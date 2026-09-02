# Troubleshooting

Every message the extension can show maps to a code below. Codes are stable; the wording
may change.

Before anything else, confirm the basics:

```bash
ollama list
```

If that fails, Ollama is not running. Start it and try again. The extension never starts,
installs, or downloads anything on its own.

## Setup and connection

| Code                    | What you see                         | What to check                                                                                                                                               |
| ----------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OLLAMA_UNREACHABLE`    | Local model unavailable              | Ollama is not running, or is not on `127.0.0.1:11434`. Start Ollama, then reopen the reader.                                                                |
| `OLLAMA_ORIGIN_BLOCKED` | Ollama needs this extension allowed  | Ollama refused the extension's origin. Allow the **exact** origin the options page shows. Never use a wildcard, and never bind Ollama to a network address. |
| `INVALID_ENDPOINT`      | Local model address needs setup      | The extension only talks to its approved loopback address. If you see this, the build is misconfigured — reinstall the released package.                    |
| `CONNECTION_TIMEOUT`    | Local model took too long to connect | Ollama accepted the connection but never answered. Check that it is healthy and not stuck on another job.                                                   |

## Model

| Code                    | What you see                  | What to check                                                                                                                     |
| ----------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `NO_MODEL`              | Choose a local model          | No model is selected. Open Settings and pick one.                                                                                 |
| `MODEL_NOT_FOUND`       | Selected model is unavailable | The selected model is no longer installed. Reinstall it with `ollama pull gemma3:4b`, or choose another in Settings.              |
| `MODEL_DOWNLOAD_FAILED` | Model download stopped        | The download did not finish. Check disk space and connectivity, then retry. You can also pull it yourself and return to Settings. |

## Generation

| Code                  | What you see                       | What to check                                                                                                                                             |
| --------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FIRST_TOKEN_TIMEOUT` | Local model took too long to start | The model did not begin answering. Common on machines without a GPU, or on the first request after the model loads. Try again, or choose a smaller model. |
| `STREAM_IDLE_TIMEOUT` | Local explanation stopped          | The model stopped mid-answer. Any partial text stays visible and marked incomplete. Retry.                                                                |
| `MALFORMED_STREAM`    | Local response could not be read   | The model sent output the extension could not parse. Retry; if it repeats, try a different model.                                                         |
| `PROVIDER_ERROR`      | Local model could not finish       | Ollama reported a failure. Check the Ollama logs.                                                                                                         |
| `REQUEST_CANCELLED`   | Explanation stopped                | You pressed Stop, or a request in another tab replaced this one. Only one explanation runs at a time.                                                     |

## Selection and page

| Code                     | What you see                        | What to check                                                                                                                                       |
| ------------------------ | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EMPTY_SELECTION`        | Select text to explain              | Nothing was selected when you invoked the reader.                                                                                                   |
| `SELECTION_TOO_LARGE`    | Select less text                    | The passage exceeds the request budget. Select a smaller passage. Dense scripts such as Chinese and Japanese reach the limit with fewer characters. |
| `CONTEXT_TOO_LARGE`      | Nearby context is too large         | The surrounding block is too big. Select a smaller passage, or turn nearby context off.                                                             |
| `UNSUPPORTED_PAGE`       | This page cannot be explained here  | Chrome blocks extensions on some pages, including `chrome://` pages and the Chrome Web Store. This is a browser rule, not a setting.                |
| `PAGE_PERMISSION_DENIED` | Page access was not allowed         | You declined optional page access. The keyboard shortcut and context menu still work; only the automatic selection toolbar needs it.                |
| `INVALID_REQUEST`        | That request is no longer available | The request expired, usually because the page navigated. Select the passage again.                                                                  |

## Things that are not errors

**The explanation is wrong or odd.** Output comes from a small local model and is not
verified. Check anything that matters.

**Translation output is poor.** The `translate` action is labelled experimental for a
reason: every 3B-class model evaluated produced flawed translations, including invented
words and, in some cases, characters from the wrong script. Do not rely on it.

**The first request is slow.** The model is being loaded into memory. Later requests in the
same session are much faster.

**An explanation of a hostile page looks manipulated.** A page can contain text that steers
the model. The output cannot execute or reach the network, but its _wording_ can be
influenced. See [privacy.md](privacy.md).

## Collecting diagnostics

Settings has a **Copy diagnostics** button. The report contains only local setup facts —
extension version, platform, endpoint host, model name, error code, timings — and is built
from an allowlist, so it cannot contain page text or model output. It is safe to paste into
an issue.
