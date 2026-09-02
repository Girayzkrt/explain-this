import {
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
import type { OnboardingClientConnection } from "../../features/onboarding/use-onboarding";
import type {
  SettingsRepository,
  StoredSettings,
} from "../../platform/storage/settings-repository";
import { RECOMMENDED_MODEL } from "../../shared/constants";
import { OptionsApp, type OptionsAppDependencies } from "./OptionsApp";

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
  await userEvent.click(
    await screen.findByRole("button", { name: /start local setup/i }),
  );
  expect(screen.getByRole("heading", { name: /checking ollama/i })).toBeVisible();
  expect(harness.client.sent.at(-1)).toEqual({ type: "check-runtime" });
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
  expect(harness.client.sent.at(-1)).toEqual({ type: "list-models" });
  act(() => harness.client.emit({ type: "models-result", models }));
  expect(screen.getByRole("heading", { name: /choose a local model/i })).toBeVisible();
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
  const language = screen.getByRole("textbox", { name: /preferred language/i });
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
      await screen.findByRole("heading", { name: /understand text locally/i }),
    ).toBeVisible();
    expect(
      screen.getByRole("progressbar", { name: /setup progress/i }),
    ).toHaveAttribute("max", "4");
    expect(screen.getByText(/nothing leaves this computer/i)).toBeInTheDocument();
    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "1Welcome",
      "2Local model",
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
      screen.queryByRole("heading", { name: /understand text locally/i }),
    ).not.toBeInTheDocument();

    await act(async () => hydration.resolve(storedSettings(0)));
    expect(
      screen.getByRole("heading", { name: /understand text locally/i }),
    ).toBeVisible();
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

  it("shows the recommended model name and size before explicit download confirmation", async () => {
    const harness = createHarness();
    await reachModelChoice(harness);

    expect(screen.getByText(RECOMMENDED_MODEL)).toBeVisible();
    expect(screen.getByText(/approximately 1.9 GB/i)).toBeVisible();
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

  it("moves keyboard focus to the active step heading after a transition", async () => {
    const harness = createHarness();

    await startRuntimeCheck(harness);

    expect(screen.getByRole("heading", { name: /checking ollama/i })).toHaveFocus();
  });

  it("requires language confirmation and keeps both privacy choices off by default", async () => {
    const harness = createHarness();
    await reachPreferences(harness);

    expect(screen.getByRole("textbox", { name: /preferred language/i })).toHaveValue(
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
          order.push(`persist:${String(patch.automaticToolbar)}`);
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
          order.push(`persist:${String(patch.automaticToolbar)}`);
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
          order.push(`persist:${String(patch.automaticToolbar)}`);
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

    expect(screen.getByRole("alert")).toHaveTextContent("Local model could not finish");
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
      /prompt|selected|readiness|output/i,
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
    expect(screen.getByRole("textbox", { name: /explanation language/i })).toHaveValue(
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

    const language = screen.getByRole("textbox", { name: /explanation language/i });
    await userEvent.clear(language);
    await userEvent.type(language, "Turkish");
    await userEvent.click(screen.getByRole("button", { name: /save language/i }));

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
});
