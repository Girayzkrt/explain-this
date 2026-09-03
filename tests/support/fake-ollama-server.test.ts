// @vitest-environment node

import { Agent, request as httpRequest } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { RECOMMENDED_MODEL } from "../../src/shared/constants";
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

function settlesWithin<T>(
  promise: Promise<T>,
  milliseconds = 75,
): Promise<"settled" | "pending"> {
  return Promise.race([
    promise.then(() => "settled" as const),
    new Promise<"pending">((resolve) =>
      setTimeout(() => resolve("pending"), milliseconds),
    ),
  ]);
}

function requestWithAgent(url: string, agent: Agent): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { agent }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode ?? 0));
    });
    request.once("error", reject);
    request.end();
  });
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
          name: RECOMMENDED_MODEL,
          model: RECOMMENDED_MODEL,
          size: 1_930_000_000,
          details: { family: "qwen2.5", parameter_size: "3B" },
        }),
        expect.objectContaining({
          name: "gemma4:26b-cloud",
          model: "gemma4:26b-cloud",
          size: 0,
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
      models: [
        expect.objectContaining({ name: RECOMMENDED_MODEL }),
        expect.objectContaining({ name: "gemma4:26b-cloud" }),
      ],
    });
  });

  it("makes download progress visible before a deterministic completion release", async () => {
    const server = await startServer();
    server.setScenario({ pull: "progress" });

    const response = await fetch(`${server.baseUrl}/api/pull`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "chrome-extension://contract-test",
      },
      body: JSON.stringify({ model: RECOMMENDED_MODEL, stream: true }),
    });

    const reader = response.body?.getReader();
    const first = await reader?.read();
    expect(new TextDecoder().decode(first?.value)).toContain('"completed":25');
    const nextChunk = reader?.read();
    if (!nextChunk) throw new Error("The fake pull response has no readable body.");
    expect(await settlesWithin(nextChunk)).toBe("pending");

    const releasePull = (server as unknown as { releasePull?: () => void }).releasePull;
    expect(releasePull).toBeTypeOf("function");
    releasePull?.();

    const remaining = await nextChunk;
    expect(new TextDecoder().decode(remaining?.value)).toContain('"completed":100');
    expect(server.requests).toEqual([
      expect.objectContaining({
        method: "POST",
        path: "/api/pull",
        origin: "chrome-extension://contract-test",
        body: { model: RECOMMENDED_MODEL, stream: true },
      }),
    ]);
  });

  it("makes a chat delta visible before its deterministic completion release", async () => {
    const server = await startServer();
    server.setScenario({ chat: "normal" });

    const response = await fetch(`${server.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: RECOMMENDED_MODEL, messages: [], stream: true }),
    });

    const reader = response.body?.getReader();
    const first = await reader?.read();
    expect(new TextDecoder().decode(first?.value)).toContain('"content":"Local "');
    const nextChunk = reader?.read();
    if (!nextChunk) throw new Error("The fake chat response has no readable body.");
    expect(await settlesWithin(nextChunk)).toBe("pending");

    server.releaseChat();

    const remaining = await nextChunk;
    const text = new TextDecoder().decode(remaining?.value);
    expect(text).toContain('"content":"answer."');
    expect(text).toContain('"done":true');
  });

  it("provides a deterministic slow-generation metric for readiness-warning flows", async () => {
    const server = await startServer();
    server.setScenario({ chat: "slow-generation" as never });

    const response = await fetch(`${server.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: RECOMMENDED_MODEL, messages: [], stream: true }),
    });
    const reader = response.body?.getReader();
    await reader?.read();
    server.releaseChat();
    const finalChunk = await reader?.read();

    expect(new TextDecoder().decode(finalChunk?.value)).toContain('"eval_count":4');
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

  it("withholds slow-first-token response headers until explicitly released", async () => {
    const server = await startServer();
    server.setScenario({ chat: "slow-first-token" });
    const responsePromise = fetch(`${server.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: RECOMMENDED_MODEL, messages: [], stream: true }),
    });

    await server.waitForRequest((request) => request.path === "/api/chat");
    expect(await settlesWithin(responsePromise)).toBe("pending");
    server.releaseChat();

    const response = await responsePromise;
    const body = response.text();

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
      body: JSON.stringify({ model: RECOMMENDED_MODEL, messages: [], stream: true }),
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
      body: JSON.stringify({ model: RECOMMENDED_MODEL, messages: [], stream: true }),
    });
    const text = await response.text();

    expect(
      text.startsWith(
        '{"message":{"role":"assistant","content":"Partial output","thinking":""},"done":false}\n',
      ),
    ).toBe(true);
    expect(text.endsWith('{"message":')).toBe(true);
  });

  it("destroys an existing keep-alive socket when becoming unreachable and recovers on reset", async () => {
    const server = await startServer();
    const agent = new Agent({ keepAlive: true });

    try {
      await expect(requestWithAgent(`${server.baseUrl}/api/tags`, agent)).resolves.toBe(
        200,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(Object.values(agent.freeSockets).flat()).not.toHaveLength(0);

      server.setUnreachable(true);
      await expect(
        requestWithAgent(`${server.baseUrl}/api/tags`, agent),
      ).rejects.toThrow();

      server.setUnreachable(false);
      await expect(fetch(`${server.baseUrl}/api/tags`)).resolves.toMatchObject({
        status: 200,
      });

      server.setUnreachable(true);
      server.reset();
      await expect(fetch(`${server.baseUrl}/api/tags`)).resolves.toMatchObject({
        status: 200,
      });
    } finally {
      agent.destroy();
    }
  });

  it("streams hostile model markup as literal chat content", async () => {
    const server = await startServer();
    server.setScenario({ chat: "hostile-markup" });

    const response = await fetch(`${server.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: RECOMMENDED_MODEL, messages: [], stream: true }),
    });
    const lines = (await readLines(response)) as {
      message?: { content?: string };
      done?: boolean;
    }[];
    const streamed = lines.map((line) => line.message?.content ?? "").join("");

    expect(streamed).toContain("[Model link](https://attacker.example)");
    expect(streamed).toContain("<img src=x onerror=alert(1)>");
    expect(streamed).toContain("<script>alert('MODEL_SCRIPT')</script>");
    expect(lines.at(-1)?.done).toBe(true);
  });
});
