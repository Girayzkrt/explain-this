import { describe, expect, it, vi } from "vitest";
import { PublicError } from "../../core/requests/public-error";
import { ModelConcurrencyGate } from "../../core/requests/model-concurrency-gate";
import { RequestCoordinator } from "../reader/request-coordinator";
import { DEFAULT_PREFERENCES, type ReadingPreferences } from "../settings/settings";
import type { SettingsRepository } from "../../platform/storage/settings-repository";
import type {
  ChatRequest,
  DownloadableModelProvider,
  ModelDownloadEvent,
  ModelDetails,
  ModelInfo,
  ProviderHealth,
  StreamEvent,
} from "../../providers/provider";
import { RECOMMENDED_MODEL } from "../../shared/constants";
import {
  parseOnboardingCommand,
  parseOnboardingEvent,
  type OnboardingCommand,
  type OnboardingEvent,
} from "./contracts";
import {
  ONBOARDING_PORT_NAME,
  OnboardingService,
  isTrustedOnboardingPort,
} from "./onboarding-service";

class ListenerSet<T> {
  readonly listeners = new Set<T>();
  addListener(listener: T): void {
    this.listeners.add(listener);
  }
  removeListener(listener: T): void {
    this.listeners.delete(listener);
  }
}

class FakePort {
  readonly onMessage = new ListenerSet<(message: unknown) => void>();
  readonly onDisconnect = new ListenerSet<() => void>();
  readonly posted: OnboardingEvent[] = [];

  postMessage(message: OnboardingEvent): void {
    this.posted.push(structuredClone(message));
  }

  disconnect(): void {
    for (const listener of [...this.onDisconnect.listeners]) listener();
  }

  send(message: OnboardingCommand | unknown): void {
    for (const listener of [...this.onMessage.listeners]) listener(message);
  }
}

interface ChatCall {
  requestId: string;
  request: ChatRequest;
  signal: AbortSignal;
}

class FakeProvider implements DownloadableModelProvider {
  health: ProviderHealth = { available: true };
  healthError: unknown;
  models: ModelInfo[] = [
    { id: RECOMMENDED_MODEL, displayName: RECOMMENDED_MODEL, origin: "local" },
  ];
  details = new Map<string, ModelDetails>();
  readonly chatCalls: ChatCall[] = [];
  readonly listCalls: AbortSignal[] = [];
  readonly downloadCalls: Array<{ model: string; signal: AbortSignal }> = [];
  listPlan: (signal: AbortSignal) => Promise<ModelInfo[]> = async () =>
    structuredClone(this.models);
  chatPlan: (call: ChatCall) => AsyncIterable<StreamEvent> = async function* (call) {
    yield { type: "started", requestId: call.requestId };
    yield { type: "delta", requestId: call.requestId, sequence: 0, text: "Ready." };
    yield {
      type: "completed",
      requestId: call.requestId,
      metrics: { outputTokens: 20, durationMs: 2_000 },
    };
  };
  downloadPlan: (
    model: string,
    signal: AbortSignal,
  ) => AsyncIterable<ModelDownloadEvent> = async function* (model) {
    yield { type: "started", model };
    yield { type: "progress", model, completedBytes: 50, totalBytes: 100 };
    yield { type: "completed", model };
  };

  async checkHealth(): Promise<ProviderHealth> {
    if (this.healthError) throw this.healthError;
    return this.health;
  }
  async listModels(signal: AbortSignal): Promise<ModelInfo[]> {
    this.listCalls.push(signal);
    return this.listPlan(signal);
  }
  async getModelDetails(model: string): Promise<ModelDetails> {
    return (
      this.details.get(model) ?? { id: model, displayName: model, origin: "local" }
    );
  }
  streamChat(
    requestId: string,
    request: ChatRequest,
    signal: AbortSignal,
  ): AsyncIterable<StreamEvent> {
    const call = { requestId, request, signal };
    this.chatCalls.push(call);
    return this.chatPlan(call);
  }
  downloadModel(model: string, signal: AbortSignal): AsyncIterable<ModelDownloadEvent> {
    this.downloadCalls.push({ model, signal });
    return this.downloadPlan(model, signal);
  }
}

function settingsHarness(preferences = DEFAULT_PREFERENCES) {
  const updates: Partial<ReadingPreferences>[] = [];
  let completions = 0;
  const repository: SettingsRepository = {
    async get() {
      return { onboardingVersion: 1, preferences };
    },
    async update(patch) {
      updates.push(structuredClone(patch));
      return { onboardingVersion: 1, preferences: { ...preferences, ...patch } };
    },
    async markOnboardingComplete() {
      completions += 1;
      return { onboardingVersion: 1, preferences };
    },
  };
  return {
    repository,
    updates,
    get completions() {
      return completions;
    },
  };
}

function createHarness(
  options: { now?: () => number; gate?: ModelConcurrencyGate } = {},
) {
  const provider = new FakeProvider();
  const settings = settingsHarness();
  const port = new FakePort();
  const service = new OnboardingService({
    provider,
    settingsRepository: settings.repository,
    modelGate: options.gate ?? new ModelConcurrencyGate(),
    now: options.now ?? (() => performance.now()),
  });
  service.handle(port);
  return { provider, settings, port, service };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settlePromise) => {
    resolve = settlePromise;
  });
  return { promise, resolve };
}

describe("onboarding service", () => {
  it.each([
    [undefined, "ready"],
    [new PublicError("OLLAMA_UNREACHABLE", "not reachable", true), "unreachable"],
    [
      new PublicError("OLLAMA_ORIGIN_BLOCKED", "origin rejected", true),
      "origin-blocked",
    ],
    [new Error("private provider details"), "error"],
  ] as const)("reports runtime health as %s -> %s", async (failure, status) => {
    const harness = createHarness();
    harness.provider.healthError = failure;

    harness.port.send({ type: "check-runtime" });
    await settle();

    expect(harness.port.posted).toHaveLength(1);
    expect(harness.port.posted[0]).toMatchObject({
      type: "runtime-result",
      health: { status },
    });
    expect(JSON.stringify(harness.port.posted)).not.toContain(
      "private provider details",
    );
  });

  it("normalizes a runtime connection timeout to the public unreachable error", async () => {
    const harness = createHarness();
    harness.provider.healthError = new PublicError(
      "CONNECTION_TIMEOUT",
      "The connection to Ollama timed out.",
      true,
    );

    harness.port.send({ type: "check-runtime" });
    await settle();

    expect(harness.port.posted).toEqual([
      {
        type: "runtime-result",
        health: {
          available: false,
          status: "unreachable",
          message: "The connection to Ollama timed out.",
          error: {
            code: "OLLAMA_UNREACHABLE",
            message: "The connection to Ollama timed out.",
            recoverable: true,
          },
          secondaryAction: "show-origin-guidance",
        },
      },
    ]);
  });

  it("preserves an explicit unavailable origin-blocked provider health result", async () => {
    const harness = createHarness();
    harness.provider.health = {
      available: false,
      status: "origin-blocked",
      message: "Ollama rejected this extension origin.",
      error: {
        code: "OLLAMA_ORIGIN_BLOCKED",
        message: "Ollama rejected this extension origin.",
        recoverable: true,
      },
      secondaryAction: "show-origin-guidance",
    };

    harness.port.send({ type: "check-runtime" });
    await settle();

    expect(harness.port.posted).toEqual([
      {
        type: "runtime-result",
        health: {
          available: false,
          status: "origin-blocked",
          message: "Ollama rejected this extension origin.",
          error: {
            code: "OLLAMA_ORIGIN_BLOCKED",
            message: "Ollama rejected this extension origin.",
            recoverable: true,
          },
          secondaryAction: "show-origin-guidance",
        },
      },
    ]);
  });

  it("reports model-required when a healthy runtime has no installed models", async () => {
    const harness = createHarness();
    harness.provider.models = [];

    harness.port.send({ type: "check-runtime" });
    await settle();

    expect(harness.port.posted).toEqual([
      {
        type: "runtime-result",
        health: {
          available: true,
          status: "model-required",
          message: "Ollama is ready, but no local model is installed.",
        },
      },
    ]);
  });

  it("asks the reader to sign in when cloud mode finds no cloud model", async () => {
    const harness = createHarness();
    harness.provider.models = [
      { id: "gemma3:4b", displayName: "gemma3:4b", origin: "local" },
    ];

    harness.port.send({ type: "list-models", mode: "ollama-cloud" });
    await settle();

    expect(harness.port.posted).toEqual([
      {
        type: "onboarding-failed",
        error: {
          code: "OLLAMA_SIGNIN_REQUIRED",
          message:
            "No Ollama Cloud models are available. Run `ollama signin`, then pull a cloud model.",
          recoverable: true,
        },
      },
    ]);
  });

  it("treats an unknown-origin model as signed in, not as needing sign-in guidance", async () => {
    const harness = createHarness();
    harness.provider.models = [
      { id: "gemma3:4b", displayName: "gemma3:4b", origin: "local" },
      { id: "gemma4:31b-cloud", displayName: "gemma4:31b-cloud", origin: "unknown" },
    ];

    harness.port.send({ type: "list-models", mode: "ollama-cloud" });
    await settle();

    expect(harness.port.posted).toEqual([
      {
        type: "models-result",
        models: [
          { id: "gemma3:4b", displayName: "gemma3:4b", origin: "local" },
          {
            id: "gemma4:31b-cloud",
            displayName: "gemma4:31b-cloud",
            origin: "unknown",
          },
        ],
      },
    ]);
  });

  it("lists every model with its origin intact when the reader is signed in", async () => {
    const harness = createHarness();
    harness.provider.models = [
      { id: "gemma3:4b", displayName: "gemma3:4b", origin: "local" },
      { id: "gemma4:26b-cloud", displayName: "gemma4:26b-cloud", origin: "cloud" },
    ];

    harness.port.send({ type: "list-models", mode: "ollama-cloud" });
    await settle();

    expect(harness.port.posted).toEqual([
      {
        type: "models-result",
        models: [
          { id: "gemma3:4b", displayName: "gemma3:4b", origin: "local" },
          {
            id: "gemma4:26b-cloud",
            displayName: "gemma4:26b-cloud",
            origin: "cloud",
          },
        ],
      },
    ]);
  });

  it("labels only explicit code-specialized model families or names", async () => {
    const harness = createHarness();
    harness.provider.models = [
      { id: "qwen3:4b", displayName: "qwen3:4b", origin: "local" },
      { id: "codegemma:7b", displayName: "codegemma:7b", origin: "local" },
      { id: "custom:latest", displayName: "Custom", origin: "local" },
    ];
    harness.provider.details.set("custom:latest", {
      id: "custom:latest",
      displayName: "Custom",
      family: "starcoder2",
      origin: "local",
    });

    harness.port.send({ type: "list-models", mode: "ollama-local" });
    await settle();

    expect(harness.port.posted).toEqual([
      {
        type: "models-result",
        models: [
          { id: "qwen3:4b", displayName: "qwen3:4b", origin: "local" },
          {
            id: "codegemma:7b",
            displayName: "codegemma:7b · Code-specialized",
            origin: "local",
          },
          {
            id: "custom:latest",
            displayName: "Custom · Code-specialized",
            origin: "local",
          },
        ],
      },
    ]);
  });

  it("downloads only the recommended model or an exact installed-library name and streams progress", async () => {
    const harness = createHarness();
    harness.provider.models = [
      { id: "llama3.2:3b", displayName: "Llama", origin: "local" },
    ];

    harness.port.send({ type: "download-model", model: "llama3.2:3b" });
    await settle();

    expect(harness.provider.downloadCalls[0]?.model).toBe("llama3.2:3b");
    expect(harness.port.posted).toEqual([
      {
        type: "download-progress",
        progress: { type: "started", model: "llama3.2:3b" },
      },
      {
        type: "download-progress",
        progress: {
          type: "progress",
          model: "llama3.2:3b",
          completedBytes: 50,
          totalBytes: 100,
        },
      },
      {
        type: "download-progress",
        progress: { type: "completed", model: "llama3.2:3b" },
      },
    ]);

    const rejected = createHarness();
    rejected.port.send({ type: "download-model", model: "arbitrary:remote" });
    await settle();
    expect(rejected.provider.downloadCalls).toHaveLength(0);
    expect(rejected.port.posted[0]).toMatchObject({
      type: "onboarding-failed",
      error: { code: "INVALID_REQUEST", recoverable: false },
    });
  });

  it("cancels an in-progress model download", async () => {
    const harness = createHarness();
    harness.provider.downloadPlan = async function* (model, signal) {
      yield { type: "started", model };
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      yield {
        type: "failed",
        model,
        error: { code: "REQUEST_CANCELLED", message: "Cancelled.", recoverable: true },
      };
    };

    harness.port.send({ type: "download-model", model: RECOMMENDED_MODEL });
    await settle();
    harness.port.send({ type: "cancel-download" });
    await settle();

    expect(harness.provider.downloadCalls[0]?.signal.aborted).toBe(true);
    expect(harness.port.posted.at(-1)).toMatchObject({
      type: "download-progress",
      progress: { type: "failed", error: { code: "REQUEST_CANCELLED" } },
    });
  });

  it("owns an alternate-model download before validation so cancel prevents pull", async () => {
    const harness = createHarness();
    const releaseValidation = deferred<void>();
    let validationSignal: AbortSignal | undefined;
    harness.provider.models = [
      { id: "llama3.2:3b", displayName: "Llama", origin: "local" },
    ];
    harness.provider.listPlan = async (signal) => {
      validationSignal = signal;
      await releaseValidation.promise;
      return structuredClone(harness.provider.models);
    };

    harness.port.send({ type: "download-model", model: "llama3.2:3b" });
    await vi.waitFor(() => expect(validationSignal).toBeDefined());
    harness.port.send({ type: "cancel-download" });
    const wasAbortedDuringValidation = validationSignal?.aborted;
    releaseValidation.resolve();
    await settle();

    expect(wasAbortedDuringValidation).toBe(true);
    expect(harness.provider.downloadCalls).toHaveLength(0);
  });

  it("does not let one onboarding port replace or cancel another port's download", async () => {
    const harness = createHarness();
    const secondPort = new FakePort();
    const releaseFirst = deferred<void>();
    harness.service.handle(secondPort);
    harness.provider.downloadPlan = async function* (model) {
      if (model === RECOMMENDED_MODEL) await releaseFirst.promise;
      yield { type: "completed", model };
    };

    harness.port.send({ type: "download-model", model: RECOMMENDED_MODEL });
    await vi.waitFor(() => expect(harness.provider.downloadCalls).toHaveLength(1));
    secondPort.send({ type: "download-model", model: RECOMMENDED_MODEL });
    secondPort.send({ type: "cancel-download" });
    const firstPortWasAborted = harness.provider.downloadCalls[0]?.signal.aborted;
    releaseFirst.resolve();
    await settle();

    expect(firstPortWasAborted).toBe(false);
  });

  it("suppresses late progress and failure from a replaced download generation", async () => {
    const harness = createHarness();
    const releaseStaleDownload = deferred<void>();
    harness.provider.models = [
      { id: "installed:latest", displayName: "Installed", origin: "local" },
    ];
    harness.provider.downloadPlan = async function* (model) {
      yield { type: "started", model };
      if (model === RECOMMENDED_MODEL) {
        await releaseStaleDownload.promise;
        yield {
          type: "progress",
          model,
          completedBytes: 1,
          totalBytes: 10,
        };
        throw new PublicError("MODEL_DOWNLOAD_FAILED", "stale download failure", true);
      }
      yield { type: "completed", model };
    };

    harness.port.send({ type: "download-model", model: RECOMMENDED_MODEL });
    await vi.waitFor(() => expect(harness.provider.downloadCalls).toHaveLength(1));
    harness.port.send({ type: "download-model", model: "installed:latest" });
    await settle();
    releaseStaleDownload.resolve();
    await vi.waitFor(() => expect(harness.provider.downloadCalls).toHaveLength(2));
    await vi.waitFor(() =>
      expect(harness.port.posted).toContainEqual({
        type: "download-progress",
        progress: { type: "completed", model: "installed:latest" },
      }),
    );

    expect(harness.port.posted).not.toContainEqual({
      type: "download-progress",
      progress: {
        type: "progress",
        model: RECOMMENDED_MODEL,
        completedBytes: 1,
        totalBytes: 10,
      },
    });
    expect(JSON.stringify(harness.port.posted)).not.toContain("stale download failure");
  });

  it("runs one synthetic Explain request and derives local readiness metrics", async () => {
    const times = [1_000, 2_250];
    const harness = createHarness({ now: () => times.shift() ?? 2_250 });

    harness.port.send({
      type: "run-readiness",
      model: RECOMMENDED_MODEL,
      preferences: DEFAULT_PREFERENCES,
    });
    await settle();

    expect(harness.provider.chatCalls).toHaveLength(1);
    const call = harness.provider.chatCalls[0];
    expect(call?.request.model).toBe(RECOMMENDED_MODEL);
    expect(call?.request.messages[1]?.content).toContain("Requested action: explain.");
    expect(call?.request.messages[1]?.content).toContain(
      "<selected_text>This is a local readiness check.</selected_text>",
    );
    expect(call?.request.messages[1]?.content).not.toContain(
      'nearby_context included="true"',
    );
    // The recommended model was just downloaded and is therefore cold; readiness must
    // use the same mode-derived budget the reader path uses, not the provider's own
    // shorter default, or a correctly configured local reader can time out here.
    expect(call?.request.firstTokenTimeoutMs).toBe(60_000);
    expect(harness.port.posted.at(-1)).toEqual({
      type: "readiness-result",
      result: {
        status: "ready",
        firstTokenMs: 1_250,
        tokensPerSecond: 10,
        warnings: [],
      },
    });
  });

  it("sizes readiness's first-token budget to cloud mode when that is the active mode", async () => {
    const harness = createHarness();
    harness.provider.models = [
      { id: "gemma4:31b-cloud", displayName: "gemma4:31b-cloud", origin: "cloud" },
    ];

    harness.port.send({
      type: "run-readiness",
      model: "gemma4:31b-cloud",
      preferences: { ...DEFAULT_PREFERENCES, selectedProvider: "ollama-cloud" },
    });
    await settle();

    const call = harness.provider.chatCalls[0];
    expect(call?.request.firstTokenTimeoutMs).toBe(20_000);
  });

  it("rejects readiness for a model outside the exact recommended-or-installed boundary", async () => {
    const harness = createHarness();
    harness.provider.models = [
      { id: "llama3.2:3b", displayName: "Llama", origin: "local" },
    ];

    harness.port.send({
      type: "run-readiness",
      model: "llama3.2:3b-remote",
      preferences: DEFAULT_PREFERENCES,
    });
    await settle();

    expect(harness.provider.chatCalls).toHaveLength(0);
    expect(harness.port.posted).toEqual([
      {
        type: "onboarding-failed",
        error: {
          code: "INVALID_REQUEST",
          message: "The selected model is not in the local model library.",
          recoverable: false,
        },
      },
    ]);
  });

  it("suppresses a late readiness result after a newer generation replaces it", async () => {
    let currentTime = 0;
    const harness = createHarness({ now: () => (currentTime += 1_000) });
    const releaseStaleReadiness = deferred<void>();
    let readinessCall = 0;
    harness.provider.chatPlan = async function* (call) {
      readinessCall += 1;
      yield { type: "started", requestId: call.requestId };
      if (readinessCall === 1) await releaseStaleReadiness.promise;
      yield { type: "delta", requestId: call.requestId, sequence: 0, text: "Ready." };
      yield {
        type: "completed",
        requestId: call.requestId,
        metrics: { outputTokens: 10, durationMs: 1_000 },
      };
    };

    const command: OnboardingCommand = {
      type: "run-readiness",
      model: RECOMMENDED_MODEL,
      preferences: DEFAULT_PREFERENCES,
    };
    harness.port.send(command);
    await vi.waitFor(() => expect(harness.provider.chatCalls).toHaveLength(1));
    harness.port.send(command);
    releaseStaleReadiness.resolve();
    await vi.waitFor(() => expect(harness.provider.chatCalls).toHaveLength(2));
    await vi.waitFor(() =>
      expect(
        harness.port.posted.filter((event) => event.type === "readiness-result"),
      ).not.toHaveLength(0),
    );
    await settle();

    expect(
      harness.port.posted.filter((event) => event.type === "readiness-result"),
    ).toHaveLength(1);
  });

  it.each([
    [30_001, 10, ["slow-first-token"]],
    [1_000, 4.99, ["slow-generation"]],
  ] as const)(
    "returns warnings rather than failure for slow local metrics",
    async (firstTokenMs, speed, warnings) => {
      const times = [0, firstTokenMs];
      const harness = createHarness({ now: () => times.shift() ?? firstTokenMs });
      harness.provider.chatPlan = async function* (call) {
        yield { type: "started", requestId: call.requestId };
        yield { type: "delta", requestId: call.requestId, sequence: 0, text: "Ready." };
        yield {
          type: "completed",
          requestId: call.requestId,
          metrics: { outputTokens: speed * 1_000, durationMs: 1_000_000 },
        };
      };

      harness.port.send({
        type: "run-readiness",
        model: RECOMMENDED_MODEL,
        preferences: DEFAULT_PREFERENCES,
      });
      await settle();

      expect(harness.port.posted.at(-1)).toMatchObject({
        type: "readiness-result",
        result: { status: "warning", firstTokenMs, tokensPerSecond: speed, warnings },
      });
    },
  );

  it("persists only validated preferences when onboarding completes", async () => {
    const harness = createHarness();
    const preferences = { ...DEFAULT_PREFERENCES, selectedModel: "llama3.2:3b" };

    harness.port.send({ type: "complete-onboarding", preferences });
    await settle();

    expect(harness.settings.updates).toEqual([preferences]);
    expect(harness.settings.completions).toBe(1);
    expect(JSON.stringify(harness.settings.updates)).not.toContain("readiness");
    expect(harness.port.posted).toEqual([{ type: "onboarding-complete" }]);
  });

  it("validates closed command and event unions without privileged options", () => {
    expect(() =>
      parseOnboardingCommand({
        type: "check-runtime",
        endpoint: "https://remote.test",
      }),
    ).toThrowError(PublicError);
    expect(() =>
      parseOnboardingCommand({
        type: "run-readiness",
        model: RECOMMENDED_MODEL,
        preferences: DEFAULT_PREFERENCES,
        prompt: "run this",
      }),
    ).toThrowError(PublicError);
    expect(() =>
      parseOnboardingCommand({
        type: "download-model",
        model: RECOMMENDED_MODEL,
        shellCommand: "ollama pull",
      }),
    ).toThrowError(PublicError);
    expect(() =>
      parseOnboardingEvent({ type: "onboarding-complete", providerOptions: {} }),
    ).toThrowError(PublicError);
    expect(() =>
      parseOnboardingEvent({
        type: "download-progress",
        progress: { type: "started", model: "m".repeat(201) },
      }),
    ).toThrowError(PublicError);
    expect(() =>
      parseOnboardingEvent({
        type: "download-progress",
        progress: {
          type: "failed",
          model: RECOMMENDED_MODEL,
          error: {
            code: "MODEL_DOWNLOAD_FAILED",
            message: "e".repeat(501),
            recoverable: true,
          },
        },
      }),
    ).toThrowError(PublicError);
  });

  it("accepts only the exact onboarding port name from the extension-page URL prefix", () => {
    const root = "chrome-extension://abcdefghijklmnop/";
    expect(
      isTrustedOnboardingPort(
        { name: ONBOARDING_PORT_NAME, sender: { url: `${root}options.html` } },
        root,
      ),
    ).toBe(true);
    expect(
      isTrustedOnboardingPort(
        { name: "options-page", sender: { url: `${root}options.html` } },
        root,
      ),
    ).toBe(false);
    expect(
      isTrustedOnboardingPort(
        {
          name: ONBOARDING_PORT_NAME,
          sender: {
            url: "https://article.test/",
            tab: { id: 4, url: "https://article.test/" },
          },
        },
        root,
      ),
    ).toBe(false);
  });

  it("shares one model-wide gate with normal reading requests", async () => {
    const gate = new ModelConcurrencyGate();
    const provider = new FakeProvider();
    let releaseReading!: () => void;
    provider.chatPlan = async function* (call) {
      yield { type: "started", requestId: call.requestId };
      if (call.requestId === "123e4567-e89b-42d3-a456-426614174001") {
        await new Promise<void>((resolve) => {
          releaseReading = resolve;
        });
      }
      yield { type: "delta", requestId: call.requestId, sequence: 0, text: "Done." };
      yield {
        type: "completed",
        requestId: call.requestId,
        metrics: { outputTokens: 10, durationMs: 1_000 },
      };
    };
    const coordinatorPort = {
      posted: [] as unknown[],
      onMessage: new ListenerSet<(message: unknown) => void>(),
      onDisconnect: new ListenerSet<() => void>(),
      postMessage(message: unknown) {
        this.posted.push(message);
      },
      disconnect() {},
    };
    const sessions = new Map<string, unknown>();
    const settings = settingsHarness();
    const coordinator = new RequestCoordinator({
      provider,
      modelGate: gate,
      settingsRepository: settings.repository,
      sessionRepository: {
        async getReaderSession() {
          return sessions.get("session") as never;
        },
        async putReaderSession(value) {
          sessions.set("session", value);
        },
        async getPrivateSource() {
          return sessions.get("source") as never;
        },
        async putPrivateSource(_tabId, value) {
          sessions.set("source", value);
        },
        async removeTabState() {
          sessions.clear();
        },
      },
    });
    coordinator.handle(coordinatorPort, {
      url: "https://reader.test/article",
      tab: { id: 8, url: "https://reader.test/article" },
    });
    for (const listener of coordinatorPort.onMessage.listeners) {
      listener({
        type: "start-request",
        request: {
          requestId: "123e4567-e89b-42d3-a456-426614174001",
          action: "explain",
          selection: "Page text",
        },
      });
    }
    await settle();

    const onboardingPort = new FakePort();
    new OnboardingService({
      provider,
      settingsRepository: settings.repository,
      modelGate: gate,
      now: () => 0,
    }).handle(onboardingPort);
    onboardingPort.send({
      type: "run-readiness",
      model: RECOMMENDED_MODEL,
      preferences: DEFAULT_PREFERENCES,
    });
    await settle();

    expect(provider.chatCalls).toHaveLength(1);
    releaseReading();
    await settle();
    await settle();
    expect(provider.chatCalls).toHaveLength(2);
  });
});
