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
  forgetExplicitInjection(tabId: number): void;
  requestAutomaticAccess(): Promise<boolean>;
  registerAutomaticAccess(): Promise<void>;
  enableAutomaticAccess(): Promise<{ granted: boolean }>;
  disableAutomaticAccess(): Promise<void>;
  restoreAutomaticAccess(): Promise<boolean>;
}

export class ReaderAccessController implements ReaderAccessService {
  private readonly explicitlyInjectedPages = new Set<string>();
  private readonly explicitInjectionInFlight = new Map<string, Promise<void>>();
  private readonly explicitInjectionGenerations = new Map<number, object>();
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
        if (this.explicitInjectionGenerations.get(tabId) === generation)
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
    this.explicitInjectionGenerations.set(tabId, {});
    this.clearExplicitInjectionState(tabId);
  }

  forgetExplicitInjection(tabId: number): void {
    this.explicitInjectionGenerations.delete(tabId);
    this.clearExplicitInjectionState(tabId);
  }

  private clearExplicitInjectionState(tabId: number): void {
    const keyPrefix = `${tabId}\u0000`;
    for (const pageKey of this.explicitlyInjectedPages) {
      if (pageKey.startsWith(keyPrefix)) this.explicitlyInjectedPages.delete(pageKey);
    }
    for (const pageKey of this.explicitInjectionInFlight.keys()) {
      if (pageKey.startsWith(keyPrefix)) this.explicitInjectionInFlight.delete(pageKey);
    }
  }

  enableAutomaticAccess(): Promise<{ granted: boolean }> {
    if (this.automaticEnableInFlight) return this.automaticEnableInFlight;

    const enable = this.enableAutomaticAccessOnce();
    this.automaticEnableInFlight = enable;
    const clearInFlight = (): void => {
      if (this.automaticEnableInFlight === enable)
        this.automaticEnableInFlight = undefined;
    };
    void enable.then(clearInFlight, clearInFlight);
    return enable;
  }

  requestAutomaticAccess(): Promise<boolean> {
    return this.browser.requestOrigins([...AUTOMATIC_READER_ORIGINS]);
  }

  registerAutomaticAccess(): Promise<void> {
    return this.ensureAutomaticReaderRegistered();
  }

  async disableAutomaticAccess(): Promise<void> {
    let unregistrationFailure: { error: unknown } | undefined;

    try {
      if (await this.browser.getReaderRegistration()) {
        try {
          await this.browser.unregisterReader();
        } catch (error: unknown) {
          try {
            if (await this.browser.getReaderRegistration()) {
              unregistrationFailure = { error };
            }
          } catch {
            unregistrationFailure = { error };
          }
        }
      }
    } catch (error: unknown) {
      unregistrationFailure = { error };
    }

    let removalFailure: { error: unknown } | undefined;
    try {
      await this.browser.removeOrigins([...AUTOMATIC_READER_ORIGINS]);
    } catch (error: unknown) {
      removalFailure = { error };
    }

    if (unregistrationFailure && removalFailure) {
      throw new AggregateError(
        [unregistrationFailure.error, removalFailure.error],
        "Failed to disable automatic reader access.",
      );
    }
    if (removalFailure) throw removalFailure.error;
    if (unregistrationFailure) throw unregistrationFailure.error;
  }

  async restoreAutomaticAccess(): Promise<boolean> {
    const granted = await this.browser.containsOrigins([...AUTOMATIC_READER_ORIGINS]);
    if (!granted) return false;
    await this.ensureAutomaticReaderRegistered();
    return true;
  }

  private async enableAutomaticAccessOnce(): Promise<{ granted: boolean }> {
    const granted = await this.requestAutomaticAccess();

    if (!granted) return { granted: false };

    await this.registerAutomaticAccess();
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

  private getExplicitInjectionGeneration(tabId: number): object {
    const current = this.explicitInjectionGenerations.get(tabId);
    if (current) return current;

    const created = {};
    this.explicitInjectionGenerations.set(tabId, created);
    return created;
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
