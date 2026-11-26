import { type ChildProcess, spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { describeAgents, detectAgents, type ReportContext } from "./agents/report";
import { configPath, writeConnectConfig } from "./config";
import { type AgentReport, HOST_API_PATHS, HOST_API_VERSION, MAX_OUTPUT_CHUNK_BYTES, POLL_WAIT_MS, type TurnProgress } from "./host-api";
import { answerCode, answerError, type JsonAnswer, requestJson, sleep } from "./http";
import { type AgentKind, PROTOCOL_VERSION } from "./protocol";
import { deviceSignIn, revokeSignIn, SignInError } from "./signin";
import { CONNECTOR } from "./util";

/**
 * The agent host (PROTOCOL.md, "The agent host API"): Otti Connect connected
 * to Octomerge itself. It signs in once with Octomerge's device sign-in,
 * registers this computer with its agents, and long-polls for commands. Each
 * turn is a process of its own, `otti-connect turn`, exactly as a worker would
 * run it: the server's `input`s go to its standard input in order, and its
 * standard output goes back as `output` chunks at byte offsets, with its exit
 * after the last one. Each turn's output stays in memory until the server
 * confirms it holds it, so a dropped connection, or a server that restarted,
 * loses nothing: the next upload starts where the server says it stands.
 */

const REQUEST_TIMEOUT_MS = 30_000;
/** The server answers a poll within POLL_WAIT_MS; one that takes much longer went missing. */
const POLL_TIMEOUT_MS = POLL_WAIT_MS + 15_000;
/** Small writes of a turn gather this long before they go out. */
const BATCH_MS = 100;
/** How much of a turn's standard error goes with its exit. */
const STDERR_TAIL_CHARS = 4_000;
/** A cancelled turn gets SIGTERM this long after its input closed, and SIGKILL after CANCEL_KILL_MS. */
const CANCEL_TERM_MS = 10_000;
const CANCEL_KILL_MS = 20_000;
/** After a turn's process exited: SIGKILL for whatever it left running, and how long its output may take to end. */
const LEFTOVER_KILL_MS = 5_000;
const OUTPUT_END_MS = 2_000;
/** How long a stop waits for the turns' exits to reach Octomerge. */
const SHUTDOWN_MS = 5_000;
/** How long the last poll, which says the computer is stopping, may take. */
const CLOSE_TIMEOUT_MS = 3_000;
const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 30_000;
/** How often the agents are checked again. */
const AGENT_CHECK_MS = 3 * 60_000;
/** Turns run in process groups of their own, so a stop reaches what they started and Ctrl+C in the terminal reaches only Otti Connect. */
const GROUPS = process.platform !== "win32";

/** The sign-in no longer works (401). */
class SignedOut extends Error {}
/** The sign-in doesn't allow an agent host (403). */
class Forbidden extends Error {}
/** The server no longer has this agent host (404 `agent_host_not_found`). */
class HostGone extends Error {}
/** No answer, or the server failed: try again after a while. */
class Retry extends Error {}
/** Otti Connect can't go on: it says why and exits. */
export class HostStop extends Error {}

/** A turn's standard output from the first byte the server hasn't confirmed on: what may still have to be sent again. */
class ByteLog {
  private chunks: Buffer[] = [];
  /** The offset of the first byte kept. */
  base = 0;
  /** Bytes the turn wrote so far. */
  end = 0;

  append(chunk: Buffer): void {
    if (!chunk.length) return;
    this.chunks.push(chunk);
    this.end += chunk.length;
  }

  /** The bytes from `from` (not below `base`) to `to`. */
  read(from: number, to: number): Buffer {
    const parts: Buffer[] = [];
    let at = this.base;
    for (const chunk of this.chunks) {
      const start = at;
      at += chunk.length;
      if (at <= from) continue;
      if (start >= to) break;
      parts.push(chunk.subarray(Math.max(0, from - start), Math.min(chunk.length, to - start)));
    }
    return parts.length === 1 ? parts[0]! : Buffer.concat(parts);
  }

  /** Forgets the bytes before `offset`: the server holds them. */
  drop(offset: number): void {
    while (this.chunks.length && this.base + this.chunks[0]!.length <= offset) {
      this.base += this.chunks[0]!.length;
      this.chunks.shift();
    }
    if (this.chunks.length && offset > this.base) {
      this.chunks[0] = this.chunks[0]!.subarray(offset - this.base);
      this.base = offset;
    }
  }
}

type Exit = { code: number | null; signal: string | null; stderrTail: string };

class Turn {
  readonly acceptedAt = Date.now();
  child?: ChildProcess;
  /** The process's own exit, before its output ended. */
  status?: { code: number | null; signal: string | null };
  readonly log = new ByteLog();
  /** The server holds the output up to here. */
  confirmed = 0;
  appliedInputSeq = 0;
  /** Inputs that came before an earlier one. */
  readonly inputs = new Map<number, { data: string; eof: boolean }>();
  stdinClosed = false;
  state: "running" | "stopping" | "exited" = "running";
  cancelled = false;
  exit?: Exit;
  stderr = "";
  readonly decoder = new StringDecoder("utf8");
  /** The agent, as the turn's `hello` names it. */
  agent?: string;
  firstLine = "";
  announced = false;
  readonly timers: NodeJS.Timeout[] = [];
  outputEnd?: NodeJS.Timeout;
  flushTimer?: NodeJS.Timeout;
  uploading = false;
  /** Ends an upload's wait before it tries again. */
  wake?: () => void;
  forgotten = false;

  constructor(readonly runId: string) {}

  get name(): string {
    return this.agent ? `${this.agent} turn` : "Turn";
  }

  get short(): string {
    return this.runId.length > 16 ? `${this.runId.slice(0, 16)}…` : this.runId;
  }
}

const clock = () => new Date().toTimeString().slice(0, 8);
/** A terminal's colours and cursor moves, which an agent's log may hold: not for a chat. */
const plain = (text: string) => text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
function duration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

export type HostOptions = {
  baseUrl: string;
  label: string;
  configDir: string;
  /** Open the approval page in the browser when a sign-in starts. */
  open: boolean;
  /** The saved sign-in for `baseUrl`, if there is one. */
  token?: string;
  hostId?: string;
  /** The agents the installer couldn't install at this start, with why: they are reported so until the next start. */
  failures?: ReadonlyMap<AgentKind, string>;
};

export class AgentHost {
  private readonly baseUrl: string;
  private readonly configDir: string;
  private label: string;
  private token?: string;
  private hostId?: string;
  private registered = false;
  private connectedOnce = false;
  private readonly turns = new Map<string, Turn>();
  /** Every run this process accepted: a `start` that comes again is never a second process. */
  private readonly accepted = new Set<string>();
  private agents: AgentReport[] = [];
  /** The agents as the server last took them. */
  private agentsSent = "";
  private checking = false;
  private agentTimer?: NodeJS.Timeout;
  private stopping = false;
  /** Stopped by SIGINT or SIGTERM, not by trouble. */
  private signalled = false;
  /** Stops the poll, a sign-in and the waits between tries. */
  private readonly stop = new AbortController();
  private pollAbort?: AbortController;
  /** Trouble an upload ran into, for the main loop: a sign-in that stopped working, a host that is gone. */
  private flagged: Error | null = null;
  private waiters: Array<() => void> = [];
  private reachable = true;
  private finished = false;
  private readonly report: ReportContext;

  constructor(private readonly options: HostOptions) {
    this.baseUrl = options.baseUrl;
    this.configDir = options.configDir;
    this.label = options.label;
    this.token = options.token;
    this.hostId = options.hostId;
    this.report = { ...(options.failures ? { failures: options.failures } : {}) };
  }

  private say(text: string): void {
    process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
  }

  private log(text: string): void {
    this.say(`${clock()} ${text}`);
  }

  /** Runs until a stop (SIGINT, SIGTERM) or trouble it can't get past; resolves with the exit status. */
  async run(): Promise<number> {
    const onSignal = (signal: NodeJS.Signals) => this.shutdown(signal);
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    try {
      this.agents = await detectAgents(this.report);
      this.say(["Agents on this computer:", ...describeAgents(this.agents).map((line) => `  ${line}`)].join("\n"));
      this.agentTimer = setInterval(() => void this.checkAgents(), AGENT_CHECK_MS);
      this.agentTimer.unref();
      await this.loop();
      await this.drain();
      return 0;
    } catch (error) {
      if (!(error instanceof HostStop) && !(error instanceof SignInError)) throw error;
      process.stderr.write(`${CONNECTOR.name}: ${error.message}\n`);
      this.stopping = true;
      this.stop.abort();
      for (const turn of this.turns.values()) this.end(turn);
      await this.drain();
      return 1;
    } finally {
      clearInterval(this.agentTimer);
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    }
  }

  private async loop(): Promise<void> {
    let retryMs = RETRY_MIN_MS;
    // The sign-in was approved just now: a refusal of it is not one to sign in again for.
    let fresh = false;
    while (!this.stopping) {
      try {
        this.raiseFlagged();
        if (!this.token) {
          await this.signIn();
          fresh = true;
        }
        if (!this.registered) await this.register();
        await this.poll();
        fresh = false;
        retryMs = RETRY_MIN_MS;
      } catch (error) {
        if (this.stopping) return;
        if (error instanceof Retry) {
          await sleep(retryMs, this.stop.signal);
          retryMs = Math.min(RETRY_MAX_MS, retryMs * 2);
        } else if (error instanceof SignedOut) {
          this.signedOut(`${this.baseUrl} no longer accepts this computer's sign-in: signing in again.`);
          fresh = false;
        } else if (error instanceof Forbidden) {
          if (fresh) throw new HostStop(`${this.baseUrl} doesn't let this sign-in connect an agent host: ${error.message}`);
          this.signedOut(`${this.baseUrl} doesn't let this computer's sign-in connect an agent host (${error.message}): signing in again.`);
        } else if (error instanceof HostGone) {
          this.registered = false;
          this.log(`${this.baseUrl} no longer has this computer as an agent host: registering it again.`);
        } else if (error instanceof SignInError && error.reason === "stopped") {
          return;
        } else throw error;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Sign-in and registration
  // -------------------------------------------------------------------------

  private async signIn(): Promise<void> {
    if (!this.connectedOnce) this.say(`\nThis computer isn't signed in to ${this.baseUrl} yet.`);
    const token = await deviceSignIn({ baseUrl: this.baseUrl, deviceName: this.label, open: this.options.open, signal: this.stop.signal, say: (text) => this.say(text) });
    this.token = token;
    this.hostId = undefined;
    this.registered = false;
    try {
      writeConnectConfig(this.configDir, { baseUrl: this.baseUrl, token, label: this.label });
    } catch (error) {
      // Nothing holds the new sign-in once this process ends: it is revoked again rather than left behind.
      const revoked = await revokeSignIn(this.baseUrl, token);
      throw new HostStop(`${(error as Error).message}. ${revoked.outcome === "revoked" ? "The new sign-in was revoked again." : `Revoke the new sign-in of ${this.label} under Settings → CLI & API → Authorized devices.`}`);
    }
    this.say(`Approved. The sign-in is saved in ${configPath(this.configDir)}.`);
  }

  /** The sign-in stopped working: its turns ran for an agent host that is gone, so they stop, and the next pass signs in again. */
  private signedOut(message: string): void {
    this.log(message);
    for (const turn of [...this.turns.values()]) this.drop(turn, "the sign-in it ran under stopped working");
    this.token = undefined;
    this.registered = false;
    this.hostId = undefined;
    try {
      writeConnectConfig(this.configDir, { baseUrl: this.baseUrl, label: this.label });
    } catch (error) {
      this.log(`Couldn't forget the old sign-in: ${(error as Error).message}`);
    }
  }

  private async register(): Promise<void> {
    const answer = await this.call(HOST_API_PATHS.register, {
      hostApi: HOST_API_VERSION,
      label: this.label,
      platform: `${process.platform} ${process.arch}`,
      connector: { name: CONNECTOR.name, version: CONNECTOR.version, contentDigest: CONNECTOR.contentDigest, protocol: PROTOCOL_VERSION },
      agents: this.agents,
    });
    const code = answerCode(answer);
    if (answer.status === 409 && code === "label_taken")
      throw new HostStop(
        `Another computer of yours is connected to ${this.baseUrl} as ${this.label}. Give this one a label of its own: start Otti Connect with --label <name>, or set OTTI_CONNECT_LABEL.`,
      );
    if (answer.status === 400 && code === "invalid_label") throw new HostStop(`${this.baseUrl} doesn't take the label ${this.label}: ${answerError(answer)}`);
    this.check(answer, "the registration");
    const hostId = typeof answer.body?.hostId === "string" ? answer.body.hostId : "";
    if (!hostId) throw new HostStop(`${this.baseUrl} answered the registration without an agent host.`);
    if (typeof answer.body?.hostApi === "number" && answer.body.hostApi !== HOST_API_VERSION)
      this.log(`${this.baseUrl} speaks version ${answer.body.hostApi} of the agent host API; this Otti Connect speaks ${HOST_API_VERSION}.`);
    this.hostId = hostId;
    if (typeof answer.body?.label === "string" && answer.body.label) this.label = answer.body.label;
    this.agentsSent = JSON.stringify(this.agents);
    this.registered = true;
    try {
      writeConnectConfig(this.configDir, { baseUrl: this.baseUrl, token: this.token, hostId, label: this.label });
    } catch (error) {
      this.log(`Couldn't save the agent host in ${configPath(this.configDir)}: ${(error as Error).message}`);
    }
    if (this.connectedOnce) this.log(`Registered again with ${this.baseUrl} as ${this.label}.`);
    else this.say(`\nConnected to ${this.baseUrl} as ${this.label}. Waiting for turns; stop with Ctrl+C.`);
    this.connectedOnce = true;
    this.reachable = true;
    this.wakeWaiters();
  }

  /** One request of the agent host API with the current sign-in. No answer is a Retry. */
  private async call(path: string, body: unknown, signal?: AbortSignal, timeoutMs = REQUEST_TIMEOUT_MS): Promise<JsonAnswer> {
    try {
      return await requestJson(this.baseUrl, path, { method: "POST", body, token: this.token, timeoutMs, signal });
    } catch (error) {
      if (this.stopping) throw new Retry();
      this.raiseFlagged();
      this.unreachable((error as Error).message);
      throw new Retry();
    }
  }

  /** What an answer other than 200 means for the main loop. */
  private check(answer: JsonAnswer, what: string): void {
    if (answer.status === 200 || answer.status === 201) {
      this.reached();
      return;
    }
    const code = answerCode(answer);
    if (answer.status === 401) throw new SignedOut(answerError(answer));
    if (answer.status === 403) throw new Forbidden(answerError(answer));
    if (answer.status === 404 && code === "agent_host_not_found") throw new HostGone(answerError(answer));
    if (answer.status === 408 || answer.status === 429 || answer.status >= 500) {
      this.unreachable(answerError(answer));
      throw new Retry();
    }
    if (answer.status === 404) throw new HostStop(`${this.baseUrl} doesn't offer the agent host API (${answerError(answer)}): it may be an Octomerge that predates Otti Connect.`);
    throw new HostStop(`${this.baseUrl} refused ${what}: ${answerError(answer)}`);
  }

  private unreachable(reason: string): void {
    if (!this.reachable) return;
    this.reachable = false;
    this.log(`Can't reach ${this.baseUrl} (${reason}). Trying again; running turns go on.`);
  }

  private reached(): void {
    if (this.reachable) return;
    this.reachable = true;
    this.log(`Reached ${this.baseUrl} again.`);
    // Uploads waiting to try again go now.
    for (const turn of this.turns.values()) turn.wake?.();
  }

  /** Trouble an upload met: the main loop deals with it, and uploads wait meanwhile. */
  private flag(error: Error): void {
    this.flagged ??= error;
    this.registered = false;
    this.pollAbort?.abort();
  }

  private raiseFlagged(): void {
    const error = this.flagged;
    if (!error) return;
    this.flagged = null;
    throw error;
  }

  /** Waits until uploads may go: signed in and registered. False once Otti Connect is done. */
  private async ready(): Promise<boolean> {
    while (!this.finished && (!this.registered || !this.token || this.flagged)) await new Promise<void>((resolve) => this.waiters.push(resolve));
    return !this.finished;
  }

  private wakeWaiters(): void {
    for (const wake of this.waiters.splice(0)) wake();
  }

  // -------------------------------------------------------------------------
  // The poll and its commands
  // -------------------------------------------------------------------------

  private progress(): TurnProgress[] {
    return [...this.turns.values()].map((turn) => ({ runId: turn.runId, outputBytes: turn.log.end, appliedInputSeq: turn.appliedInputSeq, state: turn.state }));
  }

  /** One poll: what this host's turns did since, the agents when they changed; then the commands, in order. */
  private async poll(): Promise<void> {
    const turns = this.progress();
    const agents = JSON.stringify(this.agents);
    const sendAgents = agents !== this.agentsSent;
    const controller = new AbortController();
    const stop = () => controller.abort();
    this.stop.signal.addEventListener("abort", stop, { once: true });
    this.pollAbort = controller;
    const started = Date.now();
    let answer: JsonAnswer;
    try {
      answer = await this.call(HOST_API_PATHS.poll, { hostId: this.hostId, ...(sendAgents ? { agents: this.agents } : {}), turns }, controller.signal, POLL_TIMEOUT_MS);
    } finally {
      this.pollAbort = undefined;
      this.stop.signal.removeEventListener("abort", stop);
    }
    this.check(answer, "the poll");
    if (sendAgents) this.agentsSent = agents;
    const body = answer.body ?? {};
    const held = isRecord(body.outputBytes) ? body.outputBytes : {};
    for (const reported of turns) {
      const turn = this.turns.get(reported.runId);
      if (!turn) continue;
      const bytes = held[reported.runId];
      if (typeof bytes === "number") this.confirm(turn, bytes);
      // The server doesn't have it (any more): it is unknown, or it gave it up. One that exited has nothing left to stop.
      else if (turn.exit) this.forget(turn);
      else this.drop(turn, `${this.baseUrl} no longer has it`);
    }
    const commands = Array.isArray(body.commands) ? body.commands : [];
    for (const command of commands) this.command(command);
    // An answer that came back at once and changed nothing (a server that doesn't wait): don't ask again at once.
    const elapsed = Date.now() - started;
    if (elapsed < 1_000 && JSON.stringify(this.progress()) === JSON.stringify(turns)) await sleep(1_000 - elapsed, this.stop.signal);
  }

  private command(command: unknown): void {
    if (!isRecord(command) || typeof command.runId !== "string" || !command.runId) return;
    const turn = this.turns.get(command.runId);
    switch (command.type) {
      case "start":
        if (!turn && !this.accepted.has(command.runId)) this.startTurn(command.runId);
        return;
      case "input": {
        const seq = command.seq;
        if (!turn || typeof seq !== "number" || !Number.isInteger(seq) || seq <= turn.appliedInputSeq) return;
        turn.inputs.set(seq, { data: typeof command.data === "string" ? command.data : "", eof: command.eof === true });
        this.applyInputs(turn);
        return;
      }
      case "cancel":
        if (turn) this.cancel(turn);
        return;
      default:
        // A command a newer server sends that this connector doesn't know.
        return;
    }
  }

  // -------------------------------------------------------------------------
  // Turns
  // -------------------------------------------------------------------------

  /** Starts a turn: `otti-connect turn`, this same program, with piped standard streams. */
  private startTurn(runId: string): void {
    this.accepted.add(runId);
    const turn = new Turn(runId);
    // Reported from now on, so the server doesn't send the start again.
    this.turns.set(runId, turn);
    const failed = (error: Error) => this.exited(turn, { code: null, signal: null, stderrTail: `Otti Connect couldn't start the turn's process: ${error.message}` });
    let child: ChildProcess;
    try {
      child = spawn(process.execPath, [process.argv[1]!, "turn"], { stdio: ["pipe", "pipe", "pipe"], detached: GROUPS, windowsHide: true });
    } catch (error) {
      failed(error as Error);
      return;
    }
    turn.child = child;
    child.stdin!.on("error", () => {
      // It exited before reading everything: its exit says what happened.
    });
    child.stdout!.on("data", (chunk: Buffer) => this.output(turn, chunk));
    child.stderr!.on("data", (chunk: Buffer) => {
      turn.stderr = (turn.stderr + turn.decoder.write(chunk)).slice(-STDERR_TAIL_CHARS);
    });
    child.on("error", (error) => {
      if (!child.pid) failed(error);
    });
    child.on("exit", (code, signal) => {
      turn.status = { code, signal };
      for (const timer of turn.timers.splice(0)) clearTimeout(timer);
      // What the turn started ends with it.
      this.signal(turn, "SIGTERM");
      setTimeout(() => this.signal(turn, "SIGKILL"), LEFTOVER_KILL_MS).unref();
      // Its output ends when the last process holding it does: a leftover doesn't keep the turn open.
      turn.outputEnd = setTimeout(() => {
        child.stdout!.destroy();
        child.stderr!.destroy();
        this.exited(turn, { code, signal, stderrTail: turn.stderr });
      }, OUTPUT_END_MS);
    });
    child.on("close", (code, signal) => this.exited(turn, { code: turn.status?.code ?? code, signal: turn.status?.signal ?? signal, stderrTail: turn.stderr }));
  }

  private output(turn: Turn, chunk: Buffer): void {
    turn.log.append(chunk);
    if (!turn.announced) this.announce(turn, chunk);
    if (turn.log.end - turn.confirmed >= MAX_OUTPUT_CHUNK_BYTES) this.send(turn);
    else this.schedule(turn);
  }

  /** The turn's first line is its `hello`, which names the agent: the turn is announced with it (never with what the turn is asked). */
  private announce(turn: Turn, chunk: Buffer): void {
    const newline = chunk.indexOf(10);
    turn.firstLine += chunk.subarray(0, newline < 0 ? chunk.length : newline).toString("utf8");
    if (newline < 0 && turn.firstLine.length < 65_536) return;
    turn.announced = true;
    try {
      const hello = JSON.parse(turn.firstLine) as { type?: unknown; agent?: { label?: unknown } };
      if (hello.type === "hello" && typeof hello.agent?.label === "string") turn.agent = hello.agent.label.slice(0, 40);
    } catch {
      // Not a hello: the turn is announced without its agent.
    }
    turn.firstLine = "";
    this.log(`${turn.name} started (${turn.short})`);
  }

  private applyInputs(turn: Turn): void {
    for (;;) {
      const seq = turn.appliedInputSeq + 1;
      const input = turn.inputs.get(seq);
      if (!input) return;
      // A turn that stops or exited takes no more input; the server sends none once it knows.
      if (turn.state !== "running" || !turn.child?.stdin) return;
      turn.inputs.delete(seq);
      // Input after the end of input can't be written, and is counted so the server doesn't send it again and again.
      if (input.data && !turn.stdinClosed) turn.child.stdin.write(input.data);
      turn.appliedInputSeq = seq;
      if (input.eof) this.closeInput(turn);
    }
  }

  private closeInput(turn: Turn): void {
    if (turn.stdinClosed) return;
    turn.stdinClosed = true;
    try {
      turn.child?.stdin?.end();
    } catch {
      // Closed already.
    }
  }

  private signal(turn: Turn, signal: NodeJS.Signals): void {
    const pid = turn.child?.pid;
    if (!pid) return;
    try {
      if (GROUPS) process.kill(-pid, signal);
      else turn.child!.kill(signal);
    } catch {
      // Ended already.
    }
  }

  /** `cancel`: the input closes, SIGTERM follows after 10 s and SIGKILL after 20 s. */
  private cancel(turn: Turn): void {
    if (turn.state !== "running") return;
    turn.state = "stopping";
    turn.cancelled = true;
    turn.inputs.clear();
    this.closeInput(turn);
    turn.timers.push(setTimeout(() => this.signal(turn, "SIGTERM"), CANCEL_TERM_MS), setTimeout(() => this.signal(turn, "SIGKILL"), CANCEL_KILL_MS));
  }

  /** A stop of Otti Connect itself: the input closes as for a cancel, but within the stop's few seconds (SIGTERM after 2 s, SIGKILL after 4 s). */
  private end(turn: Turn): void {
    if (turn.exit) return;
    if (turn.state === "running") turn.state = "stopping";
    turn.cancelled = true;
    this.closeInput(turn);
    for (const timer of turn.timers.splice(0)) clearTimeout(timer);
    turn.timers.push(setTimeout(() => this.signal(turn, "SIGTERM"), SHUTDOWN_MS - 3_000), setTimeout(() => this.signal(turn, "SIGKILL"), SHUTDOWN_MS - 1_000));
  }

  /** The process exited and its output ended: the exit goes out with the last chunk. */
  private exited(turn: Turn, exit: Exit): void {
    if (turn.exit) return;
    clearTimeout(turn.outputEnd);
    for (const timer of turn.timers.splice(0)) clearTimeout(timer);
    turn.exit = { code: exit.code, signal: exit.signal, stderrTail: plain(exit.stderrTail + turn.decoder.end()).slice(-STDERR_TAIL_CHARS) };
    turn.state = "exited";
    turn.inputs.clear();
    if (turn.forgotten) return;
    const took = duration(Date.now() - turn.acceptedAt);
    const how = turn.cancelled
      ? "was stopped"
      : exit.code === 0
        ? "ended"
        : exit.signal
          ? `ended by ${exit.signal}`
          : exit.code === null
            ? "couldn't start"
            : `failed (exit ${exit.code})`;
    this.log(`${turn.name} ${how} after ${took} (${turn.short})`);
    this.send(turn);
  }

  /** The server holds the output up to `bytes`: what is before it is forgotten here. */
  private confirm(turn: Turn, bytes: number): void {
    // An answer that crossed a later upload may say less than another already did.
    turn.confirmed = Math.max(turn.confirmed, Math.min(bytes, turn.log.end));
    turn.log.drop(turn.confirmed);
    if (turn.log.end > turn.confirmed || turn.exit) this.schedule(turn);
  }

  /** The server doesn't take the turn (any more): its process stops, and the turn is forgotten. */
  private drop(turn: Turn, why: string): void {
    if (turn.forgotten) return;
    if (!turn.exit) {
      this.closeInput(turn);
      this.signal(turn, "SIGTERM");
      setTimeout(() => this.signal(turn, "SIGKILL"), 3_000).unref();
      this.log(`${turn.name} stopped: ${why} (${turn.short})`);
    }
    this.forget(turn);
  }

  private forget(turn: Turn): void {
    turn.forgotten = true;
    this.turns.delete(turn.runId);
    clearTimeout(turn.flushTimer);
    turn.wake?.();
  }

  // -------------------------------------------------------------------------
  // Output
  // -------------------------------------------------------------------------

  /** Small writes gather for BATCH_MS before they go out. */
  private schedule(turn: Turn): void {
    if (turn.uploading || turn.flushTimer || turn.forgotten) return;
    turn.flushTimer = setTimeout(() => {
      turn.flushTimer = undefined;
      this.send(turn);
    }, turn.exit ? 0 : BATCH_MS);
  }

  /** Uploads what the turn has now. */
  private send(turn: Turn): void {
    this.upload(turn).catch((error) => this.log(`${turn.name}: its output couldn't be sent: ${(error as Error)?.message ?? error}`));
  }

  /**
   * Uploads the turn's output from where the server stands, one request at a
   * time, and its exit with the last chunk. Without an answer it tries again
   * (1 s, doubling up to 30 s) from the last confirmed byte; the server keeps
   * what it holds and takes the rest. The turn is forgotten once the server
   * confirmed its exit with all its bytes.
   */
  private async upload(turn: Turn): Promise<void> {
    if (turn.uploading || turn.forgotten) return;
    turn.uploading = true;
    clearTimeout(turn.flushTimer);
    turn.flushTimer = undefined;
    let retryMs = RETRY_MIN_MS;
    let eager = true;
    try {
      while (!turn.forgotten) {
        const pending = turn.log.end - turn.confirmed;
        if (pending <= 0 && !turn.exit) return;
        // After one upload, small writes gather again (the finally below schedules them); a full chunk or the end goes at once.
        if (!eager && !turn.exit && pending < MAX_OUTPUT_CHUNK_BYTES) return;
        if (!(await this.ready()) || turn.forgotten) return;
        const offset = turn.confirmed;
        const end = turn.log.end;
        const to = Math.min(end, offset + MAX_OUTPUT_CHUNK_BYTES);
        const exit = turn.exit && to === end ? turn.exit : undefined;
        const data = turn.log.read(offset, to);
        const token = this.token, hostId = this.hostId;
        let answer: JsonAnswer;
        try {
          answer = await requestJson(this.baseUrl, HOST_API_PATHS.output, {
            method: "POST",
            token,
            timeoutMs: REQUEST_TIMEOUT_MS,
            body: { hostId, runId: turn.runId, offset, data: data.toString("base64"), ...(exit ? { exit } : {}) },
          });
        } catch (error) {
          this.unreachable((error as Error).message);
          await this.retryWait(turn, retryMs);
          retryMs = Math.min(RETRY_MAX_MS, retryMs * 2);
          eager = true;
          continue;
        }
        const code = answerCode(answer);
        if (answer.status === 200) {
          this.reached();
          retryMs = RETRY_MIN_MS;
          eager = false;
          const bytes = typeof answer.body?.outputBytes === "number" ? answer.body.outputBytes : to;
          // Bytes it didn't take: it no longer takes this turn's output.
          if (data.length && bytes <= offset) {
            this.drop(turn, `${this.baseUrl} takes no more of its output`);
            return;
          }
          this.confirm(turn, bytes);
          if (exit && bytes >= end) {
            this.forget(turn);
            return;
          }
          continue;
        }
        if (answer.status === 409 && code === "output_gap") {
          const bytes = answer.body?.outputBytes;
          if (typeof bytes === "number" && bytes >= turn.log.base && bytes <= turn.log.end) {
            turn.confirmed = bytes;
            eager = true;
            continue;
          }
          this.drop(turn, `${this.baseUrl} lost output it had confirmed`);
          return;
        }
        // A sign-in or a host that stopped working is the main loop's to mend; an answer about one replaced meanwhile is old news.
        if (answer.status === 401 || answer.status === 403 || (answer.status === 404 && code === "agent_host_not_found")) {
          if (token === this.token && hostId === this.hostId)
            this.flag(answer.status === 401 ? new SignedOut(answerError(answer)) : answer.status === 403 ? new Forbidden(answerError(answer)) : new HostGone(answerError(answer)));
          eager = true;
          continue;
        }
        if (answer.status === 404) {
          this.drop(turn, code === "turn_lost" ? `${this.baseUrl} gave it up` : `${this.baseUrl} doesn't know it`);
          return;
        }
        if (answer.status === 408 || answer.status === 429 || answer.status >= 500) {
          this.unreachable(answerError(answer));
          await this.retryWait(turn, retryMs);
          retryMs = Math.min(RETRY_MAX_MS, retryMs * 2);
          eager = true;
          continue;
        }
        this.drop(turn, `${this.baseUrl} refused its output: ${answerError(answer)}`);
        return;
      }
    } finally {
      turn.uploading = false;
      if (!turn.forgotten && (turn.log.end > turn.confirmed || turn.exit)) this.schedule(turn);
    }
  }

  /** Waits before an upload tries again; a reconnect or a stop ends the wait early. */
  private async retryWait(turn: Turn, ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        turn.wake = undefined;
        resolve();
      }
      turn.wake = done;
    });
  }

  // -------------------------------------------------------------------------
  // Agents and stopping
  // -------------------------------------------------------------------------

  private async checkAgents(): Promise<void> {
    if (this.checking || this.stopping) return;
    this.checking = true;
    try {
      const agents = await detectAgents(this.report);
      if (JSON.stringify(agents) === JSON.stringify(this.agents)) return;
      this.agents = agents;
      // The next poll takes them to the server.
      this.log(["The agents changed:", ...describeAgents(agents).map((line) => `  ${line}`)].join("\n"));
    } finally {
      this.checking = false;
    }
  }

  private shutdown(signal: NodeJS.Signals): void {
    if (this.stopping) {
      // A second Ctrl+C: at once.
      for (const turn of this.turns.values()) this.signal(turn, "SIGKILL");
      process.exit(signal === "SIGINT" ? 130 : 143);
    }
    this.stopping = true;
    this.signalled = true;
    const running = [...this.turns.values()].filter((turn) => !turn.exit);
    this.say(`\n${clock()} Stopping${running.length ? `: ending ${running.length} running turn${running.length === 1 ? "" : "s"}` : ""}.`);
    this.stop.abort();
    for (const turn of running) this.end(turn);
  }

  /** At a stop: waits a few seconds for the turns' exits to reach Octomerge, then ends what is left and says this computer is stopping. */
  private async drain(): Promise<void> {
    const deadline = Date.now() + SHUTDOWN_MS;
    while (this.turns.size && Date.now() < deadline) await sleep(100);
    for (const turn of this.turns.values()) this.signal(turn, "SIGKILL");
    if (this.turns.size) this.log(`${this.turns.size} turn${this.turns.size === 1 ? "'s" : "s'"} end didn't reach ${this.baseUrl}.`);
    await this.close();
    if (!this.turns.size && this.signalled) this.log("Stopped.");
    this.finished = true;
    this.wakeWaiters();
    for (const turn of this.turns.values()) turn.wake?.();
  }

  /** The last poll, `closing`: Octomerge sends no new turn here until this computer polls again, and moves the turns waiting to start here elsewhere. */
  private async close(): Promise<void> {
    if (!this.registered || !this.token || !this.hostId) return;
    await requestJson(this.baseUrl, HOST_API_PATHS.poll, {
      method: "POST",
      token: this.token,
      timeoutMs: CLOSE_TIMEOUT_MS,
      body: { hostId: this.hostId, turns: this.progress(), closing: true },
    }).catch(() => {
      // Out of reach: Octomerge finds the computer gone a minute later.
    });
  }
}
