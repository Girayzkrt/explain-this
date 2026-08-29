import { describe, expect, it } from "vitest";
import { isSiteBlocked } from "./site-blocklist";

describe("isSiteBlocked", () => {
  it("blocks an exact hostname", () => {
    expect(isSiteBlocked("https://blocked.example/guide", ["blocked.example"])).toBe(
      true,
    );
  });

  it("blocks subdomains of a blocked hostname", () => {
    expect(
      isSiteBlocked("https://docs.blocked.example/guide", ["blocked.example"]),
    ).toBe(true);
  });

  it("normalizes hostname case and internationalized hostnames", () => {
    expect(
      isSiteBlocked("https://BÜCHER.example/guide", ["xn--bcher-kva.example"]),
    ).toBe(true);
    expect(isSiteBlocked("https://blocked.example/guide", ["BLOCKED.EXAMPLE"])).toBe(
      true,
    );
  });

  it("does not confuse a blocked hostname with a deceptive suffix", () => {
    expect(
      isSiteBlocked("https://blocked.example.evil/guide", ["blocked.example"]),
    ).toBe(false);
  });

  it("blocks invalid page URLs by default", () => {
    expect(isSiteBlocked("not a url", ["blocked.example"])).toBe(true);
  });
});
