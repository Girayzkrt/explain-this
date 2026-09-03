import { expect, test as base, type Page } from "@playwright/test";
import {
  buildExtension,
  closeResourcesInOrder,
  launchExtension,
  parseE2eBuildEndpoints,
  type BuiltExtension,
  type ExtensionFixture,
} from "../support/extension-fixture";
import {
  startFakeOllamaServer,
  type FakeOllamaServer,
} from "../support/fake-ollama-server";
import {
  startFixturePageServer,
  type FixturePageServer,
} from "../support/fixture-page-server";

export interface E2eFixture {
  readonly extension: ExtensionFixture;
  readonly fixturePages: FixturePageServer;
  readonly ollama: FakeOllamaServer;
  readonly package: BuiltExtension;
  reset(): Promise<void>;
}

interface AsyncClosable {
  close(): Promise<void>;
}

export interface E2eCleanupResources {
  extension: AsyncClosable | undefined;
  fixturePages: AsyncClosable;
  ollama: AsyncClosable;
}

/** Attempt every worker resource cleanup so a first failure cannot leak later resources. */
export async function closeE2eResources(resources: E2eCleanupResources): Promise<void> {
  await closeResourcesInOrder(
    [
      async () => resources.extension?.close(),
      async () => resources.fixturePages.close(),
      async () => resources.ollama.close(),
    ],
    "Failed to clean up E2E resources.",
  );
}

export const test = base.extend<Record<never, never>, { e2e: E2eFixture }>({
  e2e: [
    // No test-scoped fixtures are needed; keep the required Playwright destructuring shape.
    // eslint-disable-next-line no-empty-pattern
    async ({}, useFixture) => {
      const ollama = await startFakeOllamaServer();
      const fixturePages = await startFixturePageServer();
      let extension: ExtensionFixture | undefined;
      try {
        const environment = {
          VITE_EXPLAIN_THIS_OLLAMA_BASE_URL: ollama.baseUrl,
          VITE_EXPLAIN_THIS_FIXTURE_ORIGIN: fixturePages.origin,
        };
        await buildExtension({
          mode: "production",
          environment,
          forbiddenE2eEndpoints: parseE2eBuildEndpoints(environment),
        });
        const packageBuild = await buildExtension({
          mode: "e2e",
          environment,
        });
        extension = await launchExtension(packageBuild.outputPath);
        const activeExtension = extension;
        const e2e: E2eFixture = {
          extension: activeExtension,
          fixturePages,
          ollama,
          package: packageBuild,
          async reset() {
            await activeExtension.resetPages();
            await activeExtension.resetTrustedState();
            ollama.reset();
          },
        };
        await useFixture(e2e);
      } finally {
        await closeE2eResources({ extension, fixturePages, ollama });
      }
    },
    { scope: "worker" },
  ],
});

/**
 * Walks the welcome screen and the mode-choice screen that now sits in front of the
 * runtime check, choosing "on this computer" so onboarding proceeds exactly as it did
 * before the mode screen existed. Every spec written before that screen landed assumes
 * local mode, so this keeps their assertions' original meaning instead of repeating the
 * two clicks in each one.
 */
export async function beginLocalSetup(options: Page): Promise<void> {
  await options.getByRole("button", { name: "Start setup" }).click();
  await options.getByRole("button", { name: "Use this computer" }).click();
}

export { expect };
