import { spawn } from "node:child_process";
import { homedir } from "node:os";
import type { AgentReport } from "../host-api";
import type { AgentKind } from "../protocol";
import { agentEnvironment } from "../util";
import { PINNED_AGENTS } from "../versions";
import { AGENT_LABELS } from "./agent";
import { AGY_ADDED_ENV, AGY_REMOVED_ENV, locateAgy } from "./antigravity";
import { CLAUDE_ADDED_ENV, CLAUDE_REMOVED_ENV, claudeExecutable, locateSdk } from "./claude";
import { CODEX_REMOVED_ENV, locateCodex } from "./codex";
import { AGENT_NAMES, agentCommand, overrideOf, type Program, targetLabel, currentTarget, unsupportedReason } from "./pinned";

/**
 * What Otti Connect tells Octomerge about the agents on this computer: for
 * each, whether it can run it, its version, and whether it is signed in, as
 * the agent's own status command says. The agents are Otti Connect's pinned
 * copies (src/install.ts), and it runs only their own commands (`--version`,
 * `claude auth status`, `codex login status`), with the environment a turn
 * gives them (no API keys), and reads none of their files. Their output is
 * read for a version or a yes or no, and never kept: an account's identity
 * never reaches the report.
 */

/** How long one of an agent's own commands may take. */
export const CHECK_TIMEOUT_MS = 5_000;
/** Claude Code's model aliases, which Octomerge offers for it. */
const CLAUDE_MODELS = ["sonnet", "opus", "haiku"];

/** What the installer found at this start: why an agent it couldn't install isn't there. */
export type ReportContext = { failures?: ReadonlyMap<AgentKind, string> };

type CommandResult = { code: number | null; stdout: string; timedOut: boolean; failed?: string };

/**
 * Runs one of an agent's commands with no input, in its own process group
 * (so a timeout ends whatever it started), and keeps the first 64 KiB of its
 * standard output.
 */
export function runCommand(program: Program, args: string[], env: Record<string, string>, timeoutMs = CHECK_TIMEOUT_MS): Promise<CommandResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let settled = false;
    const group = process.platform !== "win32";
    const child = spawn(program.file, [...program.args, ...args], { cwd: homedir(), env, stdio: ["ignore", "pipe", "pipe"], detached: group, windowsHide: true });
    const finish = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => {
      try {
        if (group && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        // It ended meanwhile.
      }
      finish({ code: null, stdout, timedOut: true });
    }, timeoutMs);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (stdout.length < 65_536) stdout += chunk;
    });
    // Its errors are its own; nothing of them is kept.
    child.stderr?.resume();
    child.on("error", (error: NodeJS.ErrnoException) => finish({ code: null, stdout, timedOut: false, failed: error.code ?? error.message }));
    child.on("close", (code) => finish({ code, stdout, timedOut: false }));
  });
}

/** The first version number in a program's `--version` line: `2.1.331 (Claude Code)`, `codex-cli 0.172.0`. */
export function versionOf(text: string): string | undefined {
  return /\b(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?)\b/.exec(text)?.[1]?.slice(0, 80);
}

/** `claude auth status` prints JSON whose `loggedIn` says it; anything else (an older Claude Code, a timeout) says nothing. */
function claudeLoggedIn(result: CommandResult): boolean | null {
  if (result.timedOut || result.failed) return null;
  const start = result.stdout.indexOf("{");
  if (start < 0) return null;
  try {
    const status = JSON.parse(result.stdout.slice(start)) as { loggedIn?: unknown };
    return typeof status.loggedIn === "boolean" ? status.loggedIn : null;
  } catch {
    return null;
  }
}

const unanswered = (command: string, result: CommandResult) =>
  result.timedOut ? `\`${command}\` didn't answer within ${CHECK_TIMEOUT_MS / 1000} s.` : `\`${command}\` couldn't run${result.failed ? `: ${result.failed}` : ""}.`;

/** A Linux without a display (a server, a container): a sign-in there can't open a browser. */
const headless = () => process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;

/** An agent Otti Connect can't run: why, and what to do. */
function notInstalled(kind: AgentKind, context: ReportContext): AgentReport {
  const pin = PINNED_AGENTS[kind];
  const variable = overrideOf(kind);
  const detail =
    unsupportedReason(kind) ??
    context.failures?.get(kind) ??
    (variable === "OTTI_CONNECT_HOME"
      ? `OTTI_CONNECT_HOME names ${process.env.OTTI_CONNECT_HOME}, which doesn't hold the Claude Agent SDK with @modelcontextprotocol/sdk and zod beside it.`
      : variable === "OTTI_CONNECT_CLAUDE"
        ? "OTTI_CONNECT_CLAUDE is set, so Otti Connect doesn't install Claude Code, and the Claude Agent SDK that runs it isn't installed: name a folder that holds it with OTTI_CONNECT_HOME."
        : variable
          ? `${variable} names ${process.env[variable]}, which isn't a program Otti Connect can run.`
          : `\`otti-connect start\` installs ${AGENT_NAMES[kind]} ${pin.version} (a ${pin.downloadMB} MB download), and so does \`otti-connect install\`.`);
  return { kind, installed: false, detail };
}

async function claudeReport(context: ReportContext): Promise<AgentReport> {
  const kind: AgentKind = "claude-code";
  const sdk = locateSdk();
  if (!sdk) return notInstalled(kind, context);
  const claude = claudeExecutable(sdk);
  if (!claude)
    return {
      kind,
      installed: false,
      detail: `The Claude Code build that the Claude Agent SDK brings for ${targetLabel(currentTarget())} is missing from ${sdk.home}: \`otti-connect install\` installs it again.`,
    };
  const program: Program = { file: claude, args: [], path: claude };
  const env = agentEnvironment(CLAUDE_REMOVED_ENV, CLAUDE_ADDED_ENV);
  // Another `claude` (OTTI_CONNECT_CLAUDE) says its own version; the SDK's build is the one its package names.
  const custom = !!process.env.OTTI_CONNECT_CLAUDE;
  const [version, status] = await Promise.all([
    !custom && sdk.claudeCodeVersion ? Promise.resolve(sdk.claudeCodeVersion) : runCommand(program, ["--version"], env).then((result) => versionOf(result.stdout)),
    runCommand(program, ["auth", "status"], env),
  ]);
  const signedIn = claudeLoggedIn(status);
  return {
    kind,
    installed: true,
    ...(version ? { version } : {}),
    signedIn,
    models: CLAUDE_MODELS,
    ...(signedIn === false
      ? { detail: `Not signed in: run \`${agentCommand(kind, "auth login", program)}\` in a terminal on this agent host, Claude Code's own sign-in.` }
      : signedIn === null
        ? { detail: unanswered("claude auth status", status) }
        : {}),
  };
}

async function codexReport(context: ReportContext): Promise<AgentReport> {
  const kind: AgentKind = "codex";
  const codex = locateCodex();
  if (!codex) return notInstalled(kind, context);
  const env = agentEnvironment(CODEX_REMOVED_ENV);
  const [version, status] = await Promise.all([runCommand(codex, ["--version"], env), runCommand(codex, ["login", "status"], env)]);
  if (version.failed) return { kind, installed: false, detail: `Codex is installed in ${codex.path}, but it doesn't run (${version.failed}).` };
  // `codex login status` exits 0 only when Codex is signed in.
  const signedIn = status.timedOut || status.failed ? null : status.code === 0;
  return {
    kind,
    installed: true,
    ...(versionOf(version.stdout) ? { version: versionOf(version.stdout) } : {}),
    signedIn,
    ...(signedIn === false
      ? { detail: `Not signed in: run \`${agentCommand(kind, headless() ? "login --device-auth" : "login", codex)}\` in a terminal on this agent host, Codex's own sign-in.` }
      : signedIn === null
        ? { detail: unanswered("codex login status", status) }
        : {}),
  };
}

async function antigravityReport(context: ReportContext): Promise<AgentReport> {
  const kind: AgentKind = "antigravity";
  const agy = locateAgy();
  if (!agy) return notInstalled(kind, context);
  const version = await runCommand(agy, ["--version"], agentEnvironment(AGY_REMOVED_ENV, AGY_ADDED_ENV));
  if (version.failed) return { kind, installed: false, detail: `Antigravity's CLI is installed in ${agy.path}, but it doesn't run (${version.failed}).` };
  // agy has no command that says whether it is signed in.
  return {
    kind,
    installed: true,
    ...(versionOf(version.stdout) ? { version: versionOf(version.stdout) } : {}),
    signedIn: null,
    detail: `Antigravity's CLI has no command that says whether it is signed in: if it isn't, run \`${agentCommand(kind, "acp --login", agy)}\` in a terminal on this agent host, its own sign-in.`,
  };
}

/** The three agents, checked at once: at most CHECK_TIMEOUT_MS. */
export async function detectAgents(context: ReportContext = {}): Promise<AgentReport[]> {
  const safe = (kind: AgentKind, check: (context: ReportContext) => Promise<AgentReport>) =>
    check(context).catch((error): AgentReport => ({ kind, installed: false, detail: `Otti Connect couldn't check ${AGENT_LABELS[kind]}: ${String((error as Error)?.message ?? error).slice(0, 300)}` }));
  return Promise.all([safe("claude-code", claudeReport), safe("codex", codexReport), safe("antigravity", antigravityReport)]);
}

/** The agents for the person, a line each, with what to do under one that can't run: `Claude Code   2.1.331    signed in`. */
export function describeAgents(agents: readonly AgentReport[]): string[] {
  return agents.flatMap((agent) => {
    const name = AGENT_LABELS[agent.kind].padEnd(12);
    const state = !agent.installed ? "not installed" : agent.signedIn === true ? "signed in" : agent.signedIn === false ? "not signed in" : "sign-in unknown";
    const line = `${name}  ${(agent.installed ? agent.version ?? "" : "").padEnd(9)}  ${state}`.trimEnd();
    return agent.detail && !(agent.installed && agent.signedIn === true) ? [line, `${" ".repeat(14)}${agent.detail}`] : [line];
  });
}
