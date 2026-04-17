import { Bot, InputFile, InlineKeyboard, GrammyError } from "grammy";
import type { Context } from "grammy";
import { ChannelConnector, ChannelInboundMessage, ChannelSendPayload, ChannelSendResult, TelegramConnectionConfig, InteractiveQuestionPayload, InteractiveAnswerData } from "../types";
import { normalizeChannelText } from "../utils";

/**
 * Telegram caption limit for voice notes, photos, and other media.
 * Regular messages support 4096 chars, but captions are capped at 1024.
 * @see https://core.telegram.org/bots/api#sendvoice
 */
const TELEGRAM_CAPTION_LIMIT = 1024;

/** Matches YouTube URLs (watch, shorts, youtu.be). Same pattern as lib/youtube/extract.ts */
const YOUTUBE_URL_REGEX =
  /\bhttps?:\/\/(?:www\.)?(?:youtube\.com\/watch\?[^\s)]+|youtube\.com\/shorts\/[^\s)]+|youtu\.be\/[^\s)]+)/gi;

/**
 * Strip YouTube URLs from text.
 * Returns the cleaned text and whether any URLs were removed.
 */
function stripYouTubeUrls(text: string): { cleaned: string; hadUrls: boolean } {
  const cleaned = text
    .replace(YOUTUBE_URL_REGEX, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/  +/g, " ")
    .trim();
  return { cleaned, hadUrls: cleaned !== text.trim() };
}

/**
 * Truncate text to fit Telegram's caption limit for media messages.
 *
 * When text exceeds the limit, it is hard-truncated at a word boundary with
 * an ellipsis. The full original text is returned as `overflow` so the caller
 * can send it as a separate follow-up message — no content is lost.
 *
 * @returns `{ caption, overflow }` — overflow contains the full original text
 *         when truncation occurred (so caller can send it as a separate message).
 */
function truncateTelegramCaption(
  text: string,
  limit: number = TELEGRAM_CAPTION_LIMIT,
): { caption: string | undefined; overflow: string | null } {
  // Empty / whitespace-only → no caption
  if (!text || text.trim().length === 0 || text.trim() === " ") {
    return { caption: undefined, overflow: null };
  }

  // Fast path: already within limit
  if (text.length <= limit) {
    return { caption: text, overflow: null };
  }

  // Hard truncate at word boundary with ellipsis
  const ellipsis = "…";
  const maxLen = limit - ellipsis.length;
  let truncated = text.slice(0, maxLen);

  // Try to break at last space to avoid cutting mid-word
  const lastSpace = truncated.lastIndexOf(" ");
  if (lastSpace > maxLen * 0.7) {
    truncated = truncated.slice(0, lastSpace);
  }

  return { caption: truncated + ellipsis, overflow: text };
}

type TelegramConnectorOptions = {
  connectionId: string;
  characterId: string;
  config: TelegramConnectionConfig;
  onMessage: (message: ChannelInboundMessage) => void | Promise<void>;
  onStatus: (status: ChannelConnector["status"], error?: string | null) => void;
};

export class TelegramConnector implements ChannelConnector {
  connectionId: string;
  // fallow-ignore-next-line unused-class-member
  channelType: ChannelConnector["channelType"] = "telegram";
  status: ChannelConnector["status"] = "disconnected";

  private bot: Bot;
  private onMessage: TelegramConnectorOptions["onMessage"];
  private onStatus: TelegramConnectorOptions["onStatus"];
  private characterId: string;
  private botToken: string;
  private started = false;
  private connecting = false;
  private handlersAttached = false;
  private startPromise: Promise<void> | null = null;
  private pollingBlocked = false;
  private interactiveAnswerHandler: ((data: InteractiveAnswerData) => void) | null = null;

  constructor(options: TelegramConnectorOptions) {
    this.connectionId = options.connectionId;
    this.characterId = options.characterId;
    this.onMessage = options.onMessage;
    this.onStatus = options.onStatus;
    this.botToken = options.config.botToken;
    this.bot = new Bot(options.config.botToken);
  }

  async connect(): Promise<void> {
    if (this.status === "connected" || this.connecting) {
      return;
    }

    this.connecting = true;
    this.status = "connecting";
    this.onStatus(this.status);

    this.attachHandlers();

    try {
      await this.bot.api.getMe();
    } catch (error) {
      this.status = "error";
      this.onStatus(this.status, String(error));
      this.connecting = false;
      throw error;
    }

    if (this.pollingBlocked || this.started || this.startPromise) {
      this.status = "connected";
      this.onStatus(this.status);
      this.connecting = false;
      return;
    }

    this.started = true;
    const startPromise = this.bot.start({ drop_pending_updates: true });
    this.startPromise = startPromise;

    startPromise
      .then(() => {
        this.startPromise = null;
        this.started = false;
      })
      .catch((error) => {
        this.startPromise = null;
        this.started = false;
        this.handleTelegramError(error);
      });

    this.status = "connected";
    this.onStatus(this.status);
    this.connecting = false;
  }

  // fallow-ignore-next-line unused-class-member
  async disconnect(): Promise<void> {
    this.connecting = false;
    this.started = false;
    this.startPromise = null;
    await this.bot.stop();
    this.status = "disconnected";
    this.onStatus(this.status);
  }

  async sendMessage(payload: ChannelSendPayload): Promise<ChannelSendResult> {
    const chatId = Number(payload.peerId);
    const replyParameters = payload.replyToMessageId
      ? { message_id: Number(payload.replyToMessageId) }
      : undefined;
    let text = payload.text || "";
    if (
      payload.totalChunks &&
      payload.totalChunks > 1 &&
      payload.chunkIndex &&
      !/^\(\d+\/\d+\)\s/.test(text)
    ) {
      text = `(${payload.chunkIndex}/${payload.totalChunks}) ${text}`;
    }
    const imageAttachment = payload.attachments?.find((a) => a.type === "image");
    const audioAttachment = payload.attachments?.find((a) => a.type === "audio");

    // Track the first sent message ID for threading and return value
    let firstMessageId: number | undefined;

    // ── Step 1: Send image (if present) ──────────────────────────────────
    if (imageAttachment) {
      // When voice follows, send photo without caption — the text will
      // accompany the voice note instead (more natural UX).
      const captionText = audioAttachment ? "" : text;
      const { caption, overflow } = truncateTelegramCaption(captionText);
      const sent = await this.bot.api.sendPhoto(chatId, new InputFile(imageAttachment.data, imageAttachment.filename), {
        caption: caption || undefined,
        message_thread_id: payload.threadId ? Number(payload.threadId) : undefined,
        reply_parameters: replyParameters,
      });
      firstMessageId = sent.message_id;

      // If no audio follows and caption was truncated, send overflow
      if (!audioAttachment && overflow) {
        await this.sendOverflowText(chatId, overflow, payload.threadId, sent.message_id);
      }
    }

    // ── Step 2: Send voice note (if present) ─────────────────────────────
    // When both image and voice exist, the voice is threaded as a reply to
    // the image so they appear grouped in the chat.
    if (audioAttachment) {
      // Always strip YouTube URLs from voice captions — they don't belong in
      // a voice bubble. The full text (with URLs) is sent as a follow-up.
      const { cleaned: voiceText, hadUrls } = stripYouTubeUrls(text);
      const { caption, overflow } = truncateTelegramCaption(voiceText);
      // If we stripped URLs or truncated, send the full original text as follow-up
      const needsOverflow = hadUrls || overflow !== null;

      // Thread voice to the image when both are present
      const voiceReplyParams = firstMessageId
        ? { message_id: firstMessageId }
        : replyParameters;

      let sent;
      try {
        sent = await this.bot.api.sendVoice(chatId, new InputFile(audioAttachment.data, audioAttachment.filename), {
          caption,
          message_thread_id: payload.threadId ? Number(payload.threadId) : undefined,
          reply_parameters: voiceReplyParams,
        });
      } catch (error) {
        // Retry without caption if Telegram still rejects it (e.g. encoding edge cases)
        if (isCaptionTooLongError(error)) {
          console.warn(
            `[Telegram] Caption too long after truncation (${caption?.length ?? 0} chars), retrying without caption`,
          );
          sent = await this.bot.api.sendVoice(chatId, new InputFile(audioAttachment.data, audioAttachment.filename), {
            message_thread_id: payload.threadId ? Number(payload.threadId) : undefined,
            reply_parameters: voiceReplyParams,
          });
          // Send the full text as a separate message so content isn't lost
          if (text && text.trim().length > 0) {
            await this.sendOverflowText(chatId, text, payload.threadId, sent.message_id);
          }
          return {
            externalMessageId: String(firstMessageId ?? sent.message_id),
            chunkIndex: payload.chunkIndex,
            totalChunks: payload.totalChunks,
          };
        }
        throw error;
      }
      // If URLs were stripped or caption was truncated, send the full original text as follow-up
      if (needsOverflow) {
        await this.sendOverflowText(chatId, text, payload.threadId, sent.message_id);
      }
      return {
        externalMessageId: String(firstMessageId ?? sent.message_id),
        chunkIndex: payload.chunkIndex,
        totalChunks: payload.totalChunks,
      };
    }

    // ── Step 3: Image-only (already sent above) ──────────────────────────
    if (firstMessageId) {
      return {
        externalMessageId: String(firstMessageId),
        chunkIndex: payload.chunkIndex,
        totalChunks: payload.totalChunks,
      };
    }

    // ── Step 4: Plain text fallback (no attachments) ─────────────────────
    const sent = await this.bot.api.sendMessage(chatId, text || " ", {
      message_thread_id: payload.threadId ? Number(payload.threadId) : undefined,
      reply_parameters: replyParameters,
      parse_mode: payload.parseMode,
    });
    return {
      externalMessageId: String(sent.message_id),
      chunkIndex: payload.chunkIndex,
      totalChunks: payload.totalChunks,
    };
  }

  // fallow-ignore-next-line unused-class-member
  async sendTyping(peerId: string): Promise<void> {
    if (!this.bot || this.status !== "connected") return;
    try {
      await this.bot.api.sendChatAction(Number(peerId), "typing");
    } catch (error) {
      console.warn("[Telegram] Failed to send typing status:", error);
    }
  }

  // fallow-ignore-next-line unused-class-member
  async markAsRead(peerId: string, messageId: string): Promise<void> {
    // Telegram Bot API does not support marking messages as read.
    return Promise.resolve();
  }

  // fallow-ignore-next-line unused-class-member
  async acknowledgeQueued(peerId: string, externalMessageId: string): Promise<void> {
    if (!this.bot || this.status !== "connected") return;
    const chatId = Number(peerId);
    const messageId = Number(externalMessageId);
    if (!Number.isFinite(chatId) || !Number.isFinite(messageId)) return;
    try {
      await this.bot.api.setMessageReaction(chatId, messageId, [
        { type: "emoji", emoji: "👀" },
      ]);
    } catch (error) {
      // Some bots / chats disallow reactions — downgrade silently.
      console.warn("[Telegram] setMessageReaction failed:", error);
    }
  }

  // fallow-ignore-next-line unused-class-member
  setInteractiveAnswerHandler(handler: (data: InteractiveAnswerData) => void): void {
    this.interactiveAnswerHandler = handler;
  }

  // fallow-ignore-next-line unused-class-member
  async sendInteractiveQuestion(payload: InteractiveQuestionPayload): Promise<ChannelSendResult> {
    const chatId = Number(payload.peerId);
    const keyboard = new InlineKeyboard();
    for (const opt of payload.options) {
      keyboard.text(
        `${opt.index}. ${opt.label}`,
        `auq:${payload.toolUseId}:${opt.index}`,
      ).row();
    }
    const text = `${payload.questionText}\n\n${payload.instructionText}`;
    const sent = await this.bot.api.sendMessage(chatId, text, {
      reply_markup: keyboard,
      message_thread_id: payload.threadId ? Number(payload.threadId) : undefined,
    });
    return { externalMessageId: String(sent.message_id) };
  }

  private dispatchInboundMessage(message: ChannelInboundMessage): void {
    // grammY long polling processes updates sequentially. If we await the full
    // channel pipeline here, Telegram cannot deliver a later /stop until the
    // current run finishes streaming.
    void Promise.resolve(this.onMessage(message)).catch((error) => {
      console.error("[Telegram] Failed to process inbound message:", error);
    });
  }

  private attachHandlers(): void {
    if (this.handlersAttached) {
      return;
    }

    this.bot.catch((error) => {
      this.handleTelegramError(error);
    });

    this.bot.on("message", async (ctx) => {
      if (ctx.from?.is_bot) {
        return;
      }

      const peerId = String(ctx.chat?.id);
      if (!peerId) return;

      const text = normalizeChannelText(ctx.message?.text || ctx.message?.caption);
      const attachments = await extractTelegramAttachments(ctx, this.botToken);

      const inbound: ChannelInboundMessage = {
        connectionId: this.connectionId,
        characterId: this.characterId,
        channelType: "telegram",
        peerId,
        peerName: ctx.chat?.title || ctx.chat?.username || ctx.from?.username || ctx.from?.first_name || null,
        threadId: ctx.message?.message_thread_id ? String(ctx.message.message_thread_id) : null,
        messageId: String(ctx.message?.message_id ?? Date.now()),
        text,
        attachments,
        timestamp: ctx.message?.date ? new Date(ctx.message.date * 1000).toISOString() : undefined,
      };

      this.dispatchInboundMessage(inbound);
      return;
    });

    // Handle inline keyboard button clicks for interactive questions
    this.bot.on("callback_query:data", async (ctx) => {
      const data = ctx.callbackQuery.data;
      if (!data?.startsWith("auq:")) return;

      const parts = data.split(":");
      if (parts.length < 3) return;
      const toolUseId = parts[1];
      const selectedIndex = parseInt(parts[2], 10);
      if (isNaN(selectedIndex)) return;

      // Acknowledge the callback to dismiss the loading spinner
      await ctx.answerCallbackQuery({ text: "Selection received" });

      // Edit the message to show the selected option
      try {
        const selectedButton = ctx.callbackQuery.message?.reply_markup?.inline_keyboard
          ?.flat()
          ?.find((btn) => "callback_data" in btn && btn.callback_data === data);
        const selectedText = selectedButton && "text" in selectedButton ? selectedButton.text : `Option ${selectedIndex}`;
        await ctx.editMessageText(
          `${ctx.callbackQuery.message?.text ?? ""}\n\n✓ Selected: ${selectedText}`,
        );
      } catch {
        // Editing may fail if message is too old
      }

      if (this.interactiveAnswerHandler) {
        const peerId = String(ctx.callbackQuery.message?.chat?.id ?? "");
        const threadId = ctx.callbackQuery.message?.message_thread_id
          ? String(ctx.callbackQuery.message.message_thread_id)
          : undefined;
        this.interactiveAnswerHandler({
          connectionId: this.connectionId,
          peerId,
          threadId,
          toolUseId,
          selectedIndices: [selectedIndex],
        });
      }
    });

    this.handlersAttached = true;
  }

  /**
   * Send overflow text as a separate reply when caption was truncated.
   * Silently logs failures — the voice/photo was already delivered.
   */
  private async sendOverflowText(
    chatId: number,
    text: string,
    threadId?: string | null,
    replyToMessageId?: number,
  ): Promise<void> {
    try {
      await this.bot.api.sendMessage(chatId, text, {
        message_thread_id: threadId ? Number(threadId) : undefined,
        reply_parameters: replyToMessageId ? { message_id: replyToMessageId } : undefined,
      });
    } catch (err) {
      console.warn("[Telegram] Failed to send overflow text after caption truncation:", err);
    }
  }

  private handleTelegramError(error: unknown): void {
    if (this.status === "disconnected") {
      return;
    }

    if (isConflictError(error)) {
      const message = "Telegram polling conflict: another instance is already running";
      this.pollingBlocked = true;
      console.warn("[Channels] Telegram polling conflict detected; marking as connected.", message);
      this.status = "connected";
      this.onStatus(this.status);
      return;
    }

    console.error("[Channels] Telegram bot error:", error);
    this.status = "error";
    this.onStatus(this.status, formatTelegramError(error));
  }
}

function isConflictError(error: unknown): boolean {
  if (error instanceof GrammyError) {
    return error.error_code === 409;
  }
  if (error instanceof Error) {
    return error.message.includes("409") && error.message.includes("getUpdates");
  }
  return false;
}

function formatTelegramError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/**
 * Detect Telegram's "message caption is too long" error.
 * Grammy wraps API errors as GrammyError with the description from Telegram.
 */
function isCaptionTooLongError(error: unknown): boolean {
  if (error instanceof GrammyError) {
    return (
      error.error_code === 400 &&
      error.message.toLowerCase().includes("caption")
    );
  }
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    return msg.includes("caption") && (msg.includes("too long") || msg.includes("400"));
  }
  return false;
}

async function extractTelegramAttachments(ctx: Context, botToken: string): Promise<ChannelInboundMessage["attachments"]> {
  const attachments: ChannelInboundMessage["attachments"] = [];

  // Photo attachments
  const photo = ctx.message?.photo?.[ctx.message.photo.length - 1];
  if (photo) {
    const fileInfo = await ctx.api.getFile(photo.file_id);
    if (fileInfo.file_path) {
      const fileUrl = `https://api.telegram.org/file/bot${botToken}/${fileInfo.file_path}`;
      const response = await fetch(fileUrl);
      if (response.ok) {
        const arrayBuffer = await response.arrayBuffer();
        attachments.push({
          type: "image",
          filename: `telegram-${photo.file_unique_id}.jpg`,
          mimeType: response.headers.get("content-type") || "image/jpeg",
          data: Buffer.from(arrayBuffer),
        });
      } else {
        console.error(
          `[Telegram] Failed to download photo (file_id ${photo.file_id}) — ` +
          `${response.status} ${response.statusText}.`
        );
      }
    }
    return attachments;
  }

  // Voice note / audio attachments
  const voice = ctx.message?.voice;
  const audio = ctx.message?.audio;
  const voiceOrAudio = voice || audio;
  if (voiceOrAudio) {
    try {
      const fileInfo = await ctx.api.getFile(voiceOrAudio.file_id);
      if (fileInfo.file_path) {
        const fileUrl = `https://api.telegram.org/file/bot${botToken}/${fileInfo.file_path}`;
        const response = await fetch(fileUrl);
        if (response.ok) {
          const arrayBuffer = await response.arrayBuffer();
          const mimeType = voiceOrAudio.mime_type || "audio/ogg";
          const extension = voice ? "ogg" : (mimeType.includes("mp3") ? "mp3" : "ogg");
          attachments.push({
            type: "audio",
            filename: `telegram-${voiceOrAudio.file_unique_id}.${extension}`,
            mimeType,
            data: Buffer.from(arrayBuffer),
          });
        } else {
          console.error(
            `[Telegram] Failed to download voice/audio (file_id ${voiceOrAudio.file_id}) — ` +
            `${response.status} ${response.statusText}.`
          );
        }
      }
    } catch (error) {
      console.error("[Telegram] Failed to extract voice/audio:", error);
    }
  }

  return attachments;
}
