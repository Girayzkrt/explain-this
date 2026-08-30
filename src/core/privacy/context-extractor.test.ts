import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
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
});
