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

const readerSession = (origin = "https://example.test"): ReaderSession => ({
  tabId: 7,
  requestId: "request-7",
  selectionPreview: "Short public preview",
  action: "simplify",
  contextIncluded: true,
  status: "pending",
  answer: "",
  lastSequence: -1,
  origin,
});

const privateSource = (origin = "https://example.test"): PrivateSourceEnvelope => ({
  requestId: "request-7",
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

  it("discards the private source when the tab origin changes", async () => {
    const storage = new MemoryStorageArea();
    const repository = createSessionRepository(storage);
    await repository.putReaderSession(readerSession());
    await repository.putPrivateSource(7, privateSource());
    await repository.putReaderSession(readerSession("https://other.test"));

    await expect(repository.getPrivateSource(7)).resolves.toBeUndefined();
    await expect(repository.getReaderSession(7)).resolves.toEqual(
      readerSession("https://other.test"),
    );
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
