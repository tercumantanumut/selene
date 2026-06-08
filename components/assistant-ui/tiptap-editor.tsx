"use client";

import {
  useEffect,
  useCallback,
  forwardRef,
  useImperativeHandle,
} from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import { Extension, type JSONContent } from "@tiptap/core";
import type { Editor } from "@tiptap/react";
import {
  Plugin,
  PluginKey,
  TextSelection,
  type EditorState,
  type Transaction,
} from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { Fragment, Slice } from "@tiptap/pm/model";
import { padTranscriptText } from "./voice-transcript-utils";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import Placeholder from "@tiptap/extension-placeholder";
import {
  BoldIcon,
  ItalicIcon,
  ListIcon,
  ListOrderedIcon,
  CodeIcon,
  QuoteIcon,
  Heading2Icon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { toast } from "sonner";

// ============================================================================
// Types
// ============================================================================

/** A single part of the multimodal content array sent to threadRuntime.append() */
export interface ContentPart {
  type: "text" | "image";
  id?: string;
  text?: string;
  image?: string;
  displayName?: string;
  contentType?: string;
  localPath?: string;
  filePath?: string;
  size?: number;
  kind?: string;
}

export interface TiptapEditorHandle {
  /** Serialize editor content to multimodal content array */
  getContentArray: () => ContentPart[];
  /** Check if the editor has any meaningful content */
  hasContent: () => boolean;
  /** Insert plain-text transcript at the active selection using a history-aware transaction */
  insertVoiceTranscript: (text: string, sessionId?: string, insertAt?: number) => boolean;
  /** Replace the latest voice transcript with its polished version using undo-aware history */
  replaceVoiceTranscript: (oldText: string, newText: string, sessionId?: string) => boolean;
  /** Remove any transient voice transcript styling without changing the document */
  clearVoiceTranscriptDecoration: (sessionId?: string) => void;
  /** Read the currently tracked voice transcript text, if any */
  getTrackedVoiceTranscriptText: (sessionId?: string) => string | null;
  /** Clear the editor */
  clear: () => void;
  /** Focus the editor */
  focus: () => void;
}

interface TiptapEditorProps {
  /** Called when the user submits (Cmd/Ctrl+Enter) */
  onSubmit: (content: ContentPart[]) => void;
  /** Session ID for image uploads */
  sessionId?: string;
  /** Initial editor document, restored from draft persistence */
  initialContent?: JSONContent | null;
  /** Called whenever editor doc changes */
  onDraftChange?: (draft: JSONContent | null) => void;
  /** Called after editor content is cleared */
  onDraftClear?: () => void;
  /** Placeholder text */
  placeholder?: string;
  /** Whether submission is disabled */
  disabled?: boolean;
  /** Whether currently submitting */
  isSubmitting?: boolean;
  /** Additional class name */
  className?: string;
}

// ============================================================================
// Image upload helper
// ============================================================================

type UploadedImage = {
  url: string;
  localPath?: string;
  filePath?: string;
  contentType?: string;
  size?: number;
  kind: "image";
};

const uploadedImageMetadata = new Map<string, UploadedImage>();

function rememberUploadedImage(image: UploadedImage) {
  uploadedImageMetadata.set(image.url, image);
}

function getUploadedImageMetadata(url: string): UploadedImage | undefined {
  const cached = uploadedImageMetadata.get(url);
  if (cached) return cached;
  if (!url.startsWith("/api/media/")) return undefined;

  return {
    url,
    localPath: url.replace("/api/media/", ""),
    kind: "image",
  };
}

async function uploadImage(
  file: File,
  sessionId?: string,
): Promise<UploadedImage | null> {
  const MAX_SIZE = 10 * 1024 * 1024; // 10MB
  if (file.size > MAX_SIZE) {
    toast.error(
      `Image too large (${Math.round(file.size / 1024 / 1024)}MB). Max 10MB.`,
    );
    return null;
  }

  const formData = new FormData();
  formData.append("file", file);
  if (sessionId) formData.append("sessionId", sessionId);
  formData.append("role", "upload");

  try {
    const response = await fetch("/api/upload", {
      method: "POST",
      body: formData,
    });

    if (!response.ok) {
      toast.error("Failed to upload image");
      return null;
    }

    const data = await response.json();
    const uploadedImage: UploadedImage = {
      url: data.url as string,
      localPath: typeof data.localPath === "string" ? data.localPath : undefined,
      filePath: typeof data.filePath === "string" ? data.filePath : undefined,
      contentType: typeof data.contentType === "string" ? data.contentType : file.type || undefined,
      size: typeof data.size === "number" ? data.size : file.size,
      kind: "image",
    };
    rememberUploadedImage(uploadedImage);
    return uploadedImage;
  } catch {
    toast.error("Failed to upload image");
    return null;
  }
}

// ============================================================================
// Content serialization
// ============================================================================

type TiptapMark = {
  type?: string;
  attrs?: {
    href?: string;
  };
};

function wrapInlineCode(text: string): string {
  const runs = text.match(/`+/g);
  const longestRun = runs ? Math.max(...runs.map((run) => run.length)) : 0;
  const fence = "`".repeat(longestRun + 1);
  return `${fence}${text}${fence}`;
}

function applyTextMarks(
  text: string,
  marks: TiptapMark[],
): string {
  if (marks.length === 0) {
    return text;
  }

  const styleMarks: TiptapMark[] = [];
  let href: string | undefined;

  for (const mark of marks) {
    if (mark.type === "link") {
      href = mark.attrs?.href;
      continue;
    }
    styleMarks.push(mark);
  }

  let markedText = text;

  for (const mark of styleMarks) {
    switch (mark.type) {
      case "bold": {
        markedText = `**${markedText}**`;
        break;
      }
      case "italic": {
        markedText = `*${markedText}*`;
        break;
      }
      case "code": {
        markedText = wrapInlineCode(markedText);
        break;
      }
      case "strike": {
        markedText = `~~${markedText}~~`;
        break;
      }
      default:
        break;
    }
  }

  if (!href) {
    return markedText;
  }

  return `[${markedText}](${href})`;
}

export function plainTextToTiptapDoc(text: string): JSONContent | null {
  if (!text.trim()) {
    return null;
  }

  const normalizedText = text.replace(/\r\n?/g, "\n");
  const paragraphs = normalizedText.split("\n").map((line) => {
    if (line.length === 0) {
      return { type: "paragraph" };
    }

    return {
      type: "paragraph",
      content: [{ type: "text", text: line }],
    };
  });

  return {
    type: "doc",
    content: paragraphs,
  };
}

export function contentPartsToComposerText(parts: ContentPart[]): string {
  return parts
    .filter(
      (part): part is { type: "text"; text: string } =>
        part.type === "text" && typeof part.text === "string",
    )
    .map((part) => part.text)
    .filter((text) => text.length > 0)
    .join("\n")
    .trim();
}

/**
 * Walk the Tiptap document and produce an interleaved content array.
 * Text paragraphs are merged into a single text part until an image
 * node is encountered, which flushes the buffer and emits an image part.
 */
export function serializeDocToContentArray(
  doc: JSONContent | null | undefined,
): ContentPart[] {
  if (!doc) return [];

  const parts: ContentPart[] = [];
  let textBuffer = "";
  let imageIndex = 0;

  const flushText = () => {
    const trimmed = textBuffer.trim();
    if (trimmed) {
      parts.push({ type: "text", text: trimmed });
    }
    textBuffer = "";
  };

  const processNode = (
    node: Record<string, unknown>,
    parentType?: string,
    listItemIndex?: number,
  ) => {
    if (node.type === "image") {
      flushText();
      const attrs = node.attrs as { src?: string } | undefined;
      if (attrs?.src) {
        imageIndex += 1;
        const metadata = getUploadedImageMetadata(attrs.src);
        parts.push({
          type: "image",
          id: `editor-inline-image-${imageIndex}`,
          image: attrs.src,
          displayName: `[Image ${imageIndex}]`,
          contentType: metadata?.contentType,
          localPath: metadata?.localPath,
          filePath: metadata?.filePath,
          size: metadata?.size,
          kind: metadata?.kind,
        });
      }
      return;
    }

    if (node.type === "text") {
      const rawText = (node.text as string) || "";
      const marks = (node.marks as TiptapMark[] | undefined) ?? [];
      textBuffer += applyTextMarks(rawText, marks);
      return;
    }

    const isParagraphInListItem =
      node.type === "paragraph" && parentType === "listItem";

    // Block-level nodes: add newlines for separation.
    if (
      (node.type === "paragraph" ||
        node.type === "heading" ||
        node.type === "blockquote" ||
        node.type === "codeBlock") &&
      !isParagraphInListItem
    ) {
      if (textBuffer && !textBuffer.endsWith("\n")) {
        textBuffer += "\n";
      }
    }

    if (node.type === "bulletList" || node.type === "orderedList") {
      if (textBuffer && !textBuffer.endsWith("\n")) {
        textBuffer += "\n";
      }
    }

    if (node.type === "listItem") {
      if (parentType === "orderedList" && typeof listItemIndex === "number") {
        textBuffer += `${listItemIndex}. `;
      } else {
        textBuffer += "- ";
      }
    }

    if (node.type === "heading") {
      const level = (node.attrs as { level?: number })?.level ?? 2;
      textBuffer += "#".repeat(level) + " ";
    }

    if (node.type === "blockquote") {
      textBuffer += "> ";
    }

    if (node.type === "codeBlock") {
      textBuffer += "```\n";
    }

    const children = node.content as Record<string, unknown>[] | undefined;
    if (children && Array.isArray(children)) {
      if (node.type === "orderedList") {
        const start = (node.attrs as { start?: number })?.start ?? 1;
        let index = start;
        for (const child of children) {
          if (child.type === "listItem") {
            processNode(child, "orderedList", index);
            index += 1;
          } else {
            processNode(child, "orderedList");
          }
        }
      } else {
        const currentType = typeof node.type === "string" ? node.type : undefined;
        for (const child of children) {
          processNode(child, currentType);
        }
      }
    }

    // Close block-level nodes.
    if (node.type === "codeBlock") {
      textBuffer += "\n```";
    }

    if (
      node.type === "paragraph" ||
      node.type === "heading" ||
      node.type === "blockquote" ||
      node.type === "listItem"
    ) {
      if (!textBuffer.endsWith("\n")) {
        textBuffer += "\n";
      }
    }
  };

  const content = doc.content as Record<string, unknown>[] | undefined;
  if (content) {
    for (const node of content) {
      processNode(node);
    }
  }

  flushText();
  return parts;
}

function serializeToContentArray(
  editor: ReturnType<typeof useEditor>,
): ContentPart[] {
  if (!editor) return [];
  return serializeDocToContentArray(editor.getJSON());
}

type VoiceTranscriptDecorationPhase = "polishing" | "swap";

interface VoiceTranscriptRange {
  from: number;
  to: number;
  text: string;
  phase: VoiceTranscriptDecorationPhase;
  sessionId: string;
}

interface VoiceTranscriptDecorationState {
  decorations: DecorationSet;
  ranges: Map<string, VoiceTranscriptRange>;
}

type VoiceTranscriptDecorationMeta =
  | {
      type: "set";
      range: VoiceTranscriptRange;
    }
  | {
      type: "clear";
      sessionId?: string;
      preserveRange?: boolean;
    };

const voiceTranscriptDecorationPluginKey = new PluginKey<VoiceTranscriptDecorationState>(
  "voiceTranscriptDecoration",
);

function getVoiceTranscriptDecorationClassName(
  phase: VoiceTranscriptDecorationPhase,
): string {
  if (phase === "swap") {
    return "rounded-[3px] bg-terminal-green/18 dark:bg-terminal-green/24 shadow-[0_0_0_1px_hsl(var(--terminal-green)/0.22),0_0_18px_hsl(var(--terminal-green)/0.16)] transition-[background-color,box-shadow] duration-300";
  }

  return "rounded-[3px] bg-terminal-green/14 dark:bg-terminal-green/20 shadow-[0_0_0_1px_hsl(var(--terminal-green)/0.18),0_0_12px_hsl(var(--terminal-green)/0.12)] motion-safe:animate-pulse transition-[background-color,box-shadow] duration-200";
}

function buildVoiceTranscriptDecorations(
  doc: EditorState["doc"],
  ranges: Map<string, VoiceTranscriptRange>,
): DecorationSet {
  const decos: Decoration[] = [];
  for (const range of Array.from(ranges.values())) {
    if (range.from < range.to) {
      decos.push(
        Decoration.inline(range.from, range.to, {
          class: getVoiceTranscriptDecorationClassName(range.phase),
          "data-voice-transcript-phase": range.phase,
          "data-voice-session-id": range.sessionId,
        }),
      );
    }
  }
  return decos.length > 0 ? DecorationSet.create(doc, decos) : DecorationSet.empty;
}

const VoiceTranscriptDecorationExtension = Extension.create({
  name: "voiceTranscriptDecoration",

  addProseMirrorPlugins() {
    return [
      new Plugin<VoiceTranscriptDecorationState>({
        key: voiceTranscriptDecorationPluginKey,
        state: {
          init: () => ({
            decorations: DecorationSet.empty,
            ranges: new Map(),
          }),
          apply(tr, pluginState) {
            // Map all existing ranges through the transaction mapping
            const mappedRanges = new Map<string, VoiceTranscriptRange>();
            for (const [id, range] of Array.from(pluginState.ranges.entries())) {
              const newFrom = tr.mapping.map(range.from, -1);
              const newTo = tr.mapping.map(range.to, 1);
              if (newFrom < newTo) {
                mappedRanges.set(id, { ...range, from: newFrom, to: newTo });
              }
            }

            const meta = tr.getMeta(
              voiceTranscriptDecorationPluginKey,
            ) as VoiceTranscriptDecorationMeta | undefined;

            if (meta?.type === "clear") {
              if (meta.sessionId) {
                // Clear a specific session
                if (!meta.preserveRange) {
                  mappedRanges.delete(meta.sessionId);
                }
              } else {
                // Clear all sessions
                if (!meta.preserveRange) {
                  mappedRanges.clear();
                }
              }
              return {
                decorations: buildVoiceTranscriptDecorations(tr.doc, mappedRanges),
                ranges: mappedRanges,
              };
            }

            if (meta?.type === "set") {
              mappedRanges.set(meta.range.sessionId, meta.range);
              return {
                decorations: buildVoiceTranscriptDecorations(tr.doc, mappedRanges),
                ranges: mappedRanges,
              };
            }

            return {
              decorations: buildVoiceTranscriptDecorations(tr.doc, mappedRanges),
              ranges: mappedRanges,
            };
          },
        },
        props: {
          decorations(state) {
            return voiceTranscriptDecorationPluginKey.getState(state)?.decorations ?? null;
          },
        },
      }),
    ];
  },
});

function setVoiceTranscriptDecoration(
  tr: Transaction,
  range: VoiceTranscriptRange,
): Transaction {
  tr.setMeta(voiceTranscriptDecorationPluginKey, {
    type: "set",
    range,
  } satisfies VoiceTranscriptDecorationMeta);
  return tr;
}

function clearVoiceTranscriptDecoration(tr: Transaction, sessionId?: string): Transaction {
  tr.setMeta(voiceTranscriptDecorationPluginKey, {
    type: "clear",
    sessionId,
    preserveRange: !sessionId,
  } satisfies VoiceTranscriptDecorationMeta);
  return tr;
}

/** Default session ID used when callers don't provide one (backwards compat). */
const DEFAULT_VOICE_SESSION_ID = "__default__";

function getTrackedVoiceTranscriptRange(
  state: EditorState,
  sessionId?: string,
): VoiceTranscriptRange | null {
  const ranges = voiceTranscriptDecorationPluginKey.getState(state)?.ranges;
  if (!ranges || ranges.size === 0) return null;

  if (sessionId) {
    return ranges.get(sessionId) ?? null;
  }

  // Backwards compat: return the first (or default) range
  const defaultRange = ranges.get(DEFAULT_VOICE_SESSION_ID);
  if (defaultRange) return defaultRange;
  const allRanges = Array.from(ranges.values());
  return allRanges.length > 0 ? allRanges[0] : null;
}

function getTrackedVoiceTranscriptText(editor: Editor, sessionId?: string): string | null {
  const trackedRange = getTrackedVoiceTranscriptRange(editor.state, sessionId);
  if (!trackedRange || trackedRange.from >= trackedRange.to) {
    return null;
  }

  const currentText = editor.state.doc.textBetween(
    trackedRange.from,
    trackedRange.to,
    "\n",
    "\n",
  );

  return currentText || null;
}

function buildTranscriptInsertionTransaction(
  state: EditorState,
  transcriptText: string,
): Transaction | null {
  const transcriptDoc = plainTextToTiptapDoc(transcriptText);
  if (!transcriptDoc || !Array.isArray(transcriptDoc.content) || transcriptDoc.content.length === 0) {
    return null;
  }

  const { from, to } = state.selection;
  const normalizedFrom = Math.max(0, Math.min(from, state.doc.content.size));
  const normalizedTo = Math.max(normalizedFrom, Math.min(to, state.doc.content.size));
  const leftContext = state.doc.textBetween(Math.max(0, normalizedFrom - 1), normalizedFrom, "", "");
  const rightContext = state.doc.textBetween(normalizedTo, Math.min(state.doc.content.size, normalizedTo + 1), "", "");

  const isSingleParagraph =
    transcriptDoc.content.length === 1
    && transcriptDoc.content[0]?.type === "paragraph";

  if (isSingleParagraph) {
    const paragraph = transcriptDoc.content[0];
    const paragraphText = Array.isArray(paragraph.content)
      ? paragraph.content
        .filter(
          (node): node is { type?: string; text?: string } =>
            node?.type === "text" && typeof node.text === "string",
        )
        .map((node) => node.text)
        .join("")
      : "";

    if (!paragraphText) {
      return null;
    }

    const replacementText = padTranscriptText(paragraphText, leftContext, rightContext);
    if (!replacementText) {
      return null;
    }

    let tr = state.tr.insertText(replacementText, normalizedFrom, normalizedTo);
    tr = tr.setSelection(
      TextSelection.near(tr.doc.resolve(normalizedFrom + replacementText.length)),
    );
    tr.setMeta("addToHistory", true);
    return tr.scrollIntoView();
  }

  const fragmentNodes = transcriptDoc.content.map((node) =>
    state.schema.nodeFromJSON(node),
  );

  if (fragmentNodes.length === 0) {
    return null;
  }

  const slice = new Slice(Fragment.fromArray(fragmentNodes), 0, 0);
  let tr = state.tr.replaceRange(normalizedFrom, normalizedTo, slice);
  const cursorPosition = tr.mapping.map(normalizedFrom + slice.size);
  tr = tr.setSelection(TextSelection.near(tr.doc.resolve(cursorPosition)));
  tr.setMeta("addToHistory", true);
  return tr.scrollIntoView();
}

function insertVoiceTranscriptIntoEditor(
  editor: Editor,
  transcriptText: string,
  sessionId: string = DEFAULT_VOICE_SESSION_ID,
  insertAt?: number,
): boolean {
  // If insertAt specified, move selection there first
  if (insertAt !== undefined) {
    const pos = Math.min(insertAt, editor.state.doc.content.size);
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.near(editor.state.doc.resolve(pos))),
    );
  }

  const { from } = editor.state.selection;
  const transaction = buildTranscriptInsertionTransaction(editor.state, transcriptText);
  if (!transaction) {
    return false;
  }

  const insertedFrom = transaction.mapping.map(from, -1);
  const insertedTo = transaction.selection.from;
  const insertedRangeText = transaction.doc.textBetween(
    insertedFrom,
    insertedTo,
    "\n",
    "\n",
  );

  setVoiceTranscriptDecoration(transaction, {
    from: insertedFrom,
    to: insertedTo,
    text: insertedRangeText || transcriptText,
    phase: "polishing",
    sessionId,
  });

  editor.view.dispatch(transaction);
  return true;
}

function replaceVoiceTranscriptInEditor(
  editor: Editor,
  oldText: string,
  newText: string,
  sessionId: string = DEFAULT_VOICE_SESSION_ID,
): boolean {
  const trackedRange = getTrackedVoiceTranscriptRange(editor.state, sessionId);
  if (!trackedRange) {
    return false;
  }

  const currentText = editor.state.doc.textBetween(
    trackedRange.from,
    trackedRange.to,
    "\n",
    "\n",
  );

  if (!currentText.trim() || currentText.trim() !== oldText.trim()) {
    return false;
  }

  const leftContext = editor.state.doc.textBetween(
    Math.max(0, trackedRange.from - 1),
    trackedRange.from,
    "",
    "",
  );
  const rightContext = editor.state.doc.textBetween(
    trackedRange.to,
    Math.min(editor.state.doc.content.size, trackedRange.to + 1),
    "",
    "",
  );
  const replacementText = padTranscriptText(newText, leftContext, rightContext);

  if (!replacementText) {
    return false;
  }

  let tr = editor.state.tr.insertText(replacementText, trackedRange.from, trackedRange.to);
  const replacementEnd = trackedRange.from + replacementText.length;
  tr = tr.setSelection(TextSelection.near(tr.doc.resolve(replacementEnd)));
  tr.setMeta("addToHistory", true);
  setVoiceTranscriptDecoration(tr, {
    from: trackedRange.from,
    to: replacementEnd,
    text: newText || oldText,
    phase: "swap",
    sessionId,
  });
  editor.view.dispatch(tr.scrollIntoView());
  return true;
}

// ============================================================================
// Component
// ============================================================================

export const TiptapEditor = forwardRef<TiptapEditorHandle, TiptapEditorProps>(
  (
    {
      onSubmit,
      sessionId,
      placeholder = "Write your message... Add images inline with the image button or paste them.",
      disabled = false,
      isSubmitting = false,
      className,
      initialContent = null,
      onDraftChange,
      onDraftClear,
    },
    ref,
  ) => {
    const editor = useEditor({
      content: initialContent ?? undefined,
      onUpdate: ({ editor: currentEditor }) => {
        onDraftChange?.(currentEditor.isEmpty ? null : currentEditor.getJSON());
      },
      extensions: [
        VoiceTranscriptDecorationExtension,
        StarterKit.configure({
          heading: { levels: [2, 3] },
        }),
        Image.configure({
          inline: false,
          allowBase64: true,
          HTMLAttributes: {
            class:
              "rounded-md max-w-full max-h-64 object-contain my-2 border border-terminal-border",
          },
        }),
        Placeholder.configure({
          placeholder,
          emptyEditorClass:
            "before:content-[attr(data-placeholder)] before:text-terminal-muted before:float-left before:h-0 before:pointer-events-none",
        }),
      ],
      editorProps: {
        attributes: {
          class:
            "prose prose-sm max-w-none focus:outline-none min-h-[120px] max-h-[400px] overflow-y-auto px-4 py-3 font-mono text-sm text-terminal-dark",
        },
        handleKeyDown: (view, event) => {
          if (event.key !== "Tab") return false;

          const { state } = view;
          const { $from } = state.selection;

          // Only intercept Tab inside code blocks
          const insideCodeBlock = $from.parent.type.name === "codeBlock";
          if (!insideCodeBlock) return false;

          event.preventDefault();

          if (event.shiftKey) {
            // Shift+Tab: dedent — remove up to 2 leading spaces from current line
            const lineStart = $from.start();
            const textBefore = state.doc.textBetween(
              lineStart,
              $from.pos,
              "\n",
            );
            const currentLineStart =
              textBefore.lastIndexOf("\n") === -1
                ? lineStart
                : lineStart + textBefore.lastIndexOf("\n") + 1;
            const lineText = state.doc.textBetween(
              currentLineStart,
              Math.min(currentLineStart + 2, $from.end()),
            );
            const spacesToRemove = lineText.startsWith("  ")
              ? 2
              : lineText.startsWith(" ")
                ? 1
                : 0;
            if (spacesToRemove > 0) {
              const tr = state.tr.delete(
                currentLineStart,
                currentLineStart + spacesToRemove,
              );
              view.dispatch(tr);
            }
          } else {
            // Tab: insert 2 spaces
            const tr = state.tr.insertText("  ", $from.pos);
            view.dispatch(tr);
          }

          return true;
        },
        handleDrop: (view, event, _slice, moved) => {
          if (moved) return false;

          const files = event.dataTransfer?.files;
          if (!files?.length) return false;

          for (const file of files) {
            if (file.type.startsWith("image/")) {
              event.preventDefault();
              void handleImageFile(file, view.state.selection.anchor);
              return true;
            }
          }
          return false;
        },
        handlePaste: (_view, event) => {
          const items = event.clipboardData?.items;
          if (!items) return false;

          for (const item of items) {
            if (item.type.startsWith("image/")) {
              event.preventDefault();
              const file = item.getAsFile();
              if (file) {
                void handleImageFile(file);
              }
              return true;
            }
          }
          return false;
        },
      },
      immediatelyRender: false,
    });

    const handleImageFile = useCallback(
      async (file: File, position?: number) => {
        if (!editor) return;

        // Show local preview immediately
        const localUrl = URL.createObjectURL(file);
        if (position !== undefined) {
          editor
            .chain()
            .focus()
            .insertContentAt(position, {
              type: "image",
              attrs: { src: localUrl },
            })
            .run();
        } else {
          editor
            .chain()
            .focus()
            .setImage({ src: localUrl })
            .run();
        }

        // Upload to server
        const uploadedImage = await uploadImage(file, sessionId);

        if (uploadedImage) {
          // Replace local URL with remote URL in all image nodes
          const { doc } = editor.state;
          const tr = editor.state.tr;
          let replaced = false;

          doc.descendants((node, pos) => {
            if (
              node.type.name === "image" &&
              node.attrs.src === localUrl
            ) {
              tr.setNodeMarkup(pos, undefined, {
                ...node.attrs,
                src: uploadedImage.url,
              });
              replaced = true;
            }
          });

          if (replaced) {
            editor.view.dispatch(tr);
          }
        } else {
          // Upload failed — remove the placeholder image
          const { doc } = editor.state;
          const tr = editor.state.tr;
          let offset = 0;

          doc.descendants((node, pos) => {
            if (
              node.type.name === "image" &&
              node.attrs.src === localUrl
            ) {
              tr.delete(pos - offset, pos - offset + node.nodeSize);
              offset += node.nodeSize;
            }
          });

          if (offset > 0) {
            editor.view.dispatch(tr);
          }
        }

        URL.revokeObjectURL(localUrl);
      },
      [editor, sessionId],
    );

    const handleSubmitClick = useCallback(() => {
      if (!editor || disabled || isSubmitting) return;
      const contentArray = serializeToContentArray(editor);
      if (contentArray.length === 0) return;
      onSubmit(contentArray);
    }, [editor, disabled, isSubmitting, onSubmit]);

    // Cmd/Ctrl+Enter to submit
    useEffect(() => {
      if (!editor) return;

      const handleKeyDown = (event: KeyboardEvent) => {
        if (
          event.key === "Enter" &&
          (event.metaKey || event.ctrlKey) &&
          !disabled &&
          !isSubmitting
        ) {
          event.preventDefault();
          handleSubmitClick();
        }
      };

      const editorElement = editor.view.dom;
      editorElement.addEventListener("keydown", handleKeyDown);
      return () => {
        editorElement.removeEventListener("keydown", handleKeyDown);
      };
    }, [editor, disabled, isSubmitting, handleSubmitClick]);

    // Expose handle
    useImperativeHandle(ref, () => ({
      getContentArray: () =>
        editor ? serializeToContentArray(editor) : [],
      hasContent: () => {
        if (!editor) return false;
        return !editor.isEmpty;
      },
      insertVoiceTranscript: (text: string, sessionId?: string, insertAt?: number) => {
        if (!editor) return false;
        return insertVoiceTranscriptIntoEditor(editor, text, sessionId, insertAt);
      },
      replaceVoiceTranscript: (oldText: string, newText: string, sessionId?: string) => {
        if (!editor) return false;
        return replaceVoiceTranscriptInEditor(editor, oldText, newText, sessionId);
      },
      clearVoiceTranscriptDecoration: (sessionId?: string) => {
        if (!editor) return;
        const tr = clearVoiceTranscriptDecoration(editor.state.tr, sessionId);
        editor.view.dispatch(tr);
      },
      getTrackedVoiceTranscriptText: (sessionId?: string) => {
        if (!editor) return null;
        return getTrackedVoiceTranscriptText(editor, sessionId);
      },
      clear: () => {
        editor?.commands.clearContent();
        onDraftClear?.();
      },
      focus: () => {
        editor?.commands.focus();
      },
    }));

    if (!editor) return null;

    return (
      <div
        className={cn(
          "rounded-lg border border-terminal-border bg-terminal-cream/80 shadow-md transition-shadow focus-within:shadow-lg",
          className,
        )}
      >
        {/* Toolbar */}
        <div className="flex items-center gap-0.5 border-b border-terminal-border px-2 py-1 flex-wrap">
          <ToolbarButton
            onClick={() => editor.chain().focus().toggleBold().run()}
            active={editor.isActive("bold")}
            icon={<BoldIcon className="size-3.5" />}
            tooltip="Bold"
          />
          <ToolbarButton
            onClick={() => editor.chain().focus().toggleItalic().run()}
            active={editor.isActive("italic")}
            icon={<ItalicIcon className="size-3.5" />}
            tooltip="Italic"
          />
          <ToolbarButton
            onClick={() =>
              editor.chain().focus().toggleHeading({ level: 2 }).run()
            }
            active={editor.isActive("heading", { level: 2 })}
            icon={<Heading2Icon className="size-3.5" />}
            tooltip="Heading"
          />
          <div className="mx-1 h-4 w-px bg-terminal-border" />
          <ToolbarButton
            onClick={() =>
              editor.chain().focus().toggleBulletList().run()
            }
            active={editor.isActive("bulletList")}
            icon={<ListIcon className="size-3.5" />}
            tooltip="Bullet list"
          />
          <ToolbarButton
            onClick={() =>
              editor.chain().focus().toggleOrderedList().run()
            }
            active={editor.isActive("orderedList")}
            icon={<ListOrderedIcon className="size-3.5" />}
            tooltip="Ordered list"
          />
          <ToolbarButton
            onClick={() =>
              editor.chain().focus().toggleBlockquote().run()
            }
            active={editor.isActive("blockquote")}
            icon={<QuoteIcon className="size-3.5" />}
            tooltip="Quote"
          />
          <ToolbarButton
            onClick={() =>
              editor.chain().focus().toggleCodeBlock().run()
            }
            active={editor.isActive("codeBlock")}
            icon={<CodeIcon className="size-3.5" />}
            tooltip="Code block"
          />
        </div>

        {/* Editor content */}
        <EditorContent editor={editor} />
      </div>
    );
  },
);

TiptapEditor.displayName = "TiptapEditor";

// ============================================================================
// Toolbar Button
// ============================================================================

function ToolbarButton({
  onClick,
  active,
  icon,
  tooltip,
  disabled = false,
}: {
  onClick: () => void;
  active: boolean;
  icon: React.ReactNode;
  tooltip: string;
  disabled?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onMouseDown={(e) => {
            // Prevent focus loss when clicking toolbar buttons
            // This ensures the editor maintains its selection
            e.preventDefault();
          }}
          onClick={onClick}
          disabled={disabled}
          className={cn(
            "rounded p-1.5 transition-colors",
            active
              ? "bg-terminal-dark/15 text-terminal-dark"
              : "text-terminal-muted hover:text-terminal-dark hover:bg-terminal-dark/5",
            disabled && "opacity-50 cursor-not-allowed",
          )}
        >
          {icon}
        </button>
      </TooltipTrigger>
      <TooltipContent className="bg-terminal-dark text-terminal-cream font-mono text-xs">
        {tooltip}
      </TooltipContent>
    </Tooltip>
  );
}
