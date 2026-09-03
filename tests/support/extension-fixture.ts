import { execFile } from "node:child_process";
import { mkdtemp, realpath, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  chromium,
  type BrowserContext,
  type Page,
  type Worker,
} from "@playwright/test";
import {
  E2E_FIXTURE_ORIGIN,
  E2E_OLLAMA_BASE_URL,
  parseE2eBuildEndpoints,
  type E2eBuildEndpoints,
} from "../../src/shared/e2e-build";

const runFile = promisify(execFile);
const profilePrefix = "explain-this-";
const E2E_READER_HOOK_NAME = "__EXPLAIN_THIS_E2E_INVOKE_READER__";
const E2E_READER_HOOK_STATUS_NAME = `${E2E_READER_HOOK_NAME}_STATUS`;
const e2eLoopbackHost = "http://127.0.0.1/*";
const productionHosts = ["http://127.0.0.1:11434/*", "http://localhost:11434/*"];

interface ExtensionManifest {
  permissions?: string[];
  host_permissions?: string[];
  optional_host_permissions?: string[];
  options_ui?: { open_in_tab?: boolean; page?: string };
}

interface ExtensionChromeApi {
  storage: Record<
    "local" | "session",
    {
      clear(): Promise<void>;
      get(): Promise<Record<string, unknown>>;
      set(values: Record<string, unknown>): Promise<void>;
    }
  >;
}

interface BuildOptions {
  mode: "production" | "e2e";
  environment?: Record<string, string | undefined>;
  forbiddenE2eEndpoints?: E2eBuildEndpoints;
  rootDir?: string;
}

export interface BuildInvocation {
  args: string[];
  environment: NodeJS.ProcessEnv;
}

export interface BuiltExtension {
  outputPath: string;
  manifest: ExtensionManifest;
}

export interface ExtensionFixture {
  readonly context: BrowserContext;
  readonly extensionId: string;
  readonly profilePath: string;
  openOptions(): Promise<Page>;
  openSidePanel(sourcePage: Page): Promise<Page>;
  openFixture(url: string): Promise<Page>;
  resetPages(): Promise<void>;
  readTrustedStorage(area?: "local" | "session"): Promise<Record<string, unknown>>;
  resetTrustedState(): Promise<void>;
  writeTrustedStorage(
    values: Record<string, unknown>,
    area?: "local" | "session",
  ): Promise<void>;
  invokePackagedReader(page: Page): Promise<void>;
  close(): Promise<void>;
}

function sorted(values: readonly string[] | undefined): string[] {
  return [...(values ?? [])].sort();
}

function expectedE2eHosts(endpoints: E2eBuildEndpoints): string[] {
  void endpoints;
  return [...productionHosts, e2eLoopbackHost];
}

export { parseE2eBuildEndpoints };

export function assertProductionManifestSecurity(manifest: ExtensionManifest): void {
  if (manifest.permissions?.includes("tabs")) {
    throw new Error("Production permissions must not retain the e2e tabs permission.");
  }
  if (
    JSON.stringify(sorted(manifest.host_permissions)) !==
    JSON.stringify(productionHosts)
  ) {
    throw new Error(
      "Production host permissions differ from the approved loopback split.",
    );
  }
  if (
    JSON.stringify(sorted(manifest.optional_host_permissions)) !==
    JSON.stringify(["http://*/*", "https://*/*"])
  ) {
    throw new Error(
      "Production optional host permissions differ from the approved split.",
    );
  }
  if (manifest.options_ui?.open_in_tab !== false) {
    throw new Error("Production options must retain the embedded options page.");
  }
}

export function assertE2eManifestSecurity(
  manifest: ExtensionManifest,
  endpoints: E2eBuildEndpoints,
): void {
  const expectedHosts = sorted(expectedE2eHosts(endpoints));
  if (
    JSON.stringify(sorted(manifest.host_permissions)) !== JSON.stringify(expectedHosts)
  ) {
    throw new Error("E2E host permissions are not limited to IPv4 loopback.");
  }
  if (
    JSON.stringify(sorted(manifest.optional_host_permissions)) !==
    JSON.stringify(["http://*/*", "https://*/*"])
  ) {
    throw new Error("E2E optional host permissions differ from the approved split.");
  }
  if (manifest.options_ui?.open_in_tab !== true) {
    throw new Error("E2E options must open in a real extension tab.");
  }
}

export function assertReaderHookArtifact(backgroundBundle: string, e2e: boolean): void {
  const containsHook = backgroundBundle.includes(E2E_READER_HOOK_NAME);
  if (e2e && !containsHook) {
    throw new Error("The e2e background artifact is missing the reader hook.");
  }
  if (!e2e && containsHook) {
    throw new Error("The production background artifact contains the e2e reader hook.");
  }
}

export function assertProductionArtifactSecurity(
  backgroundBundle: string,
  forbiddenE2eEndpoints?: E2eBuildEndpoints,
): void {
  if (backgroundBundle.includes("__EXPLAIN_THIS_E2E_OLLAMA_BASE_URL__")) {
    throw new Error("A production package retained an E2E endpoint constant.");
  }
  if (backgroundBundle.includes("__EXPLAIN_THIS_E2E_STREAM_TIMEOUT_MS__")) {
    throw new Error("A production package retained an E2E stream timeout constant.");
  }
  if (backgroundBundle.includes(E2E_OLLAMA_BASE_URL)) {
    throw new Error("A production package retained an E2E endpoint variable.");
  }
  if (backgroundBundle.includes(E2E_FIXTURE_ORIGIN)) {
    throw new Error("A production package retained an E2E fixture-origin variable.");
  }
  if (
    forbiddenE2eEndpoints &&
    (backgroundBundle.includes(forbiddenE2eEndpoints.ollamaOrigin) ||
      backgroundBundle.includes(forbiddenE2eEndpoints.fixtureOrigin))
  ) {
    throw new Error("A production package retained an E2E endpoint value.");
  }
  assertReaderHookArtifact(backgroundBundle, false);
  if (!backgroundBundle.includes("http://127.0.0.1:11434")) {
    throw new Error(
      "The production Ollama endpoint was not compiled into the package.",
    );
  }
}

/** Build in a child process with test origins removed unless the e2e mode requires them. */
export function buildInvocation(options: BuildOptions): BuildInvocation {
  const environment: NodeJS.ProcessEnv = { ...process.env, ...options.environment };
  delete environment[E2E_OLLAMA_BASE_URL];
  delete environment[E2E_FIXTURE_ORIGIN];

  if (options.mode === "e2e") {
    const endpoints = parseE2eBuildEndpoints(options.environment);
    environment[E2E_OLLAMA_BASE_URL] = endpoints.ollamaOrigin;
    environment[E2E_FIXTURE_ORIGIN] = endpoints.fixtureOrigin;
  }

  return { args: ["build", "--mode", options.mode], environment };
}

async function readManifest(outputPath: string): Promise<ExtensionManifest> {
  return JSON.parse(
    await readFile(path.join(outputPath, "manifest.json"), "utf8"),
  ) as ExtensionManifest;
}

async function configureE2eOptionsTab(outputPath: string): Promise<ExtensionManifest> {
  const manifestPath = path.join(outputPath, "manifest.json");
  const manifest = await readManifest(outputPath);
  await writeFile(
    manifestPath,
    `${JSON.stringify({ ...manifest, options_ui: { ...manifest.options_ui, open_in_tab: true } }, null, 2)}\n`,
    "utf8",
  );
  return readManifest(outputPath);
}

async function assertCompiledEndpointConstant(
  outputPath: string,
  endpoints: E2eBuildEndpoints | undefined,
  forbiddenE2eEndpoints?: E2eBuildEndpoints,
): Promise<void> {
  const backgroundBundle = await readFile(
    path.join(outputPath, "background.js"),
    "utf8",
  );
  if (endpoints && !backgroundBundle.includes(endpoints.ollamaOrigin)) {
    throw new Error("The E2E Ollama endpoint was not compiled into the test package.");
  }
  if (endpoints) {
    if (backgroundBundle.includes("__EXPLAIN_THIS_E2E_OLLAMA_BASE_URL__")) {
      throw new Error("The E2E endpoint constant was not compiled away.");
    }
    if (backgroundBundle.includes("__EXPLAIN_THIS_E2E_STREAM_TIMEOUT_MS__")) {
      throw new Error("The E2E stream timeout constant was not compiled away.");
    }
    assertReaderHookArtifact(backgroundBundle, true);
  } else {
    assertProductionArtifactSecurity(backgroundBundle, forbiddenE2eEndpoints);
  }
}

export async function buildExtension(options: BuildOptions): Promise<BuiltExtension> {
  const rootDir = options.rootDir ?? path.resolve(import.meta.dirname, "../..");
  const invocation = buildInvocation(options);
  await runFile(
    process.execPath,
    ["node_modules/wxt/bin/wxt.mjs", ...invocation.args],
    {
      cwd: rootDir,
      env: invocation.environment,
    },
  );
  const outputPath = path.join(
    rootDir,
    ".output",
    options.mode === "e2e" ? "chrome-mv3-e2e" : "chrome-mv3",
  );
  const manifest = await readManifest(outputPath);
  if (options.mode === "e2e") {
    const e2eManifest = await configureE2eOptionsTab(outputPath);
    const endpoints = parseE2eBuildEndpoints(options.environment);
    assertE2eManifestSecurity(e2eManifest, endpoints);
    await assertCompiledEndpointConstant(outputPath, endpoints);
    return { outputPath, manifest: e2eManifest };
  } else {
    assertProductionManifestSecurity(manifest);
    await assertCompiledEndpointConstant(
      outputPath,
      undefined,
      options.forbiddenE2eEndpoints,
    );
  }
  return { outputPath, manifest };
}

/** Remove only a real mkdtemp profile directly below the canonical OS temp directory. */
export async function removeExtensionProfile(profilePath: string): Promise<void> {
  const tempRoot = await realpath(os.tmpdir());
  const lexicalProfile = path.resolve(profilePath);
  if (
    path.dirname(lexicalProfile) !== tempRoot ||
    !path.basename(lexicalProfile).startsWith(profilePrefix)
  ) {
    throw new Error("Unsafe extension profile path.");
  }
  const resolvedProfile = await realpath(lexicalProfile);
  if (
    path.dirname(resolvedProfile) !== tempRoot ||
    !path.basename(resolvedProfile).startsWith(profilePrefix)
  ) {
    throw new Error("Unsafe extension profile path.");
  }
  await rm(resolvedProfile, { recursive: true, force: false });
}

export async function closeResourcesInOrder(
  closeActions: ReadonlyArray<() => Promise<void>>,
  message: string,
): Promise<void> {
  const errors: unknown[] = [];
  for (const closeAction of closeActions) {
    try {
      await closeAction();
    } catch (error: unknown) {
      errors.push(error);
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, message);
}

/** Close Chromium and its temporary profile independently, retaining every failure. */
export async function closeExtensionResources(
  context: Pick<BrowserContext, "close"> | undefined,
  profilePath: string,
): Promise<void> {
  await closeResourcesInOrder(
    [async () => context?.close(), async () => removeExtensionProfile(profilePath)],
    "Failed to close extension resources.",
  );
}

async function extensionWorker(context: BrowserContext): Promise<Worker> {
  const existing = context
    .serviceWorkers()
    .find((worker) => worker.url().startsWith("chrome-extension://"));
  const worker = existing ?? (await context.waitForEvent("serviceworker"));
  if (!worker.url().startsWith("chrome-extension://")) {
    throw new Error("The packaged extension service worker was not available.");
  }
  return worker;
}

async function waitForStorageBootstrap(worker: Worker): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const storage = (await worker.evaluate(async () => {
      const chromeApi = (globalThis as unknown as { chrome: ExtensionChromeApi })
        .chrome;
      return chromeApi.storage.local.get();
    })) as Record<string, unknown>;
    if (Object.hasOwn(storage, "settings")) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("The extension storage bootstrap did not settle.");
}

export async function launchExtension(
  extensionPath = path.resolve(".output/chrome-mv3-e2e"),
): Promise<ExtensionFixture> {
  const profilePath = await mkdtemp(path.join(os.tmpdir(), profilePrefix));
  let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(profilePath, {
      headless: false,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
      ],
    });
    const worker = await extensionWorker(context);
    await waitForStorageBootstrap(worker);
    const launchedContext = context;
    const extensionId = new URL(worker.url()).host;
    const ownedPages = new Set<Page>();
    for (const page of launchedContext.pages()) {
      if (page.url().startsWith(`chrome-extension://${extensionId}/`)) {
        ownedPages.add(page);
      }
    }
    const anchor = await launchedContext.newPage();
    await anchor.goto("about:blank");
    ownedPages.add(anchor);
    const extensionUrl = (pathname: string): string =>
      `chrome-extension://${extensionId}/${pathname}`;

    return {
      context,
      extensionId,
      profilePath,
      async openOptions() {
        const page = await launchedContext.newPage();
        ownedPages.add(page);
        await page.goto(extensionUrl("options.html"));
        return page;
      },
      async openSidePanel(sourcePage) {
        const page = await launchedContext.newPage();
        ownedPages.add(page);
        await sourcePage.bringToFront();
        await page.goto(extensionUrl("sidepanel.html"));
        return page;
      },
      async openFixture(url) {
        const page = await launchedContext.newPage();
        ownedPages.add(page);
        await page.goto(url);
        return page;
      },
      async resetPages() {
        const pages = [...ownedPages].filter((page) => page !== anchor);
        await Promise.all(
          pages.map(async (page) => {
            ownedPages.delete(page);
            await page.close().catch(() => undefined);
          }),
        );
        await anchor.bringToFront();
      },
      async readTrustedStorage(area = "local") {
        return worker.evaluate(async (storageArea) => {
          const chromeApi = (globalThis as unknown as { chrome: ExtensionChromeApi })
            .chrome;
          return chromeApi.storage[storageArea].get();
        }, area) as Promise<Record<string, unknown>>;
      },
      async resetTrustedState() {
        await worker.evaluate(async () => {
          const chromeApi = (globalThis as unknown as { chrome: ExtensionChromeApi })
            .chrome;
          await Promise.all([
            chromeApi.storage.local.clear(),
            chromeApi.storage.session.clear(),
          ]);
        });
      },
      async writeTrustedStorage(values, area = "local") {
        await worker.evaluate(
          async ({ storageArea, nextValues }) => {
            const chromeApi = (globalThis as unknown as { chrome: ExtensionChromeApi })
              .chrome;
            await chromeApi.storage[storageArea].set(nextValues);
          },
          { storageArea: area, nextValues: values },
        );
      },
      async invokePackagedReader(page) {
        await page.bringToFront();
        const activeTabs = await worker.evaluate(async () => {
          const chromeApi = (
            globalThis as unknown as {
              chrome: {
                tabs: {
                  query(input: {
                    active: boolean;
                    currentWindow: boolean;
                  }): Promise<Array<{ id?: number; url?: string }>>;
                };
              };
            }
          ).chrome;
          return (
            await chromeApi.tabs.query({ active: true, currentWindow: true })
          ).map((tab) => ({ id: tab.id, url: tab.url }));
        });
        const activeTab = activeTabs.find((tab) => tab.url === page.url());
        if (!activeTab || typeof activeTab.id !== "number") {
          throw new Error(
            `The fixture page is not the active trusted tab: ${JSON.stringify(activeTabs)}.`,
          );
        }
        const pageOrigin = new URL(page.url()).origin;
        const fixturePermissions = await worker.evaluate(async (origin) => {
          const chromeApi = (
            globalThis as unknown as {
              chrome: {
                permissions: {
                  contains(input: { origins: string[] }): Promise<boolean>;
                  getAll(): Promise<{ origins?: string[] }>;
                };
              };
            }
          ).chrome;
          return {
            granted: (await chromeApi.permissions.getAll()).origins ?? [],
            exactOrigin: await chromeApi.permissions.contains({
              origins: [`${origin}/*`],
            }),
            loopbackHost: await chromeApi.permissions.contains({
              origins: ["http://127.0.0.1/*"],
            }),
          };
        }, pageOrigin);
        if (!fixturePermissions.loopbackHost) {
          throw new Error(
            `The e2e package lacks fixture permission for ${pageOrigin}: ${JSON.stringify(fixturePermissions)}.`,
          );
        }
        await worker.evaluate(async (hookName) => {
          const hook = (globalThis as unknown as Record<string, unknown>)[hookName];
          if (typeof hook !== "function") {
            throw new Error(
              "The e2e reader hook is unavailable in the service worker.",
            );
          }
          await (hook as () => Promise<void>)();
        }, E2E_READER_HOOK_NAME);
        const deadline = Date.now() + 10_000;
        let lastStatus: unknown;
        while (Date.now() < deadline) {
          const status = await worker.evaluate((statusName) => {
            return (globalThis as unknown as Record<string, unknown>)[statusName];
          }, E2E_READER_HOOK_STATUS_NAME);
          lastStatus = status;
          if (
            status &&
            typeof status === "object" &&
            "state" in status &&
            status.state === "complete"
          ) {
            const readerState = await page.evaluate(() => {
              const host = document.querySelector("explain-this-reader");
              return {
                host: host !== null,
                shadow: host?.shadowRoot !== null && host?.shadowRoot !== undefined,
                surfaceCount:
                  host?.shadowRoot?.querySelectorAll("[data-reader-surface]").length ??
                  0,
                toolbarCount:
                  host?.shadowRoot?.querySelectorAll('[role="toolbar"]').length ?? 0,
              };
            });
            if (!readerState.host || !readerState.shadow) {
              throw new Error(
                `The packaged reader did not reach the action surface: ${JSON.stringify(readerState)}.`,
              );
            }
            return;
          }
          if (
            status &&
            typeof status === "object" &&
            "state" in status &&
            status.state === "error"
          ) {
            throw new Error(`The e2e reader hook failed: ${JSON.stringify(status)}.`);
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        const pageState = await page.evaluate(() => ({
          readerHostCount: document.querySelectorAll("explain-this-reader").length,
          readyState: document.readyState,
        }));
        throw new Error(
          `The e2e reader hook did not complete: ${JSON.stringify({ lastStatus, pageState })}.`,
        );
      },
      async close() {
        await closeExtensionResources(launchedContext, profilePath);
      },
    };
  } catch (error) {
    await closeExtensionResources(context, profilePath).catch(() => undefined);
    throw error;
  }
}
