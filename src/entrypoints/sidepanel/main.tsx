import { createRoot } from "react-dom/client";
import { browser } from "wxt/browser";
import { SIDE_PANEL_PORT_NAME } from "../../features/reader/background-events";
import { createSidePanelController } from "../../features/reader/sidepanel-controller";
import {
  parseReaderSession,
  type ReaderPortMessage,
} from "../../platform/messaging/contracts";
import type { PortLike } from "../../platform/messaging/port";
import { SidePanelApp } from "./SidePanelApp";
import "./sidepanel.css";

const controller = createSidePanelController({
  async getActiveTabId() {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    return Number.isInteger(tab?.id) ? tab?.id : undefined;
  },
  async getReaderSession(tabId) {
    const key = `reader-session:${tabId}`;
    const stored = await browser.storage.session.get(key);
    return parseReaderSession(stored[key]);
  },
  subscribeToSessionChanges(listener) {
    const onChanged = (changes: Record<string, unknown>, areaName: string): void => {
      if (
        areaName === "session" &&
        Object.keys(changes).some((key) => key.startsWith("reader-session:"))
      ) {
        listener();
      }
    };
    browser.storage.onChanged.addListener(onChanged);
    return () => browser.storage.onChanged.removeListener(onChanged);
  },
  subscribeToActiveTabChanges(listener) {
    const onActivated = (): void => listener();
    browser.tabs.onActivated.addListener(onActivated);
    return () => browser.tabs.onActivated.removeListener(onActivated);
  },
  connectReaderPort() {
    return browser.runtime.connect({
      name: SIDE_PANEL_PORT_NAME,
    }) as unknown as PortLike<ReaderPortMessage>;
  },
});

const root = document.getElementById("root");
if (!root) throw new Error("Side-panel root is unavailable.");

createRoot(root).render(
  <SidePanelApp
    controller={controller}
    copyText={(text) => navigator.clipboard.writeText(text)}
    optionsUrl={browser.runtime.getURL("/options.html")}
  />,
);
