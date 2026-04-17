import makeWASocket, {
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  downloadMediaMessage,
  DisconnectReason,
  proto,
  makeCacheableSignalKeyStore,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import pino from "pino";
import fs from "fs/promises";
import { ChannelConnector, ChannelInboundMessage, ChannelSendPayload, ChannelSendResult, WhatsAppConnectionConfig } from "../types";
import { getWhatsAppAuthPath, normalizeChannelText } from "../utils";

type WhatsAppConnectorOptions = {
  connectionId: string;
  characterId: string;
  config: WhatsAppConnectionConfig;
  onMessage: (message: ChannelInboundMessage) => void | Promise<void>;
  onStatus: (status: ChannelConnector["status"], error?: string | null) => void;
  onQr: (qr: string | null) => void;
};

export class WhatsAppConnector implements ChannelConnector {
  connectionId: string;
  // fallow-ignore-next-line unused-class-member
  channelType: ChannelConnector["channelType"] = "whatsapp";
  status: ChannelConnector["status"] = "disconnected";

  private sock: ReturnType<typeof makeWASocket> | null = null;
  private authPath: string;
  private onMessage: WhatsAppConnectorOptions["onMessage"];
  private onStatus: WhatsAppConnectorOptions["onStatus"];
  private onQr: WhatsAppConnectorOptions["onQr"];
  private characterId: string;
  private reconnecting = false;
  private config: WhatsAppConnectionConfig;
  private readyPromise: Promise<void> | null = null;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((error: Error) => void) | null = null;

  constructor(options: WhatsAppConnectorOptions) {
    this.connectionId = options.connectionId;
    this.characterId = options.characterId;
    this.onMessage = options.onMessage;
    this.onStatus = options.onStatus;
    this.onQr = options.onQr;
    this.authPath = options.config.authPath || getWhatsAppAuthPath(options.connectionId);
    this.config = options.config;
  }

  async connect(): Promise<void> {
    this.status = "connecting";
    this.onStatus(this.status);

    await fs.mkdir(this.authPath, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(this.authPath);
    const { version } = await fetchLatestBaileysVersion();
    const logger = pino({ level: "silent" });
    this.resetReadyPromise();

    const sock = makeWASocket({
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      printQRInTerminal: false,
      version,
      logger,
      browser: ["Selene", "Desktop", "1.0.0"],
      syncFullHistory: false,
      markOnlineOnConnect: false,
    });

    this.sock = sock;

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        this.onQr(qr);
      }

      if (connection === "open") {
        this.status = "connected";
        this.onQr(null);
        this.onStatus(this.status);
        this.readyResolve?.();
      }

      if (connection === "close") {
        const reason = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
        const loggedOut = reason === DisconnectReason.loggedOut;
        const restartRequired = reason === DisconnectReason.restartRequired;
        const errorMessage = String(lastDisconnect?.error || "Connection closed");
        this.readyReject?.(new Error(errorMessage));
        this.resetReadyPromise();

        if (loggedOut) {
          this.status = "disconnected";
          this.onStatus(this.status, "Logged out");
          this.onQr(null);
          this.resetReadyPromise();
          void fs.rm(this.authPath, { recursive: true, force: true });
          return;
        }

        if (restartRequired && !this.reconnecting) {
          this.reconnecting = true;
          this.status = "connecting";
          this.onStatus(this.status, "Restarting connection");
          setTimeout(() => {
            this.reconnecting = false;
            void this.connect().catch((error) => {
              this.onStatus("error", String(error));
            });
          }, 1500);
          return;
        }

        this.status = "error";
        this.onStatus(this.status, errorMessage);
      }
    });

    sock.ev.on("messages.upsert", async ({ messages }) => {
      for (const msg of messages) {
        if (!msg.message) {
          continue;
        }
        const fromSelf = Boolean(msg.key.fromMe);
        if (fromSelf && !this.config.selfChatMode) {
          continue;
        }

        const peerId = msg.key.remoteJid;
        if (!peerId) continue;

        const text = extractText(msg.message);
        const attachments = await extractAttachments(msg, sock);
        const inbound: ChannelInboundMessage = {
          connectionId: this.connectionId,
          characterId: this.characterId,
          channelType: "whatsapp",
          peerId,
          peerName: msg.pushName || null,
          threadId: null,
          messageId: msg.key.id || `${peerId}:${Date.now()}`,
          text: normalizeChannelText(text),
          attachments,
          fromSelf,
          timestamp: msg.messageTimestamp ? new Date(Number(msg.messageTimestamp) * 1000).toISOString() : undefined,
        };

        await this.onMessage(inbound);
      }
    });
  }

  // fallow-ignore-next-line unused-class-member
  async disconnect(): Promise<void> {
    if (this.sock) {
      try {
        this.sock.end(undefined);
      } catch {
        // Ignore teardown errors.
      }
    }
    this.readyReject?.(new Error("Disconnected"));
    this.status = "disconnected";
    this.onStatus(this.status);
  }

  // fallow-ignore-next-line unused-class-member
  async sendMessage(payload: ChannelSendPayload): Promise<ChannelSendResult> {
    if (!this.sock) {
      throw new Error("WhatsApp socket not connected");
    }
    await this.waitForReady(15000);

    const text = payload.text || "";
    const imageAttachment = payload.attachments?.find((a) => a.type === "image");
    const audioAttachment = payload.attachments?.find((a) => a.type === "audio");
    let result: proto.WebMessageInfo | undefined;

    if (imageAttachment) {
      result = await this.sock.sendMessage(payload.peerId, {
        image: imageAttachment.data,
        caption: text || undefined,
      });
    } else if (audioAttachment) {
      result = await this.sock.sendMessage(payload.peerId, {
        audio: audioAttachment.data,
        mimetype: audioAttachment.mimeType || "audio/mpeg",
        ptt: true, // Send as voice note (push-to-talk)
      });
      // Also send the text as a separate message if present
      if (text && text.trim() !== " ") {
        await this.sock.sendMessage(payload.peerId, { text });
      }
    } else {
      result = await this.sock.sendMessage(payload.peerId, { text });
    }

    const externalMessageId = result?.key?.id || `${payload.peerId}:${Date.now()}`;
    return { externalMessageId };
  }

  // fallow-ignore-next-line unused-class-member
  async sendTyping(peerId: string): Promise<void> {
    if (!this.sock) return;
    try {
      await this.sock.sendPresenceUpdate("composing", peerId);
    } catch (error) {
      console.warn("[WhatsApp] Failed to send typing status:", error);
    }
  }

  // fallow-ignore-next-line unused-class-member
  async markAsRead(peerId: string, messageId: string): Promise<void> {
    if (!this.sock) return;
    try {
      // Construct the key for the message we want to mark as read
      const key = {
        remoteJid: peerId,
        id: messageId,
        fromMe: false
      };
      await this.sock.readMessages([key]);
    } catch (error) {
      console.warn("[WhatsApp] Failed to mark as read:", error);
    }
  }

  // fallow-ignore-next-line unused-class-member
  async acknowledgeQueued(peerId: string, externalMessageId: string): Promise<void> {
    if (!this.sock) return;
    // WhatsApp's native "read receipt" is the most user-visible passive ack
    // available over baileys — a follow-up text message would spam the chat
    // and presence=composing looks misleading (no assistant reply yet).
    try {
      const key = { remoteJid: peerId, id: externalMessageId, fromMe: false };
      await this.sock.readMessages([key]);
    } catch (error) {
      console.warn("[WhatsApp] acknowledgeQueued (readMessages) failed:", error);
    }
  }

  // fallow-ignore-next-line unused-class-member
  getQrCode(): string | null {
    return null;
  }

  private resetReadyPromise() {
    this.readyPromise = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
  }

  private async waitForReady(timeoutMs: number) {
    if (this.status === "connected") {
      return;
    }
    if (!this.readyPromise) {
      throw new Error("WhatsApp connection not initialized");
    }
    const timeout = new Promise<void>((_, reject) => {
      setTimeout(() => reject(new Error("WhatsApp connection timed out")), timeoutMs);
    });
    await Promise.race([this.readyPromise, timeout]);
  }
}

function extractText(message: proto.IMessage): string | null {
  if (message.conversation) {
    return message.conversation;
  }
  if (message.extendedTextMessage?.text) {
    return message.extendedTextMessage.text;
  }
  if (message.imageMessage?.caption) {
    return message.imageMessage.caption;
  }
  if (message.videoMessage?.caption) {
    return message.videoMessage.caption;
  }
  return null;
}

async function extractAttachments(
  msg: proto.IWebMessageInfo,
  sock: ReturnType<typeof makeWASocket>
) {
  const attachments: ChannelInboundMessage["attachments"] = [];

  // Image attachments
  const image = msg.message?.imageMessage;
  if (image) {
    try {
      const buffer = await downloadMediaMessage(msg, "buffer", {}, { logger: sock.logger, reuploadRequest: sock.updateMediaMessage });
      if (buffer instanceof Buffer) {
        attachments.push({
          type: "image",
          filename: image?.caption ? `${image.caption}.jpg` : `whatsapp-${msg.key.id}.jpg`,
          mimeType: image?.mimetype || "image/jpeg",
          data: buffer,
        });
      }
    } catch (error) {
      console.error("[WhatsApp] Failed to download image:", error);
    }
    return attachments;
  }

  // Audio/voice note attachments
  const audio = msg.message?.audioMessage;
  if (audio) {
    try {
      const buffer = await downloadMediaMessage(msg, "buffer", {}, { logger: sock.logger, reuploadRequest: sock.updateMediaMessage });
      if (buffer instanceof Buffer) {
        const isVoiceNote = audio.ptt === true;
        attachments.push({
          type: "audio",
          filename: isVoiceNote ? `voice-${msg.key.id}.ogg` : `audio-${msg.key.id}.ogg`,
          mimeType: audio.mimetype || "audio/ogg; codecs=opus",
          data: buffer,
        });
      }
    } catch (error) {
      console.error("[WhatsApp] Failed to download audio:", error);
    }
    return attachments;
  }

  return attachments;
}
