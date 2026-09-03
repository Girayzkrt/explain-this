import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    setupFiles: ["./tests/support/vitest.setup.ts"],
    clearMocks: true,
    // Playwright owns tests/e2e; Vitest's default glob would otherwise collect its .spec.ts files.
    exclude: [...configDefaults.exclude, "tests/e2e/**"],
  },
});
