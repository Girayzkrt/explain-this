import { describe, expect, it } from "vitest";
import {
  createSanitizedDiagnosticReport,
  serializeDiagnosticReport,
} from "./diagnostics";

describe("sanitized diagnostics", () => {
  it("constructs reports from the allowlisted facts only", () => {
    const report = createSanitizedDiagnosticReport({
      extensionVersion: "1.2.3",
      platform: "win32",
      endpoint: {
        hostname: "localhost",
        port: 9_999,
        pageUrl: "https://private.example",
      },
      selectedModel: {
        name: "qwen3:4b",
        family: "qwen",
        sizeBytes: 2_500_000_000,
        quantization: "Q4_K_M",
        token: "secret-token",
      },
      errorCode: "PROVIDER_ERROR",
      metrics: {
        durationMs: 42,
        promptTokens: 17,
        outputTokens: 8,
        response: "private",
      },
      automaticToolbar: true,
      onboardingVersion: 1,
      selection: "selected private text",
      context: { prompt: "private prompt", answer: "private answer" },
      response: "private response",
      pageUrl: "https://private.example",
      pageTitle: "Private title",
      cookies: "session=secret",
      headers: { authorization: "Bearer secret" },
    });

    expect(report).toEqual({
      extensionVersion: "1.2.3",
      platform: "win32",
      endpoint: { hostname: "localhost", port: 11434 },
      model: {
        name: "qwen3:4b",
        family: "qwen",
        sizeBytes: 2_500_000_000,
        quantization: "Q4_K_M",
      },
      errorCode: "PROVIDER_ERROR",
      metrics: { durationMs: 42, promptTokens: 17, outputTokens: 8 },
      permissions: { automaticToolbar: true },
      onboardingVersion: 1,
    });
    const serialized = serializeDiagnosticReport(report);
    expect(serialized).toBe(JSON.stringify(report, null, 2));
    expect(serialized).not.toMatch(
      /selected private text|private prompt|private answer|private response|private\.example|Private title|session=secret|Bearer secret/,
    );
    for (const forbiddenKey of [
      "selection",
      "context",
      'prompt"',
      "response",
      "answer",
      "pageUrl",
      "pageTitle",
      "cookies",
      "headers",
      'token"',
    ]) {
      expect(serialized).not.toContain(`"${forbiddenKey}`);
    }
  });

  it("drops polluted fields and unsafe strings or numeric values", () => {
    const polluted = Object.create({ prompt: "inherited secret" }) as Record<
      string,
      unknown
    >;
    polluted.extensionVersion = "x".repeat(300);
    polluted.platform = "linux";
    polluted.endpoint = { hostname: "evil.example", port: 12 };
    polluted.selectedModel = {
      name: "model",
      family: "x".repeat(300),
      sizeBytes: Infinity,
      quantization: "Q4",
    };
    polluted.metrics = {
      durationMs: -1,
      promptTokens: Infinity,
      outputTokens: 999_999_999,
    };
    polluted.automaticToolbar = "yes";
    polluted.onboardingVersion = 999;

    expect(createSanitizedDiagnosticReport(polluted)).toEqual({
      extensionVersion: "unknown",
      platform: "linux",
      endpoint: { hostname: "127.0.0.1", port: 11434 },
      model: { name: "model", quantization: "Q4" },
      permissions: { automaticToolbar: false },
      onboardingVersion: 0,
    });
  });

  it("does not read approved-looking values from a polluted prototype", () => {
    const polluted = Object.create({
      extensionVersion: "inherited-version",
      automaticToolbar: true,
      selectedModel: { name: "inherited-model" },
      metrics: { durationMs: 12 },
    }) as Record<string, unknown>;
    polluted.platform = "linux";

    expect(createSanitizedDiagnosticReport(polluted)).toEqual({
      extensionVersion: "unknown",
      platform: "linux",
      endpoint: { hostname: "127.0.0.1", port: 11434 },
      permissions: { automaticToolbar: false },
      onboardingVersion: 0,
    });
  });

  it("falls back safely when unknown input throws during own-property inspection", () => {
    const hostile = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error("private proxy detail");
        },
      },
    ) as Record<string, unknown>;

    expect(createSanitizedDiagnosticReport(hostile)).toEqual({
      extensionVersion: "unknown",
      platform: "unknown",
      endpoint: { hostname: "127.0.0.1", port: 11434 },
      permissions: { automaticToolbar: false },
      onboardingVersion: 0,
    });
  });

  it("falls back safely for revoked unknown objects", () => {
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();

    expect(createSanitizedDiagnosticReport(revoked.proxy)).toEqual({
      extensionVersion: "unknown",
      platform: "unknown",
      endpoint: { hostname: "127.0.0.1", port: 11434 },
      permissions: { automaticToolbar: false },
      onboardingVersion: 0,
    });
  });

  it("ignores values whose allowlisted getter throws", () => {
    const hostile = new Proxy(
      { extensionVersion: "private getter detail" },
      {
        get(target, key, receiver) {
          if (key === "extensionVersion") throw new Error("private getter detail");
          return Reflect.get(target, key, receiver);
        },
      },
    ) as Record<string, unknown>;

    expect(createSanitizedDiagnosticReport(hostile)).toEqual({
      extensionVersion: "unknown",
      platform: "unknown",
      endpoint: { hostname: "127.0.0.1", port: 11434 },
      permissions: { automaticToolbar: false },
      onboardingVersion: 0,
    });
  });
});
