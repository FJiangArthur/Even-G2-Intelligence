import { isSafeEndpointReference, type NoteCandidate } from "./types.js";

export interface NoteSaveResult {
  readonly status: "saved" | "duplicate" | "rejected";
  readonly note?: NoteCandidate;
  readonly reason?: string;
}

export interface NoteSink {
  save(candidate: NoteCandidate): Promise<NoteSaveResult>;
}

export interface InMemoryNoteSinkOptions {
  readonly maxNotes?: number;
  readonly maxTextLength?: number;
}

/**
 * Mandatory client-side floor for unattended note writes. Gateways should
 * apply a richer product policy as well, but a compromised/misconfigured
 * gateway must not be able to bypass these checks.
 */
export function validateAutomaticNoteCandidate(
  candidate: NoteCandidate,
  expectedSessionId?: string,
): string | undefined {
  if (expectedSessionId !== undefined && candidate.provenance.sessionId !== expectedSessionId) {
    return "note provenance belongs to a different session";
  }
  if (!isSafeEndpointReference(candidate.provenance.endpoint.url)) {
    return "note endpoint reference is unsafe";
  }

  const content = [
    candidate.title,
    candidate.text,
    ...(candidate.tags ?? []),
    candidate.provenance.sessionId,
    candidate.provenance.sourceEventId,
    candidate.provenance.prompt.id,
    candidate.provenance.prompt.version,
    candidate.provenance.endpoint.id,
    candidate.provenance.endpoint.url,
    decodePercentEncoding(candidate.provenance.endpoint.url),
    candidate.provenance.endpoint.provider,
    candidate.provenance.endpoint.model,
    candidate.provenance.speaker.id,
    candidate.provenance.speaker.label,
    candidate.provenance.mode,
    candidate.provenance.responseStrategy,
    candidate.provenance.transcriptionProvider?.profileId,
    candidate.provenance.transcriptionProvider?.model,
    candidate.provenance.answerProvider?.profileId,
    candidate.provenance.answerProvider?.model,
    candidate.persistence?.recordId,
    candidate.persistence?.failureCode,
  ]
    .filter((value): value is string => typeof value === "string")
    .join("\n");
  if (containsUnsafeControlCharacter(content)) return "note contains unsafe control characters";
  if (containsCredential(content)) return "note appears to contain a credential";
  if (containsQuestion(candidate.text)) return "questions are not saved automatically";
  if (containsUncertainty(candidate.text)) return "uncertain claims are not saved automatically";
  return undefined;
}

/**
 * A bounded local sink for previews and tests. It rejects unsafe control bytes,
 * never mutates caller-owned values, and deduplicates normalized note text per
 * session.
 */
export class InMemoryNoteSink implements NoteSink {
  private readonly notesById = new Map<string, NoteCandidate>();
  private readonly dedupeKeys = new Set<string>();
  private readonly maxNotes: number;
  private readonly maxTextLength: number;

  public constructor(options: InMemoryNoteSinkOptions = {}) {
    this.maxNotes = requirePositiveInteger(options.maxNotes ?? 1000, "maxNotes");
    this.maxTextLength = requirePositiveInteger(options.maxTextLength ?? 10_000, "maxTextLength");
  }

  public async save(candidate: NoteCandidate): Promise<NoteSaveResult> {
    const rejection = this.validate(candidate);
    if (rejection) return { status: "rejected", reason: rejection };

    const normalizedText = normalizeText(candidate.text);
    const dedupeKey = `${candidate.provenance.sessionId}\u0000${normalizedText}`;
    const normalizedCandidate = normalizeNoteForStorage(candidate);
    const existing = this.notesById.get(candidate.id);
    if (existing) {
      if (!equivalentNoteCore(existing, normalizedCandidate)) {
        return { status: "rejected", reason: "note id already exists with different content or provenance" };
      }
      const persistenceTransition = classifyPersistenceTransition(
        existing.persistence,
        normalizedCandidate.persistence,
      );
      if (persistenceTransition === "duplicate") {
        return { status: "duplicate", note: cloneNote(existing) };
      }
      if (persistenceTransition !== "update") {
        return { status: "rejected", reason: persistenceTransition };
      }
      this.notesById.set(normalizedCandidate.id, normalizedCandidate);
      return { status: "saved", note: cloneNote(normalizedCandidate) };
    }
    if (this.dedupeKeys.has(dedupeKey)) {
      return { status: "duplicate", reason: "equivalent note already exists in this session" };
    }
    if (this.notesById.size >= this.maxNotes) {
      return { status: "rejected", reason: "note capacity reached" };
    }

    const stored = normalizedCandidate;
    this.notesById.set(stored.id, stored);
    this.dedupeKeys.add(dedupeKey);
    return { status: "saved", note: cloneNote(stored) };
  }

  public list(): readonly NoteCandidate[] {
    return [...this.notesById.values()].map(cloneNote);
  }

  public clear(): void {
    this.notesById.clear();
    this.dedupeKeys.clear();
  }

  private validate(candidate: NoteCandidate): string | undefined {
    const baselineRejection = validateAutomaticNoteCandidate(candidate);
    if (baselineRejection) return baselineRejection;
    if (!candidate.id.trim()) return "note id is required";
    const text = candidate.text.trim();
    if (!text) return "note text is required";
    if (text.length > this.maxTextLength) return `note text exceeds ${this.maxTextLength} characters`;
    if (containsUnsafeControlCharacter(text)) return "note text contains unsafe control characters";
    if (candidate.title && candidate.title.length > 240) return "note title exceeds 240 characters";
    if ((candidate.tags?.length ?? 0) > 20) return "note has more than 20 tags";
    if (candidate.tags?.some((tag) => !tag.trim() || tag.length > 64 || containsUnsafeControlCharacter(tag))) {
      return "note contains an invalid tag";
    }
    const persistenceRejection = validatePersistenceOutcome(candidate);
    if (persistenceRejection) return persistenceRejection;
    if (!candidate.provenance.sessionId.trim() || !candidate.provenance.sourceEventId.trim()) {
      return "note provenance is incomplete";
    }
    if (!Number.isFinite(candidate.provenance.latencyMs.totalMs) || candidate.provenance.latencyMs.totalMs < 0) {
      return "note latency must be a finite non-negative number";
    }
    if (Number.isNaN(Date.parse(candidate.provenance.capturedAt))) {
      return "note capture timestamp is invalid";
    }
    return undefined;
  }
}

function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function containsUnsafeControlCharacter(value: string): boolean {
  // Newlines and tabs are intentionally safe; NUL/bidi and other controls are not.
  return /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]/u.test(value);
}

function containsCredential(value: string): boolean {
  return (
    /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/u.test(value) ||
    /\b(?:sk|rk|pk)-(?:proj-)?[A-Za-z0-9_-]{16,}\b/iu.test(value) ||
    /\bAKIA[A-Z0-9]{16}\b/u.test(value) ||
    /\b(?:api[ _-]?key|access[ _-]?token|auth(?:orization)?|bearer|password|secret)\s*(?::|=)\s*\S{8,}/iu.test(value) ||
    /\bBearer\s+[A-Za-z0-9._~+/-]{8,}={0,2}\b/iu.test(value)
  );
}

function containsQuestion(value: string): boolean {
  const normalized = value.trim();
  return /[?？]$/u.test(normalized) ||
    /^(?:who|what|when|where|why|how|which|whose|whom)\s+(?:to|is|are|was|were|do|does|did|can|could|would|should|will)\b/iu.test(normalized) ||
    /^(?:can|could|would|should|is|are|am|do|does|did|will)\s+\S+/iu.test(normalized);
}

function containsUncertainty(value: string): boolean {
  return /\b(?:maybe|perhaps|probably|possibly|uncertain|unsure|not sure|i think|i guess|might|may have|could be|appears to|seems to)\b/iu.test(value) ||
    /(?:^May be\b|\bmay\b)/u.test(value);
}

function decodePercentEncoding(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function normalizeNoteForStorage(candidate: NoteCandidate): NoteCandidate {
  return cloneNote({
    ...candidate,
    text: candidate.text.trim(),
    title: candidate.title?.trim(),
    tags: candidate.tags?.map((tag) => tag.trim()),
  });
}

function equivalentNoteCore(left: NoteCandidate, right: NoteCandidate): boolean {
  return structurallyEqual(
    noteCoreForComparison(left),
    noteCoreForComparison(right),
  );
}

function noteCoreForComparison(candidate: NoteCandidate): unknown {
  return {
    ...candidate,
    text: normalizeText(candidate.text),
    persistence: undefined,
  };
}

function classifyPersistenceTransition(
  previous: NoteCandidate["persistence"],
  next: NoteCandidate["persistence"],
): "duplicate" | "update" | string {
  if (structurallyEqual(previous, next)) return "duplicate";
  if (previous === undefined && next !== undefined) return "update";
  if (previous !== undefined && next === undefined) {
    return "note persistence update would remove an observed outcome";
  }
  if (previous?.status === "pending" && (next?.status === "synced" || next?.status === "failed")) {
    return "update";
  }
  return `note persistence update conflicts with terminal ${previous?.status ?? "unknown"} outcome`;
}

function validatePersistenceOutcome(candidate: NoteCandidate): string | undefined {
  const persistence = candidate.persistence;
  if (persistence === undefined) return undefined;
  if (persistence.destination !== "omi") return "note persistence destination is invalid";
  if (persistence.status === "pending") {
    return persistence.recordId === undefined && persistence.failureCode === undefined
      ? undefined
      : "pending note persistence cannot include a record or failure";
  }
  if (persistence.status === "synced") {
    return persistence.failureCode === undefined
      ? undefined
      : "synced note persistence cannot include a failure";
  }
  if (persistence.status === "failed") {
    return persistence.recordId === undefined
      ? undefined
      : "failed note persistence cannot include a record";
  }
  return "note persistence status is invalid";
}

function structurallyEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => structurallyEqual(value, right[index]));
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left).filter((key) => left[key] !== undefined).sort();
  const rightKeys = Object.keys(right).filter((key) => right[key] !== undefined).sort();
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && structurallyEqual(left[key], right[key]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneNote(note: NoteCandidate): NoteCandidate {
  return {
    ...note,
    tags: note.tags ? [...note.tags] : undefined,
    provenance: {
      ...note.provenance,
      prompt: { ...note.provenance.prompt },
      endpoint: { ...note.provenance.endpoint },
      speaker: { ...note.provenance.speaker },
      latencyMs: { ...note.provenance.latencyMs },
      ...(note.provenance.transcriptionProvider === undefined
        ? {}
        : { transcriptionProvider: { ...note.provenance.transcriptionProvider } }),
      ...(note.provenance.answerProvider === undefined
        ? {}
        : { answerProvider: { ...note.provenance.answerProvider } }),
    },
    ...(note.persistence === undefined ? {} : { persistence: { ...note.persistence } }),
  };
}

function requirePositiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer`);
  return value;
}
