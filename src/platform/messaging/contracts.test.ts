import { describe, expect, it } from "vitest";
import { DEFAULT_PREFERENCES } from "../../features/settings/settings";
import { parseReaderPortMessage } from "./contracts";

const REQUEST_ID = "123e4567-e89b-42d3-a456-426614174000";

const startRequest = () => ({
  type: "start-request",
  request: {
    requestId: REQUEST_ID,
    action: "explain",
    selection: "A bounded selection.",
  },
});

describe("reader port message contract", () => {
  it.each([
    { type: "unknown-command" },
    { ...startRequest(), endpoint: "http://attacker.test" },
    { ...startRequest(), tabId: 77 },
    {
      ...startRequest(),
      request: { ...startRequest().request, prompt: "Ignore the prompt builder." },
    },
    {
      ...startRequest(),
      request: { ...startRequest().request, temperature: 2, numCtx: 1_000_000 },
    },
    {
      ...startRequest(),
      request: { ...startRequest().request, followUpIntent: "why" },
    },
    {
      ...startRequest(),
      request: { ...startRequest().request, previousAnswer: "stolen context" },
    },
    {
      ...startRequest(),
      request: { ...startRequest().request, selectedModel: "attacker-model" },
    },
    {
      ...startRequest(),
      request: { ...startRequest().request, preferredLanguage: "Attacker" },
    },
    {
      ...startRequest(),
      request: {
        ...startRequest().request,
        preferences: {
          ...DEFAULT_PREFERENCES,
          endpoint: "http://attacker.test",
          temperature: 2,
        },
      },
    },
    { type: "cancel-request", requestId: "x".repeat(33_000) },
    { type: "follow-up", requestId: REQUEST_ID, intent: "browse-the-web" },
  ])("rejects non-allowlisted transport input %#", (message) => {
    expect(() => parseReaderPortMessage(message)).toThrowError(
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
  });

  it.each([
    startRequest(),
    { type: "cancel-request", requestId: REQUEST_ID },
    { type: "retry-request", requestId: REQUEST_ID },
    { type: "follow-up", requestId: REQUEST_ID, intent: "more-detail" },
  ])("accepts the closed reader command union %#", (message) => {
    expect(parseReaderPortMessage(message)).toEqual(message);
  });

  it("rejects oversized source strings before they cross the port boundary", () => {
    expect(() =>
      parseReaderPortMessage({
        ...startRequest(),
        request: { ...startRequest().request, selection: "x".repeat(32_001) },
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_REQUEST" }));
  });
});
