/**
 * The agents Otti Connect runs, pinned: the versions Octomerge tests with this
 * release of Otti Connect. Otti Connect installs exactly these, each in a
 * folder of its own (`<config dir>/agents/<agent>/<version>/`, by default
 * under `~/.otti-connect/agents/`), and a new release of Otti Connect brings
 * its own. The agents a person installed themselves stay as they are; both
 * use the same sign-ins, which live in the person's home folder.
 *
 * This file has no imports, so Octomerge's server can read it as it is to
 * show the tested versions. Its keys are the agent kinds of protocol.ts.
 */

/**
 * Where Otti Connect installs the agents that come from npm: npm's public
 * registry, whichever registry `npx` was pointed at to start Otti Connect.
 */
export const NPM_REGISTRY = "https://registry.npmjs.org";

const CLAUDE_AGENT_SDK = "0.3.331";

/**
 * Claude Code, which Otti Connect drives through the Claude Agent SDK. The
 * SDK's version pins Claude Code's: one of the SDK's optional packages holds
 * the Claude Code build for each platform, and npm installs the one for this
 * computer.
 */
export const CLAUDE_CODE = {
  /** Claude Code's version: the build this SDK brings (its package's `claudeCodeVersion`). */
  version: "2.1.331",
  sdkVersion: CLAUDE_AGENT_SDK,
  /** The npm packages installed together, at exactly these versions. */
  packages: {
    "@anthropic-ai/claude-agent-sdk": CLAUDE_AGENT_SDK,
    // What Otti Connect loads with the SDK: Octomerge's tools as an MCP server.
    "@modelcontextprotocol/sdk": "1.32.2",
    zod: "4.6.7",
    // A peer of the SDK that Otti Connect doesn't load, pinned so that npm
    // doesn't add its latest version.
    "@anthropic-ai/sdk": "1.13.0",
  },
  /** About what one install downloads and takes on disk, in MB (Linux x64; the other platforms are within 10 %). */
  downloadMB: 190,
  diskMB: 450,
} as const;

/** Codex: its npm package, whose optional package for this platform holds the program. */
export const CODEX = {
  version: "0.172.0",
  packages: { "@openai/codex": "0.172.0" },
  downloadMB: 180,
  diskMB: 450,
} as const;

/**
 * Google Antigravity's CLI (`agy`): Google's release archive for each
 * platform, which holds the program as `antigravity`, checked against its
 * SHA-512 before it is unpacked, as Google's installer
 * (https://antigravity.google/cli/install.sh) checks it against its release
 * manifest. Keys are `<platform>-<arch>` as Node.js names them.
 *
 * The Linux archives' SHA-512 are those Google's release manifests gave for
 * 1.5.16. The manifests had moved on to 1.5.18 when the macOS archives were
 * pinned, so theirs were computed from Google's bucket (each download's MD5
 * matching the bucket's own) on 26 November 2026.
 */
export const ANTIGRAVITY = {
  version: "1.5.16",
  build: "5250855658717184",
  archives: {
    "linux-x64": {
      url: "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.16-5250855658717184/linux-x64/cli_linux_x64.tar.gz",
      sha512: "3dee9f26e298156db673f6ce2a0f5dfed5b30006e04ceb9809c68070e7b717587b33a3da0f8bc2eda45af81a50bc8b14c82b28ae5832bcfe3e7fd49397117b31",
    },
    "linux-arm64": {
      url: "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.16-5250855658717184/linux-arm/cli_linux_arm64.tar.gz",
      sha512: "23c193151499a4986fd5fa0d8132665cc8ffbad6cc0b3ff4fd53a2cb68abb76b149a992b836d53063443cd89add335f14d8134fb02abdcecbf6e1eaef6c53d33",
    },
    "darwin-x64": {
      url: "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.16-5250855658717184/darwin-x64/cli_mac_x64.tar.gz",
      sha512: "b3eae073ee633032e9d473cdc7725c30bdfe2e09436bc36cfb3422e7e5fa3733de9591a7f78d02362294e7bf87e345d70e5d839689e526129a6f3fc041857a05",
    },
    "darwin-arm64": {
      url: "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.16-5250855658717184/darwin-arm/cli_mac_arm64.tar.gz",
      sha512: "33f5617dc74fea606d47b2483c6d271c850c9f3c9c55b724c664c3c0d4b82100d819fbcf55714f851765f6628d4296883ac8939b4fdeb55d5e6b9ce923135d18",
    },
  },
  downloadMB: 100,
  diskMB: 280,
} as const;

/** The pinned agents by kind. */
export const PINNED_AGENTS = { "claude-code": CLAUDE_CODE, codex: CODEX, antigravity: ANTIGRAVITY } as const;

/** The tested versions, as Octomerge shows them: each agent's name and version, and what drives it. */
export const TESTED_VERSIONS = [
  { kind: "claude-code", name: "Claude Code", version: CLAUDE_CODE.version, through: `the Claude Agent SDK ${CLAUDE_AGENT_SDK}` },
  { kind: "codex", name: "Codex", version: CODEX.version, through: "codex app-server" },
  { kind: "antigravity", name: "Antigravity's CLI", version: ANTIGRAVITY.version, through: "agy acp" },
] as const;
