import type { HttpAnswerProfile, HttpTranscriptionProfile, ProviderConfig } from "../config.js";
import { ProviderError } from "./types.js";

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;
export type AuthenticatedHttpProfile =
  | HttpAnswerProfile
  | HttpTranscriptionProfile
  | ProviderConfig;

export function providerRequestUrl(baseUrl: string, path: string): string {
  const base = new URL(baseUrl);
  if (base.protocol !== "http:" && base.protocol !== "https:") {
    throw new ProviderError("provider-response", "Provider URL must use HTTP or HTTPS", false);
  }
  if (base.username !== "" || base.password !== "" || base.search !== "" || base.hash !== "") {
    throw new ProviderError("provider-response", "Provider URL contains forbidden credentials or URL components", false);
  }
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("?") || path.includes("#")) {
    throw new ProviderError("provider-response", "Provider request path is invalid", false);
  }
  const basePrefix = base.pathname.replace(/\/+$/, "");
  const result = new URL(`${base.toString().replace(/\/+$/, "")}/${path.replace(/^\//, "")}`);
  if (result.origin !== base.origin || !result.pathname.startsWith(`${basePrefix}/`)) {
    throw new ProviderError("provider-response", "Provider request path escaped the configured endpoint", false);
  }
  return result.toString();
}

export function authHeaders(config: AuthenticatedHttpProfile): Record<string, string> {
  const headers: Record<string, string> = { ...config.extraHeaders };
  if (config.apiKey !== undefined) {
    headers[config.authHeader] = config.authScheme === ""
      ? config.apiKey
      : `${config.authScheme} ${config.apiKey}`;
  }
  return headers;
}

export function mapProviderFailure(status: number): ProviderError {
  if (status === 401 || status === 403) {
    return new ProviderError("provider-authentication", "Provider rejected its server credential", false, status);
  }
  if (status === 408) {
    return new ProviderError("provider-timeout", "Provider request timed out", true, status);
  }
  if (status === 429) {
    return new ProviderError("provider-rate-limit", "Provider is temporarily rate limited", true, status);
  }
  if (status >= 500) {
    return new ProviderError("provider-unavailable", "Provider is temporarily unavailable", true, status);
  }
  return new ProviderError("provider-response", `Provider request failed with status ${status}`, false, status);
}

export async function providerFetch(
  fetchImpl: FetchLike,
  input: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const requestSignal = init.signal === undefined || init.signal === null
    ? timeoutSignal
    : AbortSignal.any([init.signal, timeoutSignal]);
  try {
    // Provider requests carry audio, prompts, memory, and authorization. Never
    // let fetch forward that material to a redirect target whose origin was
    // not validated by gateway configuration.
    return await fetchImpl(input, {
      ...init,
      redirect: "error",
      signal: requestSignal,
    });
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    if (init.signal?.aborted) {
      throw new ProviderError("provider-unavailable", "Provider request was cancelled", true);
    }
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new ProviderError("provider-timeout", "Provider request timed out", true);
    }
    throw new ProviderError("provider-unavailable", "Provider request could not be completed", true);
  }
}

export const defaultFetch: FetchLike = (input, init) => fetch(input, init);
