#!/usr/bin/env node
import { join } from "node:path";
import { currentTarget, parseTarget, sameTarget, shellPath, type Target, targetLabel } from "./agents/pinned";
import { describeAgents, detectAgents } from "./agents/report";
import {
  assertConfigWritable,
  ConfigError,
  configPath,
  DEFAULT_BASE_URL,
  defaultConfigDir,
  defaultLabel,
  LABEL_PATTERN,
  parseBaseUrl,
  readConnectConfig,
  removeConnectConfig,
  resolveConfigDir,
} from "./config";
import { AgentHost, HostStop } from "./host";
import { HOST_API_VERSION } from "./host-api";
import { describeOutcomes, InstallError, installAgents, type InstallOptions, type InstallOutcome, linkPrograms } from "./install";
import { lockHolder, LockError, takeLock } from "./lock";
import { PROTOCOL_VERSION } from "./protocol";
import { revokeSignIn } from "./signin";
import { runTurn } from "./turn";
import { CONNECTOR } from "./util";

/**
 * otti-connect: runs the person's own signed-in coding agents (Claude Code,
 * Codex, Antigravity's CLI) for Octomerge, at the versions Octomerge tests.
 *
 *   otti-connect [start]    installs the agents it runs, if they aren't
 *                           installed, connects this computer to Octomerge as
 *                           an agent host (signing it in first) and runs its
 *                           turns
 *   otti-connect status     the agents and their sign-ins
 *   otti-connect install    installs the agents it runs
 *   otti-connect logout     forgets and revokes this computer's sign-in
 *   otti-connect turn       one turn on stdin and stdout (PROTOCOL.md)
 *   otti-connect --version  the connector's version and protocol version
 */
const USAGE = `Usage: ${CONNECTOR.name} [start | status | install | logout] [options]
       ${CONNECTOR.name} turn
       ${CONNECTOR.name} --version

Commands:
  start     Connect this computer to Octomerge as an agent host and run the
            turns it sends (the default). Installs the agents first if they
            aren't installed, and signs the computer in if it isn't
  status    Show the agents and their sign-ins, without connecting
  install   Install the agents this version of Otti Connect runs, without connecting
  logout    Forget this computer's sign-in to Octomerge, and revoke it there
  turn      Run one turn, speaking the connector protocol on stdin and stdout

Options:
  --base-url <url>    The Octomerge to connect to (default: $OTTI_CONNECT_BASE_URL,
                      else the one this computer signed in to, else ${DEFAULT_BASE_URL})
  --label <label>     This computer's name in Octomerge when it first connects (default:
                      $OTTI_CONNECT_LABEL, else the host name): letters, digits, dots,
                      hyphens and underscores. Once connected, rename it in Octomerge
                      (Settings → Your agents)
  --config-dir <dir>  Where the sign-in is kept (default: ~/.otti-connect)
  --agents-dir <dir>  Where the agents are installed (default: $OTTI_CONNECT_AGENTS_DIR,
                      else agents in the config folder)
  --no-open           Don't open the approval page in a browser
  -h, --help          Show this help
  -v, --version       Show the version

Options of install, for building an image:
  --platform <os/arch>  Install the agents for another platform, such as linux/arm64,
                        without running them
  --bin-dir <dir>       Also put links to the agents' own programs (claude, codex, agy)
                        into <dir>`;

class UsageError extends Error {}

type Command = "start" | "status" | "install" | "logout" | "turn" | "version" | "help";
type Options = {
  command: Command;
  baseUrl?: string;
  label?: string;
  configDir: string;
  agentsDir: string;
  open: boolean;
  platform?: Target;
  binDir?: string;
};

const COMMANDS = ["start", "status", "install", "logout", "turn"];

function parseArgs(args: readonly string[]): Options {
  let command: Command | undefined;
  const values: { baseUrl?: string; label?: string; configDir?: string; agentsDir?: string; platform?: string; binDir?: string } = {};
  let open = true;
  const names: Record<string, keyof typeof values> = {
    "--base-url": "baseUrl",
    "--label": "label",
    "--config-dir": "configDir",
    "--agents-dir": "agentsDir",
    "--platform": "platform",
    "--bin-dir": "binDir",
  };
  const plain = (command: Command): Options => ({ command, configDir: defaultConfigDir(), agentsDir: join(defaultConfigDir(), "agents"), open });
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "-h" || arg === "--help" || arg === "help") return plain("help");
    if (arg === "-v" || arg === "--version" || arg === "version") return plain("version");
    if (arg === "--no-open") {
      open = false;
      continue;
    }
    const option = /^(--[a-z-]+)(?:=(.*))?$/s.exec(arg);
    if (option) {
      const key = names[option[1]!];
      if (!key) throw new UsageError(`Unknown option ${option[1]}.`);
      const value = option[2] ?? args[++index];
      if (value === undefined || (option[2] === undefined && value.startsWith("--"))) throw new UsageError(`${option[1]} needs a value.`);
      if (values[key] !== undefined) throw new UsageError(`Use ${option[1]} once.`);
      values[key] = value;
      continue;
    }
    if (command || !COMMANDS.includes(arg)) throw new UsageError(`Unknown command ${arg}.`);
    command = arg as Command;
  }
  command ??= "start";
  if (values.label !== undefined && !LABEL_PATTERN.test(values.label))
    throw new UsageError(`--label ${values.label} isn't a label: up to 63 letters, digits, dots, hyphens and underscores, starting with a letter or digit.`);
  if ((values.platform !== undefined || values.binDir !== undefined) && command !== "install")
    throw new UsageError(`${values.platform !== undefined ? "--platform" : "--bin-dir"} goes with \`${CONNECTOR.name} install\`.`);
  const platform = values.platform !== undefined ? parseTarget(values.platform) : undefined;
  if (platform === null) throw new UsageError(`--platform ${values.platform} isn't a platform Otti Connect installs agents for: linux/amd64, linux/arm64, darwin/amd64 or darwin/arm64.`);
  const configDir = values.configDir !== undefined ? resolveConfigDir(values.configDir) : defaultConfigDir();
  const fromEnv = process.env.OTTI_CONNECT_AGENTS_DIR;
  return {
    command,
    ...(values.baseUrl !== undefined ? { baseUrl: parseBaseUrl(values.baseUrl, "--base-url") } : {}),
    ...(values.label !== undefined ? { label: values.label } : {}),
    configDir,
    agentsDir: values.agentsDir !== undefined ? resolveConfigDir(values.agentsDir) : fromEnv ? resolveConfigDir(fromEnv) : join(configDir, "agents"),
    open,
    ...(platform ? { platform } : {}),
    ...(values.binDir !== undefined ? { binDir: resolveConfigDir(values.binDir) } : {}),
  };
}

/** --base-url, else OTTI_CONNECT_BASE_URL, else the Octomerge of the saved sign-in, else octomerge.dev. */
function baseUrlOf(options: Options, saved: string | undefined): string {
  if (options.baseUrl) return options.baseUrl;
  if (process.env.OTTI_CONNECT_BASE_URL) return parseBaseUrl(process.env.OTTI_CONNECT_BASE_URL, "OTTI_CONNECT_BASE_URL");
  return saved ?? DEFAULT_BASE_URL;
}

const say = (line: string) => process.stdout.write(`${line}\n`);

/**
 * Installs the agents; Ctrl+C or SIGTERM stops the install (what it began is
 * removed, nothing half done stays) and a second one exits at once.
 */
async function installStoppable(options: Omit<InstallOptions, "signal" | "say">): Promise<{ outcomes: InstallOutcome[]; stopped: NodeJS.Signals | null }> {
  const controller = new AbortController();
  let stopped: NodeJS.Signals | null = null;
  const onSignal = (signal: NodeJS.Signals) => {
    if (stopped) process.exit(signal === "SIGINT" ? 130 : 143);
    stopped = signal;
    say("\nStopping the install …");
    controller.abort();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    return { outcomes: await installAgents({ ...options, say, signal: controller.signal }), stopped };
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

async function start(options: Options): Promise<number> {
  const saved = readConnectConfig(options.configDir);
  const baseUrl = baseUrlOf(options, saved?.baseUrl);
  if (saved?.token && saved.baseUrl !== baseUrl)
    throw new HostStop(
      `This computer is signed in to ${saved.baseUrl}, not ${baseUrl}. Sign it out there first with \`${CONNECTOR.name} logout\`, or keep both with --config-dir and another folder.`,
    );
  const envLabel = process.env.OTTI_CONNECT_LABEL;
  if (!options.label && envLabel && !LABEL_PATTERN.test(envLabel)) throw new UsageError(`OTTI_CONNECT_LABEL=${envLabel} isn't a label: letters, digits, dots, hyphens and underscores.`);
  const label = options.label ?? envLabel ?? saved?.label ?? defaultLabel();
  takeLock(options.configDir);
  // A sign-in that can't be saved fails here, before anybody approves a code.
  if (!saved?.token) assertConfigWritable(options.configDir);
  say(`Otti Connect ${CONNECTOR.version} on ${process.platform} ${process.arch}, for ${baseUrl}`);
  // No turn runs yet, so older versions of the agents can go once the new ones are in place.
  const { outcomes, stopped } = await installStoppable({
    dir: options.agentsDir,
    prune: true,
    intro: `Otti Connect runs the agents at the versions Octomerge tests with it, installed once in ${shellPath(options.agentsDir)}; any you installed yourself stay as they are.`,
  });
  if (stopped) return stopped === "SIGINT" ? 130 : 143;
  const failures = new Map(outcomes.filter((outcome) => outcome.state === "failed").map((outcome) => [outcome.kind, outcome.detail ?? ""] as const));
  return new AgentHost({ baseUrl, label, configDir: options.configDir, open: options.open, token: saved?.token, hostId: saved?.hostId, failures }).run();
}

async function status(options: Options): Promise<number> {
  const saved = readConnectConfig(options.configDir);
  say(`Otti Connect ${CONNECTOR.version} (connector protocol ${PROTOCOL_VERSION}, agent host API ${HOST_API_VERSION}) on ${process.platform} ${process.arch}`);
  const holder = lockHolder(options.configDir);
  if (saved?.token)
    say(
      `Signed in to ${saved.baseUrl}${saved.label ? ` as ${saved.label}` : ""}${saved.hostId ? ` (agent host ${saved.hostId})` : ""}; ${holder ? `connected now (process ${holder})` : `not connected now: \`${CONNECTOR.name}\` connects it`}.`,
    );
  else say(`Not signed in to Octomerge: \`${CONNECTOR.name}\` signs this computer in and connects it.`);
  const agents = await detectAgents();
  say(["", `The agents Otti Connect runs, in ${shellPath(options.agentsDir)}:`, ...describeAgents(agents).map((line) => `  ${line}`), ""].join("\n"));
  return 0;
}

async function install(options: Options): Promise<number> {
  const target = options.platform ?? currentTarget();
  const foreign = !sameTarget(target, currentTarget());
  say(`Otti Connect ${CONNECTOR.version}: the agents it runs${foreign ? ` on ${targetLabel(target)}` : ""}, in ${options.agentsDir}`);
  // A running Otti Connect may use the older versions: it removes them itself when it starts next.
  const holder = foreign ? null : lockHolder(options.configDir);
  const { outcomes, stopped } = await installStoppable({ dir: options.agentsDir, target, prune: !holder });
  if (stopped) return stopped === "SIGINT" ? 130 : 143;
  say(["", ...describeOutcomes(outcomes).map((line) => `  ${line}`)].join("\n"));
  if (holder) say(`\nOtti Connect runs with these agents now (process ${holder}): it removes older versions of them when it starts next.`);
  if (options.binDir) {
    try {
      const links = linkPrograms(options.binDir, options.agentsDir, target);
      say(["", `Links in ${options.binDir}:`, ...links.map((line) => `  ${line}`)].join("\n"));
    } catch (error) {
      if (!(error instanceof InstallError)) throw error;
      process.stderr.write(`${CONNECTOR.name}: ${error.message}\n`);
      return 1;
    }
  }
  return outcomes.every((outcome) => outcome.state === "present" || outcome.state === "installed" || outcome.state === "override") ? 0 : 1;
}

async function logout(options: Options): Promise<number> {
  const saved = readConnectConfig(options.configDir);
  if (!saved?.token) {
    if (saved) removeConnectConfig(options.configDir);
    say(`This computer isn't signed in to Octomerge (no sign-in in ${configPath(options.configDir)}).`);
    return 0;
  }
  if (options.baseUrl && options.baseUrl !== saved.baseUrl) {
    process.stderr.write(`${CONNECTOR.name}: this computer is signed in to ${saved.baseUrl}, not ${options.baseUrl}: nothing changed.\n`);
    return 1;
  }
  const revocation = await revokeSignIn(saved.baseUrl, saved.token);
  removeConnectConfig(options.configDir);
  const computer = saved.label ?? "this computer";
  if (revocation.outcome === "revoked")
    say(`Signed out: ${saved.baseUrl} revoked the sign-in of ${computer}, and it is forgotten here. ${saved.label ?? "The computer"} leaves Settings → Your agents by itself.`);
  else if (revocation.outcome === "invalid") say(`Signed out: the sign-in of ${computer} no longer worked at ${saved.baseUrl}, and it is forgotten here.`);
  else say(`The sign-in is forgotten here, but ${saved.baseUrl} couldn't revoke it (${revocation.error}). Forget ${computer} under Settings → Your agents, which revokes it.`);
  const holder = lockHolder(options.configDir);
  if (holder) say(`Otti Connect still runs with this sign-in (process ${holder}); stop it, or it asks for a new sign-in.`);
  return 0;
}

/** Exits once everything written to stdout has gone out. */
function exit(status: number): void {
  process.stdout.write("", () => process.exit(status));
}

async function main(): Promise<number> {
  let options: Options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    if (!(error instanceof UsageError || error instanceof ConfigError)) throw error;
    process.stderr.write(`${CONNECTOR.name}: ${error.message}\n\n${USAGE}\n`);
    return 64;
  }
  if (process.platform === "win32" && options.command !== "help" && options.command !== "version") {
    process.stderr.write(`${CONNECTOR.name}: Otti Connect doesn't run on Windows yet. Run it in WSL (the Windows Subsystem for Linux), where it works as on Linux.\n`);
    return 1;
  }
  // The agents folder of this process and of the turns it starts.
  process.env.OTTI_CONNECT_AGENTS_DIR = options.agentsDir;
  switch (options.command) {
    case "turn":
      return runTurn();
    case "version":
      say(`${CONNECTOR.name} ${CONNECTOR.version} (protocol ${PROTOCOL_VERSION})`);
      return 0;
    case "help":
      say(USAGE);
      return 0;
    default:
      try {
        switch (options.command) {
          case "status":
            return await status(options);
          case "install":
            return await install(options);
          case "logout":
            return await logout(options);
          default:
            return await start(options);
        }
      } catch (error) {
        if (error instanceof UsageError) {
          process.stderr.write(`${CONNECTOR.name}: ${error.message}\n`);
          return 64;
        }
        if (error instanceof ConfigError || error instanceof LockError || error instanceof HostStop) {
          process.stderr.write(`${CONNECTOR.name}: ${error.message}\n`);
          return 1;
        }
        throw error;
      }
  }
}

main().then(exit, (error) => {
  process.stderr.write(`${CONNECTOR.name}: ${(error as Error)?.stack ?? String(error)}\n`);
  exit(1);
});
