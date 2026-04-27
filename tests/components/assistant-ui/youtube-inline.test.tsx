/** @vitest-environment jsdom */

import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { YouTubeInlinePreview } from "@/components/assistant-ui/youtube-inline";

describe("YouTubeInlinePreview", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    flushSync(() => {
      root.unmount();
    });
    container.remove();
  });

  it("keeps hook order stable when a message gains a YouTube link", () => {
    flushSync(() => {
      root.render(createElement(YouTubeInlinePreview, { messageText: "plain text only" }));
    });

    expect(() => {
      flushSync(() => {
        root.render(
          createElement(YouTubeInlinePreview, {
            messageText: "watch this https://www.youtube.com/watch?v=dQw4w9WgXcQ",
          })
        );
      });
    }).not.toThrow();

    expect(container.querySelectorAll("a")).toHaveLength(1);
  });

  it("deduplicates repeated links to the same video", () => {
    flushSync(() => {
      root.render(
        createElement(YouTubeInlinePreview, {
          messageText:
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ\nhttps://youtu.be/dQw4w9WgXcQ",
        })
      );
    });

    expect(container.querySelectorAll("a")).toHaveLength(1);
  });
});
