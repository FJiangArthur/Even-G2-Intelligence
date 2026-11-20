# History, Omi import and fact checking

Release target: 0.6.0. See MEMORY_FACTS_QA.md for actual validation/upload status.

## Import Omi records

Omi integration imports conversations and their transcript passages into this phone's Helix history. It does not search Omi while generating answers, and it does not automatically upload Helix notes to Omi.

Use an Omi **Developer API Key** with conversation-read access, obtained in the Omi app's **Settings → Developer → Create Key**, not a key from its MCP settings. Enter it in the masked Omi key field, choose the desired date range in History, and use the explicit import action. You can cancel an import. Previously saved pages remain available after a cancellation or network failure; retrying upserts matching records instead of duplicating them. The imported count means conversations processed in that run, including records already present.

No key is stored inside the history archive. The separate save-API-keys option is an explicit opt-in to ordinary Even App local storage, not a documented encrypted vault.

## Search and use local memory

History contains past Helix sessions and imported Omi conversations. Search accepts English and Chinese. Open a result to see its original session, passage, time and speaker when available. Generated answers and Omi summaries remain searchable, but only original transcript passages are eligible for RAG.

With local memory enabled (the default), relevant past transcript passages are supplied alongside the current question and captured session context. Each quoted passage retains its available speaker, session ID/title and Helix/Omi source. First-person preferences belong to that recorded speaker, and an unknown speaker stays unknown. The current conversation takes priority over old or conflicting memories. Retrieval updates as completed transcripts are saved and imports finish; it does not make a separate network request. It uses bilingual lexical matching with recency weighting, so a paraphrase with no shared terms can be missed. At most five snippets of 600 characters each are included, within the existing aggregate model request budget.

History is phone-local, not account-wide cloud sync. Keep the original Omi records as a separate source. The archive has a 5 MiB safety limit: a quota or write failure is reported rather than silently deleting older conversations. Delete unwanted sessions only deliberately; deletion removes their passages from future local retrieval. App removal or clearing app storage may remove this local archive.

Deleting the currently active session stops saving that connection's history until you reconnect; the live conversation itself continues. Events received while deletion is pending are not archived. If deletion fails, previously saved history remains and future events resume saving; the pending interval is not replayed. Deleting an Omi session while an import is running waits for that import to finish or be cancelled. A later explicit import can intentionally restore the Omi record.

## Enable live web fact checking

Live web fact checking is separate from local memory and starts OFF. Enabling it sends short candidate public factual claims from committed speech directly to OpenAI's Responses web-search tool using your runtime OpenAI key. Provider search and model charges apply. No Helix gateway or third-party search proxy is introduced.

Search runs in the background and does not hold up streamed answers. Its results distinguish supported, contradicted, uncertain and unavailable. A confident correction requires completed web search and usable source citations. Open those links on the phone to inspect the evidence. Lack of evidence or a failed request is not proof that a claim is false.

Only relevant candidate claims are checked; this is not a guarantee that every utterance is verified. A short cooldown and one active search bound load. Disabling the toggle cancels in-flight checking and suppresses late results. A sourced correction cannot overwrite a newer explicit answer on the glasses.

## Stream and glasses behavior

Answers update from provider deltas; they do not wait for the complete response. Provider/network latency and the physical glasses bridge remain separate factors. Transcript updates and source details stay on the phone. Glasses use the full 576 × 288 native text region, paginate long output and hide after reading. Sourced corrections and automatic explanations can temporarily use the idle display, without interrupting answers.

Single press asks using recent context; double press asks using the captured session context. Both can use relevant local history when enabled, and a later press replaces earlier answer work. Hold/release remains push-to-talk.

## Explanations and shortcuts

Automatic term explanations start ON. Final live speech can trigger a separate model request using the selected answer model and runtime OpenAI key; provider charges apply. The phone labels these cards AI-generated and not web-verified. Expand Explanation, open Original transcript, or Dismiss. New cards preserve typing focus. Explanations are live feed cards, not a new durable archive type; their source transcript is saved through normal history.

An idle glasses explanation hides after eight seconds. Busy answers have priority and a skipped cue is not replayed afterward. Turning automatic explanations OFF cancels pending analysis and suppresses late cards. Manual questions cancel earlier analysis; pending manual answers take priority over newly finalized speech analysis.

Use the native OS tap-then-hold menu or the phone Shortcuts button for Explain term, Local answer, Global answer, Dismiss cue, and Pause / resume. No custom tap-and-hold recognizer is added. The inspected public Even SDK has no QuickList writer; QuickList export is unsupported and the fallback/destination choice remains pending. No extra service has been added.

## Sources

- [Omi Developer API](https://docs.omi.me/api-reference/introduction)
- [Omi conversation list and transcript inclusion](https://docs.omi.me/api-reference/endpoint/conversations/list)
- [OpenAI Responses web search](https://developers.openai.com/api/docs/guides/tools-web-search)
