/**
 * Slack Delivery Handler
 * 
 * Sends scheduled task results to Slack via webhook.
 */

import type { DeliveryHandler, DeliveryPayload } from "./types";
import type { SlackDeliveryConfig } from "@/lib/db/sqlite-schedule-schema";

interface SlackBlock {
  type: string;
  text?: { type: string; text: string; emoji?: boolean };
  fields?: Array<{ type: string; text: string }>;
  elements?: Array<{ type: string; text?: { type: string; text: string }; url?: string }>;
}

export class SlackDeliveryHandler implements DeliveryHandler {
  type = "slack";

  async deliver(
    payload: DeliveryPayload,
    rawConfig: Record<string, unknown>
  ): Promise<void> {
    const config = rawConfig as unknown as SlackDeliveryConfig;
    const { webhookUrl, mentionUsers } = config;

    if (!webhookUrl) {
      throw new Error("Slack webhook URL is required");
    }

    const blocks = this.buildSlackBlocks(payload, mentionUsers);

    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ blocks }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Slack delivery failed: ${error}`);
    }

    console.log("[SlackDelivery] Message sent successfully");
  }

  private buildSlackBlocks(
    payload: DeliveryPayload,
    mentionUsers?: string[]
  ): SlackBlock[] {
    const statusEmoji = payload.status === "succeeded" ? ":white_check_mark:" : ":x:";
    const durationSeconds = Math.round((payload.durationMs || 0) / 1000);

    const blocks: SlackBlock[] = [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: `${statusEmoji} ${payload.taskName}`,
          emoji: true,
        },
      },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*Status:*\n${payload.status}` },
          { type: "mrkdwn", text: `*Duration:*\n${durationSeconds}s` },
        ],
      },
    ];

    // Add summary
    if (payload.summary) {
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: payload.summary.slice(0, 2900), // Slack limit
        },
      });
    }

    // Add error
    if (payload.error) {
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `:warning: *Error:*\n${payload.error.slice(0, 500)}`,
        },
      });
    }

    // Add link to session
    if (payload.sessionUrl) {
      blocks.push({
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "View Conversation" },
            url: payload.sessionUrl,
          },
        ],
      });
    }

    // Add mentions at the end
    if (mentionUsers && mentionUsers.length > 0) {
      const mentions = mentionUsers.map((u) => `<@${u}>`).join(" ");
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `cc: ${mentions}`,
        },
      });
    }

    return blocks;
  }
}

