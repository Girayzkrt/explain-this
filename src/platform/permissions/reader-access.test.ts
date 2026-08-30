import { describe, expect, it } from "vitest";
import { FakeReaderBrowserApi } from "../../../tests/support/fake-browser-api";
import { AUTOMATIC_READER_ORIGINS, ReaderAccessController } from "./reader-access";

describe("ReaderAccessController", () => {
  it("injects the reader once for a positive numeric tab ID", async () => {
    const browser = new FakeReaderBrowserApi();
    const access = new ReaderAccessController(browser);

    await access.injectForExplicitAction(42, "https://docs.example/article");
    await access.injectForExplicitAction(42, "https://docs.example/article");

    expect(browser.executedTabs).toEqual([42]);
    expect(browser.requestCalls).toEqual([]);
    expect(browser.registeredMatches).toEqual([]);
  });

  it("injects again when a tab navigates to a different normalized page URL", async () => {
    const browser = new FakeReaderBrowserApi();
    const access = new ReaderAccessController(browser);

    await access.injectForExplicitAction(42, "https://docs.example/first");
    await access.injectForExplicitAction(42, "https://docs.example/second");

    expect(browser.executedTabs).toEqual([42, 42]);
  });

  it("allows a same-URL reload to inject again after lifecycle invalidation", async () => {
    const browser = new FakeReaderBrowserApi();
    const access = new ReaderAccessController(browser);

    await access.injectForExplicitAction(42, "https://docs.example/article");
    access.invalidateExplicitInjection(42);
    await access.injectForExplicitAction(42, "https://docs.example/article");

    expect(browser.executedTabs).toEqual([42, 42]);
  });

  it("does not let a stale successful injection suppress a same-URL reload", async () => {
    const browser = new FakeReaderBrowserApi();
    const staleExecution = browser.deferNextReaderExecution();
    const access = new ReaderAccessController(browser);

    const staleInjection = access.injectForExplicitAction(
      42,
      "https://docs.example/article",
    );
    await staleExecution.waitUntilStarted();
    access.invalidateExplicitInjection(42);
    staleExecution.resolve();
    await staleInjection;

    await access.injectForExplicitAction(42, "https://docs.example/article");
    expect(browser.executedTabs).toEqual([42, 42]);
  });

  it("keeps a newer injection in flight when a stale generation fails", async () => {
    const browser = new FakeReaderBrowserApi();
    const staleExecution = browser.deferNextReaderExecution();
    const access = new ReaderAccessController(browser);

    const staleInjection = access.injectForExplicitAction(
      42,
      "https://docs.example/article",
    );
    await staleExecution.waitUntilStarted();
    access.invalidateExplicitInjection(42);

    const newerExecution = browser.deferNextReaderExecution();
    const newerInjection = access.injectForExplicitAction(
      42,
      "https://docs.example/article",
    );
    await newerExecution.waitUntilStarted();
    staleExecution.reject(new Error("stale injection failed"));
    await expect(staleInjection).rejects.toThrow("stale injection failed");

    const sharedNewerInjection = access.injectForExplicitAction(
      42,
      "https://docs.example/article",
    );
    expect(browser.executedTabs).toEqual([42, 42]);
    newerExecution.resolve();
    await Promise.all([newerInjection, sharedNewerInjection]);
  });

  it("forgets a removed tab without letting stale injection completion return", async () => {
    const browser = new FakeReaderBrowserApi();
    const staleExecution = browser.deferNextReaderExecution();
    const access = new ReaderAccessController(browser);

    const staleInjection = access.injectForExplicitAction(
      42,
      "https://docs.example/article",
    );
    await staleExecution.waitUntilStarted();
    access.forgetExplicitInjection(42);
    staleExecution.resolve();
    await staleInjection;

    await access.injectForExplicitAction(42, "https://docs.example/article");
    expect(browser.executedTabs).toEqual([42, 42]);
  });

  it("shares concurrent page injection and clears the failed work for retry", async () => {
    const browser = new FakeReaderBrowserApi();
    const failure = new Error("script injection failed");
    browser.executeFailures.push(failure);
    const access = new ReaderAccessController(browser);

    const results = await Promise.allSettled([
      access.injectForExplicitAction(42, "https://docs.example/article"),
      access.injectForExplicitAction(42, "https://docs.example/article"),
    ]);

    expect(results).toEqual([
      { status: "rejected", reason: failure },
      { status: "rejected", reason: failure },
    ]);
    await access.injectForExplicitAction(42, "https://docs.example/article");
    expect(browser.executedTabs).toEqual([42, 42]);
  });

  it.each([0, -1, 1.5, Number.NaN])(
    "rejects invalid tab ID %s before injection",
    async (tabId) => {
      const browser = new FakeReaderBrowserApi();
      const access = new ReaderAccessController(browser);

      await expect(
        access.injectForExplicitAction(tabId, "https://docs.example/article"),
      ).rejects.toMatchObject({ code: "INVALID_TAB" });
      expect(browser.executedTabs).toEqual([]);
    },
  );

  it("requests both approved origins only when automatic access is enabled", async () => {
    const browser = new FakeReaderBrowserApi();
    const access = new ReaderAccessController(browser);

    expect(browser.requestCalls).toEqual([]);
    await expect(access.enableAutomaticAccess()).resolves.toEqual({ granted: true });

    expect(browser.requestCalls).toEqual([AUTOMATIC_READER_ORIGINS]);
    expect(browser.registeredMatches).toEqual([AUTOMATIC_READER_ORIGINS]);
  });

  it("reports a denied permission request without registering or throwing", async () => {
    const browser = new FakeReaderBrowserApi();
    browser.requestedOriginsGranted = false;
    const access = new ReaderAccessController(browser);

    await expect(access.enableAutomaticAccess()).resolves.toEqual({ granted: false });

    expect(browser.requestCalls).toEqual([AUTOMATIC_READER_ORIGINS]);
    expect(browser.registeredMatches).toEqual([]);
  });

  it("registers an isolated top-frame document-idle reader after a grant", async () => {
    const browser = new FakeReaderBrowserApi();
    const access = new ReaderAccessController(browser);

    await access.enableAutomaticAccess();

    await expect(browser.getReaderRegistration()).resolves.toEqual({
      id: "explain-this-reader",
      matches: ["http://*/*", "https://*/*"],
      js: ["content-scripts/reader.js"],
      runAt: "document_idle",
      allFrames: false,
      world: "ISOLATED",
    });
  });

  it("disables automatic access by removing its script and optional origins", async () => {
    const browser = new FakeReaderBrowserApi();
    browser.grantOrigins(AUTOMATIC_READER_ORIGINS);
    const access = new ReaderAccessController(browser);
    await access.restoreAutomaticAccess();

    await access.disableAutomaticAccess();

    expect(browser.unregisterCalls).toBe(1);
    expect(browser.removeCalls).toEqual([AUTOMATIC_READER_ORIGINS]);
    await expect(browser.getReaderRegistration()).resolves.toBeUndefined();
    await expect(browser.containsOrigins(AUTOMATIC_READER_ORIGINS)).resolves.toBe(
      false,
    );
  });

  it("restores registration at startup only when optional origins still exist", async () => {
    const authorizedBrowser = new FakeReaderBrowserApi();
    authorizedBrowser.grantOrigins(AUTOMATIC_READER_ORIGINS);
    await new ReaderAccessController(authorizedBrowser).restoreAutomaticAccess();

    const unauthorizedBrowser = new FakeReaderBrowserApi();
    await new ReaderAccessController(unauthorizedBrowser).restoreAutomaticAccess();

    expect(authorizedBrowser.registeredMatches).toEqual([AUTOMATIC_READER_ORIGINS]);
    expect(unauthorizedBrowser.registeredMatches).toEqual([]);
    expect(unauthorizedBrowser.requestCalls).toEqual([]);
  });

  it("does not register a second reader when one is already registered", async () => {
    const browser = new FakeReaderBrowserApi();
    browser.grantOrigins(AUTOMATIC_READER_ORIGINS);
    await browser.registerReader(AUTOMATIC_READER_ORIGINS);

    await new ReaderAccessController(browser).restoreAutomaticAccess();

    expect(browser.registeredMatches).toEqual([AUTOMATIC_READER_ORIGINS]);
  });

  it("shares concurrent enable and restore registration work", async () => {
    const browser = new FakeReaderBrowserApi();
    const access = new ReaderAccessController(browser);

    await expect(
      Promise.all([
        access.enableAutomaticAccess(),
        access.enableAutomaticAccess(),
        access.restoreAutomaticAccess(),
      ]),
    ).resolves.toEqual([{ granted: true }, { granted: true }, undefined]);

    expect(browser.requestCalls).toEqual([AUTOMATIC_READER_ORIGINS]);
    expect(browser.registeredMatches).toEqual([AUTOMATIC_READER_ORIGINS]);
  });

  it("shares failed registration and clears it so a later restore retries", async () => {
    const browser = new FakeReaderBrowserApi();
    browser.grantOrigins(AUTOMATIC_READER_ORIGINS);
    const failure = new Error("registration failed");
    browser.registrationFailures.push(failure);
    const access = new ReaderAccessController(browser);

    const results = await Promise.allSettled([
      access.enableAutomaticAccess(),
      access.restoreAutomaticAccess(),
    ]);

    expect(results).toEqual([
      { status: "rejected", reason: failure },
      { status: "rejected", reason: failure },
    ]);
    await access.restoreAutomaticAccess();
    expect(browser.registeredMatches).toEqual([
      AUTOMATIC_READER_ORIGINS,
      AUTOMATIC_READER_ORIGINS,
    ]);
  });

  it.each(["chrome://settings", "about:blank", "file:///C:/notes.txt"])(
    "rejects protected page %s before calling scripting",
    async (pageUrl) => {
      const browser = new FakeReaderBrowserApi();
      const access = new ReaderAccessController(browser);

      await expect(access.injectForExplicitAction(9, pageUrl)).rejects.toMatchObject({
        code: "UNSUPPORTED_PAGE",
      });
      expect(browser.executedTabs).toEqual([]);
    },
  );
});
