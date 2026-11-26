import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { AGENT_LABELS, type AgentFactory, type AgentTurn } from "./agents/agent";
import { antigravityAgent } from "./agents/antigravity";
import { claudeAgent } from "./agents/claude";
import { codexAgent } from "./agents/codex";
import { type AgentKind, type ClientMessage, PROTOCOL_VERSION, type StartMessage } from "./protocol";
import { CONNECTOR, createEmit, type Emit } from "./util";

const AGENTS: Record<AgentKind, AgentFactory> = { "claude-code": claudeAgent, codex: codexAgent, antigravity: antigravityAgent };

/** A folder name made safe: what the workspace's `folder` becomes under the connector's own folder. */
function safeFolder(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "turn";
}

/**
 * One turn (PROTOCOL.md): reads the client's lines from stdin and writes the
 * events to stdout until the client closes stdin and the agent has exited.
 * Resolves with the exit status.
 */
export async function runTurn(): Promise<number> {
  const emit: Emit = createEmit((line) => process.stdout.write(line));
  let agent: AgentTurn | null = null;
  let closed = false;
  // Lines that came after the start, before the agent was ready for them.
  const early: ClientMessage[] = [];
  let resolveStart: (start: StartMessage | null) => void = () => {};
  const started = new Promise<StartMessage | null>((resolve) => (resolveStart = resolve));
  let seenStart = false;

  const dispatch = (message: ClientMessage) => {
    if (message.type === "message") {
      // The client ends the turn at a turn_end only once its messages are received.
      emit({ type: "received", id: message.id });
      agent!.message(message);
    } else if (message.type === "tool_result") agent!.toolResult(message);
  };
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on("line", (line) => {
    let message: ClientMessage;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (!message || typeof message !== "object") return;
    if (!seenStart) {
      if (message.type !== "start") return;
      seenStart = true;
      resolveStart(message);
      return;
    }
    if (message.type !== "message" && message.type !== "tool_result") return;
    if (agent) dispatch(message);
    else early.push(message);
  });
  lines.on("close", () => {
    closed = true;
    if (!seenStart) resolveStart(null);
    agent?.close();
  });

  const start = await started;
  if (!start) return 0;
  const kind = start.agent?.kind;
  const label = kind && kind in AGENTS ? AGENT_LABELS[kind] : String(kind ?? "agent");
  emit({ type: "hello", protocol: PROTOCOL_VERSION, connector: { ...CONNECTOR }, agent: { kind, label } });
  if (start.protocol !== PROTOCOL_VERSION) {
    emit({ type: "error", code: "protocol_unsupported", message: `This connector (${CONNECTOR.name} ${CONNECTOR.version}) speaks protocol version ${PROTOCOL_VERSION}, not ${String(start.protocol)}. Install the connector that goes with this version of Octomerge.` });
    return 2;
  }
  if (!kind || !(kind in AGENTS)) {
    emit({ type: "error", code: "agent_unsupported", message: `This connector (${CONNECTOR.name} ${CONNECTOR.version}) doesn't drive ${String(kind)}.` });
    return 2;
  }
  let cwd: string;
  try {
    // Nothing on this machine is the conversation's: the agent works in an empty folder of its own.
    cwd = join(process.env.TMPDIR || tmpdir(), "otti-connect", safeFolder(String(start.workspace?.folder ?? "")));
    mkdirSync(cwd, { recursive: true });
    process.chdir(cwd);
  } catch (error) {
    emit({ type: "error", code: "bad_message", message: `The connector could not enter the agent's working folder: ${(error as Error).message}` });
    return 2;
  }
  agent = await AGENTS[kind]({ start, emit, cwd });
  for (const message of early.splice(0)) dispatch(message);
  if (closed) agent.close();
  return agent.exited;
}
