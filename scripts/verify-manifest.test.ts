// @vitest-environment node

import { describe, expect, it } from "vitest";
import { verifyManifest, type ManifestProblem } from "./verify-manifest";

/** The manifest WXT generates today, which is the approved shipping shape. */
function approvedManifest(): Record<string, unknown> {
  return {
    manifest_version: 3,
    name: "Explain This",
    description: "Understand anything you read, without leaving the page.",
    version: "1.0.0",
    minimum_chrome_version: "116",
    permissions: ["activeTab", "contextMenus", "scripting", "sidePanel", "storage"],
    host_permissions: ["http://127.0.0.1:11434/*", "http://localhost:11434/*"],
    optional_host_permissions: ["http://*/*", "https://*/*"],
    action: { default_title: "Open Explain This" },
    commands: {
      "explain-selection": {
        suggested_key: { default: "Alt+Shift+E" },
        description: "Explain selected text",
      },
    },
    background: { service_worker: "background.js" },
    options_ui: { open_in_tab: false, page: "options.html" },
    side_panel: { default_path: "sidepanel.html" },
  };
}

function checks(problems: readonly ManifestProblem[]): string[] {
  return problems.map((problem) => problem.check);
}

describe("manifest verification", () => {
  it("accepts the approved generated manifest", () => {
    expect(verifyManifest(approvedManifest())).toEqual([]);
  });

  it("rejects Manifest V2", () => {
    expect(
      checks(verifyManifest({ ...approvedManifest(), manifest_version: 2 })),
    ).toContain("manifest-version");
  });

  it.each([["115"], ["88"], [undefined]])(
    "rejects a Chrome minimum of %s",
    (minimum) => {
      const manifest = approvedManifest();
      if (minimum === undefined) delete manifest.minimum_chrome_version;
      else manifest.minimum_chrome_version = minimum;
      expect(checks(verifyManifest(manifest))).toContain("minimum-chrome-version");
    },
  );

  it.each([["<all_urls>"], ["http://*/*"], ["https://*/*"], ["http://192.168.1.5/*"]])(
    "rejects %s in required host permissions",
    (origin) => {
      const manifest = approvedManifest();
      manifest.host_permissions = [...(manifest.host_permissions as string[]), origin];
      expect(checks(verifyManifest(manifest))).toContain("required-host-permissions");
    },
  );

  it("rejects a manifest with no loopback permission", () => {
    const manifest = approvedManifest();
    manifest.host_permissions = [];
    expect(checks(verifyManifest(manifest))).toContain("loopback-permission");
  });

  it.each([
    ["webRequest"],
    ["proxy"],
    ["debugger"],
    ["management"],
    ["nativeMessaging"],
    ["cookies"],
    ["history"],
    ["tabs"],
  ])("rejects the unexpected permission %s", (permission) => {
    const manifest = approvedManifest();
    manifest.permissions = [...(manifest.permissions as string[]), permission];
    expect(checks(verifyManifest(manifest))).toContain("permissions");
  });

  it("rejects a content script registered on ordinary pages", () => {
    const manifest = approvedManifest();
    manifest.content_scripts = [
      { matches: ["http://*/*", "https://*/*"], js: ["content-scripts/reader.js"] },
    ];
    expect(checks(verifyManifest(manifest))).toContain("content-scripts");
  });

  it("rejects a popup entrypoint", () => {
    const manifest = approvedManifest();
    manifest.action = {
      default_title: "Open Explain This",
      default_popup: "popup.html",
    };
    expect(checks(verifyManifest(manifest))).toContain("popup");
  });

  it.each([
    [
      "background service worker",
      { background: { service_worker: "https://cdn.example/bg.js" } },
    ],
    [
      "web accessible resource",
      {
        web_accessible_resources: [
          { resources: ["https://cdn.example/x.js"], matches: ["<all_urls>"] },
        ],
      },
    ],
    [
      "content security policy",
      {
        content_security_policy: {
          extension_pages: "script-src 'self' https://cdn.example",
        },
      },
    ],
  ])("rejects remote code in the %s", (_label, patch) => {
    expect(checks(verifyManifest({ ...approvedManifest(), ...patch }))).toContain(
      "remote-code",
    );
  });

  it("reports a non-object manifest instead of throwing", () => {
    expect(checks(verifyManifest("not a manifest"))).toContain("manifest-shape");
  });
});
