import { describe, expect, it, vi } from "vitest";
import { DEFAULT_PREFERENCES, type ReadingPreferences } from "../settings/settings";
import type { ChatRequest, LlmProvider, StreamEvent } from "../../providers/provider";
import type {
  BackgroundPortMessage,
  ReaderPortMessage,
} from "../../platform/messaging/contracts";
import type {
  ListenerSet,
  PortLike,
  TrustedPortSender,
} from "../../platform/messaging/port";
import { createSessionRepository } from "../../platform/storage/session-repository";
import type { SettingsRepository } from "../../platform/storage/settings-repository";
import { MemoryStorageArea } from "../../../tests/support/memory-storage";
import { RequestCoordinator } from "./request-coordinator";

const REQUEST_1 = "123e4567-e89b-42d3-a456-426614174001";
const REQUEST_2 = "123e4567-e89b-42d3-a456-426614174002";
const TAB_ID = 41;
const ORIGIN = "https://reader.test";

class TestListenerSet<T extends (...args: never[]) => void> implements ListenerSet<T> {
  readonly listeners = new Set<T>();

  addListener(listener: T): void {
    this.listeners.add(listener);
  }

  removeListener(listener: T): void {
    this.listeners.delete(listener);
  }
}

class TestPort implements PortLike {
  readonly posted: BackgroundPortMessage[] = [];
  readonly onMessage = new TestListenerSet<(message: unknown) => void>();
  readonly onDisconnect = new TestListenerSet<() => void>();

  postMessage(message: BackgroundPortMessage): void {
    this.posted.push(structuredClone(message));
  }

  disconnect(): void {
    for (const listener of [...this.onDisconnect.listeners]) listener();
  }

  send(message: ReaderPortMessage | unknown): void {
    for (const listener of [...this.onMessage.listeners]) listener(message);
  }
}

interface ProviderCall {
  requestId: string;
  request: ChatRequest;
  signal: AbortSignal;
}

type StreamPlan = (call: ProviderCall) => AsyncIterable<StreamEvent>;

class FakeProvider implements LlmProvider {
  readonly calls: ProviderCall[] = [];
  readonly plans: StreamPlan[] = [];

  async checkHealth(): Promise<{ available: boolean }> {
    return { available: true };
  }

  async listModels(): Promise<[]> {
    return [];
  }

  async getModelDetails(model: string): Promise<{ id: string; displayName: string }> {
    return { id: model, displayName: model };
  }

  streamChat(
    requestId: string,
    request: ChatRequest,
    signal: AbortSignal,
  ): AsyncIterable<StreamEvent> {
    const call = { requestId, request, signal };
    this.calls.push(call);
    const plan = this.plans.shift();
    if (!plan) throw new Error("Missing fake provider plan.");
    return plan(call);
  }
}

function createSettingsRepository(
  preferences: ReadingPreferences = DEFAULT_PREFERENCES,
): SettingsRepository {
  return {
    async get() {
      return { onboardingVersion: 1, preferences };
    },
    async update() {
      return { onboardingVersion: 1, preferences };
    },
    async markOnboardingComplete() {
      return { onboardingVersion: 1, preferences };
    },
  };
}

const settingsRepository = createSettingsRepository();

function request(
  requestId = REQUEST_1,
  selection = "Private source text",
  nearbyContext?: string,
) {
  return {
    requestId,
    action: "explain" as const,
    selection,
    ...(nearbyContext === undefined ? {} : { nearbyContext }),
  };
}

function sender(tabId = TAB_ID, url = `${ORIGIN}/article`): TrustedPortSender {
  return { tab: { id: tabId, url }, url };
}

function createHarness(preferences: ReadingPreferences = DEFAULT_PREFERENCES) {
  const storage = new MemoryStorageArea();
  const sessionRepository = createSessionRepository(storage);
  const provider = new FakeProvider();
  const coordinator = new RequestCoordinator({
    provider,
    sessionRepository,
    settingsRepository: createSettingsRepository(preferences),
  });
  return { coordinator, provider, sessionRepository, storage };
}

function finitePlan(events: StreamEvent[]): StreamPlan {
  return async function* () {
    for (const event of events) yield event;
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function waitForCalls(provider: FakeProvider, count: number): Promise<void> {
  await vi.waitFor(() => expect(provider.calls).toHaveLength(count));
}

describe("RequestCoordinator", () => {
  it("rejects a port whose trusted sender has no numeric tab ID", async () => {
    const { coordinator, provider } = createHarness();
    const port = new TestPort();

    coordinator.handle(port, { url: `${ORIGIN}/article` });
    port.send({ type: "start-request", request: request() });

    await vi.waitFor(() => expect(port.posted).toHaveLength(1));
    expect(port.posted).toEqual([
      {
        type: "command-failed",
        error: expect.objectContaining({ code: "INVALID_REQUEST" }),
      },
    ]);
    expect(provider.calls).toHaveLength(0);
  });

  it("validates, budgets, prompts, streams, and stores safe state for the trusted tab", async () => {
    const trustedPreferences: ReadingPreferences = {
      ...DEFAULT_PREFERENCES,
      preferredLanguage: "Nederlands",
      explanationLevel: "technical",
      selectedModel: "trusted-model:7b",
    };
    const { coordinator, provider, sessionRepository, storage } =
      createHarness(trustedPreferences);
    const port = new TestPort();
    const privateSelection = "Private source text ".repeat(20);
    provider.plans.push(
      finitePlan([
        { type: "started", requestId: REQUEST_1 },
        { type: "delta", requestId: REQUEST_1, sequence: 0, text: "Clear answer" },
        { type: "completed", requestId: REQUEST_1 },
      ]),
    );

    coordinator.handle(port, sender());
    port.send({
      type: "start-request",
      request: request(REQUEST_1, privateSelection),
    });

    await vi.waitFor(() =>
      expect(port.posted).toContainEqual({
        type: "stream-event",
        event: { type: "completed", requestId: REQUEST_1 },
      }),
    );
    expect(provider.calls[0]?.request.messages[1]?.content).toContain(
      `<selected_text>${privateSelection}</selected_text>`,
    );
    expect(provider.calls[0]?.request.model).toBe("trusted-model:7b");
    expect(provider.calls[0]?.request.messages[1]?.content).toContain(
      "Target language: Nederlands.",
    );
    expect(provider.calls[0]?.request.messages[1]?.content).toContain(
      "Explanation level: Technical.",
    );
    expect(
      port.posted
        .filter((message) => message.type === "stream-event")
        .every((message) => message.event.requestId === REQUEST_1),
    ).toBe(true);
    await expect(sessionRepository.getReaderSession(TAB_ID)).resolves.toMatchObject({
      requestId: REQUEST_1,
      status: "completed",
      answer: "Clear answer",
      origin: ORIGIN,
    });
    await expect(sessionRepository.getPrivateSource(TAB_ID)).resolves.toEqual({
      requestId: REQUEST_1,
      selection: privateSelection,
      origin: ORIGIN,
    });

    const snapshot = await storage.snapshot();
    expect(JSON.stringify(snapshot["reader-session:41"])).not.toContain(
      privateSelection,
    );
    expect(snapshot["reader-source:41"]).toMatchObject({
      selection: privateSelection,
    });
  });

  it("rejects over-budget content before invoking the provider", async () => {
    const { coordinator, provider } = createHarness();
    const port = new TestPort();
    coordinator.handle(port, sender());

    port.send({
      type: "start-request",
      request: request(REQUEST_1, "漢".repeat(1_601)),
    });

    await vi.waitFor(() =>
      expect(port.posted).toContainEqual({
        type: "command-failed",
        error: expect.objectContaining({ code: "SELECTION_TOO_LARGE" }),
      }),
    );
    expect(provider.calls).toHaveLength(0);
  });

  it("rejects nearby context unless trusted settings opt in", async () => {
    const { coordinator, provider } = createHarness({
      ...DEFAULT_PREFERENCES,
      includeNearbyContext: false,
    });
    const port = new TestPort();
    coordinator.handle(port, sender());

    port.send({
      type: "start-request",
      request: request(REQUEST_1, "Private source", "Untrusted nearby context"),
    });

    await vi.waitFor(() =>
      expect(port.posted).toContainEqual({
        type: "command-failed",
        error: expect.objectContaining({ code: "INVALID_REQUEST" }),
      }),
    );
    expect(provider.calls).toHaveLength(0);
  });

  it("globally removes the old tab state before a cross-tab generation starts", async () => {
    const { coordinator, provider, sessionRepository } = createHarness();
    const firstPort = new TestPort();
    const secondPort = new TestPort();
    const firstReleased = deferred<void>();
    provider.plans.push(
      async function* ({ requestId, signal }) {
        yield { type: "started", requestId };
        await Promise.race([
          firstReleased.promise,
          new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve()),
          ),
        ]);
        yield { type: "cancelled", requestId };
      },
      finitePlan([
        { type: "started", requestId: REQUEST_2 },
        { type: "completed", requestId: REQUEST_2 },
      ]),
    );
    coordinator.handle(firstPort, sender());
    coordinator.handle(secondPort, sender(TAB_ID + 1, "https://second.test/page"));

    firstPort.send({ type: "start-request", request: request() });
    await waitForCalls(provider, 1);
    secondPort.send({ type: "start-request", request: request(REQUEST_2) });
    await waitForCalls(provider, 2);
    await vi.waitFor(() =>
      expect(secondPort.posted).toContainEqual({
        type: "stream-event",
        event: { type: "completed", requestId: REQUEST_2 },
      }),
    );

    expect(provider.calls[0]?.signal.aborted).toBe(true);
    expect(provider.calls[1]?.signal.aborted).toBe(false);
    await expect(sessionRepository.getReaderSession(TAB_ID)).resolves.toBeUndefined();
    await expect(sessionRepository.getPrivateSource(TAB_ID)).resolves.toBeUndefined();
    await expect(sessionRepository.getReaderSession(TAB_ID + 1)).resolves.toMatchObject(
      { requestId: REQUEST_2, status: "completed" },
    );
    await expect(sessionRepository.getPrivateSource(TAB_ID + 1)).resolves.toMatchObject(
      { requestId: REQUEST_2 },
    );
    firstReleased.resolve();
  });

  it("does not let a stale same-tab port disconnect delete newer owned state", async () => {
    const { coordinator, provider, sessionRepository } = createHarness();
    const oldPort = new TestPort();
    const newPort = new TestPort();
    provider.plans.push(
      finitePlan([
        { type: "started", requestId: REQUEST_1 },
        { type: "completed", requestId: REQUEST_1 },
      ]),
      finitePlan([
        { type: "started", requestId: REQUEST_2 },
        { type: "completed", requestId: REQUEST_2 },
      ]),
    );
    coordinator.handle(oldPort, sender(TAB_ID, "https://old.test/article"));
    coordinator.handle(newPort, sender(TAB_ID, "https://new.test/article"));
    oldPort.send({ type: "start-request", request: request() });
    await waitForCalls(provider, 1);
    newPort.send({ type: "start-request", request: request(REQUEST_2) });
    await waitForCalls(provider, 2);
    await vi.waitFor(async () =>
      expect(await sessionRepository.getReaderSession(TAB_ID)).toMatchObject({
        requestId: REQUEST_2,
        origin: "https://new.test",
      }),
    );

    oldPort.disconnect();

    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(sessionRepository.getReaderSession(TAB_ID)).resolves.toMatchObject({
      requestId: REQUEST_2,
      origin: "https://new.test",
    });
    await expect(sessionRepository.getPrivateSource(TAB_ID)).resolves.toMatchObject({
      requestId: REQUEST_2,
      origin: "https://new.test",
    });
  });

  it.each(["retry-request", "follow-up"] as const)(
    "does not let a stale-origin %s command delete newer same-tab state",
    async (type) => {
      const { coordinator, provider, sessionRepository } = createHarness();
      const oldPort = new TestPort();
      const newPort = new TestPort();
      provider.plans.push(
        finitePlan([
          { type: "started", requestId: REQUEST_1 },
          { type: "completed", requestId: REQUEST_1 },
        ]),
        finitePlan([
          { type: "started", requestId: REQUEST_2 },
          {
            type: "delta",
            requestId: REQUEST_2,
            sequence: 0,
            text: "new answer",
          },
          { type: "completed", requestId: REQUEST_2 },
        ]),
      );
      coordinator.handle(oldPort, sender(TAB_ID, "https://old.test/article"));
      coordinator.handle(newPort, sender(TAB_ID, "https://new.test/article"));
      oldPort.send({ type: "start-request", request: request() });
      await waitForCalls(provider, 1);
      newPort.send({ type: "start-request", request: request(REQUEST_2) });
      await waitForCalls(provider, 2);
      await vi.waitFor(async () =>
        expect(await sessionRepository.getReaderSession(TAB_ID)).toMatchObject({
          requestId: REQUEST_2,
          status: "completed",
        }),
      );

      oldPort.send(
        type === "retry-request"
          ? { type, requestId: REQUEST_1 }
          : { type, requestId: REQUEST_1, intent: "why" },
      );

      await vi.waitFor(() =>
        expect(oldPort.posted).toContainEqual({
          type: "command-failed",
          error: expect.objectContaining({ code: "INVALID_REQUEST" }),
        }),
      );
      expect(provider.calls).toHaveLength(2);
      await expect(sessionRepository.getReaderSession(TAB_ID)).resolves.toMatchObject({
        requestId: REQUEST_2,
        origin: "https://new.test",
        answer: "new answer",
      });
      await expect(sessionRepository.getPrivateSource(TAB_ID)).resolves.toMatchObject({
        requestId: REQUEST_2,
        origin: "https://new.test",
      });
    },
  );

  it("aborts on disconnect and removes page-bound private state", async () => {
    const { coordinator, provider, sessionRepository } = createHarness();
    const port = new TestPort();
    provider.plans.push(async function* ({ requestId, signal }) {
      yield { type: "started", requestId };
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      yield { type: "cancelled", requestId };
    });
    coordinator.handle(port, sender());
    port.send({ type: "start-request", request: request() });
    await waitForCalls(provider, 1);

    port.disconnect();

    expect(provider.calls[0]?.signal.aborted).toBe(true);
    await vi.waitFor(async () =>
      expect(await sessionRepository.getPrivateSource(TAB_ID)).toBeUndefined(),
    );
    await vi.waitFor(async () =>
      expect(await sessionRepository.getReaderSession(TAB_ID)).toBeUndefined(),
    );
  });

  it("treats repeated cancellation as an idempotent command", async () => {
    const { coordinator, provider } = createHarness();
    const port = new TestPort();
    provider.plans.push(async function* ({ requestId, signal }) {
      yield { type: "started", requestId };
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      yield { type: "cancelled", requestId };
    });
    coordinator.handle(port, sender());
    port.send({ type: "start-request", request: request() });
    await waitForCalls(provider, 1);

    port.send({ type: "cancel-request", requestId: REQUEST_1 });
    port.send({ type: "cancel-request", requestId: REQUEST_1 });

    await vi.waitFor(() =>
      expect(
        port.posted.filter(
          (message) =>
            message.type === "stream-event" && message.event.type === "cancelled",
        ),
      ).toHaveLength(1),
    );
  });

  it("ignores stale events from a cancelled provider without overwriting new state", async () => {
    const { coordinator, provider, sessionRepository } = createHarness();
    const firstPort = new TestPort();
    const secondPort = new TestPort();
    const leakStaleEvent = deferred<void>();
    provider.plans.push(
      async function* ({ requestId }) {
        yield { type: "started", requestId };
        await leakStaleEvent.promise;
        yield { type: "delta", requestId, sequence: 0, text: "stale secret" };
        yield { type: "completed", requestId };
      },
      finitePlan([
        { type: "started", requestId: REQUEST_2 },
        { type: "delta", requestId: REQUEST_2, sequence: 0, text: "new answer" },
        { type: "completed", requestId: REQUEST_2 },
      ]),
    );
    coordinator.handle(firstPort, sender());
    coordinator.handle(secondPort, sender());
    firstPort.send({ type: "start-request", request: request() });
    await waitForCalls(provider, 1);
    secondPort.send({ type: "start-request", request: request(REQUEST_2) });
    await waitForCalls(provider, 2);
    await vi.waitFor(async () =>
      expect(await sessionRepository.getReaderSession(TAB_ID)).toMatchObject({
        requestId: REQUEST_2,
        answer: "new answer",
      }),
    );

    leakStaleEvent.resolve();

    await vi.waitFor(async () =>
      expect(await sessionRepository.getReaderSession(TAB_ID)).toMatchObject({
        requestId: REQUEST_2,
        answer: "new answer",
        status: "completed",
      }),
    );
    expect(JSON.stringify(secondPort.posted)).not.toContain("stale secret");
  });

  it("maps thrown provider details to a safe failed event", async () => {
    const { coordinator, provider } = createHarness();
    const port = new TestPort();
    provider.plans.push(() => ({
      [Symbol.asyncIterator]() {
        throw new Error("private host and stack details");
      },
    }));
    coordinator.handle(port, sender());

    port.send({ type: "start-request", request: request() });

    await vi.waitFor(() =>
      expect(port.posted).toContainEqual({
        type: "stream-event",
        event: {
          type: "failed",
          requestId: REQUEST_1,
          error: {
            code: "PROVIDER_ERROR",
            message: "The local model provider failed.",
            recoverable: true,
          },
        },
      }),
    );
    expect(JSON.stringify(port.posted)).not.toContain("private host");
  });

  it("retries from private session storage after coordinator suspension", async () => {
    const storage = new MemoryStorageArea();
    const sessionRepository = createSessionRepository(storage);
    await sessionRepository.putReaderSession({
      tabId: TAB_ID,
      requestId: REQUEST_1,
      selectionPreview: "Private source text",
      action: "explain",
      contextIncluded: false,
      status: "failed",
      answer: "",
      lastSequence: -1,
      origin: ORIGIN,
    });
    await sessionRepository.putPrivateSource(TAB_ID, {
      requestId: REQUEST_1,
      selection: "Private source text",
      origin: ORIGIN,
    });
    const provider = new FakeProvider();
    provider.plans.push(
      finitePlan([
        { type: "started", requestId: REQUEST_1 },
        { type: "completed", requestId: REQUEST_1 },
      ]),
    );
    const resumed = new RequestCoordinator({
      provider,
      sessionRepository,
      settingsRepository,
    });
    const port = new TestPort();
    resumed.handle(port, sender());

    port.send({ type: "retry-request", requestId: REQUEST_1 });

    await waitForCalls(provider, 1);
    expect(provider.calls[0]?.request.messages[1]?.content).toContain(
      "<selected_text>Private source text</selected_text>",
    );
  });

  it("builds follow-up from the stored source and bounded public answer only", async () => {
    const { coordinator, provider, sessionRepository } = createHarness();
    await sessionRepository.putReaderSession({
      tabId: TAB_ID,
      requestId: REQUEST_1,
      selectionPreview: "Private source text",
      action: "explain",
      contextIncluded: false,
      status: "completed",
      answer: "Prior bounded answer",
      lastSequence: 0,
      origin: ORIGIN,
    });
    await sessionRepository.putPrivateSource(TAB_ID, {
      requestId: REQUEST_1,
      selection: "Private source text",
      origin: ORIGIN,
    });
    provider.plans.push(
      finitePlan([
        { type: "started", requestId: REQUEST_1 },
        { type: "completed", requestId: REQUEST_1 },
      ]),
    );
    const port = new TestPort();
    coordinator.handle(port, sender());

    port.send({ type: "follow-up", requestId: REQUEST_1, intent: "more-detail" });

    await waitForCalls(provider, 1);
    const prompt = provider.calls[0]?.request.messages[1]?.content;
    expect(prompt).toContain("<selected_text>Private source text</selected_text>");
    expect(prompt).toContain("<prior_answer>Prior bounded answer</prior_answer>");
    expect(prompt).toContain("Requested action: more-detail.");
  });

  it("cancelForTab aborts and removes state for tab-close cleanup", async () => {
    const { coordinator, provider, sessionRepository } = createHarness();
    const port = new TestPort();
    const release = deferred<void>();
    provider.plans.push(async function* ({ requestId }) {
      yield { type: "started", requestId };
      await release.promise;
    });
    coordinator.handle(port, sender());
    port.send({ type: "start-request", request: request() });
    await waitForCalls(provider, 1);

    coordinator.cancelForTab(TAB_ID);

    expect(provider.calls[0]?.signal.aborted).toBe(true);
    await vi.waitFor(async () =>
      expect(await sessionRepository.getPrivateSource(TAB_ID)).toBeUndefined(),
    );
    release.resolve();
  });
});
