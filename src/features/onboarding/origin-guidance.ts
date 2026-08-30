export type OriginGuidancePlatform = "windows" | "macos" | "linux" | "unknown";

export type OriginGuidanceStep =
  | { kind: "text" | "code"; text: string }
  | { kind: "link"; text: string; href: string };

export interface OriginGuidance {
  origin: string;
  steps: OriginGuidanceStep[];
}

function extensionOrigin(runtimeId: string): string {
  if (!/^[a-z0-9_-]+$/i.test(runtimeId)) {
    throw new TypeError("The extension runtime ID is invalid.");
  }
  return `chrome-extension://${runtimeId}`;
}

export function getOriginGuidance(
  platform: OriginGuidancePlatform,
  runtimeId: string,
): OriginGuidance {
  const origin = extensionOrigin(runtimeId);
  switch (platform) {
    case "windows":
      return {
        origin,
        steps: [
          { kind: "text", text: "Open Windows Environment Variables." },
          { kind: "text", text: "Create or edit OLLAMA_ORIGINS with this value:" },
          { kind: "code", text: origin },
          {
            kind: "text",
            text: "Quit Ollama from the system tray, then start the Ollama app again.",
          },
        ],
      };
    case "macos":
      return {
        origin,
        steps: [
          { kind: "text", text: "Quit the Ollama app." },
          { kind: "code", text: `launchctl setenv OLLAMA_ORIGINS "${origin}"` },
          { kind: "text", text: "Start the Ollama app again." },
        ],
      };
    case "linux":
      return {
        origin,
        steps: [
          { kind: "text", text: "Create a systemd override for the Ollama service:" },
          { kind: "code", text: `[Service]\nEnvironment="OLLAMA_ORIGINS=${origin}"` },
          { kind: "text", text: "Reload systemd and restart Ollama:" },
          {
            kind: "code",
            text: "sudo systemctl daemon-reload\nsudo systemctl restart ollama",
          },
        ],
      };
    default:
      return {
        origin,
        steps: [
          { kind: "text", text: "Configure OLLAMA_ORIGINS with this exact value:" },
          { kind: "code", text: origin },
          {
            kind: "link",
            text: "Official Ollama FAQ",
            href: "https://docs.ollama.com/faq",
          },
        ],
      };
  }
}
