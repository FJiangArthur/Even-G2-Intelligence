import { describe, expect, it, vi } from "vitest";
import { realtimeSessionConfig } from "@helix/conversation-sdk";
import {
  DEFAULT_CONFIG, SPEECH_LANGUAGE_AUTO, isMixedSpeechLanguage, loadPersistedConfig, normalizePluginConfig, pinnedSpeechLanguage, speechLocale,
} from "../src/config";

describe("speech language setting (v0.16)", () => {
  it("the default is unchanged: recognition pinned to English", () => {
    expect(DEFAULT_CONFIG.locale).toBe("en");
    expect(normalizePluginConfig({}).locale).toBe("en");
    expect(isMixedSpeechLanguage(DEFAULT_CONFIG)).toBe(false);
  });
  it("auto is the mixed-languages value, stored in one spelling", () => {
    expect(SPEECH_LANGUAGE_AUTO).toBe("auto");
    for (const value of ["auto", "AUTO", " Auto "]) {
      expect(normalizePluginConfig({ locale: value }).locale).toBe("auto");
      expect(isMixedSpeechLanguage(value)).toBe(true);
    }
    expect(isMixedSpeechLanguage(normalizePluginConfig({ locale: "auto" }))).toBe(true);
    expect(isMixedSpeechLanguage("zh-CN")).toBe(false);
    expect(isMixedSpeechLanguage(undefined)).toBe(false);
    expect(normalizePluginConfig({ locale: "zh-CN" }).locale).toBe("zh-CN");
  });
  it("speechLocale gives the locale to store for the switch", () => {
    expect(speechLocale(true)).toBe("auto");
    expect(speechLocale(true, "ko")).toBe("auto");
    expect(speechLocale(false, "ko")).toBe("ko");
    expect(speechLocale(false, " zh-CN ")).toBe("zh-CN");
    // Switched off with nothing typed, or with "auto" still in the field: back to the default language.
    expect(speechLocale(false)).toBe("en");
    expect(speechLocale(false, "")).toBe("en");
    expect(speechLocale(false, "auto")).toBe("en");
  });
  it("pinnedSpeechLanguage is undefined when mixed languages is on", () => {
    expect(pinnedSpeechLanguage({ locale: "auto" })).toBeUndefined();
    expect(pinnedSpeechLanguage({ locale: "en" })).toBe("en");
    expect(pinnedSpeechLanguage({ locale: "ko-KR" })).toBe("ko-KR");
  });
  it("auto survives a save and load", async () => {
    const store = { getLocalStorage: vi.fn(async () => JSON.stringify({ ...DEFAULT_CONFIG, locale: "Auto" })), setLocalStorage: vi.fn(async () => true) };
    await expect(loadPersistedConfig(store)).resolves.toMatchObject({ locale: "auto" });
  });
  it("the stored value leaves realtime recognition unpinned; a language pins it", () => {
    const languages = (locale: string) => (realtimeSessionConfig(undefined, locale) as { audio: { input: { transcription: { languages?: string[] } } } }).audio.input.transcription.languages;
    expect(languages(normalizePluginConfig({ locale: "AUTO" }).locale)).toBeUndefined();
    expect(languages(DEFAULT_CONFIG.locale)).toEqual(["en"]);
  });
});
