import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { OWN_CALL_INPUT_MAX, OWN_CALL_OUTPUT_MAX, type ImageData } from "../protocol";
import { agentEnvironment, boundedValue, locateExecutable, storableText } from "../util";
import { type AgentFactory, endedTurn } from "./agent";
import { agentCommand, pinnedProgram, type Program } from "./pinned";

/**
 * Codex as `codex app-server` (JSON-RPC 2.0 on stdio), the way t3code and
 * Codex's own apps drive it. The client's tools are the thread's dynamic
 * tools: Codex asks for each call in an `item/tool/call` request, answered
 * with the call's result. The conversation's files are not on this machine:
 * its shell tools are off and its sandbox is read-only. The `codex` is Otti
 * Connect's pinned install in the agents folder (src/install.ts);
 * OTTI_CONNECT_CODEX names another, for development and tests.
 */

/** Variables that would replace the person's own ChatGPT sign-in. */
export const CODEX_REMOVED_ENV = ["OPENAI_API_KEY", "OPENAI_BASE_URL", "CODEX_API_KEY"];
/** Items that are Codex's own tool calls. */
const OWN_CALLS = new Set(["commandExecution", "fileChange", "mcpToolCall", "webSearch", "imageGeneration", "imageView", "collabAgentToolCall"]);

/** The `codex` a turn runs: OTTI_CONNECT_CODEX (a path, or a name on the PATH), else Otti Connect's pinned install. */
export function locateCodex(): Program | null {
  const custom = process.env.OTTI_CONNECT_CODEX;
  if (custom) {
    const file = locateExecutable([custom]);
    return file ? { file, args: [], path: file } : null;
  }
  return pinnedProgram("codex");
}

type Input = { text: string; images: readonly ImageData[] };
type Request = { kind: "initialize" | "thread" | "resume" | "turn" } | ({ kind: "steer" } & Input);

/** What one of Codex's own calls was asked to do. */
function callInput(item: Record<string, any>): unknown {
  switch (item.type) {
    case "commandExecution":
      return { command: item.command, cwd: item.cwd };
    case "fileChange":
      return { changes: Array.isArray(item.changes) ? item.changes.map((change: any) => ({ path: change?.path, kind: change?.kind?.type ?? change?.kind })) : item.changes };
    case "mcpToolCall":
      return { server: item.server, tool: item.tool, arguments: item.arguments };
    case "webSearch":
      return { query: item.query };
    default: {
      const { id: _id, type: _type, status: _status, ...rest } = item;
      return rest;
    }
  }
}

/** What one of Codex's own calls returned. */
function callOutput(item: Record<string, any>) {
  const failed = item.status === "failed" || item.status === "declined" || (typeof item.exitCode === "number" && item.exitCode !== 0);
  const error = failed ? { isError: true } : {};
  switch (item.type) {
    case "commandExecution":
      return { text: String(item.aggregatedOutput ?? ""), ...(typeof item.exitCode === "number" ? { exitCode: item.exitCode } : {}), ...error };
    case "fileChange":
      return { text: Array.isArray(item.changes) ? item.changes.map((change: any) => `${change?.kind?.type ?? change?.kind ?? "change"} ${change?.path ?? ""}\n${change?.diff ?? ""}`).join("\n") : "", ...error };
    case "mcpToolCall":
      return { text: JSON.stringify(item.result ?? item.error ?? null), ...(item.error ? { isError: true } : {}) };
    default: {
      const { id: _id, type: _type, ...rest } = item;
      return { text: "", details: rest, ...error };
    }
  }
}

const inputItems = ({ text, images }: Input) => [
  { type: "text", text, text_elements: [] },
  ...images.map((image) => ({ type: "image", url: `data:${image.mediaType};base64,${image.data}` })),
];

export const codexAgent: AgentFactory = async ({ start, emit, cwd }) => {
  const codex = locateCodex();
  if (!codex) {
    emit({ type: "error", code: "cli_missing", message: "Codex isn't installed for Otti Connect on this computer. Otti Connect installs it when it starts (`otti-connect install` installs it now); then send the message again." });
    return endedTurn(127);
  }
  const child = spawn(codex.file, [...codex.args, "app-server", "--disable", "shell_tool", "--disable", "unified_exec"], {
    cwd,
    env: agentEnvironment(CODEX_REMOVED_ENV),
    stdio: ["pipe", "pipe", "inherit"],
  });
  child.stdin.on("error", () => {});
  const send = (message: unknown) => {
    if (!child.stdin.destroyed && child.stdin.writable) child.stdin.write(`${JSON.stringify(message)}\n`);
  };

  let rpc = 1;
  const requests = new Map<number, Request>();
  const request = (method: string, params: unknown, kind: Request) => {
    const id = rpc++;
    requests.set(id, kind);
    send({ method, id, params });
  };
  let thread: string | undefined;
  let turnId: string | undefined;
  /** Turns started and not completed. */
  let turns = 0;
  /** Messages that wait for the thread or for the next turn. */
  const queued: Input[] = [{ text: start.message.text, images: start.message.images ?? [] }];
  /** The client's tool calls Codex waits for: their `tool_call` id and the JSON-RPC id to answer. */
  const toolCalls = new Map<string, number | string>();
  const open = new Map<string, { name: string; input: unknown }>();
  const streamed = new Set<string>();
  let lastError: string | undefined;
  let failed = false;

  const threadParams = (dynamic: boolean) => ({
    cwd,
    approvalPolicy: "never",
    // Nothing here is the conversation's: Codex may read but writes nothing;
    // the client's tools do the work.
    sandbox: "read-only",
    developerInstructions: `${start.instructions}\n\nHow Octomerge's tools reach you here: they are among your functions.`,
    ...(dynamic ? { serviceName: "Octomerge", dynamicTools: start.tools.map((tool) => ({ type: "function", name: tool.name, description: tool.description, inputSchema: tool.inputSchema })) } : {}),
  });
  const startTurn = () => {
    const next = queued.splice(0);
    if (!next.length || !thread) return;
    turns++;
    request("turn/start", { threadId: thread, input: inputItems({ text: next.map((input) => input.text).join("\n\n"), images: next.flatMap((input) => input.images) }), ...(start.agent.effort ? { effort: start.agent.effort } : {}) }, { kind: "turn" });
  };
  // A failure ends the turn for good; a round's end is reported each time
  // (a message after it starts another round).
  const end = (event: Parameters<typeof emit>[0]) => {
    if (failed) return;
    if (event.type === "error") failed = true;
    emit(event);
  };

  function response(message: Record<string, any>) {
    const kind = requests.get(Number(message.id));
    if (!kind) return;
    requests.delete(Number(message.id));
    const error = message.error ? storableText(String(message.error.message ?? JSON.stringify(message.error))) : null;
    switch (kind.kind) {
      case "initialize":
        if (error) return end({ type: "error", code: "agent_failed", message: `Codex refused Octomerge's setup: ${error}` });
        send({ method: "initialized" });
        if (start.session) request("thread/resume", { threadId: start.session, ...threadParams(false) }, { kind: "resume" });
        else request("thread/start", threadParams(true), { kind: "thread" });
        return;
      case "resume":
      case "thread": {
        if (error && kind.kind === "resume") {
          // The thread is gone from this machine: a new one.
          request("thread/start", threadParams(true), { kind: "thread" });
          return;
        }
        if (error) {
          const auth = /auth|login|sign/i.test(error);
          return end({
            type: "error",
            code: auth ? "not_signed_in" : "agent_failed",
            message: auth
              ? `Codex is not signed in on the computer Otti Connect runs on (${error}). Sign in there with \`${agentCommand("codex", "login", codex)}\` in a terminal, then send the message again.`
              : `Codex could not start its thread: ${error}`,
          });
        }
        const id = message.result?.thread?.id;
        if (typeof id !== "string") return end({ type: "error", code: "agent_failed", message: "Codex started no thread" });
        thread = id;
        emit({ type: "session", id, resumed: kind.kind === "resume" });
        startTurn();
        return;
      }
      case "turn":
        if (error) {
          turns = Math.max(0, turns - 1);
          return end({ type: "turn_end", stopReason: "error", error: `Codex could not start the turn: ${error}` });
        }
        if (typeof message.result?.turn?.id === "string") turnId = message.result.turn.id;
        return;
      case "steer":
        // The turn ended before the message reached it: it starts the next one.
        if (error) {
          queued.push({ text: kind.text, images: kind.images });
          if (!turnId) startTurn();
        }
        return;
    }
  }

  function serverRequest(message: Record<string, any>) {
    const id = message.id;
    const reply = (result: unknown) => send({ id, result });
    const params = message.params ?? {};
    switch (message.method) {
      case "item/tool/call": {
        const callId = `call-${String(id)}`;
        toolCalls.set(callId, id);
        emit({ type: "tool_call", id: callId, ...(typeof params.callId === "string" && params.callId ? { callId: params.callId } : {}), name: String(params.tool ?? ""), input: params.arguments ?? {} });
        return;
      }
      // Approvals are never asked for; one that still comes is accepted as asked.
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
        return reply({ decision: "accept" });
      case "execCommandApproval":
      case "applyPatchApproval":
        return reply({ decision: "approved" });
      case "item/tool/requestUserInput":
        return reply({ answers: {} });
      case "mcpServer/elicitation/request":
        return reply({ action: "decline" });
      default:
        send({ id, error: { code: -32601, message: `Octomerge does not handle ${String(message.method)}` } });
    }
  }

  function notification(message: Record<string, any>) {
    const params = message.params ?? {};
    switch (message.method) {
      case "item/agentMessage/delta":
        if (params.delta) emit({ type: "text", text: storableText(String(params.delta)), block: typeof params.itemId === "string" ? params.itemId : "" });
        if (typeof params.itemId === "string") streamed.add(params.itemId);
        return;
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/textDelta":
        if (params.delta) emit({ type: "thinking", text: storableText(String(params.delta)) });
        if (typeof params.itemId === "string") streamed.add(params.itemId);
        return;
      case "item/started": {
        const item = params.item ?? {};
        if (OWN_CALLS.has(item.type) && typeof item.id === "string" && !open.has(item.id)) {
          const input = boundedValue(callInput(item), OWN_CALL_INPUT_MAX);
          open.set(item.id, { name: item.type, input });
          emit({ type: "tool_started", id: item.id, name: item.type, input });
        }
        return;
      }
      case "item/completed": {
        const item = params.item ?? {};
        if (item.type === "agentMessage" && !streamed.has(item.id) && item.text) emit({ type: "text", text: storableText(String(item.text)), block: String(item.id ?? "") });
        else if (item.type === "reasoning" && !streamed.has(item.id)) {
          const text = [...(item.summary ?? []), ...(item.content ?? [])].map(String).join("\n");
          if (text) emit({ type: "thinking", text: storableText(text) });
        } else if (OWN_CALLS.has(item.type)) {
          const id = String(item.id);
          const call = open.get(id) ?? { name: String(item.type), input: boundedValue(callInput(item), OWN_CALL_INPUT_MAX) };
          open.delete(id);
          emit({ type: "tool_completed", id, name: call.name, input: call.input, output: boundedValue(callOutput(item), OWN_CALL_OUTPUT_MAX) as { text: string } });
        }
        return;
      }
      case "thread/tokenUsage/updated": {
        const last = params.tokenUsage?.last ?? {};
        emit({
          type: "usage",
          inputTokens: Number(last.inputTokens ?? 0) || 0,
          outputTokens: Number(last.outputTokens ?? 0) || 0,
          ...(typeof last.cachedInputTokens === "number" ? { cacheReadTokens: last.cachedInputTokens } : {}),
          ...(typeof last.cacheWriteInputTokens === "number" ? { cacheWriteTokens: last.cacheWriteInputTokens } : {}),
        });
        return;
      }
      case "error":
        if (!params.willRetry) lastError = storableText(String(params.error?.message ?? JSON.stringify(params.error ?? params)));
        return;
      case "turn/completed": {
        turns = Math.max(0, turns - 1);
        turnId = undefined;
        // Messages that waited for the turn start the next one.
        if (queued.length && thread) return startTurn();
        // A steer that turns into a turn of its own is still on its way.
        const steering = [...requests.values()].some((kind) => kind.kind === "steer");
        if (turns > 0 || steering) return;
        const turn = params.turn ?? {};
        if (turn.status === "failed") end({ type: "turn_end", stopReason: "error", error: storableText(String(turn.error?.message ?? lastError ?? "Codex ended the turn with an error")) });
        else if (turn.status === "interrupted") end({ type: "turn_end", stopReason: "cancelled", error: "Codex's turn was interrupted." });
        else end({ type: "turn_end", stopReason: "end_turn" });
        return;
      }
      default:
        return;
    }
  }

  createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => {
    let message: Record<string, any>;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (!message || typeof message !== "object") return;
    if (message.id !== undefined && message.method === undefined) response(message);
    else if (typeof message.method === "string" && message.id !== undefined) serverRequest(message);
    else notification(message);
  });

  const exited = new Promise<number>((resolve) => {
    child.on("error", (error) => {
      end({ type: "error", code: "agent_failed", message: `Codex could not start: ${storableText(error.message)}` });
      resolve(1);
    });
    child.on("close", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });

  request("initialize", { clientInfo: { name: "octomerge", title: "Octomerge", version: "1" }, capabilities: { experimentalApi: true } }, { kind: "initialize" });

  return {
    toolResult(message) {
      const rpcId = toolCalls.get(message.id);
      if (rpcId === undefined) return;
      toolCalls.delete(message.id);
      const contentItems = message.content.map((part) => (part.type === "image" ? { type: "inputImage", imageUrl: `data:${part.mediaType};base64,${part.data}` } : { type: "inputText", text: part.text }));
      send({ id: rpcId, result: { contentItems: contentItems.length ? contentItems : [{ type: "inputText", text: "(no output)" }], success: !message.isError } });
    },
    message(message) {
      const input = { text: message.text, images: message.images ?? [] };
      // Before the thread, or between a turn's start and its ID, the message
      // waits: it starts the thread's next turn, at once when none runs.
      if (!thread || !turnId) {
        queued.push(input);
        if (thread && turns === 0 && !failed) startTurn();
        return;
      }
      request("turn/steer", { threadId: thread, expectedTurnId: turnId, input: inputItems(input) }, { kind: "steer", ...input });
    },
    close() {
      child.stdin.end();
      // app-server exits when its input closes; one that doesn't is stopped.
      setTimeout(() => child.kill("SIGTERM"), 10_000).unref();
    },
    exited,
  };
};
