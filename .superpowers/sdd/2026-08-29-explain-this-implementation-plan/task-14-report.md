# Task 14 report: Current-tab focused explanation side panel

## Outcome

Recovered and audited the interrupted Task 14 implementation. The side panel renders
only the public `ReaderSession` for the active browser tab, refreshes on active-tab and
`storage.session` changes, and sends only bounded actions through the trusted
background-owned tab binding.

## RED/GREEN evidence

The interrupted working tree already contained the Task 14 production code and tests.
Recovery therefore began with the required focused verification rather than fabricating
a RED cycle by deleting working code. The first recovery baseline and the final focused
run were both green:

```text
npm test -- src/features/reader/sidepanel-controller.test.ts src/entrypoints/sidepanel/SidePanelApp.test.tsx src/features/reader/background-events.test.ts src/features/reader/request-coordinator.test.ts src/platform/messaging/contracts.test.ts src/entrypoints/reader.content/ReaderRoot.test.tsx
Test Files  6 passed (6)
Tests       79 passed (79)
```

The retained tests cover active-tab public-session loading, tab/session subscriptions,
typed Stop/Retry/follow-ups and port reconnection, expired-source guidance, trusted
side-panel identity and early-message buffering, strict command parsing, safe UI
rendering, and the visible unsupported-side-panel error.

## Privacy and design decisions

- The side-panel entrypoint reads only `reader-session:<tabId>` and validates it with
  the strict public-session parser. It does not read `reader-source:<tabId>` or use
  `PrivateSourceEnvelope`.
- The background accepts the side-panel port only when its port name, extension ID,
  and full generated `sidepanel.html` URL match. It derives the active HTTP(S) tab
  itself and discards any port-sender tab identity.
- Commands queued before active-tab lookup are strict-parsed, buffered, and discarded
  if the port disconnects. The request coordinator preserves global request ownership
  and permits the bound panel only to stop the active request for that same origin/tab.
- The UI has no free-form input. It offers Stop, Retry, and exactly Simpler, More
  detail, Why?, and Another example. Invalid stored-source actions produce
  select-again guidance.
- Markdown is rendered through `SafeMarkdown`; partial output, copy, diagnostics,
  empty state, semantic controls/status/alerts, visible focus, and narrow layouts are
  covered by the focused UI tests.

## Build and verification

```text
npm run typecheck
tsc --noEmit
exit 0

npx eslint <all changed TypeScript/TSX files>
exit 0

npx prettier --check <all changed files>
All matched files use Prettier code style!

git diff --check
exit 0

npm run build
WXT chrome-mv3 production build
exit 0
```

The built manifest declares `side_panel.default_path` as `sidepanel.html`, includes the
`sidePanel` permission, packages `.output/chrome-mv3/sidepanel.html`, and preserves the
narrow loopback `host_permissions` with broad HTTP(S) access only under
`optional_host_permissions`.

## Files

- `src/entrypoints/sidepanel/index.html`
- `src/entrypoints/sidepanel/main.tsx`
- `src/entrypoints/sidepanel/SidePanelApp.tsx`
- `src/entrypoints/sidepanel/SidePanelApp.test.tsx`
- `src/entrypoints/sidepanel/sidepanel.css`
- `src/features/reader/sidepanel-controller.ts`
- `src/features/reader/sidepanel-controller.test.ts`
- `src/features/reader/background-events.ts`
- `src/features/reader/request-coordinator.ts`
- `src/platform/messaging/contracts.ts`
- `src/entrypoints/reader.content/ReaderRoot.tsx`
- `src/components/ResponseCard.tsx`

## Residual risks

- Chrome side-panel behavior itself still depends on the target browser supporting the
  Chrome 116 side-panel API; the in-page control reports a generic safe error when it
  is unavailable.
- The focused suite intentionally avoids the repository-wide suite, per the task
  boundary. The controller owns that broader verification once all task branches land.

## Fix round 1: lifecycle hardening

### Decisions

- An active-tab notification now synchronously invalidates the displayed session and
  disconnects its port before asynchronous tab lookup starts. Every refresh also
  records an epoch, so an action based on a session still being refreshed cannot bind
  or send against a later tab.
- The background retains the first 16 strict commands received while active-tab
  binding is pending and drops later valid commands deterministically. Failed,
  unsupported, and untrusted side-panel binds clear temporary listeners/queue and
  disconnect the still-live port; a previously disconnected port remains a no-op.
- A failed send disconnects the failed port before one retry. If that retry fails, all
  transport state is released and the panel receives a fixed recoverable error without
  raw transport details. Successful delivery or a session update clears action error.
- Coordinator ownership remains unchanged: a short-lived side-panel port that did not
  start the generation cannot abort the content-owned generation; the panel remains
  authorized to stop the same-origin, same-tab request.

### RED/GREEN evidence

Each regression was first observed failing in its smallest focused suite, then passed
after its minimal fix. The consolidated run completed with 49 tests across controller,
background binding, and coordinator ownership:

```text
npm test -- src/features/reader/sidepanel-controller.test.ts src/features/reader/background-events.test.ts src/features/reader/request-coordinator.test.ts
Test Files  3 passed (3)
Tests       49 passed (49)
```
