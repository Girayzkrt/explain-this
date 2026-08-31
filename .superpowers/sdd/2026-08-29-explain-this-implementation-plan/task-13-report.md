# Task 13 report: Shadow DOM selection toolbar and response card

## Outcome

Implemented the runtime-injected in-page reader, its exhaustive controller state
machine, a sanitized Shadow DOM React surface, and the smallest trusted background
boundary needed for saved nearby-context/blocklist configuration and user-click
side-panel handoff.

## RED evidence

### Missing reader modules and runtime boundary

After adding the controller, component, and runtime-boundary tests before production
files, the required focused command failed exactly at the absent modules:

```text
npm test -- src/features/reader/reader-controller.test.ts src/entrypoints/reader.content/ReaderRoot.test.tsx src/platform/messaging/reader-runtime.test.ts
Test Files  3 failed (3)
Tests       no tests
```

Vitest reported unresolved imports for `reader-controller`, `ReaderRoot`, and
`reader-runtime`.

### Toolbar arrow navigation

A keyboard regression was added before arrow-key handling:

```text
npm test -- src/entrypoints/reader.content/ReaderRoot.test.tsx -t "keyboard activation"
Test Files  1 failed (1)
Tests       1 failed | 5 skipped (6)
```

Focus stayed on Explain after ArrowRight instead of moving to Simplify.

### Same-text context invalidation

A repeated-text selection in a different DOM context was added before identity
validation:

```text
npm test -- src/features/reader/reader-controller.test.ts -t "different DOM context"
Test Files  1 failed (1)
Tests       1 failed | 13 skipped (14)
```

The actions surface stayed open because only text equality was checked.

### Explicit invocation validation

The invocation parser was removed, its closed-union tests were added, and the test
was observed failing before the strict parser was restored:

```text
npm test -- src/platform/messaging/reader-command.test.ts
Test Files  1 failed (1)
Tests       2 failed | 4 passed (6)
```

The accepted commands failed because `parseReaderInvocationCommand` did not exist.

### Markdown image privacy

A Markdown image regression was added before the safe renderer override:

```text
npm test -- src/entrypoints/reader.content/ReaderRoot.test.tsx -t "links as inert"
Test Files  1 failed (1)
Tests       1 failed | 5 skipped (6)
```

React Markdown mounted a remote `img`, proving a model response could otherwise
cause an external fetch.

## GREEN evidence

Final focused reader/security/UI verification:

```text
npm test -- src/features/reader/reader-controller.test.ts src/entrypoints/reader.content/ReaderRoot.test.tsx src/platform/messaging/reader-runtime.test.ts src/platform/messaging/reader-command.test.ts
Test Files  4 passed (4)
Tests       31 passed (31)
```

Affected Task 7/8/9/12 verification:

```text
npm test -- src/features/reader/background-events.test.ts src/platform/messaging/contracts.test.ts src/platform/permissions/reader-access.test.ts src/core/privacy
Test Files  6 passed (6)
Tests       102 passed (102)
```

Final full verification and build are recorded below after the last Markdown
hardening change.

## Controller decisions

- The public state is an exhaustive discriminated union covering idle, actions,
  connecting, generating, complete, cancelled, and failed states. Selection source
  text remains only in controller memory until the one `start-request` handoff.
- A port is opened only after an action. Each action creates one UUID request and
  sends one allowlisted request. The controller has no storage, fetch, provider, or
  ambient browser API access; capture, config, context extraction, connection,
  animation frame, focus, clipboard, and side-panel capabilities are narrow injected
  adapters.
- Active connection ownership is identity-based. Replacement cancels at most once,
  detaches old listeners, disconnects the old port, and ignores all later old-port
  events. Stop is idempotent.
- Deltas must match the active request and contiguous sequence. Duplicate, stale,
  out-of-order, and invalid-state events are rejected. Accepted deltas share one
  animation-frame buffer, including terminal flushes.
- A disconnect preserves partial text in a recoverable failed state. Retry reopens a
  disconnected port. Typed follow-ups are accepted only from completed output and
  never recapture page context.
- Selection invalidation compares text, anchor element, and range boundary identity,
  so same-text replacement does not retain a stale surface. Escape, collapse, blur,
  invalidation, and teardown restore or clean ownership appropriately.

## Config and security boundary

- Content scripts cannot read trusted-only storage. A dedicated strict, data-free
  runtime union accepts only `get-reader-config` and user-click `open-side-panel`.
- The background validates extension ID, numeric sender tab, and trusted HTTP(S) tab
  URL before either command. It derives blocked status from trusted tab URL and local
  settings.
- The config response is limited to `automaticToolbar`, `includeNearbyContext`, and
  `blocked` booleans. It never returns prompts, selected/source text, endpoint,
  language, provider/model options, or the full blocklist/settings object.
- Explicit context-menu and keyboard commands now cross their own strict Zod boundary.
  The side-panel tab ID is derived only from the trusted sender and is never supplied
  by page data.
- `SafeMarkdown` skips raw HTML, sanitizes the tree, renders links as inert label text,
  and renders Markdown images as inert alt text, preventing navigation and remote
  image requests. Clipboard write is invoked only from the Copy click handler; no
  clipboard-read permission is requested.
- The new runtime message listener is constructed and registered synchronously with
  the existing MV3 listeners before asynchronous service initialization.

## Design and accessibility decisions

- The subject is an immediate local reading annotation. The surface is a compact
  editorial action strip and a paper-like margin note capped at about 26rem.
- The one signature is a cobalt local spine that changes to mint, amber, or coral for
  terminal semantics. Cloud/paper/ink/slate remain quiet; there are no gradients,
  chat bubbles, decorative pills, external assets/fonts, or heavy shadows.
- Segoe UI/Aptos/system is the reading face and Cascadia Mono/Consolas is restricted
  to action/status utility. All CSS is loaded into WXT's Shadow root and begins from
  the Shadow reset.
- Controls use semantic buttons, visible focus, approximately 44px targets, toolbar
  semantics, ArrowLeft/ArrowRight/Home/End navigation, polite streamed prose, status
  and alert roles, keyboard Escape, responsive viewport clamping, forced-colors
  treatment, and reduced-motion removal.
- Motion is limited to one generating spine pulse. Focus returns to the selected
  reading anchor on close without scrolling.

## React review

- Static action/follow-up metadata is module-hoisted; no components are declared
  inside render functions.
- `useSyncExternalStore` provides one stable controller subscription. Global keyboard
  listeners are installed once and removed on unmount.
- High-frequency delta text is held in the controller and applied to React state only
  once per animation frame, avoiding per-token Markdown reprocessing.
- Derived flags stay render-local, event work stays in click handlers, and the task
  adds no UI framework, CSS-in-JS runtime, external font, or barrel import.

## Runtime and packaged asset decisions

- `reader.content` uses WXT runtime registration, `document_idle`, `ISOLATED`, and
  `cssInjectionMode: "ui"` with a narrow `http://127.0.0.1:11434/*` generation match.
- The loopback match is documented as a build-generation device. Task 7 remains the
  sole owner of optional HTTP/HTTPS dynamic registration and activeTab injection.
- Build output contains exact `content-scripts/reader.js` and
  `content-scripts/reader.css` assets. The manifest has no ordinary-page
  `content_scripts` entry.

## Files

- `src/components/ActionToolbar.tsx`
- `src/components/ResponseCard.tsx`
- `src/components/SafeMarkdown.tsx`
- `src/entrypoints/background.ts`
- `src/entrypoints/reader.content/index.tsx`
- `src/entrypoints/reader.content/ReaderRoot.tsx`
- `src/entrypoints/reader.content/ReaderRoot.test.tsx`
- `src/entrypoints/reader.content/reader.css`
- `src/features/reader/reader-controller.ts`
- `src/features/reader/reader-controller.test.ts`
- `src/platform/messaging/reader-command.ts`
- `src/platform/messaging/reader-command.test.ts`
- `src/platform/messaging/reader-runtime.ts`
- `src/platform/messaging/reader-runtime.test.ts`

`wxt.config.ts` did not require modification because the generated permission split
remained correct.

## Final checks and commit

Fresh verification after the final source change:

```text
npm test
Test Files  27 passed (27)
Tests       329 passed (329)

npm run typecheck
tsc --noEmit
exit 0

npm run build
WXT chrome-mv3 production build
exit 0
```

Changed-file ESLint exited 0. Changed files were formatted with Prettier and
`git diff --check` exited 0.

Fresh generated-manifest and asset assertions passed:

- required hosts are exactly `http://127.0.0.1:11434/*` and
  `http://localhost:11434/*`;
- broad `http://*/*` and `https://*/*` patterns appear only in
  `optional_host_permissions`;
- no manifest `content_scripts` entry exists;
- packaged `content-scripts/reader.js` is 417,384 bytes;
- packaged `content-scripts/reader.css` is 4,184 bytes.

Committed as `0aa6ba3973452e981a7052e6e488b37aa1333536`
(`feat: add floating explanation panel`). The tracked worktree is clean; this SDD
report remains intentionally ignored.

## Review fix round 1

- A nearby-context extraction failure now retains the selected text only in
  controller memory. Retry creates a fresh `start-request` for the same action
  with no `nearbyContext`; it never sends a fake request ID or a no-op retry.
- Reader-content port input is parsed as a strict, bounded Zod union before the
  controller subscription. Invalid worker payloads are ignored without throwing.
- Explicit invocations now share the selection epoch with automatic selections,
  preventing a late config response from replacing a newer action or selection.
- Terminal stream events cancel an already-scheduled animation frame after their
  synchronous delta flush.

Focused verification: 75 reader/runtime/invocation tests passed and
`npm run typecheck` exited 0.
