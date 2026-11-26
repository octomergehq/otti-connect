import { spawn } from "node:child_process";
import { HOST_API_CLIENT, HOST_API_PATHS } from "./host-api";
import { answerError, type JsonAnswer, requestJson, sleep } from "./http";

/**
 * Octomerge's device sign-in, as the client `otti-connect` (host-api.ts): it
 * shows the person a code and an address, the person approves it in the
 * browser, where Octomerge decides what an agent host's sign-in allows, and
 * the connector gets a token. Like Octomerge's own programs, it polls at the
 * interval the server asks for, slows down when told to, and stops when the
 * code expires; an expired code is replaced by a new one, so a computer
 * nobody watches (a container) can be approved whenever someone reads its
 * log.
 */

/** Octomerge's route that revokes the credential a request carries (every client of its own uses it to sign out). */
const LOGOUT_PATH = "/api/r5dctl/auth/logout";
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRY_MS = 30_000;

export class SignInError extends Error {
  constructor(message: string, readonly reason: "denied" | "refused" | "stopped") {
    super(message);
    this.name = "SignInError";
  }
}

type DeviceStart = { requestId: string; deviceCode: string; userCode: string; verificationUri: string; verificationUriComplete: string; expiresAt: string; intervalMs: number };

const text = (value: unknown) => (typeof value === "string" ? value : undefined);
const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined);

function deviceStart(answer: JsonAnswer): DeviceStart | null {
  const body = answer.body ?? {};
  const start = {
    requestId: text(body.requestId),
    deviceCode: text(body.deviceCode),
    userCode: text(body.userCode),
    verificationUri: text(body.verificationUri),
    verificationUriComplete: text(body.verificationUriComplete),
    expiresAt: text(body.expiresAt),
    intervalMs: count(body.intervalMs) ?? 5_000,
  };
  if (!start.requestId || !start.deviceCode || !start.userCode || !start.verificationUri) return null;
  return {
    ...start,
    verificationUriComplete: start.verificationUriComplete ?? `${start.verificationUri}?code=${encodeURIComponent(start.userCode)}`,
    expiresAt: start.expiresAt ?? new Date(Date.now() + 10 * 60_000).toISOString(),
  } as DeviceStart;
}

/** The approval prompt, as Octomerge's own programs print it. */
export function renderPrompt(start: Pick<DeviceStart, "verificationUri" | "verificationUriComplete" | "userCode" | "expiresAt">): string {
  const border = "─".repeat(start.userCode.length + 4);
  const until = new Date(start.expiresAt);
  const minutes = Math.max(1, Math.round((until.getTime() - Date.now()) / 60_000));
  const time = Number.isNaN(until.getTime()) ? "" : `The code works until ${until.toTimeString().slice(0, 5)} (${minutes} minute${minutes === 1 ? "" : "s"}).\n`;
  return `Approve this computer as one of your agent hosts by opening:\n${start.verificationUriComplete}\n\nOr open ${start.verificationUri} and enter this code:\n┌${border}┐\n│  ${start.userCode}  │\n└${border}┘\n${time}`;
}

/** Opens an address in the person's browser, when there is one; nothing happens when there isn't (a server, a container). */
function openInBrowser(url: string): void {
  const [command, args] =
    process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  try {
    const child = spawn(command, args as string[], { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // No browser here: the address and the code stand.
  }
}

/**
 * Signs this computer in and resolves with the token. `say` prints for the
 * person; the token is never printed. Throws SignInError when the person
 * denies the code, the server refuses the sign-in, or `signal` stops it.
 */
export async function deviceSignIn(input: { baseUrl: string; deviceName: string; open: boolean; signal: AbortSignal; say: (text: string) => void }): Promise<string> {
  const { baseUrl, signal, say } = input;
  const stopped = () => new SignInError("Stopped before the sign-in was approved.", "stopped");
  let retryMs = 1_000;
  let unreachable = false;
  const wait = async (ms: number) => {
    await sleep(ms, signal);
    if (signal.aborted) throw stopped();
  };
  for (;;) {
    if (signal.aborted) throw stopped();
    let answer: JsonAnswer;
    try {
      answer = await requestJson(baseUrl, HOST_API_PATHS.deviceStart, { method: "POST", body: { deviceName: input.deviceName, client: HOST_API_CLIENT }, timeoutMs: REQUEST_TIMEOUT_MS, signal });
    } catch (error) {
      if (signal.aborted) throw stopped();
      if (!unreachable) say(`Can't reach ${baseUrl} to sign in (${(error as Error).message}); trying again.`);
      unreachable = true;
      await wait(retryMs);
      retryMs = Math.min(MAX_RETRY_MS, retryMs * 2);
      continue;
    }
    if (answer.status === 429 || answer.status === 408 || answer.status >= 500) {
      await wait(answer.status === 429 ? count(answer.body?.intervalMs) ?? MAX_RETRY_MS : retryMs);
      retryMs = Math.min(MAX_RETRY_MS, retryMs * 2);
      continue;
    }
    const start = answer.status === 200 || answer.status === 201 ? deviceStart(answer) : null;
    if (!start) throw new SignInError(`${baseUrl} didn't start the sign-in: ${answerError(answer)}`, "refused");
    unreachable = false;
    retryMs = 1_000;
    say(renderPrompt(start));
    if (input.open && process.stdout.isTTY) openInBrowser(start.verificationUriComplete);
    const outcome = await waitForApproval(baseUrl, start, signal);
    if (typeof outcome === "object") return outcome.token;
    say(outcome === "expired" ? "The code expired before it was approved. Here is a new one." : "That sign-in can no longer be collected. Here is a new code.");
  }
}

/** Polls the sign-in until it is decided: the token, or that it expired (or was collected already) and needs a new code. */
async function waitForApproval(baseUrl: string, start: DeviceStart, signal: AbortSignal): Promise<{ token: string } | "expired" | "gone"> {
  const expiresAt = Date.parse(start.expiresAt) || Date.now() + 10 * 60_000;
  let intervalMs = start.intervalMs;
  let delayMs = intervalMs;
  let transientMs = 1_000;
  const transient = () => {
    delayMs = Math.min(MAX_RETRY_MS, Math.max(intervalMs, transientMs));
    transientMs = Math.min(MAX_RETRY_MS, transientMs * 2);
  };
  while (Date.now() < expiresAt) {
    await sleep(Math.min(delayMs, Math.max(0, expiresAt - Date.now())), signal);
    if (signal.aborted) throw new SignInError("Stopped before the sign-in was approved.", "stopped");
    let polled: JsonAnswer;
    try {
      polled = await requestJson(baseUrl, HOST_API_PATHS.devicePoll(start.requestId), { method: "POST", body: { deviceCode: start.deviceCode }, timeoutMs: REQUEST_TIMEOUT_MS, signal });
    } catch {
      if (signal.aborted) throw new SignInError("Stopped before the sign-in was approved.", "stopped");
      transient();
      continue;
    }
    if (polled.status === 429) {
      intervalMs = count(polled.body?.intervalMs) ?? intervalMs;
      delayMs = intervalMs;
      continue;
    }
    if (polled.status === 408 || polled.status >= 500) {
      transient();
      continue;
    }
    // The request is gone from the server: start over with a new code.
    if (polled.status === 404) return "gone";
    if (polled.status !== 200) throw new SignInError(`${baseUrl} refused the sign-in: ${answerError(polled)}`, "refused");
    transientMs = 1_000;
    const state = polled.body ?? {};
    switch (state.status) {
      case "pending":
        intervalMs = count(state.intervalMs) ?? intervalMs;
        delayMs = intervalMs;
        continue;
      case "approved": {
        const token = text(state.token);
        if (token) return { token };
        // An approval that adds to a sign-in in place sends no token; this connector never asks for one.
        throw new SignInError(`${baseUrl} approved the sign-in but sent no credential. Start Otti Connect again.`, "refused");
      }
      case "denied":
        throw new SignInError("The sign-in was denied in the browser.", "denied");
      case "expired":
        return "expired";
      case "consumed":
        return "gone";
      default:
        throw new SignInError(`${baseUrl} answered the sign-in in a way Otti Connect doesn't know (${String(state.status)}).`, "refused");
    }
  }
  return "expired";
}

export type Revocation = { outcome: "revoked" | "invalid" | "unreachable" | "refused"; error?: string };

/** Revokes a sign-in with Octomerge: the credential the request carries. */
export async function revokeSignIn(baseUrl: string, token: string): Promise<Revocation> {
  let answer: JsonAnswer;
  try {
    answer = await requestJson(baseUrl, LOGOUT_PATH, { method: "POST", body: {}, token, timeoutMs: REQUEST_TIMEOUT_MS });
  } catch (error) {
    return { outcome: "unreachable", error: (error as Error).message };
  }
  if (answer.status === 200) return { outcome: "revoked" };
  if (answer.status === 401) return { outcome: "invalid" };
  if (answer.status >= 500 || answer.status === 408 || answer.status === 429) return { outcome: "unreachable", error: answerError(answer) };
  return { outcome: "refused", error: answerError(answer) };
}
