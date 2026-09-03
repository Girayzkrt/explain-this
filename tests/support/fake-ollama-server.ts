import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { RECOMMENDED_CLOUD_MODEL, RECOMMENDED_MODEL } from "../../src/shared/constants";

export type TagsScenario = "no-model" | "model" | "origin-reject" | "http-failure";
export type ShowScenario = "model" | "missing-model" | "origin-reject" | "http-failure";
export type PullScenario = "progress" | "origin-reject" | "http-failure";
export type ChatScenario =
  | "normal"
  | "slow-generation"
  | "hostile-markup"
  | "slow-first-token"
  | "idle-stream"
  | "malformed-partial"
  | "missing-model"
  | "origin-reject"
  | "http-failure";

export interface FakeOllamaScenario {
  tags: TagsScenario;
  show: ShowScenario;
  pull: PullScenario;
  chat: ChatScenario;
}

export interface RecordedOllamaRequest {
  method: string;
  path: string;
  origin?: string;
  body?: unknown;
}

export interface FakeOllamaCancellation {
  path: string;
}

export interface FakeOllamaServer {
  readonly hostname: "127.0.0.1";
  readonly port: number;
  readonly baseUrl: string;
  readonly requests: readonly RecordedOllamaRequest[];
  readonly cancellations: readonly FakeOllamaCancellation[];
  setScenario(scenario: Partial<FakeOllamaScenario>): void;
  /** Destroy incoming connections so the extension observes a genuinely unreachable host. */
  setUnreachable(enabled: boolean): void;
  reset(): void;
  releasePull(): void;
  releaseChat(): void;
  waitForRequest(
    predicate: (request: RecordedOllamaRequest) => boolean,
  ): Promise<RecordedOllamaRequest>;
  waitForCancellation(path: string): Promise<FakeOllamaCancellation>;
  close(): Promise<void>;
}

const DEFAULT_SCENARIO: FakeOllamaScenario = {
  tags: "model",
  show: "model",
  pull: "progress",
  chat: "normal",
};
const MAX_BODY_BYTES = 1_000_000;

interface RequestWaiter {
  predicate: (request: RecordedOllamaRequest) => boolean;
  resolve(request: RecordedOllamaRequest): void;
  reject(error: Error): void;
}

interface CancellationWaiter {
  path: string;
  resolve(cancellation: FakeOllamaCancellation): void;
  reject(error: Error): void;
}

interface HeldResponse {
  path: string;
  response: ServerResponse;
  release(): void;
}

function jsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function corsHeaders(request: IncomingMessage): Record<string, string> {
  return {
    "access-control-allow-origin": request.headers.origin ?? "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    vary: "Origin",
  };
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  let body = "";
  for await (const chunk of request) {
    body += String(chunk);
    if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
      throw new Error("Request body exceeded the fake server limit.");
    }
  }
  return body === "" ? undefined : (JSON.parse(body) as unknown);
}

function sendJson(
  request: IncomingMessage,
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  response.writeHead(status, {
    ...corsHeaders(request),
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
}

function sendSafeError(
  request: IncomingMessage,
  response: ServerResponse,
  status: number,
): void {
  sendJson(request, response, status, { error: "Fake Ollama scenario failure." });
}

export async function startFakeOllamaServer(): Promise<FakeOllamaServer> {
  const hostname = "127.0.0.1" as const;
  const requests: RecordedOllamaRequest[] = [];
  const cancellations: FakeOllamaCancellation[] = [];
  const requestWaiters = new Set<RequestWaiter>();
  const cancellationWaiters = new Set<CancellationWaiter>();
  const sockets = new Set<Socket>();
  const heldResponses = new Set<HeldResponse>();
  let scenario = { ...DEFAULT_SCENARIO };
  let unreachable = false;
  let closed = false;

  const recordRequest = (record: RecordedOllamaRequest): void => {
    requests.push(record);
    for (const waiter of [...requestWaiters]) {
      if (!waiter.predicate(record)) continue;
      requestWaiters.delete(waiter);
      waiter.resolve(record);
    }
  };

  const recordCancellation = (path: string): void => {
    if (cancellations.some((item) => item.path === path)) return;
    const cancellation = { path };
    cancellations.push(cancellation);
    for (const waiter of [...cancellationWaiters]) {
      if (waiter.path !== path) continue;
      cancellationWaiters.delete(waiter);
      waiter.resolve(cancellation);
    }
  };

  const holdResponse = (
    path: string,
    response: ServerResponse,
    release: () => void,
  ): void => {
    const held = { path, response, release };
    heldResponses.add(held);
    let finished = false;
    response.once("finish", () => {
      finished = true;
      heldResponses.delete(held);
    });
    response.once("close", () => {
      heldResponses.delete(held);
      if (!finished && !closed) recordCancellation(path);
    });
  };

  const releaseResponses = (path: string): void => {
    for (const held of [...heldResponses]) {
      if (held.path !== path || held.response.destroyed || held.response.writableEnded)
        continue;
      held.release();
    }
  };

  const server = createServer(async (request, response) => {
    try {
      if (request.method === "OPTIONS") {
        response.writeHead(204, corsHeaders(request));
        response.end();
        return;
      }

      const url = new URL(request.url ?? "/", `http://${hostname}`);
      const body = request.method === "POST" ? await readJsonBody(request) : undefined;
      const record: RecordedOllamaRequest = {
        method: request.method ?? "GET",
        path: url.pathname,
        ...(request.headers.origin === undefined
          ? {}
          : { origin: request.headers.origin }),
        ...(body === undefined ? {} : { body }),
      };
      recordRequest(record);

      if (url.pathname === "/api/tags" && request.method === "GET") {
        if (scenario.tags === "origin-reject") {
          sendSafeError(request, response, 403);
        } else if (scenario.tags === "http-failure") {
          sendSafeError(request, response, 500);
        } else {
          sendJson(request, response, 200, {
            models:
              scenario.tags === "no-model"
                ? []
                : [
                    {
                      name: RECOMMENDED_MODEL,
                      model: RECOMMENDED_MODEL,
                      size: 1_930_000_000,
                      digest: "sha256:fake-contract",
                      details: { family: "qwen2.5", parameter_size: "3B" },
                    },
                    // A cloud-origin model, distinguishable by two independent signals (the
                    // "-cloud" name suffix and a zero/absent size) so origin detection does
                    // not depend on either heuristic alone. See model-origin.ts. Named to
                    // match RECOMMENDED_CLOUD_MODEL exactly so the onboarding headline
                    // recommendation block (which only shows once that exact model is
                    // present) actually renders in e2e coverage.
                    {
                      name: RECOMMENDED_CLOUD_MODEL,
                      model: RECOMMENDED_CLOUD_MODEL,
                      size: 0,
                    },
                  ],
          });
        }
        return;
      }

      if (url.pathname === "/api/show" && request.method === "POST") {
        if (scenario.show === "origin-reject") {
          sendSafeError(request, response, 403);
        } else if (scenario.show === "missing-model") {
          sendSafeError(request, response, 404);
        } else if (scenario.show === "http-failure") {
          sendSafeError(request, response, 500);
        } else {
          sendJson(request, response, 200, {
            details: { family: "qwen2.5", parameter_size: "3B" },
          });
        }
        return;
      }

      if (url.pathname === "/api/pull" && request.method === "POST") {
        if (scenario.pull === "origin-reject") {
          sendSafeError(request, response, 403);
        } else if (scenario.pull === "http-failure") {
          sendSafeError(request, response, 500);
        } else {
          response.writeHead(200, {
            ...corsHeaders(request),
            "content-type": "application/x-ndjson; charset=utf-8",
          });
          response.write(
            [
              { status: "pulling manifest" },
              { status: "downloading", completed: 25, total: 100 },
            ]
              .map(jsonLine)
              .join(""),
          );
          holdResponse(url.pathname, response, () => {
            response.end(
              [
                { status: "downloading", completed: 100, total: 100 },
                { status: "success" },
              ]
                .map(jsonLine)
                .join(""),
            );
          });
        }
        return;
      }

      if (url.pathname === "/api/chat" && request.method === "POST") {
        if (scenario.chat === "origin-reject") {
          sendSafeError(request, response, 403);
          return;
        }
        if (scenario.chat === "missing-model") {
          sendSafeError(request, response, 404);
          return;
        }
        if (scenario.chat === "http-failure") {
          sendSafeError(request, response, 500);
          return;
        }

        if (scenario.chat === "slow-first-token") {
          holdResponse(url.pathname, response, () => {
            response.writeHead(200, {
              ...corsHeaders(request),
              "content-type": "application/x-ndjson; charset=utf-8",
            });
            response.end(
              `${jsonLine({
                message: {
                  role: "assistant",
                  content: "Delayed answer.",
                  thinking: "",
                },
                done: false,
              })}${jsonLine({
                message: { role: "assistant", content: "", thinking: "" },
                done: true,
                total_duration: 1_000_000_000,
                prompt_eval_count: 12,
                eval_count: 10,
              })}`,
            );
          });
          return;
        }
        response.writeHead(200, {
          ...corsHeaders(request),
          "content-type": "application/x-ndjson; charset=utf-8",
        });
        if (scenario.chat === "idle-stream") {
          response.write(
            jsonLine({
              message: { role: "assistant", content: "Partial output", thinking: "" },
              done: false,
            }),
          );
          holdResponse(url.pathname, response, () => {
            response.end(
              `${jsonLine({
                message: {
                  role: "assistant",
                  content: "Delayed answer.",
                  thinking: "",
                },
                done: false,
              })}${jsonLine({
                message: { role: "assistant", content: "", thinking: "" },
                done: true,
                total_duration: 1_000_000_000,
                prompt_eval_count: 12,
                eval_count: 10,
              })}`,
            );
          });
          return;
        }
        if (scenario.chat === "hostile-markup") {
          response.end(
            [
              {
                message: {
                  role: "assistant",
                  content: "Read [Model link](https://attacker.example). ",
                  thinking: "",
                },
                done: false,
              },
              {
                message: {
                  role: "assistant",
                  content:
                    "<img src=x onerror=alert(1)> <script>alert('MODEL_SCRIPT')</script>",
                  thinking: "",
                },
                done: false,
              },
              {
                message: { role: "assistant", content: "", thinking: "" },
                done: true,
                total_duration: 1_000_000_000,
                prompt_eval_count: 12,
                eval_count: 10,
              },
            ]
              .map(jsonLine)
              .join(""),
          );
          return;
        }
        if (scenario.chat === "malformed-partial") {
          response.end(
            `${jsonLine({
              message: { role: "assistant", content: "Partial output", thinking: "" },
              done: false,
            })}{"message":`,
          );
          return;
        }

        response.write(
          jsonLine({
            message: { role: "assistant", content: "Local ", thinking: "" },
            done: false,
          }),
        );
        holdResponse(url.pathname, response, () => {
          response.end(
            [
              {
                message: { role: "assistant", content: "answer.", thinking: "" },
                done: false,
              },
              {
                message: { role: "assistant", content: "", thinking: "" },
                done: true,
                total_duration: 1_000_000_000,
                prompt_eval_count: 12,
                eval_count: scenario.chat === "slow-generation" ? 4 : 10,
              },
            ]
              .map(jsonLine)
              .join(""),
          );
        });
        return;
      }

      sendSafeError(request, response, 404);
    } catch {
      if (!response.headersSent) sendSafeError(request, response, 400);
      else response.destroy();
    }
  });

  server.on("connection", (socket) => {
    if (unreachable) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(0, hostname, () => {
      server.off("error", onError);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("The fake Ollama server did not expose an IPv4 address.");
  }
  const port = address.port;

  return {
    hostname,
    port,
    baseUrl: `http://${hostname}:${port}`,
    requests,
    cancellations,
    setScenario(next) {
      scenario = { ...scenario, ...next };
    },
    setUnreachable(enabled) {
      unreachable = enabled;
      if (enabled) {
        for (const socket of sockets) socket.destroy();
      }
    },
    reset() {
      scenario = { ...DEFAULT_SCENARIO };
      unreachable = false;
      requests.splice(0);
      cancellations.splice(0);
    },
    releasePull() {
      releaseResponses("/api/pull");
    },
    releaseChat() {
      releaseResponses("/api/chat");
    },
    waitForRequest(predicate) {
      if (closed) return Promise.reject(new Error("The fake Ollama server is closed."));
      const existing = requests.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) =>
        requestWaiters.add({ predicate, resolve, reject }),
      );
    },
    waitForCancellation(path) {
      if (closed) return Promise.reject(new Error("The fake Ollama server is closed."));
      const existing = cancellations.find((item) => item.path === path);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) =>
        cancellationWaiters.add({ path, resolve, reject }),
      );
    },
    async close() {
      if (closed) return;
      closed = true;
      const error = new Error("The fake Ollama server is closed.");
      for (const waiter of requestWaiters) waiter.reject(error);
      requestWaiters.clear();
      for (const waiter of cancellationWaiters) waiter.reject(error);
      cancellationWaiters.clear();
      for (const held of heldResponses) held.response.destroy();
      heldResponses.clear();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
