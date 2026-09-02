// @vitest-environment node

import { access, mkdtemp, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertE2eManifestSecurity,
  assertReaderHookArtifact,
  buildExtension,
  buildInvocation,
  assertProductionManifestSecurity,
  assertProductionArtifactSecurity,
  closeResourcesInOrder,
  closeExtensionResources,
  parseE2eBuildEndpoints,
  removeExtensionProfile,
} from "./extension-fixture";

const productionHosts = ["http://127.0.0.1:11434/*", "http://localhost:11434/*"];

describe("extension fixture security boundaries", () => {
  it("requires the reader hook only in e2e artifacts", () => {
    expect(() =>
      assertReaderHookArtifact("globalThis.__EXPLAIN_THIS_E2E_INVOKE_READER__", true),
    ).not.toThrow();
    expect(() =>
      assertReaderHookArtifact("globalThis.__EXPLAIN_THIS_E2E_INVOKE_READER__", false),
    ).toThrow(/production/i);
    expect(() => assertReaderHookArtifact("production background", true)).toThrow(
      /e2e/i,
    );
  });

  it("rejects production artifacts that retain an e2e endpoint", () => {
    const endpoints = {
      ollamaOrigin: "http://127.0.0.1:43127",
      fixtureOrigin: "http://127.0.0.1:43128",
    };

    expect(() =>
      assertProductionArtifactSecurity(
        "http://127.0.0.1:11434 http://127.0.0.1:43127",
        endpoints,
      ),
    ).toThrow(/e2e/i);
    expect(() =>
      assertProductionArtifactSecurity("http://127.0.0.1:11434", endpoints),
    ).not.toThrow();
  });

  it("rejects e2e options that stay embedded in chrome://extensions", () => {
    expect(() =>
      assertE2eManifestSecurity(
        {
          host_permissions: [...productionHosts, "http://127.0.0.1/*"],
          optional_host_permissions: ["http://*/*", "https://*/*"],
          options_ui: { open_in_tab: false, page: "options.html" },
        },
        {
          ollamaOrigin: "http://127.0.0.1:43127",
          fixtureOrigin: "http://127.0.0.1:43128",
        },
      ),
    ).toThrow(/options/i);
  });

  it("accepts the unchanged production permission split", () => {
    expect(() =>
      assertProductionManifestSecurity({
        host_permissions: productionHosts,
        optional_host_permissions: ["http://*/*", "https://*/*"],
        options_ui: { open_in_tab: false, page: "options.html" },
      }),
    ).not.toThrow();
    expect(() =>
      assertProductionManifestSecurity({
        host_permissions: [...productionHosts, "http://127.0.0.1:43128/*"],
        optional_host_permissions: ["http://*/*", "https://*/*"],
        options_ui: { open_in_tab: false, page: "options.html" },
      }),
    ).toThrow(/production host permissions/i);
    expect(() =>
      assertProductionManifestSecurity({
        host_permissions: productionHosts,
        optional_host_permissions: ["http://*/*", "https://*/*"],
        options_ui: { open_in_tab: false, page: "options.html" },
        permissions: ["activeTab", "tabs"],
      }),
    ).toThrow(/tabs/i);
  });

  it("allows only the IPv4 loopback test host in the e2e manifest", () => {
    const ollamaOrigin = "http://127.0.0.1:43127";
    const fixtureOrigin = "http://127.0.0.1:43128";
    expect(() =>
      assertE2eManifestSecurity(
        {
          host_permissions: [...productionHosts, "http://127.0.0.1/*"],
          optional_host_permissions: ["http://*/*", "https://*/*"],
          options_ui: { open_in_tab: true, page: "options.html" },
        },
        { ollamaOrigin, fixtureOrigin },
      ),
    ).not.toThrow();
    expect(() =>
      assertE2eManifestSecurity(
        {
          host_permissions: [...productionHosts, "http://*/*"],
          optional_host_permissions: ["http://*/*", "https://*/*"],
          options_ui: { open_in_tab: true, page: "options.html" },
        },
        { ollamaOrigin, fixtureOrigin },
      ),
    ).toThrow(/e2e host permissions/i);
  });

  it("accepts only two distinct, exact IPv4 loopback origins for an e2e build", () => {
    expect(
      parseE2eBuildEndpoints({
        VITE_EXPLAIN_THIS_OLLAMA_BASE_URL: "http://127.0.0.1:43127",
        VITE_EXPLAIN_THIS_FIXTURE_ORIGIN: "http://127.0.0.1:43128",
      }),
    ).toEqual({
      ollamaOrigin: "http://127.0.0.1:43127",
      fixtureOrigin: "http://127.0.0.1:43128",
    });

    for (const environment of [
      {},
      {
        VITE_EXPLAIN_THIS_OLLAMA_BASE_URL: "http://localhost:43127",
        VITE_EXPLAIN_THIS_FIXTURE_ORIGIN: "http://127.0.0.1:43128",
      },
      {
        VITE_EXPLAIN_THIS_OLLAMA_BASE_URL: "http://127.0.0.1:43127/path",
        VITE_EXPLAIN_THIS_FIXTURE_ORIGIN: "http://127.0.0.1:43128",
      },
      {
        VITE_EXPLAIN_THIS_OLLAMA_BASE_URL: "http://127.0.0.1:43127",
        VITE_EXPLAIN_THIS_FIXTURE_ORIGIN: "http://127.0.0.1:43127",
      },
    ]) {
      expect(() => parseE2eBuildEndpoints(environment)).toThrow(/e2e/i);
    }
  });

  it("does not pass test endpoint values to a production build invocation", () => {
    const invocation = buildInvocation({
      mode: "production",
      environment: {
        VITE_EXPLAIN_THIS_OLLAMA_BASE_URL: "http://127.0.0.1:43127",
        VITE_EXPLAIN_THIS_FIXTURE_ORIGIN: "http://127.0.0.1:43128",
      },
    });

    expect(invocation.args).toEqual(["build", "--mode", "production"]);
    expect(invocation.environment.VITE_EXPLAIN_THIS_OLLAMA_BASE_URL).toBeUndefined();
    expect(invocation.environment.VITE_EXPLAIN_THIS_FIXTURE_ORIGIN).toBeUndefined();
  });

  it("passes validated test endpoints only to an e2e build invocation", () => {
    const invocation = buildInvocation({
      mode: "e2e",
      environment: {
        VITE_EXPLAIN_THIS_OLLAMA_BASE_URL: "http://127.0.0.1:43127",
        VITE_EXPLAIN_THIS_FIXTURE_ORIGIN: "http://127.0.0.1:43128",
      },
    });

    expect(invocation.args).toEqual(["build", "--mode", "e2e"]);
    expect(invocation.environment).toMatchObject({
      VITE_EXPLAIN_THIS_OLLAMA_BASE_URL: "http://127.0.0.1:43127",
      VITE_EXPLAIN_THIS_FIXTURE_ORIGIN: "http://127.0.0.1:43128",
    });
  });

  it("returns the rewritten e2e manifest that Chromium will load", async () => {
    const built = await buildExtension({
      mode: "e2e",
      environment: {
        VITE_EXPLAIN_THIS_OLLAMA_BASE_URL: "http://127.0.0.1:43127",
        VITE_EXPLAIN_THIS_FIXTURE_ORIGIN: "http://127.0.0.1:43128",
      },
    });

    expect(built.manifest.options_ui?.open_in_tab).toBe(true);
  }, 30_000);

  it("removes only an exact mkdtemp-style profile directly below the OS temp root", async () => {
    const profilePath = await mkdtemp(path.join(os.tmpdir(), "explain-this-"));
    await mkdir(path.join(profilePath, "owned"));

    await removeExtensionProfile(profilePath);
    await expect(access(profilePath)).rejects.toThrow();

    await expect(removeExtensionProfile(os.tmpdir())).rejects.toThrow(/unsafe/i);
    await expect(
      removeExtensionProfile(path.join(os.tmpdir(), "not-explain-this-profile")),
    ).rejects.toThrow(/unsafe/i);
    await expect(
      removeExtensionProfile(path.join(os.tmpdir(), "nested", "explain-this-child")),
    ).rejects.toThrow(/unsafe/i);
  });

  it("removes the profile even when closing Chromium rejects", async () => {
    const profilePath = await mkdtemp(path.join(os.tmpdir(), "explain-this-"));
    const closeFailure = new Error("Chromium close failed");

    await expect(
      closeExtensionResources(
        { close: async () => Promise.reject(closeFailure) },
        profilePath,
      ),
    ).rejects.toMatchObject({ errors: [closeFailure] });

    await expect(access(profilePath)).rejects.toThrow();
  });

  it("waits for Chromium to settle before releasing its profile", async () => {
    const calls: string[] = [];
    let releaseClose!: () => void;
    const closeSettled = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });

    const cleanup = closeResourcesInOrder(
      [
        async () => {
          calls.push("context");
          await closeSettled;
        },
        async () => {
          calls.push("profile");
        },
      ],
      "Failed to close extension resources.",
    );

    await Promise.resolve();
    expect(calls).toEqual(["context"]);
    releaseClose();
    await cleanup;
    expect(calls).toEqual(["context", "profile"]);
  });
});
