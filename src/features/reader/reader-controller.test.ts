import { describe, expect, it, vi } from "vitest";
import type { SelectionSnapshot } from "../../core/privacy/selection";
import type { ReaderPortMessage } from "../../platform/messaging/contracts";
import type { BackgroundPortMessage } from "../../platform/messaging/contracts";
import type { ReaderInvocationCommand } from "../../platform/messaging/reader-command";
import type { ReaderRuntimeConfig } from "../../platform/messaging/reader-runtime";
import {
  ReaderController,
  type ReaderConnection,
  type ReaderControllerDependencies,
} from "./reader-controller";

const REQUEST_ID = "123e4567-e89b-42d3-a456-426614174000";

function snapshot(text = "A difficult selected sentence."): SelectionSnapshot {
  const anchorElement = document.createElement("p");
  anchorElement.textContent = text;
  document.body.append(anchorElement);
  return {
    text,
    range: document.createRange(),
    rect: new DOMRect(80, 100, 180, 24),
    anchorElement,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

class FakeConnection implements ReaderConnection {
  readonly sent: ReaderPortMessage[] = [];
  disconnected = false;
  private readonly messageListeners = new Set<
    (message: BackgroundPortMessage) => void
  >();
  private readonly disconnectListeners = new Set<() => void>();

  send(message: ReaderPortMessage): void {
    this.sent.push(structuredClone(message));
  }

  subscribe(listener: (message: BackgroundPortMessage) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  subscribeDisconnect(listener: () => void): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  disconnect(): void {
    this.disconnected = true;
  }

  emit(message: BackgroundPortMessage): void {
    for (const listener of this.messageListeners) listener(structuredClone(message));
  }

  suspend(): void {
    for (const listener of this.disconnectListeners) listener();
  }
}

function createHarness(
  options: {
    capture?: SelectionSnapshot;
    blocked?: boolean;
    includeNearbyContext?: boolean;
    getReaderConfig?: () => Promise<ReaderRuntimeConfig>;
    extractNearbyContext?: (
      snapshot: SelectionSnapshot,
      enabled: boolean,
    ) => { text: string; estimatedTokens: number; sourceBlockCount: number };
  } = {},
) {
  const connections: FakeConnection[] = [];
  const frames: FrameRequestCallback[] = [];
  const cancelFrame = vi.fn();
  const restored: SelectionSnapshot[] = [];
  const copied: string[] = [];
  const handoffs: number[] = [];
  const extracted: boolean[] = [];
  let currentSelection = options.capture;
  const dependencies: ReaderControllerDependencies = {
    captureSelection: () => currentSelection,
    getReaderConfig:
      options.getReaderConfig ??
      (async () => ({
        automaticToolbar: true,
        blocked: options.blocked ?? false,
        includeNearbyContext: options.includeNearbyContext ?? false,
      })),
    extractNearbyContext(value, enabled) {
      extracted.push(enabled);
      if (options.extractNearbyContext) {
        return options.extractNearbyContext(value, enabled);
      }
      return {
        text: enabled ? "Nearby paragraph." : "",
        estimatedTokens: enabled ? 4 : 0,
        sourceBlockCount: enabled ? 1 : 0,
      };
    },
    connect() {
      const connection = new FakeConnection();
      connections.push(connection);
      return connection;
    },
    createRequestId: () => REQUEST_ID,
    requestFrame(callback) {
      frames.push(callback);
      return frames.length;
    },
    cancelFrame,
    restoreFocus(value) {
      restored.push(value);
    },
    async writeClipboard(text) {
      copied.push(text);
    },
    async openSidePanel() {
      handoffs.push(1);
    },
    async openOptionsPage() {},
  };
  const controller = new ReaderController(dependencies);
  return {
    controller,
    connections,
    frames,
    cancelFrame,
    restored,
    copied,
    handoffs,
    extracted,
    setSelection(value: SelectionSnapshot | undefined) {
      currentSelection = value;
    },
    flushFrame() {
      const callback = frames.shift();
      if (!callback) throw new Error("No animation frame was scheduled.");
      callback(16);
    },
  };
}

describe("reader controller", () => {
  it("opens actions only after a valid non-blocked selection completes", async () => {
    const selected = snapshot();
    const valid = createHarness({ capture: selected });
    await valid.controller.selectionCompleted();
    expect(valid.controller.getState()).toMatchObject({
      status: "actions",
      selection: selected,
    });

    const empty = createHarness();
    await empty.controller.selectionCompleted();
    expect(empty.controller.getState()).toEqual({ status: "idle" });

    const blocked = createHarness({ capture: selected, blocked: true });
    await blocked.controller.selectionCompleted();
    expect(blocked.controller.getState()).toEqual({ status: "idle" });
  });

  it.each(["escape", "collapse", "blur", "invalidation"] as const)(
    "closes and restores reading focus after %s",
    async (reason) => {
      const selected = snapshot();
      const harness = createHarness({ capture: selected });
      await harness.controller.selectionCompleted();
      if (reason === "collapse") harness.setSelection(undefined);

      harness.controller.closeFor(reason);

      expect(harness.controller.getState()).toEqual({ status: "idle" });
      expect(harness.restored).toEqual([selected]);
    },
  );

  it("closes when the same text is selected from a different DOM context", async () => {
    const first = snapshot("Repeated text");
    const harness = createHarness({ capture: first });
    await harness.controller.selectionCompleted();
    harness.setSelection(snapshot("Repeated text"));

    harness.controller.contextInvalidated();

    expect(harness.controller.getState()).toEqual({ status: "idle" });
    expect(harness.restored).toEqual([first]);
  });

  it("opens one connection and sends one minimal validated request per action", async () => {
    const harness = createHarness({ capture: snapshot() });
    await harness.controller.selectionCompleted();

    harness.controller.startAction("simplify");

    expect(harness.connections).toHaveLength(1);
    expect(harness.connections[0]?.sent).toEqual([
      {
        type: "start-request",
        request: {
          requestId: REQUEST_ID,
          action: "simplify",
          selection: "A difficult selected sentence.",
        },
      },
    ]);
    expect(harness.controller.getState()).toMatchObject({
      status: "connecting",
      requestId: REQUEST_ID,
    });
  });

  it("captures nearby text only after the saved opt-in says true", async () => {
    const off = createHarness({ capture: snapshot() });
    await off.controller.selectionCompleted();
    off.controller.startAction("explain");
    expect(off.extracted).toEqual([false]);
    expect(off.connections[0]?.sent[0]).not.toHaveProperty("request.nearbyContext");

    const on = createHarness({
      capture: snapshot(),
      includeNearbyContext: true,
    });
    await on.controller.selectionCompleted();
    on.controller.startAction("explain");
    expect(on.extracted).toEqual([true]);
    expect(on.connections[0]?.sent[0]).toMatchObject({
      request: { nearbyContext: "Nearby paragraph." },
    });
  });

  it("retries a context preflight failure with the same selection and no nearby context", async () => {
    const selected = snapshot();
    let extractionAttempts = 0;
    const harness = createHarness({
      capture: selected,
      includeNearbyContext: true,
      extractNearbyContext(_value, enabled) {
        extractionAttempts += 1;
        if (extractionAttempts === 1) throw new Error("Context is too large.");
        return {
          text: enabled ? "This must not be sent on retry." : "",
          estimatedTokens: 0,
          sourceBlockCount: 0,
        };
      },
    });
    await harness.controller.selectionCompleted();

    harness.controller.startAction("explain");

    expect(harness.controller.getState()).toMatchObject({
      status: "failed",
      error: { code: "CONTEXT_TOO_LARGE", recoverable: true },
    });
    expect(harness.controller.retry()).toBe(true);
    expect(harness.connections[0]?.sent).toEqual([
      {
        type: "start-request",
        request: {
          requestId: REQUEST_ID,
          action: "explain",
          selection: selected.text,
        },
      },
    ]);
    expect(harness.extracted).toEqual([true]);
  });

  it("sends Stop once and cancels before a replacement selection", async () => {
    const first = snapshot("First selection");
    const harness = createHarness({ capture: first });
    await harness.controller.selectionCompleted();
    harness.controller.startAction("explain");
    harness.controller.stop();
    harness.controller.stop();
    expect(harness.connections[0]?.sent).toHaveLength(2);
    expect(harness.connections[0]?.sent[1]).toEqual({
      type: "cancel-request",
      requestId: REQUEST_ID,
    });

    const second = snapshot("Replacement selection");
    harness.setSelection(second);
    await harness.controller.selectionCompleted();

    expect(harness.connections[0]?.sent.at(-1)).toEqual({
      type: "cancel-request",
      requestId: REQUEST_ID,
    });
    expect(harness.connections[0]?.disconnected).toBe(true);
    expect(harness.controller.getState()).toMatchObject({
      status: "actions",
      selection: second,
    });
  });

  it("buffers accepted contiguous deltas for one animation frame", async () => {
    const harness = createHarness({ capture: snapshot() });
    await harness.controller.selectionCompleted();
    harness.controller.startAction("explain");
    const port = harness.connections[0];
    port?.emit({
      type: "stream-event",
      event: { type: "started", requestId: REQUEST_ID },
    });
    port?.emit({
      type: "stream-event",
      event: { type: "delta", requestId: REQUEST_ID, sequence: 0, text: "One " },
    });
    port?.emit({
      type: "stream-event",
      event: { type: "delta", requestId: REQUEST_ID, sequence: 1, text: "frame" },
    });

    expect(harness.frames).toHaveLength(1);
    expect(harness.controller.getState()).toMatchObject({
      status: "generating",
      answer: "",
    });
    harness.flushFrame();
    expect(harness.controller.getState()).toMatchObject({
      status: "generating",
      answer: "One frame",
    });
  });

  it("cancels a scheduled animation frame when a terminal event flushes deltas", async () => {
    const harness = createHarness({ capture: snapshot() });
    await harness.controller.selectionCompleted();
    harness.controller.startAction("explain");
    const port = harness.connections[0];
    port?.emit({
      type: "stream-event",
      event: { type: "started", requestId: REQUEST_ID },
    });
    port?.emit({
      type: "stream-event",
      event: { type: "delta", requestId: REQUEST_ID, sequence: 0, text: "Final" },
    });

    port?.emit({
      type: "stream-event",
      event: { type: "completed", requestId: REQUEST_ID },
    });

    expect(harness.controller.getState()).toMatchObject({
      status: "complete",
      answer: "Final",
    });
    expect(harness.cancelFrame).toHaveBeenCalledWith(1);
  });

  it("rejects stale, duplicate, and out-of-order stream events", async () => {
    const harness = createHarness({ capture: snapshot() });
    await harness.controller.selectionCompleted();
    harness.controller.startAction("explain");
    const port = harness.connections[0];
    port?.emit({
      type: "stream-event",
      event: { type: "started", requestId: REQUEST_ID },
    });
    for (const event of [
      { type: "delta", requestId: crypto.randomUUID(), sequence: 0, text: "stale" },
      { type: "delta", requestId: REQUEST_ID, sequence: 1, text: "future" },
      { type: "delta", requestId: REQUEST_ID, sequence: 0, text: "kept" },
      { type: "delta", requestId: REQUEST_ID, sequence: 0, text: "duplicate" },
    ] as const) {
      port?.emit({ type: "stream-event", event });
    }
    harness.flushFrame();
    expect(harness.controller.getState()).toMatchObject({ answer: "kept" });
  });

  it("preserves partial output and exposes recovery after disconnect", async () => {
    const harness = createHarness({ capture: snapshot() });
    await harness.controller.selectionCompleted();
    harness.controller.startAction("explain");
    const port = harness.connections[0];
    port?.emit({
      type: "stream-event",
      event: { type: "started", requestId: REQUEST_ID },
    });
    port?.emit({
      type: "stream-event",
      event: { type: "delta", requestId: REQUEST_ID, sequence: 0, text: "Partial" },
    });
    harness.flushFrame();
    port?.suspend();

    expect(harness.controller.getState()).toMatchObject({
      status: "failed",
      answer: "Partial",
      error: { recoverable: true },
    });
    harness.controller.retry();
    expect(harness.connections).toHaveLength(2);
    expect(harness.connections[1]?.sent).toEqual([
      { type: "retry-request", requestId: REQUEST_ID },
    ]);
  });

  it("permits typed follow-ups only from completed output", async () => {
    const harness = createHarness({ capture: snapshot() });
    await harness.controller.selectionCompleted();
    harness.controller.startAction("explain");
    expect(harness.controller.followUp("why")).toBe(false);
    const port = harness.connections[0];
    port?.emit({
      type: "stream-event",
      event: { type: "started", requestId: REQUEST_ID },
    });
    port?.emit({
      type: "stream-event",
      event: { type: "delta", requestId: REQUEST_ID, sequence: 0, text: "Answer" },
    });
    port?.emit({
      type: "stream-event",
      event: { type: "completed", requestId: REQUEST_ID },
    });
    expect(harness.controller.getState()).toMatchObject({
      status: "complete",
      answer: "Answer",
    });
    expect(harness.controller.followUp("why")).toBe(true);
    expect(port?.sent.at(-1)).toEqual({
      type: "follow-up",
      requestId: REQUEST_ID,
      intent: "why",
    });
  });

  it("handles explicit invocation and delegates clipboard and side-panel privileges", async () => {
    const harness = createHarness({ capture: snapshot("Current DOM selection") });
    const command: ReaderInvocationCommand = {
      type: "selection-action",
      action: "translate",
      selectionText: "Trusted user-selected menu text",
    };
    await harness.controller.handleInvocation(command);
    expect(harness.connections[0]?.sent[0]).toMatchObject({
      request: {
        action: "translate",
        selection: "Trusted user-selected menu text",
      },
    });
    harness.connections[0]?.emit({
      type: "stream-event",
      event: { type: "started", requestId: REQUEST_ID },
    });
    harness.connections[0]?.emit({
      type: "stream-event",
      event: { type: "delta", requestId: REQUEST_ID, sequence: 0, text: "Vertaling" },
    });
    harness.flushFrame();
    await harness.controller.copyAnswer();
    await harness.controller.openSidePanel();
    expect(harness.copied).toEqual(["Vertaling"]);
    expect(harness.handoffs).toEqual([1]);
  });

  it("lets the newest explicit invocation own state when an earlier config response arrives late", async () => {
    const firstConfig = deferred<ReaderRuntimeConfig>();
    const secondConfig = deferred<ReaderRuntimeConfig>();
    const configs = [firstConfig, secondConfig];
    let configIndex = 0;
    const harness = createHarness({
      capture: snapshot("Current page selection"),
      getReaderConfig: () => configs[configIndex++]!.promise,
    });
    const first = harness.controller.handleInvocation({
      type: "selection-action",
      action: "explain",
      selectionText: "First explicit selection",
    });
    const second = harness.controller.handleInvocation({
      type: "selection-action",
      action: "translate",
      selectionText: "Second explicit selection",
    });

    secondConfig.resolve({
      automaticToolbar: true,
      includeNearbyContext: false,
      blocked: false,
    });
    await second;
    firstConfig.resolve({
      automaticToolbar: true,
      includeNearbyContext: false,
      blocked: false,
    });
    await first;

    expect(harness.connections).toHaveLength(1);
    expect(harness.connections[0]?.sent[0]).toMatchObject({
      request: { action: "translate", selection: "Second explicit selection" },
    });
    expect(harness.controller.getState()).toMatchObject({
      status: "connecting",
      action: "translate",
      preview: "Second explicit selection",
    });
  });

  it("lets a newer automatic selection suppress a late explicit invocation", async () => {
    const explicitConfig = deferred<ReaderRuntimeConfig>();
    const automaticConfig = deferred<ReaderRuntimeConfig>();
    const configs = [explicitConfig, automaticConfig];
    let configIndex = 0;
    const explicitSelection = snapshot("Explicit page selection");
    const automaticSelection = snapshot("New automatic selection");
    const harness = createHarness({
      capture: explicitSelection,
      getReaderConfig: () => configs[configIndex++]!.promise,
    });
    const explicit = harness.controller.handleInvocation({
      type: "selection-action",
      action: "explain",
      selectionText: "Explicit action text",
    });
    harness.setSelection(automaticSelection);
    const automatic = harness.controller.selectionCompleted();

    automaticConfig.resolve({
      automaticToolbar: true,
      includeNearbyContext: false,
      blocked: false,
    });
    await automatic;
    explicitConfig.resolve({
      automaticToolbar: true,
      includeNearbyContext: false,
      blocked: false,
    });
    await explicit;

    expect(harness.connections).toHaveLength(0);
    expect(harness.controller.getState()).toMatchObject({
      status: "actions",
      selection: automaticSelection,
    });
  });
});
