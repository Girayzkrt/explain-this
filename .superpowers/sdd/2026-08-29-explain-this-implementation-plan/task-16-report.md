# Task 16 checkpoint A report: deterministic local E2E servers

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
