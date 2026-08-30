import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureSelection } from "./selection";
import { isVisibleReadingNode } from "./visibility";

const FIXTURE = readFileSync("tests/fixtures/selection-page.html", "utf8");

const defaultRect = new DOMRect(10, 20, 30, 12);

function element(id: string): HTMLElement {
  const value = document.getElementById(id);
  if (!(value instanceof HTMLElement))
    throw new Error(`Missing fixture element: ${id}`);
  return value;
}

function selectContents(target: Node): Range {
  const range = document.createRange();
  range.selectNodeContents(target);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  return range;
}

function externalRange(node: Node, text: string, rect = defaultRect): Range {
  const contents = document.createDocumentFragment();
  contents.append(document.createTextNode(text));
  const range = {
    collapsed: false,
    commonAncestorContainer: node,
    startContainer: node,
    endContainer: node,
    toString: () => text,
    getClientRects: () => [rect] as unknown as DOMRectList,
    getBoundingClientRect: () => rect,
    cloneContents: () => contents.cloneNode(true),
  } as unknown as Range;

  Object.assign(range, { cloneRange: () => range });
  return range;
}

function externalSelection(...ranges: Range[]): Selection {
  return {
    isCollapsed: ranges[0]?.collapsed ?? true,
    rangeCount: ranges.length,
    getRangeAt: (index: number) => ranges[index],
  } as unknown as Selection;
}

beforeEach(() => {
  document.body.innerHTML = FIXTURE;
  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    value: () => [defaultRect] as unknown as DOMRectList,
  });
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => defaultRect,
  });
});

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  vi.restoreAllMocks();
});

describe("captureSelection", () => {
  it("returns no snapshot for a collapsed selection", () => {
    const range = document.createRange();
    range.setStart(element("nested-selection"), 0);
    range.collapse(true);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);

    expect(captureSelection()).toBeUndefined();
  });

  it("returns no snapshot for whitespace-only selected text", () => {
    selectContents(element("whitespace-selection"));

    expect(captureSelection()).toBeUndefined();
  });

  it("normalizes Unicode and collapses whitespace across nested inline markup", () => {
    const original = selectContents(element("nested-selection"));

    const snapshot = captureSelection();

    expect(snapshot?.text).toBe("Café uses nested markup.");
    expect(snapshot?.range).not.toBe(original);
    expect(snapshot?.anchorElement).toBe(element("nested-selection"));
  });

  it("uses only the first range from a multi-range selection", () => {
    const first = externalRange(element("nested-selection"), "first range");
    const second = externalRange(element("hidden-node"), "private second range");

    expect(captureSelection(externalSelection(first, second))?.text).toBe(
      "first range",
    );
  });

  it("does not alter selected punctuation or markup-like text", () => {
    const range = externalRange(
      element("nested-selection"),
      "  Keep <tag> & cafe\u0301.\tSecond   line!  ",
    );

    expect(captureSelection(externalSelection(range))?.text).toBe(
      "Keep <tag> & café. Second line!",
    );
  });

  it.each([
    ["text input", "text-input"],
    ["password input", "password-input"],
    ["textarea", "textarea"],
    ["contenteditable", "editable"],
    ["script", "script-node"],
    ["style", "style-node"],
    ["noscript", "noscript-node"],
    ["hidden ancestry", "hidden-node"],
    ["inert ancestry", "inert-node"],
    ["aria-hidden ancestry", "aria-hidden-node"],
    ["display-none ancestry", "display-none-node"],
    ["visibility-hidden ancestry", "visibility-hidden-node"],
    ["visibility-collapse ancestry", "visibility-collapse-node"],
    ["zero-opacity ancestry", "opacity-zero-node"],
  ])("rejects a selection inside %s", (_label, id) => {
    const target = element(id);
    const range = externalRange(target, "private selected text");

    expect(isVisibleReadingNode(target)).toBe(false);
    expect(captureSelection(externalSelection(range))).toBeUndefined();
  });

  it("rejects a visible range that contains an excluded descendant", () => {
    selectContents(element("current-block"));

    expect(captureSelection()).toBeUndefined();
  });

  it("uses the final non-empty range client rectangle", () => {
    selectContents(element("nested-selection"));
    const earlier = new DOMRect(1, 2, 10, 4);
    const final = new DOMRect(30, 40, 20, 8);
    const empty = new DOMRect(99, 99, 0, 0);
    vi.spyOn(Range.prototype, "getClientRects").mockReturnValue([
      earlier,
      final,
      empty,
    ] as unknown as DOMRectList);

    expect(captureSelection()?.rect).toBe(final);
  });

  it("falls back to the range bounding rectangle when no client rect is non-empty", () => {
    selectContents(element("nested-selection"));
    const fallback = new DOMRect(12, 24, 36, 10);
    vi.spyOn(Range.prototype, "getClientRects").mockReturnValue(
      [] as unknown as DOMRectList,
    );
    vi.spyOn(Range.prototype, "getBoundingClientRect").mockReturnValue(fallback);

    expect(captureSelection()?.rect).toBe(fallback);
  });
});
