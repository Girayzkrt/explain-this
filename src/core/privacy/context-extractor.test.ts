import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SelectionSnapshot } from "./selection";
import { extractNearbyContext } from "./context-extractor";

const FIXTURE = readFileSync("tests/fixtures/selection-page.html", "utf8");

function element(id: string): HTMLElement {
  const value = document.getElementById(id);
  if (!(value instanceof HTMLElement))
    throw new Error(`Missing fixture element: ${id}`);
  return value;
}

function snapshot(anchorElement: Element, text: string): SelectionSnapshot {
  const range = document.createRange();
  range.selectNodeContents(anchorElement);
  return {
    text,
    range,
    rect: new DOMRect(10, 10, 20, 10),
    anchorElement,
  };
}

beforeEach(() => {
  document.body.innerHTML = FIXTURE;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("extractNearbyContext", () => {
  it("returns empty context without inspecting the page when opt-in is false", () => {
    const result = extractNearbyContext(
      snapshot(element("selected-text"), "selected phrase"),
      false,
    );

    expect(result).toEqual({ text: "", estimatedTokens: 0, sourceBlockCount: 0 });
  });

  it("uses the local block then at most one nearest visible block on each side", () => {
    const result = extractNearbyContext(
      snapshot(element("selected-text"), "selected phrase"),
      true,
    );

    expect(result.text).toBe(
      [
        "Current lead current tail.",
        "Nearest previous reading block.",
        "Nearest next reading block.",
      ].join("\n\n"),
    );
    expect(result.sourceBlockCount).toBe(3);
    expect(result.text).not.toContain("selected phrase");
    expect(result.text).not.toContain("Unrelated distant");
  });

  it("excludes hidden, script, style, navigation, menu, and form content", () => {
    document.body.innerHTML = `
      <section id="local-section">
        Visible section text.
        <span hidden>hidden secret</span>
        <script>script secret</script>
        <style>.x { content: "style secret"; }</style>
        <nav>navigation secret</nav>
        <menu><li>menu secret</li></menu>
        <form><textarea>form secret</textarea><input value="input secret"></form>
        <span id="section-selection">selected words</span>
      </section>
    `;

    const result = extractNearbyContext(
      snapshot(element("section-selection"), "selected words"),
      true,
    );

    expect(result.text).toBe("Visible section text.");
    expect(result.sourceBlockCount).toBe(1);
    expect(result.text).not.toMatch(/secret|selected words/u);
  });

  it("excludes case-insensitive menu and navigation role tokens", () => {
    document.body.innerHTML = `
      <section>
        Visible section text.
        <div role="banner   NAVIGATION tablist">navigation role secret</div>
        <div role="status MeNu presentation">menu role secret</div>
        <span id="role-selection">selected words</span>
      </section>
    `;

    const result = extractNearbyContext(
      snapshot(element("role-selection"), "selected words"),
      true,
    );

    expect(result).toEqual({
      text: "Visible section text.",
      estimatedTokens: 7,
      sourceBlockCount: 1,
    });
  });

  it("skips hidden adjacent blocks and takes the nearest visible reading sibling", () => {
    document.body.innerHTML = `
      <article>
        <p id="visible-previous">visible previous</p>
        <p hidden>hidden previous</p>
        <p id="local"><span id="local-selection">selected</span> local text</p>
        <p style="opacity: 0">hidden next</p>
        <p id="visible-next">visible next</p>
      </article>
    `;

    const result = extractNearbyContext(
      snapshot(element("local-selection"), "selected"),
      true,
    );

    expect(result.text).toBe("local text\n\nvisible previous\n\nvisible next");
    expect(result.sourceBlockCount).toBe(3);
  });

  it("does not traverse the document body when no local semantic block exists", () => {
    document.body.innerHTML = `
      <div><span id="orphan-selection">selected</span></div>
      <p>unrelated body-wide reading content</p>
    `;

    expect(
      extractNearbyContext(snapshot(element("orphan-selection"), "selected"), true),
    ).toEqual({ text: "", estimatedTokens: 0, sourceBlockCount: 0 });
  });

  it("does not search across document-body siblings for reading context", () => {
    document.body.innerHTML = `
      <p>unrelated body-wide previous content</p>
      <div aria-hidden="true">separator</div>
      <p id="body-local"><span id="body-selection">selected</span> local text</p>
      <div aria-hidden="true">separator</div>
      <p>unrelated body-wide next content</p>
    `;

    expect(
      extractNearbyContext(snapshot(element("body-selection"), "selected"), true),
    ).toEqual({ text: "local text", estimatedTokens: 4, sourceBlockCount: 1 });
  });

  it("stops before combined context would exceed 400 estimated tokens", () => {
    document.body.innerHTML = `
      <article>
        <p>${"漢".repeat(399)}</p>
        <p id="budget-local"><span id="budget-selection">selected</span> 漢</p>
        <p>farther text must not be considered after the nearer candidate does not fit</p>
      </article>
    `;

    const result = extractNearbyContext(
      snapshot(element("budget-selection"), "selected"),
      true,
    );

    expect(result).toEqual({ text: "漢", estimatedTokens: 1, sourceBlockCount: 1 });
  });

  it("stops at an oversized previous sibling without failing or reading the next one", () => {
    document.body.innerHTML = `
      <article>
        <p>${"漢".repeat(401)}</p>
        <p><span id="previous-order-selection">selected</span> local text</p>
        <p>next text must not be accumulated after the previous block stops traversal</p>
      </article>
    `;

    expect(
      extractNearbyContext(
        snapshot(element("previous-order-selection"), "selected"),
        true,
      ),
    ).toEqual({ text: "local text", estimatedTokens: 4, sourceBlockCount: 1 });
  });

  it("returns accepted local and previous context when the next sibling is oversized", () => {
    document.body.innerHTML = `
      <article>
        <p>accepted previous text</p>
        <p><span id="next-order-selection">selected</span> local text</p>
        <p>${"漢".repeat(401)}</p>
      </article>
    `;

    expect(
      extractNearbyContext(snapshot(element("next-order-selection"), "selected"), true),
    ).toEqual({
      text: "local text\n\naccepted previous text",
      estimatedTokens: 11,
      sourceBlockCount: 2,
    });
  });

  it("accepts one indivisible local block at the exact 400-token boundary", () => {
    document.body.innerHTML = `<p id="exact"><span id="exact-selection">selected</span>${"漢".repeat(400)}</p>`;

    const result = extractNearbyContext(
      snapshot(element("exact-selection"), "selected"),
      true,
    );

    expect(result.estimatedTokens).toBe(400);
    expect(result.sourceBlockCount).toBe(1);
  });

  it("returns CONTEXT_TOO_LARGE only when one indivisible local block exceeds 400 tokens", () => {
    document.body.innerHTML = `<p id="oversized"><span id="oversized-selection">selected</span>${"漢".repeat(401)}</p>`;

    expect(() =>
      extractNearbyContext(snapshot(element("oversized-selection"), "selected"), true),
    ).toThrowError(expect.objectContaining({ code: "CONTEXT_TOO_LARGE" }));
  });

  it("cuts off an oversized local text node before normalizing it or reading trailing nodes", () => {
    const local = document.createElement("p");
    const selection = document.createElement("span");
    selection.id = "early-cutoff-selection";
    selection.textContent = "selected";
    const hostileText = "x".repeat(100_000);
    const trailing = document.createTextNode("trailing text");
    local.append(selection, document.createTextNode(hostileText), trailing);
    document.body.replaceChildren(local);

    let trailingReads = 0;
    Object.defineProperty(trailing, "nodeValue", {
      configurable: true,
      get: () => {
        trailingReads += 1;
        return "trailing text";
      },
    });
    const normalizedLengths: number[] = [];
    const originalNormalize = String.prototype.normalize;
    vi.spyOn(String.prototype, "normalize").mockImplementation(function (
      this: string,
      form,
    ) {
      normalizedLengths.push(this.length);
      return originalNormalize.call(this, form);
    });

    expect(() =>
      extractNearbyContext(
        snapshot(element("early-cutoff-selection"), "selected"),
        true,
      ),
    ).toThrowError(expect.objectContaining({ code: "CONTEXT_TOO_LARGE" }));
    expect(trailingReads).toBe(0);
    expect(Math.max(...normalizedLengths)).toBeLessThan(hostileText.length);
  });
});
