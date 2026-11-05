/**
 * Strip Markdown formatting and return plain text.
 *
 * Used by the "Copy as text" action so the clipboard receives readable text
 * without Markdown syntax markers (headings, emphasis, code fences, links,
 * images, blockquotes, list markers, etc.).
 *
 * This is a lightweight, synchronous, regex-based stripper. It intentionally
 * avoids instantiating a markdown-it instance on the main thread (the heavy
 * rendering pipeline lives in the Web Worker) and covers the common Markdown
 * subset produced by AI responses. Edge cases are acceptable here — the user
 * also has the "Copy as Markdown" option for a verbatim source copy.
 *
 * @param markdown Raw Markdown source string.
 * @returns Plain text with Markdown syntax removed.
 */
export const stripMarkdown = (markdown: string): string => {
  return markdown
    // Fenced code blocks: keep inner content, drop the fences and language tag.
    .replace(/```[^\n]*\n?([\s\S]*?)```/g, (_match, code: string) =>
      code.replace(/\n$/, "")
    )
    // Headings: remove leading '#' marks and surrounding spaces.
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    // Bold + italic combos (***text*** or ___text___).
    .replace(/\*\*\*([^*]+)\*\*\*/g, "$1")
    .replace(/___([^_]+)___/g, "$1")
    // Bold (**text** or __text__).
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    // Italic (*text* or _text_).
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "$1")
    .replace(/(?<!_)_([^_\n]+)_(?!_)/g, "$1")
    // Strikethrough (~~text~~).
    .replace(/~~([^~]+)~~/g, "$1")
    // Images: ![alt](url) -> alt.
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    // Links: [text](url) -> text.
    .replace(/\[([^\]]*)\]\([^)]+\)/g, "$1")
    // Reference-style links: [text][ref] -> text.
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, "$1")
    // Inline code: `code` -> code.
    .replace(/`([^`]+)`/g, "$1")
    // Blockquotes: remove leading '>' markers.
    .replace(/^\s{0,3}>\s?/gm, "")
    // Unordered list markers (-, +, *).
    .replace(/^\s{0,3}[-+*]\s+/gm, "")
    // Ordered list markers (1. 2. etc.).
    .replace(/^\s{0,3}\d+\.\s+/gm, "")
    // Horizontal rules (---, ***, ___).
    .replace(/^\s{0,3}[-*_]{3,}\s*$/gm, "")
    // Collapse 3+ consecutive newlines into a single blank line.
    .replace(/\n{3,}/g, "\n\n")
    .trim();
};
