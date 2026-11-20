import { afterEach, describe, expect, it, vi } from "vitest";
import { AnswerPager, paginateAnswer, pageReadingMs } from "../src/answer-pager";
import { buildGlassesDashboard, formatGlassesState } from "../src/glasses-renderer";

afterEach(() => vi.useRealTimers());

describe("answer-only layout", () => {
  it("keeps all non-answer states visually blank and dedicates the canvas to answers", () => {
    expect(formatGlassesState({ status: "listening", transcript: { text: "private transcript", final: false } })).toBe("");
    const [panel] = buildGlassesDashboard({ status: "listening", answer: { text: "Answer", streaming: true } });
    expect(panel).toMatchObject({ width: 568, height: 280, borderWidth: 0, paddingLength: 0, isEventCapture: 1 });
  });

  it("preserves every grapheme without ellipses and uses calibrated full-width wrapping", () => {
    const input = ("Full width English sentence with an answer. 你好世界 é 👨‍👩‍👧‍👦\n").repeat(40);
    const pages = paginateAnswer(input);
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.join("")).toBe(input);
    expect(pages.some(page => page.includes("…"))).toBe(false);
    expect(paginateAnswer("中".repeat(600)).every(page => [...page].length <= 270)).toBe(true);
    expect(paginateAnswer("The full width answer uses the native proportional font. ".repeat(30))[0]!.length).toBeGreaterThan(450);
    expect(pages.every(page => !page.startsWith("\u0301") && !page.startsWith("\u200d"))).toBe(true);
    const emojiPages = paginateAnswer("👨‍👩‍👧‍👦".repeat(200));
    expect(emojiPages.every(page => new TextEncoder().encode(page).length <= 950)).toBe(true);
    expect(emojiPages.join("")).toBe("👨‍👩‍👧‍👦".repeat(200));
    expect([pageReadingMs(10), pageReadingMs(100), pageReadingMs(500)]).toEqual([3000, 4500, 10000]);
  });
});

describe("answer reading lifecycle", () => {
  it("does not rewind when final provider completion trims stream whitespace", () => {
    vi.useFakeTimers();
    const pager = new AnswerPager(vi.fn());
    const text = "Answer with detail. ".repeat(80);
    pager.update({ id: "a", text: "\n" + text, streaming: true });
    vi.advanceTimersByTime(10000);
    expect(pager.pageIndex).toBe(1);
    const visible = pager.text;
    pager.update({ id: "a", text: text.trim(), streaming: false });
    expect(pager.pageIndex).toBe(1);
    expect(pager.text).toBe(visible);
    pager.dispose();
  });
  it("advances without rewinding or resetting on append, then hides the final page", () => {
    vi.useFakeTimers();
    const changed = vi.fn();
    const pager = new AnswerPager(changed);
    const text = "Beginning of answer. ".repeat(90) + "Final tail.";
    pager.update({ id: "a", text, streaming: true });
    const first = pager.text;
    vi.advanceTimersByTime(9999);
    pager.update({ id: "a", text: text + " More tokens.", streaming: true });
    expect(pager.text).toBe(first);
    vi.advanceTimersByTime(1);
    expect(pager.pageIndex).toBe(1);
    const second = pager.text;
    pager.update({ id: "a", text: text + " More tokens. Completed.", streaming: false });
    expect(pager.text).toBe(second);
    vi.advanceTimersByTime(100000);
    expect(pager.text).toBe("");
    pager.update({ id: "a", text: text + " More tokens. Completed.", streaming: false });
    expect(pager.text).toBe("");
    expect(vi.getTimerCount()).toBe(0);
    pager.dispose();
  });

  it("gives a completed final page eight seconds and cancels replacement/reset/disposal timers", () => {
    vi.useFakeTimers();
    const pager = new AnswerPager(vi.fn());
    pager.update({ id: "a", text: "Old answer", streaming: false });
    vi.advanceTimersByTime(7000);
    pager.update({ id: "b", text: "New answer", streaming: false });
    vi.advanceTimersByTime(7999);
    expect(pager.text).toBe("New answer");
    vi.advanceTimersByTime(1);
    expect(pager.text).toBe("");
    pager.update({ id: "c", text: "Pending", streaming: true });
    pager.update(undefined);
    expect(pager.text).toBe("");
    expect(vi.getTimerCount()).toBe(0);
    pager.update({ id: "d", text: "Done", streaming: false });
    pager.dispose();
    expect(pager.text).toBe("");
    expect(vi.getTimerCount()).toBe(0);
  });
});
