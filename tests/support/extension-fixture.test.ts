// @vitest-environment node

import { access, mkdtemp, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertE2eManifestSecurity,
  buildInvocation,
  assertProductionManifestSecurity,
  parseE2eBuildEndpoints,
  removeExtensionProfile,
} from "./extension-fixture";

const productionHosts = ["http://127.0.0.1:11434/*", "http://localhost:11434/*"];

describe("extension fixture security boundaries", () => {
  it("accepts the unchanged production permission split", () => {
    expect(() =>
      assertProductionManifestSecurity({
        host_permissions: productionHosts,
        optional_host_permissions: ["http://*/*", "https://*/*"],
      }),
    ).not.toThrow();
    expect(() =>
      assertProductionManifestSecurity({
        host_permissions: [...productionHosts, "http://127.0.0.1:43128/*"],
        optional_host_permissions: ["http://*/*", "https://*/*"],
      }),
    ).toThrow(/production host permissions/i);
  });

  it("allows only the exact fake endpoint and fixture origin in the e2e manifest", () => {
    const ollamaOrigin = "http://127.0.0.1:43127";
    const fixtureOrigin = "http://127.0.0.1:43128";
    expect(() =>
      assertE2eManifestSecurity(
        {
          host_permissions: [
            ...productionHosts,
            `${ollamaOrigin}/*`,
            `${fixtureOrigin}/*`,
          ],
          optional_host_permissions: ["http://*/*", "https://*/*"],
        },
        { ollamaOrigin, fixtureOrigin },
      ),
    ).not.toThrow();
    expect(() =>
      assertE2eManifestSecurity(
        {
          host_permissions: [...productionHosts, "http://*/*"],
          optional_host_permissions: ["http://*/*", "https://*/*"],
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
});
