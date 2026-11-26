import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type { ConnectorEventBody } from "./protocol";

// A release build replaces these (Bun.build's `define`): the published version, and the digest of what was published.
declare const __OTTI_CONNECT_VERSION__: string | undefined;
declare const __OTTI_CONNECT_CONTENT_DIGEST__: string | undefined;

/** The connector's own name and version, as `hello` and the registration report them. A build from source is `0.0.0-development`. */
export const CONNECTOR = {
  name: "otti-connect",
  version: typeof __OTTI_CONNECT_VERSION__ === "string" ? __OTTI_CONNECT_VERSION__ : "0.0.0-development",
  contentDigest: typeof __OTTI_CONNECT_CONTENT_DIGEST__ === "string" ? __OTTI_CONNECT_CONTENT_DIGEST__ : null,
} as const;

/** Writes one event line to the client, numbered. */
export type Emit = (event: ConnectorEventBody) => void;

export function createEmit(write: (line: string) => void): Emit {
  let seq = 0;
  return (event) => write(`${JSON.stringify({ ...event, seq: ++seq })}\n`);
}

/** Text that survives JSON and a database: no NUL and no lone surrogates. */
export function storableText(value: string): string {
  return value.replace(/\u0000/g, "").replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD");
}

/** A value made storable and bounded: what an own tool call's input and output are reported as. */
export function boundedValue(value: unknown, maxChars: number): unknown {
  if (typeof value === "string") {
    const text = storableText(value);
    return text.length > maxChars ? `${text.slice(0, maxChars)}\n… (${text.length - maxChars} more characters)` : text;
  }
  let json: string;
  try {
    json = JSON.stringify(value ?? null);
  } catch {
    return null;
  }
  if (json.length <= maxChars) return JSON.parse(storableText(json));
  // Too long whole: keep its fields, each cut short.
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>);
    const share = Math.max(200, Math.floor(maxChars / Math.max(1, entries.length)));
    return Object.fromEntries(entries.map(([key, entry]) => [key, boundedValue(entry, share)]));
  }
  return `${storableText(json).slice(0, maxChars)}… (cut)`;
}

export function boundedText(value: unknown, maxChars: number): string {
  const text = boundedValue(typeof value === "string" ? value : value === undefined || value === null ? "" : JSON.stringify(value), maxChars);
  return typeof text === "string" ? text : "";
}

/** Folders where agent CLIs are often installed but that an agent shell's PATH may lack. */
function extraDirs(): string[] {
  const home = homedir();
  return [join(home, ".local", "bin"), join(home, ".claude", "local"), join(home, ".npm-global", "bin"), join(home, ".bun", "bin"), "/opt/homebrew/bin", "/usr/local/bin"];
}

/** The first of `names` found on PATH or in the usual install folders; null when none is. */
export function locateExecutable(names: readonly string[]): string | null {
  const dirs = [...(process.env.PATH ?? "").split(delimiter).filter(Boolean), ...extraDirs()];
  for (const name of names) {
    if (name.includes("/")) {
      if (executable(name)) return name;
      continue;
    }
    for (const dir of dirs) {
      const path = join(dir, name);
      if (executable(path)) return path;
    }
  }
  return null;
}

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The environment an agent CLI starts with: this process's, without the variables that would replace the person's own sign-in. */
export function agentEnvironment(remove: readonly string[], add: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) if (value !== undefined && !remove.includes(name)) env[name] = value;
  // The agent CLIs find their helpers on a PATH that holds their usual install folders.
  env.PATH = [...(env.PATH ?? "").split(delimiter).filter(Boolean), ...extraDirs()].join(delimiter);
  return { ...env, ...add };
}

/** The message's text with a note for each image the agent cannot be shown. */
export function textWithImageNote(text: string, images: number, reason: string): string {
  if (!images) return text;
  return `${text}\n\n(${images === 1 ? "An image was" : `${images} images were`} attached to this message, but ${reason}.)`;
}
