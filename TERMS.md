# What each agent's terms allow

Otti Connect runs coding agents that Anthropic, OpenAI and Google make and
license under their own terms. This page records what those terms say about
using an agent through another product, what Otti Connect does to stay within
them, and what is still unclear. It's kept up to date together with the
community: when a term changes, or something here is wrong, open an issue or
a pull request with the source and the date you checked it.

This isn't legal advice. You choose which agents you use through Otti Connect,
and you're responsible for following each one's terms.

Last checked: 25 November 2026.

## For every agent

- Otti Connect runs the agent's own program, unmodified, as its maker
  publishes it, on your own computer.
- You sign in to each agent with the agent's own command and its maker's own
  sign-in flow, in a terminal on your computer. Otti Connect has no sign-in of
  its own for any agent, and never reads, stores or relays a sign-in, a code
  or a token.
- Your sign-in serves your own chats only. Otti Connect has no way to share or
  pool accounts.
- Today it removes the variables that would make an agent use something other
  than your sign-in (API keys, other endpoints) from the agent's environment.
  See [Open questions](#open-questions).

## Claude Code (Anthropic)

Source: [Claude Code: Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance).

What it says:

- A product that runs Claude Code has to run the binary unmodified, without
  removing any of its sign-in methods, and each end user authenticates with
  their own API key, Claude plan or cloud provider credentials. The product
  may not pay for, resell or intermediate their usage.
- "Anthropic does not permit third-party developers to offer Claude.ai login
  into their own applications, or to route requests through Free, Pro, Max,
  or Ultra plan credentials on behalf of their users." Signing in to a Claude
  account "must complete through Anthropic's own flow".
- This doesn't prevent "an end user from signing in to the unmodified Claude
  Code binary with their own Claude subscription, including where a platform
  hosts Claude Code".
- "Developers building products or services that interact with Claude's
  capabilities, including those using the Agent SDK, should use API key
  authentication".
- A product may say in plain text that it runs Claude Code. Anthropic's names
  and logos may not be part of another product's name or logo, or suggest
  that Anthropic built, endorses or partners with it; other uses need
  Anthropic's written permission.

What Otti Connect does: it drives Claude Code through the Claude Agent SDK,
which runs Anthropic's unmodified Claude Code. You sign in with
`claude auth login`.

Unclear: whether the Agent SDK may run on a Claude plan sign-in in another
product. Anthropic's page asks developers who use the Agent SDK to use API
keys. The author of OpenCode's similar Claude Agent provider has said
Anthropic gave permission for it (October 2026). Otti Connect has no such
permission.

## Codex (OpenAI)

Sources: Codex is open source (Apache-2.0);
[Using your ChatGPT plan in other apps and sites](https://help.openai.com/en/articles/20001542-using-your-chatgpt-plan-in-other-apps-and-sites);
[Integrating Sign in with ChatGPT in your open-source app](https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt).

What they say:

- Sign in with ChatGPT lets participating apps use a person's ChatGPT plan.
  Plan usage is available to open-source projects and personal projects that
  run locally; a paid or remotely hosted app joins a waitlist before offering
  it.

What Otti Connect does: it runs Codex's own `codex app-server`, unmodified,
on your computer, the interface Codex offers for integrations. You sign in
with `codex login`. Otti Connect doesn't offer Sign in with ChatGPT.

Unclear: nothing known about driving your own Codex this way. A product that
offers ChatGPT sign-in itself would use OpenAI's programme.

## Antigravity (Google)

Sources:
[Google Antigravity Additional Terms of Service](https://antigravity.google/terms), section 6;
[Antigravity FAQ](https://antigravity.google/docs/faq);
[Other editors (ACP)](https://antigravity.google/docs/ide/extensions/acp);
replies on Google's developer forum
([13 November](https://discuss.ai.google.dev/t/an-acp-service-compliance-question/200200),
[23 November](https://discuss.ai.google.dev/t/clarifying-headless-agy-cli-usage-with-gemini-subs-not-api/203835),
[25 November](https://discuss.ai.google.dev/t/please-let-us-use-our-antigravity-subscriptions-in-other-harnesses/200453));
posts on X by Patrick C Toulme, whom Google's forum describes as a Google
employee
([1](https://x.com/PatrickToulme/status/2124265732540387418),
[2](https://x.com/PatrickToulme/status/2124681579125702798)).

What they say:

- The terms: "Using third party software, tools, or services to access the
  Service (e.g. using OpenClaw with Antigravity OAuth) is a breach of this
  Agreement", which may lead to suspension.
- The FAQ: "Wrapping `agy` inside third-party coding agents or applications
  … is not supported under consumer plans." For a third-party coding agent,
  Google recommends a Gemini Enterprise or Google AI Studio API key.
- Google documents `agy acp` for editors that speak the Agent Client
  Protocol: Zed, JetBrains IDEs, Android Studio and Xcode.
- On X: "You will NOT be banned ever for using Antigravity in T3Code", and
  "For now, please only use through Antigravity which T3Code correctly uses".
  T3 Code runs the unmodified Antigravity program over the Agent Client
  Protocol, with the person's own sign-in.
- The forum, 23 November: "Delegating tasks to agy -p or agy acp from another
  AI coding agent or external harness (such as having Claude or Codex invoke
  agy as a worker) is not supported under consumer plans"; for that, Google
  points to a Gemini API key or Gemini Enterprise.
- People report Antigravity being disabled on their accounts after using
  tools that reuse Antigravity's sign-in outside its own program (OpenClaw,
  OpenCode plugins).

What Otti Connect does: like T3 Code, it runs the unmodified `agy acp` with
your own sign-in (`agy acp --login`), and each turn is a message from your
chat.

Where it differs from T3 Code:

- The chat's files are never on your computer: Otti Connect turns off
  Antigravity's own file and terminal tools with a hook, and gives it the
  chat's tools instead, as an MCP server. Hooks and MCP servers are
  Antigravity's own settings; the program isn't changed.
- In Octomerge, another agent can start a sub-agent on an Antigravity model,
  and a chat can take a turn that nobody typed (a sub-agent finishing, an
  automation).

Guidance: on a personal Google sign-in, use Antigravity in chats you drive
yourself, and don't have other agents hand it tasks; Google points to an API
key or Gemini Enterprise for that. Google's statements don't all agree and
may change: check the sources above.

## Open questions

- **Your own API key instead of a plan.** Anthropic (for the Agent SDK) and
  Google (for other coding agents) point to API keys. Otti Connect removes
  API-key variables today, so every agent runs on your sign-in; whether to
  let you choose your own key instead is open.
