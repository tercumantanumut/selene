/**
 * Channel Delivery Handler
 *
 * Sends scheduled task results to connected Slack/Telegram channels
 * using the existing channel connector system.
 */

import type { DeliveryHandler, DeliveryPayload } from "./types";
import type { ChannelDeliveryConfig } from "@/lib/db/sqlite-schedule-schema";
import { getChannelManager } from "@/lib/channels/manager";
import { getChannelConnection } from "@/lib/db/queries";
import { generateSummaryHeader, splitMessageIntoChunks } from "@/lib/channels/message-chunker";

const TELEGRAM_SAFE_LIMIT = 3800;
const TELEGRAM_CHUNK_DELAY_MS = 100;

export class ChannelDeliveryHandler implements DeliveryHandler {
  type = "channel";

  async deliver(
    payload: DeliveryPayload,
    rawConfig: Record<string, unknown>
  ): Promise<void> {
    const config = rawConfig as unknown as ChannelDeliveryConfig;
    const { connectionId, peerId, threadId } = config;

    if (!connectionId || !peerId) {
      throw new Error("Channel connectionId and peerId are required");
    }

    const statusEmoji = payload.status === "succeeded" ? "✅" : "❌";
    const durationSeconds = Math.round((payload.durationMs || 0) / 1000);

    const lines: string[] = [
      `${statusEmoji} ${payload.taskName}`,
      `Status: ${payload.status}`,
      `Duration: ${durationSeconds}s`,
    ];

    if (payload.summary) {
      lines.push("", payload.summary.trim());
    }

    if (payload.error) {
      lines.push("", `Error: ${payload.error}`);
    }

    if (payload.sessionUrl) {
      lines.push("", `View conversation: ${payload.sessionUrl}`);
    }

    const text = lines.join("\n").trim();

    const manager = getChannelManager();
    const connection = await getChannelConnection(connectionId);
    const isTelegram = connection?.channelType === "telegram";

    if (!isTelegram || (text || " ").length <= TELEGRAM_SAFE_LIMIT) {
      await manager.sendMessage(connectionId, {
        peerId,
        threadId: threadId ?? undefined,
        text: text || " ",
      });
      return;
    }

    const bytes = Buffer.byteLength(text, "utf8");
    let baseChunks = splitMessageIntoChunks(text, {
      maxLength: TELEGRAM_SAFE_LIMIT,
      preserveHeaders: true,
    });

    let totalChunks = baseChunks.length;
    let chunks = baseChunks;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (totalChunks <= 1) {
        break;
      }
      const header = generateSummaryHeader(totalChunks, bytes);
      const combined = `${header}\n\n${text}`;
      chunks = splitMessageIntoChunks(combined, {
        maxLength: TELEGRAM_SAFE_LIMIT,
        preserveHeaders: true,
      });
      if (chunks.length === totalChunks) {
        break;
      }
      totalChunks = chunks.length;
    }

    let firstMessageId: string | undefined;
    for (const chunk of chunks) {
      const result = await manager.sendMessage(connectionId, {
        peerId,
        threadId: threadId ?? undefined,
        text: chunk.text || " ",
        replyToMessageId: firstMessageId,
        chunkIndex: chunk.index,
        totalChunks: chunk.total,
      });
      if (!firstMessageId) {
        firstMessageId = result.externalMessageId;
      }
      if (!chunk.isLast) {
        await delay(TELEGRAM_CHUNK_DELAY_MS);
      }
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
