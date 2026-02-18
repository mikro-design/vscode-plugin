import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import * as fs from "fs";
import * as path from "path";
import {
  parseMiLine,
  mapStopReason,
  escapeMiString,
  parseNumber,
  defaultRiscvRegisterNames,
  parseUnixAddress,
  sleep,
  buildShellCommand,
} from "./miParser";

// Exported pure helpers for unit testing

export function normalizeFrameList(list: any[]): any[] {
  if (!Array.isArray(list)) {
    return [];
  }
  return list.map((item) => item?.frame ?? item).filter(Boolean);
}

export function normalizeVariableList(list: any[]): any[] {
  if (!Array.isArray(list)) {
    return [];
  }
  return list.map((item) => item?.variable ?? item).filter(Boolean);
}

export function isRunningStateErrorMessage(err: unknown): boolean {
  const message = String(err ?? "").toLowerCase();
  return (
    message.includes("selected thread is running") ||
    message.includes("thread is running") ||
    message.includes("running thread is required") ||
    message.includes("cannot execute this command while")
  );
}

export function isInvalidRegName(name?: string | null): boolean {
  if (!name) {
    return true;
  }
  const trimmed = name.trim();
  if (!trimmed) {
    return true;
  }
  return /^r?nan$/i.test(trimmed);
}

export function buildRegisterNameFallback(registerNames: string[] | null): string[] {
  const fallback = defaultRiscvRegisterNames();
  if (!registerNames || registerNames.length === 0) {
    return [...fallback];
  }
  const allEmpty = registerNames.every((name) => isInvalidRegName(name));
  if (allEmpty) {
    return [...fallback];
  }
  const result = [...registerNames];
  for (let i = 0; i < fallback.length; i += 1) {
    if (isInvalidRegName(result[i])) {
      result[i] = fallback[i];
    }
  }
  if (result.length < fallback.length) {
    for (let i = result.length; i < fallback.length; i += 1) {
      result.push(fallback[i]);
    }
  }
  return result;
}

export function isBrokenPipeErrorCode(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }
  const code = (err as NodeJS.ErrnoException).code;
  return code === "EPIPE" || code === "ERR_STREAM_DESTROYED";
}

export function computeDisassemblyRange(
  memoryReference: string,
  offset: number,
  instructionOffset: number,
  instructionCount: number,
  instructionByteSize = 2
): { startAddr: number; endAddr: number } {
  const baseAddr = parseNumber(memoryReference) + offset;
  const size = instructionByteSize > 0 ? instructionByteSize : 2;
  const startAddr = baseAddr + instructionOffset * size;
  const endAddr = startAddr + instructionCount * size;
  return { startAddr, endAddr };
}

export function formatMemoryReadResponse(
  hexContents: string,
  address: number,
  requestedCount: number
): { address: string; data: string; unreadableBytes: number } {
  const buffer = Buffer.from(String(hexContents), "hex");
  return {
    address: `0x${address.toString(16)}`,
    data: buffer.toString("base64"),
    unreadableBytes: Math.max(0, requestedCount - buffer.length),
  };
}

/** Parse DAP Content-Length framed messages from a raw buffer stream.
 *  Returns parsed messages and the remaining unconsumed buffer. */
export function parseDapMessages(
  inputBuffer: Buffer,
  expectedLength: number | null
): { messages: any[]; remaining: Buffer; expectedLength: number | null } {
  const messages: any[] = [];
  let buffer = inputBuffer;
  let expected = expectedLength;
  while (true) {
    if (expected === null) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) {
        break;
      }
      const header = buffer.slice(0, headerEnd).toString("utf8");
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        buffer = buffer.slice(headerEnd + 4);
        continue;
      }
      expected = Number.parseInt(match[1], 10);
      buffer = buffer.slice(headerEnd + 4);
    }
    if (expected === null || buffer.length < expected) {
      break;
    }
    const body = buffer.slice(0, expected).toString("utf8");
    buffer = buffer.slice(expected);
    expected = null;
    try {
      messages.push(JSON.parse(body));
    } catch {
      // ignore malformed payloads
    }
  }
  return { messages, remaining: buffer, expectedLength: expected };
}

/** Encode a DAP message into Content-Length framed bytes. */
export function encodeDapMessage(payload: object): string {
  const json = JSON.stringify(payload);
  const bytes = Buffer.from(json, "utf8");
  return `Content-Length: ${bytes.length}\r\n\r\n${bytes.toString("utf8")}`;
}

/** Parse the *stopped MI async record and extract stop reason, breakpoint IDs, and thread. */
export function parseStoppedMiRecord(results: any): {
  reason: string;
  hitBreakpointIds: number[];
  threadId: number;
} {
  const reasonRaw = results?.reason ?? "breakpoint-hit";
  const reason = mapStopReason(reasonRaw);
  const bkpt = results?.bkptno ?? results?.bkpt;
  const hit = bkpt ? [Number.parseInt(bkpt, 10)].filter((v) => Number.isFinite(v)) : [];
  const threadIdStr = results?.["thread-id"];
  const threadId = threadIdStr ? Number.parseInt(threadIdStr, 10) : 1;
  return { reason, hitBreakpointIds: hit, threadId };
}

type DapRequest = {
  seq: number;
  type: "request";
  command: string;
  arguments?: any;
};

type DapResponse = {
  seq: number;
  type: "response";
  request_seq: number;
  command: string;
  success: boolean;
  message?: string;
  body?: any;
};

type DapEvent = {
  seq: number;
  type: "event";
  event: string;
  body?: any;
};

type VarRef =
  | { kind: "locals"; frameId: number }
  | { kind: "registers" }
  | { kind: "memory"; address: number; length: number };

class Rv32SimDebugAdapter {
  private seq = 1;
  private buffer = Buffer.alloc(0);
  private expectedLength: number | null = null;
  private gdb: ChildProcessWithoutNullStreams | null = null;
  private gdbBuffer = "";
  private lastMiCommand = "";
  private lastMiToken = 0;
  private lastMiSentMs = 0;
  private miToken = 1;
  private pending = new Map<
    number,
    { resolve: (value: any) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }
  >();
  private miQueue: Promise<unknown> = Promise.resolve();
  private commandTimeoutMs = Number.parseInt(process.env.MIKRO_DEBUG_ADAPTER_TIMEOUT_MS ?? "20000", 10);
  private stopAtEntry = true;
  private awaitingInitialStop = false;
  private initialStopTimer: NodeJS.Timeout | undefined;
  private initialStopDeadline = 0;
  private entryStopped = false;
  private entryPoint: number | null = null;
  private program: string | undefined;
  private gdbPath = "riscv32-unknown-elf-gdb";
  private serverAddress = "localhost:3333";
  private threads: { id: number; name: string }[] = [{ id: 1, name: "main" }];
  private defaultThreadId = 1;
  private isRunning = false;
  private readonly logPath = process.env.MIKRO_DEBUG_ADAPTER_LOG;
  private breakpoints = new Map<string, number[]>();
  private instructionBreakpointIds: number[] = [];
  private watchpointIds: number[] = [];
  private variablesRefs = new Map<number, VarRef>();
  private nextVarRef = 1;
  private registerNames: string[] | null = null;
  private lastFrames: any[] = [];
  private lastRegisterValues: { name: string; value: string; variablesReference: number }[] | null = null;
  private shuttingDown = false;
  private serverCapabilities = {
    supportsHardwareBreakpoints: false,
    supportsWatchpoints: true,
    supportsMultiThread: false,
    hwBreakpointLimit: 0,
    supportsLiveMemoryRead: false,
  };
  private postConnectCommands: string[] = [];
  private loadCommand: string | null = null;
  private liveWatchTimer: NodeJS.Timeout | undefined;
  private liveWatchEnabled = false;
  private ioClosed = false;
  private parentWatchTimer: NodeJS.Timeout | undefined;
  private deferStoppedEvents = false;
  private deferredStopped: any | null = null;
  private stopPollInFlight: Promise<void> | null = null;
  private stopPollReason = "";
  private dapQueue: Promise<void> = Promise.resolve();
  /** True when the adapter emitted a synthetic "stopped" event but GDB still
   *  believes the target is running (e.g. rv32sim blocked on assert stdin).
   *  When set, register / stack queries are answered from cache to prevent
   *  MI command storms of "Selected thread is running" errors. */
  private syntheticStop = false;

  private log(message: string): void {
    if (!this.logPath) {
      return;
    }
    try {
      fs.appendFileSync(this.logPath, `${new Date().toISOString()} [ADAPTER] ${message}\n`);
    } catch {
      // ignore logging failures
    }
  }

  start(): void {
    this.log("adapter start");
    process.stdin.on("data", (chunk: Buffer) => this.onData(chunk));
    process.stdin.on("error", () => this.shutdown());
    process.stdin.on("end", () => this.shutdown());
    process.stdout.on("error", (err: NodeJS.ErrnoException) => {
      if (this.isBrokenPipeError(err)) {
        this.log(`stdout closed: ${err.code ?? "EPIPE"}`);
      } else {
        this.log(`stdout error: ${String(err)}`);
      }
      this.ioClosed = true;
      this.shutdown();
    });
    process.on("SIGTERM", () => this.shutdown());
    process.on("SIGINT", () => this.shutdown());
    this.parentWatchTimer = setInterval(() => {
      if (this.shuttingDown) {
        return;
      }
      if (process.ppid === 1) {
        this.log("parent process detached; shutting down adapter");
        this.shutdown();
      }
    }, 1000) as unknown as NodeJS.Timeout;
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const result = parseDapMessages(this.buffer, this.expectedLength);
    this.buffer = Buffer.from(result.remaining);
    this.expectedLength = result.expectedLength;
    for (const message of result.messages) {
      this.enqueueDapMessage(message);
    }
  }

  /** Serialize DAP message processing to prevent concurrent handler races. */
  private enqueueDapMessage(message: any): void {
    this.dapQueue = this.dapQueue.then(
      () => this.handleMessage(message),
      () => this.handleMessage(message)
    ).then(() => undefined, () => undefined);
  }

  private async handleMessage(message: any): Promise<void> {
    if (message?.type !== "request") {
      return;
    }
    const request = message as DapRequest;
    this.log(`request ${request.command}`);
    switch (request.command) {
      case "initialize":
        this.onInitialize(request);
        return;
      case "launch":
        this.onLaunch(request).catch((err) => this.sendResponse(request, false, undefined, String(err)));
        return;
      case "configurationDone":
        this.onConfigurationDone(request).catch((err) => this.sendResponse(request, false, undefined, String(err)));
        return;
      case "setBreakpoints":
        this.onSetBreakpoints(request).catch((err) => this.sendResponse(request, false, undefined, String(err)));
        return;
      case "setExceptionBreakpoints":
        this.sendResponse(request, true, { breakpoints: [] });
        return;
      case "setInstructionBreakpoints":
        this.onSetInstructionBreakpoints(request).catch((err) => this.sendResponse(request, false, undefined, String(err)));
        return;
      case "dataBreakpointInfo":
        this.onDataBreakpointInfo(request);
        return;
      case "setDataBreakpoints":
        this.onSetDataBreakpoints(request).catch((err) => this.sendResponse(request, false, undefined, String(err)));
        return;
      case "disassemble":
        this.onDisassemble(request).catch((err) => this.sendResponse(request, false, undefined, String(err)));
        return;
      case "threads":
        this.onThreads(request).catch((err) => this.sendResponse(request, false, undefined, String(err)));
        return;
      case "stackTrace":
        this.onStackTrace(request).catch((err) => this.sendResponse(request, false, undefined, String(err)));
        return;
      case "scopes":
        this.onScopes(request);
        return;
      case "variables":
        this.onVariables(request).catch((err) => this.sendResponse(request, false, undefined, String(err)));
        return;
      case "readMemory":
        this.onReadMemory(request).catch((err) => this.sendResponse(request, false, undefined, String(err)));
        return;
      case "continue":
        if (this.stopAtEntry && !this.entryStopped && this.awaitingInitialStop) {
          this.log("continue ignored before entry stop");
          this.sendResponse(request, true);
          return;
        }
        this.onContinue(request).catch((err) => this.sendResponse(request, false, undefined, String(err)));
        return;
      case "pause":
        this.onPause(request).catch((err) => this.sendResponse(request, false, undefined, String(err)));
        return;
      case "next":
        if (this.stopAtEntry && !this.entryStopped && this.awaitingInitialStop) {
          this.log("step ignored before entry stop");
          this.sendResponse(request, true);
          return;
        }
        this.onStep(request, "-exec-next").catch((err) => this.sendResponse(request, false, undefined, String(err)));
        return;
      case "stepIn":
        if (this.stopAtEntry && !this.entryStopped && this.awaitingInitialStop) {
          this.log("stepIn ignored before entry stop");
          this.sendResponse(request, true);
          return;
        }
        this.onStep(request, "-exec-step").catch((err) => this.sendResponse(request, false, undefined, String(err)));
        return;
      case "stepOut":
        if (this.stopAtEntry && !this.entryStopped && this.awaitingInitialStop) {
          this.log("stepOut ignored before entry stop");
          this.sendResponse(request, true);
          return;
        }
        this.onStep(request, "-exec-finish").catch((err) => this.sendResponse(request, false, undefined, String(err)));
        return;
      case "evaluate":
        this.onEvaluate(request).catch((err) => this.sendResponse(request, false, undefined, String(err)));
        return;
      case "mikro.getRegisters":
        this.onGetRegisters(request).catch((err) => this.sendResponse(request, false, undefined, String(err)));
        return;
      case "disconnect":
      case "terminate":
        this.sendResponse(request, true);
        this.shutdown();
        return;
      default:
        this.sendResponse(request, false, undefined, `Unsupported command: ${request.command}`);
    }
  }

  private onInitialize(request: DapRequest): void {
    this.sendResponse(request, true, {
      supportsConfigurationDoneRequest: true,
      supportsTerminateRequest: true,
      supportsRestartRequest: false,
      supportsBreakpoints: true,
      supportsConditionalBreakpoints: true,
      supportsInstructionBreakpoints: true,
      supportsDataBreakpoints: true,
      supportsDisassembleRequest: true,
      supportsStackTraceRequest: true,
      supportsScopesRequest: true,
      supportsVariablesRequest: true,
      supportsEvaluateForHovers: true,
      supportsPauseRequest: true,
      supportsStepInRequest: true,
      supportsStepOutRequest: true,
      supportsStepBack: false,
      supportsReadMemoryRequest: true,
    });
    this.sendEvent("initialized");
  }

  private async onLaunch(request: DapRequest): Promise<void> {
    const args = request.arguments ?? {};
    this.stopAtEntry = typeof args.stopAtEntry === "boolean" ? args.stopAtEntry : true;
    this.awaitingInitialStop = false;
    if (this.initialStopTimer) {
      clearInterval(this.initialStopTimer);
      this.initialStopTimer = undefined;
    }
    this.initialStopDeadline = 0;
    this.entryStopped = false;
    this.program = args.program;
    this.gdbPath = args.gdbPath || args.miDebuggerPath || this.gdbPath;
    this.serverAddress = args.miDebuggerServerAddress || this.serverAddress;
    this.registerNames = null;
    this.lastRegisterValues = null;
    this.variablesRefs.clear();
    this.nextVarRef = 1;
    this.breakpoints.clear();
    this.instructionBreakpointIds = [];
    this.watchpointIds = [];
    this.entryPoint = null;
    const entryArg = args.entryPoint ?? args.mikroEntryPoint;
    if (typeof entryArg === "number" && Number.isFinite(entryArg)) {
      this.entryPoint = entryArg;
    } else if (typeof entryArg === "string" && entryArg.trim().length) {
      this.entryPoint = parseNumber(entryArg.trim());
    }
    if (Number.isFinite(Number.parseInt(args.gdbTimeoutMs ?? "", 10))) {
      this.commandTimeoutMs = Number.parseInt(args.gdbTimeoutMs, 10);
    }
    if (args._serverCapabilities) {
      const caps = args._serverCapabilities;
      this.serverCapabilities = {
        supportsHardwareBreakpoints: caps.supportsHardwareBreakpoints ?? false,
        supportsWatchpoints: caps.supportsWatchpoints ?? false,
        supportsMultiThread: caps.supportsMultiThread ?? false,
        hwBreakpointLimit: caps.hwBreakpointLimit ?? 0,
        supportsLiveMemoryRead: caps.supportsLiveMemoryRead ?? false,
      };
      if (this.serverCapabilities.supportsWatchpoints === false) {
        this.sendEvent("capabilities", { capabilities: { supportsDataBreakpoints: false } });
      }
    }
    if (Array.isArray(args._postConnectCommands)) {
      this.postConnectCommands = args._postConnectCommands;
    }
    if (typeof args._loadCommand === "string") {
      this.loadCommand = args._loadCommand;
    }
    this.log(
      `launch program=${this.program ?? ""} gdb=${this.gdbPath} server=${this.serverAddress} stopAtEntry=forced entryPoint=${
        this.entryPoint !== null ? `0x${this.entryPoint.toString(16)}` : "unknown"
      }`
    );

    if (!this.program) {
      this.sendResponse(request, false, undefined, "Missing program path.");
      return;
    }

    await this.startGdb(this.program);
    this.sendResponse(request, true);
  }

  private async onConfigurationDone(request: DapRequest): Promise<void> {
    this.sendResponse(request, true);
    if (!this.stopAtEntry) {
      await this.sendMiCommand("-exec-continue").catch(() => undefined);
    }
  }

  private async onSetBreakpoints(request: DapRequest): Promise<void> {
    const sourcePath = request.arguments?.source?.path;
    if (!sourcePath) {
      this.sendResponse(request, true, { breakpoints: [] });
      return;
    }
    const previous = this.breakpoints.get(sourcePath) ?? [];
    for (const id of previous) {
      await this.sendMiCommand(`-break-delete ${id}`).catch(() => undefined);
    }

    const newIds: number[] = [];
    const breakpoints = [];
    const requested = request.arguments?.breakpoints ?? [];
    for (const bp of requested) {
      const line = Number(bp.line);
      const target = `${sourcePath}:${line}`;
      let verified = false;
      try {
        let cmd = "-break-insert -f";
        if (bp.condition) {
          cmd += ` -c \"${escapeMiString(bp.condition)}\"`;
        }
        cmd += ` \"${escapeMiString(target)}\"`;
        const res = await this.sendMiCommand(cmd);
        const bkpt = res?.bkpt ?? res?.breakpoint ?? res?.[0]?.bkpt ?? {};
        const num = Number.parseInt(bkpt.number ?? bkpt.num ?? "", 10);
        if (Number.isFinite(num)) {
          newIds.push(num);
          verified = true;
        }
      } catch (err) {
        this.log(`break-insert failed for ${target}: ${String(err)}`);
      }
      breakpoints.push({ verified, line });
    }
    this.breakpoints.set(sourcePath, newIds);
    this.sendResponse(request, true, { breakpoints });
  }

  private async onStackTrace(request: DapRequest): Promise<void> {
    let frames: any[] = [];
    if (this.syntheticStop) {
      // GDB still thinks target is running — return cached frames
      frames = this.lastFrames;
    } else {
      try {
        const res = await this.sendMiCommand("-stack-list-frames");
        frames = this.normalizeFrames(res?.stack ?? []);
      } catch (err) {
        const msg = String(err ?? "");
        if (msg.toLowerCase().includes("running")) {
          this.syntheticStop = true;
          this.log(`stackTrace running-state error; flagging syntheticStop, returning cached frames (${this.lastFrames.length})`);
          frames = this.lastFrames;
        } else {
          throw err;
        }
      }
    }
    this.lastFrames = frames;
    const stackFrames = frames.map((frame, index) => {
      const file = frame.fullname || frame.file;
      const line = frame.line ? Number.parseInt(frame.line, 10) : 0;
      const name = frame.func || frame.addr || `frame ${index}`;
      return {
        id: index,
        name,
        source: file ? { path: file } : undefined,
        line: line || 1,
        column: 1,
      };
    });
    this.sendResponse(request, true, { stackFrames, totalFrames: stackFrames.length });
  }

  private onScopes(request: DapRequest): void {
    const frameId = Number(request.arguments?.frameId ?? 0);
    const localsRef = this.nextVarRef++;
    const regsRef = this.nextVarRef++;
    this.variablesRefs.set(localsRef, { kind: "locals", frameId });
    this.variablesRefs.set(regsRef, { kind: "registers" });
    this.sendResponse(request, true, {
      scopes: [
        {
          name: "Locals",
          variablesReference: localsRef,
          presentationHint: "locals",
        },
        {
          name: "Registers",
          variablesReference: regsRef,
          presentationHint: "registers",
        },
      ],
    });
  }

  private async onVariables(request: DapRequest): Promise<void> {
    const ref = Number(request.arguments?.variablesReference ?? 0);
    const refInfo = this.variablesRefs.get(ref);
    if (!refInfo) {
      this.sendResponse(request, true, { variables: [] });
      return;
    }
    if (refInfo.kind === "registers") {
      const regs = await this.listRegisters();
      this.sendResponse(request, true, { variables: regs });
      return;
    }
    if (refInfo.kind === "memory") {
      this.sendResponse(request, true, { variables: [] });
      return;
    }
    if (this.syntheticStop) {
      this.sendResponse(request, true, { variables: [] });
      return;
    }
    await this.sendMiCommand(`-stack-select-frame ${refInfo.frameId}`).catch((err) => {
      if (this.isRunningStateError(err)) {
        this.syntheticStop = true;
      }
    });
    if (this.syntheticStop) {
      this.sendResponse(request, true, { variables: [] });
      return;
    }
    let res: any = null;
    try {
      res = await this.sendMiCommand("-stack-list-variables --simple-values");
    } catch (err) {
      if (this.isRunningStateError(err)) {
        this.syntheticStop = true;
        this.sendResponse(request, true, { variables: [] });
        return;
      }
      throw err;
    }
    const vars = this.normalizeVariables(res?.variables ?? []);
    const variables = vars.map((variable) => ({
      name: variable.name ?? "",
      value: variable.value ?? "",
      variablesReference: 0,
    }));
    this.sendResponse(request, true, { variables });
  }

  private async onReadMemory(request: DapRequest): Promise<void> {
    const memoryReference = String(request.arguments?.memoryReference ?? "").trim();
    const offset = Number(request.arguments?.offset ?? 0);
    const count = Number(request.arguments?.count ?? 0);
    if (!memoryReference || !Number.isFinite(count) || count <= 0) {
      this.sendResponse(request, true, { address: memoryReference, data: "" });
      return;
    }
    if (this.syntheticStop) {
      this.sendResponse(request, true, { address: memoryReference, data: "", unreadableBytes: count });
      return;
    }
    const base = parseNumber(memoryReference);
    const address = base + offset;
    const res = await this.sendMiCommand(`-data-read-memory-bytes ${address} ${count}`);
    const memory = res?.memory ?? res?.[0]?.memory ?? [];
    const entry = Array.isArray(memory) ? memory[0] : memory;
    const contents = entry?.contents ?? entry?.data ?? "";
    const buffer = Buffer.from(String(contents), "hex");
    this.sendResponse(request, true, {
      address: `0x${address.toString(16)}`,
      data: buffer.toString("base64"),
      unreadableBytes: Math.max(0, count - buffer.length),
    });
  }

  private async onContinue(request: DapRequest): Promise<void> {
    if (this.isRunning) {
      this.sendResponse(request, true, { allThreadsContinued: true });
      this.sendEvent("continued", { threadId: this.defaultThreadId, allThreadsContinued: true });
      return;
    }
    try {
      await this.sendMiCommand("-exec-continue");
      this.isRunning = true;
      this.syntheticStop = false;
      this.sendResponse(request, true, { allThreadsContinued: true });
      this.sendEvent("continued", { threadId: this.defaultThreadId, allThreadsContinued: true });
    } catch (err) {
      const msg = String(err ?? "");
      if (msg.toLowerCase().includes("running")) {
        this.isRunning = true;
        this.syntheticStop = false;
        this.sendResponse(request, true, { allThreadsContinued: true });
        this.sendEvent("continued", { threadId: this.defaultThreadId, allThreadsContinued: true });
        return;
      }
      throw err;
    }
  }

  private async onPause(request: DapRequest): Promise<void> {
    if (!this.isRunning) {
      this.sendResponse(request, true);
      return;
    }
    await this.sendMiCommand("-exec-interrupt").catch((err) => {
      const msg = String(err ?? "");
      const lower = msg.toLowerCase();
      if (lower.includes("stopped") || lower.includes("not running") || lower.includes("running thread is required")) {
        return;
      }
      this.log(`pause interrupt failed: ${msg}`);
    });
    // rv32sim may not emit *stopped after interrupt; actively poll and force transition
    await this.pollForStopSingleFlight("pause", 2000);
    this.sendResponse(request, true);
  }

  private async onStep(request: DapRequest, command: string): Promise<void> {
    if (this.isRunning) {
      this.sendResponse(request, true);
      return;
    }
    this.syntheticStop = false;
    const pcBefore = await this.readPc();
    this.log(`step begin cmd=${command} pcBefore=${pcBefore !== null ? `0x${pcBefore.toString(16)}` : "n/a"}`);
    try {
      await this.sendMiCommand(command);
      this.isRunning = true;
      this.sendResponse(request, true);
      // rv32sim may not emit *stopped after step; actively poll and force transition
      await this.pollForStopSingleFlight("step", 3000);
      if (!this.isRunning) {
        const pcAfter = await this.readPc();
        this.log(
          `step end cmd=${command} pcAfter=${pcAfter !== null ? `0x${pcAfter.toString(16)}` : "n/a"} moved=${pcBefore !== null && pcAfter !== null ? pcBefore !== pcAfter : "unknown"}`
        );
      } else {
        this.log(`step end cmd=${command} target still running after poll`);
      }
      return;
    } catch (err) {
      if (!this.isRunningStateError(err)) {
        throw err;
      }
      this.log(`step recovered from running-state error: ${String(err)}`);
      await this.sendMiCommand("-exec-interrupt").catch(() => undefined);
      await this.pollForStopSingleFlight("step", 1500);
      try {
        await this.sendMiCommand(command);
        this.isRunning = true;
        this.sendResponse(request, true);
        await this.pollForStopSingleFlight("step", 3000);
        if (!this.isRunning) {
          const pcAfter = await this.readPc();
          this.log(
            `step end(retry) cmd=${command} pcAfter=${pcAfter !== null ? `0x${pcAfter.toString(16)}` : "n/a"} moved=${pcBefore !== null && pcAfter !== null ? pcBefore !== pcAfter : "unknown"}`
          );
        } else {
          this.log(`step end(retry) cmd=${command} target still running after poll`);
        }
      } catch (retryErr) {
        if (this.isRunningStateError(retryErr)) {
          this.isRunning = true;
          this.sendResponse(request, true);
          await this.pollForStopSingleFlight("step", 3000);
          if (!this.isRunning) {
            const pcAfter = await this.readPc();
            this.log(
              `step end(running-recover) cmd=${command} pcAfter=${pcAfter !== null ? `0x${pcAfter.toString(16)}` : "n/a"} moved=${pcBefore !== null && pcAfter !== null ? pcBefore !== pcAfter : "unknown"}`
            );
          } else {
            this.log(`step end(running-recover) cmd=${command} target still running after poll`);
          }
          return;
        }
        throw retryErr;
      }
    }
  }

  private async onEvaluate(request: DapRequest): Promise<void> {
    const expression = String(request.arguments?.expression ?? "").trim();
    const context = String(request.arguments?.context ?? "").trim();
    if (!expression) {
      this.sendResponse(request, true, { result: "", variablesReference: 0 });
      return;
    }
    if (this.isRunning || this.syntheticStop) {
      this.sendResponse(request, true, { result: "<running>", variablesReference: 0 });
      return;
    }
    if (context === "repl") {
      if (expression.startsWith("-")) {
        try {
          const res = await this.sendMiCommand(expression);
          const result = JSON.stringify(res, null, 2);
          this.sendResponse(request, true, { result, variablesReference: 0 });
        } catch (err) {
          this.sendResponse(request, true, { result: String(err), variablesReference: 0 });
        }
        return;
      }
      if (expression.startsWith("monitor ")) {
        try {
          const res = await this.sendMiCommand(`-interpreter-exec console \"${escapeMiString(expression)}\"`);
          this.sendResponse(request, true, { result: JSON.stringify(res), variablesReference: 0 });
        } catch (err) {
          this.sendResponse(request, true, { result: String(err), variablesReference: 0 });
        }
        return;
      }
    }
    try {
      const res = await this.sendMiCommand(`-data-evaluate-expression \"${escapeMiString(expression)}\"`);
      const result = res?.value ?? "";
      this.sendResponse(request, true, { result, variablesReference: 0 });
    } catch (err) {
      if (this.isRunningStateError(err)) {
        this.sendResponse(request, true, { result: "<running>", variablesReference: 0 });
        return;
      }
      throw err;
    }
  }

  private async onGetRegisters(request: DapRequest): Promise<void> {
    if (this.isRunning) {
      // Don't query GDB while target is running – avoids flooding MI with failing commands
      this.sendResponse(request, true, {
        running: true,
        count: 0,
        registers: [],
      });
      return;
    }
    if (this.syntheticStop) {
      // Adapter forced a synthetic stop but GDB still thinks target is running.
      // Return cached registers to avoid MI command storm.
      const cached = this.lastRegisterValues ?? [];
      this.sendResponse(request, true, {
        running: false,
        syntheticStop: true,
        count: cached.length,
        registers: cached,
      });
      return;
    }
    let regs: { name: string; value: string; variablesReference: number }[] = [];
    try {
      regs = await this.listRegisters();
    } catch (err) {
      if (!this.isRunningStateError(err)) {
        throw err;
      }
      // GDB says target is running — flag as synthetic stop to prevent future storms
      this.syntheticStop = true;
    }
    this.sendResponse(request, true, {
      running: this.isRunning,
      syntheticStop: this.syntheticStop,
      count: regs.length,
      registers: regs,
    });
  }

  private async onSetInstructionBreakpoints(request: DapRequest): Promise<void> {
    for (const id of this.instructionBreakpointIds) {
      await this.sendMiCommand(`-break-delete ${id}`).catch(() => undefined);
    }
    this.instructionBreakpointIds = [];

    const requested = request.arguments?.breakpoints ?? [];
    const breakpoints = [];
    for (const bp of requested) {
      const addr = String(bp.instructionReference ?? "").trim();
      if (!addr) {
        breakpoints.push({ verified: false, message: "No address" });
        continue;
      }
      const limit = this.serverCapabilities.hwBreakpointLimit;
      if (limit > 0 && breakpoints.filter((b: any) => b.verified).length >= limit) {
        breakpoints.push({ verified: false, message: `Hardware breakpoint limit (${limit}) reached` });
        continue;
      }
      try {
        let cmd = `-break-insert -h *${addr}`;
        if (bp.condition) {
          cmd = `-break-insert -h -c \"${escapeMiString(bp.condition)}\" *${addr}`;
        }
        const res = await this.sendMiCommand(cmd);
        const bkpt = res?.bkpt ?? res?.breakpoint ?? {};
        const num = Number.parseInt(bkpt.number ?? bkpt.num ?? "", 10);
        const verified = Number.isFinite(num);
        if (verified) {
          this.instructionBreakpointIds.push(num);
        }
        breakpoints.push({
          verified,
          instructionReference: addr,
        });
      } catch (err) {
        this.log(`hw break-insert failed for ${addr}: ${String(err)}`);
        breakpoints.push({ verified: false, message: String(err) });
      }
    }
    this.sendResponse(request, true, { breakpoints });
  }

  private onDataBreakpointInfo(request: DapRequest): void {
    if (!this.serverCapabilities.supportsWatchpoints) {
      this.sendResponse(request, true, {
        dataId: null,
        description: "Data breakpoints are not supported by this target",
        accessTypes: [],
      });
      return;
    }
    const name = String(request.arguments?.name ?? "").trim();
    if (!name) {
      this.sendResponse(request, true, { dataId: null, description: "No expression", accessTypes: [] });
      return;
    }
    const accessTypes = ["write", "read", "readWrite"];
    this.sendResponse(request, true, {
      dataId: name,
      description: name,
      accessTypes,
    });
  }

  private async onSetDataBreakpoints(request: DapRequest): Promise<void> {
    if (!this.serverCapabilities.supportsWatchpoints) {
      const requested = request.arguments?.breakpoints ?? [];
      this.sendResponse(request, true, {
        breakpoints: requested.map(() => ({ verified: false, message: "Data breakpoints are not supported by this target" })),
      });
      return;
    }
    // Delete existing watchpoints
    for (const wpId of this.watchpointIds) {
      await this.sendMiCommand(`-break-delete ${wpId}`).catch(() => undefined);
    }
    this.watchpointIds = [];

    const requested = request.arguments?.breakpoints ?? [];
    const breakpoints = [];
    for (const bp of requested) {
      const dataId = String(bp.dataId ?? "").trim();
      if (!dataId) {
        breakpoints.push({ verified: false, message: "No expression" });
        continue;
      }
      const accessType = bp.accessType ?? "write";
      let flag = "";
      if (accessType === "read") {
        flag = "-r ";
      } else if (accessType === "readWrite") {
        flag = "-a ";
      }
      try {
        const res = await this.sendMiCommand(`-break-watch ${flag}${dataId}`);
        const wpt = res?.wpt ?? res?.["hw-rwpt"] ?? res?.["hw-awpt"] ?? {};
        const num = Number.parseInt(wpt.number ?? "", 10);
        if (Number.isFinite(num)) {
          this.watchpointIds.push(num);
          breakpoints.push({ verified: true });
        } else {
          breakpoints.push({ verified: false, message: "Watchpoint not confirmed by GDB" });
        }
      } catch (err) {
        this.log(`watchpoint failed for ${dataId}: ${String(err)}`);
        breakpoints.push({ verified: false, message: String(err) });
      }
    }
    this.sendResponse(request, true, { breakpoints });
  }

  private async onDisassemble(request: DapRequest): Promise<void> {
    const memoryReference = String(request.arguments?.memoryReference ?? "").trim();
    const offset = Number(request.arguments?.offset ?? 0);
    const instructionOffset = Number(request.arguments?.instructionOffset ?? 0);
    const instructionCount = Number(request.arguments?.instructionCount ?? 100);
    const { startAddr, endAddr } = computeDisassemblyRange(memoryReference, offset, instructionOffset, instructionCount, 2);
    try {
      const res = await this.sendMiCommand(
        `-data-disassemble -s 0x${Math.max(0, startAddr).toString(16)} -e 0x${endAddr.toString(16)} -- 0`
      );
      const insns = res?.asm_insns ?? [];
      const instructions = (Array.isArray(insns) ? insns : []).map((insn: any) => {
        const raw = insn?.["func-name"] ? insn : insn?.src ?? insn;
        return {
          address: String(raw?.address ?? "0x0"),
          instruction: String(raw?.inst ?? "<unknown>"),
          symbol: raw?.["func-name"] ? `${raw["func-name"]}+${raw?.offset ?? "0"}` : undefined,
        };
      });
      this.sendResponse(request, true, { instructions });
    } catch (err) {
      this.log(`disassemble failed: ${String(err)}`);
      this.sendResponse(request, true, { instructions: [] });
    }
  }

  private async onThreads(request: DapRequest): Promise<void> {
    if (!this.serverCapabilities.supportsMultiThread) {
      this.sendResponse(request, true, { threads: this.threads.map((t) => ({ id: t.id, name: t.name })) });
      return;
    }
    try {
      const info = await this.sendMiCommand("-thread-info");
      const threadList = info?.threads ?? [];
      if (Array.isArray(threadList) && threadList.length > 0) {
        this.threads = threadList.map((t: any) => ({
          id: Number.parseInt(t.id ?? "1", 10),
          name: t["target-id"] ?? t.name ?? `Thread ${t.id}`,
        }));
      }
    } catch {
      // Fall back to stored threads
    }
    this.sendResponse(request, true, { threads: this.threads.map((t) => ({ id: t.id, name: t.name })) });
  }

  private async startGdb(program: string): Promise<void> {
    this.log("startGdb begin");
    this.deferStoppedEvents = true;
    this.deferredStopped = null;
    this.gdb = spawn(this.gdbPath, ["--nx", "--quiet", "--interpreter=mi2", program], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.gdb.on("error", (err) => {
      this.log(`gdb spawn error: ${String(err)}`);
      this.sendEvent("output", { category: "stderr", output: `gdb spawn failed: ${String(err)}\n` });
      this.gdb = null;
      // Reject all pending MI commands immediately so callers don't wait for timeout
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("gdb exited"));
      }
      this.pending.clear();
      this.sendEvent("terminated");
    });
    this.gdb.stdout.on("data", (chunk) => this.onGdbData(chunk.toString()));
    this.gdb.stderr.on("data", (chunk) => this.sendEvent("output", { category: "stderr", output: chunk.toString() }));
    this.gdb.on("exit", (code, signal) => {
      this.log(`gdb exit code=${code ?? "unknown"} signal=${signal ?? "none"} lastMiToken=${this.lastMiToken} lastMiCommand=${this.lastMiCommand}`);
      this.gdb = null;
      // Reject all pending MI commands immediately so callers don't wait for timeout
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("gdb exited"));
      }
      this.pending.clear();
      this.sendEvent("terminated");
    });

    try {
      await this.sendMiCommand("-gdb-set pagination off").catch(() => undefined);
      await this.sendMiCommand("-gdb-set breakpoint pending on").catch(() => undefined);
      await this.sendMiCommand("-gdb-set target-async on").catch(() => undefined);
      const unixPath = parseUnixAddress(this.serverAddress);
      if (unixPath) {
        const bridgePath = path.join(__dirname, "gdbUnixBridge.js");
        const pipeCommand = buildShellCommand([process.execPath, bridgePath, unixPath]);
        await this.sendMiCommand(`-target-select remote |${pipeCommand}`);
      } else {
        await this.sendMiCommand(`-target-select remote ${this.serverAddress}`);
      }
      for (const cmd of this.postConnectCommands) {
        await this.sendMiCommand(`-interpreter-exec console \"${escapeMiString(cmd)}\"`).catch((err) => {
          const message = `post-connect command failed: ${cmd} -> ${String(err)}`;
          this.log(message);
          this.sendEvent("output", { category: "stderr", output: `${message}\n` });
        });
      }
      const loadCmd = this.loadCommand ?? `monitor load_elf ${program}`;
      try {
        await this.sendMiCommand(`-interpreter-exec console \"${escapeMiString(loadCmd)}\"`);
      } catch (err) {
        throw new Error(`Failed to execute load command (${loadCmd}): ${String(err)}`);
      }
      this.log("startGdb load done");

      // Now that ELF is loaded, allow stopped events and replay any deferred one
      this.deferStoppedEvents = false;
      if (this.deferredStopped) {
        this.log("replaying deferred *stopped after load_elf");
        this.isRunning = false;
        this.deferredStopped = null;
      }

      if (this.stopAtEntry) {
        await this.checkInitialStop();
        return;
      }
      await this.sendMiCommand("-exec-continue").catch(() => undefined);
    } catch (err) {
      // Clean up the GDB process on startup failure to prevent orphaned processes
      this.log(`startGdb failed: ${String(err)}`);
      if (this.gdb) {
        try {
          this.gdb.kill("SIGTERM");
        } catch {
          // ignore
        }
        this.gdb = null;
      }
      this.deferStoppedEvents = false;
      throw err;
    }
  }

  private async checkInitialStop(): Promise<void> {
    this.log("stopAtEntry enabled; checking thread state");
    if (await this.waitForThreadStop(200)) {
      this.log("thread already stopped; emitting entry stop");
      this.emitEntryStop();
      return;
    }
    await this.sendMiCommand("-exec-interrupt").catch((err) => {
      this.log(`interrupt for entry failed: ${String(err)}`);
    });
    if (await this.waitForThreadStop(1200)) {
      this.log("interrupt stop detected; emitting entry stop");
      this.emitEntryStop();
      return;
    }
    const entryAddr = this.entryPoint ?? (await this.readPc()) ?? 0;
    const entryExpr = `*0x${entryAddr.toString(16)}`;
    let breakpointSet = false;
    try {
      await this.sendMiCommand(`-break-insert -t -f ${entryExpr}`);
      this.log(`entry temp breakpoint set at ${entryExpr}`);
      breakpointSet = true;
    } catch (err) {
      this.log(`entry breakpoint failed: ${String(err)}`);
    }
    await this.sendMiCommand("-exec-continue").catch((err) => {
      this.log(`continue for entry failed: ${String(err)}`);
    });
    this.isRunning = true;
    this.ensureEntryStop(!breakpointSet);
  }

  private async waitForThreadStop(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const info = await this.sendMiCommand("-thread-info");
        const threads = info?.threads ?? info?.["threads"] ?? [];
        const first = Array.isArray(threads) ? threads[0] : threads;
        const state = typeof first?.state === "string" ? first.state : undefined;
        if (state && state !== "running") {
          return true;
        }
      } catch (err) {
        this.log(`thread-info failed: ${String(err)}`);
        return false;
      }
      await sleep(120);
    }
    return false;
  }

  private async readPc(): Promise<number | null> {
    try {
      const res = await this.sendMiCommand(`-data-evaluate-expression "$pc"`);
      const value = String(res?.value ?? "").trim();
      if (!value) {
        return null;
      }
      return parseNumber(value);
    } catch (err) {
      this.log(`read pc failed: ${String(err)}`);
      return null;
    }
  }

  private ensureEntryStop(forceInterrupt: boolean): void {
    if (this.awaitingInitialStop) {
      this.log("entry stop pending; refreshing timer");
    } else {
      this.awaitingInitialStop = true;
    }
    this.initialStopDeadline = Date.now() + 5000;
    let interruptRequested = false;
    if (forceInterrupt) {
      this.log("entry stop pending; sending interrupt");
      this.requestInterrupt();
      interruptRequested = true;
    }
    if (this.initialStopTimer) {
      clearTimeout(this.initialStopTimer);
    }
    this.initialStopTimer = setInterval(() => {
      if (!this.awaitingInitialStop || this.shuttingDown) {
        if (this.initialStopTimer) {
          clearInterval(this.initialStopTimer);
          this.initialStopTimer = undefined;
        }
        return;
      }
      if (Date.now() >= this.initialStopDeadline) {
        if (this.initialStopTimer) {
          clearInterval(this.initialStopTimer);
          this.initialStopTimer = undefined;
        }
        void this.recoverEntryStopAfterTimeout();
        return;
      }
      if (!interruptRequested && Date.now() + 1200 >= this.initialStopDeadline) {
        this.log("entry stop still pending; forcing interrupt");
        this.requestInterrupt();
        interruptRequested = true;
      }
    }, 200) as unknown as NodeJS.Timeout;
  }

  private async recoverEntryStopAfterTimeout(): Promise<void> {
    if (!this.awaitingInitialStop || this.entryStopped || this.shuttingDown) {
      return;
    }
    this.log("entry stop timeout; forcing recovery interrupt");
    await this.sendMiCommand("-exec-interrupt").catch((err) => {
      this.log(`entry recovery interrupt failed: ${String(err)}`);
    });
    if (await this.waitForThreadStop(1500)) {
      this.log("entry stop recovered after timeout");
      this.isRunning = false;
      this.emitEntryStop();
      return;
    }
    this.log("entry stop recovery failed; emitting synthetic stop");
    this.isRunning = false;
    this.emitEntryStop();
  }

  private requestInterrupt(): void {
    this.log("requesting interrupt for stopAtEntry");
    this.sendMiCommand("-exec-interrupt").catch((err) => {
      this.log(`interrupt failed: ${String(err)}`);
    });
  }

  private emitEntryStop(hitBreakpointIds?: number[]): void {
    if (this.entryStopped) {
      return;
    }
    this.awaitingInitialStop = false;
    this.entryStopped = true;
    if (this.initialStopTimer) {
      clearInterval(this.initialStopTimer);
      this.initialStopTimer = undefined;
    }
    this.sendEvent("stopped", {
      reason: "entry",
      threadId: this.defaultThreadId,
      allThreadsStopped: true,
      hitBreakpointIds: hitBreakpointIds && hitBreakpointIds.length ? hitBreakpointIds : undefined,
    });
  }

  private onGdbData(text: string): void {
    this.gdbBuffer += text;
    let idx = this.gdbBuffer.indexOf("\n");
    while (idx >= 0) {
      const line = this.gdbBuffer.slice(0, idx).trim();
      this.gdbBuffer = this.gdbBuffer.slice(idx + 1);
      if (line.length > 0) {
        this.handleMiLine(line);
      }
      idx = this.gdbBuffer.indexOf("\n");
    }
  }

  private handleMiLine(line: string): void {
    const record = parseMiLine(line);
    if (!record) {
      return;
    }
    if (record.type !== "^") {
      this.log(`mi async type=${record.type} class=${record.class ?? ""}`);
    }
    if (record.type === "^" && record.token !== undefined) {
      this.log(`mi<- token=${record.token} class=${record.class ?? ""}`);
      const pending = this.pending.get(record.token);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(record.token);
        if (record.class === "error") {
          pending.reject(new Error(record.results?.msg || "gdb error"));
        } else {
          pending.resolve(record.results ?? {});
        }
      }
      return;
    }
    if (record.type === "*" && record.class === "stopped") {
      this.handleStoppedAsync(record.results ?? {}, "exec");
      return;
    }
    // Some gdb versions/targets report stop as notify records instead of exec records.
    if (record.type === "=" && (record.class === "thread-group-stopped" || record.class === "stopped")) {
      this.handleStoppedAsync(record.results ?? {}, "notify");
      return;
    }
    if (record.type === "*" && record.class === "running") {
      this.isRunning = true;
      return;
    }
    if (record.type === "~" && record.output) {
      this.sendEvent("output", { category: "stdout", output: record.output });
    }
  }

  private handleStoppedAsync(results: any, source: "exec" | "notify"): void {
    this.isRunning = false;
    this.syntheticStop = false; // real *stopped arrived — GDB agrees target is stopped
    if (this.deferStoppedEvents) {
      this.log(`*stopped deferred (connection/load phase, source=${source})`);
      this.deferredStopped = results ?? {};
      return;
    }
    const reasonRaw = results?.reason ?? "breakpoint-hit";
    const reason = mapStopReason(reasonRaw);
    const bkpt = results?.bkptno ?? results?.bkpt;
    const hit = bkpt ? [Number.parseInt(bkpt, 10)].filter((v) => Number.isFinite(v)) : [];
    const threadIdStr = results?.["thread-id"];
    const stoppedThreadId = threadIdStr ? Number.parseInt(threadIdStr, 10) : this.defaultThreadId;
    this.log(`stopped async source=${source} reason=${reason} thread=${stoppedThreadId}`);
    if (this.stopAtEntry && !this.entryStopped) {
      this.log("initial stop reached (entry)");
      this.emitEntryStop(hit.length ? hit : undefined);
      return;
    }
    this.sendEvent("stopped", {
      reason,
      threadId: stoppedThreadId,
      allThreadsStopped: true,
      hitBreakpointIds: hit.length ? hit : undefined,
    });
  }

  private normalizeFrames(list: any[]): any[] {
    return normalizeFrameList(list);
  }

  private normalizeVariables(list: any[]): any[] {
    return normalizeVariableList(list);
  }

  private async listRegisters(): Promise<{ name: string; value: string; variablesReference: number }[]> {
    if (this.syntheticStop) {
      // GDB still thinks target is running — don't send MI commands
      return this.lastRegisterValues ?? [];
    }
    if (this.isRunning) {
      await this.refreshRunningStateFromThreadInfo();
    }
    if (this.isRunning) {
      return this.lastRegisterValues ?? [];
    }
    await this.sendMiCommand(`-thread-select ${this.defaultThreadId}`).catch((err) => {
      if (this.isRunningStateError(err)) {
        this.syntheticStop = true;
      }
    });
    if (this.syntheticStop) {
      return this.lastRegisterValues ?? [];
    }
    if (!this.registerNames) {
      const names = await this.sendMiCommand("-data-list-register-names").catch((err) => {
        if (this.isRunningStateError(err)) {
          this.syntheticStop = true;
          return {};
        }
        throw err;
      });
      if (this.syntheticStop) {
        return this.lastRegisterValues ?? [];
      }
      const raw = names?.["register-names"] ?? [];
      this.registerNames = Array.isArray(raw) ? raw.map((name: string) => name || "") : [];
      this.applyRegisterNameFallback();
    }
    let res = await this.sendMiCommand("-data-list-register-values x").catch((err) => {
      this.log(`register-values x failed: ${String(err)}`);
      if (this.isRunningStateError(err)) {
        this.syntheticStop = true;
      }
      return null;
    });
    if (this.syntheticStop) {
      return this.lastRegisterValues ?? [];
    }
    if (!res || !Array.isArray(res?.["register-values"]) || res["register-values"].length === 0) {
      res = await this.sendMiCommand("-data-list-register-values r").catch((err) => {
        this.log(`register-values r failed: ${String(err)}`);
        if (this.isRunningStateError(err)) {
          this.syntheticStop = true;
          return null;
        }
        throw err;
      });
    }
    if (this.syntheticStop) {
      return this.lastRegisterValues ?? [];
    }
    const values = res?.["register-values"] ?? [];
    this.log(`listRegisters: mi values count=${Array.isArray(values) ? values.length : 0}`);
    const variables: { name: string; value: string; variablesReference: number }[] = [];
    for (const entry of values) {
      const number = Number.parseInt(entry?.number ?? "", 10);
      if (!Number.isFinite(number)) {
        continue;
      }
      const rawName = this.registerNames?.[number];
      const name = !this.isInvalidRegisterName(rawName) ? rawName! : `x${number}`;
      variables.push({ name, value: entry?.value ?? "", variablesReference: 0 });
    }

    await this.enrichCriticalRegisters(variables);
    const names = variables.map((item) => String(item.name ?? ""));
    const pcValue =
      variables.find((item) => String(item.name ?? "").toLowerCase() === "pc")?.value ??
      variables.find((item) => String(item.name ?? "").toLowerCase() === "program counter")?.value ??
      "";
    this.log(
      `listRegisters: exposed count=${variables.length} hasPc=${names.some((name) => name.toLowerCase() === "pc")} pcValue=${pcValue} names=${names.slice(0, 16).join(",")}`
    );

    if (variables.length === 0) {
      return this.lastRegisterValues ?? [];
    }
    this.lastRegisterValues = variables;
    return variables;
  }

  private hasRegisterName(
    variables: { name: string; value: string; variablesReference: number }[],
    aliases: string[]
  ): boolean {
    const wanted = new Set(aliases.map((name) => name.toLowerCase()));
    return variables.some((variable) => wanted.has(String(variable.name ?? "").toLowerCase()));
  }

  private async readRegisterExpression(expr: string): Promise<string | null> {
    try {
      const res = await this.sendMiCommand(`-data-evaluate-expression "${escapeMiString(expr)}"`);
      const value = String(res?.value ?? "").trim();
      return value || null;
    } catch (err) {
      this.log(`read register expression ${expr} failed: ${String(err)}`);
      return null;
    }
  }

  private async appendRegisterIfMissing(
    variables: { name: string; value: string; variablesReference: number }[],
    canonicalName: string,
    aliases: string[],
    expressions: string[]
  ): Promise<void> {
    if (this.hasRegisterName(variables, aliases)) {
      return;
    }
    for (const expr of expressions) {
      const value = await this.readRegisterExpression(expr);
      if (value) {
        variables.push({ name: canonicalName, value, variablesReference: 0 });
        return;
      }
    }
  }

  private async enrichCriticalRegisters(
    variables: { name: string; value: string; variablesReference: number }[]
  ): Promise<void> {
    await this.appendRegisterIfMissing(variables, "pc", ["pc"], ["$pc"]);
    await this.appendRegisterIfMissing(variables, "ra", ["ra", "x1"], ["$ra", "$x1"]);
    await this.appendRegisterIfMissing(variables, "sp", ["sp", "x2"], ["$sp", "$x2"]);
  }

  private buildFallbackRegisterValues(): { name: string; value: string; variablesReference: number }[] {
    const names = this.registerNames && this.registerNames.length ? this.registerNames : defaultRiscvRegisterNames();
    const values = names.map((name) => ({ name, value: "<unavailable>", variablesReference: 0 }));
    this.lastRegisterValues = values;
    return values;
  }

  private isInvalidRegisterName(name?: string | null): boolean {
    return isInvalidRegName(name);
  }

  private applyRegisterNameFallback(): void {
    this.registerNames = buildRegisterNameFallback(this.registerNames);
  }

  private sendMiCommand(command: string, timeoutMs?: number): Promise<any> {
    const timeout = timeoutMs ?? this.commandTimeoutMs;
    return this.enqueue(() =>
      new Promise((resolve, reject) => {
        if (!this.gdb || !this.gdb.stdin.writable || this.shuttingDown) {
          reject(new Error("gdb not running"));
          return;
        }
        const token = this.miToken++;
        this.lastMiToken = token;
        this.lastMiCommand = command;
        this.lastMiSentMs = Date.now();
        this.log(`mi-> token=${token} cmd=${command}`);
        const timer = setTimeout(() => {
          this.pending.delete(token);
          const pendingCount = this.pending.size;
          const elapsed = Date.now() - this.lastMiSentMs;
          const message = `gdb timeout for ${command} (token=${token}, pending=${pendingCount}, isRunning=${this.isRunning}, gdbPid=${this.gdb?.pid ?? "none"}, elapsedMs=${elapsed})`;
          this.log(message);
          reject(new Error(message));
        }, timeout);
        this.pending.set(token, { resolve, reject, timer });
        this.gdb.stdin.write(`${token}${command}\n`);
      })
    );
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.miQueue.then(fn, fn);
    this.miQueue = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  private shutdown(): void {
    if (this.shuttingDown) {
      return;
    }
    this.shuttingDown = true;
    this.syntheticStop = false;
    this.awaitingInitialStop = false;
    this.entryStopped = false;
    if (this.liveWatchTimer) {
      clearInterval(this.liveWatchTimer);
      this.liveWatchTimer = undefined;
    }
    this.liveWatchEnabled = false;
    if (this.parentWatchTimer) {
      clearInterval(this.parentWatchTimer);
      this.parentWatchTimer = undefined;
    }
    if (this.initialStopTimer) {
      clearInterval(this.initialStopTimer);
      this.initialStopTimer = undefined;
    }
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("gdb exited"));
    }
    this.pending.clear();
    if (this.gdb) {
      const gdbProc = this.gdb;
      try {
        // Send quit command to gdb before killing
        if (gdbProc.stdin.writable) {
          gdbProc.stdin.write("-gdb-exit\n");
          gdbProc.stdin.end();
        }
      } catch {
        // ignore
      }
      try {
        gdbProc.kill("SIGTERM");
        // Force kill after timeout
        setTimeout(() => {
          if (gdbProc && !gdbProc.killed) {
            gdbProc.kill("SIGKILL");
          }
        }, 1000);
      } catch {
        // ignore
      }
      this.gdb = null;
    }
    this.sendEvent("terminated");
  }

  /** Poll GDB thread state and emit a stopped event if the target has stopped.
   *  This handles remote targets (like rv32sim) that don't emit *stopped async records. */
  private async pollForStop(reason: string, timeoutMs: number): Promise<void> {
    if (!this.isRunning || this.shuttingDown) {
      return;
    }
    const deadline = Date.now() + timeoutMs;
    const interval = 100;
    let probeErrors = 0;
    while (Date.now() < deadline && this.isRunning && !this.shuttingDown) {
      await sleep(interval);
      // If a real *stopped event arrived in the meantime, we're done
      if (!this.isRunning) {
        return;
      }
      try {
        const info = await this.sendMiCommand("-thread-info", 2000);
        const threads = info?.threads ?? [];
        const first = Array.isArray(threads) ? threads[0] : threads;
        const state = typeof first?.state === "string" ? first.state : "";
        if (state && state !== "running") {
          if (!this.isRunning) {
            this.log(`pollForStop: observed stopped state=${state} after async stop event`);
            return;
          }
          this.log(`pollForStop: thread stopped (state=${state}), emitting ${reason}`);
          this.isRunning = false;
          this.sendEvent("stopped", {
            reason,
            threadId: this.defaultThreadId,
            allThreadsStopped: true,
          });
          return;
        }
      } catch (err) {
        probeErrors += 1;
        if (probeErrors <= 3 || probeErrors % 10 === 0) {
          this.log(`pollForStop: thread-info probe error (${probeErrors}): ${String(err)}`);
        }
        // thread-info may fail while running; continue polling
      }
    }
    if (this.isRunning) {
      this.log(`pollForStop: timeout after ${timeoutMs}ms, attempting interrupt recovery`);
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        await this.sendMiCommand("-exec-interrupt", 2000).catch((err) => {
          this.log(`pollForStop: interrupt attempt ${attempt} failed: ${String(err)}`);
        });
        if (this.isRunning) {
          this.requestHardInterrupt(`pollForStop-recovery-${attempt}`);
        }
        const stopped = await this.waitForStopByThreadInfo(700);
        if (stopped) {
          this.log(`pollForStop: recovered stop after interrupt attempt ${attempt}, emitting ${reason}`);
          this.isRunning = false;
          this.syntheticStop = false; // real recovery — GDB confirms stopped
          this.sendEvent("stopped", {
            reason,
            threadId: this.defaultThreadId,
            allThreadsStopped: true,
          });
          return;
        }
      }
      if (this.isRunning) {
        // Recovery exhausted — force a synthetic stop so the UI stays responsive.
        // This handles cases like step-next inside while(1) where GDB's internal
        // stepping loop can't be interrupted via -exec-interrupt.
        this.log(`pollForStop: recovery failed; forcing synthetic ${reason} stop (gdb still running)`);
        this.isRunning = false;
        this.syntheticStop = true;
        this.sendEvent("stopped", {
          reason,
          threadId: this.defaultThreadId,
          allThreadsStopped: true,
        });
      }
    }
  }

  private async pollForStopSingleFlight(reason: string, timeoutMs: number): Promise<void> {
    if (this.stopPollInFlight) {
      this.log(`pollForStop: join existing poll reason=${this.stopPollReason} requested=${reason}`);
      await this.stopPollInFlight;
      return;
    }
    const run = this.pollForStop(reason, timeoutMs).finally(() => {
      if (this.stopPollInFlight === run) {
        this.stopPollInFlight = null;
        this.stopPollReason = "";
      }
    });
    this.stopPollReason = reason;
    this.stopPollInFlight = run;
    await run;
  }

  private async waitForStopByThreadInfo(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    // Use a short per-command timeout so a hung MI command doesn't block recovery
    const probeTimeout = Math.min(2000, timeoutMs);
    while (Date.now() < deadline && !this.shuttingDown) {
      try {
        const info = await this.sendMiCommand("-thread-info", probeTimeout);
        const threads = info?.threads ?? info?.["threads"] ?? [];
        const first = Array.isArray(threads) ? threads[0] : threads;
        const state = typeof first?.state === "string" ? first.state : "";
        if (state && state !== "running") {
          return true;
        }
      } catch (err) {
        if (!this.isRunningStateError(err)) {
          this.log(`waitForStopByThreadInfo probe error: ${String(err)}`);
        }
      }
      await sleep(80);
    }
    return false;
  }

  private requestHardInterrupt(context: string): void {
    if (!this.gdb || this.shuttingDown) {
      return;
    }
    try {
      this.log(`hard interrupt requested (${context}): sending Ctrl-C to gdb stdin`);
      this.gdb.stdin.write("\u0003");
    } catch (err) {
      this.log(`hard interrupt stdin failed (${context}): ${String(err)}`);
    }
    // NOTE: Do NOT send SIGINT to the GDB process — it corrupts the MI interface,
    // causing subsequent MI commands to hang indefinitely.
  }

  private isRunningStateError(err: unknown): boolean {
    return isRunningStateErrorMessage(err);
  }

  private async refreshRunningStateFromThreadInfo(): Promise<void> {
    try {
      const info = await this.sendMiCommand("-thread-info", 2000);
      const threads = info?.threads ?? info?.["threads"] ?? [];
      const first = Array.isArray(threads) ? threads[0] : threads;
      const state = typeof first?.state === "string" ? first.state : "";
      if (state && state !== "running") {
        this.isRunning = false;
      }
    } catch {
      // ignore
    }
  }

  private sendEvent(event: string, body?: any): void {
    if (event === "stopped" || event === "continued" || event === "terminated") {
      const reason = typeof body?.reason === "string" ? body.reason : "";
      this.log(`sendEvent ${event}${reason ? ` reason=${reason}` : ""}`);
    }
    const payload: DapEvent = {
      seq: this.seq++,
      type: "event",
      event,
      body,
    };
    this.sendPayload(payload);
  }

  private sendResponse(request: DapRequest, success: boolean, body?: any, message?: string): void {
    const payload: DapResponse = {
      seq: this.seq++,
      type: "response",
      request_seq: request.seq,
      command: request.command,
      success,
      body,
      message,
    };
    this.sendPayload(payload);
  }

  private sendPayload(payload: DapResponse | DapEvent): void {
    if (this.ioClosed) {
      return;
    }
    if (!process.stdout.writable || process.stdout.destroyed || process.stdout.writableEnded) {
      this.ioClosed = true;
      return;
    }
    const json = JSON.stringify(payload);
    const bytes = Buffer.from(json, "utf8");
    const header = `Content-Length: ${bytes.length}\r\n\r\n`;
    try {
      process.stdout.write(header + bytes.toString("utf8"));
    } catch (err) {
      this.log(`send payload failed: ${String(err)}`);
      this.ioClosed = true;
      return;
    }
  }

  private isBrokenPipeError(err: unknown): boolean {
    return isBrokenPipeErrorCode(err);
  }
}

if (require.main === module) {
  new Rv32SimDebugAdapter().start();
}
