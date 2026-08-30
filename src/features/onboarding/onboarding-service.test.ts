import { describe, expect, it } from "vitest";
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
  models: ModelInfo[] = [{ id: RECOMMENDED_MODEL, displayName: RECOMMENDED_MODEL }];
  details = new Map<string, ModelDetails>();
  readonly chatCalls: ChatCall[] = [];
  readonly downloadCalls: Array<{ model: string; signal: AbortSignal }> = [];
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
  async listModels(): Promise<ModelInfo[]> {
    return structuredClone(this.models);
  }
  async getModelDetails(model: string): Promise<ModelDetails> {
    return this.details.get(model) ?? { id: model, displayName: model };
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

  it("labels only explicit code-specialized model families or names", async () => {
    const harness = createHarness();
    harness.provider.models = [
      { id: "qwen3:4b", displayName: "qwen3:4b" },
      { id: "codegemma:7b", displayName: "codegemma:7b" },
      { id: "custom:latest", displayName: "Custom" },
    ];
    harness.provider.details.set("custom:latest", {
      id: "custom:latest",
      displayName: "Custom",
      family: "starcoder2",
    });

    harness.port.send({ type: "list-models" });
    await settle();

    expect(harness.port.posted).toEqual([
      {
        type: "models-result",
        models: [
          { id: "qwen3:4b", displayName: "qwen3:4b" },
          { id: "codegemma:7b", displayName: "codegemma:7b · Code-specialized" },
          { id: "custom:latest", displayName: "Custom · Code-specialized" },
        ],
      },
    ]);
  });

  it("downloads only the recommended model or an exact installed-library name and streams progress", async () => {
    const harness = createHarness();
    harness.provider.models = [{ id: "llama3.2:3b", displayName: "Llama" }];

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
