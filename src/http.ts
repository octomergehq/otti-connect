import { CONNECTOR } from "./util";

/**
 * JSON over HTTPS to Octomerge, for the agent host API and the device
 * sign-in. A request that gets no answer (the network, a timeout, a server
 * that closed the connection) throws `NetworkError`; any answer, an error
 * included, resolves with its status and its JSON body.
 */

export class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NetworkError";
  }
}

/** An answer: its status and JSON body, and where a redirect points (never followed: the token stays with the base URL). */
export type JsonAnswer = { status: number; body: Record<string, unknown> | null; location?: string };

/** What every request says about the program that sends it. */
const USER_AGENT = `${CONNECTOR.name}/${CONNECTOR.version} (${process.platform} ${process.arch}; node ${process.versions.node})`;

/**
 * One request. `timeoutMs` bounds it as a whole; `signal` stops it early (a
 * shutdown). The token goes only in the Authorization header, never in a URL.
 */
export async function requestJson(
  baseUrl: string,
  path: string,
  init: { method: "GET" | "POST"; body?: unknown; token?: string; timeoutMs: number; signal?: AbortSignal },
): Promise<JsonAnswer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new NetworkError(`no answer within ${Math.round(init.timeoutMs / 1000)} s`)), init.timeoutMs);
  const stop = () => controller.abort(init.signal?.reason ?? new NetworkError("stopped"));
  if (init.signal?.aborted) stop();
  else init.signal?.addEventListener("abort", stop, { once: true });
  try {
    let response: Response;
    try {
      response = await fetch(`${baseUrl}${path}`, {
        method: init.method,
        headers: {
          accept: "application/json",
          "user-agent": USER_AGENT,
          ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
          ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
        },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal: controller.signal,
        redirect: "manual",
      });
    } catch (error) {
      throw new NetworkError(describeFailure(controller.signal.reason ?? error));
    }
    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      throw new NetworkError(describeFailure(controller.signal.reason ?? error));
    }
    let body: Record<string, unknown> | null = null;
    if (text) {
      try {
        const parsed: unknown = JSON.parse(text);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
      } catch {
        body = null;
      }
    }
    const location = response.status >= 300 && response.status < 400 ? response.headers.get("location") ?? undefined : undefined;
    return { status: response.status, body, ...(location ? { location } : {}) };
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener("abort", stop);
  }
}

/** Why a request got no answer, in a few words (fetch hides the cause). */
function describeFailure(error: unknown): string {
  if (error instanceof NetworkError) return error.message;
  const cause = (error as { cause?: { code?: unknown; message?: unknown } } | null)?.cause;
  if (cause && typeof cause.code === "string") return cause.code;
  if (cause && typeof cause.message === "string" && cause.message) return cause.message;
  return error instanceof Error ? error.message : String(error);
}

/** The server's own words for a refusal, or its status. */
export function answerError(answer: JsonAnswer): string {
  const error = answer.body?.error;
  if (typeof error === "string" && error) return error;
  if (answer.location) return `HTTP ${answer.status}: it redirects to ${answer.location}, so --base-url may need to name that server`;
  return `HTTP ${answer.status}`;
}

export function answerCode(answer: JsonAnswer): string | undefined {
  const code = answer.body?.code;
  return typeof code === "string" ? code : undefined;
}

/** Waits `ms`, or less when `signal` fires. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}
