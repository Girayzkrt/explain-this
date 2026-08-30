import type {
  ReaderBrowserApi,
  RegisteredContentScript,
} from "../../src/platform/permissions/browser-api";

export class FakeReaderBrowserApi implements ReaderBrowserApi {
  readonly executedTabs: number[] = [];
  readonly containsRequests: string[][] = [];
  readonly requestCalls: string[][] = [];
  readonly removeCalls: string[][] = [];
  readonly registeredMatches: string[][] = [];
  unregisterCalls = 0;
  requestedOriginsGranted = true;
  readonly executeFailures: Error[] = [];
  readonly registrationFailures: Error[] = [];
  private readonly grantedOrigins = new Set<string>();
  private registration: RegisteredContentScript | undefined;

  grantOrigins(origins: string[]): void {
    for (const origin of origins) this.grantedOrigins.add(origin);
  }

  async containsOrigins(origins: string[]): Promise<boolean> {
    this.containsRequests.push([...origins]);
    return origins.every((origin) => this.grantedOrigins.has(origin));
  }

  async requestOrigins(origins: string[]): Promise<boolean> {
    this.requestCalls.push([...origins]);
    if (this.requestedOriginsGranted) this.grantOrigins(origins);
    return this.requestedOriginsGranted;
  }

  async removeOrigins(origins: string[]): Promise<boolean> {
    this.removeCalls.push([...origins]);
    for (const origin of origins) this.grantedOrigins.delete(origin);
    return true;
  }

  async executeReader(tabId: number): Promise<void> {
    this.executedTabs.push(tabId);
    const failure = this.executeFailures.shift();
    if (failure) throw failure;
  }

  async getReaderRegistration(): Promise<RegisteredContentScript | undefined> {
    return this.registration;
  }

  async registerReader(matches: string[]): Promise<void> {
    this.registeredMatches.push([...matches]);
    const failure = this.registrationFailures.shift();
    if (failure) throw failure;
    this.registration = {
      id: "explain-this-reader",
      matches: [...matches],
      js: ["content-scripts/reader.js"],
      runAt: "document_idle",
      allFrames: false,
      world: "ISOLATED",
    };
  }

  async unregisterReader(): Promise<void> {
    this.unregisterCalls += 1;
    this.registration = undefined;
  }
}
