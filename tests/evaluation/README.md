# Prompt evaluation suite

A versioned corpus of reading cases and an **opt-in** runner that sends them to a real
local model. Nothing here contacts a real model in CI: `npm test` validates the corpus
and exercises the runner with an in-memory fake provider.

## What is in here

| File                      | Purpose                                                                      |
| ------------------------- | ---------------------------------------------------------------------------- |
| `cases.json`              | The versioned corpus. Original passages written for this repository.         |
| `schema.ts`               | The only gate on the corpus: shape, coverage fields, and production budgets. |
| `cases.test.ts`           | Runs in `npm test`. Validates the corpus offline; contacts nothing.          |
| `run-real-ollama.ts`      | The opt-in runner. Talks to a real local Ollama.                             |
| `run-real-ollama.test.ts` | Runs in `npm test`. Exercises the runner against a fake provider.            |
| `rubric.md`               | The 1–5 human scoring rubric. Automated checks do not judge quality.         |

## Corpus content policy

Every passage is original text written for this repository, public-domain, or synthetic.
**Never add real browsing content, personal data, or text copied from a page you were
reading.** The corpus is committed to git and is world-readable.

Each case declares `expectedProperties` (what a human reviewer should look for),
`prohibitedProperties` (semantic failure criteria for the reviewer), and
`prohibitedLiterals` (strings the model must never emit). Only literal prohibitions are
checked automatically.

## Running it

Validate the corpus — offline, no model required:

```bash
npm test -- tests/evaluation
```

Check whether a real run is even possible, without generating anything:

```bash
npm run test:ollama -- --preflight
```

Run the full corpus against the local model:

```bash
npm run test:ollama
```

Keep the full responses for hand-scoring:

```bash
npm run test:ollama -- --save-responses
```

Only `--preflight` and `--save-responses` are accepted; any other argument is rejected
rather than ignored.

## What the runner will not do

- It will **not download a model.** The runner is typed against `LlmProvider` rather than
  `DownloadableModelProvider`, so pulling a model is impossible by construction, not just
  discouraged. If the recommended model is missing it prints the `ollama pull` command and exits
  non-zero.
- It will **not start Ollama** or install anything.
- It will **not write responses** anywhere unless you pass `--save-responses`, and then
  only into `artifacts/evaluation/`, which is git-ignored.

## What the automated checks cover

Mechanical properties only: stream completion, non-empty output, the approved output
ceiling, leaked prompt delimiters (`<selected_text>` and friends), and prohibited
literals. A non-zero exit code means one of those failed — not that the answers were
poor.

Quality is scored by hand against [`rubric.md`](./rubric.md).

## Reusing production behaviour

The runner builds every request through the production `buildChatRequest`, with
production preferences, the production `enforceReadingBudget`, and `think: false`. It is
deliberately not a parallel prompt implementation — if the shipped prompt changes, the
evaluation changes with it.

## Recording results

Record aggregates only: date, model, corpus version, case count, mean score per rubric
dimension, and the ids of cases below the pass bar. Raw responses stay local.
