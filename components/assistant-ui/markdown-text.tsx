"use client";

import { createContext, useContext, type FC, type ReactNode, type HTMLAttributes } from "react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import remarkGfm from "remark-gfm";
import { SyntaxHighlighter, UserSyntaxHighlighter } from "./shiki-highlighter";
import { ImageLinkPreview } from "./image-link-preview";

// Context to track if we're inside an anchor tag (prevents nested <a> tags)
const InsideAnchorContext = createContext(false);

function extractTextContent(node: ReactNode): string | null {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (!Array.isArray(node)) return null;

  const parts: string[] = [];
  for (const part of node) {
    const text = extractTextContent(part);
    if (text === null) return null;
    parts.push(text);
  }

  return parts.join("");
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

const SmartInlineCode: FC<{
  children?: ReactNode;
  codeClassName: string;
  linkClassName: string;
  codeProps?: HTMLAttributes<HTMLElement>;
}> = ({ children, codeClassName, linkClassName, codeProps }) => {
  const isInsideAnchor = useContext(InsideAnchorContext);
  const maybeUrl = extractTextContent(children)?.trim();

  if (!isInsideAnchor && maybeUrl && isHttpUrl(maybeUrl)) {
    return (
      <AnchorWithContext href={maybeUrl} className={linkClassName}>
        <code className={codeClassName} {...codeProps}>
          {children}
        </code>
      </AnchorWithContext>
    );
  }

  return (
    <code className={codeClassName} {...codeProps}>
      {children}
    </code>
  );
};

// Wrapper component for anchor tags that provides context
const AnchorWithContext: FC<{
  href?: string;
  children?: ReactNode;
  className: string;
  [key: string]: unknown;
}> = ({ href, children, className, ...props }) => (
  <InsideAnchorContext.Provider value={true}>
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={className}
      {...props}
    >
      {children}
    </a>
  </InsideAnchorContext.Provider>
);

// Image component that only wraps in anchor if not already inside one
const SmartImage: FC<{
  src?: string;
  alt?: string;
  linkClassName: string;
}> = ({ src, alt, linkClassName }) => {
  const isInsideAnchor = useContext(InsideAnchorContext);

  // If already inside an anchor, just render the image indicator without wrapping in another <a>
  if (isInsideAnchor) {
    return (
      <span className="inline-flex items-center gap-1.5">
        <span>🖼️</span>
        <span>{alt || "View image"}</span>
      </span>
    );
  }

  // Not inside an anchor, wrap in clickable link
  return (
    <a
      href={typeof src === 'string' ? src : undefined}
      target="_blank"
      rel="noopener noreferrer"
      className={linkClassName}
    >
      <span>🖼️</span>
      <span>{alt || "View image"}</span>
    </a>
  );
};

// The text prop comes from MessagePrimitive.Content, but MarkdownTextPrimitive
// reads from context - it doesn't need to be passed as children
export const MarkdownText: FC<{ text: string }> = () => {
  return (
    <MarkdownTextPrimitive
      remarkPlugins={[remarkGfm]}
      components={{
        // Syntax highlighting for code blocks
        SyntaxHighlighter,
        // Override link to open in new tab (with context to prevent nested anchors)
        a: ({ href, children, ...props }) => (
          <ImageLinkPreview
            href={href}
            fallback={AnchorWithContext}
            className="text-terminal-green underline underline-offset-4 hover:text-terminal-green/80"
            {...props}
          >
            {children}
          </ImageLinkPreview>
        ),
        // Convert embedded images to clickable links (only if not already inside an anchor)
        img: ({ src, alt }) => (
          <SmartImage
            src={typeof src === 'string' ? src : undefined}
            alt={alt}
            linkClassName="inline-flex items-center gap-1.5 text-terminal-green underline underline-offset-4 hover:text-terminal-green/80"
          />
        ),
        // Inline code (not code blocks - those use SyntaxHighlighter)
        code: ({ children, ...props }) => (
          <SmartInlineCode
            children={children}
            codeClassName="rounded bg-terminal-dark/10 px-1.5 py-0.5 text-sm font-mono text-terminal-dark"
            linkClassName="inline-flex items-center text-terminal-green underline underline-offset-4 hover:text-terminal-green/80"
            codeProps={props as HTMLAttributes<HTMLElement>}
          />
        ),
        // Lists
        ul: ({ children, ...props }) => (
          <ul className="list-disc pl-6 space-y-1" {...props}>
            {children}
          </ul>
        ),
        ol: ({ children, ...props }) => (
          <ol className="list-decimal pl-6 space-y-1" {...props}>
            {children}
          </ol>
        ),
        // Headings
        h1: ({ children, ...props }) => (
          <h1 className="text-2xl font-bold font-mono mt-4 mb-2 text-terminal-dark" {...props}>
            {children}
          </h1>
        ),
        h2: ({ children, ...props }) => (
          <h2 className="text-xl font-bold font-mono mt-3 mb-2 text-terminal-dark" {...props}>
            {children}
          </h2>
        ),
        h3: ({ children, ...props }) => (
          <h3 className="text-lg font-semibold font-mono mt-2 mb-1 text-terminal-dark" {...props}>
            {children}
          </h3>
        ),
        // Paragraphs
        p: ({ children, ...props }) => (
          <p className="mb-2 last:mb-0" {...props}>
            {children}
          </p>
        ),
        // Blockquotes
        blockquote: ({ children, ...props }) => (
          <blockquote
            className="border-l-4 border-terminal-dark/30 pl-4 italic text-terminal-dark/80"
            {...props}
          >
            {children}
          </blockquote>
        ),
        // Tables
        table: ({ children, ...props }) => (
          <div className="overflow-x-auto">
            <table
              className="min-w-full border-collapse border border-terminal-border"
              {...props}
            >
              {children}
            </table>
          </div>
        ),
        th: ({ children, ...props }) => (
          <th className="border border-terminal-border bg-terminal-dark/5 px-4 py-2 text-left font-mono text-terminal-dark" {...props}>
            {children}
          </th>
        ),
        td: ({ children, ...props }) => (
          <td className="border border-terminal-border px-4 py-2" {...props}>
            {children}
          </td>
        ),
      }}
    />
  );
};

/**
 * UserMarkdownText - Markdown renderer for user messages (dark background)
 * Uses light text colors that are visible on bg-terminal-dark
 */
export const UserMarkdownText: FC<{ text: string }> = () => {
  return (
    <MarkdownTextPrimitive
      remarkPlugins={[remarkGfm]}
      components={{
        // Syntax highlighting for code blocks (uses light theme for dark bg)
        SyntaxHighlighter: UserSyntaxHighlighter,
        // Override link to open in new tab (with context to prevent nested anchors)
        a: ({ href, children, ...props }) => (
          <AnchorWithContext
            href={href}
            className="text-terminal-amber underline underline-offset-4 hover:text-terminal-amber/80"
            {...props}
          >
            {children}
          </AnchorWithContext>
        ),
        // Convert embedded images to clickable links (only if not already inside an anchor)
        img: ({ src, alt }) => (
          <SmartImage
            src={typeof src === 'string' ? src : undefined}
            alt={alt}
            linkClassName="inline-flex items-center gap-1.5 text-terminal-amber underline underline-offset-4 hover:text-terminal-amber/80"
          />
        ),
        // Inline code - light text on slightly lighter dark background
        code: ({ children, ...props }) => (
          <SmartInlineCode
            children={children}
            codeClassName="rounded bg-terminal-cream/10 px-1.5 py-0.5 text-sm font-mono text-terminal-cream"
            linkClassName="inline-flex items-center text-terminal-amber underline underline-offset-4 hover:text-terminal-amber/80"
            codeProps={props as HTMLAttributes<HTMLElement>}
          />
        ),
        // Lists - inherit text color (terminal-cream from parent)
        ul: ({ children, ...props }) => (
          <ul className="list-disc pl-6 space-y-1 text-terminal-cream" {...props}>
            {children}
          </ul>
        ),
        ol: ({ children, ...props }) => (
          <ol className="list-decimal pl-6 space-y-1 text-terminal-cream" {...props}>
            {children}
          </ol>
        ),
        // Headings - light text
        h1: ({ children, ...props }) => (
          <h1 className="text-2xl font-bold font-mono mt-4 mb-2 text-terminal-cream" {...props}>
            {children}
          </h1>
        ),
        h2: ({ children, ...props }) => (
          <h2 className="text-xl font-bold font-mono mt-3 mb-2 text-terminal-cream" {...props}>
            {children}
          </h2>
        ),
        h3: ({ children, ...props }) => (
          <h3 className="text-lg font-semibold font-mono mt-2 mb-1 text-terminal-cream" {...props}>
            {children}
          </h3>
        ),
        // Paragraphs
        p: ({ children, ...props }) => (
          <p className="mb-2 last:mb-0 text-terminal-cream" {...props}>
            {children}
          </p>
        ),
        // Blockquotes
        blockquote: ({ children, ...props }) => (
          <blockquote
            className="border-l-4 border-terminal-cream/30 pl-4 italic text-terminal-cream/80"
            {...props}
          >
            {children}
          </blockquote>
        ),
        // Tables
        table: ({ children, ...props }) => (
          <div className="overflow-x-auto">
            <table
              className="min-w-full border-collapse border border-terminal-cream/30"
              {...props}
            >
              {children}
            </table>
          </div>
        ),
        th: ({ children, ...props }) => (
          <th className="border border-terminal-cream/30 bg-terminal-cream/10 px-4 py-2 text-left font-mono text-terminal-cream" {...props}>
            {children}
          </th>
        ),
        td: ({ children, ...props }) => (
          <td className="border border-terminal-cream/30 px-4 py-2 text-terminal-cream" {...props}>
            {children}
          </td>
        ),
      }}
    />
  );
};
