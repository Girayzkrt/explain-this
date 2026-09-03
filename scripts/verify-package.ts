import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface PackageProblem {
  check: string;
  detail: string;
}

/** Documented ceiling: the whole package is ~1.1 MB today, so 4 MB leaves headroom. */
export const MAX_FILE_BYTES = 4 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set([
  ".css",
  ".html",
  ".js",
  ".json",
  ".png",
  ".svg",
  ".txt",
  ".webp",
  ".woff2",
]);
const FORBIDDEN_NAMES = [".env", ".env.local", ".DS_Store"];
const FORBIDDEN_SEGMENTS = [
  "artifacts",
  "docs",
  "tests",
  "node_modules",
  ".superpowers",
];
const REMOTE_SCRIPT =
  /(?:import\s*\(\s*["'`]https?:|src\s*=\s*["'`]https?:|importScripts\s*\(\s*["'`]https?:)/iu;

async function listFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(full);
      else found.push(path.relative(root, full).split(path.sep).join("/"));
    }
  }
  await walk(root);
  return found.sort();
}

export function verifyPackageEntry(
  relativePath: string,
  sizeBytes: number,
): PackageProblem[] {
  const problems: PackageProblem[] = [];
  const base = path.posix.basename(relativePath);
  const extension = path.posix.extname(relativePath).toLowerCase();

  if (relativePath.endsWith(".map")) {
    problems.push({ check: "source-map", detail: `${relativePath} is a source map.` });
  } else if (!ALLOWED_EXTENSIONS.has(extension)) {
    problems.push({
      check: "unexpected-file-type",
      detail: `${relativePath} has an unexpected extension (${extension || "none"}).`,
    });
  }

  if (FORBIDDEN_NAMES.includes(base)) {
    problems.push({
      check: "forbidden-file",
      detail: `${relativePath} must not ship.`,
    });
  }

  const segments = relativePath.split("/").slice(0, -1);
  const offending = segments.find((segment) => FORBIDDEN_SEGMENTS.includes(segment));
  if (offending !== undefined) {
    problems.push({
      check: "forbidden-directory",
      detail: `${relativePath} ships from a ${offending}/ directory.`,
    });
  }

  if (sizeBytes > MAX_FILE_BYTES) {
    problems.push({
      check: "file-size",
      detail: `${relativePath} is ${sizeBytes} bytes, above the ${MAX_FILE_BYTES} ceiling.`,
    });
  }

  return problems;
}

async function readHead(file: string, bytes = 512): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of createReadStream(file, { start: 0, end: bytes - 1 })) {
    const buffer = chunk as Buffer;
    chunks.push(buffer);
    total += buffer.length;
    if (total >= bytes) break;
  }
  return Buffer.concat(chunks).toString("latin1");
}

/** Reject anything that is not text or a known asset, e.g. a bundled native binary. */
function looksExecutable(head: string): boolean {
  return (
    head.startsWith("MZ") ||
    head.startsWith("\x7fELF") ||
    head.startsWith("\xca\xfe\xba\xbe")
  );
}

export async function verifyPackageDirectory(root: string): Promise<PackageProblem[]> {
  const problems: PackageProblem[] = [];
  const files = await listFiles(root);
  if (files.length === 0) {
    return [{ check: "package-shape", detail: `${root} contains no files.` }];
  }

  for (const relativePath of files) {
    const absolute = path.join(root, relativePath);
    const stats = await stat(absolute);
    problems.push(...verifyPackageEntry(relativePath, stats.size));

    const head = await readHead(absolute);
    if (looksExecutable(head)) {
      problems.push({
        check: "executable-format",
        detail: `${relativePath} begins with an executable signature.`,
      });
    }

    if (relativePath.endsWith(".js") || relativePath.endsWith(".html")) {
      const contents = await readFile(absolute, "utf8");
      if (REMOTE_SCRIPT.test(contents)) {
        problems.push({
          check: "remote-script",
          detail: `${relativePath} references a remotely hosted script.`,
        });
      }
    }
  }

  return problems;
}

async function main(): Promise<void> {
  const target = process.argv[2];
  if (target === undefined) {
    console.error("Usage: tsx scripts/verify-package.ts <package-directory>");
    process.exitCode = 2;
    return;
  }
  const problems = await verifyPackageDirectory(target);
  if (problems.length === 0) {
    console.log(`Package verified: ${target}`);
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
