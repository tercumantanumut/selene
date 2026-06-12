/**
 * Webhook Delivery Handler
 * 
 * Sends scheduled task results to a custom webhook endpoint.
 */

import type { DeliveryHandler, DeliveryPayload } from "./types";
import type { WebhookDeliveryConfig } from "@/lib/db/sqlite-schedule-schema";

export class WebhookDeliveryHandler implements DeliveryHandler {
  type = "webhook";

  async deliver(
    payload: DeliveryPayload,
    rawConfig: Record<string, unknown>
  ): Promise<void> {
    const config = rawConfig as unknown as WebhookDeliveryConfig;
    const { url, method = "POST", headers = {}, includeMetadata } = config;

    if (!url) {
      throw new Error("Webhook URL is required");
    }

    const body = this.buildPayload(payload, includeMetadata);

    const response = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Webhook delivery failed: ${response.status} - ${error}`);
    }

    console.log(`[WebhookDelivery] Sent to ${url}`);
  }

  private buildPayload(
    payload: DeliveryPayload,
    includeMetadata?: boolean
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      event: "scheduled_task_completed",
      timestamp: new Date().toISOString(),
      task: {
        id: payload.taskId,
        name: payload.taskName,
        runId: payload.runId,
      },
      result: {
        status: payload.status,
        summary: payload.summary,
        error: payload.error,
        durationMs: payload.durationMs,
      },
      session: payload.sessionId
        ? {
            id: payload.sessionId,
            url: payload.sessionUrl,
          }
        : null,
    };

    if (includeMetadata && Object.keys(payload.metadata).length > 0) {
      body.metadata = payload.metadata;
    }

    return body;
  }
}

