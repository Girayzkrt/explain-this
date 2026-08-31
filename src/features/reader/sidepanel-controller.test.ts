import { describe, expect, it } from "vitest";
import type { FollowUpIntent } from "../../core/requests/types";
import type {
  BackgroundPortMessage,
  ReaderPortMessage,
} from "../../platform/messaging/contracts";
import type { ListenerSet, PortLike } from "../../platform/messaging/port";
import type { ReaderSession } from "./session";
import {
  createSidePanelController,
  type SidePanelDependencies,
} from "./sidepanel-controller";

const REQUEST_ID = "123e4567-e89b-42d3-a456-426614174014";

class TestListeners<T> implements ListenerSet<T> {
  readonly values = new Set<T>();

  addListener(listener: T): void {
    this.values.add(listener);
  }

  removeListener(listener: T): void {
    this.values.delete(listener);
  }
}

class TestPort implements PortLike<ReaderPortMessage> {
  readonly sent: ReaderPortMessage[] = [];
  readonly onMessage = new TestListeners<(message: unknown) => void>();
  readonly onDisconnect = new TestListeners<() => void>();
  disconnected = false;
  postError: Error | undefined;

  postMessage(message: ReaderPortMessage): void {
    if (this.postError) throw this.postError;
    this.sent.push(structuredClone(message));
  }

  disconnect(): void {
    if (this.disconnected) return;
    this.disconnected = true;
    for (const listener of [...this.onDisconnect.values]) listener();
  }

  emit(message: BackgroundPortMessage): void {
    for (const listener of [...this.onMessage.values]) listener(message);
  }
}

function session(tabId: number, overrides: Partial<ReaderSession> = {}): ReaderSession {
  return {
    tabId,
    requestId: REQUEST_ID,
    selectionPreview: "A compact passage selected in the active article.",
    action: "explain",
    contextIncluded: true,
    status: "completed",
    answer: "A **local** explanation.",
    lastSequence: 0,
    origin: "https://article.example",
    ...overrides,
  };
}

function createHarness(initialTabId: number | undefined = 7) {
  let activeTabId: number | undefined = initialTabId;
  const sessions = new Map<number, ReaderSession>();
  const sessionReads: number[] = [];
  const sessionListeners = new Set<() => void>();
  const tabListeners = new Set<() => void>();
  const ports: TestPort[] = [];

  const dependencies: SidePanelDependencies = {
    async getActiveTabId() {
      return activeTabId;
    },
    async getReaderSession(tabId) {
      sessionReads.push(tabId);
      const stored = sessions.get(tabId);
      return stored ? structuredClone(stored) : undefined;
    },
    subscribeToSessionChanges(listener) {
      sessionListeners.add(listener);
      return () => sessionListeners.delete(listener);
    },
    subscribeToActiveTabChanges(listener) {
      tabListeners.add(listener);
      return () => tabListeners.delete(listener);
    },
    connectReaderPort() {
      const port = new TestPort();
      ports.push(port);
      return port;
    },
  };
  const controller = createSidePanelController(dependencies);

  return {
    controller,
    ports,
    sessionReads,
    sessions,
    setActiveTabId(tabId: number | undefined) {
      activeTabId = tabId;
    },
    async activate(tabId: number | undefined) {
      activeTabId = tabId;
      for (const listener of [...tabListeners]) listener();
      await Promise.resolve();
      await Promise.resolve();
    },
    async changeSession(tabId: number, value: ReaderSession | undefined) {
      if (value) sessions.set(tabId, value);
      else sessions.delete(tabId);
      for (const listener of [...sessionListeners]) listener();
      await Promise.resolve();
      await Promise.resolve();
    },
    get listenerCounts() {
      return { sessions: sessionListeners.size, tabs: tabListeners.size };
    },
  };
}

describe("side-panel controller", () => {
  it("loads only the safe session for the numeric active tab", async () => {
    const harness = createHarness(7);
    harness.sessions.set(7, session(7));

    await harness.controller.load();

    expect(harness.sessionReads).toEqual([7]);
    expect(harness.controller.getSnapshot()).toEqual({
      status: "session",
      session: session(7),
    });
    expect(JSON.stringify(harness.controller.getSnapshot())).not.toContain(
      "Private source",
    );
  });

  it("switches sessions on tab activation and shows instructions without one", async () => {
    const harness = createHarness(7);
    harness.sessions.set(7, session(7));
    harness.sessions.set(
      8,
      session(8, { selectionPreview: "The other tab's passage." }),
    );
    await harness.controller.load();

    await harness.activate(8);
    expect(harness.controller.getSnapshot()).toMatchObject({
      status: "session",
      session: { tabId: 8, selectionPreview: "The other tab's passage." },
    });

    await harness.activate(9);
    expect(harness.controller.getSnapshot()).toEqual({ status: "empty" });
  });

  it("reloads the active safe session after storage-session changes", async () => {
    const harness = createHarness(7);
    harness.sessions.set(7, session(7, { status: "streaming", answer: "Part" }));
    await harness.controller.load();

    await harness.changeSession(
      7,
      session(7, { status: "completed", answer: "Part complete." }),
    );

    expect(harness.controller.getSnapshot()).toMatchObject({
      status: "session",
      session: { status: "completed", answer: "Part complete." },
    });
    expect(harness.sessionReads).toEqual([7, 7]);
  });

  it("disconnects an existing port when a session refresh resolves a different tab", async () => {
    const harness = createHarness(7);
    harness.sessions.set(7, session(7));
    harness.sessions.set(8, session(8));
    await harness.controller.load();
    harness.controller.followUp("why");

    harness.setActiveTabId(8);
    await harness.changeSession(8, session(8, { answer: "Updated." }));

    expect(harness.ports[0]?.disconnected).toBe(true);
    expect(harness.controller.getSnapshot()).toMatchObject({
      status: "session",
      session: { tabId: 8, answer: "Updated." },
    });
  });

  it("invalidates displayed actions before an active-tab refresh resolves", async () => {
    const tabListeners = new Set<() => void>();
    const port = new TestPort();
    let resolveActiveTab: ((tabId: number | undefined) => void) | undefined;
    let activeTabCalls = 0;
    const controller = createSidePanelController({
      async getActiveTabId() {
        activeTabCalls += 1;
        if (activeTabCalls === 1) return 7;
        return new Promise((resolve) => {
          resolveActiveTab = resolve;
        });
      },
      async getReaderSession(tabId) {
        return tabId === 7 ? session(7) : session(8);
      },
      subscribeToSessionChanges() {
        return () => undefined;
      },
      subscribeToActiveTabChanges(listener) {
        tabListeners.add(listener);
        return () => tabListeners.delete(listener);
      },
      connectReaderPort() {
        return port;
      },
    });
    await controller.load();
    controller.followUp("why");

    for (const listener of tabListeners) listener();
    controller.followUp("why");

    expect(port.disconnected).toBe(true);
    expect(port.sent).toEqual([
      { type: "follow-up", requestId: REQUEST_ID, intent: "why" },
    ]);
    resolveActiveTab?.(8);
    await Promise.resolve();
    await Promise.resolve();
  });

  it("disconnects a failed port before delivering the action through a replacement", async () => {
    const firstPort = new TestPort();
    firstPort.postError = new Error("first post failed");
    const replacementPort = new TestPort();
    let connections = 0;
    const controller = createSidePanelController({
      async getActiveTabId() {
        return 7;
      },
      async getReaderSession() {
        return session(7);
      },
      subscribeToSessionChanges() {
        return () => undefined;
      },
      subscribeToActiveTabChanges() {
        return () => undefined;
      },
      connectReaderPort() {
        connections += 1;
        return connections === 1 ? firstPort : replacementPort;
      },
    });
    await controller.load();

    controller.followUp("why");

    expect(firstPort.disconnected).toBe(true);
    expect(replacementPort.sent).toEqual([
      { type: "follow-up", requestId: REQUEST_ID, intent: "why" },
    ]);
    expect(controller.getSnapshot()).toEqual({
      status: "session",
      session: session(7),
    });
  });

  it("shows a fixed recoverable action error when replacement delivery also fails", async () => {
    const firstPort = new TestPort();
    firstPort.postError = new Error("first transport detail");
    const replacementPort = new TestPort();
    replacementPort.postError = new Error("second transport detail");
    const recoveredPort = new TestPort();
    let connections = 0;
    const controller = createSidePanelController({
      async getActiveTabId() {
        return 7;
      },
      async getReaderSession() {
        return session(7);
      },
      subscribeToSessionChanges() {
        return () => undefined;
      },
      subscribeToActiveTabChanges() {
        return () => undefined;
      },
      connectReaderPort() {
        connections += 1;
        return connections === 1
          ? firstPort
          : connections === 2
            ? replacementPort
            : recoveredPort;
      },
    });
    await controller.load();

    expect(() => controller.followUp("why")).not.toThrow();

    expect(firstPort.disconnected).toBe(true);
    expect(replacementPort.disconnected).toBe(true);
    expect(controller.getSnapshot()).toMatchObject({
      status: "session",
      actionError: {
        code: "PROVIDER_ERROR",
        message: "The side panel connection was interrupted. Try the action again.",
        recoverable: true,
      },
    });
    expect(JSON.stringify(controller.getSnapshot())).not.toContain("transport detail");

    controller.followUp("why");

    expect(recoveredPort.sent).toEqual([
      { type: "follow-up", requestId: REQUEST_ID, intent: "why" },
    ]);
    expect(controller.getSnapshot()).toEqual({
      status: "session",
      session: session(7),
    });
  });

  it("falls back to instructions when active-tab resolution is temporarily unavailable", async () => {
    const dependencies: SidePanelDependencies = {
      async getActiveTabId() {
        throw new Error("tabs unavailable");
      },
      async getReaderSession() {
        throw new Error("must not read without a tab");
      },
      subscribeToSessionChanges() {
        return () => undefined;
      },
      subscribeToActiveTabChanges() {
        return () => undefined;
      },
      connectReaderPort() {
        return new TestPort();
      },
    };
    const controller = createSidePanelController(dependencies);

    await expect(controller.load()).resolves.toBeUndefined();

    expect(controller.getSnapshot()).toEqual({ status: "empty" });
  });

  it("sends exact typed actions and reconnects after suspension", async () => {
    const cases: Array<{
      act(controller: ReturnType<typeof createSidePanelController>): void;
      expected: ReaderPortMessage;
      state?: Partial<ReaderSession>;
    }> = [
      {
        act: (controller) => controller.stop(),
        expected: { type: "cancel-request", requestId: REQUEST_ID },
        state: { status: "streaming" },
      },
      {
        act: (controller) => controller.retry(),
        expected: { type: "retry-request", requestId: REQUEST_ID },
        state: { status: "failed" },
      },
      ...(
        [
          ["simpler", "simpler"],
          ["more-detail", "more-detail"],
          ["why", "why"],
          ["another-example", "another-example"],
        ] as const satisfies ReadonlyArray<readonly [FollowUpIntent, FollowUpIntent]>
      ).map(([intent]) => ({
        act: (controller: ReturnType<typeof createSidePanelController>) =>
          controller.followUp(intent),
        expected: { type: "follow-up" as const, requestId: REQUEST_ID, intent },
      })),
    ];

    for (const testCase of cases) {
      const harness = createHarness(7);
      harness.sessions.set(7, session(7, testCase.state));
      await harness.controller.load();

      testCase.act(harness.controller);
      expect(harness.ports[0]?.sent).toEqual([testCase.expected]);
      harness.ports[0]?.disconnect();
      testCase.act(harness.controller);

      expect(harness.ports).toHaveLength(2);
      expect(harness.ports[1]?.sent).toEqual([testCase.expected]);
    }
  });

  it("turns an expired stored-source failure into selection guidance", async () => {
    const harness = createHarness(7);
    harness.sessions.set(7, session(7));
    await harness.controller.load();
    harness.controller.followUp("why");

    harness.ports[0]?.emit({
      type: "command-failed",
      error: {
        code: "INVALID_REQUEST",
        message: "The stored reading request is unavailable.",
        recoverable: false,
      },
    });

    expect(harness.controller.getSnapshot()).toMatchObject({
      status: "session",
      actionError: {
        code: "INVALID_REQUEST",
        message: expect.stringMatching(/select the passage again/i),
      },
    });
  });

  it("disposes tab, storage, and port listeners cleanly", async () => {
    const harness = createHarness(7);
    harness.sessions.set(7, session(7));
    await harness.controller.load();
    harness.controller.followUp("simpler");

    harness.controller.dispose();

    expect(harness.listenerCounts).toEqual({ sessions: 0, tabs: 0 });
    expect(harness.ports[0]?.disconnected).toBe(true);
    expect(harness.ports[0]?.onMessage.values.size).toBe(0);
    expect(harness.ports[0]?.onDisconnect.values.size).toBe(0);
  });
});
