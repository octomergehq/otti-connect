import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { OWN_CALL_INPUT_MAX, OWN_CALL_OUTPUT_MAX, type ImageData, type ToolResultMessage } from "../protocol";
import { agentEnvironment, boundedText, boundedValue, CONNECTOR, storableText } from "../util";
import { type AgentFactory, endedTurn, mcpContent, UNANSWERED } from "./agent";
import { installedDir, sdkClaudeBuild, sdkEntry } from "./pinned";

/**
 * Claude Code through the Claude Agent SDK: the SDK's `query()` with
 * streaming input, the client's tools as an in-process MCP server named
 * `octomerge`, and none of Claude Code's own tools: the conversation's files
 * are not on this machine. The SDK's messages have the shapes of Claude
 * Code's stream-json output.
 *
 * The SDK, the MCP SDK and zod are Otti Connect's pinned install of Claude
 * Code in the agents folder (src/install.ts). The SDK brings the Claude Code
 * build it drives. For development and tests, OTTI_CONNECT_HOME names another
 * folder that holds the SDK, and OTTI_CONNECT_CLAUDE another `claude` to
 * drive.
 */

/** Variables that would replace the person's own Claude sign-in. */
export const CLAUDE_REMOVED_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"];
/** Otti Connect's copy of Claude Code stays at the version Octomerge tested: it doesn't update itself. */
export const CLAUDE_ADDED_ENV = { DISABLE_AUTOUPDATER: "1" };
const SDK = "@anthropic-ai/claude-agent-sdk";
const MCP_PREFIX = "mcp__octomerge__";

type Loaded = { sdk: any; McpServer: any; types: any };

/** Where the Agent SDK is: OTTI_CONNECT_HOME when it is set, else Otti Connect's pinned install. */
function sdkHome(): string | null {
  return process.env.OTTI_CONNECT_HOME || installedDir("claude-code");
}

/** The Agent SDK in its home: its entry, its version and the Claude Code build it brings. */
export type SdkLocation = { home: string; entry: string; version?: string; claudeCodeVersion?: string };

/**
 * The Agent SDK a turn would load, without loading it, when it and what the
 * connector loads with it (the MCP SDK and zod) resolve in its home. The
 * SDK's package names the Claude Code build it brings (`claudeCodeVersion`).
 */
export function locateSdk(): SdkLocation | null {
  const home = sdkHome();
  if (!home) return null;
  try {
    const require = createRequire(join(home, "package.json"));
    const entry = sdkEntry(home);
    if (!entry) return null;
    require.resolve("@modelcontextprotocol/sdk/server/mcp.js");
    require.resolve("@modelcontextprotocol/sdk/types.js");
    require.resolve("zod");
    const meta = JSON.parse(readFileSync(join(dirname(entry), "package.json"), "utf8")) as { name?: unknown; version?: unknown; claudeCodeVersion?: unknown };
    if (meta.name !== SDK) return null;
    return {
      home,
      entry,
      ...(typeof meta.version === "string" ? { version: meta.version } : {}),
      ...(typeof meta.claudeCodeVersion === "string" ? { claudeCodeVersion: meta.claudeCodeVersion } : {}),
    };
  } catch {
    return null;
  }
}

/** The `claude` a turn runs: OTTI_CONNECT_CLAUDE, else the Claude Code build the SDK brings. Null when there is none. */
export function claudeExecutable(sdk: SdkLocation): string | null {
  return process.env.OTTI_CONNECT_CLAUDE || sdkClaudeBuild(sdk.entry);
}

async function loadSdk(): Promise<Loaded | null> {
  const home = sdkHome();
  if (!home) return null;
  try {
    const require = createRequire(join(home, "package.json"));
    const load = (name: string) => import(pathToFileURL(require.resolve(name)).href);
    const sdk = await load(SDK);
    const { McpServer } = await load("@modelcontextprotocol/sdk/server/mcp.js");
    const types = await load("@modelcontextprotocol/sdk/types.js");
    return { sdk, McpServer, types };
  } catch {
    return null;
  }
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content === undefined || content === null ? "" : JSON.stringify(content);
  return content
    .map((block) => {
      const type = block && typeof block === "object" ? (block as { type?: unknown }).type : undefined;
      return type === "text" ? String((block as { text?: unknown }).text ?? "") : type === "image" ? "[image]" : "";
    })
    .filter(Boolean)
    .join("\n");
}

function usageOf(usage: Record<string, unknown> | undefined) {
  const read = Number(usage?.cache_read_input_tokens ?? 0) || 0, written = Number(usage?.cache_creation_input_tokens ?? 0) || 0;
  return { inputTokens: (Number(usage?.input_tokens ?? 0) || 0) + read + written, outputTokens: Number(usage?.output_tokens ?? 0) || 0, cacheReadTokens: read, cacheWriteTokens: written };
}

const userMessage = (text: string, images: readonly ImageData[], uuid: string) => ({
  type: "user",
  message: {
    role: "user",
    content: [
      { type: "text", text },
      ...images.map((image) => ({ type: "image", source: { type: "base64", media_type: image.mediaType, data: image.data } })),
    ],
  },
  parent_tool_use_id: null,
  uuid,
});

export const claudeAgent: AgentFactory = async ({ start, emit, cwd }) => {
  const loaded = await loadSdk();
  if (!loaded) {
    emit({
      type: "error",
      code: "cli_missing",
      message: "Claude Code isn't installed for Otti Connect on this computer. Otti Connect installs it when it starts (`otti-connect install` installs it now); then send the message again.",
    });
    return endedTurn(127);
  }
  const { sdk, McpServer, types } = loaded;

  // The client's tool calls the agent waits for, by the id of their `tool_call`.
  const waiting = new Map<string, (result: ToolResultMessage) => void>();
  const queue: unknown[] = [];
  let wake: (() => void) | null = null;
  let ended = false;
  // Messages written to Claude Code and not yet taken in, the turn's own first: a
  // result before that belongs to something else (the notice of a background
  // command a previous process left behind), and a result while one is
  // unread starts another round.
  const unread = new Set<string>([start.turn.messageId]);
  let tasks: Array<{ id: string; description: string }> = [];
  let waitingNow = false;
  let usage: ReturnType<typeof usageOf> | undefined;
  // Messages whose deltas were streamed, so their complete blocks are not sent twice.
  const streamed = new Set<string>();
  let current: string | undefined;
  const open = new Map<string, { name: string; input: unknown }>();
  let calls = 0;

  async function* prompt() {
    yield userMessage(start.message.text, start.message.images ?? [], start.turn.messageId);
    for (;;) {
      while (queue.length) yield queue.shift();
      if (ended) return;
      await new Promise<void>((resolve) => (wake = resolve));
      wake = null;
    }
  }

  // The client's tools: each call goes to the client, which answers with `tool_result`.
  const server = new McpServer({ name: "octomerge", version: "1" }, { capabilities: { tools: {} } });
  server.server.setRequestHandler(types.ListToolsRequestSchema, async () => ({
    tools: start.tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
  }));
  server.server.setRequestHandler(types.CallToolRequestSchema, async (request: any) => {
    const id = `call-${++calls}`;
    const meta = (request.params && request.params._meta) || {};
    const answer = ended ? Promise.resolve(UNANSWERED) : new Promise<ToolResultMessage>((resolve) => waiting.set(id, resolve));
    if (!ended) {
      const toolUseId = meta["claudecode/toolUseId"];
      emit({ type: "tool_call", id, ...(typeof toolUseId === "string" && toolUseId ? { callId: toolUseId } : {}), name: String(request.params?.name ?? ""), input: request.params?.arguments ?? {} });
    }
    const result = await answer;
    return { content: mcpContent(result.content), ...(result.isError ? { isError: true } : {}) };
  });

  const notes = [
    "How Octomerge's tools reach you here: they are the tools of the MCP server `octomerge` (named mcp__octomerge__*; your tool search finds them).",
  ];
  const claudePath = process.env.OTTI_CONNECT_CLAUDE;
  const query = sdk.query({
    prompt: prompt(),
    options: {
      cwd,
      ...(start.agent.model ? { model: start.agent.model } : {}),
      ...(start.agent.effort ? { effort: start.agent.effort } : {}),
      ...(start.session ? { resume: start.session } : {}),
      // The files are not on this machine: Claude Code's own tools are off.
      tools: [],
      mcpServers: { octomerge: { type: "sdk", name: "octomerge", instance: server } },
      allowedTools: ["mcp__octomerge"],
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      systemPrompt: { type: "preset", preset: "claude_code", append: `${start.instructions}\n\n${notes.join("\n\n")}` },
      includePartialMessages: true,
      // Our messages come back when Claude Code takes them in, which tells a
      // message it read during the turn from one it will answer after it.
      extraArgs: { "replay-user-messages": null },
      env: agentEnvironment(CLAUDE_REMOVED_ENV, { ...CLAUDE_ADDED_ENV, MCP_TOOL_TIMEOUT: "86400000", CLAUDE_AGENT_SDK_CLIENT_APP: `${CONNECTOR.name}/${CONNECTOR.version}` }),
      stderr: (data: string) => process.stderr.write(data),
      ...(claudePath ? { pathToClaudeCodeExecutable: claudePath } : {}),
    },
  });

  const working = () => {
    if (!waitingNow) return;
    waitingNow = false;
    emit({ type: "working" });
  };

  function handle(message: Record<string, any>) {
    switch (message.type) {
      case "system":
        if (message.subtype === "init") {
          if (typeof message.session_id === "string") emit({ type: "session", id: message.session_id, resumed: !!start.session && message.session_id === start.session });
          // Another round of the turn: the answer it waited after is not its last.
          working();
        }
        if (message.subtype === "background_tasks_changed" && Array.isArray(message.tasks))
          tasks = message.tasks
            .filter((task: unknown) => task && typeof (task as { task_id?: unknown }).task_id === "string")
            .map((task: { task_id: string; description?: unknown }) => ({ id: task.task_id, description: storableText(String(task.description ?? "")).slice(0, 200) }));
        return;
      case "stream_event": {
        if (message.parent_tool_use_id) return;
        const event = message.event ?? {};
        if (event.type === "message_start") {
          working();
          usage = usageOf(event.message?.usage);
          emit({ type: "usage", ...usage });
          current = typeof event.message?.id === "string" ? event.message.id : undefined;
        } else if (event.type === "message_delta" && usage) {
          usage = { ...usage, outputTokens: Number(event.usage?.output_tokens ?? usage.outputTokens) || 0 };
          emit({ type: "usage", ...usage });
        } else if (event.type === "content_block_delta") {
          const delta = event.delta ?? {};
          if (delta.type === "text_delta") emit({ type: "text", text: storableText(String(delta.text ?? "")), block: current ?? "" });
          else if (delta.type === "thinking_delta") emit({ type: "thinking", text: storableText(String(delta.thinking ?? "")) });
          else return;
          if (current) streamed.add(current);
        }
        return;
      }
      case "assistant": {
        if (message.parent_tool_use_id) return;
        const id = typeof message.message?.id === "string" ? message.message.id : "";
        const seen = !!id && streamed.has(id);
        for (const block of Array.isArray(message.message?.content) ? message.message.content : []) {
          if (block?.type === "text" && !seen && block.text) emit({ type: "text", text: storableText(String(block.text)), block: id });
          else if (block?.type === "thinking" && !seen && block.thinking) emit({ type: "thinking", text: storableText(String(block.thinking)) });
          else if (block?.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string" && !block.name.startsWith(MCP_PREFIX)) {
            const input = boundedValue(block.input, OWN_CALL_INPUT_MAX);
            open.set(block.id, { name: block.name, input });
            emit({ type: "tool_started", id: block.id, name: block.name, input });
          }
        }
        return;
      }
      case "user": {
        if (message.parent_tool_use_id) return;
        // Our own messages, echoed when Claude Code takes them into the conversation.
        if (message.isReplay) {
          if (typeof message.uuid === "string") unread.delete(message.uuid);
          return;
        }
        for (const block of Array.isArray(message.message?.content) ? message.message.content : []) {
          if (block?.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
          const call = open.get(block.tool_use_id);
          if (!call) continue;
          open.delete(block.tool_use_id);
          emit({
            type: "tool_completed",
            id: block.tool_use_id,
            name: call.name,
            input: call.input,
            output: {
              text: boundedText(contentText(block.content), OWN_CALL_OUTPUT_MAX),
              ...(block.is_error ? { isError: true } : {}),
              ...(message.tool_use_result && typeof message.tool_use_result === "object" ? { details: boundedValue(message.tool_use_result, OWN_CALL_OUTPUT_MAX) } : {}),
            },
          });
        }
        return;
      }
      case "result": {
        const failed = !!message.is_error || (typeof message.subtype === "string" && message.subtype !== "success");
        // A message not taken in yet starts another round: the turn goes on.
        if (!failed && unread.size) return;
        if (!failed && tasks.length) {
          // It answered, but its background commands still run: when one
          // ends, Claude Code hears of it and goes on, in this turn.
          if (!waitingNow) {
            waitingNow = true;
            emit({ type: "waiting", tasks });
          }
          return;
        }
        waitingNow = false;
        emit(failed
          ? { type: "turn_end", stopReason: "error", error: storableText(String(message.result || message.subtype || "Claude Code ended the turn with an error")) }
          : { type: "turn_end", stopReason: "end_turn", ...(typeof message.result === "string" ? { text: storableText(message.result) } : {}) });
        return;
      }
      default:
        return;
    }
  }

  const exited = (async () => {
    try {
      for await (const message of query) handle(message);
      return 0;
    } catch (error) {
      emit({ type: "error", code: "agent_failed", message: `The Claude Agent SDK failed: ${storableText(String((error as Error)?.message ?? error))}` });
      return 1;
    }
  })();

  return {
    toolResult(message) {
      const resolve = waiting.get(message.id);
      if (!resolve) return;
      waiting.delete(message.id);
      resolve(message);
    },
    message(message) {
      unread.add(message.id);
      queue.push(userMessage(message.text, message.images ?? [], message.id));
      wake?.();
    },
    close() {
      ended = true;
      wake?.();
      for (const resolve of waiting.values()) resolve(UNANSWERED);
      waiting.clear();
    },
    exited,
  };
};
