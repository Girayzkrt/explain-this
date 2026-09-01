// @vitest-environment node

import { afterEach, describe, expect, it } from "vitest";
import { startFixturePageServer, type FixturePageServer } from "./fixture-page-server";

const openServers = new Set<FixturePageServer>();

afterEach(async () => {
  await Promise.all([...openServers].map((server) => server.close()));
  openServers.clear();
});

describe("fixture page server", () => {
  it("serves the three exact fixture files from an ephemeral loopback origin", async () => {
    const server = await startFixturePageServer();
    openServers.add(server);

    expect(server.hostname).toBe("127.0.0.1");
    expect(server.port).toBeGreaterThan(0);
    for (const page of ["normal.html", "hostile.html", "multilingual.html"] as const) {
      const response = await fetch(server.url(page));
      expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
      await expect(response.text()).resolves.toContain(`data-fixture="${page.slice(0, -5)}"`);
    }
  });

  it("keeps privacy, geometry, and multilingual cases self-contained", async () => {
    const server = await startFixturePageServer();
    openServers.add(server);

    const pages = await Promise.all(
      (["normal.html", "hostile.html", "multilingual.html"] as const).map(
        async (page) => [page, await (await fetch(server.url(page))).text()] as const,
      ),
    );
    const content = Object.fromEntries(pages);

    expect(content["normal.html"]).toMatch(
      /FORM_VALUE_SECRET|SCRIPT_SECRET|STYLE_SECRET|DISTANT_PROMPT_INJECTION/,
    );
    expect(content["hostile.html"]).toMatch(/font-family: fantasy|z-index: -999/);
    expect(content["multilingual.html"]).toMatch(/光合成|Fotosynthese/);
    expect(pages.every(([, html]) => !/\b(?:src|href)\s*=|https?:\/\//i.test(html))).toBe(
      true,
    );
  });

  it.each([
    "/..%2fpackage.json",
    "/%2e%2e%2fpackage.json",
    "/normal.html%2f..%2fhostile.html",
    "/unknown.html",
  ])("rejects traversal and non-allowlisted path %s", async (pathname) => {
    const server = await startFixturePageServer();
    openServers.add(server);

    const response = await fetch(`${server.origin}${pathname}`);

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not found");
  });

  it("tears down only its listener and close is idempotent", async () => {
    const first = await startFixturePageServer();
    const second = await startFixturePageServer();
    openServers.add(first);
    openServers.add(second);

    await first.close();
    await first.close();
    openServers.delete(first);

    await expect(fetch(first.url("normal.html"))).rejects.toThrow();
    await expect(fetch(second.url("normal.html"))).resolves.toMatchObject({
      status: 200,
    });
  });
});
