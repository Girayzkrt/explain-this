import { execFile } from "node:child_process";
import { mkdtemp, realpath, readFile, rm } from "node:fs/promises";
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
const productionHosts = ["http://127.0.0.1:11434/*", "http://localhost:11434/*"];

interface ExtensionManifest {
  host_permissions?: string[];
  optional_host_permissions?: string[];
}

interface ExtensionChromeApi {
  storage: Record<"local" | "session", { get(): Promise<Record<string, unknown>> }>;
}

interface BuildOptions {
  mode: "production" | "e2e";
  environment?: Record<string, string | undefined>;
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
  openSidePanel(): Promise<Page>;
  openFixture(url: string): Promise<Page>;
  readTrustedStorage(area?: "local" | "session"): Promise<Record<string, unknown>>;
  invokePackagedReader(page: Page): Promise<void>;
  close(): Promise<void>;
}

function sorted(values: readonly string[] | undefined): string[] {
  return [...(values ?? [])].sort();
}

function expectedE2eHosts(endpoints: E2eBuildEndpoints): string[] {
  return [
    ...productionHosts,
    `${endpoints.ollamaOrigin}/*`,
    `${endpoints.fixtureOrigin}/*`,
  ];
}

export { parseE2eBuildEndpoints };

export function assertProductionManifestSecurity(manifest: ExtensionManifest): void {
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
}

export function assertE2eManifestSecurity(
  manifest: ExtensionManifest,
  endpoints: E2eBuildEndpoints,
): void {
  const expectedHosts = sorted(expectedE2eHosts(endpoints));
  if (
    JSON.stringify(sorted(manifest.host_permissions)) !== JSON.stringify(expectedHosts)
  ) {
    throw new Error("E2E host permissions are not limited to the two test origins.");
  }
  if (
    JSON.stringify(sorted(manifest.optional_host_permissions)) !==
    JSON.stringify(["http://*/*", "https://*/*"])
  ) {
    throw new Error("E2E optional host permissions differ from the approved split.");
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

async function assertCompiledEndpointConstant(
  outputPath: string,
  endpoints: E2eBuildEndpoints | undefined,
): Promise<void> {
  const backgroundBundle = await readFile(
    path.join(outputPath, "background.js"),
    "utf8",
  );
  if (backgroundBundle.includes("__EXPLAIN_THIS_E2E_OLLAMA_BASE_URL__")) {
    throw new Error("The E2E endpoint constant was not compiled away.");
  }
  if (endpoints && !backgroundBundle.includes(endpoints.ollamaOrigin)) {
    throw new Error("The E2E Ollama endpoint was not compiled into the test package.");
  }
  if (!endpoints && backgroundBundle.includes(E2E_OLLAMA_BASE_URL)) {
    throw new Error("A production package retained an E2E endpoint variable.");
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
    const endpoints = parseE2eBuildEndpoints(options.environment);
    assertE2eManifestSecurity(manifest, endpoints);
    await assertCompiledEndpointConstant(outputPath, endpoints);
  } else {
    assertProductionManifestSecurity(manifest);
    await assertCompiledEndpointConstant(outputPath, undefined);
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
    const launchedContext = context;
    const extensionId = new URL(worker.url()).host;
    const extensionUrl = (pathname: string): string =>
      `chrome-extension://${extensionId}/${pathname}`;

    return {
      context,
      extensionId,
      profilePath,
      async openOptions() {
        const page = await launchedContext.newPage();
        await page.goto(extensionUrl("options.html"));
        return page;
      },
      async openSidePanel() {
        const page = await launchedContext.newPage();
        await page.goto(extensionUrl("sidepanel.html"));
        return page;
      },
      async openFixture(url) {
        const page = await launchedContext.newPage();
        await page.goto(url);
        return page;
      },
      async readTrustedStorage(area = "local") {
        return worker.evaluate(async (storageArea) => {
          const chromeApi = (globalThis as unknown as { chrome: ExtensionChromeApi })
            .chrome;
          return chromeApi.storage[storageArea].get();
        }, area) as Promise<Record<string, unknown>>;
      },
      async invokePackagedReader(page) {
        await page.bringToFront();
        await page.keyboard.press("Alt+Shift+E");
      },
      async close() {
        await launchedContext.close();
        await removeExtensionProfile(profilePath);
      },
    };
  } catch (error) {
    await context?.close().catch(() => undefined);
    await removeExtensionProfile(profilePath).catch(() => undefined);
    throw error;
  }
}
