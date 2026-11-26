import type { StartMessage, ToolContent, ToolResultMessage, UserMessage } from "../protocol";
import type { Emit } from "../util";

/**
 * What an agent's turn gets: the start message, the way to the client, and
 * where it works. The conversation's files are never on this machine: the
 * agent's own file and shell tools are off, and the client's tools do that
 * work.
 */
export type AgentContext = {
  start: StartMessage;
  emit: Emit;
  /** The empty folder of its own the agent works in. */
  cwd: string;
};

/** One turn of an agent CLI, as the connector drives it. */
export interface AgentTurn {
  toolResult(message: ToolResultMessage): void;
  message(message: UserMessage): void;
  /** The client closed the input: the agent finishes, answers what still waits with an error, and exits. */
  close(): void;
  /** The connector's exit status, once the agent has exited. */
  readonly exited: Promise<number>;
}

export type AgentFactory = (context: AgentContext) => Promise<AgentTurn>;

export const AGENT_LABELS = { "claude-code": "Claude Code", codex: "Codex", antigravity: "Antigravity" } as const;

/** A turn that already ended (the agent could not start): it only waits for the client to close the input. */
export function endedTurn(status: number): AgentTurn {
  return { toolResult() {}, message() {}, close() {}, exited: Promise.resolve(status) };
}

/** The answer a tool call gets when the turn ends before the client answered it. */
export const UNANSWERED: ToolResultMessage = {
  type: "tool_result",
  id: "",
  content: [{ type: "text", text: "Octomerge's run ended before this tool returned." }],
  isError: true,
};

/** A tool result's content as MCP content blocks. */
export function mcpContent(content: readonly ToolContent[]): Array<Record<string, unknown>> {
  const blocks = content.map((part) => (part.type === "image" ? { type: "image", data: part.data, mimeType: part.mediaType } : { type: "text", text: part.text }));
  return blocks.length ? blocks : [{ type: "text", text: "(no output)" }];
}
