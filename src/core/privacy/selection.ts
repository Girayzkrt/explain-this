import { isVisibleReadingNode } from "./visibility";

export interface SelectionSnapshot {
  text: string;
  range: Range;
  rect: DOMRectReadOnly;
  anchorElement: Element;
}

function normalizeSelectedText(value: string): string {
  return value.normalize("NFC").replace(/\s+/gu, " ").trim();
}

function elementForNode(node: Node): Element | null {
  if (node instanceof Element) return node;
  return node.parentElement;
}

function finalNonEmptyClientRect(range: Range): DOMRectReadOnly {
  const rects = Array.from(range.getClientRects());
  for (let index = rects.length - 1; index >= 0; index -= 1) {
    const rect = rects[index];
    if (rect !== undefined && rect.width > 0 && rect.height > 0) return rect;
  }
  return range.getBoundingClientRect();
}

function containsExcludedContent(range: Range): boolean {
  const contents = range.cloneContents();
  const walker = contents.ownerDocument.createTreeWalker(
    contents,
    NodeFilter.SHOW_ELEMENT,
  );
  let node = walker.nextNode();

  while (node !== null) {
    if (!isVisibleReadingNode(node)) return true;
    node = walker.nextNode();
  }

  return false;
}

export function captureSelection(
  selection: Selection | null = window.getSelection(),
): SelectionSnapshot | undefined {
  if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) {
    return undefined;
  }

  // Multi-range selections are deliberately reduced to their first range in the MVP.
  const range = selection.getRangeAt(0).cloneRange();
  if (range.collapsed) return undefined;

  if (
    !isVisibleReadingNode(range.startContainer) ||
    !isVisibleReadingNode(range.endContainer) ||
    !isVisibleReadingNode(range.commonAncestorContainer) ||
    containsExcludedContent(range)
  ) {
    return undefined;
  }

  const text = normalizeSelectedText(range.toString());
  if (text.length === 0) return undefined;

  const anchorElement = elementForNode(range.commonAncestorContainer);
  if (anchorElement === null) return undefined;

  return {
    text,
    range,
    rect: finalNonEmptyClientRect(range),
    anchorElement,
  };
}
