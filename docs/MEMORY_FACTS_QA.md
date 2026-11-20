# Local memory / web fact checks — 0.6.0 release record

Status: 0.6.0 implementation, final review and package completed. The whole-change review's two controller defects and stale Omi instructions were fixed in e26ef1d; the independent scoped rereview found all three addressed with no new blocking issue. Root reran all 363 tests on that final commit successfully. Private upload is blocked at Developer Hub sign-in: the authorized app URL still redirects to login, so no upload or publication is claimed. Physical-device and live-provider acceptance are not claimed. Native QuickList write API is not exposed in the inspected public SDK.

Milestones: local history/import at 2a9ed81; local RAG/web checks through 2b57d75; phone history/deletion/priority through 499137b; contextual cards/shortcuts through 4bf96a2. Release qualification now accepts short Chinese categorical claims (`水是元素。`) and preserves historical speaker, session ID/title and Helix/Omi source in quoted model input. The existing snippet and aggregate request budgets remain in force. Both cases received failing tests before the fixes. The final lifecycle fix wave preserves live features after archive deletion and preserves the web scheduler across ordinary speech commits; final gates passed 363 tests.

## Approved scope

Explicit Omi conversation import, persistent phone-local searchable history, local source-linked RAG, direct incremental answers, optional nonblocking live web fact checking, private Developer Hub upload. No Helix server.

## Acceptance matrix

| Boundary | Required evidence | Current status |
|---|---|---|
| Local history | Reload, bilingual search, source passage, deletion, storage failure | Automated tests and native store reconstruction passed; root real DOM search/source checks passed |
| Omi import | Multi-page transcript import, repeated import dedupe, cancel/error | Injected-provider tests passed; native two-page/26-session import repeated without duplicates |
| Local RAG | Relevant source inclusion, no answer-as-fact, no Omi call during answer | SDK attribution tests and native fixture source inclusion/Omi-zero checks passed |
| Streaming | First phone/native bridge text before provider completion | Native injected-provider partial bridge text and actual phone DOM before provider completion passed |
| Web facts | OFF zero calls; ON real web_search contract; sources; failure and abort | Native fixture OFF zero, sourced short-Chinese correction, immediate OFF abort/late silence passed |
| Display priority | Manual replacement beats stale answer/correction; idle hides | Fresh memory/facts and answer-first native regressions passed; English/CJK paging, latest request abort, idle hide, busy cue priority |
| Contextual cards | Source-linked explanation; busy-answer protection; OFF cancellation; no stale popup | Fresh native fixture and root real phone DOM interactions passed |
| Native shortcuts | OS contextual menu item invokes action; plain gestures unchanged; phone equivalents | Native OS context_menu/down/up/click delivered itemID 1 and Explain provider request; phone five actions passed |
| Project gate | Full build/test and credential guard | npm run check and bash scripts/run_gate.sh each passed 363 tests; all builds and guards passed |
| Package | Version, file list, checksum, no QA/keys bundled | 0.6.0 package created and production input files inspected; details below |
| Developer Hub | New version visible in Private builds after Add build | Blocked at sign-in; user handoff requested, not uploaded |
| Live provider account | Actual current key entitlement, network and sourced search | Not yet exercised |
| Physical G2 | Install, live microphone, optics/legibility, gesture and latency acceptance | Not yet exercised |
| Native QuickList | Supported public writer and native destination verification | Unsupported: no writer found in public SDK; fallback choice pending, no extra service implemented |

## Verification rules

- Fixture results must carry `fixtureOnly: true`; do not describe them as real-provider or physical-device verification.
- Report imported/upserted conversations separately from newly added records.
- Public factual claims are candidates, not guaranteed errors. Without completed web search and usable citations, no confident correction is displayed.
- Local retrieval is bilingual lexical retrieval with recency weighting, not a remote embedding service or guaranteed semantic recall.
- The original portal was read through Computer UI before implementation: latest private build 0.5.0. Upload 0.6.0 only after final review and gates.
- Rechecked 2026-09-12 in Chrome: the authorized Helix portal URL redirects to sign-in. Upload is not verified; user sign-in requested while implementation continues.
- Physical-device availability was checked with xcrun devicectl during this release: the registered physical iPhone was unavailable; connected entries were simulated. Android platform-tools adb also listed no attached devices. No physical G2/phone acceptance is inferred from simulator results.
- Device inventory repeated 2026-09-12 with the same boundary: registered physical iPhone unavailable, connected iPhone simulated, adb list empty.

## API research checks

- [Omi Developer API introduction](https://docs.omi.me/api-reference/introduction) identifies the Developer API key from Settings → Developer → Create Key. This is not the Omi MCP key. Import needs conversation-read permission, not write permission.
- [Omi conversation listing](https://docs.omi.me/api-reference/endpoint/conversations/list) supports offset pagination and include_transcript=true. No memory-search endpoint is needed while answering.
- [OpenAI web-search guide](https://developers.openai.com/api/docs/guides/tools-web-search) explicitly supports tool_choice=required when search must run. URL citations must be visible and clickable. The implementation must validate both executed search and citation annotations before displaying a confident verdict.

## Release commands and package

`npm run test -w @helix/conversation-sdk -- test/fact-check.test.ts test/direct-transport.test.ts`: RED 4 failed / 45 passed; GREEN 49 passed. The RED cases were the short Chinese claim, existing retrieval serialization, and first-person attribution for each of Helix/Omi.

`npm run check`: final lifecycle-wave exit 0, SDK 159, legacy gateway 104, plugin 100 tests; 35 test files / 363 tests. The initial release qualification passed 356 tests after updating its stale 0.5.0 controller-test version assertion to 0.6.0. `bash scripts/run_gate.sh`: final exit 0 with the same 363 tests and `HELIX_G2_GATE_PASSED`. Both were run as required. Explicit strict TypeScript checking of the two QA pages passed during initial qualification; these unchanged QA pages are excluded from the production TS include/entry graph.

`npm run pack:g2`: final lifecycle-wave exit 0, SDK floor 0.0.14 / Even App 2.2.9, package `apps/g2-plugin/helix-g2.ehpk`, **846,890 bytes**. SHA-256: `448d5437dd437ad5ab35a3bbc1ea23f4561bd3758843bc42db2fbc7072e8e9eb`. App/root/plugin/SDK/dependent SDK references and client handshake are 0.6.0; legacy gateway standalone version stays 0.3.0.

The artifact begins with custom `EHPK` signature and format 1, not ZIP. Inspection covers the exact manifest and nine production files supplied to the official packer, plus artifact signature/size/SHA; it is not an independent decoder audit of the packer's container payload. Production files: index.html; assets/index-CRHvWBnb.js; assets/index-3Jfrjm8J.css; g1/PROVENANCE.md; g1/helix_assistant_hero.webp; g1/fonts/inter_variable.ttf; g1/fonts/fraunces_variable.ttf; g1/licenses/OFL-Inter.txt; g1/licenses/OFL-Fraunces.txt. Scans found no QA entry/marker/synthetic record or credential material. No QA page is reachable from the production entry graph.

`npm audit --omit=dev --json` reported zero vulnerabilities. The full development dependency audit reports two existing moderate entries for vitest/@vitest/mocker, GHSA-82fw-gwwq-j7x9. No broad tooling major upgrade was included in this release.

## Root Computer phone checks

Root reported actual production CompanionUi DOM interactions in the explicitly labeled `memory-facts.html?browser=1` fixture at 390 × 844: no horizontal overflow; all five Shortcuts; expand/source/dismiss automatic explanation; delayed card preserves active typed-input focus; OFF suppresses pending explanation; synthetic import of 26 sessions; English `budget` and Chinese `预算` search; original passage with Fixture Alice, Omi timestamp/source; answer source chip opens/highlights its original; local partial before completion; Global/Explain replace earlier streams with interrupted card; local-memory OFF produces no source chip; web ON yields sourced short-Chinese contradiction and HTTPS citation; pause/resume; all four masked key fields and save OFF. Browser fake-display acceptance is not native evidence.

Root separately inspected actual native simulator PNGs on black background: partial answer, automatic explanation and OS contextual menu. Text was legible; the explanation used the full-width region and menu exposed all five labels. Native PNG RGB is green with alpha, so a viewer that ignores transparency appears solid green; inspect composited on black without altering the original capture.

## Accepted native memory/facts run

Fresh official simulator 0.9.5, production source/build frozen, synthetic providers/PCM, actual Even storage/display bridge. `node scripts/qa_memory_facts.mjs` exited 0 with `G2_MEMORY_FACTS_QA_PASSED`. Result in `artifacts/memory-facts/memory-facts-result.json`: `fixtureOnly=true`, `browser=false`, `partialBeforeCompletion=true`, `omiCallsDuringAnswer=0`, `webCallsWhenDisabled=0`, `historyAfterReload=27`, `importedSessions=26`, `ragIncluded=true`, `nativeMenu=true`, `passed=true`. The 27 reconstructed sessions are 26 imported plus one Helix fixture session. Reconstruction uses a second LocalHistoryStore over actual Even get/set; no full phone-process restart is claimed.

Native screenshot pairs (glasses/webview): partial-answer, sourced-correction, automatic-explanation, expanded-explanation, busy-answer-priority, phone-shortcuts, native-context-menu, native-explain-term. Structured console events are in memory-facts-events.json. The fixture uses unique QA storage prefixes, never clears production history/keys, and includes no actual user records or provider credentials.

Discarded development attempts exposed fixture assertions/cleanup issues that were fixed before the accepted fresh run. One discarded attempt also suspended WebView timers for over 110 seconds while HTTP console remained responsive; official context_menu input resumed overdue callbacks. No busy CPU loop was observed. One scoped foreground diagnostic was used before the parent required only Computer/official API for further UI operations; no global preferences changed and no further OS scripting followed. This is a simulator suspension caveat, not accepted timing evidence. The accepted run completed with official API interactions/screenshots and no console errors.

## Paging regression and production startup

`AF_QA_OUTPUT=artifacts/memory-facts/answer-first node scripts/qa_answer_first.mjs` passed in a fresh official simulator: `G2_ANSWER_FIRST_QA_PASSED`. Two English pages and two Chinese pages retained their ending markers; completed-answer reading survived new speech/question detection; both auto-hid; local/global replacement aborted old work; click-before-double produced one global request; hold/release left blank glasses. The earlier `artifacts/answer-first` evidence was preserved. New events/result/PNGs live under `artifacts/memory-facts/answer-first`.

A final fresh native instance loaded the exact production `dist` through `npm run preview -w @helix/g2-plugin -- --host 127.0.0.1 --port 4174`. The real companion showed Ready / Glasses ready / Blank until an answer with no QA banner or fixture controls; six startup console entries contained no errors or QA markers. Production-startup-webview.png and production-startup-glasses.png are in artifacts/memory-facts. No key entry, connection or provider call occurred. All worker-owned native/preview processes were stopped afterward; the parent's Vite development server was preserved.

## Final lifecycle fix wave — 2026-09-12

Against release base `d7e572a`, successful deletion now disables archival for the current connection while retaining live identity, transcript/manual priority tracking, fact and explanation callbacks, and answer source chips. Reconnect creates a new archivable session. Pending deletion still suspends new writes synchronously, serializes accepted writes/deletion, and resumes future archival after failure. Deleted archives remain absent through more speech, facts, answers, reconnect and store reconstruction; existing Omi import/delete ordering remains covered.

Ordinary hold/release and pause commits retain active web checks, latest pending speech, three-second cooldown, preceding speech context and claim deduplication. Explicit manual/local/global answer requests, OFF, disconnect and exit still cancel. No SDK scheduler or architecture changes were needed. Deployment instructions now describe explicit Omi key/History import and session-only notes.

RED covering integration run: 3 failed / 18 passed. Two successful-deletion windows lost post-delete facts, explanation cards and source chips; successive holds aborted the active request and started three searches. GREEN history/controller/presentation: 43/43 passed. Final complete gates and package are recorded above.

Production code/build froze after packaging. Fresh official simulator memory/facts and answer-first runs both passed first attempt, with no timer suspension, source/build mutations or OS UI scripting. Final memory/facts overwrote the standard `artifacts/memory-facts/memory-facts-{result,events}.json` and eight PNG pairs: `fixtureOnly=true`, `browser=false`, `partialBeforeCompletion=true`, `omiCallsDuringAnswer=0`, `webCallsWhenDisabled=0`, `historyAfterReload=27`, `importedSessions=26`, `ragIncluded=true`, `nativeMenu=true`, `passed=true`. The earlier whole directory was preserved in `artifacts/memory-facts-before-final-fix`.

Final paging command: `AF_QA_OUTPUT=artifacts/memory-facts/answer-first-final-fix node scripts/qa_answer_first.mjs`; exit 0, `G2_ANSWER_FIRST_QA_PASSED`, two English and two Chinese pages, tails/auto-hide, completed-answer reading during speech, replacement/abort, click discrimination and hold/release blank passed. The production-startup images above remain initial `d7e572a` qualification evidence; the final bundle was inspected and the changed controller exercised in the fresh final native fixtures. Both worker native processes were stopped; the parent Vite server remained running.

Root's targeted Computer browser follow-up on frozen code saw two synthetic web requests 3.205 seconds apart, both fact cards, no web-aborted log, and no third request for the repeated Chinese claim. Local help still streamed a partial with a memory source chip. Post-successful-deletion verification is production-controller integration coverage, not a root DOM deletion claim. Synthetic provider results do not establish live factual accuracy, account entitlement, physical G2 acceptance or private Hub upload. Root owns final scoped review and upload; sign-in remains required.
