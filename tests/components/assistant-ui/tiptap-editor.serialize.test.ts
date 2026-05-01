import type { JSONContent } from "@tiptap/core";
import { describe, expect, it } from "vitest";

import {
  contentPartsToComposerText,
  serializeDocToContentArray,
} from "@/components/assistant-ui/tiptap-editor";

describe("serializeDocToContentArray", () => {
  it("serializes inline marks into markdown", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "plain " },
            { type: "text", text: "bold", marks: [{ type: "bold" }] },
            { type: "text", text: " " },
            { type: "text", text: "italic", marks: [{ type: "italic" }] },
            { type: "text", text: " " },
            { type: "text", text: "code", marks: [{ type: "code" }] },
            { type: "text", text: " " },
            { type: "text", text: "strike", marks: [{ type: "strike" }] },
            { type: "text", text: " " },
            {
              type: "text",
              text: "link",
              marks: [
                {
                  type: "link",
                  attrs: { href: "https://example.com" },
                },
              ],
            },
          ],
        },
      ],
    };

    expect(serializeDocToContentArray(doc)).toEqual([
      {
        type: "text",
        text: "plain **bold** *italic* `code` ~~strike~~ [link](https://example.com)",
      },
    ]);
  });

  it("applies style marks before wrapping links", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "combo",
              marks: [
                { type: "bold" },
                {
                  type: "link",
                  attrs: { href: "https://example.com/combo" },
                },
              ],
            },
          ],
        },
      ],
    };

    expect(serializeDocToContentArray(doc)).toEqual([
      {
        type: "text",
        text: "[**combo**](https://example.com/combo)",
      },
    ]);
  });

  it("uses safe inline code fences when text contains backticks", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "a`b",
              marks: [{ type: "code" }],
            },
          ],
        },
      ],
    };

    expect(serializeDocToContentArray(doc)).toEqual([
      { type: "text", text: "``a`b``" },
    ]);
  });

  it("serializes ordered lists with numeric prefixes", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [
        {
          type: "orderedList",
          attrs: { start: 3 },
          content: [
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "third" }],
                },
              ],
            },
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "fourth" }],
                },
              ],
            },
          ],
        },
      ],
    };

    expect(serializeDocToContentArray(doc)).toEqual([
      {
        type: "text",
        text: "3. third\n4. fourth",
      },
    ]);
  });

  it("keeps text and image parts interleaved", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "hello", marks: [{ type: "bold" }] }],
        },
        {
          type: "image",
          attrs: { src: "https://example.com/a.png" },
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: "after", marks: [{ type: "italic" }] }],
        },
      ],
    };

    expect(serializeDocToContentArray(doc)).toEqual([
      { type: "text", text: "**hello**" },
      {
        type: "image",
        id: "editor-inline-image-1",
        image: "https://example.com/a.png",
        displayName: "[Image 1]",
      },
      { type: "text", text: "*after*" },
    ]);
  });
});

describe("contentPartsToComposerText", () => {
  it("joins text parts with newlines and ignores non-text parts", () => {
    expect(
      contentPartsToComposerText([
        { type: "text", text: "first line" },
        { type: "image", image: "https://example.com/image.png" },
        { type: "text", text: "second line" },
      ]),
    ).toBe("first line\nsecond line");
  });

  it("trims and returns empty string when no text parts are present", () => {
    expect(
      contentPartsToComposerText([
        { type: "image", image: "https://example.com/image.png" },
      ]),
    ).toBe("");
  });
});
