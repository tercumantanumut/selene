import { App, LogLevel } from "@slack/bolt";
import type { ChannelInboundMessage, ChannelConnector, ChannelSendPayload, ChannelSendResult, SlackConnectionConfig, InteractiveQuestionPayload, InteractiveAnswerData } from "../types";
import { normalizeChannelText } from "../utils";

type SlackConnectorOptions = {
  connectionId: string;
  characterId: string;
  config: SlackConnectionConfig;
  onMessage: (message: ChannelInboundMessage) => void | Promise<void>;
  onStatus: (status: ChannelConnector["status"], error?: string | null) => void;
};

export class SlackConnector implements ChannelConnector {
  connectionId: string;
  // fallow-ignore-next-line unused-class-member
  channelType: ChannelConnector["channelType"] = "slack";
  status: ChannelConnector["status"] = "disconnected";

  private app: App;
  private onMessage: SlackConnectorOptions["onMessage"];
  private onStatus: SlackConnectorOptions["onStatus"];
  private characterId: string;
  private botUserId: string | null = null;
  private interactiveAnswerHandler: ((data: InteractiveAnswerData) => void) | null = null;

  constructor(options: SlackConnectorOptions) {
    this.connectionId = options.connectionId;
    this.characterId = options.characterId;
    this.onMessage = options.onMessage;
    this.onStatus = options.onStatus;
    this.app = new App({
      token: options.config.botToken,
      appToken: options.config.appToken,
      signingSecret: options.config.signingSecret,
      socketMode: true,
      logLevel: LogLevel.WARN,
    });
  }

  // fallow-ignore-next-line unused-class-member
  async connect(): Promise<void> {
    this.status = "connecting";
    this.onStatus(this.status);

    const auth = await this.app.client.auth.test();
    this.botUserId = auth.user_id || null;

    this.app.event("message", async ({ event, client }) => {
      if (event.subtype && event.subtype !== "file_share") {
        return;
      }
      const botId = "bot_id" in event ? (event as { bot_id?: string }).bot_id : undefined;
      if (botId || (this.botUserId && event.user === this.botUserId)) {
        return;
      }

      const peerId = event.channel;
      if (!peerId) return;

      const threadId = event.thread_ts ? String(event.thread_ts) : null;
      const text = normalizeChannelText(event.text || "");
      const attachments = await extractSlackAttachments(event, client, this.app.client.token);

      const peerName = await resolveSlackPeerName(client, peerId, event.user);

      const inbound: ChannelInboundMessage = {
        connectionId: this.connectionId,
        characterId: this.characterId,
        channelType: "slack",
        peerId,
        peerName,
        threadId,
        messageId: String(event.ts || Date.now()),
        text,
        attachments,
        timestamp: event.ts ? new Date(Number(event.ts) * 1000).toISOString() : undefined,
      };

      await this.onMessage(inbound);
    });

    // Handle interactive question button clicks
    this.app.action(/^auq_/, async ({ action, ack, respond }) => {
      await ack();
      if (!("value" in action) || typeof action.value !== "string") return;

      const parts = action.value.split(":");
      if (parts.length < 3 || parts[0] !== "auq") return;
      const toolUseId = parts[1];
      const selectedIndex = parseInt(parts[2], 10);
      if (isNaN(selectedIndex)) return;

      // Update original message to show selection
      try {
        const label = "text" in action && action.text ? (action.text as { text?: string }).text : `Option ${selectedIndex}`;
        await respond({
          text: `✓ Selected: ${label ?? `Option ${selectedIndex}`}`,
          replace_original: false,
        });
      } catch {
        // Ignore respond failures
      }

      if (this.interactiveAnswerHandler) {
        const peerId = "channel" in action ? String((action as { channel?: { id?: string } }).channel?.id ?? "") : "";
        this.interactiveAnswerHandler({
          connectionId: this.connectionId,
          peerId,
          toolUseId,
          selectedIndices: [selectedIndex],
        });
      }
    });

    await this.app.start();
    this.status = "connected";
    this.onStatus(this.status);
  }

  // fallow-ignore-next-line unused-class-member
  async disconnect(): Promise<void> {
    await this.app.stop();
    this.status = "disconnected";
    this.onStatus(this.status);
  }

  // fallow-ignore-next-line unused-class-member
  async sendMessage(payload: ChannelSendPayload): Promise<ChannelSendResult> {
    const text = payload.text || "";
    const imageAttachment = payload.attachments?.find((a) => a.type === "image");
    const audioAttachment = payload.attachments?.find((a) => a.type === "audio");
    const fileAttachment = imageAttachment || audioAttachment;

    if (fileAttachment) {
      try {
        const uploadArgs: Record<string, unknown> = {
          channel_id: payload.peerId,
          file: fileAttachment.data,
          filename: fileAttachment.filename,
          initial_comment: text || undefined,
        };
        if (payload.threadId) {
          uploadArgs.thread_ts = payload.threadId;
        }
        const uploaded = await this.app.client.files.uploadV2(uploadArgs as any);
        const uploadResult = uploaded as unknown as Record<string, unknown>;
        const fileId = (uploadResult.files as Array<{ id?: string }> | undefined)?.[0]?.id
          || (uploadResult.file as { id?: string } | undefined)?.id
          || `${payload.peerId}:${Date.now()}`;
        return { externalMessageId: String(fileId) };
      } catch (uploadError) {
        // Fallback: send text-only via chat.postMessage if file upload fails
        console.warn("[Slack] File upload failed, falling back to text-only:", uploadError);
        if (text) {
          const sent = await this.app.client.chat.postMessage({
            channel: payload.peerId,
            text,
            thread_ts: payload.threadId || undefined,
          });
          return { externalMessageId: String(sent.ts || `${payload.peerId}:${Date.now()}`) };
        }
        throw uploadError;
      }
    }

    const sent = await this.app.client.chat.postMessage({
      channel: payload.peerId,
      text: text || " ",
      thread_ts: payload.threadId || undefined,
    });
    return { externalMessageId: String(sent.ts || `${payload.peerId}:${Date.now()}`) };
  }

  // fallow-ignore-next-line unused-class-member
  async sendTyping(_peerId: string): Promise<void> {
    // Slack Web API does not support typing indicators for bots — no-op
  }

  // fallow-ignore-next-line unused-class-member
  async acknowledgeQueued(peerId: string, externalMessageId: string): Promise<void> {
    // Use a reaction rather than an ephemeral message: reactions are silent,
    // persistent, and don't add a chat line that we'd then have to clean up
    // when the real assistant reply lands.
    try {
      await this.app.client.reactions.add({
        channel: peerId,
        timestamp: externalMessageId,
        name: "eyes",
      });
    } catch (error) {
      // already_reacted and invalid_name are both safe to ignore.
      console.warn("[Slack] reactions.add failed:", error);
    }
  }

  // fallow-ignore-next-line unused-class-member
  setInteractiveAnswerHandler(handler: (data: InteractiveAnswerData) => void): void {
    this.interactiveAnswerHandler = handler;
  }

  // fallow-ignore-next-line unused-class-member
  async sendInteractiveQuestion(payload: InteractiveQuestionPayload): Promise<ChannelSendResult> {
    const blocks = [
      {
        type: "section" as const,
        text: { type: "mrkdwn" as const, text: payload.questionText },
      },
      {
        type: "actions" as const,
        block_id: `auq_${payload.toolUseId}`,
        elements: payload.options.map((opt) => ({
          type: "button" as const,
          text: { type: "plain_text" as const, text: opt.label, emoji: true },
          value: `auq:${payload.toolUseId}:${opt.index}`,
          action_id: `auq_${payload.toolUseId}_${opt.index}`,
        })),
      },
    ];

    const sent = await this.app.client.chat.postMessage({
      channel: payload.peerId,
      blocks,
      text: `${payload.questionText}\n${payload.instructionText}`,
      thread_ts: payload.threadId || undefined,
    });

    return { externalMessageId: String(sent.ts || `${payload.peerId}:${Date.now()}`) };
  }
}

async function resolveSlackPeerName(client: any, channelId: string, userId?: string | null) {
  try {
    const channelInfo = await client.conversations.info({ channel: channelId });
    const channelName = channelInfo.channel?.name || channelInfo.channel?.user;
    if (channelName) {
      return channelName;
    }
  } catch {
    // Ignore
  }

  if (userId) {
    try {
      const userInfo = await client.users.info({ user: userId });
      return userInfo.user?.real_name || userInfo.user?.name || null;
    } catch {
      return null;
    }
  }
  return null;
}

async function extractSlackAttachments(event: any, client: any, token?: string | undefined) {
  const attachments: ChannelInboundMessage["attachments"] = [];
  const files = event.files as Array<{ url_private_download?: string; mimetype?: string; name?: string }> | undefined;
  if (!files?.length) return attachments;

  // Find image or audio file
  const file = files.find(
    (item) => item.mimetype?.startsWith("image/") || item.mimetype?.startsWith("audio/")
  );
  if (!file?.url_private_download) {
    return attachments;
  }

  const response = await fetch(file.url_private_download, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });

  if (!response.ok) {
    if (response.status === 403) {
      console.error(
        `[Slack] Permission denied downloading file "${file.name}" (403). ` +
        `Your Slack app is missing the "files:read" OAuth scope. ` +
        `Go to api.slack.com → your app → Features & Permissions → Scopes, ` +
        `add "files:read", and reinstall the app.`
      );
    } else {
      console.error(
        `[Slack] Failed to download file "${file.name}" — ` +
        `${response.status} ${response.statusText}. ` +
        `The bot token may be missing or expired.`
      );
    }
    return attachments;
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const mimeType = response.headers.get("content-type") || file.mimetype || "application/octet-stream";
  const isAudio = mimeType.startsWith("audio/");

  attachments.push({
    type: isAudio ? "audio" : "image",
    filename: file.name || `slack-${Date.now()}.${isAudio ? "mp3" : "jpg"}`,
    mimeType,
    data: buffer,
  });

  return attachments;
}
