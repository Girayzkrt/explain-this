import { describe, expect, it } from "vitest";
import { getOriginGuidance } from "./origin-guidance";

const RUNTIME_ID = "abcdefghijklmnopabcdefghijklmnop";
const EXACT_ORIGIN = `chrome-extension://${RUNTIME_ID}`;

describe("Ollama origin guidance", () => {
  it.each(["windows", "macos", "linux"] as const)(
    "uses only the exact extension origin on %s",
    (platform) => {
      const guidance = getOriginGuidance(platform, RUNTIME_ID);
      const serialized = JSON.stringify(guidance);

      expect(guidance.origin).toBe(EXACT_ORIGIN);
      expect(serialized).toContain(EXACT_ORIGIN);
      expect(serialized).not.toContain("chrome-extension://*");
      expect(serialized).not.toContain("OLLAMA_HOST");
      expect(serialized).not.toContain("0.0.0.0");
      expect(serialized).not.toMatch(/https?:\/\/(?!docs\.ollama\.com)/);
    },
  );

  it("uses the Environment Variables UI and tray restart on Windows", () => {
    expect(getOriginGuidance("windows", RUNTIME_ID).steps).toEqual([
      { kind: "text", text: "Open Windows Environment Variables." },
      { kind: "text", text: "Create or edit OLLAMA_ORIGINS with this value:" },
      { kind: "code", text: EXACT_ORIGIN },
      {
        kind: "text",
        text: "Quit Ollama from the system tray, then start the Ollama app again.",
      },
    ]);
  });

  it("uses launchctl with the exact origin and app restart on macOS", () => {
    expect(getOriginGuidance("macos", RUNTIME_ID).steps).toEqual([
      { kind: "text", text: "Quit the Ollama app." },
      { kind: "code", text: `launchctl setenv OLLAMA_ORIGINS "${EXACT_ORIGIN}"` },
      { kind: "text", text: "Start the Ollama app again." },
    ]);
  });

  it("uses a systemd override and daemon reload/restart on Linux", () => {
    expect(getOriginGuidance("linux", RUNTIME_ID).steps).toEqual([
      { kind: "text", text: "Create a systemd override for the Ollama service:" },
      { kind: "code", text: `[Service]\nEnvironment="OLLAMA_ORIGINS=${EXACT_ORIGIN}"` },
      { kind: "text", text: "Reload systemd and restart Ollama:" },
      {
        kind: "code",
        text: "sudo systemctl daemon-reload\nsudo systemctl restart ollama",
      },
    ]);
  });

  it("gives unknown platforms the official FAQ and exact origin value", () => {
    const guidance = getOriginGuidance("unknown", RUNTIME_ID);
    expect(guidance.steps).toEqual([
      { kind: "text", text: "Configure OLLAMA_ORIGINS with this exact value:" },
      { kind: "code", text: EXACT_ORIGIN },
      {
        kind: "link",
        text: "Official Ollama FAQ",
        href: "https://docs.ollama.com/faq",
      },
    ]);
  });
});
