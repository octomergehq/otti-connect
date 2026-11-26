import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, closeSync, createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { createGunzip } from "node:zlib";
import {
  AGENT_KINDS,
  AGENT_NAMES,
  antigravityArchive,
  codexBinary,
  codexLauncher,
  COMMAND_NAMES,
  currentTarget,
  installedDir,
  MANIFEST_FILE,
  overrideOf,
  pinnedSpec,
  sameTarget,
  sdkClaudeBuild,
  sdkEntry,
  type Target,
  targetLabel,
  unsupportedReason,
  versionDir,
} from "./agents/pinned";
import { sleep } from "./http";
import { tryLock } from "./lock";
import type { AgentKind } from "./protocol";
import { CONNECTOR, locateExecutable } from "./util";
import { CLAUDE_CODE, CODEX, NPM_REGISTRY, PINNED_AGENTS } from "./versions";

/**
 * The agents installer: makes sure the pinned agents (src/versions.ts) are in
 * the agents folder, one folder per agent and version.
 *
 * - Claude Code (the Agent SDK with what Otti Connect loads with it) and
 *   Codex come from npm's public registry, `npm install --prefix <folder>`;
 *   the agents' optional packages hold their builds for each platform.
 * - Antigravity's CLI is Google's release archive, checked against its
 *   pinned SHA-512 before it is unpacked, as Google's installer does.
 *
 * Each install goes into a temporary folder beside its final one
 * (`.<version>.<pid>.<random>.partial`), gets checked, gets its manifest
 * last (what it pins, and the size of each of the agent's programs), and is
 * then renamed into place, so a half install is never used; one that stopped
 * leaves only the temporary folder, which the next install removes. An
 * install whose programs changed (agy updates itself where it can write) is
 * installed again. `.install.lock` in the agents folder keeps two installers
 * apart. Older versions are removed only when no turn may use them (at
 * start, before turns run). A failure leaves that agent out, with its
 * reason, and the others go on; the next start tries again.
 */

const INSTALL_LOCK = ".install.lock";
/** The longest an npm install may take. */
const NPM_TIMEOUT_MS = 60 * 60_000;
/** A download that receives nothing for this long is given up. */
const STALL_MS = 120_000;
/** How often a long install says it still runs. */
const TICK_MS = 30_000;
/** How long a fresh program may take to say its version (macOS checks a new program on its first run). */
const CHECK_TIMEOUT_MS = 120_000;

export class InstallError extends Error {}

/** What became of one agent. */
export type InstallOutcome = {
  kind: AgentKind;
  /**
   * `present`: installed before; `installed`: just now; `override`: an
   * `OTTI_CONNECT_*` variable names another program, so Otti Connect's own
   * isn't installed; `unsupported`: no pinned build for this platform;
   * `failed`: with the reason in `detail`.
   */
  state: "present" | "installed" | "override" | "unsupported" | "failed";
  /** Why the agent isn't installed, as the report gives it to the person. */
  detail?: string;
  /** The same, without the agent's name: for a line that names it. */
  reason?: string;
  folder?: string;
};

export type InstallOptions = {
  /** The agents folder. */
  dir: string;
  /** The platform to install for; this computer by default. Another platform's agents are installed without running them (a container's build). */
  target?: Target;
  /** Also remove older versions: only where no turn may use them. */
  prune: boolean;
  say: (line: string) => void;
  /** Said once before the first install, when there is one. */
  intro?: string;
  signal?: AbortSignal;
};

const versionOf = (kind: AgentKind) => PINNED_AGENTS[kind].version;
const nameOf = (kind: AgentKind) => `${AGENT_NAMES[kind]} ${versionOf(kind)}`;

function duration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min${seconds % 60 ? ` ${seconds % 60} s` : ""}`;
}

/** Installs the pinned agents that aren't installed; resolves with each agent's outcome, in AGENT_KINDS's order. Never throws for one agent's failure. */
export async function installAgents(options: InstallOptions): Promise<InstallOutcome[]> {
  const here = currentTarget();
  const target = options.target ?? here;
  const foreign = !sameTarget(target, here);
  const outcomes = new Map<AgentKind, InstallOutcome>();
  const missing: AgentKind[] = [];
  for (const kind of AGENT_KINDS) {
    const variable = foreign ? undefined : overrideOf(kind);
    const unsupported = unsupportedReason(kind, target);
    if (variable) outcomes.set(kind, { kind, state: "override", reason: `${variable} is set: Otti Connect runs what it names instead of installing its own copy.` });
    else if (unsupported) outcomes.set(kind, { kind, state: "unsupported", detail: unsupported, reason: unsupported });
    else if (complete(kind, options.dir, target) === true) outcomes.set(kind, { kind, state: "present", folder: versionDir(kind, options.dir) });
    else missing.push(kind);
  }
  const ordered = () => AGENT_KINDS.map((kind) => outcomes.get(kind)!);
  if (!missing.length && !leftovers(options.dir, options.prune)) return ordered();

  let release: () => void;
  try {
    release = await installLock(options.dir, options.say, options.signal);
  } catch (error) {
    const reason = (error as Error).message;
    for (const kind of missing) outcomes.set(kind, failure(kind, reason));
    if (missing.length) options.say(`Couldn't install the agents in ${options.dir}: ${reason}`);
    return ordered();
  }
  try {
    // What earlier installs that stopped left behind; another installer can't be at work while this one holds the lock.
    sweep(options.dir, false, options.say);
    let introduced = false;
    for (const kind of missing) {
      if (options.signal?.aborted) {
        outcomes.set(kind, failure(kind, "Otti Connect stopped before it installed it."));
        continue;
      }
      // Another Otti Connect may have installed it while this one waited for the lock.
      const state = complete(kind, options.dir, target);
      if (state === true) {
        outcomes.set(kind, { kind, state: "present", folder: versionDir(kind, options.dir) });
        continue;
      }
      if (options.intro && !introduced) options.say(options.intro);
      introduced = true;
      if (state === "changed") options.say(`${nameOf(kind)} in ${versionDir(kind, options.dir)} changed since Otti Connect installed it (it may have updated itself): installing it again.`);
      outcomes.set(kind, await installOne(kind, options, target, foreign));
    }
    if (options.prune && !options.signal?.aborted) sweep(options.dir, true, options.say);
  } finally {
    release();
  }
  return ordered();
}

/** The agent's own programs in an install for the platform: what the manifest records the sizes of. Null when one is missing. */
function programFiles(kind: AgentKind, folder: string, target: Target): string[] | null {
  if (kind === "claude-code") {
    const entry = sdkEntry(folder);
    const build = entry ? sdkClaudeBuild(entry, target) : null;
    return build ? [build] : null;
  }
  if (kind === "codex") {
    const binary = codexBinary(folder, target);
    return binary && existsSync(codexLauncher(folder)) ? [codexLauncher(folder), binary] : null;
  }
  const agy = join(folder, "agy");
  return existsSync(agy) ? [agy] : null;
}

/** The sizes of the agent's programs, by their path in the install: a program that updated itself has another. */
function programSizes(kind: AgentKind, folder: string, target: Target): Record<string, number> | null {
  const files = programFiles(kind, folder, target);
  if (!files) return null;
  return Object.fromEntries(files.map((file) => [relative(folder, file), statSync(file).size]));
}

/**
 * The pinned version is installed for the platform (true), it isn't
 * (false), or its programs aren't the ones installed (`changed`: agy updates
 * itself when it is run where it can write, as by a person signing in with
 * Otti Connect's copy).
 */
function complete(kind: AgentKind, dir: string, target: Target): boolean | "changed" {
  const folder = installedDir(kind, dir, target);
  if (!folder) return false;
  let recorded: unknown;
  try {
    recorded = (JSON.parse(readFileSync(join(folder, MANIFEST_FILE), "utf8")) as { files?: unknown }).files;
  } catch {
    return false;
  }
  let sizes: Record<string, number> | null;
  try {
    sizes = programSizes(kind, folder, target);
  } catch {
    sizes = null;
  }
  return sizes && JSON.stringify(sizes) === JSON.stringify(recorded) ? true : "changed";
}

/** The agents folder holds something besides the pinned versions that a sweep would remove. */
function leftovers(dir: string, prune: boolean): boolean {
  return AGENT_KINDS.some((kind) => entries(join(dir, kind)).some((name) => name !== versionOf(kind) && (prune || name.startsWith("."))));
}

function entries(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * Removes what stopped installs left (dot folders) and, with `versions`, the
 * versions this release doesn't pin. Only under the install lock.
 */
function sweep(dir: string, versions: boolean, say: (line: string) => void): void {
  for (const kind of AGENT_KINDS) {
    const parent = join(dir, kind);
    for (const name of entries(parent)) {
      if (name === versionOf(kind)) continue;
      if (!name.startsWith(".") && !versions) continue;
      try {
        removeTree(join(parent, name));
        if (!name.startsWith(".")) say(`Removed ${AGENT_NAMES[kind]} ${name}: this version of Otti Connect runs ${versionOf(kind)}.`);
      } catch (error) {
        say(`Couldn't remove ${join(parent, name)}: ${(error as Error).message}`);
      }
    }
  }
}

/** Waits for the agents folder's install lock while another live Otti Connect holds it. */
async function installLock(dir: string, say: (line: string) => void, signal?: AbortSignal): Promise<() => void> {
  try {
    mkdirSync(dir, { recursive: true });
  } catch (error) {
    throw new InstallError(`Otti Connect can't create ${dir}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`);
  }
  let told = false;
  for (;;) {
    let lock: ReturnType<typeof tryLock>;
    try {
      lock = tryLock(join(dir, INSTALL_LOCK));
    } catch (error) {
      throw new InstallError((error as Error).message);
    }
    if ("release" in lock) return lock.release;
    if (!told) say(`Another Otti Connect (process ${lock.holder}) is installing agents in ${dir}: waiting for it to finish.`);
    told = true;
    await sleep(1_000, signal);
    if (signal?.aborted) throw new InstallError("Otti Connect stopped while it waited for another one's install.");
  }
}

/** Installs one agent into a temporary folder, checks it, and renames it into place. */
async function installOne(kind: AgentKind, options: InstallOptions, target: Target, foreign: boolean): Promise<InstallOutcome> {
  const final = versionDir(kind, options.dir);
  const parent = dirname(final);
  const temp = join(parent, `.${versionOf(kind)}.${process.pid}.${randomBytes(4).toString("hex")}.partial`);
  const pin = PINNED_AGENTS[kind];
  const started = Date.now();
  const progress = { text: "" };
  options.say(`Installing ${nameOf(kind)}${foreign ? ` for ${targetLabel(target)}` : ""} (a ${pin.downloadMB} MB download, ${pin.diskMB} MB on disk) …`);
  const ticker = setInterval(() => options.say(`  … ${progress.text || `still installing ${AGENT_NAMES[kind]}`} (${duration(Date.now() - started)})`), TICK_MS);
  try {
    mkdirSync(parent, { recursive: true });
    mkdirSync(temp);
    if (kind === "antigravity") await installAntigravity(temp, target, foreign, options.signal, progress);
    else await installFromNpm(kind, temp, target, foreign, options.signal);
    const files = programSizes(kind, temp, target);
    if (!files) throw new InstallError(`the install holds no program of ${AGENT_NAMES[kind]}'s for ${targetLabel(target)}.`);
    // Written last: a folder without it, or with another one, is never used.
    writeFileSync(
      join(temp, MANIFEST_FILE),
      `${JSON.stringify({ spec: pinnedSpec(kind, target), files, installedAt: new Date().toISOString(), installedBy: `${CONNECTOR.name} ${CONNECTOR.version}` }, null, 2)}\n`,
    );
    if (existsSync(final)) {
      // An install this release doesn't take (another platform's, another release's of the same version, one that changed): replaced.
      const aside = join(parent, `.${versionOf(kind)}.${process.pid}.${randomBytes(4).toString("hex")}.old`);
      renameSync(final, aside);
      renameSync(temp, final);
      removeTree(aside);
    } else renameSync(temp, final);
    options.say(`Installed ${nameOf(kind)} (${duration(Date.now() - started)}).`);
    return { kind, state: "installed", folder: final };
  } catch (error) {
    try {
      removeTree(temp);
    } catch {
      // The next install removes it.
    }
    const reason = options.signal?.aborted ? "Otti Connect stopped before the install finished." : (error as Error).message;
    options.say(`Couldn't install ${nameOf(kind)}: ${reason}`);
    return failure(kind, reason);
  } finally {
    clearInterval(ticker);
  }
}

/** An agent that isn't installed, and why: the next start tries again. */
function failure(kind: AgentKind, reason: string): InstallOutcome {
  return { kind, state: "failed", reason, detail: `Otti Connect couldn't install ${nameOf(kind)}: ${reason} It tries again when it starts next.` };
}

// ---------------------------------------------------------------------------
// npm: Claude Code and Codex
// ---------------------------------------------------------------------------

/** npm: the one that started Otti Connect (`npx`), the one beside this Node.js, or the one on the PATH. */
function locateNpm(): { file: string; args: string[] } | null {
  const bin = dirname(process.execPath);
  for (const path of [process.env.npm_execpath, join(bin, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"), join(bin, "node_modules", "npm", "bin", "npm-cli.js")])
    if (path && /npm-cli\.[cm]?js$/.test(path) && existsSync(path)) return { file: process.execPath, args: [path] };
  const npm = locateExecutable(["npm"]);
  return npm ? { file: npm, args: [] } : null;
}

/** npm's settings from the environment that `npx` passes on (its registry, its prefix) don't apply to the install; the person's network settings do. */
const NPM_SETTINGS_KEPT = /^npm_config_(https?_proxy|proxy|no_?proxy|cafile|ca|cert|key|strict_ssl|userconfig|globalconfig|local_address|maxsockets|fetch_[a-z_]+)$/i;

function npmEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) if (value !== undefined && (!/^npm_/i.test(name) || NPM_SETTINGS_KEPT.test(name))) env[name] = value;
  return env;
}

async function installFromNpm(kind: AgentKind, temp: string, target: Target, foreign: boolean, signal?: AbortSignal): Promise<void> {
  const npm = locateNpm();
  if (!npm) throw new InstallError(`npm isn't on this computer, and Otti Connect installs ${AGENT_NAMES[kind]} with it. Install Node.js with npm, then start Otti Connect again.`);
  const packages: Record<string, string> = kind === "claude-code" ? CLAUDE_CODE.packages : CODEX.packages;
  const cache = join(temp, ".npm-cache");
  const args = [
    ...npm.args,
    "install",
    "--prefix", temp,
    "--registry", NPM_REGISTRY,
    // Its own cache, removed with the install's leftovers: the agents' builds don't stay twice on disk.
    "--cache", cache,
    "--no-save",
    "--no-package-lock",
    "--no-audit",
    "--no-fund",
    "--no-update-notifier",
    "--ignore-scripts",
    "--include=optional",
    "--loglevel=error",
    "--no-progress",
    // Another platform's builds: npm picks the agents' optional packages for it.
    ...(foreign ? [`--os=${target.os}`, `--cpu=${target.arch}`, ...(target.libc ? [`--libc=${target.libc}`] : [])] : []),
    ...Object.entries(packages).map(([name, version]) => `${name}@${version}`),
  ];
  const result = await run(npm.file, args, { cwd: temp, env: npmEnvironment(), timeoutMs: NPM_TIMEOUT_MS, signal });
  removeTree(cache);
  if (result.code !== 0) throw new InstallError(result.timedOut ? `npm install didn't finish within ${duration(NPM_TIMEOUT_MS)}.` : npmFailure(result.output, result.code));

  // What npm installed is what this release pins, with the build for the platform.
  for (const [name, version] of Object.entries(packages)) {
    const found = packageVersion(temp, name);
    if (found !== version) throw new InstallError(`npm installed ${name} ${found ?? "nowhere"} instead of ${version}.`);
  }
  if (kind === "claude-code") {
    const entry = sdkEntry(temp);
    const claudeCode = (readPackage(temp, "@anthropic-ai/claude-agent-sdk") as { claudeCodeVersion?: unknown } | null)?.claudeCodeVersion;
    if (claudeCode !== CLAUDE_CODE.version) throw new InstallError(`The Claude Agent SDK brings Claude Code ${String(claudeCode)}, not ${CLAUDE_CODE.version}.`);
    const build = entry ? sdkClaudeBuild(entry, target) : null;
    if (!build) throw new InstallError(`npm didn't install the Claude Code build for ${targetLabel(target)}, one of the Agent SDK's optional packages (is npm set to leave optional packages out?).`);
    if (!foreign) await checkVersion(kind, build, [], temp);
  } else {
    if (!codexBinary(temp, target)) throw new InstallError(`npm didn't install Codex's program for ${targetLabel(target)}, one of its optional packages (is npm set to leave optional packages out?).`);
    if (!foreign) await checkVersion(kind, process.execPath, [codexLauncher(temp)], temp);
  }
}

function readPackage(folder: string, name: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(join(folder, "node_modules", name, "package.json"), "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function packageVersion(folder: string, name: string): string | undefined {
  const version = readPackage(folder, name)?.version;
  return typeof version === "string" ? version : undefined;
}

/** npm's own words for a failure: its error code and the line that says what went wrong. */
function npmFailure(output: string, code: number | null): string {
  const errors = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^npm (ERR!|error)\b/.test(line))
    .map((line) => line.replace(/^npm (ERR!|error)\s*/, ""))
    .filter(Boolean);
  const errorCode = errors.map((line) => /^code (\S+)/.exec(line)?.[1]).find(Boolean);
  const message = errors.filter((line) => !/^(code|errno|syscall|path|dest|A complete log|Log files were not written|You can rerun)\b/i.test(line)).slice(0, 2).join(" ");
  const what = `npm install failed${errorCode ? ` (${errorCode})` : code !== null ? ` (exit code ${code})` : ""}`;
  const tail = message || output.trim().split(/\r?\n/).slice(-2).join(" ");
  const text = `${what}${tail ? `: ${tail}` : ""}`.slice(0, 500).trimEnd();
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

// ---------------------------------------------------------------------------
// Antigravity's CLI: Google's archive, checked against its SHA-512
// ---------------------------------------------------------------------------

async function installAntigravity(temp: string, target: Target, foreign: boolean, signal: AbortSignal | undefined, progress: { text: string }): Promise<void> {
  const archive = antigravityArchive(target);
  if (!archive) throw new InstallError(unsupportedReason("antigravity", target) ?? `there is no archive for ${targetLabel(target)}.`);
  const file = join(temp, "agy.tar.gz");
  const { sha512 } = await download(archive.url, file, signal, (bytes, total) => {
    progress.text = `downloaded ${Math.round(bytes / 1e6)}${total ? ` of ${Math.round(total / 1e6)}` : ""} MB of ${AGENT_NAMES.antigravity}`;
  });
  if (sha512 !== archive.sha512)
    throw new InstallError(`the download from ${archive.url} doesn't match the SHA-512 Otti Connect pins for it (${sha512.slice(0, 16)}… instead of ${archive.sha512.slice(0, 16)}…), so it wasn't installed.`);
  const agy = join(temp, "agy");
  if (!(await unpackFile(file, "antigravity", agy))) throw new InstallError("Google's archive holds no program `antigravity`.");
  rmSync(file);
  chmodSync(agy, 0o755);
  if (foreign) return;
  // As Google's installer does on macOS, in case the download was marked as one.
  if (process.platform === "darwin") await run("xattr", ["-d", "com.apple.quarantine", agy], { cwd: temp, env: process.env as Record<string, string>, timeoutMs: 10_000 }).catch(() => {});
  await checkVersion("antigravity", agy, [], temp);
}

/** Downloads `url` into `file`, hashing it on the way: its SHA-512 in hex. */
async function download(url: string, file: string, signal: AbortSignal | undefined, progress: (bytes: number, total: number | null) => void): Promise<{ sha512: string; bytes: number }> {
  const controller = new AbortController();
  const stop = () => controller.abort();
  if (signal?.aborted) stop();
  signal?.addEventListener("abort", stop, { once: true });
  let stalled = false;
  let timer = setTimeout(() => ((stalled = true), stop()), STALL_MS);
  const alive = () => {
    clearTimeout(timer);
    timer = setTimeout(() => ((stalled = true), stop()), STALL_MS);
  };
  const hash = createHash("sha512");
  let bytes = 0;
  const out = createWriteStream(file, { flags: "wx", mode: 0o600 });
  const failed = new Promise<never>((_, reject) => out.on("error", reject));
  failed.catch(() => {});
  try {
    let response: Response;
    try {
      response = await fetch(url, { signal: controller.signal, redirect: "follow" });
    } catch (error) {
      throw new InstallError(`couldn't download ${url}: ${stalled ? "no answer" : describe(error)}.`);
    }
    if (!response.ok || !response.body) throw new InstallError(`couldn't download ${url}: HTTP ${response.status}.`);
    const total = Number(response.headers.get("content-length")) || null;
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        alive();
        hash.update(value);
        bytes += value.length;
        progress(bytes, total);
        if (!out.write(value)) await Promise.race([new Promise<void>((resolve) => out.once("drain", () => resolve())), failed]);
      }
    } catch (error) {
      if (error instanceof InstallError) throw error;
      throw new InstallError(`the download of ${url} broke off after ${Math.round(bytes / 1e6)} MB: ${stalled ? `nothing came for ${duration(STALL_MS)}` : describe(error)}.`);
    }
    await Promise.race([new Promise<void>((resolve) => out.end(resolve)), failed]);
    return { sha512: hash.digest("hex"), bytes };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", stop);
    if (!out.closed) out.destroy();
  }
}

function describe(error: unknown): string {
  const cause = (error as { cause?: { code?: unknown; message?: unknown } } | null)?.cause;
  if (cause && typeof cause.code === "string") return cause.code;
  if (cause && typeof cause.message === "string" && cause.message) return cause.message;
  return error instanceof Error ? error.message : String(error);
}

/**
 * Unpacks one regular file, `member`, of a .tar.gz archive into
 * `destination`, as Google's installer does with `tar -xzf … antigravity`:
 * ustar names with their prefix, GNU long names and pax `path`s. False when
 * the archive doesn't hold it.
 */
export async function unpackFile(archive: string, member: string, destination: string): Promise<boolean> {
  const BLOCK = 512;
  const wanted = member.replace(/^\.\//, "");
  const input = createReadStream(archive);
  const gunzip = input.pipe(createGunzip());
  let buffer: Buffer = Buffer.alloc(0);
  /** Bytes still to pass over: an entry's data or its padding. */
  let skip = 0;
  /** The member being written, and how many of its bytes are still to come. */
  let target: { fd: number; left: number } | null = null;
  /** A GNU long name's or a pax header's data being read, for the next entry's name. */
  let meta: { type: "L" | "x"; left: number; padding: number; parts: Buffer[] } | null = null;
  let nextName: string | null = null;
  let found = false;
  const field = (header: Buffer, start: number, length: number) => {
    const raw = header.subarray(start, start + length);
    const end = raw.indexOf(0);
    return raw.subarray(0, end < 0 ? length : end).toString("utf8");
  };
  const sizeOf = (header: Buffer) => {
    if (header[124]! & 0x80) {
      // Base-256, for entries of 8 GiB and more.
      let size = 0;
      for (let index = 125; index < 136; index++) size = size * 256 + header[index]!;
      return size;
    }
    return parseInt(field(header, 124, 12).trim() || "0", 8) || 0;
  };
  /** Reads what the buffer holds; true once the member is written or the archive ended. */
  const consume = (): boolean => {
    for (;;) {
      if (target) {
        const count = Math.min(target.left, buffer.length);
        if (count) writeSync(target.fd, buffer, 0, count);
        buffer = buffer.subarray(count);
        target.left -= count;
        if (target.left > 0) return false;
        closeSync(target.fd);
        target = null;
        found = true;
        return true;
      }
      if (meta) {
        const count = Math.min(meta.left, buffer.length);
        meta.parts.push(Buffer.from(buffer.subarray(0, count)));
        buffer = buffer.subarray(count);
        meta.left -= count;
        if (meta.left > 0) return false;
        const data = Buffer.concat(meta.parts).toString("utf8");
        if (meta.type === "L") nextName = data.replace(/\0+$/, "");
        else {
          const path = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(data)?.[1];
          if (path) nextName = path;
        }
        skip = meta.padding;
        meta = null;
        continue;
      }
      if (skip) {
        const count = Math.min(skip, buffer.length);
        buffer = buffer.subarray(count);
        skip -= count;
        if (skip) return false;
        continue;
      }
      if (buffer.length < BLOCK) return false;
      const header = buffer.subarray(0, BLOCK);
      buffer = buffer.subarray(BLOCK);
      if (header.every((byte) => byte === 0)) return true;
      const prefix = field(header, 257, 5) === "ustar" ? field(header, 345, 155) : "";
      const name = (nextName ?? (prefix ? `${prefix}/${field(header, 0, 100)}` : field(header, 0, 100))).replace(/^\.\//, "");
      nextName = null;
      const size = sizeOf(header);
      const padding = (BLOCK - (size % BLOCK)) % BLOCK;
      const type = String.fromCharCode(header[156]!);
      if (type === "L" || type === "x") meta = { type, left: size, padding, parts: [] };
      else if (name === wanted && (type === "0" || type === "\0" || type === "7")) {
        target = { fd: openSync(destination, "wx", 0o700), left: size };
        if (!size) {
          closeSync(target.fd);
          target = null;
          found = true;
          return true;
        }
      } else skip = size + padding;
    }
  };
  try {
    for await (const chunk of gunzip as AsyncIterable<Buffer>) {
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
      if (consume()) break;
    }
  } finally {
    const open = target as { fd: number } | null;
    if (open) closeSync(open.fd);
    input.destroy();
    gunzip.destroy();
  }
  if (!found) rmSync(destination, { force: true });
  return found;
}

// ---------------------------------------------------------------------------
// Running programs, checking them, removing installs
// ---------------------------------------------------------------------------

type RunResult = { code: number | null; output: string; timedOut: boolean };

/** Runs a program to its end, keeping the last 16 KiB of what it prints; a stop or the timeout ends it. */
function run(file: string, args: string[], options: { cwd: string; env: Record<string, string>; timeoutMs: number; signal?: AbortSignal }): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    let output = "";
    let timedOut = false;
    const child = spawn(file, args, { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const keep = (chunk: Buffer) => {
      output = (output + chunk.toString("utf8")).slice(-16_384);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const stop = () => child.kill("SIGTERM");
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeoutMs);
    options.signal?.addEventListener("abort", stop, { once: true });
    child.on("error", (error) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", stop);
      reject(new InstallError(`${file} couldn't run: ${(error as NodeJS.ErrnoException).code ?? error.message}.`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", stop);
      resolve({ code, output, timedOut });
    });
  });
}

/** Runs a fresh install's program with `--version`, in a home folder of its own: it runs here, and it is the pinned version. */
async function checkVersion(kind: AgentKind, file: string, args: string[], temp: string): Promise<void> {
  const home = join(temp, ".check-home");
  mkdirSync(home, { recursive: true });
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) if (value !== undefined) env[name] = value;
  Object.assign(env, { HOME: home, CODEX_HOME: join(home, ".codex"), DISABLE_AUTOUPDATER: "1", AGY_CLI_DISABLE_AUTO_UPDATE: "1" });
  try {
    const result = await run(file, [...args, "--version"], { cwd: temp, env, timeoutMs: CHECK_TIMEOUT_MS });
    const version = versionOf(kind);
    if (result.code === 0 && new RegExp(`(^|[^0-9.])${version.replace(/\./g, "\\.")}($|[^0-9])`).test(result.output)) return;
    const said = result.output.trim().split(/\r?\n/).slice(-2).join(" ").slice(0, 300);
    throw new InstallError(
      result.timedOut
        ? `the program didn't say its version within ${duration(CHECK_TIMEOUT_MS)}.`
        : result.code === 0
          ? `the program installed says it is ${said || "no version"}, not ${version}.`
          : `the program installed doesn't run here (exit code ${result.code ?? "none"}${said ? `: ${said}` : ""}).`,
    );
  } finally {
    removeTree(home);
  }
}

/** Removes a folder and what it holds, read-only folders in it included. */
function removeTree(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
    return;
  } catch (error) {
    if (!["EACCES", "EPERM", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
  }
  const writable = (folder: string) => {
    try {
      chmodSync(folder, 0o700);
    } catch {
      // Not ours: rmSync says so below.
    }
    for (const name of entries(folder)) {
      const child = join(folder, name);
      try {
        if (lstatSync(child).isDirectory()) writable(child);
      } catch {
        // Gone meanwhile.
      }
    }
  };
  writable(path);
  rmSync(path, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Links to the programs (the container image)
// ---------------------------------------------------------------------------

/**
 * Puts a link to each installed agent's own program (`claude`, `codex`,
 * `agy`) into `binDir`, for a machine that has no other copy of the agents,
 * such as the container image, where a person signs in to each with its own
 * command. Returns a line per link.
 */
export function linkPrograms(binDir: string, dir: string, target: Target = currentTarget()): string[] {
  mkdirSync(binDir, { recursive: true });
  const lines: string[] = [];
  for (const kind of AGENT_KINDS) {
    const folder = installedDir(kind, dir, target);
    if (!folder) continue;
    const entry = kind === "claude-code" ? sdkEntry(folder) : null;
    const program = kind === "claude-code" ? (entry ? sdkClaudeBuild(entry, target) : null) : kind === "codex" ? codexLauncher(folder) : join(folder, "agy");
    if (!program || !existsSync(program)) continue;
    const link = join(binDir, COMMAND_NAMES[kind]);
    try {
      if (!lstatSync(link).isSymbolicLink()) throw new InstallError(`${link} is there already and isn't a link, so Otti Connect leaves it.`);
      unlinkSync(link);
    } catch (error) {
      if (error instanceof InstallError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    symlinkSync(program, link);
    lines.push(`${link} → ${program}`);
  }
  return lines;
}

/** A line per agent for `otti-connect install`: what it did. */
export function describeOutcomes(outcomes: readonly InstallOutcome[]): string[] {
  return outcomes.map((outcome) => {
    const name = `${AGENT_NAMES[outcome.kind]} ${versionOf(outcome.kind)}`.padEnd(26);
    switch (outcome.state) {
      case "present":
        return `${name}  installed before, in ${outcome.folder}`;
      case "installed":
        return `${name}  installed now, in ${outcome.folder}`;
      case "override":
        return `${name}  ${outcome.reason ?? ""}`;
      case "unsupported":
        return `${name}  not available: ${outcome.reason ?? ""}`;
      case "failed":
        return `${name}  not installed: ${outcome.reason ?? ""}`;
    }
  });
}

