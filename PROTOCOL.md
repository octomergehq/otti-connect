# The Octomerge connector protocol, version 1

How Octomerge drives one turn of a coding agent through a connector: a
program that runs where the person's agent is installed and signed in, such
as Otti Connect (`otti-connect`). The connector speaks this protocol with
Octomerge (the client) and the agent's own protocol with the agent. Nothing
the agent speaks reaches the client, and the client's tools reach the agent
only as calls the client answers. Any program that speaks this protocol can
be a connector.

The types are in [`src/protocol.ts`](src/protocol.ts), a file without imports.

## Transport

- One connector process serves one turn (Otti Connect: `otti-connect turn`).
- The client writes to the connector's standard input and reads its standard
  output: UTF-8 JSON, one object per line, each line at most 32 MiB. The
  connector writes nothing else to its standard output; its log goes to
  standard error.
- The streams are ordered and reliable. The client delivers each of its lines
  once; a client that reads the output again (after a reconnect, or as
  another process) can tell where it was by the events' `seq`, which counts
  from 1.
- The client starts the process itself (where Octomerge's own worker program
  runs), or a connector that connected to Octomerge through the
  [agent host API](#the-agent-host-api) starts it and carries the same
  streams over HTTPS.

## A turn

1. The client writes `start`. The connector answers `hello`, then works.
2. The connector writes the agent's progress: `session`, `text`, `thinking`,
   `tool_started`, `tool_completed`, `usage`.
3. When the agent calls one of the client's tools, the connector writes
   `tool_call` and the agent waits for the `tool_result` with the same `id`.
4. While the turn goes on, the client may write `message`: the connector
   reports `received` and the agent takes it at its next opportunity.
5. The turn ends with `turn_end`, or with `error` if it cannot go on. The
   client then closes the connector's input, and the connector exits once the
   agent has exited.

Closing the input earlier ends the turn early: the connector answers the
tool calls that still wait with an error, stops the agent and exits. So does
SIGTERM.

### Client to connector

```jsonc
{"type": "start", "protocol": 1,
 "turn": {"id": "cli-3f2a…", "messageId": "8c1e…"},
 "agent": {"kind": "claude-code", "model": "sonnet", "effort": "low"},
 "workspace": {"folder": "4b1d9e…"},
 "session": "c0ffee…",
 "instructions": "You work as the agent of a conversation in Octomerge…",
 "tools": [{"name": "shell", "description": "…", "inputSchema": {"type": "object"}}],
 "message": {"text": "Run the tests", "images": [{"data": "iVBOR…", "mediaType": "image/png"}]}}
{"type": "tool_result", "id": "call-1", "content": [{"type": "text", "text": "ok"}], "isError": false}
{"type": "message", "id": "5d0a…", "text": "Also check the linter", "images": []}
```

- `turn.id` is the same each time the client starts the same turn again;
  `turn.messageId` identifies its first message.
- `agent.kind` is `claude-code`, `codex` or `antigravity`. `model` and `effort`
  are the CLI's own names.
- `workspace.folder` names the agent's working folder, the same for every
  turn of a conversation. The files the agent works on are never on this
  machine: its own file and shell tools are off, and it does that work with
  the client's tools. It runs in an empty folder of its own, which `folder`
  names (Otti Connect: `$TMPDIR/otti-connect/<folder>`).
- `session` continues the agent's session of an earlier turn, as that turn's
  `session` event named it. Without it, the agent starts a new session.
- `instructions` are appended to the agent's own system prompt. The connector
  adds how the client's tools are named for its agent.
- `tools` lists the client's tools in order of importance: an agent that can
  take only part of them takes them from the start.
- `images` are base64: image/png, image/jpeg, image/gif or image/webp. An agent
  that cannot take images gets a note in the text instead.

### Connector to client

Every event has `seq`.

| Event | Meaning |
| --- | --- |
| `hello` `{protocol, connector: {name, version, contentDigest?}, agent: {kind, label}}` | First: the protocol version the connector speaks, the connector and the agent. `contentDigest` identifies the release the connector was built from; a development build has none. |
| `session` `{id, resumed}` | The agent's session, to continue in a later turn. `resumed`: the start's session was continued. |
| `text` `{text, block?}` | Answer text. A new `block` (a message or item of the agent's) starts a new paragraph. |
| `thinking` `{text}` | The agent's reasoning, as far as it shows it. |
| `tool_started` `{id, name, input}` | One of the agent's own tools started. |
| `tool_completed` `{id, name, input, output: {text, isError?, exitCode?, details?}}` | It returned. One without a `tool_started` started and returned at once. |
| `tool_call` `{id, callId?, name, input}` | The agent calls the client's tool `name` and waits for `tool_result` `id`. `callId` is the agent's own identity of the call when it has one that is unique beyond the turn. |
| `usage` `{inputTokens, outputTokens, cacheReadTokens?, cacheWriteTokens?}` | The tokens of the agent's latest model request. |
| `waiting` `{tasks: [{id, description}]}` | The agent answered, but background work it started keeps the turn open. |
| `working` | It works again after `waiting`. |
| `received` `{id}` | The connector took in the client's `message` `id`. |
| `turn_end` `{stopReason, error?, text?}` | The round ended with nothing left to answer. `text` is the final answer when no `text` events carried it. |
| `error` `{code, message}` | The turn cannot go on. `message` is written for the person. |

`error` codes: `protocol_unsupported`, `agent_unsupported`, `bad_message`,
`cli_missing`, `not_signed_in`, `agent_failed`.

## Rules

- **Calls.** Tool calls may overlap, and their results may come in any order.
  Each `tool_result` answers the `tool_call` with its `id`, once.
- **Messages and rounds.** A message the connector takes in before a
  `turn_end` is part of that round: the agent does not end the round while one
  it received is unanswered. A message it takes in after a `turn_end` starts
  another round of the same turn, which ends with another `turn_end`. So a
  client that wrote a message ends the turn only at a `turn_end` after that
  message's `received`.
- **Own tools.** The client shows the agent's own calls; it never runs them.
  The connector bounds their reported input to 6,000 and output to 12,000
  characters.
- **Waiting.** After `waiting` the agent is idle until its background work
  ends or a message comes. The client decides how long a turn may wait, and
  ends it by closing the input or stopping the process.
- **Sign-in.** Each CLI uses the person's own sign-in on this machine. The
  connector removes the variables that would replace it (API keys and other
  endpoints) from the CLI's environment.
- **Versions.** `start.protocol` is the version the client speaks. A
  connector that doesn't speak it answers `hello` with its own version and
  `error` `protocol_unsupported`. Additions that a reader may ignore (new
  optional fields, new events) keep the version: both sides ignore what they
  don't know.

## Example

```text
→ {"type":"start","protocol":1,"turn":{"id":"cli-7d…","messageId":"0b…"},"agent":{"kind":"codex","effort":"low"},"workspace":{"folder":"4b1d…"},"instructions":"…","tools":[…],"message":{"text":"What is in README.md?"}}
← {"type":"hello","protocol":1,"connector":{"name":"otti-connect","version":"1.0.0","contentDigest":"…"},"agent":{"kind":"codex","label":"Codex"},"seq":1}
← {"type":"session","id":"019a…","resumed":false,"seq":2}
← {"type":"tool_call","id":"call-0","callId":"call_Hx…","name":"read","input":{"path":"README.md"},"seq":3}
→ {"type":"tool_result","id":"call-0","content":[{"type":"text","text":"# Project…"}]}
← {"type":"text","text":"README.md describes…","block":"msg_1","seq":4}
← {"type":"usage","inputTokens":5120,"outputTokens":180,"seq":5}
← {"type":"turn_end","stopReason":"end_turn","seq":6}
→ (end of input)
```

## The agent host API

How a connector connects a computer to Octomerge itself, with no other
Octomerge program on it, and runs turns there: the computer becomes one of the
person's **agent hosts**. Version 1; the types are in
[`src/host-api.ts`](src/host-api.ts), whose only import is `src/protocol.ts`'s
agent kinds. Otti Connect implements it in `src/host.ts`.

It is HTTPS with JSON bodies. Every request after the sign-in carries
`Authorization: Bearer <token>`, and the token goes to the Octomerge that
issued it and nowhere else. Each turn is the connector protocol above,
carried by the API: the server's lines arrive as `input` commands, and the
turn's standard output goes back as `output` chunks.

### Sign-in

The connector signs in once with Octomerge's device sign-in, as the client
`otti-connect`:

1. `POST /api/auth/device/start` `{deviceName, client: "otti-connect"}`, with
   no `scopes`: Octomerge decides what an agent host's sign-in allows. The
   answer (201) has `requestId`, `deviceCode`, `userCode`, `verificationUri`,
   `verificationUriComplete`, `expiresAt` and `intervalMs`.
2. The connector shows the person the code and the address; the person
   approves the code in the browser, signed in to Octomerge.
3. It polls `POST /api/auth/device/poll/<requestId>` `{deviceCode}` every
   `intervalMs` until `expiresAt`: `{status: "pending", intervalMs}` waits
   on, `{status: "approved", token}` is the sign-in, and `denied`, `expired` or
   `consumed` end it. A 429 says to slow down to its `intervalMs`.

The connector keeps the token to itself (Otti Connect: in
`~/.otti-connect/connect.json`, readable by its owner only) and never prints
it. `POST /api/r5dctl/auth/logout` with the token revokes it; Octomerge's
Settings → Your agents revokes it too when the person forgets the computer.

### Register

`POST /api/agent-hosts/connector/register` with the computer and its agents
(`RegisterRequest`) answers `{hostId, label, hostApi}`. One sign-in is one
agent host: registering again, as a connector does each time it starts,
answers the same `hostId`, updates what it reported and keeps the host's
label, which the person may have changed in Octomerge (Settings → Your
agents).

- `label` names the computer, as Octomerge's worker labels do: 1 to 63
  letters, digits, dots, hyphens and underscores, starting with a letter or
  digit. The answer's `label` is the one to use from then on.
- `platform` (`darwin arm64`, `linux x64`, …), `connector` (`{name, version,
  protocol, contentDigest?}`, the digest of the release it was built from,
  as in `hello`), and `hostApi`, the version the connector speaks.
- `agents`: an `AgentReport` for each agent the connector drives: `kind`,
  `installed`, `version` (as the agent's own program says it), `signedIn` (as
  the agent's own status command says it: `true`, `false`, or `null` when it
  has none to ask), `models` (the agent's own names for the models offered
  for it, such as Claude Code's aliases), and `detail`, a short note for the
  person (why it can't run, what to run). A report never holds a credential
  or an account's identity, and comes from the agents' own commands, never
  from their files.

### Poll

`POST /api/agent-hosts/connector/poll` `{hostId, agents?, turns}` is a long
poll: the server answers within `POLL_WAIT_MS` (25 s), and at once when it
has commands. A connector keeps one poll at a time, and builds each after it
handled the previous answer's commands. It sends `agents` when they changed
since the server last took them.

`turns` has a `TurnProgress` for each turn from the moment the connector
accepts its `start` until the server acknowledged its exit: `runId`,
`outputBytes` (the bytes of standard output the turn wrote so far),
`appliedInputSeq` (the last input handed to its standard input) and `state`:
`running`, `stopping` once the connector has its `cancel`, `exited` once its
process exited. A running turn a poll leaves out, the server takes for lost.

The answer is `{commands, outputBytes}`. The commands come in order (a turn's
`start` before its inputs):

- `start {runId}`: start a turn process (`otti-connect turn`) with piped
  standard streams. A connector starts each run once: a `start` for a run it
  has or had is ignored.
- `input {runId, seq, data, eof}`: write `data` to the turn's standard input,
  each `seq` once, in order (`seq` counts from 1 in each turn); `eof` closes
  the input after it. The server sends inputs after `appliedInputSeq` again
  while the turn is reported `running`, so one whose poll answer was lost
  comes again.
- `cancel {runId}`: close the turn's input, then end its process (its process
  group) with SIGTERM 10 s later and SIGKILL 20 s later if it hasn't exited.
  The server sends it again until the turn is reported `stopping`.

`outputBytes` has, for each turn the poll named that the server still has,
the bytes of its output the server holds: the connector sends what follows
them. A turn missing there is unknown to the server, or it gave the turn up:
the connector stops its process and forgets it.

A host the server hasn't heard from for `HOST_OFFLINE_AFTER_MS` (a minute) is
offline: no new turn goes to it, and its running turns are given up after a
while. A turn still waiting to start on a host that hasn't polled for half a
minute moves to the next host that has the agent.

A connector that stops sends one last poll with `closing: true` once its
turns ended (Otti Connect does, within a few seconds of Ctrl+C or SIGTERM):
the server answers at once, sends no new turn to the host until it polls
again, and moves the turns waiting to start there to another host.

### Output

`POST /api/agent-hosts/connector/output` `{hostId, runId, offset, data,
exit?}` answers `{outputBytes}`, the bytes of that turn's output the server
holds.

- `data` is base64 of at most `MAX_OUTPUT_CHUNK_BYTES` (256 KiB) of the turn's
  standard output, starting at byte `offset`. A connector uploads the output
  as it comes, one request at a time per turn, gathering small writes (Otti
  Connect waits 100 ms), and keeps every byte until the server confirmed it
  holds it, in a poll's `outputBytes` or an `output`'s answer.
- `exit` `{code, signal, stderrTail}` goes with the last chunk, once the
  process exited and its output ended: an empty `data` when nothing is left.
  `stderrTail` is the end of its standard error (Otti Connect sends 4,000
  characters). Every `start` a connector accepts ends with an exit: a process
  that couldn't start has `code: null` and the reason in `stderrTail`.
- Uploads are idempotent. A chunk that starts below the bytes the server
  holds adds only the rest, and an exit sent again is answered like the
  first. So after a request without an answer, or a reconnect, the connector
  sends again from the last offset the server confirmed.
- The connector forgets a turn once an `output` with its exit is answered
  with all of its bytes.

### Errors

Errors are JSON `{error, code}`, and `error` is written for the person.

| Answer | Meaning | The connector |
| --- | --- | --- |
| 401 | The sign-in no longer works (revoked, or the computer was forgotten) | Says so, stops its turns, signs in again |
| 403 | The sign-in doesn't allow an agent host | Signs in again; a new sign-in that gets it too is an error |
| 404 `agent_host_not_found` | The server doesn't have this agent host | Registers again |
| 404 `turn_not_found`, `turn_lost` | The server doesn't have the turn, or gave it up | Stops the turn and forgets it |
| 409 `label_taken` | Another connected computer of the account has the label (one that has been away, or whose sign-in was revoked, hands it over) | Asks the person for another label |
| 409 `output_gap` | The chunk starts after the bytes the server holds (`outputBytes`) | Sends from there |
| 409 `host_api_unsupported` | The server speaks another version (`hostApi`) | Says to update the connector |
| 408, 429, 5xx, no answer | The server is busy or out of reach | Tries again after 1 s, doubling up to 30 s, while its turns go on |

### Example

```text
→ POST /api/auth/device/start {"deviceName":"mac-mini","client":"otti-connect"}
← 201 {"requestId":"5b1e…","deviceCode":"…","userCode":"K7QD-4XNM","verificationUri":"https://octomerge.dev/auth","verificationUriComplete":"https://octomerge.dev/auth?code=K7QD-4XNM","expiresAt":"…","intervalMs":5000}
→ POST /api/auth/device/poll/5b1e… {"deviceCode":"…"}
← 200 {"status":"approved","credentialId":"…","scopes":["agents"],"token":"…"}
→ POST /api/agent-hosts/connector/register {"hostApi":1,"label":"mac-mini","platform":"darwin arm64","connector":{"name":"otti-connect","version":"1.0.0","contentDigest":"…","protocol":1},"agents":[{"kind":"claude-code","installed":true,"version":"2.1.331","signedIn":true,"models":["sonnet","opus","haiku"]},{"kind":"codex","installed":true,"version":"0.172.0","signedIn":false,"detail":"…"},{"kind":"antigravity","installed":false,"detail":"…"}]}
← 200 {"hostId":"7f3c…","label":"mac-mini","hostApi":1}
→ POST /api/agent-hosts/connector/poll {"hostId":"7f3c…","turns":[]}
← 200 {"commands":[{"type":"start","runId":"cli-3f2a…"},{"type":"input","runId":"cli-3f2a…","seq":1,"data":"{\"type\":\"start\",…}\n","eof":false}],"outputBytes":{}}
   (the connector starts `otti-connect turn` and writes input 1 to it)
→ POST /api/agent-hosts/connector/poll {"hostId":"7f3c…","turns":[{"runId":"cli-3f2a…","outputBytes":0,"appliedInputSeq":1,"state":"running"}]}
   (while that poll waits, the turn writes its first events)
→ POST /api/agent-hosts/connector/output {"hostId":"7f3c…","runId":"cli-3f2a…","offset":0,"data":"eyJ0eXBlIjoiaGVsbG8iLC…"}
← 200 {"outputBytes":412}
   (the poll's answer: the tool result the turn waits for)
← 200 {"commands":[{"type":"input","runId":"cli-3f2a…","seq":2,"data":"{\"type\":\"tool_result\",…}\n","eof":false}],"outputBytes":{"cli-3f2a…":412}}
   … (the turn ends with turn_end, an input with eof closes its input, its process exits)
→ POST /api/agent-hosts/connector/output {"hostId":"7f3c…","runId":"cli-3f2a…","offset":5120,"data":"","exit":{"code":0,"signal":null,"stderrTail":""}}
← 200 {"outputBytes":5120}
```
