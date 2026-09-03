import {
  within,
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import type {
  OnboardingCommand,
  OnboardingEvent,
} from "../../features/onboarding/contracts";
import { DEFAULT_PREFERENCES } from "../../features/settings/settings";
import type { ReadingPreferences } from "../../features/settings/settings";
import type { OnboardingClientConnection } from "../../features/onboarding/use-onboarding";
import type {
  SettingsRepository,
  StoredSettings,
} from "../../platform/storage/settings-repository";
import { RECOMMENDED_CLOUD_MODEL, RECOMMENDED_MODEL } from "../../shared/constants";
import { DownloadStep, OptionsApp, type OptionsAppDependencies } from "./OptionsApp";

afterEach(cleanup);

class FakeClient implements OnboardingClientConnection {
  readonly sent: OnboardingCommand[] = [];
  private readonly listeners = new Set<(event: OnboardingEvent) => void>();
  private readonly disconnectListeners = new Set<() => void>();

  send(command: OnboardingCommand): void {
    this.sent.push(structuredClone(command));
  }

  subscribe(listener: (event: OnboardingEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeDisconnect(listener: () => void): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  disconnect(): void {}

  emit(event: OnboardingEvent): void {
    for (const listener of this.listeners) listener(structuredClone(event));
  }

  suspend(): void {
    for (const listener of this.disconnectListeners) listener();
  }
}

function storedSettings(onboardingVersion: 0 | 1 = 0): StoredSettings {
  return {
    onboardingVersion,
    preferences: {
      ...DEFAULT_PREFERENCES,
      preferredLanguage: "Dutch",
      blockedSites: [],
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function createHarness(overrides: Partial<OptionsAppDependencies> = {}) {
  const clients: FakeClient[] = [];
  const updates: Array<Partial<typeof DEFAULT_PREFERENCES>> = [];
  const settings = storedSettings();
  const settingsRepository: SettingsRepository = {
    async get() {
      return structuredClone(settings);
    },
    async update(patch) {
      updates.push(structuredClone(patch));
      settings.preferences = { ...settings.preferences, ...patch };
      return structuredClone(settings);
    },
    async markOnboardingComplete() {
      return structuredClone(settings);
    },
  };
  const readerAccess: OptionsAppDependencies["readerAccess"] = {
    async requestAutomaticAccess() {
      return false;
    },
    async registerAutomaticAccess() {},
    async disableAutomaticAccess() {},
  };
  const dependencies: OptionsAppDependencies = {
    createClient() {
      const client = new FakeClient();
      clients.push(client);
      return client;
    },
    settingsRepository,
    readerAccess,
    getUiLanguage: () => "Dutch",
    getOriginGuidance: () => ({
      origin: "chrome-extension://runtime-id",
      steps: [
        { kind: "text", text: "Configure OLLAMA_ORIGINS with this value:" },
        { kind: "code", text: "chrome-extension://runtime-id" },
      ],
    }),
    ...overrides,
  };
  render(<OptionsApp dependencies={dependencies} />);
  return {
    dependencies,
    clients,
    settings,
    updates,
    get client() {
      const client = clients.at(-1);
      if (!client) throw new Error("The onboarding client was not opened.");
      return client;
    },
  };
}

async function startRuntimeCheck(harness: ReturnType<typeof createHarness>) {
  await userEvent.click(await screen.findByRole("button", { name: /start setup/i }));
  await userEvent.click(
    await screen.findByRole("button", { name: /use this computer/i }),
  );
  expect(screen.getByRole("heading", { name: /checking ollama/i })).toBeVisible();
  await waitFor(() =>
    expect(harness.client.sent.at(-1)).toEqual({ type: "check-runtime" }),
  );
}

async function reachModelChoice(
  harness: ReturnType<typeof createHarness>,
  models: Extract<OnboardingEvent, { type: "models-result" }>["models"] = [],
) {
  await startRuntimeCheck(harness);
  act(() => {
    harness.client.emit({
      type: "runtime-result",
      health: { available: true, status: models.length ? "ready" : "model-required" },
    });
  });
  expect(harness.client.sent.at(-1)).toEqual({
    type: "list-models",
    mode: "ollama-local",
  });
  act(() => harness.client.emit({ type: "models-result", models }));
  expect(screen.getByRole("heading", { name: /choose a local model/i })).toBeVisible();
}

async function reachCloudModelChoice(
  harness: ReturnType<typeof createHarness>,
  models: Extract<OnboardingEvent, { type: "models-result" }>["models"] = [],
) {
  await userEvent.click(await screen.findByRole("button", { name: /start setup/i }));
  await userEvent.click(
    await screen.findByRole("button", { name: /use ollama cloud/i }),
  );
  act(() => {
    harness.client.emit({
      type: "runtime-result",
      health: { available: true, status: "ready" },
    });
  });
  expect(harness.client.sent.at(-1)).toEqual({
    type: "list-models",
    mode: "ollama-cloud",
  });
  act(() => harness.client.emit({ type: "models-result", models }));
  expect(screen.getByRole("heading", { name: /choose a cloud model/i })).toBeVisible();
}

async function reachPreferences(harness: ReturnType<typeof createHarness>) {
  await reachModelChoice(harness);
  await userEvent.click(
    screen.getByRole("button", { name: `Download ${RECOMMENDED_MODEL}` }),
  );
  act(() => {
    harness.client.emit({
      type: "download-progress",
      progress: { type: "completed", model: RECOMMENDED_MODEL },
    });
  });
  expect(
    screen.getByRole("heading", { name: /choose how explanations read/i }),
  ).toBeVisible();
}

/** Language, level, nearby context and page access all live on one screen now. */
async function reachPermission(harness: ReturnType<typeof createHarness>) {
  await reachPreferences(harness);
  const language = screen.getByRole("combobox", { name: /preferred language/i });
  expect(language).toHaveValue("Dutch");
  expect(
    screen.getByRole("checkbox", { name: /include nearby context/i }),
  ).not.toBeChecked();
  expect(
    screen.getByRole("checkbox", { name: /show the selection toolbar/i }),
  ).not.toBeChecked();
}

/** Submit the merged choices screen, leaving page access switched off. */
async function submitChoices() {
  await userEvent.click(screen.getByRole("button", { name: /confirm and continue/i }));
}

describe("options onboarding", () => {
  it("starts at Welcome and shows four setup milestones", async () => {
    createHarness();

    expect(
      await screen.findByRole("heading", { name: /set up explain this/i }),
    ).toBeVisible();
    expect(
      screen.getByRole("progressbar", { name: /setup progress/i }),
    ).toHaveAttribute("max", "4");
    // The mode isn't chosen yet at Welcome, so the milestone can't claim "Local" —
    // a reader who picks Ollama Cloud one screen later would see it proven wrong.
    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "1Welcome",
      "2Model",
      "3Preferences",
      "4Ready",
    ]);
  });

  // The rail and the state machine each had their own step mapping, and only one was
  // updated when the milestones changed, so the progress read "6 of 4".
  it("keeps the rail on the local-model milestone while choosing a model", async () => {
    const harness = createHarness();
    await reachModelChoice(harness);

    expect(screen.getByRole("progressbar", { name: /setup progress/i })).toHaveValue(2);
    expect(screen.getByText("2 of 4")).toBeVisible();
  });

  // The milestone label used to read "Local model" on every screen in every mode, so a
  // reader in cloud mode saw it contradict the "Choose a cloud model" heading right next
  // to it. It must track the mode actually chosen once one has been.
  it("labels the model milestone by the mode actually chosen", async () => {
    const localHarness = createHarness();
    await reachModelChoice(localHarness);
    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toContain(
      "2Local model",
    );

    cleanup();

    const cloudHarness = createHarness();
    await reachCloudModelChoice(cloudHarness, [
      {
        id: RECOMMENDED_CLOUD_MODEL,
        displayName: RECOMMENDED_CLOUD_MODEL,
        origin: "cloud",
      },
    ]);
    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toContain(
      "2Cloud model",
    );
    expect(
      screen.getAllByRole("listitem").map((item) => item.textContent),
    ).not.toContain("2Local model");
  });

  // Regression test for the race the milestone-label fix could reintroduce: chooseMode
  // dispatches the "mode" action (updating onboarding state) synchronously, but only
  // persists selectedProvider to settings after an awaited storage round trip. If the
  // label were still sourced from `preferences.selectedProvider` instead of
  // `state.mode`, it would read "Local model" for as long as that round trip is
  // pending. `userEvent.click` cannot observe this on its own — it awaits through
  // `act()` until every promise in the click settles, well past the persisted write —
  // so this test holds `settingsRepository.update()` open with an unresolved promise
  // and asserts the render that happens *before* resolving it.
  it("labels the model milestone from the mode choice itself, before the settings write resolves", async () => {
    const settings = storedSettings();
    const persistedUpdate = deferred<StoredSettings>();
    createHarness({
      settingsRepository: {
        async get() {
          return structuredClone(settings);
        },
        update() {
          // Never resolves during this test — the point is to inspect the render
          // while this promise is still pending.
          return persistedUpdate.promise;
        },
        async markOnboardingComplete() {
          return structuredClone(settings);
        },
      },
    });

    await userEvent.click(await screen.findByRole("button", { name: /start setup/i }));
    await userEvent.click(
      await screen.findByRole("button", { name: /use ollama cloud/i }),
    );

    // The command hasn't been sent yet either — chooseMode sends "check-runtime" only
    // after the settings write resolves — which independently confirms this assertion
    // really does land inside the pending window, not after it.
    expect(screen.getByRole("heading", { name: /checking ollama/i })).toBeVisible();
    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toContain(
      "2Cloud model",
    );
    expect(document.body.textContent).not.toMatch(/2local model/i);

    await act(async () => {
      persistedUpdate.resolve(structuredClone(settings));
    });
  });

  // A free-text language box meant guessing at spellings the model may not honour.
  it("offers every language as a picker and preselects the browser language", async () => {
    const harness = createHarness();
    await reachPreferences(harness);

    const picker = screen.getByRole("combobox", { name: /preferred language/i });
    expect(picker).toHaveValue("Dutch");
    expect(within(picker).getAllByRole("option").length).toBeGreaterThan(150);
    expect(
      within(picker).getByRole("option", { name: /^Turkish/ }),
    ).toBeInTheDocument();
  });

  // Language tags are not option values, so an unresolved one would silently select the
  // first language in the list. Existing installs have a tag stored from getUILanguage().
  it("resolves a stored language tag to the matching option", async () => {
    const stored = storedSettings();
    stored.preferences.preferredLanguage = "tr-TR";
    const harness = createHarness({
      settingsRepository: {
        async get() {
          return structuredClone(stored);
        },
        async update(patch) {
          stored.preferences = { ...stored.preferences, ...patch };
          return structuredClone(stored);
        },
        async markOnboardingComplete() {
          return structuredClone(stored);
        },
      },
    });
    await reachPreferences(harness);

    expect(screen.getByRole("combobox", { name: /preferred language/i })).toHaveValue(
      "Turkish",
    );
  });

  it("stores the chosen language by its English name", async () => {
    const harness = createHarness();
    await reachPreferences(harness);

    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: /preferred language/i }),
      "Turkish",
    );
    await submitChoices();

    expect(harness.client.sent.at(-1)).toMatchObject({
      type: "run-readiness",
      preferences: { preferredLanguage: "Turkish" },
    });
  });

  // Setup was a one-way street: a wrong model or level could only be undone by finishing.
  it("goes back from the model choice to the mode choice", async () => {
    const harness = createHarness();
    await reachModelChoice(harness);

    await userEvent.click(screen.getByRole("button", { name: /back/i }));

    expect(screen.getByRole("heading", { name: /choose how it runs/i })).toBeVisible();
  });

  it("goes back from preferences to the model choice", async () => {
    const harness = createHarness();
    await reachPreferences(harness);

    await userEvent.click(screen.getByRole("button", { name: /back/i }));

    expect(
      screen.getByRole("heading", { name: /choose a local model/i }),
    ).toBeVisible();
  });

  it("waits for settings hydration before mounting an incomplete setup form", async () => {
    const hydration = deferred<StoredSettings>();
    createHarness({
      settingsRepository: {
        get: () => hydration.promise,
        async update() {
          throw new Error("not used");
        },
        async markOnboardingComplete() {
          throw new Error("not used");
        },
      },
    });

    expect(screen.getByRole("status")).toHaveTextContent(/loading settings/i);
    expect(
      screen.queryByRole("heading", { name: /set up explain this/i }),
    ).not.toBeInTheDocument();

    await act(async () => hydration.resolve(storedSettings(0)));
    expect(screen.getByRole("heading", { name: /set up explain this/i })).toBeVisible();
  });

  it("opens completed onboarding in the settings experience without readiness output", async () => {
    createHarness({
      settingsRepository: {
        async get() {
          return storedSettings(1);
        },
        async update(patch) {
          return {
            ...storedSettings(1),
            preferences: { ...storedSettings(1).preferences, ...patch },
          };
        },
        async markOnboardingComplete() {
          return storedSettings(1);
        },
      },
    });

    expect(
      await screen.findByRole("heading", { name: /explanation settings/i }),
    ).toBeVisible();
    expect(screen.getByRole("textbox", { name: /blocked host/i })).toBeVisible();
    expect(document.body.textContent).not.toMatch(/tokens\/s|first response/i);
  });

  it("keeps diagnostic facts opaque and preserves trusted settings overrides", async () => {
    const hostile = new Proxy(
      {
        extensionVersion: "attacker-version",
        selectedModel: { name: "attacker-model" },
        automaticToolbar: true,
        onboardingVersion: 0,
      },
      {
        ownKeys() {
          throw new Error("hostile ownKeys trap");
        },
      },
    );

    let copiedReport = "";
    createHarness({
      settingsRepository: {
        async get() {
          return storedSettings(1);
        },
        async update(patch) {
          return {
            ...storedSettings(1),
            preferences: { ...storedSettings(1).preferences, ...patch },
          };
        },
        async markOnboardingComplete() {
          return storedSettings(1);
        },
      },
      getDiagnosticFacts: () => hostile,
      copyDiagnosticReport: async (report) => {
        copiedReport = report;
      },
    });

    expect(
      await screen.findByRole("heading", { name: /explanation settings/i }),
    ).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: /copy diagnostics/i }));
    expect(screen.getByRole("status")).toHaveTextContent(/copied/i);
    expect(JSON.parse(copiedReport)).toMatchObject({
      extensionVersion: "attacker-version",
      model: { name: RECOMMENDED_MODEL },
      permissions: { automaticToolbar: false },
      onboardingVersion: 1,
    });
  });

  it("falls back when diagnostic facts throw during retrieval", async () => {
    createHarness({
      settingsRepository: {
        async get() {
          return storedSettings(1);
        },
        async update(patch) {
          return {
            ...storedSettings(1),
            preferences: { ...storedSettings(1).preferences, ...patch },
          };
        },
        async markOnboardingComplete() {
          return storedSettings(1);
        },
      },
      getDiagnosticFacts: () => {
        throw new Error("private dependency failure");
      },
      copyDiagnosticReport: async () => undefined,
    });

    expect(
      await screen.findByRole("heading", { name: /explanation settings/i }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: /copy diagnostics/i })).toBeVisible();
  });

  it("shows checking, missing-runtime recovery, and only the official HTTPS installer", async () => {
    const harness = createHarness();
    await startRuntimeCheck(harness);

    act(() => {
      harness.client.emit({
        type: "runtime-result",
        health: {
          available: false,
          status: "unreachable",
          error: {
            code: "OLLAMA_UNREACHABLE",
            message: "Ollama is not running.",
            recoverable: true,
          },
        },
      });
    });

    expect(screen.getByRole("alert")).toHaveTextContent("Local model unavailable");
    expect(screen.getByRole("alert")).not.toHaveTextContent("Ollama is not running");
    const install = screen.getByRole("link", { name: /install ollama/i });
    expect(install).toHaveAttribute("href", "https://ollama.com/download");
    expect(install).toHaveAttribute("rel", expect.stringContaining("noopener"));
    await userEvent.click(screen.getByRole("button", { name: /check again/i }));
    expect(harness.client.sent.at(-1)).toEqual({ type: "check-runtime" });
  });

  it("renders exact-origin guidance as text and code", async () => {
    const harness = createHarness();
    await startRuntimeCheck(harness);

    act(() => {
      harness.client.emit({
        type: "runtime-result",
        health: {
          available: false,
          status: "origin-blocked",
          message: "Ollama rejected this extension origin.",
          secondaryAction: "show-origin-guidance",
        },
      });
    });

    expect(
      screen.getByRole("heading", { name: /allow this extension in ollama/i }),
    ).toBeVisible();
    expect(
      screen.getByText("chrome-extension://runtime-id", { selector: "code" }),
    ).toBeVisible();
    expect(document.body.textContent).not.toContain("chrome-extension://*");
  });

  it("preserves the runtime secondary action as an explicit guidance button", async () => {
    const harness = createHarness();
    await startRuntimeCheck(harness);

    act(() => {
      harness.client.emit({
        type: "runtime-result",
        health: {
          available: false,
          status: "unreachable",
          message: "Ollama could not be reached.",
          secondaryAction: "show-origin-guidance",
        },
      });
    });

    await userEvent.click(
      screen.getByRole("button", { name: /show exact-origin guidance/i }),
    );
    expect(
      screen.getByRole("heading", { name: /allow this extension in ollama/i }),
    ).toBeVisible();
    expect(
      screen.getByText("chrome-extension://runtime-id", { selector: "code" }),
    ).toBeVisible();
  });

  it("says plainly what each mode does with the reader's text", async () => {
    createHarness();
    await userEvent.click(await screen.findByRole("button", { name: /start setup/i }));

    expect(screen.getByText(/does not leave your machine/i)).toBeVisible();
    expect(screen.getByText(/sent to Ollama's servers/i)).toBeVisible();
    // Non-retention is Ollama's claim, not a promise this project can make.
    expect(screen.getByText(/Ollama states/i)).toBeVisible();
  });

  it("offers the on-this-computer mode first", async () => {
    createHarness();
    await userEvent.click(await screen.findByRole("button", { name: /start setup/i }));

    const headings = screen.getAllByRole("heading", { level: 3 });
    expect(headings[0]).toHaveTextContent(/On this computer/i);
  });

  // The reader is choosing between privacy and capability, not picking a recommended
  // option — a styling difference between the two buttons would put a thumb on the
  // scale even though the cards themselves are styled identically.
  it("gives the local and cloud buttons identical styling", async () => {
    createHarness();
    await userEvent.click(await screen.findByRole("button", { name: /start setup/i }));

    const localButton = screen.getByRole("button", { name: /use this computer/i });
    const cloudButton = screen.getByRole("button", { name: /use ollama cloud/i });
    expect(localButton.className).toBe(cloudButton.className);
  });

  it("shows both cloud sign-in commands and retries list-models with the mode intact", async () => {
    const harness = createHarness();
    await userEvent.click(await screen.findByRole("button", { name: /start setup/i }));
    await userEvent.click(
      await screen.findByRole("button", { name: /use ollama cloud/i }),
    );
    expect(harness.client.sent.at(-1)).toEqual({ type: "check-runtime" });

    act(() => {
      harness.client.emit({
        type: "runtime-result",
        health: { available: true, status: "ready" },
      });
    });
    expect(harness.client.sent.at(-1)).toEqual({
      type: "list-models",
      mode: "ollama-cloud",
    });

    act(() => {
      harness.client.emit({
        type: "onboarding-failed",
        error: {
          code: "OLLAMA_SIGNIN_REQUIRED",
          message:
            "No Ollama Cloud models are available. Run `ollama signin`, then pull a cloud model.",
          recoverable: true,
        },
      });
    });

    expect(
      screen.getByRole("heading", { name: /sign in to ollama cloud/i }),
    ).toBeVisible();
    expect(screen.getByText("ollama signin", { selector: "code" })).toBeVisible();
    expect(
      screen.getByText(`ollama pull ${RECOMMENDED_CLOUD_MODEL}`, { selector: "code" }),
    ).toBeVisible();

    const retryButton = screen.getByRole("button", { name: /check again/i });
    expect(retryButton).toBeVisible();
    await userEvent.click(retryButton);
    expect(harness.client.sent.at(-1)).toEqual({
      type: "list-models",
      mode: "ollama-cloud",
    });
  });

  it("shows the recommended model name and size before explicit download confirmation", async () => {
    const harness = createHarness();
    await reachModelChoice(harness);

    expect(screen.getByText(RECOMMENDED_MODEL)).toBeVisible();
    expect(screen.getByText(/approximately 3.3 GB/i)).toBeVisible();
    await userEvent.click(
      screen.getByRole("button", { name: `Download ${RECOMMENDED_MODEL}` }),
    );
    expect(harness.client.sent.at(-1)).toEqual({
      type: "download-model",
      model: RECOMMENDED_MODEL,
    });
  });

  it("labels code-specialized installed models and can use an installed model", async () => {
    const harness = createHarness();
    await reachModelChoice(harness, [
      {
        id: "qwen2.5-coder:7b",
        displayName: "qwen2.5-coder:7b · Code-specialized",
        sizeBytes: 4_700_000_000,
        origin: "local",
      },
    ]);

    expect(screen.getByText(/code-specialized/i)).toBeVisible();
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: /installed model/i }),
      "qwen2.5-coder:7b",
    );
    await userEvent.click(screen.getByRole("button", { name: /use installed model/i }));
    expect(
      screen.getByRole("heading", { name: /choose how explanations read/i }),
    ).toBeVisible();
  });

  it("disables a cloud model while the on-this-computer mode is active", async () => {
    const harness = createHarness();
    await reachModelChoice(harness, [
      { id: "gemma3:4b", displayName: "gemma3:4b", origin: "local" },
      { id: "gemma4:26b-cloud", displayName: "gemma4:26b-cloud", origin: "cloud" },
    ]);

    const localOption = screen.getByRole("option", { name: /^gemma3:4b$/i });
    expect(localOption).not.toBeDisabled();

    const cloudOption = screen.getByRole("option", { name: /gemma4:26b-cloud/i });
    expect(cloudOption).toBeDisabled();
    expect(cloudOption).toHaveAccessibleName(/runs in Ollama's cloud/i);
  });

  it("disables a local model while the Ollama Cloud mode is active", async () => {
    const harness = createHarness();
    await reachCloudModelChoice(harness, [
      { id: "gemma3:4b", displayName: "gemma3:4b", origin: "local" },
      {
        id: RECOMMENDED_CLOUD_MODEL,
        displayName: RECOMMENDED_CLOUD_MODEL,
        origin: "cloud",
      },
    ]);

    const localOption = screen.getByRole("option", { name: /gemma3:4b/i });
    expect(localOption).toBeDisabled();
    expect(localOption).toHaveAccessibleName(/runs on this computer/i);

    const cloudOption = screen.getByRole("option", {
      name: new RegExp(`^${RECOMMENDED_CLOUD_MODEL}$`, "i"),
    });
    expect(cloudOption).not.toBeDisabled();
  });

  it("does not claim the model step is local while cloud mode is active", async () => {
    const harness = createHarness();
    await reachCloudModelChoice(harness, [
      {
        id: RECOMMENDED_CLOUD_MODEL,
        displayName: RECOMMENDED_CLOUD_MODEL,
        origin: "cloud",
      },
    ]);

    const heading = screen.getByRole("heading", { name: /choose a cloud model/i });
    expect(heading).toBeVisible();
    expect(heading.textContent).not.toMatch(/local/i);
    expect(document.body.textContent).not.toMatch(/choose a local model/i);
  });

  it("does not claim the welcome screen or loading state are local before a mode is chosen", async () => {
    const hydration = deferred<StoredSettings>();
    createHarness({
      settingsRepository: {
        get: () => hydration.promise,
        async update() {
          throw new Error("not used");
        },
        async markOnboardingComplete() {
          throw new Error("not used");
        },
      },
    });

    expect(screen.getByRole("status")).toHaveTextContent(/loading settings/i);
    const loadingEyebrow = document.querySelector(".eyebrow");
    expect(loadingEyebrow?.textContent).not.toMatch(/local/i);
    expect(loadingEyebrow?.textContent).not.toMatch(/cloud/i);
    // The persistent sidebar renders even during hydration, so it must not promise
    // locality either, before the reader has had any chance to choose a mode.
    expect(document.body.textContent).not.toMatch(/stays on (this|your) computer/i);

    await act(async () => hydration.resolve(storedSettings(0)));
    const heading = screen.getByRole("heading", { name: /set up explain this/i });
    expect(heading).toBeVisible();
    expect(heading.textContent).not.toMatch(/local/i);
    expect(heading.textContent).not.toMatch(/cloud/i);
    expect(document.body.textContent).not.toMatch(/understand text locally/i);
    // The welcome screen's own body copy used to promise "Selected text goes only to
    // 127.0.0.1. No cloud account is required." — concrete and false the moment a
    // reader picks Ollama Cloud one screen later.
    expect(document.body.textContent).not.toMatch(/goes only to 127\.0\.0\.1/i);
    expect(document.body.textContent).not.toMatch(/no cloud account is required/i);
    expect(document.body.textContent).not.toMatch(/stays on (this|your) computer/i);
    // The welcome screen's own call-to-action button used to read "Start local
    // setup" — one unconditional "local" on the one screen that precedes the mode
    // choice.
    expect(screen.getByRole("button", { name: /start setup/i })).not.toHaveTextContent(
      /local/i,
    );
  });

  // The controller ruling behind this task: with cloud mode active, no rendered
  // options screen may claim the reader's text stays on this computer. A prior task
  // scoped its equivalent check to a single element specifically because the
  // persistent sidebar still failed a document-wide assertion — this test is the one
  // that makes that document-wide assertion possible, and it walks every reachable
  // screen in cloud mode to prove it.
  it("never claims the reading stays on this computer anywhere while cloud mode is active", async () => {
    const cloudModel = {
      id: RECOMMENDED_CLOUD_MODEL,
      displayName: RECOMMENDED_CLOUD_MODEL,
      origin: "cloud" as const,
    };
    const noLocalityClaim = /stays on (this|your) computer/i;
    const harness = createHarness();

    await reachCloudModelChoice(harness, [cloudModel]);
    expect(document.body.textContent).not.toMatch(noLocalityClaim);
    // The rail's step-2 milestone used to read "Local model" unconditionally, right next
    // to a "Choose a cloud model" heading in this exact state.
    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toContain(
      "2Cloud model",
    );
    expect(document.body.textContent).not.toMatch(/2local model/i);

    await userEvent.click(
      screen.getByRole("button", { name: `Use ${RECOMMENDED_CLOUD_MODEL}` }),
    );
    expect(
      screen.getByRole("heading", { name: /choose how explanations read/i }),
    ).toBeVisible();
    expect(document.body.textContent).not.toMatch(noLocalityClaim);
    expect(screen.getByText(/goes to the cloud model/i)).toBeVisible();

    await submitChoices();
    expect(
      screen.getByRole("heading", { name: /testing your cloud model/i }),
    ).toBeVisible();
    expect(document.body.textContent).not.toMatch(noLocalityClaim);

    act(() => {
      harness.client.emit({
        type: "readiness-result",
        result: {
          status: "ready",
          firstTokenMs: 900,
          tokensPerSecond: 18,
          warnings: [],
        },
      });
    });
    expect(screen.getByRole("heading", { name: /^ready$/i })).toBeVisible();
    expect(screen.getByText(/your cloud model is ready/i)).toBeVisible();
    expect(screen.getByText(/read the cloud explanation/i)).toBeVisible();
    expect(document.body.textContent).not.toMatch(noLocalityClaim);
    expect(document.body.textContent).not.toMatch(/your local model is ready/i);

    await userEvent.click(screen.getByRole("button", { name: /finish setup/i }));
    harness.settings.onboardingVersion = 1;
    act(() => harness.client.emit({ type: "onboarding-complete" }));

    expect(
      screen.getByRole("heading", { name: /explanation settings/i }),
    ).toBeVisible();
    expect(
      screen.getByRole("heading", { name: /^cloud model$/i, level: 3 }),
    ).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: /^local model$/i, level: 3 }),
    ).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(noLocalityClaim);
  });

  it("reports byte progress and exposes cancellation as a keyboard-operable button", async () => {
    const harness = createHarness();
    await reachModelChoice(harness);
    await userEvent.click(
      screen.getByRole("button", { name: `Download ${RECOMMENDED_MODEL}` }),
    );
    act(() => {
      harness.client.emit({
        type: "download-progress",
        progress: {
          type: "progress",
          model: RECOMMENDED_MODEL,
          completedBytes: 1_250_000_000,
          totalBytes: 2_500_000_000,
        },
      });
    });

    expect(
      screen.getByRole("heading", { name: /downloading the local model/i }),
    ).toBeVisible();
    expect(screen.getByRole("progressbar", { name: /model download/i })).toHaveValue(
      1_250_000_000,
    );
    expect(screen.getByText(/1.25 GB of 2.50 GB/i)).toBeVisible();
    const cancel = screen.getByRole("button", { name: /cancel download/i });
    cancel.focus();
    await userEvent.keyboard("{Enter}");
    expect(harness.client.sent.at(-1)).toEqual({ type: "cancel-download" });
    expect(screen.getByRole("progressbar", { name: /setup progress/i })).toHaveValue(2);
  });

  // A cloud pull moves no weights across the network, so Ollama reports a `total` of 0
  // rather than omitting it. That must read as "preparing", not as a 0-of-0 progress bar.
  it("shows preparing rather than a percentage when a pull moves no bytes", async () => {
    const harness = createHarness();
    await reachModelChoice(harness);
    await userEvent.click(
      screen.getByRole("button", { name: `Download ${RECOMMENDED_MODEL}` }),
    );
    act(() => {
      harness.client.emit({
        type: "download-progress",
        progress: {
          type: "progress",
          model: RECOMMENDED_MODEL,
          completedBytes: 0,
          totalBytes: 0,
        },
      });
    });

    expect(screen.getByText(/preparing/i)).toBeVisible();
    expect(screen.queryByText(/NaN/)).toBeNull();
    expect(screen.queryByText(/%/)).toBeNull();
  });

  // The other branch of the same guard: a pull that omits `totalBytes` entirely, rather
  // than reporting it as 0, must also read as "preparing" rather than a stuck bar.
  it("shows preparing when a pull's progress event omits totalBytes entirely", async () => {
    const harness = createHarness();
    await reachModelChoice(harness);
    await userEvent.click(
      screen.getByRole("button", { name: `Download ${RECOMMENDED_MODEL}` }),
    );
    act(() => {
      harness.client.emit({
        type: "download-progress",
        progress: {
          type: "progress",
          model: RECOMMENDED_MODEL,
          completedBytes: 0,
        },
      });
    });

    expect(screen.getByText(/preparing/i)).toBeVisible();
    expect(screen.queryByText(/NaN/)).toBeNull();
    expect(screen.queryByText(/%/)).toBeNull();
  });

  // DownloadStep is a pure function of its props. The onboarding flow cannot currently
  // reach the "downloading" step in Ollama Cloud mode — ModelStep only calls
  // downloadModel once a cloud model is already installed, at which point it calls
  // useInstalledModel instead — but that gating is incidental to the current UI wiring,
  // not a guarantee, and the component already branches its copy on selectedProvider.
  // Render it directly so a swapped ternary in the cloud copy cannot go untested.
  it("uses cloud-mode copy when DownloadStep renders for Ollama Cloud", () => {
    render(
      <DownloadStep
        onCancel={() => {}}
        selectedProvider="ollama-cloud"
        state={{
          step: "downloading",
          mode: "ollama-cloud",
          progress: {
            type: "progress",
            model: RECOMMENDED_CLOUD_MODEL,
            completedBytes: 0,
          },
        }}
      />,
    );

    expect(
      screen.getByRole("heading", { name: /^downloading the model$/i }),
    ).toBeVisible();
    expect(screen.getByText(/^preparing$/i)).toBeVisible();
    expect(screen.getByText(/ollama runs this model in its cloud/i)).toBeVisible();
    expect(document.body.textContent).not.toMatch(/preparing local download/i);
    expect(document.body.textContent).not.toMatch(
      /ollama stores this model on your computer/i,
    );
  });

  it("moves keyboard focus to the active step heading after a transition", async () => {
    const harness = createHarness();

    await startRuntimeCheck(harness);

    expect(screen.getByRole("heading", { name: /checking ollama/i })).toHaveFocus();
  });

  it("requires language confirmation and keeps both privacy choices off by default", async () => {
    const harness = createHarness();
    await reachPreferences(harness);

    expect(screen.getByRole("combobox", { name: /preferred language/i })).toHaveValue(
      "Dutch",
    );
    expect(screen.getByRole("radio", { name: /everyday/i })).toBeChecked();
    expect(
      screen.getByRole("checkbox", { name: /include nearby context/i }),
    ).not.toBeChecked();
    expect(
      screen.getByRole("checkbox", { name: /show the selection toolbar/i }),
    ).not.toBeChecked();
    expect(screen.getByText(/needs optional access to ordinary pages/i)).toBeVisible();
  });

  it("requests page permission directly from Enable and carries denial into readiness", async () => {
    const permission = deferred<{ granted: boolean }>();
    let permissionCalls = 0;
    const harness = createHarness({
      readerAccess: {
        requestAutomaticAccess() {
          permissionCalls += 1;
          return permission.promise.then(({ granted }) => granted);
        },
        async registerAutomaticAccess() {},
        async disableAutomaticAccess() {},
      },
    });
    await reachPermission(harness);

    fireEvent.click(
      screen.getByRole("checkbox", { name: /show the selection toolbar/i }),
    );
    expect(permissionCalls).toBe(1);
    await act(async () => permission.resolve({ granted: false }));
    await submitChoices();

    expect(
      screen.getByRole("heading", { name: /testing your local model/i }),
    ).toBeVisible();
    expect(screen.getByText(/context menu or keyboard shortcut/i)).toBeVisible();
    expect(harness.client.sent.at(-1)).toMatchObject({
      type: "run-readiness",
      preferences: { automaticToolbar: false, includeNearbyContext: false },
    });
  });

  it("persists granted consent immediately before registering the automatic reader", async () => {
    const order: string[] = [];
    const settings = storedSettings(0);
    const permissionAccess = {
      async enableAutomaticAccess() {
        order.push("request", "register");
        return { granted: true };
      },
      requestAutomaticAccess() {
        order.push("request");
        return Promise.resolve(true);
      },
      async registerAutomaticAccess() {
        order.push("register");
      },
      async disableAutomaticAccess() {
        order.push("cleanup");
      },
    };
    const harness = createHarness({
      readerAccess: permissionAccess,
      settingsRepository: {
        async get() {
          return structuredClone(settings);
        },
        async update(patch) {
          if (Object.hasOwn(patch, "automaticToolbar")) {
            order.push(`persist:${String(patch.automaticToolbar)}`);
          }
          settings.preferences = { ...settings.preferences, ...patch };
          return structuredClone(settings);
        },
        async markOnboardingComplete() {
          return structuredClone(settings);
        },
      },
    });
    await reachPermission(harness);

    await userEvent.click(
      screen.getByRole("checkbox", { name: /show the selection toolbar/i }),
    );
    await submitChoices();
    await screen.findByRole("heading", { name: /testing your local model/i });

    expect(order).toEqual(["request", "persist:true", "register"]);
  });

  it("persists denial as false and removes pre-existing automatic access", async () => {
    const order: string[] = [];
    let automaticAccess = true;
    const settings = storedSettings(0);
    const permissionAccess = {
      async enableAutomaticAccess() {
        order.push("request");
        return { granted: false };
      },
      requestAutomaticAccess() {
        order.push("request");
        return Promise.resolve(false);
      },
      async registerAutomaticAccess() {
        order.push("register");
      },
      async disableAutomaticAccess() {
        order.push("cleanup");
        automaticAccess = false;
      },
    };
    const harness = createHarness({
      readerAccess: permissionAccess,
      settingsRepository: {
        async get() {
          return structuredClone(settings);
        },
        async update(patch) {
          if (Object.hasOwn(patch, "automaticToolbar")) {
            order.push(`persist:${String(patch.automaticToolbar)}`);
          }
          settings.preferences = { ...settings.preferences, ...patch };
          return structuredClone(settings);
        },
        async markOnboardingComplete() {
          return structuredClone(settings);
        },
      },
    });
    await reachPermission(harness);

    await userEvent.click(
      screen.getByRole("checkbox", { name: /show the selection toolbar/i }),
    );
    await submitChoices();
    await screen.findByRole("heading", { name: /testing your local model/i });

    expect(order).toEqual(["request", "persist:false", "cleanup"]);
    expect(automaticAccess).toBe(false);
  });

  it("persists Not now as false and removes pre-existing automatic access", async () => {
    const order: string[] = [];
    let automaticAccess = true;
    const settings = storedSettings(0);
    const harness = createHarness({
      readerAccess: {
        requestAutomaticAccess() {
          order.push("request");
          return Promise.resolve(true);
        },
        async registerAutomaticAccess() {
          order.push("register");
        },
        async disableAutomaticAccess() {
          order.push("cleanup");
          automaticAccess = false;
        },
      },
      settingsRepository: {
        async get() {
          return structuredClone(settings);
        },
        async update(patch) {
          if (Object.hasOwn(patch, "automaticToolbar")) {
            order.push(`persist:${String(patch.automaticToolbar)}`);
          }
          settings.preferences = { ...settings.preferences, ...patch };
          return structuredClone(settings);
        },
        async markOnboardingComplete() {
          return structuredClone(settings);
        },
      },
    });
    await reachPermission(harness);

    await submitChoices();
    await screen.findByRole("heading", { name: /testing your local model/i });

    expect(order).toEqual(["persist:false", "cleanup"]);
    expect(automaticAccess).toBe(false);
    expect(harness.client.sent.at(-1)).toMatchObject({
      type: "run-readiness",
      preferences: { automaticToolbar: false },
    });
  });

  it.each(["persistence", "registration"] as const)(
    "rolls back consent and access when %s fails",
    async (failurePoint) => {
      const order: string[] = [];
      const settings = storedSettings(0);
      const permissionAccess = {
        async enableAutomaticAccess() {
          order.push("request", "register");
          return { granted: true };
        },
        requestAutomaticAccess() {
          order.push("request");
          return Promise.resolve(true);
        },
        async registerAutomaticAccess() {
          order.push("register");
          if (failurePoint === "registration") throw new Error("register failed");
        },
        async disableAutomaticAccess() {
          order.push("cleanup");
        },
      };
      const harness = createHarness({
        readerAccess: permissionAccess,
        settingsRepository: {
          async get() {
            return structuredClone(settings);
          },
          async update(patch) {
            order.push(`persist:${String(patch.automaticToolbar)}`);
            if (failurePoint === "persistence") {
              throw new Error("persist failed");
            }
            settings.preferences = { ...settings.preferences, ...patch };
            return structuredClone(settings);
          },
          async markOnboardingComplete() {
            return structuredClone(settings);
          },
        },
      });
      await reachPermission(harness);

      await userEvent.click(
        screen.getByRole("checkbox", { name: /show the selection toolbar/i }),
      );
      await submitChoices();
      await screen.findByRole("heading", { name: /testing your local model/i });

      expect(order.at(-2)).toBe("persist:false");
      expect(order.at(-1)).toBe("cleanup");
      expect(harness.client.sent.at(-1)).toMatchObject({
        type: "run-readiness",
        preferences: { automaticToolbar: false },
      });
    },
  );

  it("reports readiness warnings and persists preferences without private or generated content", async () => {
    const harness = createHarness();
    await reachPermission(harness);
    await submitChoices();

    act(() => {
      harness.client.emit({
        type: "readiness-result",
        result: {
          status: "warning",
          firstTokenMs: 31_000,
          tokensPerSecond: 4.5,
          warnings: ["slow-first-token", "slow-generation"],
        },
      });
    });

    expect(screen.getByRole("heading", { name: /^ready$/i })).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent(/slower than recommended/i);
    await userEvent.click(screen.getByRole("button", { name: /finish setup/i }));
    const completion = harness.client.sent.at(-1);
    expect(completion).toMatchObject({
      type: "complete-onboarding",
      preferences: {
        preferredLanguage: "Dutch",
        automaticToolbar: false,
        includeNearbyContext: false,
      },
    });
    expect(JSON.stringify(completion)).not.toMatch(
      /prompt|selectedText|selected text|readiness|output/i,
    );
  });

  it("shows recoverable failures with a retry that repeats the interrupted action", async () => {
    const harness = createHarness();
    await startRuntimeCheck(harness);
    act(() => {
      harness.client.emit({
        type: "onboarding-failed",
        error: {
          code: "PROVIDER_ERROR",
          message: "The local check was interrupted.",
          recoverable: true,
        },
      });
    });

    expect(screen.getByRole("alert")).toHaveTextContent("Model could not finish");
    expect(screen.getByRole("alert")).not.toHaveTextContent(
      "The local check was interrupted",
    );
    await userEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(harness.client.sent.at(-1)).toEqual({ type: "check-runtime" });
  });

  it("offers the existing no-access continuation only for a permission denial", async () => {
    const harness = createHarness();
    await startRuntimeCheck(harness);
    act(() => {
      harness.client.emit({
        type: "onboarding-failed",
        error: {
          code: "PAGE_PERMISSION_DENIED",
          message: "private browser permission detail",
          recoverable: true,
        },
      });
    });

    expect(screen.getByRole("alert")).toHaveTextContent("Page access was not allowed");
    expect(screen.getByRole("alert")).not.toHaveTextContent(
      "private browser permission detail",
    );
    await userEvent.click(
      screen.getByRole("button", { name: /continue without automatic access/i }),
    );
    expect(harness.client.sent.at(-1)).toMatchObject({
      type: "run-readiness",
      preferences: { automaticToolbar: false },
    });
  });

  it("reconnects and safely resumes the active command after worker suspension", async () => {
    const harness = createHarness();
    await startRuntimeCheck(harness);
    act(() => harness.client.suspend());

    await waitFor(() => expect(harness.clients).toHaveLength(2));
    expect(harness.client.sent).toEqual([{ type: "check-runtime" }]);
    expect(screen.getByRole("heading", { name: /checking ollama/i })).toBeVisible();
  });

  it("offers one blocked-host editor only after setup is saved", async () => {
    const harness = createHarness();
    await reachPermission(harness);
    await submitChoices();
    act(() => {
      harness.client.emit({
        type: "readiness-result",
        result: {
          status: "ready",
          firstTokenMs: 900,
          tokensPerSecond: 18,
          warnings: [],
        },
      });
    });

    expect(
      screen.queryByRole("textbox", { name: /blocked host/i }),
    ).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /finish setup/i }));
    const completion = harness.client.sent.at(-1);
    expect(completion).toMatchObject({
      type: "complete-onboarding",
      preferences: { blockedSites: [] },
    });
    harness.settings.onboardingVersion = 1;
    act(() => harness.client.emit({ type: "onboarding-complete" }));

    await userEvent.type(
      screen.getByRole("textbox", { name: /blocked host/i }),
      "news.example",
    );
    await userEvent.click(screen.getByRole("button", { name: /add blocked host/i }));
    await waitFor(() =>
      expect(harness.updates).toContainEqual({ blockedSites: ["news.example"] }),
    );
    expect(completion).toMatchObject({ preferences: { blockedSites: [] } });
    expect(JSON.stringify(harness.updates)).not.toMatch(
      /prompt|selectedText|selected text|readiness|output/i,
    );

    cleanup();
    render(<OptionsApp dependencies={harness.dependencies} />);
    expect(
      await screen.findByRole("heading", { name: /explanation settings/i }),
    ).toBeVisible();
    expect(screen.getByText("news.example", { selector: "code" })).toBeVisible();
  });

  // Everything chosen during onboarding used to be frozen: the settings screen offered
  // only blocked hosts and diagnostics, with no way to see or change a preference again.
  async function reachSettings(harness: ReturnType<typeof createHarness>) {
    await reachPermission(harness);
    await submitChoices();
    act(() => {
      harness.client.emit({
        type: "readiness-result",
        result: {
          status: "ready",
          firstTokenMs: 900,
          tokensPerSecond: 18,
          warnings: [],
        },
      });
    });
    await userEvent.click(screen.getByRole("button", { name: /finish setup/i }));
    harness.settings.onboardingVersion = 1;
    act(() => harness.client.emit({ type: "onboarding-complete" }));
  }

  it("shows the saved reading preferences on the settings screen", async () => {
    const harness = createHarness();
    await reachSettings(harness);

    expect(
      screen.getByRole("heading", { name: /explanation settings/i }),
    ).toBeVisible();
    expect(screen.getByRole("radio", { name: /Everyday:/ })).toBeChecked();
    expect(screen.getByRole("combobox", { name: /explanation language/i })).toHaveValue(
      "Dutch",
    );
    expect(
      screen.getByRole("checkbox", { name: /include nearby context/i }),
    ).toBeVisible();
    expect(
      screen.getByRole("checkbox", { name: /show the selection toolbar/i }),
    ).not.toBeChecked();
  });

  it("changes the explanation level from settings", async () => {
    const harness = createHarness();
    await reachSettings(harness);

    await userEvent.click(screen.getByRole("radio", { name: /Technical:/ }));

    await waitFor(() =>
      expect(harness.updates).toContainEqual({ explanationLevel: "technical" }),
    );
  });

  it("changes the explanation language from settings", async () => {
    const harness = createHarness();
    await reachSettings(harness);

    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: /explanation language/i }),
      "Turkish",
    );

    await waitFor(() =>
      expect(harness.updates).toContainEqual({ preferredLanguage: "Turkish" }),
    );
  });

  it("turns nearby context on from settings", async () => {
    const harness = createHarness();
    await reachSettings(harness);

    await userEvent.click(
      screen.getByRole("checkbox", { name: /include nearby context/i }),
    );

    await waitFor(() =>
      expect(harness.updates).toContainEqual({ includeNearbyContext: true }),
    );
  });

  // The optional origin must be requested inside the click, exactly as onboarding does.
  it("requests page access when the selection toolbar is switched on", async () => {
    let requested = 0;
    const harness = createHarness({
      readerAccess: {
        async requestAutomaticAccess() {
          requested += 1;
          return true;
        },
        async registerAutomaticAccess() {},
        async disableAutomaticAccess() {},
      },
    });
    await reachSettings(harness);

    await userEvent.click(
      screen.getByRole("checkbox", { name: /show the selection toolbar/i }),
    );

    await waitFor(() => expect(requested).toBe(1));
    await waitFor(() =>
      expect(harness.updates).toContainEqual({ automaticToolbar: true }),
    );
  });

  it("keeps the toolbar off and revokes access when the request is denied", async () => {
    let disabled = 0;
    const harness = createHarness({
      readerAccess: {
        async requestAutomaticAccess() {
          return false;
        },
        async registerAutomaticAccess() {},
        async disableAutomaticAccess() {
          disabled += 1;
        },
      },
    });
    await reachSettings(harness);
    const beforeSettings = disabled;

    await userEvent.click(
      screen.getByRole("checkbox", { name: /show the selection toolbar/i }),
    );

    await waitFor(() => expect(disabled).toBe(beforeSettings + 1));
    await waitFor(() =>
      expect(harness.updates).toContainEqual({ automaticToolbar: false }),
    );
  });

  it("re-enters setup so the model and connection can be changed", async () => {
    const harness = createHarness();
    await reachSettings(harness);

    await userEvent.click(screen.getByRole("button", { name: /run setup again/i }));

    expect(harness.client.sent.at(-1)).toEqual({ type: "check-runtime" });
    expect(screen.getByRole("heading", { name: /checking ollama/i })).toBeVisible();
  });

  // Changing mode from Settings. Reaches "settings" directly (a returning, completed
  // install) with a chosen provider/model baked into storage, rather than walking the
  // full onboarding flow — the file's existing render helper (createHarness) with a
  // custom settingsRepository stands in for the plan's `renderOptions({ state, preferences })`
  // pseudocode, which this codebase never defines.
  function reachSettingsWithPreferences(preferencesPatch: Partial<ReadingPreferences>) {
    const stored = storedSettings(1);
    stored.preferences = { ...stored.preferences, ...preferencesPatch };
    const settingsUpdates: Array<Partial<ReadingPreferences>> = [];
    const harness = createHarness({
      settingsRepository: {
        async get() {
          return structuredClone(stored);
        },
        async update(patch) {
          settingsUpdates.push(structuredClone(patch));
          stored.preferences = { ...stored.preferences, ...patch };
          return structuredClone(stored);
        },
        async markOnboardingComplete() {
          return structuredClone(stored);
        },
      },
    });
    return { harness, settingsUpdates };
  }

  it("sends the reader back to model choice when the mode invalidates their model", async () => {
    const { harness, settingsUpdates } = reachSettingsWithPreferences({
      selectedProvider: "ollama-cloud",
      selectedModel: "gemma4:26b-cloud",
    });
    expect(
      await screen.findByRole("heading", { name: /explanation settings/i }),
    ).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: /use this computer/i }));

    await waitFor(() =>
      expect(settingsUpdates).toContainEqual({ selectedProvider: "ollama-local" }),
    );
    await waitFor(() =>
      expect(harness.client.sent.at(-1)).toEqual({
        type: "list-models",
        mode: "ollama-local",
      }),
    );
    act(() => {
      harness.client.emit({
        type: "models-result",
        models: [
          { id: "gemma3:4b", displayName: "gemma3:4b", origin: "local" },
          { id: "gemma4:26b-cloud", displayName: "gemma4:26b-cloud", origin: "cloud" },
        ],
      });
    });

    expect(
      screen.getByRole("heading", { name: /choose a local model/i }),
    ).toBeVisible();
    expect(screen.getByText(/runs in Ollama's cloud/i)).toBeVisible();
  });

  it("keeps the current model when it is still valid in the new mode", async () => {
    const { harness, settingsUpdates } = reachSettingsWithPreferences({
      selectedProvider: "ollama-cloud",
      selectedModel: "gemma3:4b",
    });
    expect(
      await screen.findByRole("heading", { name: /explanation settings/i }),
    ).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: /use this computer/i }));

    await waitFor(() =>
      expect(settingsUpdates).toContainEqual({ selectedProvider: "ollama-local" }),
    );
    await waitFor(() =>
      expect(harness.client.sent.at(-1)).toEqual({
        type: "list-models",
        mode: "ollama-local",
      }),
    );
    act(() => {
      harness.client.emit({
        type: "models-result",
        models: [{ id: "gemma3:4b", displayName: "gemma3:4b", origin: "local" }],
      });
    });

    expect(
      screen.getByRole("heading", { name: /explanation settings/i }),
    ).toBeVisible();
  });

  // The onboarding service raises OLLAMA_SIGNIN_REQUIRED (not an empty models list) when
  // cloud mode finds no cloud-origin model. Switching mode from Settings must route to the
  // existing sign-in guidance screen instead of leaving the reader on a blank picker.
  it("routes to cloud sign-in guidance rather than an empty picker when no cloud model is available", async () => {
    const { harness, settingsUpdates } = reachSettingsWithPreferences({
      selectedProvider: "ollama-local",
      selectedModel: RECOMMENDED_MODEL,
    });
    expect(
      await screen.findByRole("heading", { name: /explanation settings/i }),
    ).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: /use ollama cloud/i }));

    await waitFor(() =>
      expect(settingsUpdates).toContainEqual({ selectedProvider: "ollama-cloud" }),
    );
    await waitFor(() =>
      expect(harness.client.sent.at(-1)).toEqual({
        type: "list-models",
        mode: "ollama-cloud",
      }),
    );
    act(() => {
      harness.client.emit({
        type: "onboarding-failed",
        error: {
          code: "OLLAMA_SIGNIN_REQUIRED",
          message:
            "No Ollama Cloud models are available. Run `ollama signin`, then pull a cloud model.",
          recoverable: true,
        },
      });
    });

    expect(
      screen.getByRole("heading", { name: /sign in to ollama cloud/i }),
    ).toBeVisible();
  });

  // Interleaved-command coverage. OnboardingService keeps one active operation per port
  // and silently drops a superseded command's response, so a Settings mode change whose
  // persist write is still in flight when another command goes out must never leave the
  // reader on a screen with no way forward. `reachSettingsWithDeferredUpdates` holds each
  // settingsRepository.update() open until the test explicitly resolves it, so a second
  // action can be injected into that window on purpose.
  function reachSettingsWithDeferredUpdates(
    preferencesPatch: Partial<ReadingPreferences>,
  ) {
    const stored = storedSettings(1);
    stored.preferences = { ...stored.preferences, ...preferencesPatch };
    const pending: Array<{
      patch: Partial<ReadingPreferences>;
      resolve: (settings: StoredSettings) => void;
    }> = [];
    const harness = createHarness({
      settingsRepository: {
        async get() {
          return structuredClone(stored);
        },
        update(patch) {
          return new Promise<StoredSettings>((resolve) => {
            pending.push({ patch: structuredClone(patch), resolve });
          });
        },
        async markOnboardingComplete() {
          return structuredClone(stored);
        },
      },
    });
    function resolveNext(index: number): void {
      const entry = pending[index];
      if (!entry) throw new Error(`no pending settings update at index ${index}`);
      stored.preferences = { ...stored.preferences, ...entry.patch };
      entry.resolve(structuredClone(stored));
    }
    return { harness, pending, resolveNext };
  }

  it("still reaches a model picker when another command interleaves before mode revalidation resolves", async () => {
    // selectedModel is deliberately a local-origin model that stays valid under the
    // mode being switched to ("ollama-local"): the eventual consistency check comes back
    // "ok", which is exactly the case an unguarded ref would answer with "stay put" —
    // silently leaving the reader on whatever step the intervening command left them on.
    const { harness, resolveNext } = reachSettingsWithDeferredUpdates({
      selectedProvider: "ollama-cloud",
      selectedModel: "gemma3:4b",
    });
    expect(
      await screen.findByRole("heading", { name: /explanation settings/i }),
    ).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: /use this computer/i }));
    // The mode's persist write hasn't resolved yet, so nothing has been sent for the
    // revalidation — this is the storage-latency window the finding describes.
    expect(harness.client.sent).toHaveLength(0);

    await userEvent.click(screen.getByRole("button", { name: /run setup again/i }));
    expect(harness.client.sent.at(-1)).toEqual({ type: "check-runtime" });
    expect(screen.getByRole("heading", { name: /checking ollama/i })).toBeVisible();

    // The deferred mode-change persist now resolves, sending its own list-models after
    // check-runtime — which supersedes it on the port. Its runtime-result is dropped by
    // the service and never arrives here; only the surviving list-models response does.
    await act(async () => resolveNext(0));
    expect(harness.client.sent.at(-1)).toEqual({
      type: "list-models",
      mode: "ollama-local",
    });

    act(() => {
      harness.client.emit({
        type: "models-result",
        models: [{ id: "gemma3:4b", displayName: "gemma3:4b", origin: "local" }],
      });
    });

    // Rescued onto a real screen with a way forward, not stuck on "Checking Ollama".
    expect(
      screen.getByRole("heading", { name: /choose a local model/i }),
    ).toBeVisible();
  });

  it("still reaches a model picker after two rapid mode switches", async () => {
    const { harness, pending, resolveNext } = reachSettingsWithDeferredUpdates({
      selectedProvider: "ollama-local",
      selectedModel: RECOMMENDED_MODEL,
    });
    expect(
      await screen.findByRole("heading", { name: /explanation settings/i }),
    ).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: /use ollama cloud/i }));
    await userEvent.click(screen.getByRole("button", { name: /use this computer/i }));
    expect(pending).toHaveLength(2);

    // Both persisted writes eventually settle — order does not matter here, since only
    // the second switch's own list-models can ever survive uncleared on the port, and
    // state.mode was already pinned to "ollama-local" by the second click's synchronous
    // dispatch regardless of resolution order.
    await act(async () => resolveNext(0));
    await act(async () => resolveNext(1));
    expect(harness.client.sent.at(-1)).toEqual({
      type: "list-models",
      mode: "ollama-local",
    });

    act(() => {
      harness.client.emit({
        type: "models-result",
        models: [{ id: "gemma3:4b", displayName: "gemma3:4b", origin: "local" }],
      });
    });

    expect(
      screen.getByRole("heading", { name: /choose a local model/i }),
    ).toBeVisible();
  });
});
