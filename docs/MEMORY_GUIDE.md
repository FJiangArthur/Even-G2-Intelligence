# History, Omi import and fact checking

Describes 0.13. See MEMORY_FACTS_QA.md for the validation status recorded for earlier releases.

## Import Omi records

Omi integration imports conversations and their transcript passages into this phone's Helix history. It does not search Omi while generating answers, and it does not automatically upload Helix notes to Omi. Import is manual unless you turn on automatic import (below).

Use an Omi **Developer API Key** with conversation-read access, obtained in the Omi app's **Settings → Developer → Create Key**, not a key from its MCP settings. Enter it in the masked Omi key field in Setup → API keys, choose the date range in **Knowledge → Transfers → Omi → Helix**, and tap **Import from Omi**. You can cancel an import. Previously saved pages remain available after a cancellation or network failure; retrying upserts matching records instead of duplicating them. The imported count means conversations processed in that run, including records already present.

No key is stored inside the history archive. The separate save-API-keys option is an explicit opt-in to ordinary Even App local storage, not a documented encrypted vault.

### Import automatically (0.13)

**Knowledge → Transfers → Omi → Helix → Import new Omi conversations automatically** is OFF by default. Until 0.13 there was no automatic import at all: Omi conversations arrived only when you tapped **Import from Omi**.

When it is ON, Helix imports when the app opens, when it returns to the foreground, and about every 30 minutes while it stays open (a failed attempt is retried after 5 minutes). The first run covers the last 14 days; later runs start one day before the last successful run, and repeated records are updated, not duplicated. The line under the switch shows the last result or the reason nothing was imported.

- It needs the Omi developer key at that moment. After a restart the key is only there if **Save API keys on this phone** is on; otherwise the status line says the key is missing and the import starts as soon as you enter it.
- It cannot run while the Even app is closed or Helix is not open. Plugins have no background execution.
- The switch and the last outcome are stored under `helix.omi.auto-import.v1`. The key and conversation text are never written there.
- A conversation Omi returns in a form Helix cannot read is skipped and counted instead of failing the whole import (this also applies to the manual import). Timestamps without a UTC offset are read as UTC.

## Import notes, export notes (0.13)

All of this is in **Knowledge → Transfers**. Every action now reports next to its own button, with one row per file.

**Import (Obsidian → Helix).** Three ways, because the Even app's WebView may not offer a file picker:

1. **Choose note files**: several `.md` / `.txt` files at once. Each file gets its own row (imported, or the reason it failed). One unreadable file no longer cancels the others. Limits: 2 MB per note, 200 notes per batch.
2. **Paste text instead**: no file picker needed.
3. **Import from a link**: an `https://` link to a Markdown or text file. This only works when the site allows cross-site reads; inside the Even app only the plugin's whitelisted provider hosts are reachable, so expect it to fail there and paste the text instead.

**Export (Helix → Obsidian).** **Export vault** tries, in order, and tells you which one happened:

1. In an ordinary browser: a normal download (one `.md`, or a `.zip` of notes).
2. In the Even app: the system share sheet with the file, where the phone's WebView offers it ("Save to Files", Obsidian, AirDrop…).
3. The notes copied to the clipboard as one Markdown document.
4. The Markdown shown in the page (**Show Markdown here**) to select and copy by hand.

Before 0.13 the app clicked a hidden download link and always reported "Prepared …". The Even bridge has no file-save API and an embedded WebView only saves such a link if the host app handles downloads, so in the app nothing was saved. Helix no longer attempts that link inside the Even app.

## PDF documents (0.13)

**Knowledge → Transfers → PDF → Helix** adds PDFs to the knowledge base: up to 20 per batch, 30 MB each, at most 400,000 characters of text kept per PDF. The parsed text is stored in the phone archive, which holds 5 MiB for all sessions together, so a batch of large PDFs may not all fit (400,000 Chinese characters alone are about 1.2 MB). A PDF that does not fit is reported as failed with the storage-limit message; it is saved all-or-nothing, so no empty document is left and an earlier copy of the same file stays as it was. Each PDF has its own progress row; one failing does not affect the others, and **Cancel** keeps what was already added. Adding the same file again replaces it.

Choose how the PDFs are read:

| | On this phone | With OpenAI |
|---|---|---|
| Upload | None | Each PDF is uploaded to your OpenAI project with the key from Setup |
| Cost | None | Billed to your key: input tokens for the text and an image of every page, plus the transcription as output tokens |
| Scanned / photographed PDFs | Not readable (no OCR): reported as "No selectable text found" | Readable, the model sees the page images |
| Limits | Text layer only; first 500 pages; multi-column pages and tables can come out mixed; password-protected PDFs are rejected | Long documents can be cut at the model's output limit (reported as "text was cut") |
| After parsing | — | The upload is deleted from OpenAI again |
| By link | No (needs the file) | Yes: **Add a PDF by link** sends the link to OpenAI, which downloads it. Use this when the file picker is unavailable |

The on-phone parser is pdf.js. It is loaded only when the first PDF is parsed, so it does not slow app start, but it adds about 1.8 MB to the plugin package.

The text is saved on the phone as an ordinary knowledge document: listed under **Obsidian** with the tag `pdf`, visible in History, deletable there, and counted in the 5 MiB archive limit. The on-phone keyword search uses it in answers like any other passage, with the page number kept. If **OpenAI knowledge base** is selected and already created, newly added PDFs are synced to it right away; otherwise they are included in the next **Sync to OpenAI**. PDFs are not sent by **Send Obsidian notes to Omi**.

### What was checked where

Checked by automated tests and in a desktop browser with a fake bridge (`apps/g2-plugin/qa/knowledge-io.html`): the fallback order, per-file results, auto-import schedule and persistence, both PDF parsers against a fake OpenAI, and real PDF bytes through pdf.js.

Not checked, needs the real Even app on a phone: whether its WebView opens a file picker for `<input type="file">` (and with multiple selection), whether it offers the share sheet with files, whether the clipboard works there, whether pdf.js can start its worker from the app's origin (it falls back to the main thread), and the real OpenAI and Omi responses.

## Search and use local memory

History contains past Helix sessions and imported Omi conversations. Search accepts English and Chinese. Open a result to see its original session, passage, time and speaker when available. Generated answers and Omi summaries remain searchable, but only original transcript passages are eligible for RAG.

With local memory enabled (the default), relevant past transcript passages are supplied alongside the current question and captured session context. Each quoted passage retains its available speaker, session ID/title and Helix/Omi source. First-person preferences belong to that recorded speaker, and an unknown speaker stays unknown. The current conversation takes priority over old or conflicting memories. Retrieval updates as completed transcripts are saved and imports finish; it does not make a separate network request. It uses bilingual lexical matching with recency weighting, so a paraphrase with no shared terms can be missed. At most five snippets of 600 characters each are included, within the existing aggregate model request budget.

History is phone-local, not account-wide cloud sync. Keep the original Omi records as a separate source. The archive has a 5 MiB safety limit: a quota or write failure is reported rather than silently deleting older conversations. Delete unwanted sessions only deliberately; deletion removes their passages from future local retrieval. App removal or clearing app storage may remove this local archive.

Deleting the currently active session stops saving that connection's history until you reconnect; the live conversation itself continues. Events received while deletion is pending are not archived. If deletion fails, previously saved history remains and future events resume saving; the pending interval is not replayed. Deleting an Omi session while an import is running waits for that import to finish or be cancelled. A later explicit import can intentionally restore the Omi record.

## Enable live web fact checking

Live web fact checking is separate from local memory and starts OFF (Knowledge → Memory → **Live web fact check**; **Verify** checks a single claim). Enabling it sends short candidate public factual claims from committed speech to a web search chosen by your answer provider:

- **OpenAI answers (default):** OpenAI's Responses web-search tool, with your OpenAI key.
- **DeepSeek answers:** DeepSeek's own web search, with your DeepSeek key.
- **Zhipu GLM (China) answers:** the Zhipu Web Search API, then GLM judges only those results, with your Zhipu key.
- **Other providers (Qwen, Kimi, Zhipu international):** OpenAI web search when an OpenAI key is entered; otherwise checks are off and Setup says so.

Provider search and model charges apply. Requests go from the phone straight to that provider; no Helix gateway or third-party search proxy is involved. With **Prefer latest news in fact checks** on (the default) the check carries today's date and prefers recent, dated reporting. Details: [PROVIDERS_AND_SEARCH.md](PROVIDERS_AND_SEARCH.md).

Search runs in the background and does not hold up streamed answers. Its results distinguish supported, contradicted, uncertain and unavailable. A verdict requires a completed web search and usable sources (on DeepSeek, when the answer carries no citation, the first results of the search it ran are listed). Open those links on the phone to inspect the evidence. Lack of evidence or a failed request is not proof that a claim is false.

Only relevant candidate claims are checked; this is not a guarantee that every utterance is verified. A short cooldown and one active search bound load. Disabling the toggle cancels in-flight checking and suppresses late results. A sourced correction cannot overwrite a newer explicit answer on the glasses.

## Stream and glasses behavior

Answers update from provider deltas; they do not wait for the complete response. Provider/network latency and the physical glasses bridge remain separate factors. Transcript updates and source details stay on the phone.

Since 0.13 the glasses display is **ambient** by default: during a conversation the lens is blank. An answer pops up, pages by itself and disappears when it has been read; lookups, term explanations and fact verdicts pop up as short cues and disappear too. Cues wait while an answer is showing. **Double-tap** wakes the full HUD with its menu; double-tap on the menu, or 20 seconds without a gesture, blanks it again. Setup → G2 controls → **Always show the glasses HUD** keeps the full HUD on instead. Details: [PIXEL_GESTURES.md](PIXEL_GESTURES.md).

Gestures: **tap** pages or closes what is showing; with nothing showing it asks about the last few sentences of the conversation (a billed request). **Double-tap** opens the menu; the whole-conversation answer is the menu item **Answer all**. **Hold / release** is push-to-talk. Requested answers can use relevant local history when enabled, and a later request replaces earlier answer work.

## Explanations and shortcuts

Automatic term explanations start ON. Final live speech can trigger a separate model request using the selected answer provider, its model and its key (OpenAI, DeepSeek, Qwen, Zhipu or Kimi); provider charges apply. Setup → **Answer length** sizes the explanation (Brief: one short sentence; Detailed: two to four sentences). The phone labels these cards AI-generated and not web-verified. Expand Explanation, open Original transcript, or Dismiss. New cards preserve typing focus. Explanations are live feed cards, not a new durable archive type; their source transcript is saved through normal history.

On the glasses an explanation is a cue: on the ambient display it pops up and disappears after it has been read. Answers have priority; a cue that waited too long (45 seconds) is dropped, not replayed. Turning automatic explanations OFF cancels pending analysis and suppresses late cards. Manual questions cancel earlier analysis; pending manual answers take priority over newly finalized speech analysis.

Use the native OS tap-then-hold menu or the phone Shortcuts button for Explain term, Local answer, Global answer, Dismiss cue, and Pause / resume. No custom tap-and-hold recognizer is added. The inspected public Even SDK has no QuickList writer; QuickList export is unsupported and the fallback/destination choice remains pending. No extra service has been added.

## Sources

- [Omi Developer API](https://docs.omi.me/api-reference/introduction)
- [Omi conversation list and transcript inclusion](https://docs.omi.me/api-reference/endpoint/conversations/list)
- [OpenAI Responses web search](https://developers.openai.com/api/docs/guides/tools-web-search)
- [OpenAI file inputs (PDF `input_file`, 50 MB limits, text + page images)](https://developers.openai.com/api/docs/guides/file-inputs)
- [OpenAI Files API (`purpose: user_data`)](https://developers.openai.com/api/reference/resources/files/methods/create)
