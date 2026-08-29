import { PublicError } from "../requests/public-error";

function isAbortError(error: unknown): error is DOMException {
  return error instanceof DOMException && error.name === "AbortError";
}

/** Parse a UTF-8 NDJSON response while tolerating arbitrary network chunking. */
export async function* parseNdjson<T>(
  stream: ReadableStream<Uint8Array>,
  validate: (input: unknown) => T,
  signal: AbortSignal,
): AsyncGenerator<T> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let carry = "";

  const cancelReader = (): void => {
    // Cancellation resolves a pending read. The abort check immediately after
    // that read preserves the signal's AbortError for the consumer.
    void reader.cancel().catch(() => undefined);
  };

  signal.addEventListener("abort", cancelReader);

  try {
    if (signal.aborted) {
      await reader.cancel().catch(() => undefined);
      signal.throwIfAborted();
    }

    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();

      carry += decoder.decode(value, { stream: !done });
      const lines = carry.split("\n");
      let finalLine: string | undefined;
      if (done) {
        finalLine = lines.pop();
        carry = "";
      } else {
        carry = lines.pop() ?? "";
      }

      for (const line of lines) {
        signal.throwIfAborted();
        const normalized = line.endsWith("\r") ? line.slice(0, -1) : line;
        if (normalized.trim()) yield validate(JSON.parse(normalized));
      }

      if (done) {
        signal.throwIfAborted();
        const normalized = finalLine?.endsWith("\r")
          ? finalLine.slice(0, -1)
          : finalLine;
        if (normalized?.trim()) yield validate(JSON.parse(normalized));
        break;
      }
    }
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (isAbortError(error)) throw error;
    throw new PublicError("MALFORMED_STREAM", "The model response was invalid.", true);
  } finally {
    signal.removeEventListener("abort", cancelReader);
    reader.releaseLock();
  }
}
