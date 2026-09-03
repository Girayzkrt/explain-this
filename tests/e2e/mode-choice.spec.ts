import type { Page } from "@playwright/test";
import { RECOMMENDED_CLOUD_MODEL } from "../../src/shared/constants";
import { expect, test } from "./e2e-fixture";

/**
 * Every phrase this branch has had to strip because it claimed the reading stayed on
 * the machine, across five separate waves of fixes (see the commits touching
 * error-copy.ts, provider-copy.ts, and OptionsApp.tsx). A single count-zero assertion
 * on one screen, which is what this file used to have, only ever catches one phrase on
 * one screen — this is the net all of them, run across every screen a cloud-mode
 * reader actually reaches.
 */
const FALSE_LOCAL_CLAIMS: readonly RegExp[] = [
  /does not leave your machine/i,
  /never leaves your (?:computer|machine)/i,
  /stays on this computer/i,
  /explaining locally/i,
  /connecting to local model/i,
  /\blocal model\b/i,
  // Was singular-only (`\blocal explanation\b`) — `\b` does not match between `n` and
  // `s`, so it missed the plural form entirely, including the rail headline "Local
  // explanations, set up clearly." that the stale-screenshot finding was about.
  /\blocal explanations?\b/i,
  /\blocal reader\b/i,
  // Removed welcome copy that was previously guarded only by a unit assertion, not
  // this e2e net.
  /understand text locally/i,
  /local response could not be read/i,
  /preparing local download/i,
];

/**
 * Excludes the ".mode-option" cards: Settings shows both mode choices side by side so
 * the reader can switch either way, and the local card's own honest description of
 * *itself* ("does not leave your machine") is expected to sit right there even while
 * cloud mode is the one currently active. That is a description of the other choice,
 * not a claim about the session in progress — the same distinction ModeOptions's own
 * doc comment draws. Everywhere else on the page is fair game.
 */
async function assertNoFalseLocalClaims(page: Page, screen: string): Promise<void> {
  // innerText only excludes ".mode-option" correctly if those elements are actually
  // hidden (a detached clone loses layout and innerText goes empty in Chromium), so
  // hide them, read, then restore — all inside one synchronous evaluate. Read
  // `textContent` alongside `innerText` (innerText follows rendering/visibility rules
  // and can miss screen-reader-only text that is still in the DOM), and collect every
  // `aria-label` attribute explicitly — neither innerText nor textContent exposes an
  // attribute's value, so an accessible name like `aria-label="Local setup sequence"`
  // is otherwise invisible to this scan entirely. `textContent` ignores CSS entirely
  // (unlike innerText), so the display:none trick above does not exclude ".mode-option"
  // from it — exclude those nodes for textContent by removing them from a detached
  // clone instead, which loses layout (fine, textContent doesn't need it) without
  // touching the live, still-rendered page the innerText read depends on.
  const { innerText, textContent, ariaLabels } = await page.evaluate(() => {
    const cards = [...document.querySelectorAll<HTMLElement>(".mode-option")];
    const previous = cards.map((card) => card.style.display);
    for (const card of cards) card.style.display = "none";
    const innerText = document.body.innerText;
    cards.forEach((card, index) => {
      card.style.display = previous[index] ?? "";
    });

    const clone = document.body.cloneNode(true) as HTMLElement;
    clone.querySelectorAll(".mode-option").forEach((card) => card.remove());
    const textContent = clone.textContent ?? "";

    const ariaLabels = [...document.querySelectorAll<HTMLElement>("[aria-label]")]
      .filter((element) => !element.closest(".mode-option"))
      .map((element) => element.getAttribute("aria-label") ?? "")
      .join("\n");

    return { innerText, textContent, ariaLabels };
  });
  const text = `${innerText}\n${textContent}\n${ariaLabels}`;
  for (const phrase of FALSE_LOCAL_CLAIMS) {
    expect(phrase.test(text), `${screen} must not show ${phrase}`).toBe(false);
  }
}

test.beforeEach(async ({ e2e }) => {
  await e2e.reset();
});

test("reaches cloud model choice through the mode screen", async ({ e2e }) => {
  const options = await e2e.extension.openOptions();
  await options.bringToFront();

  await options.getByRole("button", { name: "Start setup" }).click();
  await expect(
    options.getByRole("heading", { name: "Choose how it runs" }),
  ).toBeVisible();

  await options.getByRole("button", { name: "Use Ollama Cloud" }).click();
  await expect(
    options.getByRole("heading", { name: "Choose a cloud model" }),
  ).toBeVisible();
  await expect(
    options.getByRole("option", { name: new RegExp(RECOMMENDED_CLOUD_MODEL) }),
  ).toBeEnabled();
});

test("keeps a cloud model unselectable in local mode", async ({ e2e }) => {
  const options = await e2e.extension.openOptions();
  await options.bringToFront();

  await options.getByRole("button", { name: "Start setup" }).click();
  await options.getByRole("button", { name: "Use this computer" }).click();
  await expect(
    options.getByRole("heading", { name: "Choose a local model" }),
  ).toBeVisible();

  await expect(
    options.getByRole("option", { name: new RegExp(RECOMMENDED_CLOUD_MODEL) }),
  ).toBeDisabled();
});

test("never claims the text stays on the machine anywhere a cloud-mode reader lands", async ({
  e2e,
}) => {
  const options = await e2e.extension.openOptions();
  await options.bringToFront();

  await options.getByRole("button", { name: "Start setup" }).click();
  await options.getByRole("button", { name: "Use Ollama Cloud" }).click();
  await expect(
    options.getByRole("heading", { name: "Choose a cloud model" }),
  ).toBeVisible();
  await assertNoFalseLocalClaims(options, "cloud model choice");

  await options.getByRole("button", { name: `Use ${RECOMMENDED_CLOUD_MODEL}` }).click();
  await expect(
    options.getByRole("heading", { name: "Choose how explanations read" }),
  ).toBeVisible();
  await assertNoFalseLocalClaims(options, "preferences");

  await options.getByRole("button", { name: "Confirm and continue" }).click();
  await expect(
    options.getByRole("heading", { name: "Testing your cloud model" }),
  ).toBeVisible();
  await assertNoFalseLocalClaims(options, "readiness");

  await e2e.ollama.waitForRequest((request) => request.path === "/api/chat");
  e2e.ollama.releaseChat();
  await expect(options.getByRole("heading", { name: "Ready" })).toBeVisible();
  await assertNoFalseLocalClaims(options, "ready");

  await options.getByRole("button", { name: "Finish setup" }).click();
  await expect(
    options.getByRole("heading", { name: "Explanation settings" }),
  ).toBeVisible();
  await assertNoFalseLocalClaims(options, "settings");
});
