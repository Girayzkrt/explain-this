import { describe, expect, it } from "vitest";
import type {
  PrivateSourceEnvelope,
  ReaderSession,
} from "../../features/reader/session";
import {
  AccessControlledMemoryStorageArea,
  MemoryStorageArea,
} from "../../../tests/support/memory-storage";
import { initializeStorageAccess } from "./storage-area";
import { createSessionRepository } from "./session-repository";

const readerSession = (
  origin = "https://example.test",
  requestId = "request-7",
): ReaderSession => ({
  tabId: 7,
  requestId,
  selectionPreview: "Short public preview",
  action: "simplify",
  contextIncluded: true,
  status: "pending",
  answer: "",
  lastSequence: -1,
  origin,
});

const privateSource = (
  origin = "https://example.test",
  requestId = "request-7",
): PrivateSourceEnvelope => ({
  requestId,
  selection: "The full private selected text must never appear in the UI session.",
  nearbyContext: "The full private nearby context.",
  previousAnswer: "A bounded prior answer.",
  origin,
});

describe("session repository", () => {
  it("stores one public reader session and a separately keyed private source per numeric tab", async () => {
    const storage = new MemoryStorageArea();
    const repository = createSessionRepository(storage);
    await repository.putReaderSession(readerSession());
    await repository.putPrivateSource(7, privateSource());

    await expect(repository.getReaderSession(7)).resolves.toEqual(readerSession());
    await expect(repository.getPrivateSource(7)).resolves.toEqual(privateSource());
    await expect(storage.snapshot()).resolves.toEqual({
      "reader-session:7": readerSession(),
      "reader-source:7": privateSource(),
    });
  });

  it("keeps reader sessions isolated by numeric tab ID", async () => {
    const repository = createSessionRepository(new MemoryStorageArea());
    await repository.putReaderSession(readerSession());
    await repository.putReaderSession({
      ...readerSession(),
      tabId: 8,
      requestId: "request-8",
    });

    await expect(repository.getReaderSession(7)).resolves.toEqual(readerSession());
    await expect(repository.getReaderSession(8)).resolves.toMatchObject({
      tabId: 8,
      requestId: "request-8",
    });
    await expect(repository.getReaderSession(-1)).rejects.toThrow(TypeError);
    await expect(repository.getReaderSession(7.5)).rejects.toThrow(TypeError);
  });

  it("never exposes the private source through the UI session getter", async () => {
    const repository = createSessionRepository(new MemoryStorageArea());
    await repository.putReaderSession(readerSession());
    await repository.putPrivateSource(7, privateSource());

    const publicSession = await repository.getReaderSession(7);

    expect(publicSession).toEqual(readerSession());
    expect(JSON.stringify(publicSession)).not.toContain("full private selected text");
  });

  it("caps the public selection preview to 240 display characters before storage", async () => {
    const storage = new MemoryStorageArea();
    const repository = createSessionRepository(storage);
    await repository.putReaderSession({
      ...readerSession(),
      selectionPreview: "🙂".repeat(241),
    });

    await expect(repository.getReaderSession(7)).resolves.toMatchObject({
      selectionPreview: "🙂".repeat(240),
    });
    const stored = (await storage.snapshot())["reader-session:7"] as ReaderSession;
    expect(Array.from(stored.selectionPreview)).toHaveLength(240);
  });

  it("persists the optional provider field instead of stripping it as unknown", async () => {
    const storage = new MemoryStorageArea();
    const repository = createSessionRepository(storage);
    const withProvider: ReaderSession = {
      ...readerSession(),
      provider: "ollama-cloud",
    };

    await repository.putReaderSession(withProvider);

    await expect(repository.getReaderSession(7)).resolves.toEqual(withProvider);
    await expect(storage.snapshot()).resolves.toEqual({
      "reader-session:7": withProvider,
    });
  });

  it("leaves the provider field absent when the session never carried one", async () => {
    const repository = createSessionRepository(new MemoryStorageArea());

    await repository.putReaderSession(readerSession());

    const stored = await repository.getReaderSession(7);
    expect(stored?.provider).toBeUndefined();
    expect(stored).not.toHaveProperty("provider");
  });

  it("stores only serializable allowlisted fields in the public session", async () => {
    const storage = new MemoryStorageArea();
    const repository = createSessionRepository(storage);
    const unsafeSession = {
      ...readerSession(),
      callback: () => undefined,
      controller: new AbortController(),
      node: document.createElement("div"),
      browserObject: { runtime: { id: "extension-id" } },
      selection: "full private selection",
    } as unknown as ReaderSession;

    await repository.putReaderSession(unsafeSession);

    await expect(storage.snapshot()).resolves.toEqual({
      "reader-session:7": readerSession(),
    });
    expect(JSON.stringify(await repository.getReaderSession(7))).not.toContain(
      "full private selection",
    );
  });

  it.each([
    {
      transition: "origin",
      firstWrite: "source",
      nextOrigin: "https://other.test",
      nextRequestId: "request-8",
    },
    {
      transition: "origin",
      firstWrite: "session",
      nextOrigin: "https://other.test",
      nextRequestId: "request-8",
    },
    {
      transition: "request",
      firstWrite: "source",
      nextOrigin: "https://example.test",
      nextRequestId: "request-8",
    },
    {
      transition: "request",
      firstWrite: "session",
      nextOrigin: "https://example.test",
      nextRequestId: "request-8",
    },
  ] as const)(
    "keeps $transition transitions coherent when the $firstWrite is written first",
    async ({ firstWrite, nextOrigin, nextRequestId }) => {
      const storage = new MemoryStorageArea();
      const repository = createSessionRepository(storage);
      await repository.putReaderSession(readerSession());
      await repository.putPrivateSource(7, privateSource());

      const nextSession = readerSession(nextOrigin, nextRequestId);
      const nextSource = privateSource(nextOrigin, nextRequestId);
      if (firstWrite === "source") {
        await repository.putPrivateSource(7, nextSource);
        await expect(storage.snapshot()).resolves.toEqual({
          "reader-source:7": nextSource,
        });
        await repository.putReaderSession(nextSession);
      } else {
        await repository.putReaderSession(nextSession);
        await expect(storage.snapshot()).resolves.toEqual({
          "reader-session:7": nextSession,
        });
        await repository.putPrivateSource(7, nextSource);
      }

      await expect(storage.snapshot()).resolves.toEqual({
        "reader-session:7": nextSession,
        "reader-source:7": nextSource,
      });
    },
  );

  it.each([
    ["selection", "漢".repeat(1_601), "SELECTION_TOO_LARGE"],
    ["nearbyContext", "漢".repeat(401), "CONTEXT_TOO_LARGE"],
    ["previousAnswer", "漢".repeat(601), "CONTEXT_TOO_LARGE"],
  ] as const)(
    "rejects a dense-script private %s over its approved token budget",
    async (field, value, code) => {
      const repository = createSessionRepository(new MemoryStorageArea());

      await expect(
        repository.putPrivateSource(7, {
          ...privateSource(),
          [field]: value,
        }),
      ).rejects.toMatchObject({ code });
    },
  );

  it("preserves a private source unchanged at every approved dense-script boundary", async () => {
    const repository = createSessionRepository(new MemoryStorageArea());
    const source: PrivateSourceEnvelope = {
      ...privateSource(),
      selection: "漢".repeat(1_600),
      nearbyContext: "漢".repeat(400),
      previousAnswer: "漢".repeat(600),
    };

    await repository.putPrivateSource(7, source);

    await expect(repository.getPrivateSource(7)).resolves.toEqual(source);
  });

  it("removes the public session and private source together", async () => {
    const storage = new MemoryStorageArea();
    const repository = createSessionRepository(storage);
    await repository.putReaderSession(readerSession());
    await repository.putPrivateSource(7, privateSource());

    await repository.removeTabState(7);

    await expect(storage.snapshot()).resolves.toEqual({});
  });

  it("restricts local and session storage to trusted extension contexts", async () => {
    const local = new AccessControlledMemoryStorageArea();
    const session = new AccessControlledMemoryStorageArea();

    await initializeStorageAccess({ local, session });

    expect(local.accessLevels).toEqual(["TRUSTED_CONTEXTS"]);
    expect(session.accessLevels).toEqual(["TRUSTED_CONTEXTS"]);
  });
});
