# Privacy

Where your reading goes depends on the mode you choose during setup, and nothing changes
mode without you choosing it there or in Settings. This document states exactly what is
handled, where it goes, how long it lives, and what you control.

## The short version

| Mode             | Where your selected text goes                                  |
| ---------------- | -------------------------------------------------------------- |
| On this computer | Nowhere. The model runs locally through Ollama.                |
| Ollama Cloud     | To Ollama's servers. Ollama states that it does not retain it. |

The default is **On this computer**, and in that mode the text you read never leaves your
computer.

- Only the text **you select** is sent to the model. Nearby context is opt-in and off
  by default.
- Page text and model output are **never written to persistent storage**.
- There is no telemetry, no analytics, no remote logging, and no account.

## Data inventory

| Data item          | Source                                                             | Destination                                                                                | Stored where, for how long                                                                               | Your control                                             |
| ------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Selected text      | Your selection                                                     | Local Ollama on loopback, which forwards it to Ollama's cloud servers in Ollama Cloud mode | `storage.session` while the request is live; deleted when the tab navigates, closes, or the browser ends | Select nothing and nothing is sent                       |
| Nearby context     | Nearest visible reading blocks around the selection                | Same as selected text                                                                      | Same as above                                                                                            | **Off by default**; opt in per preference                |
| Model output       | Local Ollama, relaying Ollama's cloud servers in Ollama Cloud mode | Reader card and side panel                                                                 | `storage.session` for the current request only                                                           | Close the card                                           |
| Preferences        | You, during onboarding                                             | Never leaves the device                                                                    | `storage.local` until you change or remove them                                                          | Editable in Settings                                     |
| Blocked hostnames  | You                                                                | Never leaves the device                                                                    | `storage.local` as hostnames only                                                                        | Editable in Settings                                     |
| Diagnostics report | Local setup facts                                                  | Your clipboard, only when you click Copy                                                   | Not stored                                                                                               | Built from an allowlist; contains no page text or output |

`storage.session` is cleared by the browser when the browser closes. The extension also
deletes a tab's entries when that tab navigates away or is closed.

## What is deliberately never sent

The extension extracts a bounded snapshot, not the page. The following are excluded, and
automated tests assert their absence from real recorded requests:

- hidden text (`hidden`, `aria-hidden`, `display: none`, `opacity: 0`);
- form values and input contents;
- `<script>` and `<style>` contents;
- navigation and menu regions;
- text outside the nearest visible reading blocks, including distant prompt-injection bait.

Requests are also size-bounded before they are sent: roughly 1,600 tokens of selection,
400 of nearby context, and 600 of a previous answer. Over-budget requests are refused
locally and never reach the model.

## Permissions, one at a time

| Permission                                             | Why it exists                                                                             |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `activeTab`                                            | Read the selection in the tab you are on, when you invoke the extension                   |
| `contextMenus`                                         | Add the right-click "Explain This" menu                                                   |
| `scripting`                                            | Inject the reader surface into the current page on demand                                 |
| `sidePanel`                                            | Open the side panel for a longer answer                                                   |
| `storage`                                              | Save your preferences locally                                                             |
| `http://127.0.0.1:11434/*`, `http://localhost:11434/*` | Talk to your local Ollama. **Required**, and the only required host access                |
| `http://*/*`, `https://*/*`                            | **Optional and off unless you grant it.** Only needed for the automatic selection toolbar |

The extension never requests `tabs`, `webRequest`, `cookies`, `history`, or any other
broad capability. `npm run verify:manifest` fails the build if that changes.

## Ollama origin configuration

Ollama may reject requests from an extension origin. If it does, the extension shows the
exact origin to allow. Set it to that **exact** origin, never a wildcard and never a
network-wide bind. Binding Ollama to a non-loopback address exposes your model to your
network and is outside this extension's threat model.

## Prompt injection: the honest boundary

A web page can contain text designed to hijack the model, for example "ignore previous
instructions". **This extension does not prevent that, and neither did any small local
model we evaluated.** Testing four models against four injection cases found none that
resisted them all, and adding a trust-boundary reminder after the untrusted text did not
help.

What is actually enforced, and tested:

- Model output is rendered as **sanitised Markdown**. It cannot execute scripts, create
  links, or inject DOM nodes.
- The extension itself has **no network egress beyond loopback**: it only ever talks to
  the local Ollama address. In the default **On this computer** mode that means nothing
  leaves the machine. In **Ollama Cloud** mode, that same local Ollama forwards your
  selection on to Ollama's servers as normal for that mode — a successful injection
  cannot route it anywhere beyond where the mode already sends it.
- Page text is **never persisted**.
- The reader surface lives in its own **Shadow DOM**, so hostile page CSS cannot restyle or
  reposition it.

The residual risk is therefore **content spoofing**: a hostile page can change the wording
that appears inside the reader card. Treat explanations of untrusted pages with the same
scepticism you would apply to the page itself.
