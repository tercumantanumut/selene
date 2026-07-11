"use client";

import type { FC } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface StandaloneMarkdownProps {
  content: string;
  className?: string;
}

/**
 * Standalone Markdown renderer for use outside of assistant-ui message context.
 * Unlike MarkdownText, this doesn't require MessagePrimitive.Parts context.
 */
export const StandaloneMarkdown: FC<StandaloneMarkdownProps> = ({ content, className }) => {
  return (
    <div className={className}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children, ...props }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-terminal-green underline underline-offset-4 hover:text-terminal-green/80"
              {...props}
            >
              {children}
            </a>
          ),
          pre: ({ children, ...props }) => (
            <pre
              className="overflow-x-auto rounded-lg bg-terminal-dark/5 p-4 text-sm font-mono text-terminal-dark my-2"
              {...props}
            >
              {children}
            </pre>
          ),
          code: ({ children, className, ...props }) => {
            // Check if it's an inline code or code block
            const isInline = !className;
            return isInline ? (
              <code
                className="rounded bg-terminal-dark/10 px-1.5 py-0.5 text-sm font-mono text-terminal-dark"
                {...props}
              >
                {children}
              </code>
            ) : (
              <code className={className} {...props}>
                {children}
              </code>
            );
          },
          ul: ({ children, ...props }) => (
            <ul className="list-disc pl-6 space-y-1 my-2" {...props}>
              {children}
            </ul>
          ),
          ol: ({ children, ...props }) => (
            <ol className="list-decimal pl-6 space-y-1 my-2" {...props}>
              {children}
            </ol>
          ),
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
          h4: ({ children, ...props }) => (
            <h4 className="text-base font-semibold font-mono mt-3 mb-1 text-terminal-dark" {...props}>
              {children}
            </h4>
          ),
          p: ({ children, ...props }) => (
            <p className="mb-2 last:mb-0" {...props}>
              {children}
            </p>
          ),
          blockquote: ({ children, ...props }) => (
            <blockquote
              className="border-l-4 border-terminal-dark/30 pl-4 italic text-terminal-dark/80 my-3"
              {...props}
            >
              {children}
            </blockquote>
          ),
          table: ({ children, ...props }) => (
            <div className="overflow-x-auto my-3">
              <table className="min-w-full border-collapse border border-terminal-dark/20" {...props}>
                {children}
              </table>
            </div>
          ),
          th: ({ children, ...props }) => (
            <th className="border border-terminal-dark/20 bg-terminal-dark/5 px-4 py-2 text-left font-mono text-terminal-dark" {...props}>
              {children}
            </th>
          ),
          td: ({ children, ...props }) => (
            <td className="border border-terminal-dark/20 px-4 py-2" {...props}>
              {children}
            </td>
          ),
          hr: ({ ...props }) => (
            <hr className="my-4 border-terminal-dark/20" {...props} />
          ),
          strong: ({ children, ...props }) => (
            <strong className="font-semibold text-terminal-dark" {...props}>
              {children}
            </strong>
          ),
          em: ({ children, ...props }) => (
            <em className="italic" {...props}>
              {children}
            </em>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
};

