# Task 16 checkpoint A/B report: deterministic local E2E servers and harness

## Outcome

Recovered and audited the interrupted Task 16 checkpoint-A support layer only. The
fake Ollama server and fixture-page server bind to dynamically allocated IPv4
loopback ports, expose deterministic local HTTP contracts, and tear down their own
listeners and sockets idempotently. No Playwright harness or browser E2E specs were
started in this checkpoint.

## RED/GREEN evidence

The inherited uncommitted baseline had the two support servers, their tests, and the
three fixture pages. The controller-reported baseline was 16 focused tests passing.
The first recovery run reproduced that result. A teardown regression was then added
test-first and observed failing: pending request/cancellation control waiters timed
out after `close()` instead of settling. The minimal fix rejects and clears pending
waiters, and post-close waiter calls now reject immediately.

Final focused verification:

```text
npx vitest run tests/support/fake-ollama-server.test.ts tests/support/fixture-page-server.test.ts
Test Files  2 passed (2)
Tests       18 passed (18)
```

Additional focused checks assert reset clears request records and restores default
scenarios, fixture responses use the exact HTML content type, and fixture content
contains the required privacy, hostile-CSS geometry, and multilingual cases without
external resource references.

## APIs and files

`startFakeOllamaServer()` returns:

- `hostname`, `port`, and `baseUrl` for the ephemeral `127.0.0.1` endpoint;
- read-only request and cancellation records;
- `setScenario`, `reset`, and `releaseChat` controls;
- `waitForRequest`, `waitForCancellation`, and idempotent `close`.

Supported Ollama scenarios cover empty/model tags, pull progress, normal chat,
slow-first-token, idle stream, malformed partial stream, missing model, HTTP failure,
origin rejection, and client cancellation detection. Error responses use fixed text
and do not echo request bodies.

`startFixturePageServer()` serves only `normal.html`, `hostile.html`, and
`multilingual.html` from a dynamic loopback origin. Encoded traversal, unknown
paths, and non-GET requests are not allowlisted; fixture responses are UTF-8 HTML.

Checkpoint files:

- `tests/support/fake-ollama-server.ts`
- `tests/support/fake-ollama-server.test.ts`
- `tests/support/fixture-page-server.ts`
- `tests/support/fixture-page-server.test.ts`
- `tests/fixtures/pages/normal.html`
- `tests/fixtures/pages/hostile.html`
- `tests/fixtures/pages/multilingual.html`

## Checkpoint B: secure packaged-extension harness

Checkpoint B adds no browser-flow specifications. It provides the common harness
that later E2E specifications consume:

- `wxt build --mode e2e` accepts only two distinct exact
  `http://127.0.0.1:<port>` origins supplied through
  `VITE_EXPLAIN_THIS_OLLAMA_BASE_URL` and
  `VITE_EXPLAIN_THIS_FIXTURE_ORIGIN`; malformed or missing variables fail the
  build. The e2e manifest adds only those two required origins. Production mode
  ignores those variables and keeps its original fixed loopback permission split.
- The fake Ollama endpoint is injected with a Vite `define` constant only for the
  e2e package. Production builds compile that constant to `undefined`; the
  runtime URL guard has no environment-variable fallback.
- `tests/support/extension-fixture.ts` builds packages in a child process,
  validates the generated manifest and compiled endpoint constant, launches a
  headed persistent Chromium profile, resolves the extension service worker/ID,
  and opens options, side-panel, or fixture pages. Its storage helper evaluates
  only in the trusted extension worker. Its reader helper uses Chrome's registered
  keyboard command, so the production background handler injects and invokes the
  packaged reader; it does not inject raw page code, prompt text, or endpoint
  values.
- Fixture teardown first closes the browser context and then removes only the
  canonical direct child created under the OS temp directory with the
  `explain-this-` prefix. It rejects temp-root, nested, symlink-resolved, and
  unrelated paths.
- `playwright.config.ts` runs one headed worker with event-driven waits and
  local Windows/macOS settings. No Xvfb command or browser flow is added here.

Focused harness coverage checks endpoint validation, production/e2e build
invocations, exact manifest splits, and profile cleanup without launching Chromium.

## Verification and residuals

```text
npx eslint <checkpoint TypeScript files>
exit 0

npx prettier --check <checkpoint files>
All matched files use Prettier code style!

git diff --check
exit 0 (after staging)
```

Repository `npm run typecheck` remains blocked by an unrelated untracked
`tests/support/extension-fixture.test.ts`, which imports the missing
`tests/support/extension-fixture.ts`. The untracked extension-fixture test and the
unrelated modified `src/providers/ollama/url.test.ts` were left untouched and are not
part of this server-only checkpoint. Browser-owned Playwright flows remain a later
Task 16 checkpoint.

## Checkpoint C recovery evidence (2026-09-01)

The first Chromium run reproduced two failures: missing-runtime expected empty
storage although production bootstrap repairs missing settings to a version-0
default object, and the no-model flow asserted an exact duplicate `/api/tags`
count while the real browser flow had not yet reached the model step. The exact
default settings shape is now asserted, including the runtime UI language (`en-US`)
and absence of page-source/output strings. The no-model assertion waits on the
actual `Choose a local model` heading.

The endpoint root cause was traced through the generated service-worker artifact:
before the shared constant override, the background provider was fixed to
`127.0.0.1:11434`; the e2e build now compiles only the literal fake loopback origin,
while production retains the fixed loopback endpoint. The harness validates both
manifest permission splits and the compiled endpoint artifact. E2e options are
rewritten only in the generated test package to open as a real extension tab,
avoiding `chrome://extensions` management-page contamination.

The fixture now waits for storage bootstrap, owns extension-created pages, preserves
one inert `about:blank` anchor, closes only pages it owns, and clears trusted local
and session storage after startup initialization. Generated Playwright artifacts
are ignored by `test-results/`, `playwright-report/`, and `blob-report/`.

Current browser gap: the no-model Chromium flow still stalls before the model-choice
heading on this host even though the missing-runtime flow reaches its expected
heading and exact storage shape. Instrumentation showed the worker starts its
provider fetch, but the fake server does not observe the no-model request before
the test timeout. This remains an automated gap requiring further browser/network
diagnosis; no core data/UI assertion was skipped.

## Focused onboarding recovery (2026-09-01)

Root cause: `OllamaProvider` stored the global browser `fetch` unbound and invoked
it as `this.fetchImpl(...)`. Chromium therefore raised an illegal-invocation
`TypeError` in the service worker before the fake Ollama server saw `GET /api/tags`;
the provider mapped it to `OLLAMA_UNREACHABLE`. The existing regression test failed
with that exact mapped error. Binding the selected implementation to `globalThis`
restores the browser receiver while preserving injected test fetches.

Evidence and commands:

```text
npx vitest run src/providers/ollama/ollama-provider.test.ts -t "calls the default browser fetch with the global receiver" --reporter=dot
1 passed (18 skipped)

npx playwright test tests/e2e/onboarding.spec.ts -g "downloads the recommended model" --workers=1 --reporter=line
1 passed (7.8s)
```

The passing browser flow observed the fake server tags/pull requests and no service
worker network error. Production `options_ui.open_in_tab` remains false and the
production endpoint remains `http://127.0.0.1:11434`; the dynamic endpoint is still
e2e compile-time-only.

## Reader-flow checkpoint C follow-up (2026-09-01)

### Scope and preserved work

The inherited uncommitted onboarding, fake-server, harness, provider, constants,
and fixture changes were preserved. Reader-flow work did not modify privacy or
errors specifications. No commit was created.

### RED/GREEN production regression

The first reader run failed before any Ollama request: the real fixture DOM was
present, but the toolbar never mounted after the packaged keyboard invocation. The
generated e2e service worker showed `readerBrowserApi.executeReader` detaching
`browser.scripting.executeScript` and invoking it without its `browser.scripting`
receiver, the browser-only equivalent of the already observed unbound `fetch`
defect.

A focused regression was added first in
`src/platform/permissions/browser-api.test.ts`. It uses a receiver-sensitive
`executeScript` implementation and initially failed with:

```text
promise rejected "TypeError: Incorrect scripting receiver."
```

The minimal fix binds `browser.scripting.executeScript` to
`browser.scripting`. The regression then passed:

```text
npx vitest run src/platform/permissions/browser-api.test.ts --reporter=dot
Test Files  1 passed (1)
Tests       1 passed (1)
```

The focused permission suite also passes:

```text
npx vitest run src/platform/permissions/browser-api.test.ts src/platform/permissions/reader-access.test.ts --reporter=dot
Test Files  2 passed (2)
Tests       27 passed (27)
```

### Five reader tests, serial evidence

Before the receiver fix, the first test failed at the toolbar assertion. The same
failure was reproduced in the other four tests. After the fix, the first test was
rerun and still failed at that same toolbar assertion; the remaining four were
rerun serially with the required worker/reporter settings and each failed at the
same pre-toolbar assertion:

```text
npx playwright test tests/e2e/reader.spec.ts -g "runs every primary action" --workers=1 --reporter=dot
1 failed: toolbar "Explain selected text" not visible; no fake-server request

npx playwright test tests/e2e/reader.spec.ts -g "stops an in-flight stream" --workers=1 --reporter=dot
1 failed: toolbar "Explain selected text" not visible

npx playwright test tests/e2e/reader.spec.ts -g "opens the side-panel flow" --workers=1 --reporter=dot
1 failed: toolbar "Explain selected text" not visible

npx playwright test tests/e2e/reader.spec.ts -g "replaces a first-tab generation" --workers=1 --reporter=dot
1 failed: toolbar "Explain selected text" not visible

npx playwright test tests/e2e/reader.spec.ts -g "keeps the surface isolated" --workers=1 --reporter=dot
1 failed: toolbar "Explain selected text" not visible
```

The fixture helper still uses the production registered shortcut
`Alt+Shift+E`; no raw page script, prompt, provider mock, sleep, or weakened
assertion was introduced. A temporary e2e-only `Ctrl+Shift+E` manifest experiment
and explicit body focus were both reverted because they produced the identical
failure. This isolates the remaining gap to the browser-owned
`commands.onCommand` accelerator not being delivered by Playwright keyboard input
on this headed Windows host; the fake Ollama server observes no reader request.
The browser-owned command/shortcut surface needs a real native-browser smoke path
or a supported browser-level trigger before these five flows can execute under
Playwright. The tests remain intentionally red rather than bypassing that path.

### Additional verification

```text
npm run typecheck
exit 0

npm run build
exit 0 (production MV3 package built)

npx prettier --check src/platform/permissions/browser-api.ts src/platform/permissions/browser-api.test.ts
All matched files use Prettier code style!

git diff --check
exit 0
```

Changed files in this follow-up:

- `src/platform/permissions/browser-api.ts`
- `src/platform/permissions/browser-api.test.ts`
- `.superpowers/sdd/2026-08-29-explain-this-implementation-plan/task-16-report.md`

## Reader-flow checkpoint C command-hook ruling (2026-09-01)

The browser-owned native shortcut remains unchanged for production and is still
reserved for manual smoke coverage. To make Playwright exercise the same
production path without adding a runtime message route, an e2e-only compile-time
global service-worker hook was added. Its callback schedules the exact existing
`handlers.onCommand("explain-selection")` invocation and reports rejected
promises to `console.error`; it does not inject page code or expose a prompt,
endpoint, or provider mock. The fixture invokes only that global through the
packaged service worker, while the page script remains the production reader
injected by `ReaderAccessController`.

TDD/artifact evidence:

```text
npx vitest run tests/support/extension-fixture.test.ts -t "requires the reader hook only in e2e artifacts" --reporter=dot
RED before implementation: TypeError: assertReaderHookArtifact is not a function
GREEN after implementation: 1 passed
```

`buildExtension` now asserts the hook sentinel is present in the e2e background
artifact and absent from the production artifact. The e2e manifest receives the
minimal `tabs` permission because the existing trusted-tab URL check otherwise
cannot identify the active fixture tab when the command is invoked without a
native user gesture. Production permissions and the registered `Alt+Shift+E`
command remain unchanged.

The controller then required one focused RED experiment: the hook originally
returned/awaited the complete command-handler promise, which caused the CDP
worker evaluation to run until timeout and report `Frame with ID 0 was removed`.
The hook was changed to schedule the exact handler asynchronously and return
immediately, with rejection reporting. The focused reader test still fails at
the same pre-surface boundary:

```text
npx playwright test tests/e2e/reader.spec.ts -g "runs every primary action" --workers=1 --reporter=dot
1 failed
expect(getByRole("toolbar", { name: "Explain selected text" })).toBeVisible()
Error: element(s) not found; timeout 10000ms
tests/e2e/reader.spec.ts:48
No fake-Ollama request was observed.
```

No additional reader-flow fix was stacked after this evidence. The remaining
failure is therefore not the worker-evaluation deadlock; it is the next exact
boundary after the asynchronous hook experiment. The four other reader specs
were not rerun after this latest experiment because the focused primary test
remained red, per the checkpoint instruction.

Post-experiment verification:

```text
npm run typecheck
exit 0

npx vitest run tests/support/extension-fixture.test.ts src/platform/permissions/browser-api.test.ts src/platform/permissions/reader-access.test.ts --reporter=dot
Test Files  3 passed (3)
Tests  35 passed (35)

npm run build
exit 0 (production MV3 package built)

production artifact sentinel check: production sentinel absent
git diff --check
exit 0
```

Prettier still reports the shared fixture files as needing formatting; this was
already present before the final focused experiment and was not mechanically
rewritten to avoid disturbing inherited Task16 harness changes.

## Reader-flow checkpoint C packaged-Chromium recovery (2026-09-01)

The e2e command hook reached the real reader, which exposed two browser event-order
defects. First, pressing a toolbar button collapsed the live Range before React's
click handler ran. A new `ActionToolbar` regression failed with
`defaultPrevented: false`; preventing the button's `mousedown` default action made
the focused test pass. Second, every reader-control `mouseup` bubbled to the page's
selection listener, which could replace a newly started request with the action
toolbar. A `ReaderRoot` regression failed because the page listener ran once;
stopping `mouseup` propagation at the reader surface made it pass for every toolbar
and response-card control.

The hostile fixture also proved that `rem` was not isolated by Shadow DOM: its
37-pixel root font size expanded the nominal 26rem surface beyond the viewport.
The equivalent 416-pixel maximum now preserves the intended size independently of
page root typography. The real-browser geometry assertion failed at a right edge of
1487.9375 in a 1280-pixel viewport before this change and passed afterward.

Cross-tab replacement correctly aborted the first fake-Ollama connection and
deleted its private state, but did not notify the first content UI. The existing
coordinator test was strengthened first and failed with no `cancelled` event in the
old port. The coordinator now posts one explicit cancelled stream event before
removing the replaced identity; stale provider events remain ignored because the
old generation is no longer active. The focused unit regression and packaged
two-tab flow both pass.

The side-panel test helper previously loaded `sidepanel.html` as the active browser
tab, unlike Chrome's actual side panel, so the production controller queried the
extension page instead of the source article. The helper now restores the source
page as active before loading the panel document in the background. No production
side-panel code or browser permission changed.

Focused and aggregate evidence:

```text
npx vitest run src/components/ActionToolbar.test.tsx --reporter=dot
1/1 passed after the observed RED

npx vitest run src/entrypoints/reader.content/ReaderRoot.test.tsx -t "does not let response-control mouseup" --reporter=dot
1/1 passed after the observed RED

npx vitest run src/features/reader/request-coordinator.test.ts -t "cancels the old tab UI" --reporter=dot
1/1 passed after the observed RED

npx playwright test tests/e2e/reader.spec.ts -g "runs every primary toolbar action" --workers=1 --reporter=dot
1 passed

npx playwright test tests/e2e/reader.spec.ts -g "stops an in-flight stream|keeps the surface isolated" --workers=1 --reporter=dot
2 passed

npx playwright test tests/e2e/reader.spec.ts -g "opens the side-panel flow|replaces a first-tab generation" --workers=1 --reporter=dot
2 passed

npx playwright test tests/e2e/reader.spec.ts --workers=1 --reporter=dot
5 passed
```

`tests/e2e/MANUAL-SMOKE.md` now keeps native context-menu hierarchy, real Chrome
keyboard accelerator dispatch, the browser permission dialog, the real side-panel
gesture, protected pages, and incognito-disabled behavior explicit and manual.

## Steps 5, 6 and 8 checkpoint (2026-09-01, Claude session)

### Two inherited gate failures fixed first

`npm test` exited 1 although every unit test passed: Vitest has no `exclude`, so its
default `**/*.{test,spec}.ts` glob collected the Playwright `.spec.ts` files and failed
on `test.beforeEach` inside an async `test.describe`. `vitest.config.ts` now excludes
`tests/e2e/**` on top of `configDefaults.exclude`. Unit runtime also dropped from 29s
to roughly 9s.

Repository-wide `npm run lint` exited 1 on the new `ReaderRoot` mouseup containment
barrier (`jsx-a11y/no-static-element-interactions`); the previous checkpoint had linted
only its own changed files. The handler is a containment barrier rather than an
interaction, and a role or tabIndex would add a spurious focus stop to a layout
container, so the rule is disabled on that one line with that justification. The
verified synthetic-event mechanism was deliberately left byte-identical rather than
refactored to a native ref listener, to preserve the packaged-Chromium evidence
recorded above.

### New test-support capabilities (each added test-first)

- `fake-ollama-server` chat scenario `hostile-markup` streams literal model markup
  (`[Model link](https://attacker.example)`, `<img onerror>`, `<script>`). RED observed
  as `expected 'Local answer.' to contain '[Model link]...'`.
- `fake-ollama-server.setUnreachable(enabled)` destroys incoming connections so the
  extension observes a genuinely unreachable host and the provider maps the resulting
  `TypeError` to `OLLAMA_UNREACHABLE`. RED observed as `setUnreachable is not a
  function`. `reset()` clears it.
- `__EXPLAIN_THIS_E2E_STREAM_TIMEOUT_MS__` (1500 ms) follows the existing endpoint and
  reader-hook constant pattern: declared in `src/e2e-build.d.ts`, defined in
  `wxt.config.ts`, surfaced as `E2E_STREAM_TIMEOUT_MS`, and applied in `background.ts`
  only when defined. Production compiles it to `undefined` and keeps the 30s provider
  defaults. `assertCompiledEndpointConstant` now also asserts the placeholder is
  compiled away.

### Step 5: `tests/e2e/privacy.spec.ts` (5 tests)

Selected-text-only default requests; opted-in nearby context limited to the nearest
visible reading blocks; absence of every hidden, form, script, style, navigation, and
distant prompt-injection marker from recorded request bodies; hostile model markup
rendered as inert text with zero `script`, `a`, or `img` nodes in the shadow root; and
`storage.local` plus the real sanitized diagnostics report free of source and output.
The first two tests validate each other — context is absent when off and present when
on — so neither passes vacuously.

### Step 6: `tests/e2e/errors.spec.ts` (9 tests)

Unreachable runtime, rejected origin, missing model, generic provider failure with a
successful retry, first-token timeout, idle timeout with partial output preserved,
malformed stream with partial output preserved, oversized dense-script selection
refused before any `/api/chat` request, and navigation cancellation clearing the
surface and private session state.

The oversized case uses the multilingual fixture's existing `#oversized-selection`
(`"漢".repeat(1601)`), which matches the coordinator's budget unit test. An initial
attempt with a ~176k-character Latin selection produced no UI at all, consistent with
the bounded port parser dropping the message before the coordinator could answer.

### Finding: three reader errors have no in-page recovery control

`OLLAMA_UNREACHABLE` (`open-setup`), `MODEL_NOT_FOUND` (`choose-model`), and
`OLLAMA_ORIGIN_BLOCKED` (`show-origin-steps`) render title and explanation but no
button in the reader card, because `ResponseCard` supplies only `onRetry`,
`onDismiss`, and `onSelectLessText`, and `PublicErrorNotice` intentionally renders
"only a supplied compatible control". The user's only in-page moves are Close or Open
in side panel, and the side panel supplies only `onRetry`. This is a deliberate
architectural split (a content script cannot open the options page directly), not a
defect introduced here, so the specifications assert the true current behavior —
title plus explanation, which uniquely pin the propagated `PublicErrorCode` — rather
than a control that does not exist. Whether the reader should offer a route to setup
is a product decision left to the controller.

### Step 8 verification (2026-09-01)

```text
npm test            437 passed (39 files), exit 0
npm run typecheck   exit 0
npm run lint        exit 0 (repository-wide)
npm run build       exit 0
npx playwright test 21 passed (errors 9, onboarding 2, privacy 5, reader 5), exit 0

changed-file prettier --check   exit 0
production background.js        no e2e reader-hook, timeout, or endpoint sentinel
production manifest             loopback-only hosts, no `tabs`, options_ui embedded
```

`tests/support/extension-fixture.ts` was Prettier-clean at HEAD and had drifted in the
inherited uncommitted changes (four wrapping hunks); it is now formatted.

**Correction (recorded during Task 17):** the sentence originally continued "so every
changed file passes the changed-file gate", and a claim was made that repository-wide
Prettier was clean. Both were wrong. The check that produced them piped
`prettier --check .` through `grep -E "^\[warn\]"`, which never matches because Prettier
colourises the `warn` token, so the grep silently reported success. Five further changed
files were still unformatted at that moment: `src/components/ActionToolbar.test.tsx`,
`tests/e2e/onboarding.spec.ts`, `tests/e2e/reader.spec.ts`,
`tests/support/extension-fixture.test.ts`, and
`tests/support/fixture-page-server.test.ts`. All five are now formatted. Repository-wide
Prettier remains red only on the three pre-existing files Task 13 already recorded
(`README.md`, `src/core/requests/schemas.ts`, `src/core/requests/schemas.test.ts`), which
are unmodified from HEAD and outside any changed-file boundary.

Step 9 (commit) was deliberately not performed: this task has not had its independent
review round, and the controller owns the commit boundary.

## Independent review fixes (2026-09-02)

The post-fix review found no Critical issue. Optional-origin revocation now checks and
removes each granted origin independently. E2E teardown attempts extension, fixture-server,
and Ollama cleanup in order and still removes the temporary profile if Chromium close fails.
The fixture returns the rewritten E2E manifest and validates a real production artifact,
while retaining the controller-approved broad test-only IPv4 loopback host. Slow-first-token
responses withhold headers and stream tests assert intermediate deltas/progress. Hostile-page
checks cover the isolated surface and narrow viewport. The trusted reader runtime now routes
setup-related model errors to the options page through a strict command. Focused tests,
typecheck, lint, production build, and 22 Chromium E2E tests pass. Commit is pending Git
index write permission in the current sandbox.
