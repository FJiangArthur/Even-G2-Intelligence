/**
 * v0.16 phone: lines to say on the Q&A tab and in the peek strip, and the mixed-languages speech setting.
 * The vitest environment has no DOM, so these read the pure helpers, the markup string and the presentation.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CopilotSuggestion } from "@helix/conversation-sdk";
import { DEFAULT_CONFIG, speechLocale } from "../src/config";
import { ConversationPresentation } from "../src/presentation";
import { companionMarkup, panelSignature, speechLanguageFields, suggestionGroups, withSaidLines } from "../src/ui";

const at = "2026-11-23T10:00:00.000Z";
const uiSource = readFileSync(new URL("../src/ui.ts", import.meta.url), "utf8");
const suggestion = (id: string, question: string, extra: Partial<CopilotSuggestion> = {}): CopilotSuggestion => ({ id, question, why: "", createdAt: at, ...extra });
const line = suggestion("l1", "How does this differ from futurism: is planning also a way of leaving the present?", { kind: "say", why: "names a rival idea" });
const second = suggestion("l2", "Is attention to the senses a skill, or just a habit?", { kind: "say" });
const probe = suggestion("q1", "What was your own part?");

describe("v0.16 Q&A tab: lines to say", () => {
  it("heads a line to say 'Say next' and a tap marks it said instead of asking Helix", () => {
    for (const mode of ["general", "learning", "social", "partner"]) {
      const [group, ...rest] = suggestionGroups(mode, [line, second]);
      expect(rest).toEqual([]);
      expect(group!.heading).toBe("Say next");
      expect(group!.action).toBe("said");
      expect(group!.doneLabel).toBe("Said");
      expect(group!.tapLabel).toBe("Mark as said");
      expect(`${group!.note} ${group!.tapLabel}`).not.toMatch(/ask Helix/iu);
      expect(group!.note).toMatch(/hold or use Copy/u);
      expect(group!.items).toEqual([line, second]);
    }
    // Nothing yet in a mode that suggests lines: the empty panel names lines, not questions.
    expect(suggestionGroups("general", []).map(group => [group.heading, group.action])).toEqual([["Say next", "said"]]);
    expect(suggestionGroups("general", [])[0]!.empty).toMatch(/say/iu);
  });

  it("puts said lines last and keeps question groups for suggestions that are questions", () => {
    const said = { ...line, askedAt: at };
    expect(suggestionGroups("general", [said, second])[0]!.items).toEqual([second, said]);
    // A question left from before the mode changed keeps its own group and its ask behaviour.
    const groups = suggestionGroups("general", [line, probe]);
    expect(groups.map(group => group.heading)).toEqual(["Say next", "Ask them"]);
    expect(groups[1]!.action ?? "ask").toBe("ask");
    expect(groups[1]!.items).toEqual([probe]);
  });

  it("leaves Interviewer and Candidate as they were", () => {
    const theirs = suggestion("s3", "Why are you leaving?", { kind: "they-ask" }), mine = suggestion("s4", "How is on-call set up?", { kind: "ask-them" });
    expect(suggestionGroups("interviewer", [probe]).map(group => [group.heading, group.action ?? "ask", group.tapLabel])).toEqual([["Probes to ask", "ask", "Ask Helix"]]);
    expect(suggestionGroups("interviewer", []).map(group => group.heading)).toEqual(["Probes to ask"]);
    expect(suggestionGroups("interviewee", [theirs, mine]).map(group => [group.heading, group.action ?? "ask"])).toEqual([["They may ask", "ask"], ["Ask them", "ask"]]);
    expect(suggestionGroups("interviewee", []).map(group => group.heading)).toEqual(["They may ask", "Ask them"]);
    expect(suggestionGroups("technical", []).map(group => group.heading)).toEqual(["Probe"]);
  });

  it("a tap on a line is the 'said' action; long-press copy and the Copy button stay", () => {
    expect(uiSource).toContain('actionButton(group.action === "said" ? "said" : "ask"');
    expect(uiSource).toContain('button.dataset.longpress = "copy"');
    expect(uiSource).toContain('action === "said"');
    expect(uiSource).toContain("onSayLine");
  });

  it("withSaidLines marks tapped lines as said without touching the others", () => {
    const snapshot = new ConversationPresentation().snapshot();
    const marked = withSaidLines({ ...snapshot, suggestions: [line, second, probe] }, new Map([["l1", at]]));
    expect(marked.suggestions.map(item => item.askedAt)).toEqual([at, undefined, undefined]);
    // Nothing tapped: the same object, so nothing re-renders.
    const same = { ...snapshot, suggestions: [line] };
    expect(withSaidLines(same, new Map())).toBe(same);
    expect(panelSignature("qa", marked)).not.toBe(panelSignature("qa", { ...snapshot, suggestions: [line, second, probe] }));
  });
});

describe("v0.16 presentation: lines to say", () => {
  it("peeks a new line as 'Say next' and a question as 'Suggested question'", () => {
    const presentation = new ConversationPresentation();
    presentation.setSuggestions([line]);
    expect(presentation.snapshot().peek).toMatchObject({ id: "l1", tab: "qa", kind: "suggestion", title: "Say next", text: line.question });
    presentation.setSuggestions([line, probe]);
    expect(presentation.snapshot().peek).toMatchObject({ id: "q1", title: "Suggested question" });
  });

  it("markSuggestionSaid marks the line said and keeps it said when the list is sent again", () => {
    const presentation = new ConversationPresentation();
    presentation.setSuggestions([line, second]);
    expect(presentation.markSuggestionSaid("l1", at)).toBe(true);
    expect(presentation.snapshot().suggestions.map(item => [item.id, item.askedAt])).toEqual([["l1", at], ["l2", undefined]]);
    // The copilot does not know about the tap and sends the line again as open.
    const seq = presentation.snapshot().peek!.seq, unseen = presentation.snapshot().unseen.qa;
    presentation.setSuggestions([line, second]);
    expect(presentation.snapshot().suggestions.find(item => item.id === "l1")!.askedAt).toBe(at);
    expect(presentation.snapshot().peek!.seq, "a said line is not news").toBe(seq);
    expect(presentation.snapshot().unseen.qa).toBe(unseen);
    expect(presentation.markSuggestionSaid("missing")).toBe(false);
    expect(presentation.markSuggestionSaid("l1"), "already said").toBe(false);
  });

  it("a new session forgets which lines were said", () => {
    const presentation = new ConversationPresentation();
    presentation.setSuggestions([line]);
    presentation.markSuggestionSaid("l1", at);
    presentation.reset();
    presentation.setSuggestions([line]);
    expect(presentation.snapshot().suggestions[0]!.askedAt).toBeUndefined();
  });
});

describe("v0.16 Setup: speech language", () => {
  const markup = companionMarkup();
  it("has a mixed-languages switch beside the speech language", () => {
    expect(markup).toContain('id="speech-mixed"');
    expect(markup).toContain("Mixed languages (do not assume English)");
    expect(markup).toMatch(/<label for="locale">Speech language/u);
  });

  it("maps the saved locale to the switch and back", () => {
    expect(speechLanguageFields({ locale: "auto" })).toEqual({ mixed: true, language: DEFAULT_CONFIG.locale });
    expect(speechLanguageFields({ locale: "zh-CN" })).toEqual({ mixed: false, language: "zh-CN" });
    expect(speechLanguageFields({ locale: "en" })).toEqual({ mixed: false, language: "en" });
    expect(speechLocale(true, "zh-CN")).toBe("auto");
    expect(speechLocale(false, "zh-CN")).toBe("zh-CN");
    expect(uiSource).toContain('speechLocale(this.input("speech-mixed").checked, this.input("locale").value)');
  });
});
