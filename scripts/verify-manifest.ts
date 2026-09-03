import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface ManifestProblem {
  check: string;
  detail: string;
}

/** Everything the shipped extension is allowed to ask for. Anything else is a regression. */
const ALLOWED_PERMISSIONS = new Set([
  "activeTab",
  "contextMenus",
  "scripting",
  "sidePanel",
  "storage",
]);
/** Required hosts must stay on loopback; broad access is optional and user-granted. */
const ALLOWED_REQUIRED_HOSTS = new Set([
  "http://127.0.0.1:11434/*",
  "http://localhost:11434/*",
]);
const LOOPBACK_HOST = "http://127.0.0.1:11434/*";
const MINIMUM_CHROME_VERSION = 116;
const REMOTE_URL = /https?:\/\//iu;

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}

export function verifyManifest(input: unknown): ManifestProblem[] {
  const manifest = asObject(input);
  if (!manifest) {
    return [{ check: "manifest-shape", detail: "The manifest is not a JSON object." }];
  }

  const problems: ManifestProblem[] = [];
  const add = (check: string, detail: string): void => {
    problems.push({ check, detail });
  };

  if (manifest.manifest_version !== 3) {
    add(
      "manifest-version",
      `Expected manifest_version 3, found ${String(manifest.manifest_version)}.`,
    );
  }

  const minimum = Number.parseInt(String(manifest.minimum_chrome_version ?? ""), 10);
  if (!Number.isFinite(minimum) || minimum < MINIMUM_CHROME_VERSION) {
    add(
      "minimum-chrome-version",
      `Expected minimum_chrome_version of at least ${MINIMUM_CHROME_VERSION}, found ${String(manifest.minimum_chrome_version)}.`,
    );
  }

  const permissions = asStringArray(manifest.permissions);
  const unexpected = permissions.filter((name) => !ALLOWED_PERMISSIONS.has(name));
  if (unexpected.length > 0) {
    add("permissions", `Unexpected permissions: ${unexpected.join(", ")}.`);
  }

  const requiredHosts = asStringArray(manifest.host_permissions);
  const broadHosts = requiredHosts.filter((host) => !ALLOWED_REQUIRED_HOSTS.has(host));
  if (broadHosts.length > 0) {
    add(
      "required-host-permissions",
      `Required host permissions must stay on the approved loopback origins; found ${broadHosts.join(", ")}.`,
    );
  }
  if (!requiredHosts.includes(LOOPBACK_HOST)) {
    add(
      "loopback-permission",
      `Required host permissions must include ${LOOPBACK_HOST}.`,
    );
  }

  // The reader is injected at runtime, so a declared content script would silently widen
  // the extension's reach on ordinary pages.
  const contentScripts = Array.isArray(manifest.content_scripts)
    ? manifest.content_scripts
    : [];
  if (contentScripts.length > 0) {
    add(
      "content-scripts",
      "The production manifest must declare no content scripts; the reader is injected at runtime.",
    );
  }

  if (asObject(manifest.action)?.default_popup !== undefined) {
    add("popup", "The extension must not ship a popup entrypoint.");
  }

  const remoteSources: string[] = [];
  const serviceWorker = asObject(manifest.background)?.service_worker;
  if (typeof serviceWorker === "string" && REMOTE_URL.test(serviceWorker)) {
    remoteSources.push(`background.service_worker ${serviceWorker}`);
  }
  const policy = asObject(manifest.content_security_policy);
  for (const [key, value] of Object.entries(policy ?? {})) {
    if (typeof value === "string" && REMOTE_URL.test(value)) {
      remoteSources.push(`content_security_policy.${key}`);
    }
  }
  const webAccessible = Array.isArray(manifest.web_accessible_resources)
    ? manifest.web_accessible_resources
    : [];
  for (const entry of webAccessible) {
    for (const resource of asStringArray(asObject(entry)?.resources)) {
      if (REMOTE_URL.test(resource))
        remoteSources.push(`web_accessible_resources ${resource}`);
    }
  }
  if (remoteSources.length > 0) {
    add(
      "remote-code",
      `Remote or externally hosted code referenced by: ${remoteSources.join("; ")}.`,
    );
  }

  return problems;
}

export async function verifyManifestFile(file: string): Promise<ManifestProblem[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    return [
      {
        check: "manifest-shape",
        detail: `Could not read ${file}: ${error instanceof Error ? error.message : String(error)}.`,
      },
    ];
  }
  return verifyManifest(parsed);
}

async function main(): Promise<void> {
  const file = process.argv[2];
  if (file === undefined) {
    console.error("Usage: tsx scripts/verify-manifest.ts <manifest.json>");
    process.exitCode = 2;
    return;
  }
  const problems = await verifyManifestFile(file);
  if (problems.length === 0) {
    console.log(`Manifest verified: ${file}`);
    return;
  }
  for (const problem of problems) console.error(`${problem.check}: ${problem.detail}`);
  process.exitCode = 1;
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined) {
  const invokedDirectly =
    path.resolve(entryPoint) === path.resolve(fileURLToPath(import.meta.url));
  if (invokedDirectly) await main();
}
