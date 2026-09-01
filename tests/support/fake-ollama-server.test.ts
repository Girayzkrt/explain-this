// @vitest-environment node

import { afterEach, describe, expect, it } from "vitest";
import { startFakeOllamaServer, type FakeOllamaServer } from "./fake-ollama-server";

const openServers = new Set<FakeOllamaServer>();

async function startServer(): Promise<FakeOllamaServer> {
  const server = await startFakeOllamaServer();
  openServers.add(server);
  return server;
}

async function readLines(response: Response): Promise<unknown[]> {
  const text = await response.text();
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);
}

afterEach(async () => {
  await Promise.all([...openServers].map((server) => server.close()));
  openServers.clear();
});

describe("fake Ollama contract server", () => {
  it("binds an ephemeral IPv4 loopback port and closes idempotently", async () => {
    const server = await startServer();

    expect(server.hostname).toBe("127.0.0.1");
    expect(server.port).toBeGreaterThan(0);
    expect(server.baseUrl).toBe(`http://127.0.0.1:${server.port}`);
    await expect(fetch(`${server.baseUrl}/api/tags`)).resolves.toMatchObject({
      status: 200,
    });

    await server.close();
    await expect(server.close()).resolves.toBeUndefined();
    openServers.delete(server);
    await expect(fetch(`${server.baseUrl}/api/tags`)).rejects.toThrow();
  });

  it("rejects pending control waiters when it closes", async () => {
    const server = await startServer();
    const requestWaiter = server.waitForRequest(() => false);
    const cancellationWaiter = server.waitForCancellation("/api/chat");

    await server.close();

    const postCloseRequestWaiter = server.waitForRequest(() => false);
    const postCloseCancellationWaiter = server.waitForCancellation("/api/tags");
    const settled = (promise: Promise<unknown>) =>
      Promise.race([
        promise.then(
          () => "resolved",
          () => "rejected",
        ),
        new Promise<"timed out">((resolve) =>
          setTimeout(() => resolve("timed out"), 100),
        ),
      ]);
    const requestResult = await settled(requestWaiter);
    const cancellationResult = await settled(cancellationWaiter);
    const postCloseRequestResult = await settled(postCloseRequestWaiter);
    const postCloseCancellationResult = await settled(postCloseCancellationWaiter);

    expect(requestResult).toBe("rejected");
    expect(cancellationResult).toBe("rejected");
    expect(postCloseRequestResult).toBe("rejected");
    expect(postCloseCancellationResult).toBe("rejected");
    openServers.delete(server);
  });

  it("serves deterministic empty and installed model libraries", async () => {
    const server = await startServer();
    server.setScenario({ tags: "no-model" });

    await expect(
      fetch(`${server.baseUrl}/api/tags`).then((response) => response.json()),
    ).resolves.toEqual({ models: [] });

    server.setScenario({ tags: "model" });
    await expect(
      fetch(`${server.baseUrl}/api/tags`).then((response) => response.json()),
    ).resolves.toEqual({
      models: [
        expect.objectContaining({
          name: "qwen3:4b",
          size: 2_500_000_000,
          details: { family: "qwen3", parameter_size: "4B" },
        }),
      ],
    });
  });

  it("resets scenarios and request records for deterministic reuse", async () => {
    const server = await startServer();
    server.setScenario({ tags: "no-model" });
    await fetch(`${server.baseUrl}/api/tags`);

    server.reset();

    expect(server.requests).toEqual([]);
    await expect(
      fetch(`${server.baseUrl}/api/tags`).then((response) => response.json()),
    ).resolves.toEqual({
      models: [expect.objectContaining({ name: "qwen3:4b" })],
    });
  });

  it("streams pull progress and records the exact request contract", async () => {
    const server = await startServer();
    server.setScenario({ pull: "progress" });

    const response = await fetch(`${server.baseUrl}/api/pull`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "chrome-extension://contract-test",
      },
      body: JSON.stringify({ model: "qwen3:4b", stream: true }),
    });

    await expect(readLines(response)).resolves.toEqual([
      { status: "pulling manifest" },
      { status: "downloading", completed: 25, total: 100 },
      { status: "downloading", completed: 100, total: 100 },
      { status: "success" },
    ]);
    expect(server.requests).toEqual([
      expect.objectContaining({
        method: "POST",
        path: "/api/pull",
        origin: "chrome-extension://contract-test",
        body: { model: "qwen3:4b", stream: true },
      }),
    ]);
  });

  it("streams normal chat chunks with stable content and metrics", async () => {
    const server = await startServer();
    server.setScenario({ chat: "normal" });

    const response = await fetch(`${server.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "qwen3:4b", messages: [], stream: true }),
    });

    await expect(readLines(response)).resolves.toEqual([
      {
        message: { role: "assistant", content: "Local ", thinking: "" },
        done: false,
      },
      {
        message: { role: "assistant", content: "answer.", thinking: "" },
        done: false,
      },
      {
        message: { role: "assistant", content: "", thinking: "" },
        done: true,
        total_duration: 1_000_000_000,
        prompt_eval_count: 12,
        eval_count: 10,
      },
    ]);
  });

  it.each([
    ["origin-reject", 403],
    ["missing-model", 404],
    ["http-failure", 500],
  ] as const)(
    "returns the %s chat status without echoing request content",
    async (chat, status) => {
      const server = await startServer();
      server.setScenario({ chat });

      const response = await fetch(`${server.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "private-model-name",
          messages: [{ role: "user", content: "private selected source" }],
          stream: true,
        }),
      });

      expect(response.status).toBe(status);
      expect(await response.text()).not.toMatch(/private-model-name|private selected/i);
    },
  );

  it("holds a slow first token until explicitly released", async () => {
    const server = await startServer();
    server.setScenario({ chat: "slow-first-token" });
    const response = await fetch(`${server.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "qwen3:4b", messages: [], stream: true }),
    });
    const body = response.text();

    await server.waitForRequest((request) => request.path === "/api/chat");
    server.releaseChat();

    await expect(body).resolves.toContain('"content":"Delayed answer."');
  });

  it("keeps an idle stream open after one chunk and detects client cancellation", async () => {
    const server = await startServer();
    server.setScenario({ chat: "idle-stream" });
    const caller = new AbortController();
    const response = await fetch(`${server.baseUrl}/api/chat`, {
      method: "POST",
      signal: caller.signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "qwen3:4b", messages: [], stream: true }),
    });
    const reader = response.body?.getReader();
    await expect(reader?.read()).resolves.toMatchObject({ done: false });

    const cancelled = server.waitForCancellation("/api/chat");
    caller.abort();

    await expect(cancelled).resolves.toEqual({ path: "/api/chat" });
  });

  it("ends malformed chat only after a valid partial chunk", async () => {
    const server = await startServer();
    server.setScenario({ chat: "malformed-partial" });

    const response = await fetch(`${server.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "qwen3:4b", messages: [], stream: true }),
    });
    const text = await response.text();

    expect(
      text.startsWith(
        '{"message":{"role":"assistant","content":"Partial output","thinking":""},"done":false}\n',
      ),
    ).toBe(true);
    expect(text.endsWith('{"message":')).toBe(true);
  });
});
