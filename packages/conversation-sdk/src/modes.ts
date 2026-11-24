import type { ConversationMode, ResponseStrategy } from "./types.js";
import { answerLengthProfile } from "./answer-length.js";

/**
 * v0.10 mode profiles: one place that says how Helix behaves in each kind of conversation.
 * `answer` steers the answer lane, `copilot`/`suggestions`/`summary` steer the background copilot,
 * `presets` are the feature toggles a mode switch applies (the user can still change them after).
 */
export interface ModePresets {
  readonly summarize: boolean; readonly concepts: boolean; readonly conflicts: boolean; readonly suggestions: boolean;
  readonly implicitAsks: boolean; readonly webGrounding: boolean; readonly claims: boolean; readonly people: boolean;
  /** Auto-answer detected questions (others' questions; the interviewer's own ones as an answer key). */
  readonly autoAnswer: boolean;
  readonly responseStrategy: ResponseStrategy;
  /** Notes mode: the copilot lane maintains the session to-do list and running notes. */
  readonly noteTaking?: boolean;
}
export interface ModeProfile {
  readonly id: ConversationMode;
  /** Phone label. */
  readonly label: string;
  /** Glasses status tag (<= 6 chars). */
  readonly short: string;
  /** One line on the phone mode picker. */
  readonly blurb: string;
  readonly answer: string;
  /** Extra copilot guidance (fairness, tone, what matters). Empty for the default meeting behaviour. */
  readonly copilot: string;
  /** What suggestedQuestions mean in this mode. */
  readonly suggestions: string;
  /** Summary focus. */
  readonly summary: string;
  /** Glasses label of the suggestions view. */
  readonly askLabel: string;
  /** The wearer's own spoken questions: never answered, or answered as an interviewer's answer key. */
  readonly selfQuestions: "ignore" | "answer-key";
  readonly presets: ModePresets;
  /** False for legacy modes kept only for stored settings and the gateway protocol. */
  readonly picker: boolean;
  /**
   * A rule that stays in the answer prompt when the user replaces the mode prompt with their own
   * (Interviewer fairness, Candidate honesty). The built-in `answer` already states it.
   */
  readonly guard?: string;
  /**
   * True when suggestions come in two kinds (CopilotSuggestion.kind): questions the other side may
   * ask next and questions the wearer could ask. Other modes only have the second kind.
   */
  readonly suggestionKinds?: boolean;
  /**
   * v0.16. True when this mode's suggestions are lines to say (CopilotSuggestion.kind "say") rather
   * than questions to ask: Meeting, Learning, Social and Partner. Never together with suggestionKinds.
   */
  readonly sayLines?: boolean;
}

/** The two kinds of suggestion in Candidate mode, with the panel heading for each. */
export const SUGGESTION_KINDS = ["they-ask", "ask-them"] as const;
export type SuggestionKind = typeof SUGGESTION_KINDS[number];
export const SUGGESTION_KIND_LABELS: Readonly<Record<SuggestionKind, string>> = Object.freeze({ "they-ask": "They may ask", "ask-them": "Ask them" });

const INTERVIEWER_GUARD = "Judge only job-relevant evidence; never comment on age, gender, race, religion, disability, family, nationality, accent or other protected characteristics.";
const CANDIDATE_GUARD = "Never invent experience, employers, numbers or titles for the wearer; when the saved knowledge has nothing relevant, give a truthful structure (what to cover) instead of made-up specifics.";

const DEFAULT_SUGGESTIONS = "at most 5 useful questions the WEARER could ask the other party next, phrased exactly as the wearer would say them aloud to that person (e.g. 'What lead time are you seeing for the Jetson boards?'), spanning the whole conversation, each with a short why. Never questions for the wearer to answer, and never questions that were already asked or answered in the conversation.";
/**
 * v0.16 suggestions of the sayLines modes: lines the wearer can read aloud, not questions about the talk.
 * `flavour` is the mode's tone. Field names are unchanged: `question` holds the line.
 */
const sayLines = (flavour: string): string => `at most 3 lines the WEARER can say next, each written to be read aloud word for word, in the language being spoken. ${flavour} A line may be a sharp question, a comparison with a named idea, a counterpoint, an example, or a connection to something said earlier. Engage with the substance like a well-read participant and name the idea (e.g. in a talk about being present: 'How does this differ from futurism: is planning for the future also a way of leaving the present?'). Each line is one or two complete sentences, with no label, no quotation marks and no preamble such as 'you could say'. Never a question about the transcript or the audio, never a request to repeat or clarify, and never something that was already said. The field question holds the line; why is at most 8 words on what the line adds.`;

/**
 * v0.16 speech-recognition rule, in both the answer prompt and the copilot prompt: garbled or cut-off
 * speech is read for its most likely meaning and never commented on.
 */
export const SPEECH_RECOGNITION_RULE = "The conversation text comes from live speech recognition and may contain wrong words, mixed languages and cut-off sentences. Infer the most likely meaning silently. Never mention the transcript, speech recognition, missing words or unclear audio, and never ask the wearer to clarify or repeat. If the meaning cannot be recovered, respond to the topic of the surrounding conversation.";
/** v0.16: answers and lines follow the language being spoken, in both prompts. */
export const SPOKEN_LANGUAGE_RULE = "Write in the language being spoken in the conversation; when languages are mixed, use the language of the most recent speech.";
/** Uncertainty is for facts. Garbled speech is covered by SPEECH_RECOGNITION_RULE and is never reported. */
const FACTS_RULE = "When a fact is not known, say so briefly instead of inventing it; this is about facts, never about unclear or unfinished speech.";

const ALL_ON: ModePresets = Object.freeze({ summarize: true, concepts: true, conflicts: true, suggestions: true, implicitAsks: true, webGrounding: true, claims: true, people: true, autoAnswer: true, responseStrategy: "reactive" });

const profile = (value: Omit<ModeProfile, "picker" | "selfQuestions" | "copilot" | "suggestions" | "guard" | "suggestionKinds" | "sayLines"> & Partial<Pick<ModeProfile, "picker" | "selfQuestions" | "copilot" | "suggestions" | "guard" | "suggestionKinds" | "sayLines">>): ModeProfile =>
  Object.freeze({ picker: true, selfQuestions: "ignore", copilot: "", suggestions: DEFAULT_SUGGESTIONS, ...value });

export const MODE_PROFILES: Readonly<Record<ConversationMode, ModeProfile>> = Object.freeze({
  general: profile({
    id: "general", label: "Meeting", short: "MEET", askLabel: "ASK THEM",
    blurb: "Decisions, owners, numbers and the questions worth asking.",
    answer: "Be a concise, practical meeting assistant. Prioritize a direct answer, then the decision, owner, risk or next step it implies.",
    suggestions: sayLines("In a meeting or a talk the lines move the discussion forward: the decision, owner, number or risk that is still open, or the idea worth testing."),
    summary: "decisions, owners, numbers, dates and open issues",
    presets: ALL_ON, sayLines: true,
  }),
  technical: profile({
    id: "technical", label: "Technical", short: "TECH", askLabel: "PROBE",
    blurb: "Specs, trade-offs and sharp follow-ups for engineering talks.",
    answer: "Support a technical discussion as a senior engineer would. Answer precisely with concrete numbers, units, versions and the key assumption; name the main trade-off or failure mode. Prefer a specific recommendation over a survey; say plainly when something depends on unknowns.",
    copilot: "This is a technical discussion. Prefer precise engineering content: specs, numbers, interfaces, versions, constraints.",
    suggestions: "at most 5 sharp technical follow-up questions the WEARER could ask next, phrased as they would say them aloud: assumptions, numbers and units, scaling limits, failure modes, edge cases, trade-offs, interfaces and test evidence. Each with a short why. Never questions already asked or answered.",
    summary: "technical decisions, specs and numbers, open design questions, risks and owners",
    presets: ALL_ON,
  }),
  interviewer: profile({
    id: "interviewer", label: "Interviewer", short: "INTVW", askLabel: "PROBE", selfQuestions: "answer-key",
    blurb: "You run the interview: answer keys for your questions, probes, and evidence on the candidate.",
    // v0.16: the answer-key format is asked for only by an ANSWER KEY request (answerKeyInput: the wearer's
    // own spoken question). A manual ask or a candidate's question never gets it from this text.
    answer: `Support the INTERVIEWER (the wearer), never the candidate. Help them run the interview: weigh what the candidate said and what to ask next. For the candidate's questions about the role, answer briefly and only from known context. Use a labelled format only when the request itself asks for one. ${INTERVIEWER_GUARD}`,
    guard: INTERVIEWER_GUARD,
    copilot: "The wearer is the interviewer; the other speaker is the candidate. Assess only job-relevant evidence from what the candidate actually said. Never infer or mention protected characteristics (age, gender, race, religion, disability, family status, nationality, accent).",
    suggestions: "at most 5 follow-up probes the INTERVIEWER (wearer) could ask the candidate next, phrased as they would say them aloud: ask for specifics the candidate glossed over, their own contribution versus the team's, numbers and outcomes, trade-offs they chose, and depth on claimed skills. Each with a short why. Never questions already asked or answered.",
    summary: "candidate evidence: concrete strengths and concerns, each tied to what the candidate said (scale, tools, outcomes, ownership); keyFacts are the candidate's checkable claims",
    presets: Object.freeze({ ...ALL_ON, implicitAsks: false }),
  }),
  partner: profile({
    id: "partner", label: "Partner", short: "PARTNR", askLabel: "CHECK IN",
    blurb: "Personal conversations: listen well, remember what matters. No fact-checking.",
    answer: "Support a personal conversation with someone close to the wearer. Be warm, brief and human. Never lecture, diagnose, fact-check or score points; when asked, help the wearer respond with care and honesty.",
    copilot: "This is a personal conversation between the wearer and someone close to them. Be kind and discreet. Never judge, diagnose or take sides, and never suggest manipulative or dishonest lines.",
    suggestions: sayLines("This is a personal conversation: the lines are warm, plain and honest, such as a short reflection of what the other person feels or a caring open question about what they shared (e.g. 'That sounds exhausting. What was the hardest part?'). No therapy jargon, no advice they did not ask for, nothing manipulative."),
    summary: "what matters to the other person: feelings, needs, plans, dates, preferences and things worth remembering or following up on",
    presets: Object.freeze({ summarize: true, concepts: false, conflicts: false, suggestions: true, implicitAsks: false, webGrounding: false, claims: false, people: true, autoAnswer: false, responseStrategy: "reactive" }),
    sayLines: true,
  }),
  negotiation: profile({
    id: "negotiation", label: "Negotiation", short: "DEAL", askLabel: "ASK",
    blurb: "Offers, numbers and concessions on the table; questions that uncover interests.",
    answer: "Support the wearer in a negotiation or sales conversation. Be concise and numeric: restate the terms on the table, then suggest one next move grounded in what was said. Never suggest deception or pressure tactics.",
    copilot: "This is a negotiation. Track offers, counteroffers, prices, volumes, deadlines and concessions exactly as stated.",
    suggestions: "at most 5 questions the WEARER could ask next to uncover the other side's interests, constraints, deadlines, decision process and flexibility, or to pin down vague terms. Phrased as they would say them aloud, each with a short why. Never questions already asked or answered.",
    summary: "terms on the table (offers, counteroffers, numbers, dates), concessions made, open issues and agreed points",
    presets: Object.freeze({ ...ALL_ON }),
  }),
  learning: profile({
    id: "learning", label: "Learning", short: "LEARN", askLabel: "ASK",
    blurb: "Lectures and walkthroughs: concepts explained, study notes, smart questions.",
    answer: "Support the wearer learning from a lecture or explanation. Explain clearly and simply, with one concrete example or analogy when it helps.",
    copilot: "The wearer is learning. Explain unfamiliar concepts generously but accurately.",
    suggestions: sayLines("The wearer is learning from a lecture or talk: the lines show they followed the idea and take it further, such as how it applies, where its limits are, or how it compares with a related theory or school of thought."),
    summary: "study notes: key ideas, definitions, formulas, steps and examples in the order they were taught",
    presets: Object.freeze({ ...ALL_ON, conflicts: false, claims: false, people: false }),
    sayLines: true,
  }),
  social: profile({
    id: "social", label: "Social", short: "SOCIAL", askLabel: "TALK",
    blurb: "Casual talk: easy follow-ups and quick look-ups, nothing heavy.",
    answer: "Use a warm, natural tone. Help the conversation flow without sounding scripted or overly formal.",
    copilot: "This is casual conversation. Keep everything light and friendly.",
    suggestions: sayLines("This is casual talk: the lines are light, friendly and short, and pick up what the other person shared (their plans, interests, stories) with a real thought or a related story."),
    summary: "what people shared: plans, interests, names and things worth following up on",
    presets: Object.freeze({ summarize: true, concepts: true, conflicts: false, suggestions: true, implicitAsks: true, webGrounding: true, claims: false, people: true, autoAnswer: false, responseStrategy: "reactive" }),
    sayLines: true,
  }),
  passive: profile({
    id: "passive", label: "Quiet", short: "QUIET", askLabel: "ASK THEM",
    blurb: "Captions and a running summary only. Ask when you want help.",
    answer: "Remain quiet unless directly asked a clear question or given a manual query. Never proactively interrupt.",
    summary: "decisions, numbers, dates and open issues",
    presets: Object.freeze({ summarize: true, concepts: false, conflicts: false, suggestions: false, implicitAsks: false, webGrounding: true, claims: false, people: false, autoAnswer: false, responseStrategy: "reactive" }),
  }),
  notes: profile({
    id: "notes", label: "Notes", short: "NOTES", askLabel: "ASK THEM",
    blurb: "Note-taker: action items, a living to-do list and meeting notes. No auto-answers.",
    answer: "Act as the wearer's note-taker. Stay quiet unless the wearer asks directly; then answer briefly from the conversation: what was decided, who owns what and by when. Never invent action items, owners or dates.",
    copilot: "The wearer wants notes, not answers. Capture action items with their owner and due date exactly as stated, keep the to-do list current by editing existing items instead of duplicating them, and write short factual notes of what was discussed and decided.",
    summary: "decisions, action items with owners and due dates, open questions and numbers",
    presets: Object.freeze({ summarize: true, concepts: false, conflicts: false, suggestions: false, implicitAsks: false, webGrounding: true, claims: false, people: true, autoAnswer: false, responseStrategy: "reactive", noteTaking: true }),
  }),
  // Candidate keeps the id `interviewee` so stored settings and the legacy `interview` alias keep working.
  interviewee: profile({
    id: "interviewee", label: "Candidate", short: "CAND", askLabel: "PREP",
    blurb: "You are being interviewed: answers you can say aloud from your saved résumé, what they may ask next, and questions to ask them.",
    answer: `The wearer is the CANDIDATE being interviewed; the other speaker is the interviewer. Answer the interviewer's question in the first person, as words the wearer can say aloud: the direct answer first, then one concrete example taken from the saved knowledge and memories supplied below (the wearer keeps their résumé and the job description there). For behavioural questions ("tell me about a time...") give situation, action, result in brief. ${CANDIDATE_GUARD}`,
    copilot: "The wearer is the candidate in a job interview; the other speaker is the interviewer. Track what the interviewer seems to be evaluating (skills, ownership, judgement, motivation, fit) from the questions they ask. Never invent experience or facts about the wearer.",
    suggestions: `at most 5 questions of two kinds. kind "they-ask": up to 3 questions the INTERVIEWER is likely to ask next, phrased as the interviewer would say them, so the wearer can prepare; why says what the interviewer would be checking. kind "ask-them": 1 or 2 good questions the CANDIDATE (wearer) could ask the interviewer about the role, team, expectations or next steps, phrased as the wearer would say them aloud; why says what the answer tells the wearer. Never questions already asked or answered.`,
    summary: "the interview so far: questions the interviewer asked, how each answer went, follow-ups the wearer owes and next steps; keyFacts are facts about the role, team, process and dates",
    presets: Object.freeze({ ...ALL_ON, implicitAsks: false }),
    guard: CANDIDATE_GUARD, suggestionKinds: true,
  }),
  // Legacy mode: kept for stored settings and the gateway protocol, not offered in the picker.
  "office-discussion": profile({
    id: "office-discussion", label: "Meeting", short: "MEET", askLabel: "ASK THEM", picker: false,
    blurb: "Legacy name of Meeting.",
    answer: "Focus on decisions, tradeoffs, owners, risks, and concrete next actions in a workplace discussion.",
    summary: "decisions, owners, numbers, dates and open issues",
    presets: ALL_ON,
  }),
});

/** Modes offered in the phone picker and the glasses menu, in display order. */
export const PICKER_MODES: readonly ConversationMode[] = Object.freeze(["general", "technical", "interviewer", "interviewee", "partner", "negotiation", "learning", "social", "passive", "notes"]);

export function modeProfile(mode: string | undefined): ModeProfile {
  return (mode && Object.prototype.hasOwnProperty.call(MODE_PROFILES, mode) ? MODE_PROFILES[mode as ConversationMode] : undefined) ?? MODE_PROFILES.general;
}

/**
 * Answer-lane request for the interviewer's own question (Interviewer mode). The key always has
 * ANSWER_KEY_SENTENCES labelled sentences; the answer length changes how much each part holds, and
 * answerSentenceLimit(length, base, true) gives the matching sentence limit for the instructions.
 */
export function answerKeyInput(question: string, length?: unknown): string {
  return `ANSWER KEY. The wearer is interviewing a candidate and just asked them: ${JSON.stringify(question.trim())}
Give the interviewer exactly three short labelled sentences: ${answerLengthProfile(length).answerKey} A lower sentence limit in the instructions does not apply to this answer key. Do not answer as the candidate.`;
}
export const ANSWER_KEY_PREFIX = "ANSWER KEY.";

/**
 * v0.16 request text of a manual "last few sentences" / "whole conversation" ask: the reply is the line
 * itself, ready to read aloud. `omitted` = earlier speech of the session is not in the request.
 * `correction` false leaves the "Correction:" sentence out (see lineCorrection).
 */
export function lineRequest(scope: "local" | "global", omitted = false, correction = true): string {
  const source = scope === "local" ? "the recent focus, using relevant earlier background" : omitted ? "the captured session" : "the whole captured session";
  return `Give the wearer the single best thing to say next, word for word, in the language being spoken, as one or two sentences they can read aloud. Base it on ${source}. If the other person just asked something, the line answers it; otherwise it adds a substantive point, comparison, example or sharp question on the topic. Write only the line: no preamble, no label, no quotation marks and no labelled format.${correction ? ' If something just said was factually wrong, add one sentence starting "Correction:".' : ""}`;
}
/**
 * Whether a line to say may carry a "Correction:" sentence in this mode. Modes whose presets turn both
 * fact lanes off (conflicts and claims: Partner, Social, Learning, Quiet) do not fact-check the other person.
 */
export function lineCorrection(mode: string | undefined): boolean {
  const presets = modeProfile(mode).presets;
  return presets.conflicts || presets.claims;
}

const MODE_INSTRUCTIONS: Readonly<Record<ConversationMode, string>> = Object.freeze(Object.fromEntries(
  Object.values(MODE_PROFILES).map(item => [item.id, item.answer])) as Record<ConversationMode, string>);

const FILLER = /^(?:ok(?:ay)?|sure|right|yeah|yes|no|thanks?|thank you|got it|sounds good|mm+|uh+|um+)[.! ]*$/i;
const ACTIONABLE = /\b(?:need(?:s)? to|have to|must|should|decid(?:e|ing)|choos(?:e|ing)|deadline|due\b|by (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|today)|risk(?:s|y)?\b|block(?:ed|er|ing)?\b|problem\b|issue\b|trade-?off|next step|action item|launch date|ship date|owner\b|priority|prioriti[sz]e)\b/i;
const NEGATED_ACTION = /\b(?:no|not\s+(?:a|an|the)?|without\s+(?:a|an|any)?)\s*(?:current\s+|remaining\s+)?(?:issue|problem|risk|blocker|action item|next step|decision|need)\b|\b(?:do|does|did)\s+not\s+need\s+to\s+(?:decide|choose|act|change|ship|launch)\b|\bshould\s+not\s+(?:block|change|act|ship|launch)\b/i;
const TITLED_NEXT_STEP = /\b(?:movie|film|book|song|episode|show)\b.{0,40}\b(?:called|named|titled)\s+["'“‘]?next step\b/i;

export function modeSystemPrompt(
  protectedBasePrompt: string,
  mode: ConversationMode,
  strategy: ResponseStrategy,
  /** v0.11: the user's own prompt for this mode (replaces the built-in mode instruction; the mode's `guard` rule is kept). */
  customInstruction?: string,
  /** v0.16 `line`: a manual context ask, whose reply is a line for the wearer to read aloud (lineRequest). */
  options: { readonly line?: boolean } = {},
): string {
  const strategyInstruction = strategy === "reactive"
    ? "Automatically answer detected questions only; do not invent interventions for ordinary statements."
    : strategy === "proactive"
      ? "Automatically intervene only for useful non-question decisions, actions, blockers, or risks. Detected questions wait for a manual query."
      : "Automatically answer detected questions and also intervene for useful non-question decisions, actions, blockers, or risks.";
  // A user prompt replaces the built-in instruction but never the mode's guard rule.
  const custom = customInstruction?.trim().slice(0, 4000).trim(), guard = MODE_PROFILES[mode].guard;
  return [
    protectedBasePrompt.trim(),
    `Protected conversation mode: ${mode}. ${custom ? `${custom}${guard ? ` ${guard}` : ""}` : MODE_INSTRUCTIONS[mode]}`,
    `Protected response strategy: ${strategy}. ${strategyInstruction}`,
    options.line
      ? `The reply is the wearer's own next line in natural spoken language, with nothing before or after it. ${FACTS_RULE}`
      : `Start with the answer itself in natural spoken language. Omit filler, preambles and coaching phrases such as 'you could say'. ${FACTS_RULE}`,
    `${SPEECH_RECOGNITION_RULE} ${SPOKEN_LANGUAGE_RULE}`,
  ].join("\n\n");
}

export function shouldGenerateProactiveResponse(
  text: string,
  mode: ConversationMode,
  strategy: ResponseStrategy,
): boolean {
  if (strategy === "reactive" || mode === "passive") return false;
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length < 18 || FILLER.test(compact)) return false;
  const words = compact.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (words.length < 4) return false;
  if (TITLED_NEXT_STEP.test(compact)) return false;
  if (NEGATED_ACTION.test(compact) && !/\b(?:but|however|although|yet)\b/i.test(compact)) return false;
  return ACTIONABLE.test(compact);
}

export function shouldAnswerDetectedQuestions(strategy: ResponseStrategy): boolean {
  return strategy === "reactive" || strategy === "both";
}

export function proactiveInput(text: string): string {
  return `Offer one concise, immediately useful intervention for this statement. Do not pretend it was a question and do not add filler:\n${text.trim()}`;
}
