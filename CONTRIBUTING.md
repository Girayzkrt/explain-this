# Contributing

## Requirements

- **Node 22** and npm.
- **Ollama is optional.** It is needed only for the opt-in local evaluation suite. Every
  other test uses a deterministic fake server and contacts nothing.

## Setup

```bash
npm ci
```

## The commands that matter

Run the aggregate gate before opening a pull request:

```bash
npm run check
```

That runs, in order: `format:check`, `lint`, `typecheck`, `test`, `build`,
`verify:manifest`, and `verify:package`.

The browser end-to-end suite is separate because it launches a real headed Chromium with
the packaged extension loaded:

```bash
npm run test:e2e
```

On Linux you need a display; CI runs it through `xvfb-run`.

Individual commands:

| Command                              | What it does                                     |
| ------------------------------------ | ------------------------------------------------ |
| `npm test`                           | Unit, component and contract tests (Vitest)      |
| `npm run test:e2e`                   | Packaged-extension browser tests (Playwright)    |
| `npm run test:ollama -- --preflight` | Checks whether a real evaluation run is possible |
| `npm run test:ollama`                | Opt-in evaluation against your local model       |
| `npm run verify:manifest`            | Asserts the built manifest's permissions         |
| `npm run verify:package`             | Asserts nothing unexpected ships                 |
| `npm run build` / `npm run zip`      | Production build / unsigned Chrome ZIP           |

## Testing strategy

- **Unit and component tests** cover contracts, budgets, state machines and UI behaviour.
- **Contract tests** exercise a fake Ollama server that mirrors the real HTTP shape.
- **End-to-end tests** drive the _packaged_ extension in real Chromium: onboarding, the
  reader flow, privacy guarantees and error recovery.
- **The evaluation suite** (`tests/evaluation/`) is opt-in and needs a real local model. It
  checks mechanical properties only; answer quality is scored by hand against
  `tests/evaluation/rubric.md`.
- **Browser-owned surfaces** — the native context menu, the real keyboard accelerator, the
  permission dialog, the side-panel gesture, protected pages and incognito — are not
  claimed as automated. They are a manual checklist in
  [`tests/e2e/MANUAL-SMOKE.md`](tests/e2e/MANUAL-SMOKE.md).

## Pull requests

- Use [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`,
  `test:`, `docs:`, `ci:`, `chore:`).
- Keep pull requests focused on one change.
- Include the evidence: what you ran and what it printed.
- **Never commit page text, model responses, or evaluation artifacts.**
  `artifacts/evaluation/` is git-ignored for that reason.

## Adding evaluation cases

Add original text you wrote, public-domain text, or synthetic text to
`tests/evaluation/cases.json`. Never paste content from a page you were reading. The
schema enforces the same request budgets the extension applies at runtime, so an
over-budget case fails `npm test`.
