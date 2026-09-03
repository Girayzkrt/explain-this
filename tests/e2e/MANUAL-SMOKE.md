# Manual browser UI smoke checks

These checks cover Chrome-owned UI and browser policies that are not reliably exposed to Playwright. They are manual smoke checks, not automated E2E tests. Run them against the packaged extension built for the E2E fixture environment, with the local fake Ollama service and fixture page available.

## Run record

- Date/time: ______________________________
- Tester: __________________________________
- Chrome / Chromium version: _______________
- OS and version: __________________________
- Extension build / commit: ________________
- Result: [ ] Pass [ ] Pass with notes [ ] Fail

## Prerequisites

- [ ] Build and load the E2E extension in a fresh Chrome profile; confirm the expected extension ID.
- [ ] Start the loopback fake Ollama server and fixture-page server used by the E2E tests.
- [ ] Confirm the fixture page has selectable nested text and that the extension is enabled.
- [ ] Have a second tab and an incognito window available for the relevant checks.
- [ ] Keep DevTools or the fake-server request log available for privacy checks; do not copy real sensitive page content into the test.

## Native context-menu hierarchy

- [ ] On a normal fixture page, select text and open Chrome’s native context menu.
- [ ] Confirm the extension’s top-level menu item is present and named correctly.
- [ ] Confirm the item has the expected child actions in the documented order (primary reader actions and follow-up actions as applicable).
- [ ] Confirm the menu is absent or disabled when no text is selected.
- [ ] Activate one child action and confirm the reader receives the selected text once, with no duplicate toolbar/card.
- [ ] Confirm unrelated Chrome context-menu entries remain usable.

## Real keyboard command registration and activation

- [ ] Open `chrome://extensions/`, open the extension’s keyboard-shortcut settings, and confirm the intended command is registered with the expected default or configured shortcut.
- [ ] If Chrome reports a conflict, assign a non-conflicting shortcut and record it here: ____________________.
- [ ] On the fixture page, select text and press the real shortcut (not a Playwright-dispatched synthetic command).
- [ ] Confirm the reader opens for the current selection and the command does not trigger on an empty selection.
- [ ] Confirm pressing the shortcut again does not create an unintended duplicate request or duplicate UI.

## Optional permission dialog text and flow

- [ ] From the extension UI, start the optional page-access permission flow.
- [ ] Verify Chrome’s native permission dialog names only the intended optional access and gives a clear allow/deny choice.
- [ ] Confirm the dialog does not request broad unrelated origins or unnecessary permissions.
- [ ] Choose **Deny** and confirm the extension remains usable for features that do not require page access; the UI explains the limitation without exposing page text.
- [ ] Repeat and choose **Allow**; confirm the requested feature works and no additional prompt appears for the same scope.
- [ ] If Chrome suppresses the dialog because permission state is already settled, record the state and verify it in `chrome://extensions/`.

## Side-panel opening gesture

- [ ] Use Chrome’s real side-panel opening gesture (toolbar side-panel button or the extension’s documented action), rather than directly navigating to an extension URL.
- [ ] Confirm the Explain This side panel opens in the current tab and has the expected title and controls.
- [ ] Confirm the panel does not open a normal tab, steal focus from the page unexpectedly, or duplicate an existing panel.
- [ ] With no active request, confirm the panel shows the expected empty or ready state.
- [ ] Start a reader request and confirm the panel reflects the request state and streamed result safely.

## Chrome Web Store and protected pages

- [ ] Navigate to a Chrome Web Store page. Confirm the extension does not inject a toolbar, attempt to read selection, or display a misleading error.
- [ ] Visit a protected browser page such as `chrome://settings/` (and another relevant `chrome://` page if available). Confirm the extension reports restricted-page behavior gracefully and does not claim the page was read.
- [ ] Confirm no permission prompt appears merely from visiting a Web Store or protected page.
- [ ] Return to the fixture page and confirm ordinary page access still works after these restricted-page attempts.

## Incognito disabled behavior

- [ ] In `chrome://extensions/`, ensure **Allow in incognito** is disabled for the extension.
- [ ] Open an incognito window and visit the fixture page (or an allowed local test page).
- [ ] Confirm the extension’s toolbar action, context-menu item, keyboard command, and side-panel entry are unavailable or clearly disabled in incognito.
- [ ] Confirm no request is sent to the fake Ollama server and no page text is stored or surfaced from the incognito page.
- [ ] Return to a regular window and confirm the extension remains enabled and functional there.

## Privacy and security spot-checks

- [ ] In the fake-server log, verify a normal request contains only the selected text and explicitly permitted nearby context; no full DOM, hidden text, form values, scripts, styles, navigation, or distant prompt-injection text is present.
- [ ] Confirm model output is displayed as text: it cannot create executable scripts, links, or unexpected DOM elements.
- [ ] Confirm Chrome’s extension permission page shows only the intended permissions and the E2E fixture host (never in a production build).
- [ ] Confirm diagnostics and local storage contain settings/status only, not source text or model output.
- [ ] Clear the temporary profile after the run and record any unexpected browser permission or privacy behavior in the notes below.

## Mode selection and Ollama Cloud sign-in

Playwright covers the mode screen, cloud model choice, and disclosure copy against the
fake Ollama server (`tests/e2e/mode-choice.spec.ts`), but nothing in this repository
exercises a real Ollama Cloud account. These checks need one.

- [ ] On the mode screen ("Choose how it runs"), confirm **On this computer** and
      **Ollama Cloud** are given visually equal weight — same size, same styling,
      neither presented as the "better" or highlighted choice.
- [ ] Choose **Ollama Cloud** against a real Ollama installation with no signed-in
      cloud session. Confirm the sign-in guidance screen appears with the exact
      commands (`ollama signin`, `ollama pull <model>`).
- [ ] Run those commands for real, in a real terminal, against real Ollama. Click
      **Check again** and confirm it proceeds to cloud model choice once signed in —
      not before.
- [ ] Confirm a real signed-in cloud model appears in the model list, selectable, and
      that a real local model appears disabled with a "runs on this computer" reason.
- [ ] Send a real explanation request in Ollama Cloud mode. Confirm the reader card
      shows the cloud-mode copy ("Cloud reader" kicker in the side panel, "Explaining
      via Ollama’s cloud…" status, `aria-label="Cloud explanation"`) and never any
      local-mode copy.
- [ ] Switch mode in Settings from **On this computer** to **Ollama Cloud** and back.
      At each point, confirm the mode table and privacy-promise language on the
      options page (and, separately, the README and `docs/privacy.md` shipped with
      this build) describe the mode that is actually active — not the other one, and
      not both.
- [ ] Stop the local Ollama daemon while Ollama Cloud mode is selected. Confirm the
      error is "Model unavailable" (`OLLAMA_UNREACHABLE`), not a cloud-specific
      message — cloud mode still depends on the local daemon as its gateway.
- [ ] Let a real Ollama Cloud session expire or sign out mid-session, then send a
      request. Confirm it surfaces "Sign in to Ollama Cloud"
      (`OLLAMA_SIGNIN_REQUIRED`) rather than a generic retry-forever failure.

## Open questions needing a signed-in Ollama Cloud installation

These are the design's own "to verify during implementation" items
(`docs/superpowers/specs/2026-09-02-hybrid-provider-design.md`). None of them can be
answered against the fake Ollama server; record the actual observation here once a
signed-in installation is available.

- [ ] Whether a cloud model appears in a real `/api/tags` response at all, and whether
      its `size` field is `0`, absent, or something else. Record the raw JSON.
- [ ] Ollama's actual unauthenticated response shape for a cloud request (status code,
      body) once a cloud session has genuinely expired, so `OLLAMA_SIGNIN_REQUIRED`'s
      mapping in `src/providers/ollama/errors.ts` can be narrowed from its current
      defensive form if the observed shape differs from 401.
- [ ] Cloud first-token latency on a real signed-in installation, to replace the
      provisional 20 000 ms budget in `firstTokenBudgetMs`
      (`src/shared/constants.ts`) with a measured figure.

## Notes / deviations

---

---

---
