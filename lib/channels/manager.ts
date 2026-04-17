import { loadSettings } from "@/lib/settings/settings-manager";
import {
  getChannelConnection,
  listChannelConnections,
  updateChannelConnection,
  getOrCreateLocalUser,
} from "@/lib/db/queries";
import { WhatsAppConnector } from "./connectors/whatsapp";
import { TelegramConnector } from "./connectors/telegram";
import { SlackConnector } from "./connectors/slack";
import { DiscordConnector } from "./connectors/discord";
import { ChannelConnector, ChannelSendPayload, ChannelSendResult, ChannelStatus, InteractiveQuestionPayload, type ChannelInboundMessage } from "./types";

// Lazy import to break the inbound ↔ manager circular dependency.
// inbound.ts needs getChannelManager() at runtime; manager.ts needs
// handleInboundMessage at runtime. Both are only called after the module
// graph is fully resolved, so a deferred require is safe here.
function getHandleInboundMessage(): (msg: ChannelInboundMessage) => Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return (require("./inbound") as { handleInboundMessage: (msg: ChannelInboundMessage) => Promise<void> }).handleInboundMessage;
}

class ChannelManager {
  private connectors = new Map<string, ChannelConnector>();
  private qrCodes = new Map<string, string>();
  private bootstrapPromises = new Map<string, Promise<void>>();
  private connectPromises = new Map<string, Promise<ChannelConnector | null>>();

  async bootstrap(userId?: string): Promise<void> {
    const settings = loadSettings();
    const targetUserId = userId || settings.localUserId;
    const key = targetUserId || "default";

    const existing = this.bootstrapPromises.get(key);
    if (existing) {
      return existing;
    }

    const promise = (async () => {
      const dbUser = await getOrCreateLocalUser(targetUserId, settings.localUserEmail);
      const connections = await listChannelConnections({ userId: dbUser.id });

      await Promise.all(
        connections.map((conn) =>
          this.connect(conn.id).catch((error) => {
            console.error("[Channels] Failed to connect", conn.id, error);
          })
        )
      );
    })().finally(() => {
      this.bootstrapPromises.delete(key);
    });

    this.bootstrapPromises.set(key, promise);
    return promise;
  }

  getQrCode(connectionId: string): string | null {
    return this.qrCodes.get(connectionId) ?? null;
  }

  async connect(connectionId: string): Promise<ChannelConnector | null> {
    const existing = this.connectors.get(connectionId);
    if (existing && (existing.status === "connected" || existing.status === "connecting")) {
      return existing;
    }
    const pending = this.connectPromises.get(connectionId);
    if (pending) {
      return pending;
    }

    const promise = (async () => {
      if (existing) {
        try {
          await existing.disconnect();
        } catch (error) {
          console.warn("[Channels] Failed to disconnect existing connector", connectionId, error);
        }
        this.connectors.delete(connectionId);
      }

      const connection = await getChannelConnection(connectionId);
      if (!connection) {
        throw new Error("Connection not found");
      }

      const config = connection.config as { type?: string } | null;
      if (!config || typeof config !== "object") {
        throw new Error("Invalid channel configuration");
      }

      await updateChannelConnection(connectionId, { status: "connecting", lastError: null });

      const updateStatus = async (status: ChannelStatus, error?: string | null) => {
        try {
          await updateChannelConnection(connectionId, {
            status,
            lastError: error ?? null,
          });
        } catch (err) {
          console.error("[Channels] Failed to update connection status", connectionId, err);
        }
      };

      const handleQr = (qr: string | null) => {
        if (qr) {
          this.qrCodes.set(connectionId, qr);
        } else {
          this.qrCodes.delete(connectionId);
        }
      };

      const handleInbound = getHandleInboundMessage();
      let connector: ChannelConnector;
      if (connection.channelType === "whatsapp") {
        connector = new WhatsAppConnector({
          connectionId,
          characterId: connection.characterId,
          config: { type: "whatsapp", ...(config as any) },
          onMessage: handleInbound,
          onStatus: updateStatus,
          onQr: handleQr,
        });
      } else if (connection.channelType === "telegram") {
        connector = new TelegramConnector({
          connectionId,
          characterId: connection.characterId,
          config: { type: "telegram", ...(config as any) },
          onMessage: handleInbound,
          onStatus: updateStatus,
        });
      } else if (connection.channelType === "slack") {
        connector = new SlackConnector({
          connectionId,
          characterId: connection.characterId,
          config: { type: "slack", ...(config as any) },
          onMessage: handleInbound,
          onStatus: updateStatus,
        });
      } else if (connection.channelType === "discord") {
        connector = new DiscordConnector({
          connectionId,
          characterId: connection.characterId,
          config: { type: "discord", ...(config as any) },
          onMessage: handleInbound,
          onStatus: updateStatus,
        });
      } else {
        throw new Error(`Unsupported channel type: ${connection.channelType}`);
      }

      this.connectors.set(connectionId, connector);
      try {
        await connector.connect();
        return connector;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await updateStatus("error", message);
        this.connectors.delete(connectionId);
        throw error;
      }
    })().finally(() => {
      this.connectPromises.delete(connectionId);
    });

    this.connectPromises.set(connectionId, promise);
    return promise;
  }

  async disconnect(connectionId: string): Promise<void> {
    const connector = this.connectors.get(connectionId);
    if (connector) {
      await connector.disconnect();
    }
    this.connectors.delete(connectionId);
    this.qrCodes.delete(connectionId);
    await updateChannelConnection(connectionId, { status: "disconnected" });
  }

  async sendMessage(connectionId: string, payload: ChannelSendPayload): Promise<ChannelSendResult> {
    const connector = await this.connect(connectionId);
    if (!connector) {
      throw new Error("Channel connector unavailable");
    }
    return connector.sendMessage(payload);
  }

  async sendTyping(connectionId: string, peerId: string): Promise<void> {
    const connector = this.connectors.get(connectionId);
    if (connector && connector.sendTyping) {
      await connector.sendTyping(peerId);
    }
  }

  async markAsRead(connectionId: string, peerId: string, messageId: string): Promise<void> {
    const connector = this.connectors.get(connectionId);
    if (connector && connector.markAsRead) {
      await connector.markAsRead(peerId, messageId);
    }
  }

  /**
   * Best-effort ack that an inbound message has been *queued* for mid-stream
   * live-prompt injection (an active run is still streaming so the message
   * won't visibly render until the next step). Swallows transport errors;
   * callers should NOT await-and-throw — the ack is UX polish, not critical
   * state. See `ChannelConnector.acknowledgeQueued` jsdoc for per-channel
   * semantics.
   */
  async acknowledgeQueued(connectionId: string, peerId: string, externalMessageId: string): Promise<void> {
    const connector = this.connectors.get(connectionId);
    if (!connector || !connector.acknowledgeQueued) return;
    try {
      await connector.acknowledgeQueued(peerId, externalMessageId);
    } catch (error) {
      console.warn("[ChannelManager] acknowledgeQueued failed:", error);
    }
  }

  getConnector(connectionId: string): ChannelConnector | undefined {
    return this.connectors.get(connectionId);
  }

  async sendInteractiveQuestion(
    connectionId: string,
    payload: InteractiveQuestionPayload,
  ): Promise<ChannelSendResult> {
    const connector = await this.connect(connectionId);
    if (!connector) {
      throw new Error("Channel connector unavailable");
    }
    // Use native interactive elements if supported, otherwise text fallback
    if (connector.sendInteractiveQuestion) {
      return connector.sendInteractiveQuestion(payload);
    }
    // Text fallback (WhatsApp and any connector without interactive support)
    const optionsText = payload.options
      .map((opt) => `${opt.index}. ${opt.label}${opt.description ? ` — ${opt.description}` : ""}`)
      .join("\n");

    return connector.sendMessage({
      peerId: payload.peerId,
      threadId: payload.threadId,
      text: `${payload.questionText}\n\n${optionsText}\n\n${payload.instructionText}`,
    });
  }
}

let singleton: ChannelManager | null = null;

export function getChannelManager(): ChannelManager {
  if (!singleton) {
    singleton = new ChannelManager();
  }
  return singleton;
}
