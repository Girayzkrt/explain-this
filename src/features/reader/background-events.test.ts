import { describe, expect, it, vi } from "vitest";
import type { PortLike, TrustedPortSender } from "../../platform/messaging/port";
import {
  createBackgroundHandlers,
  initializeBackgroundServices,
  type BackgroundDependencies,
  type ContextMenuCreateData,
} from "./background-events";

class FakeListenerSet<T> {
  readonly listeners = new Set<T>();

  addListener(listener: T): void {
    this.listeners.add(listener);
  }

  removeListener(listener: T): void {
    this.listeners.delete(listener);
  }
}

class FakePort implements PortLike {
  readonly onMessage = new FakeListenerSet<(message: unknown) => void>();
  readonly onDisconnect = new FakeListenerSet<() => void>();
  readonly posted: unknown[] = [];
  disconnected = false;

  constructor(
    readonly name: string,
    readonly sender?: TrustedPortSender,
  ) {}

  postMessage(message: never): void {
    this.posted.push(message);
  }

  disconnect(): void {
    this.disconnected = true;
  }

  emitDisconnect(): void {
    for (const listener of [...this.onDisconnect.listeners]) listener();
  }
}

function createHarness() {
  const menus: ContextMenuCreateData[] = [];
  let removeAllCalls = 0;
  const openedOptions: number[] = [];
  const injected: Array<{ tabId: number; pageUrl: string }> = [];
  const invalidatedTabs: number[] = [];
  const forgottenTabs: number[] = [];
  const sent: Array<{ tabId: number; message: unknown }> = [];
  const coordinatedPorts: PortLike[] = [];
  const cancelledTabs: number[] = [];
  const panelBehaviors: Array<{ openPanelOnActionClick: true }> = [];
  let restoreAutomaticAccessCalls = 0;
  let activeTabs: Array<{
    id?: number | undefined;
    url?: string | undefined;
  }> = [{ id: 17, url: "https://trusted.example/article" }];

  const dependencies: BackgroundDependencies = {
    contextMenus: {
      async removeAll() {
        removeAllCalls += 1;
        menus.splice(0);
      },
      create(data) {
        menus.push(data);
      },
    },
    runtime: {
      async openOptionsPage() {
        openedOptions.push(1);
      },
    },
    tabs: {
      async queryActive() {
        return activeTabs;
      },
      async sendMessage(tabId, message) {
        sent.push({ tabId, message });
      },
    },
    sidePanel: {
      async setPanelBehavior(behavior) {
        panelBehaviors.push(behavior);
      },
    },
    readerAccess: {
      async injectForExplicitAction(tabId, pageUrl) {
        injected.push({ tabId, pageUrl });
      },
      invalidateExplicitInjection(tabId) {
        invalidatedTabs.push(tabId);
      },
      forgetExplicitInjection(tabId) {
        forgottenTabs.push(tabId);
      },
      async restoreAutomaticAccess() {
        restoreAutomaticAccessCalls += 1;
      },
    },
    coordinator: {
      handle(port) {
        coordinatedPorts.push(port);
      },
      async cancelForTab(tabId) {
        cancelledTabs.push(tabId);
      },
    },
  };

  return {
    handlers: createBackgroundHandlers(dependencies),
    dependencies,
    menus,
    openedOptions,
    injected,
    invalidatedTabs,
    forgottenTabs,
    sent,
    coordinatedPorts,
    cancelledTabs,
    panelBehaviors,
    get removeAllCalls() {
      return removeAllCalls;
    },
    get restoreAutomaticAccessCalls() {
      return restoreAutomaticAccessCalls;
    },
    setActiveTabs(tabs: typeof activeTabs) {
      activeTabs = tabs;
    },
  };
}

describe("background reader events", () => {
  it("creates one parent and four selection actions on installation", async () => {
    const harness = createHarness();

    await harness.handlers.onInstalled({ reason: "install" });

    expect(harness.removeAllCalls).toBe(1);
    expect(harness.menus).toEqual([
      { id: "explain-this", title: "Explain This", contexts: ["selection"] },
      {
        id: "explain",
        parentId: "explain-this",
        title: "Explain",
        contexts: ["selection"],
      },
      {
        id: "simplify",
        parentId: "explain-this",
        title: "Simplify",
        contexts: ["selection"],
      },
      {
        id: "translate",
        parentId: "explain-this",
        title: "Translate",
        contexts: ["selection"],
      },
      {
        id: "example",
        parentId: "explain-this",
        title: "Give an example",
        contexts: ["selection"],
      },
    ]);
  });

  it("opens options only for the first installation", async () => {
    const harness = createHarness();

    await harness.handlers.onInstalled({ reason: "install" });
    await harness.handlers.onInstalled({ reason: "update" });

    expect(harness.openedOptions).toHaveLength(1);
  });

  it("recreates menus idempotently after an update", async () => {
    const harness = createHarness();

    await harness.handlers.onInstalled({ reason: "install" });
    await harness.handlers.onInstalled({ reason: "update" });

    expect(harness.removeAllCalls).toBe(2);
    expect(harness.menus).toHaveLength(5);
    expect(harness.menus.map((menu) => menu.id)).toEqual([
      "explain-this",
      "explain",
      "simplify",
      "translate",
      "example",
    ]);
  });

  it("injects from the trusted tab and forwards only the selected action data", async () => {
    const harness = createHarness();

    await harness.handlers.onContextMenuClick(
      {
        menuItemId: "simplify",
        pageUrl: "https://untrusted-click-metadata.example/ignored",
        selectionText: "Dense selected sentence",
      },
      { id: 23, url: "https://trusted.example/article" },
    );

    expect(harness.injected).toEqual([
      { tabId: 23, pageUrl: "https://trusted.example/article" },
    ]);
    expect(harness.sent).toEqual([
      {
        tabId: 23,
        message: {
          type: "selection-action",
          action: "simplify",
          selectionText: "Dense selected sentence",
        },
      },
    ]);
    expect(JSON.stringify(harness.sent)).not.toContain(
      "untrusted-click-metadata.example",
    );
  });

  it("rejects unsupported context-menu pages before injection", async () => {
    const harness = createHarness();

    await harness.handlers.onContextMenuClick(
      {
        menuItemId: "explain",
        pageUrl: "chrome://settings/",
        selectionText: "Private setting",
      },
      { id: 23, url: "https://trusted.example/article" },
    );

    expect(harness.injected).toEqual([]);
    expect(harness.sent).toEqual([]);
  });

  it("captures the active tab selection for the Explain keyboard command", async () => {
    const harness = createHarness();

    await harness.handlers.onCommand("explain-selection");

    expect(harness.injected).toEqual([
      { tabId: 17, pageUrl: "https://trusted.example/article" },
    ]);
    expect(harness.sent).toEqual([
      {
        tabId: 17,
        message: { type: "capture-current-selection", action: "explain" },
      },
    ]);
  });

  it("ignores unknown commands and active tabs without trusted identity", async () => {
    const harness = createHarness();
    harness.setActiveTabs([{ id: undefined, url: undefined }]);

    await harness.handlers.onCommand("unknown-command");
    await harness.handlers.onCommand("explain-selection");

    expect(harness.injected).toEqual([]);
    expect(harness.sent).toEqual([]);
  });

  it("configures action clicks to open the side panel and restores access", async () => {
    const harness = createHarness();

    await initializeBackgroundServices(harness.dependencies);

    expect(harness.panelBehaviors).toEqual([{ openPanelOnActionClick: true }]);
    expect(harness.restoreAutomaticAccessCalls).toBe(1);
  });

  it("aborts state and terminally forgets injection lifecycle on tab removal", async () => {
    const harness = createHarness();
    const port = new FakePort("explain-this-reader", {
      origin: "https://trusted.example",
      tab: { id: 29, url: "https://trusted.example/article" },
    });
    harness.handlers.onPortConnected(port);

    await harness.handlers.onTabRemoved(29);
    port.emitDisconnect();

    expect(harness.cancelledTabs).toEqual([29]);
    expect(harness.forgottenTabs).toEqual([29]);
    expect(harness.invalidatedTabs).toEqual([]);
  });

  it("routes only the approved reader port from a valid tab", () => {
    const harness = createHarness();
    const approved = new FakePort("explain-this-reader", {
      origin: "https://trusted.example",
      tab: { id: 7, url: "https://trusted.example/article" },
    });
    const wrongName = new FakePort("options-page", {
      origin: "https://trusted.example",
      tab: { id: 7, url: "https://trusted.example/article" },
    });
    const missingTab = new FakePort("explain-this-reader", {
      origin: "https://trusted.example",
    });

    harness.handlers.onPortConnected(approved);
    harness.handlers.onPortConnected(wrongName);
    harness.handlers.onPortConnected(missingTab);
    wrongName.emitDisconnect();
    missingTab.emitDisconnect();

    expect(harness.coordinatedPorts).toEqual([approved]);
    expect(harness.invalidatedTabs).toEqual([]);
  });

  it("lets only the latest same-tab reader port invalidate on disconnect", () => {
    const harness = createHarness();
    const olderPort = new FakePort("explain-this-reader", {
      origin: "https://trusted.example",
      tab: { id: 7, url: "https://trusted.example/article" },
    });
    const newerPort = new FakePort("explain-this-reader", {
      origin: "https://trusted.example",
      tab: { id: 7, url: "https://trusted.example/next" },
    });

    harness.handlers.onPortConnected(olderPort);
    harness.handlers.onPortConnected(newerPort);
    olderPort.emitDisconnect();

    expect(harness.invalidatedTabs).toEqual([]);

    newerPort.emitDisconnect();

    expect(harness.invalidatedTabs).toEqual([7]);
  });

  it("observes startup service failures without skipping sibling initialization", async () => {
    const harness = createHarness();
    const failure = new Error("side panel unavailable");
    harness.dependencies.sidePanel.setPanelBehavior = vi
      .fn()
      .mockRejectedValue(failure);

    await expect(initializeBackgroundServices(harness.dependencies)).rejects.toBe(
      failure,
    );
    expect(harness.restoreAutomaticAccessCalls).toBe(1);
  });
});
