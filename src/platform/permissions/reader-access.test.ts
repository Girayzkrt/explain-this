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
