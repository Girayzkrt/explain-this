import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { Socket } from "node:net";

export type FixturePageName = "normal.html" | "hostile.html" | "multilingual.html";

export interface FixturePageServer {
  readonly hostname: "127.0.0.1";
  readonly port: number;
  readonly origin: string;
  readonly requests: readonly string[];
  url(page: FixturePageName): string;
  close(): Promise<void>;
}

const fixtureUrls: Record<FixturePageName, URL> = {
  "normal.html": new URL("../fixtures/pages/normal.html", import.meta.url),
  "hostile.html": new URL("../fixtures/pages/hostile.html", import.meta.url),
  "multilingual.html": new URL("../fixtures/pages/multilingual.html", import.meta.url),
};

function fixtureName(pathname: string): FixturePageName | undefined {
  if (!pathname.startsWith("/") || pathname.includes("%") || pathname.includes("\\")) {
    return undefined;
  }
  const candidate = pathname.slice(1);
  return Object.hasOwn(fixtureUrls, candidate)
    ? (candidate as FixturePageName)
    : undefined;
}

export async function startFixturePageServer(): Promise<FixturePageServer> {
  const hostname = "127.0.0.1" as const;
  const requests: string[] = [];
  const sockets = new Set<Socket>();
  let closed = false;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${hostname}`);
    requests.push(url.pathname);
    const name = request.method === "GET" ? fixtureName(url.pathname) : undefined;
    if (!name) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }

    try {
      const body = await readFile(fixtureUrls[name], "utf8");
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-security-policy":
          "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'",
        "content-type": "text/html; charset=utf-8",
      });
      response.end(body);
    } catch {
      response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      response.end("Fixture unavailable");
    }
  });
  server.on("connection", (socket) => {
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
    throw new Error("The fixture server did not expose an IPv4 address.");
  }
  const port = address.port;
  const origin = `http://${hostname}:${port}`;

  return {
    hostname,
    port,
    origin,
    requests,
    url(page) {
      return `${origin}/${page}`;
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
