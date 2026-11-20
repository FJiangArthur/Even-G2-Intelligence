# Answer providers, news-backed fact search and answer length

Everything here runs on the phone. Keys stay on the phone, each key is sent only to its own
provider's fixed base URL, and every origin is listed in `apps/g2-plugin/app.json`.

## Answer providers (Setup → Models → Answer provider)

| Profile id | Provider | Base URL | Key field | Models | Web search with sources |
|---|---|---|---|---|---|
| `openai-responses`, `openai-compatible` | OpenAI | `https://api.openai.com/v1` | OpenAI | OpenAI catalog | Responses `web_search` |
| `deepseek` | DeepSeek | `https://api.deepseek.com` | DeepSeek | `deepseek-flash`, `deepseek-v4-pro` | `deepseek_web_search` tool (beta, `deepseek-flash`) |
| `qwen` | Alibaba Qwen, Beijing | `https://dashscope.aliyuncs.com/compatible-mode/v1` | Qwen (DashScope) | `qwen3.7-plus`, `qwen3.8-flash`, `qwen4-max` | none (compatible mode returns no sources) |
| `qwen-intl` | Alibaba Qwen, Singapore | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` | Qwen (DashScope) | same | none |
| `zhipu` | Zhipu GLM, bigmodel.cn | `https://open.bigmodel.cn/api/paas/v4` | Zhipu | `glm-5.2`, `glm-5.3`, `glm-5-turbo`, `glm-5`, `glm-4.7`, `glm-4.7-flash` | Web Search API (`/web_search`, recency filter, publish dates) |
| `zai` | Zhipu GLM, Z.ai | `https://api.z.ai/api/paas/v4` | Zhipu | `glm-5.2`, `glm-5.3`, `glm-5`, `glm-4.7` | none verified |
| `moonshot` | Moonshot Kimi | `https://api.moonshot.ai/v1` | Moonshot | `kimi-k3.1-pro`, `kimi-k3` | none |

The non-OpenAI providers are called through Chat Completions (`packages/conversation-sdk/src/chat-providers.ts`).
Their differences are written down in `provider-registry.ts`:

- Thinking: DeepSeek and GLM send `thinking: { type: "disabled" }`, Qwen sends `enable_thinking: false`,
  Kimi K3 always reasons and gets `reasoning_effort: "low"`; GLM-5.3 cannot disable thinking. Always-reasoning
  models get the larger output budget.
- Output limit: `max_tokens`, except Kimi (`max_completion_tokens`); Zhipu gets at least 1024.
- Streaming usage: `stream_options: { include_usage: true }` for DeepSeek, Qwen and Kimi; Zhipu reports usage in the last chunk.
- Copilot analysis puts the schema in the prompt and the SDK validates every field as before. JSON mode
  (`response_format: { type: "json_object" }`) is sent to DeepSeek, Zhipu (bigmodel.cn) and Kimi, where it is
  documented; Qwen compatible mode and Z.ai get the prompt only.
- Cost: only DeepSeek publishes USD list prices (the peak rate is used, so estimates are an upper bound).
  Qwen, GLM and Kimi show "price n/a".

With a non-OpenAI provider selected:

- The OpenAI Responses API and the OpenAI model-list check are not used.
- OpenAI transcription profiles (Realtime, GPT Transcribe, Whisper) still need an OpenAI key. Without one, pick
  Deepgram or Soniox; Connect says so.
- The OpenAI knowledge base (vector store) and History → Generate summary keep using the OpenAI key. Without one,
  answers use the knowledge saved on the phone.

Qwen and Zhipu keys are region-bound: choose the profile that matches where the key was created.
Setup → API keys → "Test provider key" sends one tiny request to the selected provider.

## News-backed fact search

Fact checks are still opt-in: Knowledge → Memory → "Live web fact check" for the automatic lane, and the
Verify action for a single claim. New: Setup → Copilot → "Prefer latest news in fact checks" (`newsSearch`, on by default).

- The check prompt carries today's date and asks for the most recent reporting; a time-sensitive claim
  ("latest", "today", "just announced", 最新, 今天 …) is marked `recency: "news"` and searched news-first.
  With the Zhipu search such a claim uses `search_recency_filter: "oneMonth"` and widens once if nothing is found.
- Sources carry `publishedAt` when known. `dateSource: "search"` is the search engine's date (DeepSeek, Zhipu);
  `dateSource: "model"` is the date the model reported for a page it really cited (OpenAI has no date field).
  A verdict without a real source is still returned as "uncertain". DeepSeek exception: when its answer has no citation annotations,
  the first three results of the search it ran are attached as sources (searched, not necessarily cited).
- Where the search runs: the answer provider's own verified search; otherwise OpenAI web search when an OpenAI key
  is entered; otherwise nowhere. Setup shows which one applies, including "Web and news checks are off for this provider".
- Phone: Checks cards show the verdict, "latest news" and clickable, dated source chips. "via <provider>" appears only when a
  non-OpenAI answer provider is selected (a search route exists); the default OpenAI path sets no `via`.
- Glasses (ambient display): the verdict pops up as `CHECK` / `FACT CHECK`; a news-biased check reads `news check` and ends with one `Src: site · date · +n` line for the newest dated source. Answer length "Detailed" lets a pop-up cue use up to 6 pages instead of 3; answers always page in full.
  Glasses: unchanged lanes (a contradicted, sourced check appears as a correction).

Search cost: OpenAI bills per search plus tokens; DeepSeek counts results as input tokens; Zhipu bills per search in CNY.

## Answer length (Setup → How Helix should help → Answer length)

`answerLength`: `brief` | `standard` (default) | `detailed`.

| | Brief | Standard | Detailed |
|---|---|---|---|
| Live answer sentences | at most 2 | "Max answer sentences" (3) | limit raised to at least 6 (still "at most N") |
| Live answer output tokens (plain / reasoning model) | 300 / 1500 | 600 / 2000 | 1200 / 3000 |
| Copilot lookup / proposal sentences | 2 / 2 | 3 / 4 | 5 / 6 |
| Web-check verdict | one short sentence | one or two sentences | three or four sentences |
| Concept explanation | one short sentence | one or two sentences | two to four sentences |
| Auto-explained term (max characters) | one short sentence (200) | unchanged prompt (500) | two to four sentences (900) |

Standard sends exactly the prompts and limits used before the setting existed.

## Not verified on hardware

All of the above is covered by unit tests with mocked provider responses. No live request was made to DeepSeek,
Qwen, Zhipu or Moonshot, and nothing here was run on G2 glasses or inside the Even Realities app WebView.
