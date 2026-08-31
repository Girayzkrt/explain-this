# Task 15 report: Actionable errors and sanitized diagnostics

## Outcome

Recovered the interrupted Task 15 implementation and completed its remaining
permission-denied recovery path. All user-facing model failures now use exhaustive,
fixed public copy keyed by `PublicErrorCode`; raw exception messages are not rendered.
Options exposes the existing no-access continuation through
`resolvePermission(false, true)`, preserving the safe onboarding flow into readiness.

## RED/GREEN evidence

Recovery began with the controller-reported focused baseline:

```text
7 focused files: 58 passed, 1 failed (59 tests)
Failure: OptionsApp permission-denied state had no
"Continue without automatic access" button.
```

Root cause was a missing `onContinueWithoutAccess` callback in the failed onboarding
surface. The callback was added and the regression passed. Additional boundary tests
were written test-first and observed failing before each hardening change:

- hostile `Object.hasOwn` proxy input failed before safe diagnostics access was added;
- revoked proxy input failed before safe object classification was added;
- synchronous clipboard failure escaped before fixed failure feedback was added.

Final focused verification:

```text
npx vitest run [Task 15 seven-file suite]
Test Files  7 passed (7)
Tests       62 passed (62)
```

## Design and privacy

- `ERROR_PRESENTATIONS` is an exhaustive `Record<PublicErrorCode, ErrorPresentation>`,
  including `INVALID_ENDPOINT`, with fixed title, explanation, and valid primary
  recovery intent for every code.
- `PublicErrorNotice` renders only fixed presentation copy and renders a control only
  when the matching callback is supplied. Options, reader, and side-panel surfaces
  preserve partial output and label failed/cancelled output as incomplete.
- Diagnostics are constructed from an explicit allowlist. Unknown, inherited,
  nested, proxy, overlong, non-finite, negative, and out-of-range values are ignored;
  endpoint output is restricted to the loopback hostname and fixed port `11434`.
  Serialization is exactly two-space JSON and contains no page text, URLs, answers,
  prompts, cookies, headers, or raw provider input.
- Diagnostics are rendered only in the trusted Options settings surface. Clipboard
  writes occur only after the explicit button click; rejected or synchronously thrown
  clipboard calls produce fixed safe feedback.

## Files

- `src/core/requests/error-copy.ts` and `.test.ts`
- `src/components/PublicErrorNotice.tsx` and `.test.tsx`
- `src/components/ResponseCard.tsx`
- `src/features/onboarding/diagnostics.ts` and `.test.ts`
- `src/features/onboarding/DiagnosticsView.tsx` and `.test.tsx`
- `src/entrypoints/options/OptionsApp.tsx` and `.test.tsx`
- `src/entrypoints/options/main.tsx`
- `src/entrypoints/reader.content/ReaderRoot.test.tsx`
- `src/entrypoints/sidepanel/SidePanelApp.tsx` and `.test.tsx`

## Verification and build outputs

```text
npm run typecheck                 exit 0
npx eslint <all changed files>    exit 0
npx prettier --check <changed>   All matched files use Prettier code style!
git diff --check                  exit 0
npm run build                     WXT chrome-mv3 production build, exit 0
```

The production manifest contains `activeTab`, `contextMenus`, `scripting`,
`sidePanel`, and `storage`; required hosts are only loopback Ollama endpoints and
ordinary HTTP(S) hosts remain optional. The build contains `options.html`,
`sidepanel.html`, and the reader content-script assets.

## Residual risks

- The focused Task 15 suite intentionally excludes the full repository suite per the
  task boundary; later integration/E2E work remains the broader browser verification.
- Clipboard availability still depends on browser permission/runtime support; failures
  are handled with fixed feedback and no sensitive details.
