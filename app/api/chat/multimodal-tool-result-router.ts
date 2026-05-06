import type { ModelMessage, UserModelMessage } from "ai";
import {
  getReadFileImageUnsupportedMessage,
  providerRequiresTextOnlyImageReads,
  providerSupportsImageToolResults,
  providerSupportsUserImageParts,
} from "@/lib/ai/provider-types";
import { splitDataUri } from "@/lib/ai/media/image-resolver";

const EPHEMERAL_IMAGE_OMITTED = "[ephemeral image bytes omitted from persisted history]";

type ReadFileImageOutput = {
  status?: string;
  kind?: string;
  filePath?: string;
  message?: string;
  image?: {
    dataUri?: string;
    mediaType?: string;
    byteLength?: number;
  };
};

type ToolResultPart = {
  type?: string;
  toolName?: string;
  toolCallId?: string;
  output?: unknown;
};

function getRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function unwrapToolOutput(output: unknown): unknown {
  const outer = getRecord(output);
  if (outer?.type === "json") return outer.value;
  if (outer?.type === "text") {
    try {
      return JSON.parse(String(outer.value));
    } catch {
      return output;
    }
  }
  return output;
}

function getReadFileImageOutput(part: ToolResultPart): ReadFileImageOutput | null {
  if (part.type !== "tool-result" || part.toolName !== "readFile") return null;
  const payload = getRecord(unwrapToolOutput(part.output));
  if (!payload || payload.kind !== "image") return null;
  const image = getRecord(payload.image);
  if (!image || typeof image.dataUri !== "string") return null;
  if (image.dataUri === EPHEMERAL_IMAGE_OMITTED) return null;
  return payload as ReadFileImageOutput;
}

function makeImageUserMessage(result: ReadFileImageOutput): UserModelMessage | null {
  const dataUri = result.image?.dataUri;
  if (!dataUri) return null;
  const split = splitDataUri(dataUri);
  if (!split) return null;

  const label = result.filePath || "readFile image result";
  return {
    role: "user",
    content: [
      {
        type: "text",
        text: `(Ephemeral image from readFile for ${label}. This image is visible only for this model step.)`,
      },
      {
        type: "image",
        image: split.base64,
        mediaType: split.mediaType,
      },
    ],
  };
}

function makeToolResultContentOutput(result: ReadFileImageOutput): { type: "content"; value: Array<{ type: "text"; text: string } | { type: "media"; data: string; mediaType: string }> } | null {
  const dataUri = result.image?.dataUri;
  if (!dataUri) return null;
  const split = splitDataUri(dataUri);
  if (!split) return null;
  return {
    type: "content",
    value: [
      { type: "text", text: result.message || `Loaded image ${result.filePath || "file"}.` },
      { type: "media", data: split.base64, mediaType: split.mediaType },
    ],
  };
}

function makeUnsupportedTextOutput(provider: string | undefined): { type: "text"; value: string } {
  return {
    type: "text",
    value: getReadFileImageUnsupportedMessage(provider),
  };
}

export function routeMultimodalReadFileResults(
  messages: ModelMessage[],
  provider: string | undefined,
): ModelMessage[] {
  if (providerRequiresTextOnlyImageReads(provider)) {
    return messages.map((message) => {
      if (!Array.isArray(message.content)) return message;
      let changed = false;
      const content = message.content.map((part) => {
        const result = getReadFileImageOutput(part as ToolResultPart);
        if (!result) return part;
        changed = true;
        return {
          ...part,
          output: makeUnsupportedTextOutput(provider),
        };
      }) as ModelMessage["content"];
      return changed ? ({ ...message, content } as ModelMessage) : message;
    });
  }

  const routedMessages: ModelMessage[] = [];
  for (const message of messages) {
    if (!Array.isArray(message.content)) {
      routedMessages.push(message);
      continue;
    }

    const syntheticUserMessages: UserModelMessage[] = [];
    let changed = false;
    const content = message.content.map((part) => {
      const result = getReadFileImageOutput(part as ToolResultPart);
      if (!result) return part;

      const contentOutput = providerSupportsImageToolResults(provider)
        ? makeToolResultContentOutput(result)
        : null;
      if (contentOutput) {
        changed = true;
        return { ...part, output: contentOutput };
      }

      if (providerSupportsUserImageParts(provider)) {
        const synthetic = makeImageUserMessage(result);
        if (synthetic) {
          syntheticUserMessages.push(synthetic);
          changed = true;
          return {
            ...part,
            output: {
              type: "text",
              value: result.message || `Loaded image ${result.filePath || "file"}; preview attached in the next ephemeral message.`,
            },
          };
        }
      }

      changed = true;
      return { ...part, output: makeUnsupportedTextOutput(provider) };
    }) as ModelMessage["content"];

    routedMessages.push(changed ? ({ ...message, content } as ModelMessage) : message);
    routedMessages.push(...syntheticUserMessages as ModelMessage[]);
  }

  return routedMessages;
}
