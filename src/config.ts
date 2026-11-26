import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, unlinkSync, writeSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/**
 * Where Otti Connect keeps this computer's sign-in to Octomerge:
 * `<config dir>/connect.json`, readable by its owner only (0600), holding the
 * server it signed in to, the token, the agent host it registered as and its
 * label. The token is never printed or logged.
 */

export const DEFAULT_BASE_URL = "https://octomerge.dev";
export const CONFIG_FILE = "connect.json";
/** A computer's label, as Octomerge's worker labels: letters, digits, dots, hyphens, underscores. */
export const LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;

export type ConnectConfig = {
  /** The Octomerge the token was issued by, the only server it is sent to. */
  baseUrl: string;
  token?: string;
  hostId?: string;
  label?: string;
};

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function defaultConfigDir(): string {
  return join(homedir(), ".otti-connect");
}

/** A folder named on the command line: `~/…` is the home folder even where no shell expanded it (`--config-dir=~/x`). */
export function resolveConfigDir(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return isAbsolute(value) ? value : resolve(value);
}

export function configPath(dir: string): string {
  return join(dir, CONFIG_FILE);
}

/** An Octomerge's origin, as `--base-url` or OTTI_CONNECT_BASE_URL name it. */
export function parseBaseUrl(value: string, setting: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new ConfigError(`${setting} is not a URL: name an Octomerge such as ${DEFAULT_BASE_URL}`);
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== ""))
    throw new ConfigError(`${setting} must be an Octomerge's address such as ${DEFAULT_BASE_URL}, without a path, query or credentials`);
  return url.origin;
}

/** This computer's name made a label: the host name without `.local`, other characters as hyphens. */
export function defaultLabel(name = hostname()): string {
  const label = name
    .trim()
    .replace(/\.local\.?$/i, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "")
    .slice(0, 63)
    .replace(/[._-]+$/, "");
  return LABEL_PATTERN.test(label) ? label : "computer";
}

/** The saved sign-in, or null when there is none. A file Otti Connect can't read is an error that names it. */
export function readConnectConfig(dir: string): ConnectConfig | null {
  const path = configPath(dir);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new ConfigError(`Otti Connect can't read ${path}: ${(error as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConfigError(`${path} isn't a sign-in Otti Connect saved (not JSON). Remove it, or use --config-dir for another folder.`);
  }
  const value = parsed as Record<string, unknown> | null;
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.baseUrl !== "string")
    throw new ConfigError(`${path} isn't a sign-in Otti Connect saved. Remove it, or use --config-dir for another folder.`);
  const text = (key: string) => (typeof value[key] === "string" && value[key] ? (value[key] as string) : undefined);
  let baseUrl: string;
  try {
    baseUrl = parseBaseUrl(value.baseUrl, `The baseUrl in ${path}`);
  } catch (error) {
    throw new ConfigError((error as Error).message);
  }
  const token = text("token"), hostId = text("hostId"), label = text("label");
  return { baseUrl, ...(token ? { token } : {}), ...(hostId ? { hostId } : {}), ...(label && LABEL_PATTERN.test(label) ? { label } : {}) };
}

/** Saves the sign-in: a new file readable by its owner only, renamed over the old one, so a crash never leaves half of it. */
export function writeConnectConfig(dir: string, config: ConnectConfig): void {
  const path = configPath(dir);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw new ConfigError(`Otti Connect can't create ${dir}: ${(error as Error).message}`);
  }
  const temporary = join(dir, `.${CONFIG_FILE}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  const body = `${JSON.stringify({ baseUrl: config.baseUrl, ...(config.token ? { token: config.token } : {}), ...(config.hostId ? { hostId: config.hostId } : {}), ...(config.label ? { label: config.label } : {}) }, null, 2)}\n`;
  try {
    const descriptor = openSync(temporary, "wx", 0o600);
    try {
      writeSync(descriptor, body);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, path);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // It was never created.
    }
    throw new ConfigError(`Otti Connect can't save its sign-in to ${path}: ${(error as Error).message}`);
  }
}

/** Fails before a sign-in starts when its result could not be saved, so nobody approves a code for nothing. */
export function assertConfigWritable(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const probe = join(dir, `.${CONFIG_FILE}.${process.pid}.${randomBytes(4).toString("hex")}.probe`);
    closeSync(openSync(probe, "wx", 0o600));
    unlinkSync(probe);
  } catch (error) {
    throw new ConfigError(`Otti Connect can't save a sign-in in ${dir}: ${(error as Error).message}. Use --config-dir to name a folder it can write.`);
  }
}

/** Forgets the saved sign-in. True when there was one. */
export function removeConnectConfig(dir: string): boolean {
  const path = configPath(dir);
  try {
    rmSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new ConfigError(`Otti Connect can't remove ${path}: ${(error as Error).message}`);
  }
}
