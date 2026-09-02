# Hybrid provider design

Date: 2026-09-02
Status: approved, implementation split across Task 20 and Task 21

## Why

The extension answers in the reader's language, and until now it could only do that through
a model small enough to run on the reader's own machine. Measurement on 2026-09-02
established that this ceiling is real and cannot be reached past with prompt work. Across
twenty translations in ten European languages, `qwen2.5:3b-instruct` produced invented
non-words in Dutch, Polish, Swedish and Greek; `gemma3:4b`, now the recommended local
model, produced grammatical output everywhere but failed invisibly on the sentences that
matter, inserting a negation that inverted a Polish contractual clause and rendering a
thirty-day notice period as twenty in Turkish. `gemini-3.5-flash-lite`, measured on the
same corpus with the same prompt and the same checks, produced nineteen correct renderings
out of twenty and kept every number and polarity intact.

The product's stated purpose is to explain and translate correctly. Its other stated
promise is that the reader's text never leaves their machine. After the measurement these
two are in direct conflict, and no amount of engineering dissolves that. The resolution is
to stop making the choice on the reader's behalf: offer both, describe each honestly, and
let the reader decide which matters more for their use.

## Scope

Three modes are designed here. Implementation is split so that each task ships something
that works on its own.

**Task 20** makes provider selection real for the two modes that already share transport:
local Ollama and Ollama Cloud. Both reach the same `127.0.0.1:11434` endpoint, so this task
adds no provider class, no host permission, and no credential handling. It delivers the
mode concept, the safety gate, the onboarding branch, and the honest disclosure.

**Task 21** adds Gemini: a second `LlmProvider` implementation, user-supplied key storage,
an optional host permission requested at opt-in, and error mapping for authentication and
quota. It builds on a seam Task 20 will have proven.

## Evidence carried into the design

Four measured or verified facts constrain what follows. Each is recorded in the ledger with
its numbers.

1. Ollama Cloud is reached through the local Ollama at `127.0.0.1:11434` using the same
   `/api/chat` contract. The existing provider can talk to it unchanged.
2. Neither `/api/tags` nor `/api/show` carries any field indicating that a model runs in
   the cloud. There is no reliable API-level signal.
3. Ollama states that its cloud does not retain submitted data. Google states the opposite
   for the Gemini free tier: free-tier content is used to improve their products, and only
   the paid tier is excluded.
4. Because Ollama Cloud traffic goes to localhost, no host permission can distinguish it
   from local inference. For Gemini a withheld host permission is a real technical barrier;
   for Ollama Cloud no such barrier exists and disclosure is the only mechanism.

## Data model

`selectedProvider` becomes a union. Task 20 defines two values:

```ts
selectedProvider: z.enum(["ollama-local", "ollama-cloud"]);
```

Task 21 extends the enum with `"gemini"`. Adding a value does not invalidate stored
settings, so one migration covers both tasks: the settings repository rewrites a stored
`"ollama"` to `"ollama-local"` on read, and falls back to the default for any value it does
not recognise.

Model origin is derived, never stored. `ModelInfo` gains:

```ts
origin: "local" | "cloud" | "unknown";
```

`OllamaProvider.listModels` computes it from the `/api/tags` response using two signals: the
`-cloud` suffix in the model name, and a `size` of zero or absent, on the reasoning that a
cloud model has no local weights. Neither signal is contractual, which is why the third
value exists.

**Uncertainty resolves toward cloud.** An `"unknown"` origin is treated exactly as
`"cloud"` by every consumer. A model wrongly withheld from local mode costs the user one
extra step; a model wrongly admitted sends their reading off the machine after we promised
it would not.

## Mode and model consistency

The gate is a pure function in `core/`, independent of the provider and of React, so that
onboarding and the request path produce the same refusal:

```ts
function checkModeConsistency(
  mode: SelectedProvider,
  model: ModelInfo,
): "ok" | "cloud-model-in-local-mode" | "local-model-in-cloud-mode";
```

The two mismatches are not equally serious and the design treats them differently.
`cloud-model-in-local-mode` is a safety failure: the interface has promised the text stays
on the machine and the selected model would send it away. The request path refuses it and
it carries a `PublicErrorCode`. `local-model-in-cloud-mode` is only an expectation
mismatch — the reader gets more privacy than they asked for and lower quality than they
expected — so it never blocks a request. It exists so the model list can explain why an
entry is greyed out, and it stays out of the error vocabulary entirely.

The user's chosen mode is the sole source of truth for what the interface claims. The origin
heuristic only decides which models are offered. This ordering matters: if the heuristic is
wrong, the product has shown an unnecessary warning rather than told a lie.

## Onboarding

The second milestone already covers five internal states, so the new states cost no visible
step. The reader still sees "2 of 4".

```
welcome (1) -> choosing-mode (2) -> checking-runtime (2) -> ... -> choosing-model (2) -> preferences (3)
```

`choosing-mode` precedes `checking-runtime` deliberately. A reader who chooses Gemini in
Task 21 must not be required to install Ollama first, and that is only possible if the mode
is known before the runtime is probed.

The mode screen presents both options with equal weight, local listed first, each described
plainly:

- **On this computer** — Your selected text does not leave your machine. Requires Ollama and
  a model, about 3.3 GB.
- **Ollama Cloud** — Your selected text is sent to Ollama's servers. Ollama states that it
  does not retain your data. Runs larger models with nothing to download.

The attribution in the second description is deliberate. Non-retention is Ollama's claim,
not a guarantee this project can make, and the wording says so.

The cloud branch cannot run `ollama signin` on the reader's behalf. When `/api/tags`
contains no cloud-origin model, a `cloud-signin-guidance` state shows the commands and a
retry control, reusing the shape of the existing `origin-guidance` state rather than
inventing a second pattern for the same problem.

The model list is filtered and annotated by mode. In local mode, cloud and unknown-origin
models are listed but disabled with the reason shown; in cloud mode the reverse. Back
navigation extends to the new states, and changing mode from Settings re-runs the runtime
check and re-validates the selected model, so a mode change cannot leave a stale, invalid
selection in place.

## Provider wiring

Task 20 adds no provider selection. Both modes speak to the same Ollama instance, so
`background.ts` continues to construct one `OllamaProvider`; the mode governs which models
may be chosen, what the interface claims, and how the gate behaves. The only change inside
the provider is the `origin` computation in `listModels`. `streamChat`, `checkHealth` and
`getModelDetails` are untouched. Provider selection by mode arrives in Task 21, where it is
genuinely needed.

Cloud models are still pulled with `ollama pull`, but no weights are transferred, so the
operation is near-instant and reports zero or absent `totalBytes`. `ModelDownloadEvent`
already declares `totalBytes` optional; the download interface must honour that and fall
back to an indeterminate state rather than computing a percentage from zero.

The first-token timeout becomes mode-derived. Locally the delay is model loading — measured
at 30656 ms for a cold `gemma3:4b`. In the cloud there is no load but there is network
latency and queueing. One budget cannot fit both. The cloud value will be measured against a
signed-in installation and fixed then; the design requires only that the budget depend on
the mode.

## Errors

Two codes join `PublicErrorCode` in Task 20.

`OLLAMA_SIGNIN_REQUIRED` covers cloud mode without an authenticated session. Ollama's exact
unauthenticated response could not be verified without signing in, so the mapping starts
defensive: any authentication-shaped failure, whether a 401, a 403, or an identity error
surfaced in the stream, maps to this code, and the mapping is narrowed once the real shape
is observed during implementation.

`CLOUD_MODEL_IN_LOCAL_MODE` carries the gate's refusal. It is a real error code rather than
a UI-only state so that onboarding and the request path refuse identically instead of
drifting into two behaviours for one condition.

Gemini's authentication, quota and invalid-key codes are deliberately not defined here. They
will be written against observed responses in Task 21.

Prompt budgets do not change. The prompt is capped near 2600 tokens and `numCtx: 4096`
already covers it; enlarging the window was measured on 2026-09-02 to cost 3661 ms against
420 ms on the first request while gaining nothing, because the budget never fills it.

## Testing

The manifest constraint is enforced rather than trusted. `verify-manifest.ts` asserts that
production host permissions are exactly the two localhost entries, so any premature Google
host addition fails the build. The optional host permission belongs to Task 21.

Most of `privacy.spec.ts` is unaffected. Its assertions concern what enters the prompt —
selection boundaries, nearby-context discipline, page text never leaking — and cloud-mode
requests reach the same fake server, so those assertions hold unchanged.

Three areas are new.

_Unit, test-first._ `checkModeConsistency` is a pure function, so RED is observed before
implementation: cloud origin refused in local mode, unknown origin refused in local mode,
local origin in cloud mode reported as a mismatch that does not block, and matching pairs
accepted. A separate test asserts that only the local-mode failure reaches the request path,
which is what keeps the harmless direction out of the error vocabulary. Origin derivation is
covered separately for the suffix signal, the zero-size signal, and the case where the two
disagree. Observed RED output is quoted in the task report, per the workflow already in use.

_Migration._ A stored `selectedProvider` of `"ollama"` is rewritten to `"ollama-local"` on
read, and an unrecognised value falls back to the default.

_End to end._ The fake Ollama server gains a cloud-origin entry in `/api/tags`: a
`-cloud`-suffixed model with zero size. Two flows follow — reaching model choice through the
cloud branch's signin guidance, and confirming that a cloud model appears disabled in local
mode. A third test asserts the disclosure text matches the mode, which is what stops the
interface claiming text stays on the machine while cloud mode is active.

## Documentation

`README.md` currently promises without qualification that reading stays on the machine. That
statement becomes mode-dependent and must say so: the default local mode gives that
guarantee, and choosing Ollama Cloud sends selected text to Ollama's servers under Ollama's
own non-retention statement. `docs/privacy.md` and the store description carry the same
language. A sentence of precision here is cheaper than a compliance problem later.

## To verify during implementation

- Whether cloud models appear in `/api/tags` at all, and whether `size` is zero or absent.
  If both signals fail, the suffix stands alone; the direction of the decision does not
  change, because unknown already resolves toward cloud.
- Ollama's actual unauthenticated response shape, so `OLLAMA_SIGNIN_REQUIRED` can be narrowed
  from the defensive mapping.
- The cloud first-token latency, to fix the mode-derived timeout.

## Non-goals

Quality claims about Ollama Cloud. No cloud model has been measured on the corpus, and the
interface will not rank the modes by answer quality until one has been. Per-request cloud
confirmation was considered and rejected: the product's interaction is select-and-read, and a
prompt on every selection would end it.
