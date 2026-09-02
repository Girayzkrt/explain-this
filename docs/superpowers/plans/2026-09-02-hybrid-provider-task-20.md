# Hybrid Provider, Task 20 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the reader choose between running the model on their own machine and running it on Ollama Cloud, and make the interface tell the truth about which one is active.

**Architecture:** Both modes reach the same Ollama at `127.0.0.1:11434`, so no second provider is built here. A `selectedProvider` union records the reader's choice, a derived `origin` field marks each model as local or cloud, and a pure gate refuses the one combination that would break the privacy promise. Onboarding gains two internal states inside the existing second milestone, so the visible step count does not change.

**Tech Stack:** TypeScript (strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), Zod, React 19, WXT, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-02-hybrid-provider-design.md`

## Global Constraints

- TypeScript is strict with `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`. Optional properties are added with conditional spreads (`...(x === undefined ? {} : { x })`), never assigned `undefined`.
- Production `host_permissions` stay exactly `http://127.0.0.1:11434/*` and `http://localhost:11434/*`. No Google host in Task 20.
- An `"unknown"` model origin is treated as `"cloud"` by every consumer. Never as local.
- The reader's chosen mode is the only source of truth for what the interface claims. The origin heuristic only decides which models are offered.
- Never commit page text, model output, or evaluation artifacts.
- Disclosure copy attributes non-retention to Ollama ("Ollama states that...") and never asserts it as this project's guarantee.
- Full gate before every commit: `npm run check`.

---

### Task 1: Derive model origin

**Files:**

- Create: `src/providers/ollama/model-origin.ts`
- Create: `src/providers/ollama/model-origin.test.ts`
- Modify: `src/providers/ollama/schemas.ts:11-17` (make `size` optional)
- Modify: `src/providers/provider.ts:36-40` (`ModelInfo` gains `origin`)
- Modify: `src/providers/ollama/ollama-provider.ts:120-127` (`listModels` wires it)

**Interfaces:**

- Produces: `deriveModelOrigin(name: string, sizeBytes: number | undefined): ModelOrigin` and `type ModelOrigin = "local" | "cloud" | "unknown"`, both exported from `src/providers/ollama/model-origin.ts`. `ModelInfo.origin: ModelOrigin` is exported from `src/providers/provider.ts`.

- [ ] **Step 1: Write the failing test**

Create `src/providers/ollama/model-origin.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { deriveModelOrigin } from "./model-origin";

describe("deriveModelOrigin", () => {
  test("treats a -cloud suffix as cloud whatever the size says", () => {
    expect(deriveModelOrigin("gpt-oss:120b-cloud", 0)).toBe("cloud");
    expect(deriveModelOrigin("gemma4:26b-cloud", 4_000_000_000)).toBe("cloud");
  });

  test("treats a named model with real local weights as local", () => {
    expect(deriveModelOrigin("gemma3:4b", 3_338_801_804)).toBe("local");
  });

  // Ollama's API carries no cloud marker, so a model with no weights on disk and no
  // suffix cannot be classified. It must not be assumed local.
  test("reports an unmarked model with no local weights as unknown", () => {
    expect(deriveModelOrigin("mistral-large-3", 0)).toBe("unknown");
    expect(deriveModelOrigin("mistral-large-3", undefined)).toBe("unknown");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/providers/ollama/model-origin.test.ts`
Expected: FAIL — `Failed to resolve import "./model-origin"`.

- [ ] **Step 3: Write the implementation**

Create `src/providers/ollama/model-origin.ts`:

```ts
export type ModelOrigin = "local" | "cloud" | "unknown";

/**
 * Ollama exposes no field saying whether a model runs in its cloud, so origin is inferred
 * from two unreliable signals: the naming convention, and the absence of local weights.
 * Anything that cannot be shown to be local stays "unknown", which every consumer treats
 * as cloud. Withholding a local model costs a step; admitting a cloud one breaks a promise.
 */
export function deriveModelOrigin(
  name: string,
  sizeBytes: number | undefined,
): ModelOrigin {
  if (name.toLowerCase().endsWith("-cloud")) return "cloud";
  if (sizeBytes !== undefined && sizeBytes > 0) return "local";
  return "unknown";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/providers/ollama/model-origin.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Make the tags schema tolerate a missing size**

In `src/providers/ollama/schemas.ts`, change `ollamaTagModelSchema` so a cloud model that reports no size does not fail parsing and take the whole list down with it:

```ts
export const ollamaTagModelSchema = z
  .object({
    name: z.string(),
    // Cloud models have no local weights, and may report no size at all.
    size: z.number().nonnegative().optional(),
    details: ollamaDetailsSchema.optional(),
  })
  .passthrough();
```

- [ ] **Step 6: Add `origin` to `ModelInfo`**

In `src/providers/provider.ts`, extend the interface and import the type:

```ts
import type { ModelOrigin } from "./ollama/model-origin";

export interface ModelInfo {
  id: string;
  displayName: string;
  sizeBytes?: number;
  origin: ModelOrigin;
}
```

- [ ] **Step 7: Wire it into `listModels`**

Replace the body of `listModels` in `src/providers/ollama/ollama-provider.ts`:

```ts
  async listModels(signal: AbortSignal): Promise<ModelInfo[]> {
    const tags = await this.fetchTags(signal);
    return tags.models.map((model) => ({
      id: model.name,
      displayName: model.name,
      ...(model.size === undefined ? {} : { sizeBytes: model.size }),
      origin: deriveModelOrigin(model.name, model.size),
    }));
  }
```

Add the import at the top of the file: `import { deriveModelOrigin } from "./model-origin";`

- [ ] **Step 8: Fix every `ModelInfo` literal the new required field breaks**

Run: `npm run typecheck`
Expected: errors in test files and fixtures that build `ModelInfo` without `origin`. Add `origin: "local"` to each, since they all represent installed local models today. Known sites: `src/features/onboarding/onboarding-service.test.ts:66`, `tests/evaluation/run-real-ollama.test.ts:66`. Re-run until clean.

- [ ] **Step 9: Run the full gate**

Run: `npm run check`
Expected: exit 0.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat: derive whether a model runs locally or in Ollama's cloud"
```

---

### Task 2: Mode union and migration

**Files:**

- Modify: `src/features/settings/settings.ts:5-30`
- Modify: `src/platform/storage/settings-repository.ts:60-75`
- Modify: `src/platform/storage/settings-repository.test.ts`

**Interfaces:**

- Consumes: nothing from Task 1.
- Produces: `SelectedProviderSchema` and `type SelectedProvider = "ollama-local" | "ollama-cloud"`, exported from `src/features/settings/settings.ts`.

- [ ] **Step 1: Write the failing test**

Append to `src/platform/storage/settings-repository.test.ts`. Match the existing file's helper for building a fake storage area; if it names one differently, reuse that name rather than introducing a second one.

```ts
describe("selectedProvider migration", () => {
  // get() repairs unparseable settings by resetting to defaults, so without a migration an
  // existing install would silently lose its language, level and blocked sites.
  test("rewrites a stored ollama provider and keeps every other preference", async () => {
    const storage = createFakeStorageArea({
      settings: {
        onboardingVersion: 1,
        preferences: {
          preferredLanguage: "Turkish",
          explanationLevel: "technical",
          preserveEnglishTerms: false,
          includeNearbyContext: true,
          selectedProvider: "ollama",
          selectedModel: "gemma3:4b",
          automaticToolbar: true,
          blockedSites: ["example.com"],
        },
      },
    });
    const repository = createSettingsRepository(storage, () => "English");

    const stored = await repository.get();

    expect(stored.preferences.selectedProvider).toBe("ollama-local");
    expect(stored.preferences.preferredLanguage).toBe("Turkish");
    expect(stored.preferences.blockedSites).toEqual(["example.com"]);
    expect(stored.onboardingVersion).toBe(1);
  });

  test("falls back to defaults for a provider value it does not recognise", async () => {
    const storage = createFakeStorageArea({
      settings: {
        onboardingVersion: 1,
        preferences: {
          preferredLanguage: "Turkish",
          explanationLevel: "technical",
          preserveEnglishTerms: false,
          includeNearbyContext: true,
          selectedProvider: "anthropic",
          selectedModel: "gemma3:4b",
          automaticToolbar: true,
          blockedSites: ["example.com"],
        },
      },
    });
    const repository = createSettingsRepository(storage, () => "English");

    const stored = await repository.get();

    expect(stored.preferences.selectedProvider).toBe("ollama-local");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/platform/storage/settings-repository.test.ts -t "selectedProvider migration"`
Expected: FAIL — the first test receives `"ollama"` rewritten to defaults, so `preferredLanguage` is `"English"` and `blockedSites` is empty.

- [ ] **Step 3: Widen the schema**

In `src/features/settings/settings.ts`, replace the literal with a union and export the type:

```ts
export const SelectedProviderSchema = z.enum(["ollama-local", "ollama-cloud"]);
export type SelectedProvider = z.infer<typeof SelectedProviderSchema>;
```

In `ReadingPreferencesSchema`, replace `selectedProvider: z.literal("ollama"),` with `selectedProvider: SelectedProviderSchema,`. In `DEFAULT_PREFERENCES`, replace `selectedProvider: "ollama",` with `selectedProvider: "ollama-local",`.

- [ ] **Step 4: Migrate before the strict parse**

In `src/platform/storage/settings-repository.ts`, add above the class:

```ts
/** The provider was a single literal before cloud mode existed. */
function migrateStoredSettings(stored: unknown): unknown {
  if (typeof stored !== "object" || stored === null) return stored;
  const settings = stored as Record<string, unknown>;
  const preferences = settings.preferences;
  if (typeof preferences !== "object" || preferences === null) return stored;
  const values = preferences as Record<string, unknown>;
  if (values.selectedProvider !== "ollama") return stored;
  return {
    ...settings,
    preferences: { ...values, selectedProvider: "ollama-local" },
  };
}
```

Then in `get()`, run it before parsing:

```ts
const stored = await this.storage.get(SETTINGS_KEY);
const parsed = PersistedSettingsSchema.safeParse(
  migrateStoredSettings(stored[SETTINGS_KEY]),
);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/platform/storage/settings-repository.test.ts -t "selectedProvider migration"`
Expected: PASS, 2 tests.

- [ ] **Step 6: Run the full gate**

Run: `npm run check`
Expected: exit 0. If `settings.test.ts` asserts `selectedProvider: "ollama"`, update it to `"ollama-local"`.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: record which mode the reader chose, migrating existing installs"
```

---

### Task 3: The consistency gate

**Files:**

- Create: `src/core/requests/mode-consistency.ts`
- Create: `src/core/requests/mode-consistency.test.ts`
- Modify: `src/core/requests/public-error.ts:1-19`

**Interfaces:**

- Consumes: `ModelOrigin` from Task 1, `SelectedProvider` from Task 2.
- Produces: `checkModeConsistency(mode: SelectedProvider, origin: ModelOrigin): ModeConsistency` where `type ModeConsistency = "ok" | "cloud-model-in-local-mode" | "local-model-in-cloud-mode"`, and `blocksRequest(result: ModeConsistency): boolean`.

- [ ] **Step 1: Write the failing test**

Create `src/core/requests/mode-consistency.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { blocksRequest, checkModeConsistency } from "./mode-consistency";

describe("checkModeConsistency", () => {
  test("accepts a local model in local mode and a cloud model in cloud mode", () => {
    expect(checkModeConsistency("ollama-local", "local")).toBe("ok");
    expect(checkModeConsistency("ollama-cloud", "cloud")).toBe("ok");
  });

  test("refuses a cloud model in local mode", () => {
    expect(checkModeConsistency("ollama-local", "cloud")).toBe(
      "cloud-model-in-local-mode",
    );
  });

  // The heuristic cannot prove this model is local, and local mode has promised the text
  // stays on the machine, so the unprovable case is refused rather than assumed safe.
  test("refuses an unknown origin in local mode", () => {
    expect(checkModeConsistency("ollama-local", "unknown")).toBe(
      "cloud-model-in-local-mode",
    );
  });

  test("reports a local model in cloud mode as a mismatch", () => {
    expect(checkModeConsistency("ollama-cloud", "local")).toBe(
      "local-model-in-cloud-mode",
    );
  });
});

describe("blocksRequest", () => {
  // Only the unsafe direction stops a request. The other gives the reader more privacy
  // than they asked for, which is no reason to refuse to answer.
  test("blocks only the mismatch that would break the privacy promise", () => {
    expect(blocksRequest("cloud-model-in-local-mode")).toBe(true);
    expect(blocksRequest("local-model-in-cloud-mode")).toBe(false);
    expect(blocksRequest("ok")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/requests/mode-consistency.test.ts`
Expected: FAIL — `Failed to resolve import "./mode-consistency"`.

- [ ] **Step 3: Write the implementation**

Create `src/core/requests/mode-consistency.ts`:

```ts
import type { SelectedProvider } from "../../features/settings/settings";
import type { ModelOrigin } from "../../providers/ollama/model-origin";

export type ModeConsistency =
  "ok" | "cloud-model-in-local-mode" | "local-model-in-cloud-mode";

export function checkModeConsistency(
  mode: SelectedProvider,
  origin: ModelOrigin,
): ModeConsistency {
  if (mode === "ollama-local") {
    return origin === "local" ? "ok" : "cloud-model-in-local-mode";
  }
  return origin === "local" ? "local-model-in-cloud-mode" : "ok";
}

/**
 * Only the local-mode failure reaches the request path. A local model in cloud mode
 * disappoints the reader's expectation of quality; it does not send their reading anywhere
 * they were not told about, so it never refuses an answer.
 */
export function blocksRequest(result: ModeConsistency): boolean {
  return result === "cloud-model-in-local-mode";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/core/requests/mode-consistency.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Add the error code**

In `src/core/requests/public-error.ts`, add `| "CLOUD_MODEL_IN_LOCAL_MODE"` to the `PublicErrorCode` union, after `"MODEL_NOT_FOUND"`.

- [ ] **Step 6: Run the full gate**

Run: `npm run check`
Expected: exit 0. If any exhaustive `switch` over `PublicErrorCode` now fails to compile, add a branch whose message reads: `The selected model runs in Ollama's cloud, but this computer-only mode was chosen. Pick a local model or switch to Ollama Cloud in Settings.`

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: refuse a cloud model while the local-only promise is in force"
```

---

### Task 4: Enforce the gate on the request path

**Files:**

- Modify: `src/core/requests/request-coordinator.ts`
- Modify: `src/core/requests/request-coordinator.test.ts`

**Interfaces:**

- Consumes: `checkModeConsistency`, `blocksRequest` from Task 3; `LlmProvider.listModels` from Task 1.

- [ ] **Step 1: Read the coordinator before changing it**

Run: `sed -n '1,80p' src/core/requests/request-coordinator.ts`
Note how it reads preferences and how it emits a `failed` stream event, and follow that shape exactly in the steps below rather than inventing a new one.

- [ ] **Step 2: Write the failing test**

Append to `src/core/requests/request-coordinator.test.ts`, reusing the file's existing harness helpers:

```ts
test("refuses to start a request when local mode has a cloud model selected", async () => {
  const harness = createHarness({
    preferences: {
      selectedProvider: "ollama-local",
      selectedModel: "gemma4:26b-cloud",
    },
    models: [
      { id: "gemma4:26b-cloud", displayName: "gemma4:26b-cloud", origin: "cloud" },
    ],
  });

  const events = await collect(harness.coordinator.explain(baseReadingRequest));

  expect(events.at(-1)).toMatchObject({
    type: "failed",
    error: { code: "CLOUD_MODEL_IN_LOCAL_MODE" },
  });
  expect(harness.provider.chatCalls).toHaveLength(0);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/core/requests/request-coordinator.test.ts -t "cloud model selected"`
Expected: FAIL — the coordinator streams normally and `chatCalls` has length 1.

- [ ] **Step 4: Implement the check**

Before the coordinator opens the chat stream, resolve the selected model's origin from `provider.listModels` and refuse when the gate blocks:

```ts
const models = await this.provider.listModels(signal);
const selected = models.find((model) => model.id === preferences.selectedModel);
// An unlisted model cannot be shown to be local, and local mode has made a promise.
const origin = selected?.origin ?? "unknown";
const consistency = checkModeConsistency(preferences.selectedProvider, origin);
if (blocksRequest(consistency)) {
  throw new PublicError(
    "CLOUD_MODEL_IN_LOCAL_MODE",
    "The selected model runs in Ollama's cloud, but this computer-only mode was chosen. Pick a local model or switch to Ollama Cloud in Settings.",
    true,
  );
}
```

Place it so the existing failure-to-stream-event mapping converts the throw into a `failed` event, matching how other `PublicError` throws are already handled in this file.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/core/requests/request-coordinator.test.ts`
Expected: PASS, whole file.

- [ ] **Step 6: Run the full gate**

Run: `npm run check`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: stop a reading request that would contradict the chosen mode"
```

---

### Task 5: The choosing-mode onboarding state

**Files:**

- Modify: `src/features/onboarding/use-onboarding.ts:25-95` (state, actions, reducer, step number, back)
- Modify: `src/features/onboarding/use-onboarding.test.ts`

**Interfaces:**

- Consumes: `SelectedProvider` from Task 2.
- Produces: onboarding state `{ step: "choosing-mode" }`; controller method `chooseMode(mode: SelectedProvider): void`; action `{ type: "mode"; mode: SelectedProvider }`.

- [ ] **Step 1: Write the failing test**

Append to `src/features/onboarding/use-onboarding.test.ts`:

```ts
test("asks how it should run before probing the runtime", () => {
  const { result } = renderOnboarding();

  act(() => result.current.controller.begin());

  expect(result.current.state.step).toBe("choosing-mode");
});

test("keeps the mode choice inside the second milestone", () => {
  expect(onboardingStepNumber({ step: "choosing-mode" })).toBe(2);
});

test("returns from model choice to the mode choice", () => {
  const { result } = renderOnboarding();

  act(() => result.current.controller.begin());
  act(() => result.current.controller.chooseMode("ollama-cloud"));
  act(() =>
    result.current.dispatchForTest({
      type: "models",
      models: [{ id: "gemma3:4b", displayName: "gemma3:4b", origin: "local" }],
    }),
  );
  act(() => result.current.controller.goBack());

  expect(result.current.state.step).toBe("choosing-mode");
});
```

If the test file has no `dispatchForTest` escape hatch, drive the state through the existing port-message helpers the file already uses instead, and keep the three assertions unchanged.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/features/onboarding/use-onboarding.test.ts -t "milestone"`
Expected: FAIL — `onboardingStepNumber` has no `"choosing-mode"` branch, so TypeScript rejects the literal and the run errors before assertions.

- [ ] **Step 3: Add the state and action**

In `src/features/onboarding/use-onboarding.ts`, add to `OnboardingState`:

```ts
  | { step: "choosing-mode" }
```

and to `OnboardingAction`:

```ts
  | { type: "mode"; mode: SelectedProvider }
```

- [ ] **Step 4: Map the milestone**

In `onboardingStepNumber`, add `case "choosing-mode":` immediately above `case "checking-runtime":` so it falls through to `return 2`.

- [ ] **Step 5: Route welcome into the mode choice**

In `reduceOnboarding`, make the action that currently moves `welcome` to `checking-runtime` move it to `choosing-mode` instead, and add:

```ts
    case "mode":
      return { step: "checking-runtime" };
```

Persist the chosen mode through the existing preferences save path, so the reducer stays a pure state machine and storage stays where it already is.

- [ ] **Step 6: Add the controller method and back edge**

Add `chooseMode(mode: SelectedProvider)` to `OnboardingController`, dispatching `{ type: "mode", mode }` and writing `selectedProvider` through the settings port the hook already uses. In the `back` action, add a branch returning `{ step: "choosing-mode" }` when the current step is `"choosing-model"`.

- [ ] **Step 7: Run test to verify it passes**

Run: `npx vitest run src/features/onboarding/use-onboarding.test.ts`
Expected: PASS, whole file.

- [ ] **Step 8: Run the full gate**

Run: `npm run check`
Expected: exit 0.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: ask how the model should run before probing for Ollama"
```

---

### Task 6: The cloud signin guidance state

**Files:**

- Modify: `src/core/requests/public-error.ts`
- Modify: `src/features/onboarding/use-onboarding.ts`
- Modify: `src/features/onboarding/onboarding-service.ts:240-260`
- Modify: `src/features/onboarding/onboarding-service.test.ts`

**Interfaces:**

- Consumes: `ModelOrigin` from Task 1, `choosing-mode` from Task 5.
- Produces: onboarding state `{ step: "cloud-signin-guidance" }`; error code `OLLAMA_SIGNIN_REQUIRED`.

- [ ] **Step 1: Write the failing test**

Append to `src/features/onboarding/onboarding-service.test.ts`:

```ts
test("asks the reader to sign in when cloud mode finds no cloud model", async () => {
  const harness = createHarness({
    models: [{ id: "gemma3:4b", displayName: "gemma3:4b", origin: "local" }],
  });

  harness.port.send({ type: "list-models", mode: "ollama-cloud" });
  await harness.settled();

  expect(harness.port.sent.at(-1)).toMatchObject({
    type: "error",
    error: { code: "OLLAMA_SIGNIN_REQUIRED", recoverable: true },
  });
});

test("lists cloud models when the reader is signed in", async () => {
  const harness = createHarness({
    models: [
      { id: "gemma3:4b", displayName: "gemma3:4b", origin: "local" },
      { id: "gemma4:26b-cloud", displayName: "gemma4:26b-cloud", origin: "cloud" },
    ],
  });

  harness.port.send({ type: "list-models", mode: "ollama-cloud" });
  await harness.settled();

  expect(harness.port.sent.at(-1)).toMatchObject({
    type: "models",
    models: [{ id: "gemma4:26b-cloud" }],
  });
});
```

Match the harness and message names the existing file uses; if `list-models` carries no `mode` today, add the field to that message type as part of this task.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/features/onboarding/onboarding-service.test.ts -t "sign in"`
Expected: FAIL — the service returns all models and never emits `OLLAMA_SIGNIN_REQUIRED`.

- [ ] **Step 3: Add the error code**

In `src/core/requests/public-error.ts`, add `| "OLLAMA_SIGNIN_REQUIRED"` after `"OLLAMA_ORIGIN_BLOCKED"`.

- [ ] **Step 4: Filter and detect in the service**

In `src/features/onboarding/onboarding-service.ts`, where models are listed, filter by mode and report the empty cloud case:

```ts
const models = await this.provider.listModels(signal);
const offered =
  mode === "ollama-cloud"
    ? models.filter((model) => model.origin !== "local")
    : models.filter((model) => model.origin === "local");

if (mode === "ollama-cloud" && offered.length === 0) {
  throw new PublicError(
    "OLLAMA_SIGNIN_REQUIRED",
    "No Ollama Cloud models are available. Run `ollama signin`, then pull a cloud model.",
    true,
  );
}
```

- [ ] **Step 5: Add the guidance state**

In `src/features/onboarding/use-onboarding.ts`, add `| { step: "cloud-signin-guidance"; error: PublicErrorShape }` to `OnboardingState` and a matching action. Map it to milestone 2 by adding `case "cloud-signin-guidance":` alongside `case "origin-guidance":`. Route `OLLAMA_SIGNIN_REQUIRED` failures into it, and let the existing retry control re-dispatch the model listing, exactly as `origin-guidance` already does.

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run src/features/onboarding/onboarding-service.test.ts`
Expected: PASS, whole file.

- [ ] **Step 7: Run the full gate**

Run: `npm run check`
Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: guide the reader through Ollama sign-in when cloud mode is empty"
```

---

### Task 7: The mode screen and its disclosure

**Files:**

- Modify: `src/entrypoints/options/OptionsApp.tsx`
- Modify: `src/entrypoints/options/OptionsApp.test.tsx`
- Modify: `src/entrypoints/options/options.css`

**Interfaces:**

- Consumes: `chooseMode` from Task 5.

- [ ] **Step 1: Write the failing test**

Append to `src/entrypoints/options/OptionsApp.test.tsx`:

```ts
test("says plainly what each mode does with the reader's text", async () => {
  renderOptions({ state: { step: "choosing-mode" } });

  expect(screen.getByText(/does not leave your machine/i)).toBeVisible();
  expect(screen.getByText(/sent to Ollama's servers/i)).toBeVisible();
  // Non-retention is Ollama's claim, not a promise this project can make.
  expect(screen.getByText(/Ollama states/i)).toBeVisible();
});

test("offers the on-this-computer mode first", () => {
  renderOptions({ state: { step: "choosing-mode" } });

  const headings = screen.getAllByRole("heading", { level: 3 });
  expect(headings[0]).toHaveTextContent(/On this computer/i);
});
```

Use whatever render helper the file already defines instead of `renderOptions` if the name differs.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/entrypoints/options/OptionsApp.test.tsx -t "each mode"`
Expected: FAIL — no element matches `/does not leave your machine/i`.

- [ ] **Step 3: Build the mode step**

Add to `src/entrypoints/options/OptionsApp.tsx`, placing the component beside `ModelStep` and rendering it from the step switch for `"choosing-mode"`:

```tsx
function ModeStep({ controller }: { controller: OnboardingController }) {
  return (
    <StepFrame eyebrow="Step 2 of 4" heading="Choose how it runs">
      <div className="mode-option">
        <Laptop size={20} strokeWidth={1.9} aria-hidden="true" focusable="false" />
        <h3>On this computer</h3>
        <p>
          Your selected text does not leave your machine. Requires Ollama and a model,
          about 3.3 GB.
        </p>
        <button
          className="button button-primary"
          type="button"
          onClick={() => controller.chooseMode("ollama-local")}
        >
          Use this computer
        </button>
      </div>

      <div className="mode-option">
        <Cloud size={20} strokeWidth={1.9} aria-hidden="true" focusable="false" />
        <h3>Ollama Cloud</h3>
        <p>
          Your selected text is sent to Ollama&apos;s servers. Ollama states that it
          does not retain your data. Runs larger models with nothing to download.
        </p>
        <button
          className="button button-secondary"
          type="button"
          onClick={() => controller.chooseMode("ollama-cloud")}
        >
          Use Ollama Cloud
        </button>
      </div>
    </StepFrame>
  );
}
```

Import `Cloud` and `Laptop` from `lucide-react` alongside the icons already imported.

- [ ] **Step 4: Style the option cards**

In `src/entrypoints/options/options.css`, add a `.mode-option` rule following the spacing, radius and border tokens `.model-recommendation` already uses, so the two screens read as one design.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/entrypoints/options/OptionsApp.test.tsx`
Expected: PASS, whole file.

- [ ] **Step 6: Run the full gate**

Run: `npm run check`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: let the reader choose the mode and say what each one does"
```

---

### Task 8: Filter and annotate the model list

**Files:**

- Modify: `src/entrypoints/options/OptionsApp.tsx` (`ModelStep`)
- Modify: `src/entrypoints/options/OptionsApp.test.tsx`

**Interfaces:**

- Consumes: `ModelInfo.origin` from Task 1, `checkModeConsistency` from Task 3.

- [ ] **Step 1: Write the failing test**

Append to `src/entrypoints/options/OptionsApp.test.tsx`:

```ts
test("disables a cloud model while the on-this-computer mode is active", () => {
  renderOptions({
    state: {
      step: "choosing-model",
      models: [
        { id: "gemma3:4b", displayName: "gemma3:4b", origin: "local" },
        { id: "gemma4:26b-cloud", displayName: "gemma4:26b-cloud", origin: "cloud" },
      ],
    },
    preferences: { selectedProvider: "ollama-local" },
  });

  const cloudOption = screen.getByRole("option", { name: /gemma4:26b-cloud/i });
  expect(cloudOption).toBeDisabled();
  expect(cloudOption).toHaveAccessibleName(/runs in Ollama's cloud/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/entrypoints/options/OptionsApp.test.tsx -t "disables a cloud model"`
Expected: FAIL — the option renders enabled with no explanation.

- [ ] **Step 3: Annotate the options**

In `ModelStep`, compute each option's state from the gate rather than re-deriving the rule:

```tsx
{
  state.models.map((model) => {
    const consistency = checkModeConsistency(selectedProvider, model.origin);
    const blocked = consistency !== "ok";
    const reason =
      consistency === "cloud-model-in-local-mode"
        ? " — runs in Ollama's cloud"
        : consistency === "local-model-in-cloud-mode"
          ? " — runs on this computer"
          : "";
    return (
      <option key={model.id} value={model.id} disabled={blocked}>
        {model.displayName}
        {reason}
      </option>
    );
  });
}
```

Take `selectedProvider` from the preferences the component already receives; if `ModelStep` does not have them, pass them in from its caller rather than reading storage inside the component.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/entrypoints/options/OptionsApp.test.tsx`
Expected: PASS, whole file.

- [ ] **Step 5: Run the full gate**

Run: `npm run check`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: show why a model cannot be picked in the current mode"
```

---

### Task 9: Indeterminate progress for weightless pulls

**Files:**

- Modify: `src/entrypoints/options/OptionsApp.tsx` (the downloading step)
- Modify: `src/entrypoints/options/OptionsApp.test.tsx`

**Interfaces:**

- Consumes: `ModelDownloadEvent` from `src/providers/provider.ts`, unchanged.

- [ ] **Step 1: Write the failing test**

```ts
test("shows preparing rather than a percentage when a pull moves no bytes", () => {
  renderOptions({
    state: {
      step: "downloading",
      progress: { type: "progress", model: "gemma4:26b-cloud", completedBytes: 0 },
    },
  });

  expect(screen.getByText(/preparing/i)).toBeVisible();
  expect(screen.queryByText(/NaN/)).toBeNull();
  expect(screen.queryByText(/%/)).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/entrypoints/options/OptionsApp.test.tsx -t "moves no bytes"`
Expected: FAIL — the step renders `NaN%` or an empty percentage because `totalBytes` is absent.

- [ ] **Step 3: Handle the absent total**

In the downloading step, branch before computing a percentage:

```tsx
const total =
  state.progress.type === "progress" ? state.progress.totalBytes : undefined;
const indeterminate = total === undefined || total === 0;
```

Render the word `Preparing` and a progress element with no `value` when `indeterminate` is true, and the existing percentage otherwise.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/entrypoints/options/OptionsApp.test.tsx`
Expected: PASS, whole file.

- [ ] **Step 5: Run the full gate**

Run: `npm run check`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "fix: stop the download step computing a percentage of nothing"
```

---

### Task 10: Manifest guard and honest documentation

**Files:**

- Modify: `scripts/verify-manifest.test.ts`
- Modify: `README.md`
- Modify: `docs/privacy.md`

**Interfaces:**

- Consumes: `verifyManifest` from `scripts/verify-manifest.ts`, unchanged.

- [ ] **Step 1: Write the failing test**

Append to `scripts/verify-manifest.test.ts`:

```ts
test("rejects a hosted model API added to required host permissions", () => {
  const problems = verifyManifest({
    manifest_version: 3,
    minimum_chrome_version: 116,
    permissions: ["activeTab", "contextMenus", "scripting", "sidePanel", "storage"],
    host_permissions: [
      "http://127.0.0.1:11434/*",
      "https://generativelanguage.googleapis.com/*",
    ],
  });

  expect(problems).toContainEqual(
    expect.objectContaining({ check: "required-host-permissions" }),
  );
});
```

- [ ] **Step 2: Run test to verify it passes immediately**

Run: `npx vitest run scripts/verify-manifest.test.ts -t "hosted model API"`
Expected: PASS. `ALLOWED_REQUIRED_HOSTS` already rejects anything off loopback; this test pins that behaviour so a later task cannot loosen it silently. If it fails, the allowlist has drifted — restore it rather than adjusting the test.

- [ ] **Step 3: Make the README promise conditional**

In `README.md`, the unqualified claim that reading stays on this computer becomes mode-dependent. Replace it with:

```markdown
Where your reading goes depends on the mode you choose during setup.

| Mode             | Where your selected text goes                                  |
| ---------------- | -------------------------------------------------------------- |
| On this computer | Nowhere. The model runs locally through Ollama.                |
| Ollama Cloud     | To Ollama's servers. Ollama states that it does not retain it. |

The default is **On this computer**. Nothing changes mode without you choosing it in setup
or in Settings.
```

- [ ] **Step 4: Carry the same language into the privacy document**

In `docs/privacy.md`, apply the same distinction wherever the local-only guarantee is currently stated unconditionally, keeping the attribution wording for Ollama's non-retention claim.

- [ ] **Step 5: Run the full gate**

Run: `npm run check`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "docs: describe where reading goes in each mode"
```

---

### Task 11: A first-token budget that fits the mode

**Files:**

- Modify: `src/shared/constants.ts`
- Modify: `src/entrypoints/background.ts:101-110`
- Modify: `src/providers/ollama/ollama-provider.test.ts`

**Interfaces:**

- Consumes: `SelectedProvider` from Task 2.
- Produces: `firstTokenBudgetMs(mode: SelectedProvider): number`, exported from `src/shared/constants.ts`.

- [ ] **Step 1: Write the failing test**

Append to `src/providers/ollama/ollama-provider.test.ts`:

```ts
import { firstTokenBudgetMs } from "../../shared/constants";

describe("firstTokenBudgetMs", () => {
  // Locally the wait is model loading, measured at 30656 ms for a cold gemma3:4b. In the
  // cloud nothing loads, so the same budget would hide a stalled request for far too long.
  test("gives local mode room to load a model and cloud mode much less", () => {
    expect(firstTokenBudgetMs("ollama-local")).toBeGreaterThanOrEqual(45_000);
    expect(firstTokenBudgetMs("ollama-cloud")).toBeLessThan(
      firstTokenBudgetMs("ollama-local"),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/providers/ollama/ollama-provider.test.ts -t "firstTokenBudgetMs"`
Expected: FAIL — `firstTokenBudgetMs` is not exported from `src/shared/constants.ts`.

- [ ] **Step 3: Write the implementation**

Add to `src/shared/constants.ts`:

```ts
/**
 * Local inference pays for model loading before the first token; a cold gemma3:4b was
 * measured at 30656 ms on 2026-09-02, so the local budget must clear that with margin.
 * Cloud inference loads nothing, so a long budget there only delays reporting a stall.
 * The cloud figure is provisional until measured against a signed-in installation.
 */
export function firstTokenBudgetMs(mode: SelectedProvider): number {
  return mode === "ollama-local" ? 60_000 : 20_000;
}
```

Import `SelectedProvider` as a type from `../features/settings/settings`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/providers/ollama/ollama-provider.test.ts -t "firstTokenBudgetMs"`
Expected: PASS.

- [ ] **Step 5: Feed the budget from the chosen mode**

In `src/entrypoints/background.ts`, the provider is constructed once with a fixed `firstTokenTimeoutMs`. Pass the budget per request instead, reading the mode from the settings the coordinator already loads, so a mode change takes effect without rebuilding the provider. Keep the `E2E_STREAM_TIMEOUT_MS` override winning over both values, since the end-to-end package depends on it.

- [ ] **Step 6: Run the full gate**

Run: `npm run check`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: size the first-token wait to the mode that is running"
```

---

### Task 12: Changing mode from Settings

**Files:**

- Modify: `src/entrypoints/options/OptionsApp.tsx` (the settings step)
- Modify: `src/entrypoints/options/OptionsApp.test.tsx`

**Interfaces:**

- Consumes: `chooseMode` from Task 5, `checkModeConsistency` from Task 3.

- [ ] **Step 1: Write the failing test**

Append to `src/entrypoints/options/OptionsApp.test.tsx`:

```ts
test("sends the reader back to model choice when the mode invalidates their model", async () => {
  const { controller } = renderOptions({
    state: { step: "settings" },
    preferences: {
      selectedProvider: "ollama-cloud",
      selectedModel: "gemma4:26b-cloud",
    },
  });

  await userEvent.click(screen.getByRole("button", { name: /use this computer/i }));

  expect(controller.state.step).toBe("choosing-model");
  expect(screen.getByText(/runs in Ollama's cloud/i)).toBeVisible();
});

test("keeps the current model when it is still valid in the new mode", async () => {
  const { controller } = renderOptions({
    state: { step: "settings" },
    preferences: { selectedProvider: "ollama-cloud", selectedModel: "gemma3:4b" },
  });

  await userEvent.click(screen.getByRole("button", { name: /use this computer/i }));

  expect(controller.state.step).toBe("settings");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/entrypoints/options/OptionsApp.test.tsx -t "invalidates their model"`
Expected: FAIL — no mode control exists in the settings step.

- [ ] **Step 3: Add the mode control and revalidation**

Render the same two mode buttons inside the settings step. On change, write `selectedProvider`, re-list models, and run `checkModeConsistency` against the currently selected model. If the result is not `"ok"`, move to `choosing-model` so the reader picks a valid one; otherwise stay on settings. Reuse `ModeStep`'s copy rather than writing a second wording of the same disclosure.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/entrypoints/options/OptionsApp.test.tsx`
Expected: PASS, whole file.

- [ ] **Step 5: Run the full gate**

Run: `npm run check`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: revalidate the chosen model when the mode changes in Settings"
```

---

### Task 13: End-to-end coverage

**Files:**

- Modify: `tests/support/fake-ollama-server.ts:210-225`
- Create: `tests/e2e/mode-choice.spec.ts`

**Interfaces:**

- Consumes: every task above.

- [ ] **Step 1: Serve a cloud model from the fake server**

In `tests/support/fake-ollama-server.ts`, add a second entry to the `/api/tags` response beside the existing one:

```ts
{
  name: "gemma4:26b-cloud",
  model: "gemma4:26b-cloud",
  size: 0,
},
```

- [ ] **Step 2: Write the failing end-to-end test**

Create `tests/e2e/mode-choice.spec.ts`, following the fixture, launch and locator patterns in `tests/e2e/onboarding.spec.ts`:

```ts
import { expect, test } from "./e2e-fixture";

test("reaches cloud model choice through the mode screen", async ({ e2e }) => {
  const options = await e2e.openOptions();

  await expect(
    options.getByRole("heading", { name: "Choose how it runs" }),
  ).toBeVisible();
  await options.getByRole("button", { name: "Use Ollama Cloud" }).click();

  await expect(options.getByRole("option", { name: /gemma4:26b-cloud/ })).toBeEnabled();
});

test("keeps a cloud model unselectable in the on-this-computer mode", async ({
  e2e,
}) => {
  const options = await e2e.openOptions();

  await options.getByRole("button", { name: "Use this computer" }).click();

  await expect(
    options.getByRole("option", { name: /gemma4:26b-cloud/ }),
  ).toBeDisabled();
});

test("never claims the text stays on the machine while cloud mode is chosen", async ({
  e2e,
}) => {
  const options = await e2e.openOptions();

  await options.getByRole("button", { name: "Use Ollama Cloud" }).click();

  await expect(options.getByText(/does not leave your machine/i)).toHaveCount(0);
});
```

- [ ] **Step 3: Run the end-to-end tests**

Run: `npm run test:e2e -- mode-choice`
Expected: PASS, 3 tests. If existing specs now stop at the new mode screen, add the mode click to their setup helper rather than removing the screen.

- [ ] **Step 4: Run every end-to-end test**

Run: `npm run test:e2e`
Expected: PASS, all specs.

- [ ] **Step 5: Run the full gate**

Run: `npm run check`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "test: cover the mode choice end to end"
```

---

## Verification during implementation

The spec records three things that could not be settled without a signed-in Ollama. Confirm each while working, and record what was found in the task report:

1. Whether cloud models appear in `/api/tags`, and whether `size` is `0` or absent. If neither signal holds, the `-cloud` suffix stands alone — the direction of the decision does not change, because unknown already resolves toward cloud.
2. Ollama's real unauthenticated response, so `OLLAMA_SIGNIN_REQUIRED` can be narrowed from the empty-list heuristic in Task 6 to the actual failure.
3. Cloud first-token latency. Task 11 ships a provisional 20 second cloud budget derived from nothing but judgement. Replace it with a measured value once a signed-in installation is available, and record the measurement in the report.
