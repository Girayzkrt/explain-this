import { browser } from "wxt/browser";

export const READER_CONTENT_SCRIPT_ID = "explain-this-reader";
export const READER_CONTENT_SCRIPT_FILE = "content-scripts/reader.js";

export interface RegisteredContentScript {
  id: string;
  matches: string[];
  js: string[];
  runAt: "document_idle";
  allFrames: false;
  world: "ISOLATED";
}

export interface ReaderBrowserApi {
  containsOrigins(origins: string[]): Promise<boolean>;
  requestOrigins(origins: string[]): Promise<boolean>;
  removeOrigins(origins: string[]): Promise<boolean>;
  executeReader(tabId: number): Promise<void>;
  getReaderRegistration(): Promise<RegisteredContentScript | undefined>;
  registerReader(matches: string[]): Promise<void>;
  unregisterReader(): Promise<void>;
}

export const readerBrowserApi: ReaderBrowserApi = {
  async containsOrigins(origins) {
    return browser.permissions.contains({ origins });
  },

  async requestOrigins(origins) {
    return browser.permissions.request({ origins });
  },

  async removeOrigins(origins) {
    return browser.permissions.remove({ origins });
  },

  async executeReader(tabId) {
    const executeScript = browser.scripting.executeScript as unknown as (injection: {
      target: { tabId: number };
      files: string[];
      world: "ISOLATED";
    }) => Promise<unknown>;
    await executeScript({
      target: { tabId },
      files: [READER_CONTENT_SCRIPT_FILE],
      world: "ISOLATED",
    });
  },

  async getReaderRegistration() {
    const registrations = await browser.scripting.getRegisteredContentScripts({
      ids: [READER_CONTENT_SCRIPT_ID],
    });
    const registration = registrations[0];
    if (!registration) return undefined;

    return {
      id: READER_CONTENT_SCRIPT_ID,
      matches: registration.matches ?? [],
      js: registration.js ?? [],
      runAt: "document_idle",
      allFrames: false,
      world: "ISOLATED",
    };
  },

  async registerReader(matches) {
    await browser.scripting.registerContentScripts([
      {
        id: READER_CONTENT_SCRIPT_ID,
        matches,
        js: [READER_CONTENT_SCRIPT_FILE],
        runAt: "document_idle",
        allFrames: false,
        world: "ISOLATED",
      },
    ]);
  },

  async unregisterReader() {
    await browser.scripting.unregisterContentScripts({
      ids: [READER_CONTENT_SCRIPT_ID],
    });
  },
};
