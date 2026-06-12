/**
 * Email Delivery Handler
 * 
 * Sends scheduled task results via email.
 * Supports Resend, but can be extended for other providers.
 */

import type { DeliveryHandler, DeliveryPayload } from "./types";
import type { EmailDeliveryConfig } from "@/lib/db/sqlite-schedule-schema";

export class EmailDeliveryHandler implements DeliveryHandler {
  type = "email";

  async deliver(
    payload: DeliveryPayload,
    rawConfig: Record<string, unknown>
  ): Promise<void> {
    const config = rawConfig as unknown as EmailDeliveryConfig;
    const { recipients, subject, includeFullTranscript } = config;

    if (!recipients || recipients.length === 0) {
      throw new Error("No email recipients configured");
    }

    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      console.warn("[EmailDelivery] RESEND_API_KEY not configured, skipping email");
      return;
    }

    const resolvedSubject = this.resolveVariables(
      subject || `[Selene] ${payload.taskName} - ${payload.status}`,
      payload
    );

    const html = this.buildEmailHtml(payload, includeFullTranscript);

    // Use Resend API directly
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: process.env.EMAIL_FROM || "Selene <notifications@selene.app>",
        to: recipients,
        subject: resolvedSubject,
        html,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Email delivery failed: ${error}`);
    }

    console.log(`[EmailDelivery] Sent to ${recipients.length} recipient(s)`);
  }

  private resolveVariables(text: string, payload: DeliveryPayload): string {
    const now = new Date();
    return text
      .replace(/\{\{TODAY\}\}/g, now.toISOString().split("T")[0])
      .replace(/\{\{TASK_NAME\}\}/g, payload.taskName)
      .replace(/\{\{STATUS\}\}/g, payload.status);
  }

  private buildEmailHtml(
    payload: DeliveryPayload,
    _includeFullTranscript?: boolean
  ): string {
    const statusEmoji = payload.status === "succeeded" ? "✅" : "❌";
    const statusColor = payload.status === "succeeded" ? "#22c55e" : "#ef4444";
    const durationSeconds = Math.round((payload.durationMs || 0) / 1000);

    const sessionLink = payload.sessionUrl
      ? `<a href="${payload.sessionUrl}" style="color: #3b82f6; text-decoration: none;">View full conversation →</a>`
      : "";

    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 20px; background: #f5f5f5;">
  <div style="max-width: 600px; margin: 0 auto; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
    <div style="padding: 24px; border-bottom: 1px solid #e5e5e5;">
      <h1 style="margin: 0; font-size: 20px; color: #111;">
        ${statusEmoji} ${payload.taskName}
      </h1>
    </div>
    
    <div style="padding: 24px;">
      <div style="display: flex; gap: 24px; margin-bottom: 24px;">
        <div>
          <div style="font-size: 12px; color: #666; text-transform: uppercase;">Status</div>
          <div style="font-size: 16px; font-weight: 500; color: ${statusColor};">${payload.status}</div>
        </div>
        <div>
          <div style="font-size: 12px; color: #666; text-transform: uppercase;">Duration</div>
          <div style="font-size: 16px; font-weight: 500;">${durationSeconds}s</div>
        </div>
      </div>
      
      ${payload.summary ? `
      <div style="margin-bottom: 24px;">
        <div style="font-size: 12px; color: #666; text-transform: uppercase; margin-bottom: 8px;">Summary</div>
        <div style="background: #f5f5f5; padding: 16px; border-radius: 8px; white-space: pre-wrap; font-size: 14px; line-height: 1.5;">
${payload.summary}
        </div>
      </div>
      ` : ""}
      
      ${payload.error ? `
      <div style="margin-bottom: 24px;">
        <div style="font-size: 12px; color: #ef4444; text-transform: uppercase; margin-bottom: 8px;">Error</div>
        <div style="background: #fef2f2; color: #dc2626; padding: 16px; border-radius: 8px; font-size: 14px;">
          ${payload.error}
        </div>
      </div>
      ` : ""}
      
      ${sessionLink ? `<p style="margin: 0;">${sessionLink}</p>` : ""}
    </div>
    
    <div style="padding: 16px 24px; background: #f9f9f9; border-top: 1px solid #e5e5e5; font-size: 12px; color: #666;">
      Sent by Selene • ${new Date().toLocaleDateString()}
    </div>
  </div>
</body>
</html>
    `.trim();
  }
}

