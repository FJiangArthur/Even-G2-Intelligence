import type { NoteCandidate, NoteProvenance } from "./types.js";
import { extractQuestions } from "./questions.js";

export type NoteRejectionReason =
  | "empty"
  | "uncertain"
  | "sensitive"
  | "canned-error"
  | "not-useful"
  | "question-like"
  | "duplicate";

export type NoteDecision =
  | { readonly accepted: true; readonly proposal: NoteCandidate }
  | { readonly accepted: false; readonly reasons: readonly NoteRejectionReason[] };

export interface NoteEvaluationInput {
  readonly id: string;
  readonly content: string;
  readonly provenance: NoteProvenance;
  readonly existingNotes?: readonly string[];
}

const UNCERTAINTY_PATTERNS = [
  /\b(?:i(?:'m| am) not sure|i do not know|i don't know)\b/i,
  /\b(?:maybe|perhaps|possibly|probably|apparently|presumably)\b/i,
  /\b(?:might|may or may not|cannot verify|can't verify|unverified|uncertain)\b/i,
  /\b(?:i think|i believe|it seems|it appears)\b/i,
];

const SENSITIVE_PATTERNS = [
  /\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|passcode|secret)\b\s*[:=]/i,
  /\bsk-[A-Za-z0-9_-]{12,}\b/,
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/,
  /\b\d{3}-\d{2}-\d{4}\b/,
  /\b(?:\d[ -]*?){13,19}\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\b(?:diagnosed with|medical record|prescription for)\b/i,
];

const QUESTION_OPENING = /^(?:who|what|when|where|why|which|whose|how|can|could|would|will|should|may|might|must|do|does|did|is|are|am|was|were|have|has|had)\b/i;
const CANNED_ERROR_PATTERNS = [
  /^(?:i(?:'m| am)\s+)?sorry[,. ]+(?:something|an error|i (?:cannot|can't|couldn't|was unable))/i,
  /\b(?:something went wrong|please try again|request (?:failed|timed out)|service (?:is )?unavailable)\b/i,
  /^(?:i (?:cannot|can't|couldn't)|unable to) (?:answer|help|complete|process)\b/i,
];
const USEFUL_MEMORY_PATTERNS = [
  /\b(?:decision|decided|agreed|commit(?:ted|ment)?|next step|action item|follow[- ]?up|owner|deadline|due date|launch date|ship date)\b/i,
  /\b(?:requirement|requires|required|preference|prefers?|risk|blocker|blocked|trade-?off|priority)\b/i,
  /\b(?:we|i|the team|the project)\s+(?:will|must|need(?:s)? to|plan(?:s)? to|intend(?:s)? to)\b/i,
];

function canonicalize(content: string): string {
  return content
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function tokenSimilarity(left: string, right: string): number {
  if (left === right) return 1;
  const leftTokens = new Set(left.split(" ").filter(Boolean));
  const rightTokens = new Set(right.split(" ").filter(Boolean));
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;

  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) intersection += 1;
  }
  const union = leftTokens.size + rightTokens.size - intersection;
  return intersection / union;
}

/**
 * Produces a note proposal only when the assistant output is sufficiently
 * definite and safe. Rejections are intentional, typed, and deterministic.
 */
export function evaluateAutomaticNote(input: NoteEvaluationInput): NoteDecision {
  const content = input.content.replace(/\s+/g, " ").trim();
  const reasons: NoteRejectionReason[] = [];

  if (content.length < 8) reasons.push("empty");
  if (UNCERTAINTY_PATTERNS.some((pattern) => pattern.test(content))) reasons.push("uncertain");
  if (SENSITIVE_PATTERNS.some((pattern) => pattern.test(content))) reasons.push("sensitive");
  if (CANNED_ERROR_PATTERNS.some((pattern) => pattern.test(content))) reasons.push("canned-error");
  if (!USEFUL_MEMORY_PATTERNS.some((pattern) => pattern.test(content))) reasons.push("not-useful");
  if (extractQuestions(content, 1).length > 0 || QUESTION_OPENING.test(content)) reasons.push("question-like");

  const canonical = canonicalize(content);
  if ((input.existingNotes ?? []).some((note) => tokenSimilarity(canonical, canonicalize(note)) >= 0.88)) {
    reasons.push("duplicate");
  }

  if (reasons.length > 0) {
    return { accepted: false, reasons: [...new Set(reasons)] };
  }

  return {
    accepted: true,
    proposal: {
      id: input.id,
      text: content,
      provenance: input.provenance,
    },
  };
}
