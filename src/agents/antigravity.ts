import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { OWN_CALL_INPUT_MAX, OWN_CALL_OUTPUT_MAX, type ImageData, type ToolResultMessage } from "../protocol";
import { agentEnvironment, boundedValue, locateExecutable, storableText, textWithImageNote } from "../util";
import { type AgentFactory, endedTurn, mcpContent, UNANSWERED } from "./agent";
import { antigravityTools } from "./gemini-schema";
import { agentCommand, pinnedProgram, type Program } from "./pinned";

/**
 * Google Antigravity's CLI as `agy acp`, the Agent Client Protocol server
 * Zed, JetBrains IDEs and t3code drive (JSON-RPC 2.0 on stdio). The client's
 * tools reach it as an MCP server, `octomerge`, served over HTTP on the
 * loopback interface behind a token only this process and the CLI know
 * (`mcp_octomerge_*` to the CLI). The conversation's files are not on this
 * machine: a PreToolUse hook in the CLI's empty working folder denies its own
 * file and terminal tools. The `agy` is Otti Connect's pinned install in the
 * agents folder (src/install.ts); OTTI_CONNECT_AGY names another, for
 * development and tests.
 */

/** Variables that would replace the person's own Google sign-in. */
export const AGY_REMOVED_ENV = ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GEMINI_BASE_URL", "AGY_ADC_AUTH"];
/** Otti Connect's copy of agy stays at the version Octomerge tested: agy otherwise updates itself in the background. */
export const AGY_ADDED_ENV = { AGY_CLI_DISABLE_AUTO_UPDATE: "1" };
/** agy's own file and terminal tools (1.5.16), denied by the workspace's hook. */
const OWN_FILE_TOOLS = "^(run_command|read_file|edit_file|write_file|manage_task|run_workflow|view_file|write_to_file|replace_file_content|multi_replace_file_content|list_dir|find_by_name|grep_search)$";

type Input = { text: string; images: readonly ImageData[] };
type Request = { kind: "initialize" | "session" | "resume" | "prompt" } | { kind: "config"; next: string[] };

/** A call of the client's tools as the CLI announces it: the CLI's own calls are reported, not these. */
const isClientCall = (update: Record<string, any>) => /\bmcp_octomerge_/.test(String(update.title ?? ""));

/** One of the agent's own tool calls: its tool name and arguments, with the command, file or query it acts on. */
function callOf(update: Record<string, any>) {
  const name = typeof update.name === "string" && update.name ? update.name : String(update.kind ?? "tool");
  const raw = update.args ?? update.rawInput;
  const args: Record<string, unknown> = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const text = (value: unknown) => (typeof value === "string" && value.trim() ? value : undefined);
  const command = text(args.CommandLine), path = text(args.Path ?? args.AbsolutePath ?? args.TargetFile), query = text(args.query ?? args.Query);
  return {
    name,
    input: boundedValue({
      ...(command ? { command } : {}),
      ...(path ? { path } : {}),
      ...(query ? { query } : {}),
      ...(!command && !path && !query && text(update.title) ? { description: update.title } : {}),
      args,
    }, OWN_CALL_INPUT_MAX),
  };
}

function outputOf(update: Record<string, any>) {
  const parts: string[] = [];
  for (const entry of Array.isArray(update.content) ? update.content : []) {
    if (entry?.type === "content" && entry.content?.type === "text") parts.push(String(entry.content.text ?? ""));
    else if (entry?.type === "diff") parts.push(`${entry.path ?? ""}\n${entry.newText ?? ""}`);
    else if (entry?.type === "terminal") parts.push(`(terminal ${String(entry.terminalId ?? "")})`);
  }
  return {
    text: String(boundedValue(parts.join("\n"), OWN_CALL_OUTPUT_MAX) ?? ""),
    ...(update.status === "failed" ? { isError: true } : {}),
    ...(update.rawOutput !== undefined ? { details: boundedValue(update.rawOutput, OWN_CALL_OUTPUT_MAX) } : {}),
  };
}

/** The `agy` a turn runs: OTTI_CONNECT_AGY (a path, or a name on the PATH), else Otti Connect's pinned install. */
export function locateAgy(): Program | null {
  const custom = process.env.OTTI_CONNECT_AGY;
  if (custom) {
    const file = locateExecutable([custom]);
    return file ? { file, args: [], path: file } : null;
  }
  return pinnedProgram("antigravity");
}

/**
 * A PreToolUse hook in the agent's own working folder that denies agy's own
 * file and terminal tools. Hooks are the workspace's own configuration:
 * nothing of the person's is changed.
 */
function denyOwnTools(cwd: string): void {
  const reason = "On this machine your own file and terminal tools are turned off: the files and commands of this conversation are on its worker. Use the tools of the MCP server octomerge instead (mcp_octomerge_shell, mcp_octomerge_read, mcp_octomerge_write, mcp_octomerge_edit, mcp_octomerge_grep, mcp_octomerge_find, mcp_octomerge_ls).";
  const decision = JSON.stringify({ decision: "deny", reason });
  mkdirSync(join(cwd, ".agents"), { recursive: true });
  writeFileSync(join(cwd, ".agents", "hooks.json"), `${JSON.stringify({
    "octomerge-own-tools-off": {
      PreToolUse: [{ matcher: OWN_FILE_TOOLS, hooks: [{ type: "command", command: `cat >/dev/null; printf '%s\\n' '${decision}'`, timeout: 10 }] }],
    },
  }, null, 2)}\n`);
}

export const antigravityAgent: AgentFactory = async ({ start, emit, cwd }) => {
  const agy = locateAgy();
  if (!agy) {
    emit({ type: "error", code: "cli_missing", message: "Antigravity's CLI isn't installed for Otti Connect on this computer. Otti Connect installs it when it starts (`otti-connect install` installs it now); then send the message again." });
    return endedTurn(127);
  }
  denyOwnTools(cwd);

  const { offered, left } = antigravityTools(start.tools);
  // The client's tool calls the CLI waits for, by the id of their `tool_call`.
  const waiting = new Map<string, (result: ToolResultMessage) => void>();
  let calls = 0;
  let ended = false;
  const token = randomBytes(24).toString("hex");

  // The client's tools as a minimal MCP server (streamable HTTP, JSON responses, no sessions).
  const server = createServer((request, response: ServerResponse) => {
    if (request.headers.authorization !== `Bearer ${token}`) return void response.writeHead(401).end();
    if (request.method !== "POST") return void response.writeHead(405, { Allow: "POST" }).end();
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      let message: Record<string, any>;
      try {
        message = JSON.parse(raw);
      } catch {
        return void response.writeHead(400).end();
      }
      if (!message || typeof message !== "object" || Array.isArray(message)) return void response.writeHead(400).end();
      // Notifications and responses: accepted.
      if (message.id === undefined || message.method === undefined) return void response.writeHead(202).end();
      const reply = (body: Record<string, unknown>) => {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, ...body }));
      };
      const params = message.params ?? {};
      switch (message.method) {
        case "initialize":
          return reply({ result: { protocolVersion: params.protocolVersion || "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "octomerge", version: "1" } } });
        case "ping":
          return reply({ result: {} });
        case "tools/list":
          return reply({ result: { tools: offered } });
        case "tools/call": {
          const id = `call-${++calls}`;
          const answer = (result: ToolResultMessage) => reply({ result: { content: mcpContent(result.content), isError: result.isError === true } });
          if (ended) return answer(UNANSWERED);
          waiting.set(id, answer);
          response.on("close", () => waiting.delete(id));
          emit({ type: "tool_call", id, name: String(params.name ?? ""), input: params.arguments ?? {} });
          return;
        }
        default:
          return reply({ error: { code: -32601, message: "Method not found" } });
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const mcpServer = { type: "http", name: "octomerge", url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, headers: [{ name: "Authorization", value: `Bearer ${token}` }] };

  const child = spawn(agy.file, [...agy.args, "acp", "--dangerously-skip-permissions", "--disable-telemetry"], { cwd, env: agentEnvironment(AGY_REMOVED_ENV, AGY_ADDED_ENV), stdio: ["pipe", "pipe", "inherit"] });
  child.stdin.on("error", () => {});
  const send = (message: unknown) => {
    if (!child.stdin.destroyed && child.stdin.writable) child.stdin.write(`${JSON.stringify(message)}\n`);
  };
  let rpc = 1;
  const requests = new Map<number, Request>();
  const request = (method: string, params: unknown, kind: Request) => {
    const id = rpc++;
    requests.set(id, kind);
    send({ jsonrpc: "2.0", id, method, params });
  };

  let session: string | undefined;
  /** Prompts sent and not answered. */
  let turns = 0;
  const queued: Input[] = [{ text: start.message.text, images: start.message.images ?? [] }];
  let promptImages = false;
  let failed = false;
  /** The session is set up (its model and thinking level too): messages go to it as prompts. */
  let ready = false;
  const open = new Map<string, { name: string; input: unknown }>();

  const end = (event: Parameters<typeof emit>[0]) => {
    if (failed) return;
    if (event.type === "error") failed = true;
    emit(event);
  };
  const instructions = [
    start.instructions,
    "How Octomerge's tools reach you here: they are the tools of the MCP server `octomerge` (named mcp_octomerge_*).",
    ...(left.length ? [`Antigravity's CLI takes only part of a large MCP server's tools, so these of Octomerge's tools are not offered to you here: ${left.join(", ")}.`] : []),
  ].join("\n\n");
  const sessionParams = () => ({ cwd, mcpServers: [mcpServer], _meta: { antigravity: { systemPrompt: { append: instructions } } } });
  const prompt = () => {
    const next = queued.splice(0);
    if (!next.length || !session) return;
    const images = next.flatMap((input) => input.images);
    const text = next.map((input) => input.text).join("\n\n");
    turns++;
    request("session/prompt", {
      sessionId: session,
      prompt: [
        { type: "text", text: promptImages ? text : textWithImageNote(text, images.length, "Antigravity's CLI does not take images in a message") },
        ...(promptImages ? images.map((image) => ({ type: "image", data: image.data, mimeType: image.mediaType })) : []),
      ],
    }, { kind: "prompt" });
  };
  /** After the session: its model and thinking level, then the turn's prompt. */
  const configure = (options: string[]) => {
    const [first, ...rest] = options;
    if (!first) {
      ready = true;
      return prompt();
    }
    const [configId, value] = first.split("=", 2) as [string, string];
    request("session/set_config_option", { sessionId: session, configId, value }, { kind: "config", next: rest });
  };
  const configOptions = () => [...(start.agent.model ? [`model=${start.agent.model}`] : []), ...(start.agent.effort ? [`thought_level=${start.agent.effort}`] : [])];

  function response(message: Record<string, any>) {
    const kind = requests.get(Number(message.id));
    if (!kind) return;
    requests.delete(Number(message.id));
    const error = message.error ? storableText(String(message.error.message ?? JSON.stringify(message.error))) : null;
    switch (kind.kind) {
      case "initialize":
        if (error) return end({ type: "error", code: "agent_failed", message: `Antigravity refused Octomerge's setup: ${error}` });
        promptImages = message.result?.agentCapabilities?.promptCapabilities?.image === true;
        if (start.session) request("session/resume", { sessionId: start.session, ...sessionParams() }, { kind: "resume" });
        else request("session/new", sessionParams(), { kind: "session" });
        return;
      case "resume":
        if (error) {
          // The session is gone from this machine: a new one.
          request("session/new", sessionParams(), { kind: "session" });
          return;
        }
        session = start.session;
        emit({ type: "session", id: session!, resumed: true });
        return configure(configOptions());
      case "session": {
        if (error) return end({ type: "error", code: /auth/i.test(error) ? "not_signed_in" : "agent_failed", message: /auth/i.test(error)
          ? `Antigravity is not signed in on the computer Otti Connect runs on (${error}). Sign in there with \`${agentCommand("antigravity", "acp --login", agy)}\` in a terminal, then send the message again.`
          : `Antigravity could not start its session: ${error}` });
        const id = message.result?.sessionId;
        if (typeof id !== "string") return end({ type: "error", code: "agent_failed", message: "Antigravity started no session" });
        session = id;
        emit({ type: "session", id, resumed: false });
        return configure(configOptions());
      }
      case "config":
        return configure(kind.next);
      case "prompt": {
        turns = Math.max(0, turns - 1);
        if (error) return end({ type: "turn_end", stopReason: "error", error: `Antigravity's turn failed: ${error}` });
        if (turns > 0) return;
        // Messages that waited for the turn start the next one.
        if (queued.length && session) return prompt();
        const reason = String(message.result?.stopReason ?? "end_turn");
        return end(reason === "end_turn" ? { type: "turn_end", stopReason: reason }
          : reason === "cancelled" ? { type: "turn_end", stopReason: reason, error: "Antigravity's turn was cancelled." }
          : reason === "refusal" ? { type: "turn_end", stopReason: reason, error: "Antigravity refused to continue." }
          : { type: "turn_end", stopReason: reason, error: `Antigravity ended the turn early (${reason}).` });
      }
    }
  }

  function update(params: Record<string, any>) {
    const change = params.update ?? {};
    switch (change.sessionUpdate) {
      case "agent_message_chunk":
        if (change.content?.type === "text" && change.content.text) emit({ type: "text", text: storableText(String(change.content.text)), block: String(change.messageId ?? "") });
        return;
      case "agent_thought_chunk":
        if (change.content?.type === "text" && change.content.text) emit({ type: "thinking", text: storableText(String(change.content.text)) });
        return;
      case "tool_call":
      case "tool_call_update": {
        const id = typeof change.toolCallId === "string" ? change.toolCallId : null;
        if (!id) return;
        let call = open.get(id);
        if (!call && change.sessionUpdate === "tool_call" && !isClientCall(change)) {
          call = callOf(change);
          open.set(id, call);
          emit({ type: "tool_started", id, name: call.name, input: call.input });
        }
        if (call && (change.status === "completed" || change.status === "failed")) {
          open.delete(id);
          emit({ type: "tool_completed", id, name: call.name, input: call.input, output: outputOf(change) });
        }
        return;
      }
      case "usage_update": {
        const used = Number(change.used ?? change.usage?.inputTokens ?? 0) || 0;
        if (used) emit({ type: "usage", inputTokens: used, outputTokens: Number(change.usage?.outputTokens ?? 0) || 0 });
        return;
      }
      default:
        return;
    }
  }

  /** A request of the agent's, answered at once: no client methods are served, and permissions are skipped at launch. */
  function agentRequest(message: Record<string, any>) {
    const id = message.id, params = message.params ?? {};
    if (message.method === "session/request_permission") {
      // One that still comes is allowed as asked.
      const options = Array.isArray(params.options) ? params.options : [];
      const allow = options.find((option: any) => String(option?.kind ?? "").startsWith("allow")) ?? options[0];
      return send({ jsonrpc: "2.0", id, result: allow ? { outcome: { outcome: "selected", optionId: allow.optionId } } : { outcome: { outcome: "cancelled" } } });
    }
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Octomerge does not handle ${String(message.method)}` } });
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
    else if (typeof message.method === "string" && message.id !== undefined) agentRequest(message);
    else if (message.method === "session/update") update(message.params ?? {});
  });

  const exited = new Promise<number>((resolve) => {
    child.on("error", (error) => {
      end({ type: "error", code: "agent_failed", message: `Antigravity's CLI could not start: ${storableText(error.message)}` });
      server.close();
      resolve(1);
    });
    child.on("close", (code, signal) => {
      server.close();
      resolve(code ?? (signal ? 1 : 0));
    });
  });

  request("initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    clientInfo: { name: "octomerge", title: "Octomerge", version: "1" },
  }, { kind: "initialize" });

  return {
    toolResult(message) {
      const answer = waiting.get(message.id);
      if (!answer) return;
      waiting.delete(message.id);
      answer(message);
    },
    message(message) {
      queued.push({ text: message.text, images: message.images ?? [] });
      // agy steers a running turn with the next prompt (1.5 and newer); an
      // idle session takes it as its next prompt at once. Before the session
      // is set up it waits.
      if (ready && !failed) prompt();
    },
    close() {
      ended = true;
      for (const answer of waiting.values()) answer(UNANSWERED);
      waiting.clear();
      child.stdin.end();
    },
    exited,
  };
};
