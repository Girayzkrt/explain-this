import type { ReadingAction } from "../../core/requests/types";
import type { PortLike, TrustedPortSender } from "../../platform/messaging/port";
import type { ReaderInvocationCommand } from "../../platform/messaging/reader-command";
import type { SettingsRepository } from "../../platform/storage/settings-repository";

export const READER_PORT_NAME = "explain-this-reader";

const MENU_PARENT_ID = "explain-this";
const EXPLAIN_COMMAND = "explain-selection";
const readerActions = ["explain", "simplify", "translate", "example"] as const;

export interface RuntimeInstalledDetails {
  reason: "install" | "update" | "shared_module_update" | "chrome_update";
}

export interface ContextMenuClickData {
  menuItemId: number | string;
  pageUrl?: string | undefined;
  selectionText?: string | undefined;
}

export interface BrowserTab {
  id?: number | undefined;
  url?: string | undefined;
}

export interface BrowserPort extends PortLike {
  name: string;
  sender?: TrustedPortSender | undefined;
}

export interface ContextMenuCreateData {
  id: string;
  title: string;
  contexts: ["selection"];
  parentId?: string;
}

export interface BackgroundDependencies {
  contextMenus: {
    removeAll(): Promise<void>;
    create(data: ContextMenuCreateData): void;
  };
  runtime: {
    openOptionsPage(): Promise<void>;
  };
  tabs: {
    queryActive(): Promise<BrowserTab[]>;
    sendMessage(tabId: number, message: ReaderInvocationCommand): Promise<void>;
  };
  sidePanel: {
    setPanelBehavior(behavior: { openPanelOnActionClick: true }): Promise<void>;
  };
  readerAccess: {
    injectForExplicitAction(tabId: number, pageUrl: string): Promise<void>;
    invalidateExplicitInjection(tabId: number): void;
    forgetExplicitInjection(tabId: number): void;
    restoreAutomaticAccess(): Promise<boolean>;
    disableAutomaticAccess(): Promise<void>;
  };
  settingsRepository: Pick<SettingsRepository, "get" | "update">;
  coordinator: {
    handle(port: PortLike, sender: TrustedPortSender): void;
    cancelForTab(tabId: number): Promise<void>;
  };
}

export interface BackgroundHandlers {
  onInstalled(details: RuntimeInstalledDetails): Promise<void>;
  onContextMenuClick(info: ContextMenuClickData, tab?: BrowserTab): Promise<void>;
  onCommand(command: string): Promise<void>;
  onTabRemoved(tabId: number): Promise<void>;
  onPortConnected(port: BrowserPort): void;
}

const menuItems: readonly ContextMenuCreateData[] = [
  { id: MENU_PARENT_ID, title: "Explain This", contexts: ["selection"] },
  {
    id: "explain",
    parentId: MENU_PARENT_ID,
    title: "Explain",
    contexts: ["selection"],
  },
  {
    id: "simplify",
    parentId: MENU_PARENT_ID,
    title: "Simplify",
    contexts: ["selection"],
  },
  {
    id: "translate",
    parentId: MENU_PARENT_ID,
    title: "Translate",
    contexts: ["selection"],
  },
  {
    id: "example",
    parentId: MENU_PARENT_ID,
    title: "Give an example",
    contexts: ["selection"],
  },
];

function toReaderAction(menuItemId: number | string): ReadingAction | undefined {
  return typeof menuItemId === "string" &&
    readerActions.includes(menuItemId as ReadingAction)
    ? (menuItemId as ReadingAction)
    : undefined;
}

function supportedPageUrl(pageUrl: string | undefined): pageUrl is string {
  if (!pageUrl) return false;
  try {
    const protocol = new URL(pageUrl).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function trustedTab(tab: BrowserTab | undefined): tab is BrowserTab & {
  id: number;
  url: string;
} {
  return Number.isInteger(tab?.id) && (tab?.id ?? 0) > 0 && supportedPageUrl(tab?.url);
}

async function recreateMenus(dependencies: BackgroundDependencies): Promise<void> {
  await dependencies.contextMenus.removeAll();
  for (const item of menuItems) dependencies.contextMenus.create({ ...item });
}

export function createBackgroundHandlers(
  dependencies: BackgroundDependencies,
): BackgroundHandlers {
  const portOwners = new Map<number, object>();

  return {
    async onInstalled(details) {
      await recreateMenus(dependencies);
      if (details.reason === "install") {
        await dependencies.runtime.openOptionsPage();
      }
    },

    async onContextMenuClick(info, tab) {
      const action = toReaderAction(info.menuItemId);
      if (
        !action ||
        info.selectionText === undefined ||
        (info.pageUrl !== undefined && !supportedPageUrl(info.pageUrl)) ||
        !trustedTab(tab)
      ) {
        return;
      }

      await dependencies.readerAccess.injectForExplicitAction(tab.id, tab.url);
      await dependencies.tabs.sendMessage(tab.id, {
        type: "selection-action",
        action,
        selectionText: info.selectionText,
      });
    },

    async onCommand(command) {
      if (command !== EXPLAIN_COMMAND) return;
      const [tab] = await dependencies.tabs.queryActive();
      if (!trustedTab(tab)) return;

      await dependencies.readerAccess.injectForExplicitAction(tab.id, tab.url);
      await dependencies.tabs.sendMessage(tab.id, {
        type: "capture-current-selection",
        action: "explain",
      });
    },

    async onTabRemoved(tabId) {
      if (!Number.isInteger(tabId) || tabId < 0) return;
      portOwners.delete(tabId);
      dependencies.readerAccess.forgetExplicitInjection(tabId);
      await dependencies.coordinator.cancelForTab(tabId);
    },

    onPortConnected(port) {
      const tabId = port.sender?.tab?.id;
      if (
        port.name !== READER_PORT_NAME ||
        !Number.isInteger(tabId) ||
        (tabId ?? -1) < 0
      ) {
        return;
      }

      const acceptedTabId = tabId as number;
      const owner = {};
      portOwners.set(acceptedTabId, owner);
      dependencies.coordinator.handle(port, port.sender as TrustedPortSender);
      port.onDisconnect.addListener(() => {
        if (portOwners.get(acceptedTabId) !== owner) return;
        portOwners.delete(acceptedTabId);
        dependencies.readerAccess.invalidateExplicitInjection(acceptedTabId);
      });
    },
  };
}

export async function initializeBackgroundServices(
  dependencies: BackgroundDependencies,
): Promise<void> {
  const initializeAutomaticAccess = async (): Promise<void> => {
    const stored = await dependencies.settingsRepository.get();
    if (!stored.preferences.automaticToolbar) {
      await dependencies.readerAccess.disableAutomaticAccess();
      return;
    }

    let restored = false;
    try {
      restored = await dependencies.readerAccess.restoreAutomaticAccess();
    } catch {
      // The fallback below returns storage and registration to the disabled state.
    }
    if (restored) return;

    await Promise.allSettled([
      dependencies.settingsRepository.update({ automaticToolbar: false }),
      dependencies.readerAccess.disableAutomaticAccess(),
    ]);
  };

  await Promise.all([
    dependencies.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }),
    initializeAutomaticAccess(),
  ]);
}
