import type { HttpTranscriptionProfile } from "../config.js";
import { profileSelection } from "../config.js";
import {
  authHeaders,
  defaultFetch,
  mapProviderFailure,
  providerFetch,
  providerRequestUrl,
  type FetchLike,
} from "./http.js";
import type { TranscriptionProvider, TranscriptionRequest, TranscriptionResult } from "./types.js";
import { ProviderError } from "./types.js";

interface DeepgramPayload {
  readonly results?: {
    readonly channels?: readonly {
      readonly alternatives?: readonly { readonly transcript?: unknown }[];
    }[];
  };
}

export class DeepgramTranscriptionProvider implements TranscriptionProvider {
  public readonly selection;

  public constructor(
    private readonly profile: HttpTranscriptionProfile,
    private readonly fetchImpl: FetchLike = defaultFetch,
  ) {
    if (profile.kind !== "deepgram") throw new TypeError("DeepgramTranscriptionProvider requires a deepgram profile");
    this.selection = profileSelection(profile);
  }

  public async transcribe(request: TranscriptionRequest): Promise<TranscriptionResult> {
    const url = new URL(providerRequestUrl(this.profile.baseUrl, this.profile.path));
    url.searchParams.set("encoding", "linear16");
    url.searchParams.set("sample_rate", "16000");
    url.searchParams.set("channels", "1");
    url.searchParams.set("smart_format", "true");
    if (this.profile.model !== "") url.searchParams.set("model", this.profile.model);
    if (request.language !== undefined && request.language.trim() !== "") {
      url.searchParams.set("language", request.language.trim());
    }
    const body = Uint8Array.from(request.pcm16).buffer;
    const response = await providerFetch(
      this.fetchImpl,
      url.toString(),
      {
        method: "POST",
        headers: {
          ...authHeaders(this.profile),
          "Content-Type": "audio/l16;rate=16000",
          Accept: "application/json",
        },
        body,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      },
      this.profile.requestTimeoutMs,
    );
    if (!response.ok) throw mapProviderFailure(response.status);

    let payload: DeepgramPayload;
    try {
      payload = await response.json() as DeepgramPayload;
    } catch {
      throw new ProviderError("provider-response", "Deepgram returned invalid transcription JSON", false);
    }
    const transcript = payload.results?.channels?.[0]?.alternatives?.[0]?.transcript;
    if (typeof transcript !== "string" || transcript.trim() === "") {
      throw new ProviderError("provider-response", "Deepgram returned an empty transcription", false);
    }
    return { text: transcript.trim() };
  }
}
