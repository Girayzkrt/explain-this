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
  invalidateExplicitInjection(tabId: number): void;
  enableAutomaticAccess(): Promise<{ granted: boolean }>;
  disableAutomaticAccess(): Promise<void>;
  restoreAutomaticAccess(): Promise<void>;
}

export class ReaderAccessController implements ReaderAccessService {
  private readonly explicitlyInjectedPages = new Set<string>();
  private readonly explicitInjectionInFlight = new Map<string, Promise<void>>();
  private readonly explicitInjectionGenerations = new Map<number, number>();
  private automaticEnableInFlight: Promise<{ granted: boolean }> | undefined;
  private automaticRegistrationInFlight: Promise<void> | undefined;

  constructor(private readonly browser: ReaderBrowserApi) {}

  async injectForExplicitAction(tabId: number, pageUrl: string): Promise<void> {
    if (!Number.isInteger(tabId) || tabId <= 0)
      throw new ReaderAccessError("INVALID_TAB");
    const normalizedPageUrl = normalizeSupportedPageUrl(pageUrl);
    if (!normalizedPageUrl) throw new ReaderAccessError("UNSUPPORTED_PAGE");

    const pageKey = `${tabId}\u0000${normalizedPageUrl}`;
    const generation = this.getExplicitInjectionGeneration(tabId);
    if (this.explicitlyInjectedPages.has(pageKey)) return;

    const inFlight = this.explicitInjectionInFlight.get(pageKey);
    if (inFlight) return inFlight;

    const injection = Promise.resolve()
      .then(() => this.browser.executeReader(tabId))
      .then(() => {
        if (this.getExplicitInjectionGeneration(tabId) === generation)
          this.explicitlyInjectedPages.add(pageKey);
      });
    this.explicitInjectionInFlight.set(pageKey, injection);

    try {
      await injection;
    } finally {
      if (this.explicitInjectionInFlight.get(pageKey) === injection)
        this.explicitInjectionInFlight.delete(pageKey);
    }
  }

  invalidateExplicitInjection(tabId: number): void {
    this.explicitInjectionGenerations.set(
      tabId,
      this.getExplicitInjectionGeneration(tabId) + 1,
    );
    const keyPrefix = `${tabId}\u0000`;
    for (const pageKey of this.explicitlyInjectedPages) {
      if (pageKey.startsWith(keyPrefix)) this.explicitlyInjectedPages.delete(pageKey);
    }
    for (const pageKey of this.explicitInjectionInFlight.keys()) {
      if (pageKey.startsWith(keyPrefix)) this.explicitInjectionInFlight.delete(pageKey);
    }
  }

  async enableAutomaticAccess(): Promise<{ granted: boolean }> {
    if (this.automaticEnableInFlight) return this.automaticEnableInFlight;

    const enable = this.enableAutomaticAccessOnce();
    this.automaticEnableInFlight = enable;
    try {
      return await enable;
    } finally {
      if (this.automaticEnableInFlight === enable)
        this.automaticEnableInFlight = undefined;
    }
  }

  async disableAutomaticAccess(): Promise<void> {
    await this.browser.unregisterReader();
    await this.browser.removeOrigins([...AUTOMATIC_READER_ORIGINS]);
  }

  async restoreAutomaticAccess(): Promise<void> {
    const granted = await this.browser.containsOrigins([...AUTOMATIC_READER_ORIGINS]);
    if (granted) await this.ensureAutomaticReaderRegistered();
  }

  private async enableAutomaticAccessOnce(): Promise<{ granted: boolean }> {
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

  private async ensureAutomaticReaderRegistered(): Promise<void> {
    if (this.automaticRegistrationInFlight) return this.automaticRegistrationInFlight;

    const registration = this.registerAutomaticReader();
    this.automaticRegistrationInFlight = registration;
    try {
      await registration;
    } finally {
      if (this.automaticRegistrationInFlight === registration)
        this.automaticRegistrationInFlight = undefined;
    }
  }

  private async registerAutomaticReader(): Promise<void> {
    if (await this.browser.getReaderRegistration()) return;
    await this.browser.registerReader([...AUTOMATIC_READER_ORIGINS]);
  }

  private getExplicitInjectionGeneration(tabId: number): number {
    return this.explicitInjectionGenerations.get(tabId) ?? 0;
  }
}

const normalizeSupportedPageUrl = (pageUrl: string): string | undefined => {
  try {
    const page = new URL(pageUrl);
    if (page.protocol !== "http:" && page.protocol !== "https:") return undefined;
    return page.href;
  } catch {
    return undefined;
  }
};
