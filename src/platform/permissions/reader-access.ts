import type { ReaderBrowserApi } from "./browser-api";

export const AUTOMATIC_READER_ORIGINS = ["http://*/*", "https://*/*"];

export type ReaderAccessErrorCode = "INVALID_TAB" | "UNSUPPORTED_PAGE";

export class ReaderAccessError extends Error {
  constructor(readonly code: ReaderAccessErrorCode) {
    super(code);
    this.name = "ReaderAccessError";
  }
}

export interface ReaderAccessService {
  injectForExplicitAction(tabId: number, pageUrl: string): Promise<void>;
  enableAutomaticAccess(): Promise<{ granted: boolean }>;
  disableAutomaticAccess(): Promise<void>;
  restoreAutomaticAccess(): Promise<void>;
}

export class ReaderAccessController implements ReaderAccessService {
  private readonly explicitlyInjectedTabs = new Set<number>();

  constructor(private readonly browser: ReaderBrowserApi) {}

  async injectForExplicitAction(tabId: number, pageUrl: string): Promise<void> {
    if (!Number.isInteger(tabId) || tabId <= 0)
      throw new ReaderAccessError("INVALID_TAB");
    if (!isSupportedPage(pageUrl)) throw new ReaderAccessError("UNSUPPORTED_PAGE");
    if (this.explicitlyInjectedTabs.has(tabId)) return;

    await this.browser.executeReader(tabId);
    this.explicitlyInjectedTabs.add(tabId);
  }

  async enableAutomaticAccess(): Promise<{ granted: boolean }> {
    const alreadyGranted = await this.browser.containsOrigins([
      ...AUTOMATIC_READER_ORIGINS,
    ]);
    const granted =
      alreadyGranted ||
      (await this.browser.requestOrigins([...AUTOMATIC_READER_ORIGINS]));

    if (!granted) return { granted: false };

    await this.ensureAutomaticReaderRegistered();
    return { granted: true };
  }

  async disableAutomaticAccess(): Promise<void> {
    await this.browser.unregisterReader();
    await this.browser.removeOrigins([...AUTOMATIC_READER_ORIGINS]);
  }

  async restoreAutomaticAccess(): Promise<void> {
    const granted = await this.browser.containsOrigins([...AUTOMATIC_READER_ORIGINS]);
    if (granted) await this.ensureAutomaticReaderRegistered();
  }

  private async ensureAutomaticReaderRegistered(): Promise<void> {
    if (await this.browser.getReaderRegistration()) return;
    await this.browser.registerReader([...AUTOMATIC_READER_ORIGINS]);
  }
}

const isSupportedPage = (pageUrl: string): boolean => {
  try {
    const { protocol } = new URL(pageUrl);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
};
