// @vitest-environment node

import { describe, expect, it } from "vitest";
import { verifyPackageEntry, MAX_FILE_BYTES } from "./verify-package";

function checks(path: string, size = 1_000): string[] {
  return verifyPackageEntry(path, size).map((problem) => problem.check);
}

describe("package entry verification", () => {
  it.each([
    ["background.js"],
    ["manifest.json"],
    ["options.html"],
    ["assets/options-DtUSZL_M.css"],
    ["content-scripts/reader.js"],
  ])("accepts the shipped artifact %s", (file) => {
    expect(checks(file)).toEqual([]);
  });

  it("rejects a source map", () => {
    expect(checks("background.js.map")).toContain("source-map");
  });

  it.each([[".env"], [".DS_Store"]])("rejects the forbidden file %s", (file) => {
    expect(checks(file)).toContain("forbidden-file");
  });

  it.each([["tests/leak.js"], ["docs/plan.js"], ["artifacts/run.json"]])(
    "rejects %s shipping from a forbidden directory",
    (file) => {
      expect(checks(file)).toContain("forbidden-directory");
    },
  );

  it.each([["tool.exe"], ["lib.so"], ["notes.md"]])(
    "rejects the unexpected file type %s",
    (file) => {
      expect(checks(file)).toContain("unexpected-file-type");
    },
  );

  it("rejects a file above the documented size ceiling", () => {
    expect(checks("background.js", MAX_FILE_BYTES + 1)).toContain("file-size");
  });

  it("accepts a file exactly at the ceiling", () => {
    expect(checks("background.js", MAX_FILE_BYTES)).toEqual([]);
  });
});
