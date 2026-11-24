/** v0.16 fix pass (phone side): base prompt default and its migration, and the language kept behind "Mixed languages". */
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_CONFIG, LEGACY_DEFAULT_INSTRUCTIONS, loadPersistedConfig, normalizePluginConfig, serializePersistedConfig, shownSpeechLanguage, speechLanguageSettings,
  type SessionFormState,
} from "../src/config";
import { speechLanguageFields } from "../src/ui";

const form: SessionFormState = { ...DEFAULT_CONFIG, accessToken: "", openaiApiKey: "", deepgramApiKey: "", sonioxApiKey: "", omiApiKey: "", saveApiKeysOnPhone: false };

describe("base prompt (v0.16)", () => {
  it("the default is about facts and names no detected question", () => {
    expect(DEFAULT_CONFIG.instructions).not.toMatch(/uncertain/iu);
    expect(DEFAULT_CONFIG.instructions).not.toMatch(/detected question/iu);
    expect(DEFAULT_CONFIG.instructions).toMatch(/Never invent facts/u);
    expect(DEFAULT_CONFIG.instructions).not.toBe(LEGACY_DEFAULT_INSTRUCTIONS);
    expect(LEGACY_DEFAULT_INSTRUCTIONS).toBe("Answer the detected question directly and concisely. Preserve uncertainty and prefer useful next actions.");
  });
  it("the prompt version is bumped", () => {
    expect(DEFAULT_CONFIG.promptVersion).toBe("2");
    expect(normalizePluginConfig({}).promptVersion).toBe("2");
  });
  it("a saved config with the old default moves to the new default and version", async () => {
    const saved = { ...DEFAULT_CONFIG, instructions: LEGACY_DEFAULT_INSTRUCTIONS, promptVersion: "1" };
    expect(normalizePluginConfig(saved)).toMatchObject({ instructions: DEFAULT_CONFIG.instructions, promptVersion: "2" });
    const store = { getLocalStorage: vi.fn(async () => JSON.stringify(saved)), setLocalStorage: vi.fn(async () => true) };
    await expect(loadPersistedConfig(store)).resolves.toMatchObject({ instructions: DEFAULT_CONFIG.instructions, promptVersion: "2" });
  });
  it("a prompt the user wrote is kept; the built-in version still moves", () => {
    const mine = "Answer like a patent attorney. Preserve uncertainty.";
    expect(normalizePluginConfig({ ...DEFAULT_CONFIG, instructions: mine, promptVersion: "1" })).toMatchObject({ instructions: mine, promptVersion: "2" });
  });
  it("a host's own prompt id and version are kept", () => {
    expect(normalizePluginConfig({ ...DEFAULT_CONFIG, promptId: "direct", promptVersion: "1" })).toMatchObject({ promptId: "direct", promptVersion: "1" });
    expect(normalizePluginConfig({ ...DEFAULT_CONFIG, promptVersion: "4" }).promptVersion).toBe("4");
  });
});

describe("the language behind Mixed languages", () => {
  it("turning the switch on keeps the language that was set", () => {
    expect(speechLanguageSettings(true, "zh-CN")).toEqual({ locale: "auto", speechLanguage: "zh-CN" });
    expect(speechLanguageSettings(true, "")).toEqual({ locale: "auto" });
    expect(speechLanguageSettings(true, "auto")).toEqual({ locale: "auto" });
    expect(speechLanguageSettings(false, " ko ")).toEqual({ locale: "ko" });
    expect(speechLanguageSettings(false, "")).toEqual({ locale: "en" });
  });
  it("on, save, load, off: the user is back on their own language, not English", () => {
    // zh-CN is set; the user turns Mixed languages on and the form is saved.
    const saved = JSON.parse(serializePersistedConfig({ ...form, ...speechLanguageSettings(true, "zh-CN") })) as Record<string, unknown>;
    expect(saved).toMatchObject({ locale: "auto", speechLanguage: "zh-CN" });
    const loaded = normalizePluginConfig(saved);
    expect(loaded).toMatchObject({ locale: "auto", speechLanguage: "zh-CN" });
    // The Setup field shows it (disabled) while mixed is on.
    expect(speechLanguageFields(loaded)).toEqual({ mixed: true, language: "zh-CN" });
    expect(shownSpeechLanguage(loaded)).toBe("zh-CN");
    // Switch off: the field's value is stored as the locale again.
    const { speechLanguage: _kept, ...rest } = loaded;
    const off = normalizePluginConfig({ ...rest, ...speechLanguageSettings(false, speechLanguageFields(loaded).language) });
    expect(off.locale).toBe("zh-CN");
    expect("speechLanguage" in off).toBe(false);
  });
  it("the kept language is dropped when a single language is pinned, and never holds 'auto'", () => {
    expect("speechLanguage" in normalizePluginConfig({ locale: "ko", speechLanguage: "zh-CN" })).toBe(false);
    expect("speechLanguage" in normalizePluginConfig({ locale: "auto", speechLanguage: "AUTO" })).toBe(false);
    expect("speechLanguage" in normalizePluginConfig({ locale: "auto", speechLanguage: 7 })).toBe(false);
    expect(speechLanguageFields({ locale: "auto" })).toEqual({ mixed: true, language: "en" });
    expect("speechLanguage" in DEFAULT_CONFIG).toBe(false);
  });
  it("is checked for credentials like the other saved text", () => {
    const secret = ["sk", "proj", "abcdefghijklmnopqrstuvwxyz012345"].join("-");
    expect(() => serializePersistedConfig({ ...form, locale: "auto", speechLanguage: secret })).toThrow("speechLanguage looks like a credential");
  });
});
