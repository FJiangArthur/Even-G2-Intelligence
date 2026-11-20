import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CHAT_PROVIDER_IDS, DEFAULT_COPILOT_SETTINGS, PROVIDER_CREDENTIAL_NAMES, providerOrigins } from "@helix/conversation-sdk";
import {
  ANSWER_PROVIDERS,
  DEFAULT_CONFIG,
  copilotSettingsFromConfig,
  loadPersistedConfig,
  normalizePluginConfig,
  persistProviderCredentials,
  loadPersistedProviderCredentials,
  providerCredentialsForSession,
  providerCredentialsFromForm,
  savePersistedConfig,
  serializePersistedConfig,
  type SessionFormState,
} from "../src/config";
import { companionMarkup, modelForProvider, providerModelOptionsMarkup } from "../src/ui";
import { sourceDateLabel } from "../src/history-panel";
import { G2ConversationController } from "../src/controller";
import { ConversationPresentation } from "../src/presentation";
import type { GlassesRenderer } from "../src/glasses-renderer";

const form: SessionFormState = {
  ...DEFAULT_CONFIG, accessToken: "", openaiApiKey: "sk-openai-runtime", deepgramApiKey: "dg-runtime", sonioxApiKey: "", omiApiKey: "", saveApiKeysOnPhone: false,
  deepseekApiKey: "sk-deepseek-runtime", dashscopeApiKey: "sk-dashscope-runtime", zhipuApiKey: "zhipuid.zhipusecret", moonshotApiKey: "sk-moonshot-runtime",
  transcriptionProvider: "deepgram",
};
const manifest = JSON.parse(readFileSync(new URL("../app.json", import.meta.url), "utf8")) as { permissions: { name: string; whitelist?: string[] }[] };
const uiSource = readFileSync(new URL("../src/ui.ts", import.meta.url), "utf8");

describe("answer length setting", () => {
  it("defaults to standard, survives a round trip and rejects unknown values", async () => {
    expect(DEFAULT_CONFIG.answerLength).toBe("standard");
    expect(normalizePluginConfig({}).answerLength).toBe("standard");
    expect(normalizePluginConfig({ answerLength: "enormous" }).answerLength).toBe("standard");
    const values = new Map<string, string>();
    const store = { getLocalStorage: async (key: string) => values.get(key) ?? "", setLocalStorage: async (key: string, value: string) => { values.set(key, value); return true; } };
    await savePersistedConfig(store, { ...form, answerLength: "detailed" });
    await expect(loadPersistedConfig(store)).resolves.toMatchObject({ answerLength: "detailed", newsSearch: true });
  });
  it("reaches the copilot lane only when it is not standard", () => {
    expect(copilotSettingsFromConfig({ ...DEFAULT_CONFIG, answerLength: "brief" })).toEqual({ ...DEFAULT_COPILOT_SETTINGS, mode: "general", newsSearch: true, answerLength: "brief" });
    expect(copilotSettingsFromConfig({ ...DEFAULT_CONFIG, answerLength: "standard" })).not.toHaveProperty("answerLength");
  });
  it("is offered in Setup with Standard preselected", () => {
    const markup = companionMarkup();
    expect(markup).toMatch(/<select id="answer-length">\s*<option value="brief">Brief<\/option><option value="standard" selected>Standard<\/option><option value="detailed">Detailed<\/option>/u);
    expect(markup).toContain('id="answer-length-note"');
    expect(uiSource).toContain('answerLength: this.select("answer-length").value');
  });
});

describe("news search setting", () => {
  it("is on by default, can be turned off and old records load as on", async () => {
    expect(DEFAULT_CONFIG.newsSearch).toBe(true);
    expect(normalizePluginConfig({ newsSearch: false }).newsSearch).toBe(false);
    expect(normalizePluginConfig({ newsSearch: "yes" }).newsSearch).toBe(true);
    expect(copilotSettingsFromConfig({ ...DEFAULT_CONFIG, newsSearch: false })).not.toHaveProperty("newsSearch");
    await expect(loadPersistedConfig({ getLocalStorage: async () => JSON.stringify({ model: "gpt-4.1-mini" }), setLocalStorage: async () => true })).resolves.toMatchObject({ newsSearch: true, answerLength: "standard", liveWebFactCheck: false });
  });
  it("has a Setup toggle and a note that says where checks search", () => {
    const markup = companionMarkup();
    expect(markup).toContain('<input id="news-search" type="checkbox" />');
    expect(markup).toContain("Prefer latest news in fact checks");
    expect(markup).toContain('<p id="search-provider-note" class="field-note" role="status"></p>');
    expect(uiSource).toContain("searchAvailability(providerId, has)");
  });
  it("formats source dates for the citation chips", () => {
    expect(sourceDateLabel("2026-11-17")).toBe("17 Nov 2026");
    expect(sourceDateLabel("2026-01-05")).toBe("5 Jan 2026");
    for (const bad of [undefined, "", "Nov 17", "2026-13-01", "2026-11-17T08:00:00Z"]) expect(sourceDateLabel(bad)).toBeUndefined();
  });
});

describe("direct answer providers", () => {
  it("offers every SDK chat provider as an answer provider and whitelists its origin", () => {
    for (const id of CHAT_PROVIDER_IDS) expect(ANSWER_PROVIDERS).toContain(id);
    expect(normalizePluginConfig({ answerProvider: "deepseek" }).answerProvider).toBe("deepseek");
    expect(normalizePluginConfig({ answerProvider: "made-up" }).answerProvider).toBe("openai-responses");
    const whitelist = manifest.permissions.find(item => item.name === "network")!.whitelist!;
    for (const origin of providerOrigins()) expect(whitelist).toContain(origin);
    expect(whitelist).toEqual(expect.arrayContaining(["https://api.deepseek.com", "https://dashscope.aliyuncs.com", "https://dashscope-intl.aliyuncs.com", "https://open.bigmodel.cn", "https://api.z.ai", "https://api.moonshot.ai"]));
    expect(whitelist.every(origin => /^(?:https|wss):\/\/[a-z0-9.-]+$/u.test(origin))).toBe(true);
  });
  it("has a key field per provider and lists them in the Answer provider picker", () => {
    const markup = companionMarkup();
    for (const id of ["deepseek-api-key", "dashscope-api-key", "zhipu-api-key", "moonshot-api-key"]) {
      expect(markup).toMatch(new RegExp(`<input id="${id}" type="password" autocomplete="off"`, "u"));
    }
    for (const id of CHAT_PROVIDER_IDS) expect(markup).toContain(`<option value="${id}">`);
    expect(markup).toContain('<option value="openai-responses">OpenAI Responses</option>');
    expect(markup).toContain('id="test-provider-key"');
    // The provider key fields live in the group that is never persisted with settings.
    expect(markup.indexOf('id="deepseek-api-key"')).toBeGreaterThan(markup.indexOf('class="config-group provider-key-group"'));
    expect(markup.indexOf('id="moonshot-api-key"')).toBeLessThan(markup.indexOf('id="save-api-keys"'));
  });
  it("sends a provider key into a session only when that provider answers", () => {
    expect(providerCredentialsFromForm(form)).toEqual({ openai: "sk-openai-runtime", deepgram: "dg-runtime", deepseek: "sk-deepseek-runtime", dashscope: "sk-dashscope-runtime", zhipu: "zhipuid.zhipusecret", moonshot: "sk-moonshot-runtime" });
    expect(providerCredentialsForSession({ ...form, answerProvider: "openai-responses" })).toEqual({ openai: "sk-openai-runtime", deepgram: "dg-runtime" });
    expect(providerCredentialsForSession({ ...form, answerProvider: "deepseek" })).toEqual({ openai: "sk-openai-runtime", deepgram: "dg-runtime", deepseek: "sk-deepseek-runtime" });
    expect(providerCredentialsForSession({ ...form, answerProvider: "qwen-intl" })).toEqual({ openai: "sk-openai-runtime", deepgram: "dg-runtime", dashscope: "sk-dashscope-runtime" });
    expect(providerCredentialsForSession({ ...form, answerProvider: "zai", openaiApiKey: "" })).toEqual({ deepgram: "dg-runtime", zhipu: "zhipuid.zhipusecret" });
    expect(providerCredentialsForSession({ ...form, answerProvider: "moonshot", moonshotApiKey: "" })).toEqual({ openai: "sk-openai-runtime", deepgram: "dg-runtime" });
    for (const name of ["deepseek", "dashscope", "zhipu", "moonshot"]) expect(PROVIDER_CREDENTIAL_NAMES).toContain(name);
  });
  it("never writes provider keys into the settings record, and stores them only with the opt-in", async () => {
    const serialized = serializePersistedConfig({ ...form, answerProvider: "deepseek", model: "deepseek-flash", copilotModel: "deepseek-flash" });
    for (const secret of ["sk-deepseek-runtime", "sk-dashscope-runtime", "zhipuid.zhipusecret", "sk-moonshot-runtime", "ApiKey"]) expect(serialized).not.toContain(secret);
    expect(JSON.parse(serialized)).toMatchObject({ answerProvider: "deepseek", model: "deepseek-flash" });
    const values = new Map<string, string>();
    const store = { getLocalStorage: async (key: string) => values.get(key) ?? "", setLocalStorage: async (key: string, value: string) => { values.set(key, value); return true; } };
    await persistProviderCredentials(store, providerCredentialsFromForm(form), false);
    expect([...values.values()].join("")).toBe("");
    await persistProviderCredentials(store, providerCredentialsFromForm(form), true);
    await expect(loadPersistedProviderCredentials(store)).resolves.toMatchObject({ saveApiKeysOnPhone: true, credentials: { deepseek: "sk-deepseek-runtime", zhipu: "zhipuid.zhipusecret" } });
  });
  it("shows each provider's own models and falls back across providers", () => {
    const deepseek = providerModelOptionsMarkup("deepseek", "answer");
    expect(deepseek).toContain('<option value="deepseek-flash">'); expect(deepseek).toContain("Custom model id…"); expect(deepseek).not.toContain("gpt-");
    expect(providerModelOptionsMarkup("qwen", "copilot")).toContain('<option value="qwen3.8-flash">Qwen3.8 Flash · fast, low cost · default</option>');
    expect(providerModelOptionsMarkup("openai-responses", "answer")).toContain('<option value="gpt-6.1-terra">');
    expect(modelForProvider("deepseek", "gpt-6.1-terra", "answer")).toBe("deepseek-flash");
    expect(modelForProvider("openai-responses", "deepseek-flash", "answer")).toBe("gpt-6.1-terra");
    expect(modelForProvider("openai-compatible", "kimi-k3", "copilot")).toBe("gpt-6-luna");
    expect(modelForProvider("openai-responses", "gpt-6.2-custom", "answer")).toBe("gpt-6.2-custom");
    expect(modelForProvider("zhipu", "glm-5.3", "answer")).toBe("glm-5.3");
  });
  it("tests a provider key against that provider only", async () => {
    const bridge = { getLocalStorage: async () => "", setLocalStorage: async () => true, createStartUpPageContainer: async () => 0, textContainerUpgrade: async () => true,
      audioControl: async () => true, shutDownPageContainer: async () => true, onEvenHubEvent: () => () => undefined };
    const controller = new G2ConversationController(bridge as never, {} as GlassesRenderer, new ConversationPresentation());
    const calls: { url: string; auth: string; model: string }[] = [];
    controller.keyTestFetch = async (url, init) => {
      calls.push({ url, auth: (init!.headers as Record<string, string>).Authorization!, model: JSON.parse(init!.body as string).model });
      return Response.json({ choices: [{ message: { content: "OK" } }] });
    };
    // A leftover OpenAI model id is replaced by the provider default instead of being sent to Kimi.
    expect(await controller.testProviderKey("moonshot", "sk-moonshot-runtime", "gpt-6.1-terra")).toMatchObject({ status: "ok", model: "kimi-k3.1-pro" });
    expect(calls).toEqual([{ url: "https://api.moonshot.ai/v1/chat/completions", auth: "Bearer sk-moonshot-runtime", model: "kimi-k3.1-pro" }]);
    expect((await controller.testProviderKey("openai-responses", "sk-x", "gpt-6.1-terra")).status).toBe("error");
    expect(calls).toHaveLength(1);
  });
});
