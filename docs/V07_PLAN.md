# Helix G2 v0.7 — copilot rework plan

Contract: `packages/conversation-sdk/src/copilot-types.ts` (do not change shapes without telling the integrator; additive fields OK).

## Problems being fixed
1. Model list stale + selection not persistent. `ui.ts writeConfig` and `controller.ts connect` clamp to gpt-4.1-mini/gpt-4o-mini; config only saved on Connect.
   Current OpenAI lineup (developers.openai.com pricing + models pages, read 2026-11-07), all reasoning models, Responses API, web_search supported, 1.05M context, 128K max output:
   - gpt-6-astra   $10.00 in / $1.00 cached / $50.00 out  effort: low..max (no none)
   - gpt-6.1-sol   $2.00 / $0.10 / $10.00                 effort: low..max (no none)
   - gpt-6.1-terra $1.00 / $0.05 / $5.00                  effort: none..max
   - gpt-6-luna    $0.10 / $0.01 / $0.50                  effort: none..max
   Legacy still callable: gpt-4.1-mini (page lists gpt-4.1-mini-2025-04-14 $0.80/$0.20/$3.20), gpt-4.1 ($3.00/$0.75/$12.00), gpt-4o-mini (no published price -> cost "unknown").
   Transcription: gpt-transcribe $0.0045/min (new default; supports free-form `prompt`; `language` param not documented -> omit), gpt-4o-mini-transcribe $0.003/min, whisper-1 $0.006/min. whisper-1 + gpt-4o*-transcribe shut down 2027-02-26.
   Web search tool: $10 per 1k calls + search content tokens at model rate.
   Reasoning models: send `reasoning: { effort }` (Responses) and budget max_output_tokens for reasoning (>= 2000). Chat Completions for gpt-6*: not documented -> force Responses.
2. Timing/money wrong: answer meta shows `totalMs` measured from audio commit incl. queueing; no cost at all. Fix with AnswerTiming + UsageRecord from provider `usage` (Responses `response.completed.response.usage`; chat `stream_options.include_usage`). Also time/price *content* answers need web grounding (lookup lane).
3. RAG finds nothing: retrieval excludes current session, transcript-only, exact-token lexical with high threshold, no diagnostics, no web. Fix: BM25-ish + prefix/stem matching, include prior answers/fact-checks at lower weight, return diagnostics, optional web-grounded answers with citations.

## New features
Rolling summary, conflict detection, concept channel (CDTF -> explanation), suggested questions spanning whole conversation, interactive verification (verify any point), implicit asks (Jetson lead time -> web lookup; "16 GB RAM / 1 TB SSD architecture" -> proposed answer), rehearsal mode (scripted interview / technical discussion played through the pipeline, must finish).

## Ownership (parallel agents; stay in your files)
- SDK agent: packages/conversation-sdk/src/{model-catalog,copilot,usage,direct-providers,direct-transport,local-history,fact-check,context-insights,questions,index}.ts + packages/conversation-sdk/test/*.
- UI agent: apps/g2-plugin/src/{ui,styles.css,presentation,pixel-art,tabs,config}.ts + matching tests in apps/g2-plugin/tests.
- Rehearsal agent: apps/g2-plugin/src/rehearsal.ts (scripts data + player), scripts/live-rehearsal.mjs, apps/g2-plugin/tests/rehearsal.e2e.test.ts, docs/REHEARSAL.md, fake OpenAI fetch in apps/g2-plugin/tests/fake-openai.ts.
- Integrator: apps/g2-plugin/src/{controller,main}.ts wiring, README, final gate.
