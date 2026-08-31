# SDD ledger — plan: C:/Users/krtgi/projects/explain-this/docs/planning/2026-08-29-explain-this-implementation-plan.md

Spec: C:/Users/krtgi/projects/explain-this/docs/planning/2026-08-29-explain-this-system-design.md
Branch start: 2832f53
Implementation branch: codex/explain-this-mvp
Baseline: repository contains no package manifest or test command yet; Task 1 creates both.

## Preflight consistency scan

| Tasks | Produced → consumed or shared surface | Finding |
|---|---|---|
| 1 → 2 | settings schema and defaults → request preferences | Clean; Task 2 imports Task 1 contracts. |
| 1 → 11 | settings defaults → onboarding controls | Clean; UI persists only the Task 1 schema. |
| 1 → 13 | WXT manifest/build configuration → runtime reader entrypoint | Clean, subject to generated-manifest verification in Task 13. |
| 1 → 16 | WXT configuration → test-mode fixture configuration | Clean; test-only host must be absent from production build. |
| 1 → 17 | `.gitignore` → evaluation artifact ignore | Clean; Task 17 appends a narrowly scoped artifact path. |
| 1 → 18 | package scripts/build → CI and packaging scripts | Clean; Task 18 extends rather than replaces scripts. |
| 2 → 3 | `ReadingRequest`, actions, preferences → prompt builder | Clean; arbitrary prompt and provider options remain impossible. |
| 2 → 5 | public error union → loopback URL guard | Conflict; Task 5 emits `INVALID_ENDPOINT`, which Task 2 omitted. See Ruling 4. |
| 2 → 6 | `PublicErrorShape` and bounded request text → session snapshots | Clean; private source and display snapshot remain separate. |
| 2 → 8 | validators and budgets → request coordinator | Clean; sender metadata is derived separately. |
| 2 → 15 | public error union → exhaustive recovery copy | Clean; TypeScript exhaustiveness is the enforcement mechanism. |
| 3 → 5 | provider-neutral contracts → Ollama adapter | Clean; adapter-specific fields do not leak upstream. |
| 3 → 8 | prompt builder/provider → coordinator | Clean; background owns prompting and provider access. |
| 3 → 10 | downloadable provider contracts → onboarding service | Clean; options page cannot send prompts or endpoints. |
| 3 → 17 | prompt builder → real-model evaluator | Clean; evaluator reuses production budgets and prompts. |
| 4 → 5 | NDJSON parser → Ollama streaming | Clean; parser validates caller-supplied schemas. |
| 4 → 8 | stream sequencing → coordinator/UI delivery | Clean; stale or duplicate deltas are rejected. |
| 5 → 9 | Ollama factory → production background dependencies | Clean; all model HTTP remains in the worker. |
| 5 → 10 | model health/list/download → onboarding | Clean; shared global concurrency gate is required. |
| 5 → 16 | Ollama HTTP contract → fake server | Clean; fake binds only to loopback and never ships. |
| 5 → 17 | Ollama provider → opt-in local smoke test | Clean; model pulling remains forbidden in the evaluator. |
| 6 → 8 | settings/session repositories → coordinator | Clean; retry/follow-up source is trusted-session-only. |
| 6 → 9 | repositories → startup and tab cleanup | Clean; storage access is restricted at worker startup. |
| 6 → 14 | safe session snapshot → side panel | Clean; side panel cannot access `reader-source:*`. |
| 7 → 9 | `ReaderAccessService` → background commands | Clean; explicit and automatic injection stay distinct. |
| 7 → 11 | optional-origin request → onboarding permission card | Clean; request must occur inside the button gesture. |
| 7 → 13 | runtime registration/injection → packaged content script | Clean, with generated-manifest assertions as the backstop. |
| 7 → 16 | test-mode host and browser API boundary → E2E | Clean; production manifest is separately asserted. |
| 8 → 9 | coordinator and port contracts → background routing | Clean; only named ports are accepted. |
| 8 → 13 | reader port contract → content UI controller | Clean; content code has no provider or storage access. |
| 8 → 14 | reader port contract → side-panel commands | Clean; follow-ups remain typed rather than free-form chat. |
| 9 → 10 | background entrypoint → onboarding port routing | Clean; extension-page sender URL is validated. |
| 9 → 14 | background events → side-panel opening and cleanup | Conflict; plan asks for navigation listeners without declaring a navigation permission. See Ruling 2. |
| 10 → 11 | onboarding contracts/client → options UI | Clean; UI is a state machine over validated events. |
| 10 → 15 | provider/model facts → sanitized diagnostics | Clean; report is constructed from an allowlist. |
| 11 → 15 | options UI → error/diagnostics integration | Clean; shared recovery components are introduced later. |
| 12 → 13 | selection/context/position primitives → reader UI | Clean; extraction precedes prompting and obeys opt-in. |
| 13 → 14 | current reader request → side-panel handoff | Clean; side panel shows current work, not history. |
| 13 → 15 | response card → exhaustive recovery UI | Clean; partial output remains visible and marked incomplete. |
| 14 → 15 | side-panel UI → exhaustive recovery UI | Clean; the same safe Markdown and error presentation are reused. |
| 16 → 18 | Playwright E2E → hosted CI | Conflict; headed persistent Chromium requires a display on Linux CI. See Ruling 3. |
| 17 → 19 | aggregate evaluation results → public README | Clean; raw responses remain ignored and local. |
| 18 → 19 | verified package/permissions → publishing documentation | Clean; documentation does not claim automated store publication. |

| Task | Internal tests/files/implementation consistency | Finding |
|---|---|---|
| 1 | Foundation, config, defaults, and first test | Conflict; the prescribed constant-equality test is a change detector. See Ruling 1. |
| 2 | Strict schemas and conservative budgets | Clean. |
| 3 | Provider contracts and two-message prompt construction | Clean. |
| 4 | Chunk parser and monotonic sequence rules | Clean. |
| 5 | Loopback guard, strict response validation, streaming, and timeouts | Clean. |
| 6 | Local preferences, safe snapshots, private source envelopes | Clean. |
| 7 | Explicit injection, optional origins, runtime registration, blocklist | Clean. |
| 8 | Strict messages, sender trust boundary, one global request | Clean. |
| 9 | Background handlers and event wiring | Conflict covered by Ruling 2. |
| 10 | Background-only onboarding and origin guidance | Clean. |
| 11 | Accessible stateful onboarding and user-gesture permission request | Clean. |
| 12 | Selection exclusions, bounded context, pure placement | Clean. |
| 13 | Shadow UI, safe Markdown, cancellation, runtime content script | Clean. |
| 14 | Current-tab session and constrained follow-ups | Clean. |
| 15 | Exhaustive recovery copy and allowlisted diagnostics | Clean. |
| 16 | Fake Ollama and production-path browser flows | Conflict covered by Ruling 3. |
| 17 | Versioned corpus and opt-in real-model runner | Clean. |
| 18 | Manifest/package verification and hosted-safe workflows | Clean after Ruling 3; package verifier accepts directory and ZIP targets. |
| 19 | User/developer documentation and public assets | Clean. |

Ruling 1: Task 1 will preserve every exact approved default but test observable schema/default-factory behavior instead of asserting exported constants equal themselves — this follows the spec while ensuring tests catch a user-visible regression — cost if wrong: a future intentional default change requires updating behavior fixtures rather than one constant snapshot.

Ruling 2: Cross-origin cleanup will be driven by the reader content port lifecycle (`pagehide`/disconnect) plus `tabs.onRemoved`, not a broad `webNavigation` listener — this satisfies session deletion without adding browsing-metadata permission omitted by the privacy design — cost if wrong: an unusual renderer crash could leave temporary `storage.session` state until replacement, tab close, or browser end.

Ruling 3: Linux CI will invoke headed extension E2E through `xvfb-run`, while local Windows/macOS uses `npm run test:e2e` directly — persistent extension Chromium stays real without requiring a physical CI display — cost if wrong: CI setup gains an Ubuntu/Xvfb-specific command that may need maintenance when Playwright headless extension support changes.

Ruling 4: Task 2 will include `INVALID_ENDPOINT` in `PublicErrorCode` because Task 5's mandatory loopback guard emits it; Task 15 must provide exhaustive recovery copy for it — this keeps the provider safety branch typed instead of weakening it to a generic provider failure — cost if wrong: the public error vocabulary gains one configuration-only case that ordinary users should never encounter.

Ruling 5: Task 7 defines and tests the fixed packaged-reader path, but Task 13 remains responsible for creating and build-verifying `content-scripts/reader.js`; no dummy content script will be added early — this preserves the planned separation between permission orchestration and reader UI — cost if wrong: explicit/automatic injection remains nonfunctional until Task 13, so Task 13's generated-asset assertion is load-bearing and must not be waived.

Task 1: minor (deferred): add behavioral coverage for factory array isolation and invalid settings input; final review must triage this test-depth suggestion.
Task 1: verification (2026-08-29): `npm test` 1/1 passed; `npm run typecheck`, `npm run lint`, and `npm run build` exited 0; generated manifest is MV3, Chrome 116+, loopback-required/ordinary-site-optional, and has no popup.
Task 1: complete (commits 03a8c44..6758a3d, review clean)
Task 2: fix round 1/5 (1 addressed, 0 open — nearby context now requires explicit opt-in; commits ad5a949..f9259b2)
Task 2: verification (2026-08-29): focused request suite 14/14 passed and type-check exited 0; controller confirmed the full system-design error union plus `CONTEXT_TOO_LARGE`, `INVALID_REQUEST`, and Ruling 4's `INVALID_ENDPOINT`.
Task 2: complete (commits 6758a3d..f9259b2, review clean)
Task 3: verification (2026-08-29): focused prompt suite 20/20 passed and type-check exited 0.
Task 3: complete (commits f9259b2..d21f71e, review clean)
Task 4: deferred minor: repository-wide lint now exposes Task 2's empty `ValidatedReadingRequest` marker interface; replace it with an equivalent type alias no later than the CI increment.
Task 4: fix round 1/5 (2 addressed, 0 open — buffered and pre-aborted stream cancellation; commits bf3c1e7..9b2953f)
Task 4: verification (2026-08-29): focused streaming suite 12/12 passed and type-check exited 0.
Task 4: complete (commits d21f71e..9b2953f, review clean)
Task 5: minor (deferred): add a direct overall-timeout regression test; final review must triage.
Task 5: minor (deferred): tighten the pre-canonicalization endpoint regex to reject a final line terminator accepted by JavaScript `$`; host escape is not possible, but literal exactness can be stronger.
Task 5: fix round 1/5 (3 addressed, 0 open — exact IPv4 authority, neutral `/api/show`, failed-tags body cleanup; commits b57d6dd..13b2773)
Task 5: verification (2026-08-29): focused Ollama suite 45/45 passed and type-check exited 0.
Task 5: complete (commits 9b2953f..13b2773, review clean)
Task 6: interrupted before commit by usage limit; fresh implementer removed only unreported Task 6 production artifacts, re-established RED, and completed the task without reusing unverifiable output.
Task 6: minor (deferred): storage access restriction starts synchronously but its promise is intentionally not awaited; Task 9 must preserve synchronous MV3 listener registration while adding explicit failure handling/readiness if needed.
Task 6: fix round 1/5 (3 addressed, 0 open — record coherence, persistence budgets, reducer lifecycle; commits f82c2bb..21d7e1b)
Task 6: verification (2026-08-30): focused storage/session suite 32/32 passed and type-check exited 0.
Task 6: complete (commits 13b2773..21d7e1b, review clean)
Task 7: minor (deferred): normalize a terminal dot in blocklist hostnames so FQDN and ordinary hostname forms match.
Task 7: minor (deferred): per-tab injection generation entries can accumulate across many removed tabs; Task 9 lifecycle cleanup/final review should consider a terminal forget operation.
Task 7: fix round 1/5 (1 addressed, 1 open — page identity/invalidation added; in-flight invalidation race remained; commits 25ba531..ee4f167)
Task 7: fix round 2/5 (1 addressed, 0 open — generation guard prevents stale completion; commits ee4f167..c9fe132)
Task 7: verification (2026-08-30): focused permission suite 26/26 passed and type-check exited 0.
Task 7: complete (commits 21d7e1b..c9fe132, review clean under Ruling 5's Task 13 asset gate)
Task 8: fix round 1/5 (3 addressed, 0 open — trusted settings boundary, cross-tab replacement cleanup, stale-port ownership; commits c350fd8..89c9a35)
Task 8: verification (2026-08-30): focused messaging/coordinator suite 32/32 passed and type-check exited 0.
Task 8: complete (commits c9fe132..89c9a35, review clean)
Task 9: fix round 1/5 (1 addressed, 0 open — latest reader-port token owns injection invalidation; commits 1116d6f..91b927f)
Task 9: verification (2026-08-30): background suite 12/12 passed; type-check/build exited 0; generated MV3 manifest has background.js, loopback-only required hosts, broad optional origins, no popup, and no webNavigation.
Task 9: complete (commits 89c9a35..91b927f, review clean under Rulings 2 and 5)
Task 10: review round 1 (5 important open — health normalization/status preservation, download validation cancellation, readiness model allowlist, and per-port/generation stale-operation ownership; implementation commit e4ad65a)
Task 10: minor (deferred): bound nested download event strings and consider practical event-list limits at the external contract.
Task 10: minor (deferred): the shared gate relies on provider iterators honoring abort; final provider/E2E verification should exercise the real adapter cancellation path.
Task 10: fix round 1/5 (5 addressed, 0 open — runtime health normalization/status preservation, validation-time cancellation, readiness allowlist, per-port/generation ownership; commits e4ad65a..b4a4175)
Task 10: verification (2026-08-30): onboarding/coordinator suite 44/44 and full suite 224/224 passed; type-check/build exited 0; generated MV3 manifest retains loopback-only required hosts, broad optional origins, no popup, and no webNavigation.
Task 10: complete (commits 91b927f..b4a4175, re-review clean; residual low-impact completion-write replacement caveat deferred)
Task 11: review round 1 (6 open — direct user-gesture permission request, consent/registration persistence ordering, true onboarding completion/resume, blocked-host ownership, origin-guidance secondary action, and step-focus management; implementation commit b8d5be5)
Task 11: minor (deferred): retain the interrupted operation's rail step on failure rather than resetting progress to step 2.
Task 11: minor (expected to resolve with completion hydration): prevent late settings hydration from replacing an already-mounted preferences draft.
Task 11: fix round 1/5 (5 addressed, 1 open — synchronous request, consent ordering/rollback, completion resume, blocklist ownership, origin recovery, focus/rail/hydration; commits b8d5be5..012dc83; idempotent disable/denial cleanup remained)
Task 11: minor (deferred): background startup consent restoration and a simultaneous options permission transaction use separate controllers and have a low-frequency last-writer race; reassess in final E2E/privacy review before broadening the strict onboarding command surface.
Task 11: fix round 2/5 (1 addressed, 0 open — idempotent missing/racing-registration cleanup and false-consent stale-access removal; commits 012dc83..bd54c48)
Task 11: verification (2026-08-30): focused permission/options/background suite 62/62 and full suite 254/254 passed; type-check/build exited 0; generated MV3 manifest has options.html, no popup, no webNavigation, and no deferred Task 13 reader asset.
Task 11: complete (commits b4a4175..bd54c48, round-2 re-review clean; startup/options last-writer race deferred for final E2E/privacy audit)
Task 12: review round 1 (3 open — form-ancestry selection exclusion, oversized-adjacent nonfailure semantics, and budget-aware early cutoff; implementation commit b219819)
Task 12: minor (deferred): use range-aware removal when repeated selected text appears in the local block.
Task 12: minor (expected in fix): normalize role-token exclusions case-insensitively rather than exact lowercase attribute matching.
Task 12: E2E gate (Task 16): verify real Range rectangles, computed visibility, and viewport placement because jsdom geometry is synthetic.
Task 12: fix round 1/5 (3 addressed, 0 open — form ancestry, optional oversized-sibling semantics, budget-aware traversal and role parsing; commits b219819..18fe147)
Task 12: verification (2026-08-31): privacy suite 44/44 and full suite 298/298 passed; type-check/build exited 0.
Task 12: complete (commits bd54c48..18fe147, re-review clean; repeated-text removal and real-browser geometry remain deferred gates)
Task 13: review round 1 (3 confirmed important open — preflight Retry no-op, unparsed port messages, and async invocation ordering; implementation commit 0aa6ba3)
Task 13: review finding dismissed after source verification: WXT creates the shadow host with `document.createElement(options.name)`, so `querySelector("explain-this-reader")` is the correct host selector; the existing access controller also coalesces same-page explicit injection. A narrow async mount-race hardening remains optional, not an acceptance blocker.
Task 13: minor (deferred): cancel an already-scheduled empty animation-frame flush after terminal events and surface side-panel opening failures in the Task 15 recovery UI.
Task 13: fix round 1/5 (3 addressed, 0 open — truthful no-context preflight retry, strict worker-port parsing, invocation epoch ownership, and terminal rAF cancellation; focused reader/runtime suite 75/75 and type-check passed).
