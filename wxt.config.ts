import { defineConfig } from "wxt";
import { parseE2eBuildEndpoints } from "./src/shared/e2e-build";

const productionHostPermissions = [
  "http://127.0.0.1:11434/*",
  "http://localhost:11434/*",
];

export default defineConfig({
  srcDir: "src",
  modules: ["@wxt-dev/module-react"],
  manifest: (environment) => {
    const e2eEndpoints =
      environment.mode === "e2e" ? parseE2eBuildEndpoints() : undefined;
    const e2eHostPermissions = e2eEndpoints
      ? [`${e2eEndpoints.ollamaOrigin}/*`, `${e2eEndpoints.fixtureOrigin}/*`]
      : [];

    return {
      name: "Explain This",
      description: "Understand anything you read, without leaving the page.",
      minimum_chrome_version: "116",
      permissions: ["activeTab", "contextMenus", "scripting", "sidePanel", "storage"],
      host_permissions: [...productionHostPermissions, ...e2eHostPermissions],
      optional_host_permissions: ["http://*/*", "https://*/*"],
      action: { default_title: "Open Explain This" },
      commands: {
        "explain-selection": {
          suggested_key: { default: "Alt+Shift+E" },
          description: "Explain selected text",
        },
      },
    };
  },
  vite: (environment) => {
    const e2eEndpoints =
      environment.mode === "e2e" ? parseE2eBuildEndpoints() : undefined;
    return {
      define: {
        __EXPLAIN_THIS_E2E_OLLAMA_BASE_URL__: JSON.stringify(
          e2eEndpoints?.ollamaOrigin,
        ),
      },
    };
  },
});
