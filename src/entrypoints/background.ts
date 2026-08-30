import { browser } from "wxt/browser";
import {
  createBackgroundHandlers,
  initializeBackgroundServices,
  type BackgroundDependencies,
  type BrowserPort,
} from "../features/reader/background-events";
import { RequestCoordinator } from "../features/reader/request-coordinator";
import { readerBrowserApi } from "../platform/permissions/browser-api";
import { ReaderAccessController } from "../platform/permissions/reader-access";
import {
  createSessionRepository,
  type SessionRepository,
} from "../platform/storage/session-repository";
import {
  createSettingsRepository,
  type SettingsRepository,
} from "../platform/storage/settings-repository";
import {
  getExtensionStorageAreas,
  initializeStorageAccess,
} from "../platform/storage/storage-area";
import { OllamaProvider } from "../providers/ollama/ollama-provider";
import { OLLAMA_BASE_URL } from "../shared/constants";

const STORAGE_UNAVAILABLE = new Error("Trusted extension storage is unavailable.");

function beginStorageInitialization(): Promise<boolean> {
  return initializeStorageAccess().then(
    () => true,
    (error: unknown) => {
      console.error("Failed to restrict extension storage access.", error);
      return false;
    },
  );
}

async function requireStorage<T>(
  readiness: Promise<boolean>,
  operation: () => Promise<T>,
): Promise<T> {
  if (!(await readiness)) throw STORAGE_UNAVAILABLE;
  return operation();
}

function withStorageReadiness(
  repository: SettingsRepository,
  readiness: Promise<boolean>,
): SettingsRepository {
  return {
    get: () => requireStorage(readiness, () => repository.get()),
    update: (patch) => requireStorage(readiness, () => repository.update(patch)),
    markOnboardingComplete: () =>
      requireStorage(readiness, () => repository.markOnboardingComplete()),
  };
}

function withSessionStorageReadiness(
  repository: SessionRepository,
  readiness: Promise<boolean>,
): SessionRepository {
  return {
    getReaderSession: (tabId) =>
      requireStorage(readiness, () => repository.getReaderSession(tabId)),
    putReaderSession: (session) =>
      requireStorage(readiness, () => repository.putReaderSession(session)),
    getPrivateSource: (tabId) =>
      requireStorage(readiness, () => repository.getPrivateSource(tabId)),
    putPrivateSource: (tabId, source) =>
      requireStorage(readiness, () => repository.putPrivateSource(tabId, source)),
    async removeTabState(tabId) {
      if (await readiness) await repository.removeTabState(tabId);
    },
  };
}

function createProductionBackgroundDependencies(
  storageReadiness: Promise<boolean>,
): BackgroundDependencies {
  const storage = getExtensionStorageAreas();
  const settingsRepository = withStorageReadiness(
    createSettingsRepository(storage.local, () => browser.i18n.getUILanguage()),
    storageReadiness,
  );
  const sessionRepository = withSessionStorageReadiness(
    createSessionRepository(storage.session),
    storageReadiness,
  );
  const readerAccess = new ReaderAccessController(readerBrowserApi);
  const coordinator = new RequestCoordinator({
    provider: new OllamaProvider({ baseUrl: OLLAMA_BASE_URL }),
    sessionRepository,
    settingsRepository,
  });

  return {
    contextMenus: {
      removeAll: () => browser.contextMenus.removeAll(),
      create(data) {
        browser.contextMenus.create(data);
      },
    },
    runtime: {
      openOptionsPage: () => browser.runtime.openOptionsPage(),
    },
    tabs: {
      queryActive: () => browser.tabs.query({ active: true, currentWindow: true }),
      async sendMessage(tabId, message) {
        await browser.tabs.sendMessage(tabId, message);
      },
    },
    sidePanel: {
      setPanelBehavior: (behavior) => browser.sidePanel.setPanelBehavior(behavior),
    },
    readerAccess,
    coordinator,
  };
}

export default defineBackground(() => {
  const storageReadiness = beginStorageInitialization();
  const dependencies = createProductionBackgroundDependencies(storageReadiness);
  const handlers = createBackgroundHandlers(dependencies);

  browser.runtime.onInstalled.addListener(handlers.onInstalled);
  browser.contextMenus.onClicked.addListener(handlers.onContextMenuClick);
  browser.commands.onCommand.addListener(handlers.onCommand);
  browser.tabs.onRemoved.addListener(handlers.onTabRemoved);
  browser.runtime.onConnect.addListener((port) => {
    handlers.onPortConnected(port as unknown as BrowserPort);
  });

  void initializeBackgroundServices(dependencies).catch((error: unknown) => {
    console.error("Failed to initialize background services.", error);
  });
});
