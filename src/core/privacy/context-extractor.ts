import { PublicError } from "../requests/public-error";
import { estimateTokens } from "../requests/token-estimator";
import type { SelectionSnapshot } from "./selection";
import { isVisibleReadingNode } from "./visibility";

const MAX_NEARBY_CONTEXT_TOKENS = 400;
const READING_BLOCK_SELECTOR = [
  "p",
  "li",
  "pre",
  "blockquote",
  "figcaption",
  "dd",
  "dt",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "article",
  "section",
].join(",");
const CONTEXT_EXCLUSION_SELECTOR = [
  "form",
  "menu",
  "nav",
  "[role='menu']",
  "[role='menubar']",
  "[role='navigation']",
].join(",");

export interface NearbyContext {
  text: string;
  estimatedTokens: number;
  sourceBlockCount: number;
}

function normalizeContextText(value: string): string {
  return value.normalize("NFC").replace(/\s+/gu, " ").trim();
}

function isAllowedReadingBlock(element: Element): boolean {
  return (
    element.matches(READING_BLOCK_SELECTOR) &&
    element.closest(CONTEXT_EXCLUSION_SELECTOR) === null &&
    isVisibleReadingNode(element)
  );
}

function nearestReadingSibling(
  block: Element,
  direction: "previous" | "next",
): Element | undefined {
  const bodyBoundary = block.parentElement === block.ownerDocument.body;
  let sibling =
    direction === "previous" ? block.previousElementSibling : block.nextElementSibling;

  while (sibling !== null) {
    if (isAllowedReadingBlock(sibling)) return sibling;
    if (bodyBoundary) return undefined;
    sibling =
      direction === "previous"
        ? sibling.previousElementSibling
        : sibling.nextElementSibling;
  }

  return undefined;
}

function visibleBlockText(block: Element): string {
  const parts: string[] = [];
  const walker = block.ownerDocument.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();

  while (node !== null) {
    const parent = node.parentElement;
    if (
      parent !== null &&
      parent.closest(CONTEXT_EXCLUSION_SELECTOR) === null &&
      isVisibleReadingNode(node)
    ) {
      parts.push(node.nodeValue ?? "");
    }
    node = walker.nextNode();
  }

  return normalizeContextText(parts.join(""));
}

function withoutSelectedText(blockText: string, selectedText: string): string {
  const index = blockText.indexOf(selectedText);
  if (index < 0) return blockText;
  return normalizeContextText(
    `${blockText.slice(0, index)} ${blockText.slice(index + selectedText.length)}`,
  );
}

function contextTooLarge(): PublicError {
  return new PublicError(
    "CONTEXT_TOO_LARGE",
    "CONTEXT_TOO_LARGE: One nearby reading block is too large.",
    true,
  );
}

export function extractNearbyContext(
  snapshot: SelectionSnapshot,
  enabled: boolean,
): NearbyContext {
  if (!enabled) return { text: "", estimatedTokens: 0, sourceBlockCount: 0 };

  const localBlock = snapshot.anchorElement.closest(READING_BLOCK_SELECTOR);
  if (localBlock === null || !isAllowedReadingBlock(localBlock)) {
    return { text: "", estimatedTokens: 0, sourceBlockCount: 0 };
  }

  const candidates = [
    localBlock,
    nearestReadingSibling(localBlock, "previous"),
    nearestReadingSibling(localBlock, "next"),
  ];
  const accepted: string[] = [];

  for (const candidate of candidates) {
    if (candidate === undefined) continue;
    const visibleText = visibleBlockText(candidate);
    const text =
      candidate === localBlock
        ? withoutSelectedText(visibleText, snapshot.text)
        : visibleText;
    if (text.length === 0) continue;
    if (estimateTokens(text) > MAX_NEARBY_CONTEXT_TOKENS) throw contextTooLarge();

    const combined = [...accepted, text].join("\n\n");
    if (estimateTokens(combined) > MAX_NEARBY_CONTEXT_TOKENS) break;
    accepted.push(text);
  }

  const text = accepted.join("\n\n");
  return {
    text,
    estimatedTokens: estimateTokens(text),
    sourceBlockCount: accepted.length,
  };
}
