# Answer-first G2 v0.5.0 QA and release record

## Requested behavior

The implementation plan and spec are in [the plan](superpowers/plans/2026-09-10-answer-first-g2.md) and [acceptance specification](superpowers/plans/2026-09-10-answer-first-g2-spec.md). Release acceptance requires answer-only blank-idle glasses, full-width/full-height answers, automatic pagination, phone-only transcripts, local/global context, and replacing local/global gesture requests.

## Evidence collected before implementation

- Even Hub portal https://hub.evenrealities.com/hub/com.helix.g2conversation is accessible through Computer and lists private build v0.4.0. This is the baseline, not evidence of the new upload.
- Native simulator 0.9.5 full-screen text calibration (568×280 region, 4 px margins) uses the full line width with native wrapping. Old code's preinserted line breaks and seven-panel dashboard caused wasted area.
- Full-width English and CJK screenshots are in local `artifacts/answer-first/calibration-native.png` and `calibration-cjk.png`. CJK has approximately 28 glyphs per line; ordinary English prose around 60–65 characters in this calibration. A 708-character English paragraph overflows the screen and must be paged.
- Official [display documentation](https://hub.evenrealities.com/docs/build/display) confirms native text wrapping, a fixed font, the 576×288 canvas and one event-capture container. The simulator's bundled README warns that font rendering can differ from hardware.

## Verification status

SDK engine milestone: reviewed implementation at `b93b5b7`; full build/check passed **236 tests** (SDK 69, legacy gateway 104, plugin baseline 63). Dedicated tests cover full-session retention beyond UI history, independent transcript ingestion, local/global scope, replacing queued/running answers, delayed Omi cancellation, empty-context and size-limit errors, six-second segment boundaries and transient audio-commit recovery. Review caught and fixed lost manual chat history, lost explicit automatic question targets and empty frames after a failed segment commit. No real provider or credentials were used in these deterministic tests.

Official simulator deterministic run: `node scripts/qa_answer_first.mjs` passed against a fresh simulator 0.9.5 instance at `/qa/answer-first.html`. Actual native bridge calls, controller, SDK direct transport and companion UI were used, with synthetic PCM and injected provider fetch responses (no real keys or paid calls). It verified:

- Blank startup and transcript-only glasses; transcript and detected question visible on phone.
- A fresh transcript and detected question after long-answer completion do not interrupt the current page, its later pages or final expiry (expanded post-review native regression).
- Two English pages and two Chinese pages, all trailing text retained, native full-width wrapping and final automatic blanking.
- Local request cancellation by global request, no cancelled text resurfacing, double click does not exit.
- Click-before-double discrimination issues exactly one global request.
- Hold/release opens/closes microphone port, adds phone transcript and does not revive old output.

Root visually inspected both English and Chinese native screenshots on a black background through Computer: first pages use ten rows across almost the entire screen; final pages retain the English and Chinese tail markers; idle is blank. Raw captures and structured events/results are under `artifacts/answer-first/`. An earlier development instance invalidated by hot reload was discarded; the accepted run was fresh and had no console errors.

Read-only framebuffer alpha analysis corroborates the visual check: English first-page glyph bounds x=4…563, y=10…270; Chinese x=5…563, y=9…270 on the 576×288 canvas. Both completed-answer idle and production startup idle contain zero visible pixels (alpha >32). These are simulator measurements, not physical lens measurements.

Final release gate `bash scripts/run_gate.sh` passed: **255 tests** (SDK 83, legacy gateway 104, plugin 68), all builds, workspace credential scan and compiled credential-variable check. Independent task reviews passed; final whole-branch review then found and fixed completed-answer interruption by new detection and combined provider-context overflow. Both received RED→GREEN regressions in commit `e3a3924`; the expanded native simulator scenario also passed. The separate production build was loaded in a fresh official simulator: actual ready companion and blank-until-answer state loaded without console errors; no QA banner or fixture controls were present.

The complete serialized provider request now receives a conservative UTF-8-byte budget plus output/framing reserve. Old auxiliary manual exchanges can be omitted, but the mandatory captured transcript/current request/instructions are not sliced. Mandatory overflow is actionable before dispatch; provider overflow errors are sanitized. Known GPT-4o/4.1-family capacities are supported; unknown SDK model IDs use an explicitly provisional 4,096-unit budget. This can reject earlier than exact tokenization; it does not silently truncate the session transcript.

System-exit/abnormal-exit cleanup is covered by controller/router integration tests; the simulator automation API does not expose that native event. Physical G2 remains a separate acceptance gate.

## Package and portal

Final rebuilt `apps/g2-plugin/helix-g2.ehpk` from `npm run pack:g2`: app/plugin/SDK version **0.5.0**, SDK **0.0.14**, minimum Even App **2.2.9**, **834,054 bytes**, valid `EHPK` signature. SHA-256: `72d399cf1107d8a74521cc43f05e814343a7f5b689158493052a409a65b1aae2`. The earlier pre-review candidate was replaced and was not uploaded.

All nine production files passed a credential-pattern, QA-marker and obsolete gateway-origin scan. No runtime credential was bundled. Scoped final fix review passed both findings with no new Critical/Important issues.

**Portal upload verified through Computer on 2026-09-10 at approximately 08:18 UTC.** The native Chrome file picker selected the exact package above. Even Hub parsed `v0.5.0`, `helix-g2.ehpk`, `834.1 KB`, `Private`; a 466-character changelog described the changes and test boundaries. After clicking **Add build**, the modal closed and the requested app's **Private builds** list showed **v0.5.0 — Uploaded 13 seconds ago — Private** above the prior v0.4.0 build. Both accessibility text and screenshot confirmed the saved list entry. No public publication, testing-group change, installation or physical G2 acceptance was performed.

Code and release records were committed on the existing main checkout per the user's instruction. The only process ruling was using main instead of a new worktree; its risk would be concurrent checkout conflicts, and no unrelated modifications were overwritten. Temporary plan-specific review scratch was removed from the checkout after the durable QA record and commits were retained; framebuffer artifacts remain available locally.

## Acceptance boundaries

“Global” is the whole captured transcript in the current session, not unrelated past conversations or private files. Local focus is recent sentences with relevant earlier background. The raw session context has a size ceiling of 96,000 bytes. Since v0.15 the beginning rolls off at the ceiling and the model is told that earlier speech is not included; before v0.15 the session ended with an error.

Whisper `whisper-1` produces completed audio-clip transcripts, not word-by-word streaming. Phone updates should arrive as each bounded segment is transcribed; real provider partial events, when available, are phone-only. Cloud AI still requires internet; Helix itself has no server.

Portal private-build upload, public publication, installation and physical G2 acceptance are distinct. This record will identify exactly which occurred.
