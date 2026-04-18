export type ChannelType = "whatsapp" | "telegram" | "slack" | "discord";

export type ChannelStatus = "disconnected" | "connecting" | "connected" | "error";

type ChannelDirection = "inbound" | "outbound";

export interface WhatsAppConnectionConfig {
  type: "whatsapp";
  /**
   * Optional override for auth storage directory.
   * Defaults to ${LOCAL_DATA_PATH}/channels/whatsapp/<connectionId>
   */
  authPath?: string;
  /**
   * Allow self-chat (messages sent from the linked WhatsApp account).
   * Useful for testing with "Message yourself".
   */
  selfChatMode?: boolean;
  /** Friendly label shown in the UI. */
  label?: string;
}

export interface TelegramConnectionConfig {
  type: "telegram";
  botToken: string;
  /** Friendly label shown in the UI. */
  label?: string;
}

export interface SlackConnectionConfig {
  type: "slack";
  botToken: string;
  appToken: string;
  signingSecret: string;
  /** Friendly label shown in the UI. */
  label?: string;
}

export interface DiscordConnectionConfig {
  type: "discord";
  botToken: string;
  /** Friendly label shown in the UI. */
  label?: string;
}

export type ChannelConnectionConfig =
  | WhatsAppConnectionConfig
  | TelegramConnectionConfig
  | SlackConnectionConfig
  | DiscordConnectionConfig;

export interface ChannelAttachment {
  type: "image" | "file" | "audio";
  filename: string;
  mimeType: string;
  data: Buffer;
}

export interface ChannelInboundMessage {
  connectionId: string;
  characterId: string;
  channelType: ChannelType;
  peerId: string;
  peerName?: string | null;
  threadId?: string | null;
  messageId: string;
  text?: string | null;
  attachments?: ChannelAttachment[];
  fromSelf?: boolean;
  timestamp?: string;
}

export interface ChannelSendPayload {
  peerId: string;
  text: string;
  threadId?: string | null;
  attachments?: ChannelAttachment[];
  replyToMessageId?: string | null;
  chunkIndex?: number;
  totalChunks?: number;
  /** Telegram-compatible parse mode. Legacy "Markdown" is supported but "MarkdownV2" is preferred. */
  parseMode?: "Markdown" | "MarkdownV2" | "HTML";
}

export interface ChannelSendResult {
  externalMessageId: string;
  chunkIndex?: number;
  totalChunks?: number;
}

export interface InteractiveQuestionPayload {
  peerId: string;
  threadId?: string | null;
  toolUseId: string;
  questionText: string;
  options: { index: number; label: string; description: string }[];
  multiSelect: boolean;
  instructionText: string;
}

export interface InteractiveAnswerData {
  connectionId: string;
  peerId: string;
  threadId?: string | null;
  toolUseId: string;
  selectedIndices: number[];
}

export interface ChannelConnector {
  connectionId: string;
  channelType: ChannelType;
  status: ChannelStatus;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  sendMessage(payload: ChannelSendPayload): Promise<ChannelSendResult>;
  getQrCode?(): string | null;
  sendTyping?(peerId: string): Promise<void>;
  markAsRead?(peerId: string, messageId: string): Promise<void>;
  /**
   * Lightweight user-visible ack fired when an inbound message is *queued*
   * for mid-stream live-prompt injection (because an active run is still
   * streaming). This lets the user see "got it, it'll land next" without
   * waiting for the chat UI to re-render.
   *
   * Implementations should be idempotent + best-effort: swallow transport
   * errors, never retry. Per-channel expectations:
   *   - Telegram: emoji reaction on the inbound message (setMessageReaction).
   *   - WhatsApp: readMessages() (piggybacks on the existing read receipt).
   *   - Slack:    reactions.add ("eyes" emoji) on the inbound message —
   *               silent and persistent (we used to suggest postEphemeral
   *               here, but the impl was changed to a reaction so we don't
   *               leave a chat line to clean up; see slack.ts:180).
   *   - Discord:  message.react() on the inbound message.
   */
  acknowledgeQueued?(peerId: string, externalMessageId: string): Promise<void>;
  sendInteractiveQuestion?(payload: InteractiveQuestionPayload): Promise<ChannelSendResult>;
  setInteractiveAnswerHandler?(handler: (data: InteractiveAnswerData) => void): void;
}
