import { describe, expect, it } from "vitest";
import { PublicError } from "../../core/requests/public-error";
import { normalizeOllamaBaseUrl } from "./url";

describe("normalizeOllamaBaseUrl", () => {
  it.each([
    ["http://127.0.0.1:11434", "http://127.0.0.1:11434/"],
    ["http://127.0.0.1:11434/", "http://127.0.0.1:11434/"],
    ["http://localhost:11434", "http://localhost:11434/"],
    ["http://localhost:11434/", "http://localhost:11434/"],
  ])("accepts the exact Ollama loopback API base %s", (input, expected) => {
    expect(normalizeOllamaBaseUrl(input).href).toBe(expected);
  });

  it.each([
    "https://127.0.0.1:11434",
    "http://127.0.0.1",
    "http://127.0.0.1:11435",
    "http://localhost",
    "http://localhost:80",
    "http://user@localhost:11434",
    "http://user:password@localhost:11434",
    "http://localhost:11434/api",
    "http://localhost:11434/api/../tags",
    "http://localhost:11434/%2e%2e/api",
    "http://localhost:11434/?target=elsewhere",
    "http://localhost:11434/#fragment",
    "http://[::1]:11434",
    "http://0.0.0.0:11434",
    "http://192.168.1.12:11434",
    "http://localhost.example.com:11434",
    "http://localhost%2eexample.com:11434",
    "http://127.0.0.1%2eexample.com:11434",
    "http://2130706433:11434",
    "http://0x7f000001:11434",
    "http://127.1:11434",
    "http://0177.0.0.1:11434",
    "not a url",
  ])("rejects a non-exact Ollama loopback API base %s", (input) => {
    expect(() => normalizeOllamaBaseUrl(input)).toThrow(
      expect.objectContaining({
        code: "INVALID_ENDPOINT",
        message: "The Ollama address is not allowed.",
        recoverable: false,
      }) as PublicError,
    );
  });
});
