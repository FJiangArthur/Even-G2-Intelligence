/**
 * Answer length (Setup → "Answer length"). One setting drives the prompt wording and the
 * output-token limits of every lane that writes prose for the wearer: live answers, copilot
 * lookups/proposals, web-check verdicts and concept explanations.
 *
 * "standard" reproduces the limits that were hard-coded before this setting existed
 * (sentence cap from the session prompt, 600/2000 answer tokens, 3-4 sentence lookups,
 * "one or two sentence" verdicts) and adds no prompt text, so existing behaviour is unchanged.
 */
export const ANSWER_LENGTHS = ["brief", "standard", "detailed"] as const;
export type AnswerLength = typeof ANSWER_LENGTHS[number];
export const DEFAULT_ANSWER_LENGTH: AnswerLength = "standard";

export interface AnswerLengthProfile {
  readonly id: AnswerLength;
  readonly label: string;
  /** One line for the Setup note. */
  readonly blurb: string;
  /** Extra answer-lane instruction ("" for standard). */
  readonly style: string;
  /** Output-token limit for a live answer: plain model / model that spends tokens on reasoning. */
  readonly answerTokens: number;
  readonly answerReasoningTokens: number;
  /** Copilot lookup / question sentences and proposal sentences. */
  readonly lookupSentences: number;
  readonly proposeSentences: number;
  readonly lookupTokens: number;
  readonly lookupReasoningTokens: number;
  /** Max characters kept from a lookup answer. */
  readonly lookupChars: number;
  /** Wording used inside the web-check prompt, e.g. "one or two sentence". */
  readonly verdictSentences: string;
  readonly verdictTokens: number;
  readonly verdictReasoningTokens: number;
  /** Wording used inside the copilot concept prompt, e.g. "one or two sentences". */
  readonly conceptSentences: string;
  /** The three labelled parts of an interviewer answer key (modes.ts answerKeyInput), sized for this length. */
  readonly answerKey: string;
}

/** An interviewer answer key is always three labelled sentences: "Strong answer:", "Probe:", "Flag:". */
export const ANSWER_KEY_SENTENCES = 3;

const PROFILES: Readonly<Record<AnswerLength, AnswerLengthProfile>> = Object.freeze({
  brief: Object.freeze({
    id: "brief", label: "Brief", blurb: "At most 2 sentences. Fastest to read on the glasses, lowest cost.",
    style: "Be as brief as possible: give the answer itself and stop. No background, caveats or examples unless they change the answer.",
    answerTokens: 300, answerReasoningTokens: 1500,
    lookupSentences: 2, proposeSentences: 2, lookupTokens: 250, lookupReasoningTokens: 1500, lookupChars: 600,
    verdictSentences: "one short sentence", verdictTokens: 350, verdictReasoningTokens: 1500,
    conceptSentences: "one short sentence",
    answerKey: '"Strong answer:" the 2 most important points a strong answer covers (semicolon-separated, a few words each), "Probe:" one follow-up question of at most 8 words, "Flag:" one red flag in a few words.',
  }),
  standard: Object.freeze({
    id: "standard", label: "Standard", blurb: "Your sentence limit (3 by default).",
    style: "",
    answerTokens: 600, answerReasoningTokens: 2000,
    lookupSentences: 3, proposeSentences: 4, lookupTokens: 400, lookupReasoningTokens: 2000, lookupChars: 1200,
    verdictSentences: "one or two sentence", verdictTokens: 500, verdictReasoningTokens: 2000,
    conceptSentences: "one or two sentences",
    answerKey: '"Strong answer:" the 2-4 points a strong answer covers (semicolon-separated), "Probe:" one follow-up question, "Flag:" one red flag to listen for.',
  }),
  detailed: Object.freeze({
    id: "detailed", label: "Detailed", blurb: "Up to 6 sentences or more (the sentence limit is raised to at least 6), with reasons, numbers or steps. Slower and costs more; the glasses page long answers.",
    style: "Give a fuller answer: the direct answer first, then the key reasons, numbers, steps or trade-offs that support it.",
    answerTokens: 1200, answerReasoningTokens: 3000,
    lookupSentences: 5, proposeSentences: 6, lookupTokens: 800, lookupReasoningTokens: 3000, lookupChars: 2400,
    verdictSentences: "three or four sentence", verdictTokens: 800, verdictReasoningTokens: 2500,
    conceptSentences: "two to four sentences",
    answerKey: '"Strong answer:" the 4-6 points a strong answer covers (semicolon-separated, each with the detail or number to listen for), "Probe:" one follow-up question and what it should reveal, "Flag:" one red flag and why it matters.',
  }),
});

/** Unknown or missing values fall back to standard (old configs, bad host callbacks). */
export function cleanAnswerLength(value: unknown): AnswerLength {
  return typeof value === "string" && (ANSWER_LENGTHS as readonly string[]).includes(value) ? value as AnswerLength : DEFAULT_ANSWER_LENGTH;
}

export function answerLengthProfile(value: unknown): AnswerLengthProfile { return PROFILES[cleanAnswerLength(value)]; }

/**
 * Sentence cap for a live answer. `base` is the session's "Max answer sentences" (1-10, default 3):
 * Standard uses it as-is, Brief caps it at 2, Detailed raises it to at least 6.
 * An interviewer answer key (`answerKey`) is never capped below its three labelled sentences;
 * Brief shortens the parts of the key instead (AnswerLengthProfile.answerKey).
 */
export function answerSentenceLimit(length: unknown, base: number | undefined, answerKey = false): number {
  const limit = Number.isInteger(base) && base! >= 1 ? Math.min(10, base!) : 3;
  const id = cleanAnswerLength(length);
  const capped = id === "brief" ? Math.min(limit, 2) : id === "detailed" ? Math.max(limit, 6) : limit;
  return answerKey ? Math.max(capped, ANSWER_KEY_SENTENCES) : capped;
}

/** Output-token limit for a live answer. */
export function answerLengthTokens(length: unknown, reasoning: boolean): number {
  const profile = answerLengthProfile(length);
  return reasoning ? profile.answerReasoningTokens : profile.answerTokens;
}
