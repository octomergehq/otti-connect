/**
 * The Octomerge agent host API, version 1 (PROTOCOL.md, "The agent host
 * API"): how a connector on a person's computer connects to Octomerge itself
 * and takes turns from it, with no other Octomerge program on that computer.
 *
 * A connector signs in once with Octomerge's device sign-in, as the client
 * `otti-connect`: it shows the person a code, and the person approves it in
 * the browser, where Octomerge grants the sign-in an agent host needs. With
 * the token it registers as an agent host, then polls for commands: a turn to
 * start, a line of input for a running turn, a turn to stop. Each turn is the
 * connector protocol (protocol.ts) carried over HTTPS: the server's lines
 * arrive as `input` commands, in order; the connector uploads what the turn
 * writes to its standard output as `output` chunks at byte offsets, and the
 * turn's exit with the last one. Offsets make a dropped connection harmless:
 * the server says how many bytes of each turn it holds, and the connector
 * sends the rest again.
 *
 * Every request carries `Authorization: Bearer <token>`. Errors are JSON
 * `{ error, code }`: 401 the sign-in no longer works (sign in again); 403 it
 * doesn't allow an agent host; 404 `agent_host_not_found` the host was removed
 * (register again); 404 `turn_not_found` or `turn_lost` the server doesn't
 * have the turn or gave it up (stop it and forget it); 409 `label_taken`
 * another connected computer of the account has the label (a computer that
 * has been away for HOST_OFFLINE_AFTER_MS, or whose sign-in was revoked,
 * hands its label, place and settings to the one that registers with it);
 * 409 `output_gap` an output chunk starts after the bytes the server holds
 * (`outputBytes` in the answer says where to resume). Output is idempotent: a
 * chunk that starts below the bytes held adds only the rest, and an exit sent
 * again is answered like the first.
 *
 * The only import is protocol.ts's agent kinds, so a client can use both
 * files as they are.
 */
import type { AgentKind } from "./protocol";

export const HOST_API_VERSION = 1;
/** The device sign-in's client name for a connector: the server grants it what an agent host needs. */
export const HOST_API_CLIENT = "otti-connect";

export const HOST_API_PATHS = {
  /** Octomerge's device sign-in (shared with its other programs). */
  deviceStart: "/api/auth/device/start",
  devicePoll: (requestId: string) => `/api/auth/device/poll/${encodeURIComponent(requestId)}`,
  register: "/api/agent-hosts/connector/register",
  poll: "/api/agent-hosts/connector/poll",
  output: "/api/agent-hosts/connector/output",
} as const;

/** The server answers a poll within this, sooner when it has commands. */
export const POLL_WAIT_MS = 25_000;
/** The longest output chunk the server takes, before base64. */
export const MAX_OUTPUT_CHUNK_BYTES = 256 * 1024;
/** A host the server hasn't heard from for this long is offline: no new turn goes to it. */
export const HOST_OFFLINE_AFTER_MS = 60_000;

/** What a connector says about one agent on its computer. */
export type AgentReport = {
  kind: AgentKind;
  /** The agent's program is there and the connector can run it. */
  installed: boolean;
  /** The agent's own version, as its program reports it. */
  version?: string;
  /** Whether the agent is signed in, as its own status command says; null when it has none the connector can ask. */
  signedIn?: boolean | null;
  /** The models the connector offers for it, by the agent's own names (Claude Code's aliases, Antigravity's models). */
  models?: string[];
  /** A short note for the person: why it isn't usable, what to run. Never a credential or an account's identity. */
  detail?: string;
};

/**
 * The connector program. `contentDigest` is the digest of the client release
 * it was built from (Octomerge's releases stamp it in; a development build has
 * none): a production build of the same content counts as the version an
 * Octomerge environment targets, as its other programs do.
 */
export type ConnectorInfo = { name: string; version: string; protocol: number; contentDigest?: string | null };

/** `POST register`: the computer, as it calls itself, its connector and its agents. */
export type RegisterRequest = {
  hostApi: number;
  /** A label for the computer, as Octomerge's worker labels: letters, digits, dots, hyphens, underscores. */
  label: string;
  /** `darwin arm64`, `linux x64`, … */
  platform: string;
  connector: ConnectorInfo;
  agents: AgentReport[];
};
export type RegisterResponse = { hostId: string; label: string; hostApi: number };

/**
 * Where a turn stands on the connector. A connector reports a turn in every
 * poll from the moment it accepts its `start` until the server acknowledged
 * its exit: a running turn a poll leaves out, the server takes for lost.
 */
export type TurnProgress = {
  runId: string;
  /** Bytes of standard output the turn wrote so far. */
  outputBytes: number;
  /** The highest input `seq` handed to the turn's standard input. */
  appliedInputSeq: number;
  /**
   * `running` (the default), `stopping` once the connector has the turn's
   * `cancel`, `exited` once its process exited and until the server
   * acknowledged the exit. The server sends `input` and `cancel` only for a
   * running turn, so a poll doesn't come back at once with a command the
   * connector already has.
   */
  state?: "running" | "stopping" | "exited";
};

/**
 * `POST poll`: the host's turns, and its agents when they changed. One poll
 * at a time per host, each built after the previous answer's commands were
 * handled.
 */
export type PollRequest = {
  hostId: string;
  agents?: AgentReport[];
  turns: TurnProgress[];
  /**
   * The connector is stopping, after its turns ended: the server sends no new
   * turn to the host until it polls again, moves the turns waiting to start
   * there to another host, and answers at once.
   */
  closing?: boolean;
};

export type HostCommand =
  /** Start a turn: run `otti-connect turn` (or the connector's equivalent) and wait for its input. */
  | { type: "start"; runId: string }
  /** A line (or the end) of the turn's standard input. `seq` counts from 1 in each turn; write each once, in order. */
  | { type: "input"; runId: string; seq: number; data: string; eof: boolean }
  /** Stop the turn: close its input, and end its process if it doesn't exit soon. */
  | { type: "cancel"; runId: string };

/**
 * The commands come in order (a turn's `start` before its `input`s). The
 * server sends `start` again while polls don't report the turn, and `input`s
 * after `appliedInputSeq` again while it reports the turn running.
 */
export type PollResponse = {
  commands: HostCommand[];
  /**
   * For each turn the request named that the server still has: the output
   * bytes it holds; send what follows them. A turn missing here is unknown
   * or lost: stop it and forget it.
   */
  outputBytes: Record<string, number>;
};

/** `POST output`: a chunk of a turn's standard output, base64, at its byte offset; the exit with the last one. */
export type OutputRequest = {
  hostId: string;
  runId: string;
  offset: number;
  data: string;
  exit?: { code: number | null; signal?: string | null; stderrTail?: string };
};
export type OutputResponse = { outputBytes: number };
