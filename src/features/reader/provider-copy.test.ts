import { describe, expect, it } from "vitest";
import { providerCopy } from "./provider-copy";

describe("providerCopy", () => {
  it("tells the truth about a local request without overclaiming elsewhere", () => {
    const copy = providerCopy("ollama-local");

    expect(copy.kicker).toBe("Local reader");
    expect(copy.ariaLabel).toBe("Local explanation");
    expect(copy.connecting).toBe("Connecting to local model…");
    expect(copy.explaining).toBe("Explaining locally…");
  });

  it("tells the reader their text left the machine when the mode is cloud", () => {
    const copy = providerCopy("ollama-cloud");

    expect(copy.kicker.toLowerCase()).not.toContain("local");
    expect(copy.ariaLabel.toLowerCase()).not.toContain("local");
    expect(copy.connecting.toLowerCase()).not.toContain("local");
    expect(copy.explaining.toLowerCase()).not.toContain("local");
    expect(copy.connecting.toLowerCase()).toContain("ollama");
    expect(copy.explaining.toLowerCase()).toContain("ollama");
  });

  it("never claims local or cloud processing when the mode is unknown", () => {
    const copy = providerCopy(undefined);

    for (const value of [
      copy.kicker,
      copy.ariaLabel,
      copy.connecting,
      copy.explaining,
    ]) {
      expect(value.toLowerCase()).not.toContain("local");
      expect(value.toLowerCase()).not.toContain("cloud");
      expect(value.toLowerCase()).not.toContain("ollama");
    }
  });
});
