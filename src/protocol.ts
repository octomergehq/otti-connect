/**
 * The Octomerge connector protocol, version 1 (PROTOCOL.md): how a client
 * (Octomerge) drives one turn of a coding agent CLI through a connector.
 *
 * One connector process serves one turn. The client writes JSON lines to the
 * connector's input and reads JSON lines from its output; closing the input
 * ends the turn. Everything the agent CLI itself speaks (Claude Code's SDK
 * messages, Codex's app-server JSON-RPC, the Agent Client Protocol of
 * Antigravity's CLI) stays inside the connector.
 *
 * This file has no imports, so a client can use it as it is.
 */

export const PROTOCOL_VERSION = 1;

/** The agent CLIs this version of the protocol names. */
export type AgentKind = "claude-code" | "codex" | "antigravity";

/** An image, base64-encoded: image/png, image/jpeg, image/gif or image/webp. */
export type ImageData = { data: string; mediaType: string };

/** One of the client's tools, which the agent may call (`tool_call`). */
export type ToolSpec = { name: string; description: string; inputSchema: Record<string, unknown> };

/** What a tool call returned, as the agent is shown it. */
export type ToolContent = { type: "text"; text: string } | ({ type: "image" } & ImageData);

// ---------------------------------------------------------------------------
// Client to connector
// ---------------------------------------------------------------------------

/** The turn's first line: who the agent is, where it works, what it is told and its first message. */
export type StartMessage = {
  type: "start";
  /** The protocol version the client speaks. */
  protocol: number;
  /** The turn's identity, the same each time the client starts it again, and the identity of its first message. */
  turn: { id: string; messageId: string };
  agent: { kind: AgentKind; model?: string; effort?: string };
  /**
   * Where the agent works. The files it works on are not on this machine:
   * its own file and shell tools are turned off, and it does that work with
   * the client's tools. It runs in an empty folder of its own, which
   * `folder` names (the same for every turn of a conversation).
   */
  workspace: { folder: string };
  /** The agent's session to continue, as a `session` event of an earlier turn named it. */
  session?: string;
  /** Appended to the agent's own system prompt. */
  instructions: string;
  /** The client's tools the agent may call. */
  tools: ToolSpec[];
  /** The turn's first message. */
  message: { text: string; images?: ImageData[] };
};

/** The answer to a `tool_call` with the same `id`. */
export type ToolResultMessage = { type: "tool_result"; id: string; content: ToolContent[]; isError?: boolean };

/** A message for the agent while its turn goes on. `id` identifies it. */
export type UserMessage = { type: "message"; id: string; text: string; images?: ImageData[] };

export type ClientMessage = StartMessage | ToolResultMessage | UserMessage;

// ---------------------------------------------------------------------------
// Connector to client: each line is one event with `seq`, counting from 1
// ---------------------------------------------------------------------------

/** The first event: the protocol version the connector speaks, the connector and the agent. */
export type HelloEvent = {
  type: "hello";
  protocol: number;
  connector: { name: string; version: string; contentDigest?: string | null };
  agent: { kind: AgentKind; label: string; version?: string };
};
/** The agent's session, to continue in a later turn; `resumed`: the start's session was continued. */
export type SessionEvent = { type: "session"; id: string; resumed: boolean };
/** Answer text. A new `block` (a message or item of the agent's) starts a new paragraph. */
export type TextEvent = { type: "text"; text: string; block?: string };
export type ThinkingEvent = { type: "thinking"; text: string };
/** One of the agent's own tools started. */
export type ToolStartedEvent = { type: "tool_started"; id: string; name: string; input: unknown };
/** One of the agent's own tools returned; one that never had a `tool_started` started and returned at once. */
export type ToolCompletedEvent = { type: "tool_completed"; id: string; name: string; input: unknown; output: ToolOutput };
export type ToolOutput = { text: string; isError?: boolean; exitCode?: number; details?: unknown };
/**
 * The agent calls one of the client's tools and waits for the `tool_result`
 * with this `id`. `callId` is the agent's own identity of the call, when it
 * has one that is unique beyond this turn.
 */
export type ToolCallEvent = { type: "tool_call"; id: string; callId?: string; name: string; input: unknown };
/** The tokens of the agent's latest model request. */
export type UsageEvent = { type: "usage"; inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number };
/** The agent answered, but background work it started keeps the turn open. */
export type WaitingEvent = { type: "waiting"; tasks: Array<{ id: string; description: string }> };
/** The agent works again after `waiting`. */
export type WorkingEvent = { type: "working" };
/**
 * The connector took in the client's `message` with this id. One it takes in
 * after a `turn_end` starts another round of the turn, which ends with
 * another `turn_end`: a client that wrote a message ends the turn only at a
 * `turn_end` that follows that message's `received`.
 */
export type ReceivedEvent = { type: "received"; id: string };
/** The turn ended: nothing is left to answer. `text` is the final answer when no `text` events carried it. */
export type TurnEndEvent = { type: "turn_end"; stopReason: string; error?: string; text?: string };
/** The turn cannot go on. */
export type ErrorEvent = { type: "error"; code: ErrorCode; message: string };
export type ErrorCode =
  | "protocol_unsupported"
  | "agent_unsupported"
  | "bad_message"
  | "cli_missing"
  | "not_signed_in"
  | "agent_failed";

export type ConnectorEventBody =
  | HelloEvent
  | SessionEvent
  | TextEvent
  | ThinkingEvent
  | ToolStartedEvent
  | ToolCompletedEvent
  | ToolCallEvent
  | UsageEvent
  | WaitingEvent
  | WorkingEvent
  | ReceivedEvent
  | TurnEndEvent
  | ErrorEvent;
export type ConnectorEvent = ConnectorEventBody & { seq: number };

/** The longest line either side writes, in bytes. */
export const MAX_LINE_BYTES = 32 * 1024 * 1024;
/** How long the connector reports the input and output of the agent's own tool calls, at most, in characters. */
export const OWN_CALL_INPUT_MAX = 6_000;
export const OWN_CALL_OUTPUT_MAX = 12_000;
