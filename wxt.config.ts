import { defineConfig } from "wxt";

export default defineConfig({
  srcDir: "src",
  modules: ["@wxt-dev/module-react"],
  manifest: {
    name: "Explain This",
    description: "Understand anything you read, without leaving the page.",
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
  },
});
