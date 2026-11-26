import type { ToolSpec } from "../protocol";

const isNullSchema = (value: unknown) =>
  !!value && typeof value === "object" && (value as Record<string, unknown>).type === "null" && Object.keys(value).length === 1;

/**
 * A JSON Schema pattern (an ECMAScript regular expression) as Go's regexp
 * (RE2), which Antigravity's CLI checks tool schemas with, reads it:
 * `\uXXXX` and `\u{X…}` become `\x{X…}`. Null for one RE2 can't read at all
 * (lookarounds, backreferences).
 */
export function re2Pattern(pattern: string): string | null {
  let out = "";
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index]!;
    if (char !== "\\") {
      out += char;
      continue;
    }
    const rest = pattern.slice(index + 1);
    const unicode = /^u([0-9A-Fa-f]{4})/.exec(rest) ?? /^u\{([0-9A-Fa-f]{1,6})\}/.exec(rest);
    if (unicode) {
      out += `\\x{${unicode[1]}}`;
      index += unicode[0].length;
    } else if (/^[1-9k]/.test(rest)) return null;
    else {
      // Any other escape, kept as written (an escaped backslash too).
      out += char + (pattern[index + 1] ?? "");
      index++;
    }
  }
  return /\(\?<?[=!]/.test(out) ? null : out;
}

/**
 * A tool's input schema as Antigravity's CLI takes it. It checks each MCP
 * tool's schema and refuses one it can't read (1.5.16 refused a pattern
 * holding `\u2028`, which Go's regexp doesn't take, and the model never saw
 * the tool). Patterns are written as RE2 reads them, or left out; Gemini's
 * function declarations take a subset of JSON Schema besides, so null
 * alternatives go (a field that may be null is optional anyway), and so do
 * `$schema` keys, and `const` becomes a one-value `enum`. The client still
 * checks each call's input against the tool's own schema.
 */
export function geminiToolSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(geminiToolSchema);
  if (!schema || typeof schema !== "object") return schema;
  const own: Record<string, unknown> = {};
  let merged: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (key === "$schema" || (key === "default" && value === null)) continue;
    if (key === "pattern" && typeof value === "string") {
      const pattern = re2Pattern(value);
      if (pattern !== null) own.pattern = pattern;
    } else if (key === "patternProperties" && value && typeof value === "object" && !Array.isArray(value)) {
      const entries = Object.entries(value as Record<string, unknown>).flatMap(([pattern, child]) => {
        const re2 = re2Pattern(pattern);
        return re2 === null ? [] : [[re2, geminiToolSchema(child)] as const];
      });
      if (entries.length) own.patternProperties = Object.fromEntries(entries);
    } else if (key === "type" && Array.isArray(value)) {
      const types = value.filter((type) => type !== "null");
      if (types.length === 1) own.type = types[0];
      else if (types.length > 1) own.anyOf = types.map((type) => ({ type }));
    } else if (key === "enum" && Array.isArray(value)) own.enum = value.filter((item) => item !== null);
    else if (key === "const") {
      if (value !== null) own.enum = [value];
    } else if ((key === "anyOf" || key === "oneOf") && Array.isArray(value)) {
      const branches = value.filter((branch) => !isNullSchema(branch)).map(geminiToolSchema);
      // One alternative left: the schema is that one, with this one's own keywords.
      if (branches.length === 1 && branches[0] && typeof branches[0] === "object" && !Array.isArray(branches[0])) merged = branches[0] as Record<string, unknown>;
      else own[key] = branches;
    } else own[key] = geminiToolSchema(value);
  }
  return { ...merged, ...own };
}

/**
 * How much of the client's tools Antigravity's CLI is offered, in characters
 * of their descriptions and schemas. The CLI keeps an MCP server's tools
 * smallest first within a budget of its own and leaves out the rest without
 * a word (1.5.16: between 55,600 and 58,400 characters, measured with
 * Octomerge's tools). Offered within this budget, the CLI leaves nothing out,
 * and the tools left out are the ones last in the client's order.
 */
const TOOL_BUDGET = 48_000;

/** The client's tools as the CLI is offered them, in the client's order within the budget, and the names of those left out. */
export function antigravityTools(tools: readonly ToolSpec[]) {
  const offered: Array<{ name: string; description: string; inputSchema: unknown }> = [];
  const left: string[] = [];
  let total = 0;
  for (const tool of tools) {
    const inputSchema = geminiToolSchema(tool.inputSchema);
    const size = tool.description.length + JSON.stringify(inputSchema).length;
    if (total + size > TOOL_BUDGET) left.push(tool.name);
    else {
      offered.push({ name: tool.name, description: tool.description, inputSchema });
      total += size;
    }
  }
  return { offered, left };
}
