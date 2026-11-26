import { accessSync, constants, existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type { AgentKind } from "../protocol";
import { ANTIGRAVITY, CLAUDE_CODE, CODEX, PINNED_AGENTS } from "../versions";

/**
 * Where Otti Connect's own copies of the agents are. The agents folder holds
 * one folder per agent and pinned version (`claude-code/2.1.331/`,
 * `codex/0.172.0/`, `antigravity/1.5.16/`), each with a manifest that the
 * installer (src/install.ts) writes last. A folder counts only when its
 * manifest names exactly what this release pins for this computer, so a half
 * install, another release's install or another platform's is never used.
 */

/** The installer writes it into a version's folder once everything else is there. */
export const MANIFEST_FILE = "otti-connect-agent.json";
/** The agents, in the order Otti Connect installs and reports them. */
export const AGENT_KINDS: readonly AgentKind[] = ["claude-code", "codex", "antigravity"];
export const AGENT_NAMES: Record<AgentKind, string> = { "claude-code": "Claude Code", codex: "Codex", antigravity: "Antigravity's CLI" };
/** Each agent's own program, as a person types it. */
export const COMMAND_NAMES: Record<AgentKind, string> = { "claude-code": "claude", codex: "codex", antigravity: "agy" };
const SDK = "@anthropic-ai/claude-agent-sdk";

/**
 * The variables that name an agent's program (or the Agent SDK's home) for
 * development and tests: when one is set, Otti Connect neither installs nor
 * runs its own copy of that agent.
 */
export const OVERRIDES: Record<AgentKind, readonly string[]> = {
  "claude-code": ["OTTI_CONNECT_HOME", "OTTI_CONNECT_CLAUDE"],
  codex: ["OTTI_CONNECT_CODEX"],
  antigravity: ["OTTI_CONNECT_AGY"],
};

/** The variable among OVERRIDES[kind] that is set, if one is. */
export function overrideOf(kind: AgentKind): string | undefined {
  return OVERRIDES[kind].find((name) => !!process.env[name]);
}

/** The agents folder: OTTI_CONNECT_AGENTS_DIR (the commands set it from their options, and turns inherit it), else `~/.otti-connect/agents`. */
export function agentsDir(): string {
  return process.env.OTTI_CONNECT_AGENTS_DIR || join(homedir(), ".otti-connect", "agents");
}

// ---------------------------------------------------------------------------
// Platforms
// ---------------------------------------------------------------------------

/** A platform the agents' builds are for: Node.js's names, and the C library on Linux. */
export type Target = { os: string; arch: string; libc: "glibc" | "musl" | null };

let muslCache: boolean | undefined;
/** A Linux whose C library is musl (as the Agent SDK decides it: Node.js reports no glibc). */
export function musl(): boolean {
  if (process.platform !== "linux") return false;
  if (muslCache === undefined) {
    const report = process.report as (NodeJS.ProcessReport & { excludeNetwork?: boolean }) | undefined;
    if (report && "excludeNetwork" in report) report.excludeNetwork = true;
    const header = (report?.getReport?.() as { header?: { glibcVersionRuntime?: string } } | undefined)?.header;
    muslCache = !!header && header.glibcVersionRuntime === undefined;
  }
  return muslCache;
}

/** This computer. */
export function currentTarget(): Target {
  return { os: process.platform, arch: process.arch, libc: process.platform === "linux" ? (musl() ? "musl" : "glibc") : null };
}

/** `linux-x64`, `linux-arm64-musl`, `darwin-arm64`: what a manifest records. */
export function targetKey(target: Target): string {
  return `${target.os}-${target.arch}${target.libc === "musl" ? "-musl" : ""}`;
}

/** For messages: `Linux arm64`, `macOS x64`. */
export function targetLabel(target: Target): string {
  const os = target.os === "darwin" ? "macOS" : target.os === "linux" ? "Linux" : target.os === "win32" ? "Windows" : target.os;
  return `${os} ${target.arch}${target.libc === "musl" ? " (musl)" : ""}`;
}

export function sameTarget(a: Target, b: Target): boolean {
  return targetKey(a) === targetKey(b);
}

/**
 * A platform named on the command line, as Docker names platforms or as
 * Node.js does: `linux/arm64`, `linux/amd64`, `darwin-arm64`. Linux is glibc
 * unless the name ends in `musl` (`linux/arm64/musl`).
 */
export function parseTarget(value: string): Target | null {
  const parts = value.trim().toLowerCase().split(/[/-]/).filter(Boolean);
  const os = parts[0] === "macos" ? "darwin" : parts[0];
  const arch = ({ amd64: "x64", x86_64: "x64", x64: "x64", arm64: "arm64", aarch64: "arm64" } as Record<string, string>)[parts[1] ?? ""];
  if ((os !== "linux" && os !== "darwin") || !arch) return null;
  const rest = parts.slice(2).filter((part) => part !== "v8");
  if (rest.length > 1 || (rest[0] && rest[0] !== "musl" && rest[0] !== "glibc") || (rest[0] && os !== "linux")) return null;
  return { os, arch, libc: os === "linux" ? (rest[0] === "musl" ? "musl" : "glibc") : null };
}

/** Antigravity's archive for a platform, when Otti Connect pins one for it. */
export function antigravityArchive(target: Target = currentTarget()): { url: string; sha512: string } | undefined {
  if (target.libc === "musl") return undefined;
  return (ANTIGRAVITY.archives as Record<string, { url: string; sha512: string }>)[`${target.os}-${target.arch}`];
}

/** Why Otti Connect has no build of the agent for a platform; undefined when it has one. */
export function unsupportedReason(kind: AgentKind, target: Target = currentTarget()): string | undefined {
  const version = PINNED_AGENTS[kind].version;
  if (target.os === "win32") return `Otti Connect doesn't run ${AGENT_NAMES[kind]} on Windows yet: run Otti Connect in WSL, where it works as on Linux.`;
  if ((target.os !== "linux" && target.os !== "darwin") || (target.arch !== "x64" && target.arch !== "arm64"))
    return `${AGENT_NAMES[kind]} ${version} has no build for ${targetLabel(target)} that Otti Connect can install.`;
  if (kind === "antigravity" && !antigravityArchive(target))
    return `Google publishes no build of ${AGENT_NAMES[kind]} ${version} for ${targetLabel(target)} that Otti Connect pins.`;
  return undefined;
}

// ---------------------------------------------------------------------------
// Installed versions
// ---------------------------------------------------------------------------

/** What an install of the agent holds for a platform; the installer records it in the manifest. */
export function pinnedSpec(kind: AgentKind, target: Target = currentTarget()): Record<string, unknown> {
  const platform = targetKey(target);
  switch (kind) {
    case "claude-code":
      return { agent: kind, version: CLAUDE_CODE.version, packages: CLAUDE_CODE.packages, platform };
    case "codex":
      return { agent: kind, version: CODEX.version, packages: CODEX.packages, platform };
    case "antigravity":
      return { agent: kind, version: ANTIGRAVITY.version, build: ANTIGRAVITY.build, sha512: antigravityArchive(target)?.sha512 ?? null, platform };
  }
}

/** The pinned version's folder, installed or not. */
export function versionDir(kind: AgentKind, dir = agentsDir()): string {
  return join(dir, kind, PINNED_AGENTS[kind].version);
}

/** The manifest in `folder` names what this release pins for the platform. */
export function manifestMatches(folder: string, kind: AgentKind, target: Target = currentTarget()): boolean {
  try {
    const manifest = JSON.parse(readFileSync(join(folder, MANIFEST_FILE), "utf8")) as { spec?: unknown };
    return JSON.stringify(manifest.spec) === JSON.stringify(pinnedSpec(kind, target));
  } catch {
    return false;
  }
}

/** The pinned version's folder when it is installed for the platform; null when it isn't. */
export function installedDir(kind: AgentKind, dir = agentsDir(), target: Target = currentTarget()): string | null {
  const folder = versionDir(kind, dir);
  return manifestMatches(folder, kind, target) ? folder : null;
}

// ---------------------------------------------------------------------------
// Programs
// ---------------------------------------------------------------------------

/** How to run one of an agent's programs: `file` with `args` before the program's own. `path` is the program itself, as a person runs it. */
export type Program = { file: string; args: string[]; path: string };

/** The Agent SDK's entry in a folder whose node_modules hold it, or null. */
export function sdkEntry(home: string): string | null {
  try {
    return createRequire(join(home, "package.json")).resolve(SDK);
  } catch {
    return null;
  }
}

/** The Claude Code build that the Agent SDK at `entry` brings for a platform, found as the SDK finds it: its platform's package beside it. */
export function sdkClaudeBuild(entry: string, target: Target = currentTarget()): string | null {
  const { os, arch } = target;
  const packages = os === "linux"
    ? target.libc === "musl" ? [`${SDK}-linux-${arch}-musl`, `${SDK}-linux-${arch}`] : [`${SDK}-linux-${arch}`, `${SDK}-linux-${arch}-musl`]
    : [`${SDK}-${os}-${arch}`];
  const require = createRequire(entry);
  for (const name of packages) {
    try {
      const path = require.resolve(`${name}/claude${os === "win32" ? ".exe" : ""}`);
      if (existsSync(path)) return path;
    } catch {
      // Not this one.
    }
  }
  return null;
}

/** Codex's own launcher in an install, which finds the platform's program and hands over to it. */
export function codexLauncher(folder: string): string {
  return join(folder, "node_modules", "@openai", "codex", "bin", "codex.js");
}

/** Codex's program for a platform in an install (its platform package's `vendor/<target triple>/bin/codex`), or null. */
export function codexBinary(folder: string, target: Target = currentTarget()): string | null {
  const vendor = join(folder, "node_modules", "@openai", `codex-${target.os}-${target.arch}`, "vendor");
  try {
    for (const triple of readdirSync(vendor)) {
      const path = join(vendor, triple, "bin", target.os === "win32" ? "codex.exe" : "codex");
      if (existsSync(path)) return path;
    }
  } catch {
    // No platform package.
  }
  return null;
}

/** Otti Connect's own copy of each agent's program, when it is installed for the platform: what turns run, and what a person runs to sign in. */
export function pinnedProgram(kind: AgentKind, dir = agentsDir(), target: Target = currentTarget()): Program | null {
  const folder = installedDir(kind, dir, target);
  if (!folder) return null;
  switch (kind) {
    case "claude-code": {
      const entry = sdkEntry(folder);
      const build = entry ? sdkClaudeBuild(entry, target) : null;
      return build ? { file: build, args: [], path: build } : null;
    }
    case "codex": {
      // Codex's own launcher, run with this Node.js.
      const launcher = codexLauncher(folder);
      return existsSync(launcher) ? { file: process.execPath, args: [launcher], path: join(folder, "node_modules", ".bin", "codex") } : null;
    }
    case "antigravity": {
      const agy = join(folder, "agy");
      return existsSync(agy) ? { file: agy, args: [], path: agy } : null;
    }
  }
}

/** The person's own program `name` on the PATH, when there is one. */
export function onPath(name: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const path = join(dir, name);
    try {
      accessSync(path, constants.X_OK);
      return path;
    } catch {
      // Not here.
    }
  }
  return null;
}

/** A path as a person types it in a shell: `~/…` under the home folder, quoted where the shell needs it. */
export function shellPath(path: string): string {
  const home = homedir();
  const quote = (text: string) => (/^[A-Za-z0-9_./@%+=:,-]*$/.test(text) ? text : `'${text.replace(/'/g, `'\\''`)}'`);
  if (home && home !== "/" && path.startsWith(`${home}/`)) return `~/${quote(path.slice(home.length + 1))}`;
  return quote(path);
}

/**
 * The command that runs one of an agent's own commands, such as its sign-in:
 * the agent's own program when the person has it on the PATH (it shares the
 * sign-ins with Otti Connect's copy), else Otti Connect's copy by its path.
 */
export function agentCommand(kind: AgentKind, args: string, program: Program | null): string {
  const name = COMMAND_NAMES[kind];
  if (onPath(name) || !program) return `${name} ${args}`;
  return `${shellPath(program.path)} ${args}`;
}
