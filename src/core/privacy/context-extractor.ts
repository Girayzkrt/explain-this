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
const EXCLUDED_CONTEXT_ELEMENTS = new Set(["FORM", "MENU", "NAV"]);
const EXCLUDED_CONTEXT_ROLES = new Set(["menu", "menubar", "navigation"]);
const BUDGET_CHECK_INTERVAL = 64;

export interface NearbyContext {
  text: string;
  estimatedTokens: number;
  sourceBlockCount: number;
}

function normalizeContextText(value: string): string {
  return value.normalize("NFC").replace(/\s+/gu, " ").trim();
}

function hasExcludedContextAncestry(element: Element): boolean {
  let current: Element | null = element;

  while (current !== null) {
    if (EXCLUDED_CONTEXT_ELEMENTS.has(current.tagName)) return true;

    const roles = current.getAttribute("role")?.trim().split(/\s+/u) ?? [];
    if (roles.some((role) => EXCLUDED_CONTEXT_ROLES.has(role.toLowerCase()))) {
      return true;
    }

    current = current.parentElement;
  }

  return false;
}

function isAllowedReadingBlock(element: Element): boolean {
  return (
    element.matches(READING_BLOCK_SELECTOR) &&
    !hasExcludedContextAncestry(element) &&
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

interface VisibleBlockText {
  text: string;
  exceedsLimit: boolean;
}

function visibleBlockText(block: Element, tokenLimit: number): VisibleBlockText {
  let compactText = "";
  let endsInWhitespace = false;
  let charactersSinceBudgetCheck = 0;
  const walker = block.ownerDocument.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();

  while (node !== null) {
    const parent = node.parentElement;
    if (
      parent !== null &&
      !hasExcludedContextAncestry(parent) &&
      isVisibleReadingNode(node)
    ) {
      for (const character of node.nodeValue ?? "") {
        const isWhitespace = /\s/u.test(character);
        if (isWhitespace) {
          if (compactText.length === 0 || endsInWhitespace) {
            endsInWhitespace = true;
            continue;
          }
          compactText += " ";
          endsInWhitespace = true;
        } else {
          compactText += character;
          endsInWhitespace = false;
        }

        charactersSinceBudgetCheck += 1;
        if (charactersSinceBudgetCheck >= BUDGET_CHECK_INTERVAL) {
          const normalized = normalizeContextText(compactText);
          if (estimateTokens(normalized) > tokenLimit) {
            return { text: "", exceedsLimit: true };
          }
          charactersSinceBudgetCheck = 0;
        }
      }
    }
    node = walker.nextNode();
  }

  const text = normalizeContextText(compactText);
  return { text, exceedsLimit: estimateTokens(text) > tokenLimit };
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
    const isLocalBlock = candidate === localBlock;
    const traversalLimit = isLocalBlock
      ? MAX_NEARBY_CONTEXT_TOKENS + estimateTokens(snapshot.text) + 2
      : MAX_NEARBY_CONTEXT_TOKENS;
    const visible = visibleBlockText(candidate, traversalLimit);
    if (visible.exceedsLimit) {
      if (isLocalBlock) throw contextTooLarge();
      break;
    }

    const text = isLocalBlock
      ? withoutSelectedText(visible.text, snapshot.text)
      : visible.text;
    if (text.length === 0) continue;
    if (estimateTokens(text) > MAX_NEARBY_CONTEXT_TOKENS) {
      if (isLocalBlock) throw contextTooLarge();
      break;
    }

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
