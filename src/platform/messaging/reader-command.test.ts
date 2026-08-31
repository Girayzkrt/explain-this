import { describe, expect, it } from "vitest";
import { parseReaderInvocationCommand } from "./reader-command";

describe("reader invocation command", () => {
  it.each([
    { type: "capture-current-selection", action: "explain" },
    {
      type: "selection-action",
      action: "translate",
      selectionText: "Selected text",
    },
  ])("accepts a closed explicit command %#", (command) => {
    expect(parseReaderInvocationCommand(command)).toEqual(command);
  });

  it.each([
    { type: "capture-current-selection", action: "simplify" },
    { type: "selection-action", action: "browse", selectionText: "text" },
    { type: "selection-action", action: "explain", selectionText: "" },
    {
      type: "selection-action",
      action: "explain",
      selectionText: "text",
      endpoint: "https://attacker.example",
    },
  ])("rejects malformed or privileged invocation data %#", (command) => {
    expect(() => parseReaderInvocationCommand(command)).toThrow();
  });
});
