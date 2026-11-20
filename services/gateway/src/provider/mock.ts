import type {
  AnswerRequest,
  ConversationProvider,
  TranscriptionRequest,
  TranscriptionResult,
} from "./types.js";

export class MockConversationProvider implements ConversationProvider {
  public readonly endpoint;
  public readonly selection;

  public constructor(
    private readonly transcript: string,
    endpoint: ConversationProvider["endpoint"] = {
    id: "mock",
    url: "urn:helix:provider:mock",
    provider: "mock",
    model: "mock",
    },
    selection: ConversationProvider["selection"] = {
      profileId: endpoint.id,
      model: endpoint.model,
    },
  ) {
    this.endpoint = endpoint;
    this.selection = selection;
  }

  public async transcribe(_request: TranscriptionRequest): Promise<TranscriptionResult> {
    return { text: this.transcript };
  }

  public async *streamAnswer(request: AnswerRequest): AsyncGenerator<string> {
    const answer = `The next step is to address “${request.question.replace(/\?$/, "")}” directly.`;
    const chunks = answer.match(/\S+\s*/g) ?? [answer];
    for (const chunk of chunks) yield chunk;
  }
}
