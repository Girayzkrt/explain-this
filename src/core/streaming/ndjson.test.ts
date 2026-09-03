import { describe, expect, it } from "vitest";
import { PublicError } from "../requests/public-error";
import { parseNdjson } from "./ndjson";

function streamFromChunks(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function utf8Chunks(text: string, split: number[] = []): Uint8Array[] {
  const bytes = new TextEncoder().encode(text);
  const boundaries = [0, ...split, bytes.byteLength];
  return boundaries
    .slice(0, -1)
    .map((start, index) => bytes.slice(start, boundaries[index + 1]));
}

async function collect<T>(iterator: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterator) values.push(value);
  return values;
}

describe("parseNdjson", () => {
  it("parses one object once when every UTF-8 byte boundary splits the line", async () => {
    const text = JSON.stringify({ text: "café — 東京" });
    const expected = [{ text: "café — 東京" }];

    for (
      let boundary = 1;
      boundary < new TextEncoder().encode(text).byteLength;
      boundary += 1
    ) {
      await expect(
        collect(
          parseNdjson(
            streamFromChunks(utf8Chunks(text, [boundary])),
            (input) => input as (typeof expected)[number],
            new AbortController().signal,
          ),
        ),
      ).resolves.toEqual(expected);
    }
  });

  it("parses several newline-delimited objects from one chunk in order", async () => {
    const stream = streamFromChunks(utf8Chunks('{"n":1}\n{"n":2}\n{"n":3}\n'));

    await expect(
      collect(
        parseNdjson(
          stream,
          (input) => input as { n: number },
          new AbortController().signal,
        ),
      ),
    ).resolves.toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
  });

  it("accepts CRLF separators and blank lines", async () => {
    const stream = streamFromChunks(utf8Chunks('\r\n{"n":1}\r\n\n{"n":2}\n'));

    await expect(
      collect(
        parseNdjson(
          stream,
          (input) => input as { n: number },
          new AbortController().signal,
        ),
      ),
    ).resolves.toEqual([{ n: 1 }, { n: 2 }]);
  });

  it("parses a valid non-empty final line without a newline", async () => {
    const stream = streamFromChunks(utf8Chunks('{"done":true}'));

    await expect(
      collect(
        parseNdjson(
          stream,
          (input) => input as { done: boolean },
          new AbortController().signal,
        ),
      ),
    ).resolves.toEqual([{ done: true }]);
  });

  it("reports malformed JSON as a recoverable MALFORMED_STREAM error", async () => {
    const stream = streamFromChunks(utf8Chunks('{"ok":true}\nnot-json\n'));

    await expect(
      collect(parseNdjson(stream, (input) => input, new AbortController().signal)),
    ).rejects.toMatchObject({
      code: "MALFORMED_STREAM",
      recoverable: true,
    } satisfies Partial<PublicError>);
  });

  it("preserves AbortError and cancels a pending reader when aborted", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const abortController = new AbortController();
    const iterator = parseNdjson(stream, (input) => input, abortController.signal);
    const pending = iterator.next();
    abortController.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(cancelled).toBe(true);
    expect(stream.locked).toBe(false);
  });

  it("stops before yielding the next buffered record after abort", async () => {
    const stream = streamFromChunks(utf8Chunks('{"n":1}\n{"n":2}\n'));
    const abortController = new AbortController();
    const iterator = parseNdjson(
      stream,
      (input) => input as { n: number },
      abortController.signal,
    );

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { n: 1 },
    });
    abortController.abort();

    await expect(iterator.next()).rejects.toMatchObject({ name: "AbortError" });
  });

  it("cancels the reader when iteration starts with an already-aborted signal", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const abortController = new AbortController();
    abortController.abort();
    const iterator = parseNdjson(stream, (input) => input, abortController.signal);

    await expect(iterator.next()).rejects.toMatchObject({ name: "AbortError" });
    expect(cancelled).toBe(true);
    expect(stream.locked).toBe(false);
  });
});
