/** Shared on-device question detection; no network or runtime dependency. */
import type { QuestionKind } from "./copilot-types.js";
import type { Speaker } from "./types.js";

/**
 * v0.8 question policy by speaker role. A question the wearer speaks ("self") is
 * the wearer asking the other party: it is shown ("ask") but never auto-answered.
 * Questions from others or unattributed speech are answered ("answer").
 */
export function questionKindFor(role: Speaker["role"] | undefined): Extract<QuestionKind, "answer" | "ask"> {
  return role === "self" ? "ask" : "answer";
}
export interface DetectedQuestion {
  readonly text: string;
  readonly sourceStart: number;
}

const QUESTION_START = String.raw`(?:who|what|when|where|why|which|whose|how|can|could|would|will|should|may|might|must|do|does|did|is|are|am|was|were|have|has|had|tell\s+me|explain|describe|walk\s+me\s+through|help\s+me\s+understand)`;
const DIRECT_QUESTION_START = /^(?:who|when|where|why|which|whose|tell\s+me|explain|describe|walk\s+me\s+through|help\s+me\s+understand)\b/iu;
const WHAT_QUESTION_START = /^what\s+(?!a\b|an\b)\S+/iu;
const HOW_QUESTION_START = /^how\s+(?:do|does|did|can|could|would|will|should|may|might|must|is|are|am|was|were|have|has|had|many|much|long|far|often|soon|old|big|small|fast|slow|well)\b/iu;
const MODAL_QUESTION_START = /^(?:can|could|would|will|should|may|might|must)\s+(?:i|you|we|they|he|she|it|this|that|these|those|there|someone|anyone|the|a|an|my|your|our|their|its)\b\s+\S+/iu;
const AUXILIARY_QUESTION_START = /^(?:do|does|did|is|are|am|was|were|have|has|had)\s+\S+\s+\S+/iu;
const CHINESE_QUESTION = /^(?:你能|你可以|您能|您可以|能否|可否|是否|为什么|为何|怎么|怎样|如何|什么|谁|哪(?:个|些|里)?|几|多少)|(?:吗|呢|么)[。！!\s]*$/u;
const ARABIC_QUESTION = /^(?:هل|ما|ماذا|من|متى|أين|لماذا|كيف|أي|أيمكن|يمكن\s+أن)(?:\s|$)/u;
const SPANISH_QUESTION = /^¿?\s*(?:puedes|podrías|podria|podriais|qué|que\s+|cómo|como\s+|por\s+qué|cuando|cuándo|donde|dónde|quién|quien|cuál|cual|cuánto|cuanto|es\s+|son\s+)/iu;
const JAPANESE_QUESTION = /^(?:なぜ|どう|何|いつ|どこ|誰|どれ|どの|できますか)|(?:ですか|ますか|でしょうか|できますか|なのか|だろうか)[。！!\s]*$/u;
const LEADING_FILLER = /^(?:(?:okay|ok|well|so|please|hey|um|uh|also|then)\b[,:]?\s*)+/i;
const QUESTION_MARKS = new Set(["?", "？", "؟"]);
const CLOSING_PUNCTUATION = new Set([
  '"', "'", "”", "’", "»", "›", ")", "]", "}", "）", "］", "｝", "】", "」", "』",
]);

interface Clause {
  readonly text: string;
  readonly start: number;
  readonly explicitQuestion: boolean;
  /** Split off after a conjunction ("... and have a long lead time"). */
  readonly continuation?: boolean;
}

function normalizeQuestion(text: string): string {
  const trimmed = text
    .replace(LEADING_FILLER, "")
    .replace(/^[,:;\-–—\s]+/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (endsWithQuestionMark(trimmed)) return trimmed;
  return `${trimmed.replace(/[.!;,\s]+$/, "")}?`;
}

function endsWithQuestionMark(value: string): boolean {
  const characters = Array.from(value.trimEnd());
  while (characters.length > 0 && CLOSING_PUNCTUATION.has(characters.at(-1) ?? "")) {
    characters.pop();
  }
  return QUESTION_MARKS.has(characters.at(-1) ?? "");
}

function canonicalQuestion(text: string): string {
  return text.normalize("NFKC").toLocaleLowerCase("en-US").replace(/[^\p{L}\p{N}]+/gu, "");
}

function looksLikeUnpunctuatedQuestion(text: string): boolean {
  const cleaned = text
    .replace(/^["'“‘「『（(\s]+/, "")
    .replace(LEADING_FILLER, "")
    .trim();
  if (
    DIRECT_QUESTION_START.test(cleaned)
    || WHAT_QUESTION_START.test(cleaned)
    || HOW_QUESTION_START.test(cleaned)
    || MODAL_QUESTION_START.test(cleaned)
    || AUXILIARY_QUESTION_START.test(cleaned)
  ) return true;
  return CHINESE_QUESTION.test(cleaned)
    || ARABIC_QUESTION.test(cleaned)
    || SPANISH_QUESTION.test(cleaned)
    || JAPANESE_QUESTION.test(cleaned);
}

function sentenceClauses(input: string): Clause[] {
  const clauses: Clause[] = [];
  const sentencePattern = /[^?？؟!.。！;\n]+[?？؟!.。！;]?["'”’»›)\]}）］｝】」』]*/gu;

  for (const sentenceMatch of input.matchAll(sentencePattern)) {
    const sentence = sentenceMatch[0];
    const sentenceStart = sentenceMatch.index;
    const explicitQuestion = endsWithQuestionMark(sentence);
    const sentenceParts: Omit<Clause, "explicitQuestion">[] = [];
    const splitPattern = new RegExp(
      String.raw`(?:,\s+(?:(?:and|also|then)\s+)?|\s+(?:and|also|then)\s+)(?=${QUESTION_START}\b)`,
      "gi",
    );
    let localStart = 0;

    for (const split of sentence.matchAll(splitPattern)) {
      const splitStart = split.index;
      const before = sentence.slice(localStart, splitStart);
      if (before.trim() !== "") {
        sentenceParts.push({ text: before, start: sentenceStart + localStart });
      }
      localStart = splitStart + split[0].length;
    }

    const remainder = sentence.slice(localStart);
    if (remainder.trim() !== "") {
      sentenceParts.push({ text: remainder, start: sentenceStart + localStart });
    }
    for (const [index, part] of sentenceParts.entries()) {
      clauses.push({
        ...part,
        explicitQuestion: explicitQuestion && index === sentenceParts.length - 1,
        continuation: index > 0,
      });
    }
  }
  return clauses;
}

/**
 * Finds at most three speakable questions without an LLM round trip. The
 * detector deliberately favors recall for explicit questions and common
 * spoken interrogative forms, while preserving their source order.
 */
export function extractQuestions(input: string, limit = 3): DetectedQuestion[] {
  if (!Number.isInteger(limit) || limit < 0) {
    throw new RangeError("limit must be a non-negative integer");
  }
  if (limit === 0) return [];

  // Preserve the user's visible punctuation and script; normalize only the
  // private dedupe key so Arabic/CJK question marks survive presentation.
  const normalizedInput = input.replace(/\s+/g, " ").trim();
  if (normalizedInput === "") return [];

  const questions: DetectedQuestion[] = [];
  const seen = new Set<string>();
  for (const clause of sentenceClauses(normalizedInput)) {
    const cleaned = clause.text.replace(LEADING_FILLER, "").trim();
    if (!clause.explicitQuestion && !looksLikeUnpunctuatedQuestion(cleaned)) continue;
    // "X is hard to order and have a long lead time." is a statement: a bare
    // auxiliary after a conjunction continues the predicate, it is not a new question.
    if (!clause.explicitQuestion && clause.continuation && AUXILIARY_QUESTION_START.test(cleaned)
      && !/^(?:do|does|did|is|are|am|was|were|have|has|had)\s+(?:i|you|we|they|he|she|it|this|that|there)\b/iu.test(cleaned)) continue;

    const question = normalizeQuestion(cleaned);
    if (question.length < 5 || question.length > 320) continue;

    const canonical = canonicalQuestion(question);
    if (canonical.length < 3 || seen.has(canonical)) continue;

    seen.add(canonical);
    questions.push({ text: question, sourceStart: clause.start });
    if (questions.length === limit) break;
  }

  return questions;
}

const WEB_LOOKUP = new RegExp([
  String.raw`\blead[\s-]?times?\b`, String.raw`\bprices?\b`, String.raw`\bpricing\b`, String.raw`\bcosts?\b`, String.raw`\bhow\s+much\s+(?:is|are|does|do|would|will|did)\b`,
  String.raw`\bavailab(?:le|ility)\b`, String.raw`\bin\s+stock\b`, String.raw`\bstock\s+(?:price|level|status)s?\b`, String.raw`\bout\s+of\s+stock\b`, String.raw`\bback-?order`,
  String.raw`\blatest\b`, String.raw`\bnewest\b`, String.raw`\bcurrent(?:ly)?\b`, String.raw`\bright\s+now\b`, String.raw`\btoday'?s?\b`, String.raw`\bthis\s+(?:week|month|quarter|year)\b`,
  String.raw`\brelease\s+dates?\b`, String.raw`\breleased\b`, String.raw`\bship(?:s|ping|ped)?\b`, String.raw`\bdeliver(?:y|ies)\s+times?\b`,
  String.raw`\bexchange\s+rates?\b`, String.raw`\bweather\b`, String.raw`\bnews\b`, String.raw`\bas\s+of\b`, String.raw`\b20[2-3]\d\b`,
  "价格", "多少钱", "交货期", "货期", "交期", "最新", "现在", "目前", "库存", "发布(?:日期|时间)", "上市", "汇率",
].join("|"), "iu");
const CONVERSATION_REFERENCE = /\b(?:said|mentioned|told\s+(?:us|me|you|them))\b|\bdid\s+\S+\s+(?:say|mention)\b|\b(?:earlier|in\s+this\s+(?:meeting|call|conversation))\b|刚才|之前说/iu;

/**
 * Heuristic for time-sensitive or public-lookup requests (lead times, prices,
 * availability, release dates, "right now"). True means a web-grounded answer
 * is worth its cost; questions about what was said in the conversation are false.
 */
export function needsWebLookup(text: string): boolean {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length < 4 || compact.length > 4000) return false;
  if (CONVERSATION_REFERENCE.test(compact)) return false;
  return WEB_LOOKUP.test(compact);
}
