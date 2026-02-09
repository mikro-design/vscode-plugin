import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import * as fs from "fs";
import * as path from "path";

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

type MiRecord = {
  token?: number;
  type: string;
  class?: string;
  results?: any;
  output?: string;
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
  private readonly threadId = 1;
  private isRunning = false;
  private readonly logPath = process.env.MIKRO_DEBUG_ADAPTER_LOG;
  private breakpoints = new Map<string, number[]>();
  private variablesRefs = new Map<number, VarRef>();
  private nextVarRef = 1;
  private registerNames: string[] | null = null;
  private lastFrames: any[] = [];
  private lastRegisterValues: { name: string; value: string; variablesReference: number }[] | null = null;
  private shuttingDown = false;
  private ioClosed = false;
  private parentWatchTimer: NodeJS.Timeout | undefined;
  private stepRecoveryTimer: NodeJS.Timeout | undefined;
  private pauseRecoveryTimer: NodeJS.Timeout | undefined;

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
    while (true) {
      if (this.expectedLength === null) {
        const headerEnd = this.buffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) {
          return;
        }
        const header = this.buffer.slice(0, headerEnd).toString("utf8");
        const match = header.match(/Content-Length:\s*(\d+)/i);
        if (!match) {
          this.buffer = this.buffer.slice(headerEnd + 4);
          continue;
        }
        this.expectedLength = Number.parseInt(match[1], 10);
        this.buffer = this.buffer.slice(headerEnd + 4);
      }
      if (this.expectedLength === null || this.buffer.length < this.expectedLength) {
        return;
      }
      const body = this.buffer.slice(0, this.expectedLength).toString("utf8");
      this.buffer = this.buffer.slice(this.expectedLength);
      this.expectedLength = null;
      try {
        const message = JSON.parse(body);
        void this.handleMessage(message);
      } catch {
        // ignore malformed payloads
      }
    }
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
        await this.onConfigurationDone(request);
        return;
      case "setBreakpoints":
        this.onSetBreakpoints(request).catch((err) => this.sendResponse(request, false, undefined, String(err)));
        return;
      case "setExceptionBreakpoints":
        this.sendResponse(request, true, { breakpoints: [] });
        return;
      case "setInstructionBreakpoints":
        this.sendResponse(request, true, { breakpoints: [] });
        return;
      case "threads":
        this.sendResponse(request, true, { threads: [{ id: this.threadId, name: "rv32sim" }] });
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
    this.stopAtEntry = true;
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
        const res = await this.sendMiCommand(`-break-insert -f \"${escapeMiString(target)}\"`);
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
    try {
      const res = await this.sendMiCommand("-stack-list-frames");
      frames = this.normalizeFrames(res?.stack ?? []);
    } catch (err) {
      const msg = String(err ?? "");
      if (msg.toLowerCase().includes("running")) {
        this.log(`stackTrace while running; returning cached frames (${this.lastFrames.length})`);
        frames = this.lastFrames;
      } else {
        throw err;
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
    await this.sendMiCommand(`-stack-select-frame ${refInfo.frameId}`).catch(() => undefined);
    let res: any = null;
    try {
      res = await this.sendMiCommand("-stack-list-variables --simple-values");
    } catch (err) {
      if (this.isRunningStateError(err)) {
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
      this.sendEvent("continued", { threadId: this.threadId, allThreadsContinued: true });
      return;
    }
    try {
      await this.sendMiCommand("-exec-continue");
      this.isRunning = true;
      this.sendResponse(request, true, { allThreadsContinued: true });
      this.sendEvent("continued", { threadId: this.threadId, allThreadsContinued: true });
    } catch (err) {
      const msg = String(err ?? "");
      if (msg.toLowerCase().includes("running")) {
        this.isRunning = true;
        this.sendResponse(request, true, { allThreadsContinued: true });
        this.sendEvent("continued", { threadId: this.threadId, allThreadsContinued: true });
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
    this.sendResponse(request, true);
    this.armPauseRecovery();
    // Request interrupt but let real '*stopped' MI event drive state transitions.
    void this.sendMiCommand("-exec-interrupt").catch((err) => {
      const msg = String(err ?? "");
      const lower = msg.toLowerCase();
      if (lower.includes("stopped") || lower.includes("not running") || lower.includes("running thread is required")) {
        return;
      }
      this.log(`pause interrupt failed: ${msg}`);
    });
  }

  private async onStep(request: DapRequest, command: string): Promise<void> {
    if (this.isRunning) {
      this.sendResponse(request, true);
      return;
    }
    try {
      await this.sendMiCommand(command);
      this.isRunning = true;
      this.armStepRecovery();
      this.sendResponse(request, true);
      return;
    } catch (err) {
      if (!this.isRunningStateError(err)) {
        throw err;
      }
      this.log(`step recovered from running-state error: ${String(err)}`);
      await this.sendMiCommand("-exec-interrupt").catch(() => undefined);
      await this.waitForThreadStop(1500).catch(() => false);
      this.isRunning = false;
      try {
        await this.sendMiCommand(command);
        this.isRunning = true;
        this.armStepRecovery();
        this.sendResponse(request, true);
      } catch (retryErr) {
        if (this.isRunningStateError(retryErr)) {
          this.isRunning = true;
          this.armStepRecovery();
          this.sendResponse(request, true);
          return;
        }
        throw retryErr;
      }
    }
  }

  private async onEvaluate(request: DapRequest): Promise<void> {
    const expression = String(request.arguments?.expression ?? "").trim();
    if (!expression) {
      this.sendResponse(request, true, { result: "", variablesReference: 0 });
      return;
    }
    const res = await this.sendMiCommand(`-data-evaluate-expression \"${escapeMiString(expression)}\"`);
    const result = res?.value ?? "";
    this.sendResponse(request, true, { result, variablesReference: 0 });
  }

  private async onGetRegisters(request: DapRequest): Promise<void> {
    if (this.isRunning) {
      await this.refreshRunningStateFromThreadInfo();
    }
    let regs: { name: string; value: string; variablesReference: number }[] = [];
    try {
      regs = await this.listRegisters();
    } catch (err) {
      if (!this.isRunningStateError(err)) {
        throw err;
      }
    }
    this.sendResponse(request, true, {
      running: this.isRunning,
      count: regs.length,
      registers: regs,
    });
  }

  private async startGdb(program: string): Promise<void> {
    this.log("startGdb begin");
    this.gdb = spawn(this.gdbPath, ["--nx", "--quiet", "--interpreter=mi2", program], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.gdb.on("error", (err) => {
      this.log(`gdb spawn error: ${String(err)}`);
      this.sendEvent("output", { category: "stderr", output: `gdb spawn failed: ${String(err)}\n` });
      this.sendEvent("terminated");
    });
    this.gdb.stdout.on("data", (chunk) => this.onGdbData(chunk.toString()));
    this.gdb.stderr.on("data", (chunk) => this.sendEvent("output", { category: "stderr", output: chunk.toString() }));
    this.gdb.on("exit", (code, signal) => {
      this.log(`gdb exit code=${code ?? "unknown"} signal=${signal ?? "none"} lastMiToken=${this.lastMiToken} lastMiCommand=${this.lastMiCommand}`);
      this.gdb = null;
      this.sendEvent("terminated");
    });

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
    await this.sendMiCommand(`-interpreter-exec console \"monitor load_elf ${program}\"`).catch(() => undefined);
    this.log("startGdb load_elf done");

    if (this.stopAtEntry) {
      await this.checkInitialStop();
      return;
    }
    await this.sendMiCommand("-exec-continue").catch(() => undefined);
  }

  private async checkInitialStop(): Promise<void> {
    if (this.entryStopped) {
      this.log("entry already stopped; skipping initial stop probe");
      this.awaitingInitialStop = false;
      if (this.initialStopTimer) {
        clearInterval(this.initialStopTimer);
        this.initialStopTimer = undefined;
      }
      return;
    }
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
      threadId: this.threadId,
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
      this.clearRecoveryTimers();
      this.isRunning = false;
      const reasonRaw = record.results?.reason ?? "breakpoint-hit";
      const reason = mapStopReason(reasonRaw);
      const bkpt = record.results?.bkptno ?? record.results?.bkpt;
      const hit = bkpt ? [Number.parseInt(bkpt, 10)].filter((v) => Number.isFinite(v)) : [];
      if (this.stopAtEntry && !this.entryStopped) {
        this.log("initial stop reached (entry)");
        this.emitEntryStop(hit.length ? hit : undefined);
        return;
      }
      this.sendEvent("stopped", {
        reason,
        threadId: this.threadId,
        allThreadsStopped: true,
        hitBreakpointIds: hit.length ? hit : undefined,
      });
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

  private normalizeFrames(list: any[]): any[] {
    if (!Array.isArray(list)) {
      return [];
    }
    return list.map((item) => item?.frame ?? item).filter(Boolean);
  }

  private normalizeVariables(list: any[]): any[] {
    if (!Array.isArray(list)) {
      return [];
    }
    return list.map((item) => item?.variable ?? item).filter(Boolean);
  }

  private async listRegisters(): Promise<{ name: string; value: string; variablesReference: number }[]> {
    if (this.isRunning) {
      await this.refreshRunningStateFromThreadInfo();
    }
    if (this.isRunning) {
      return this.lastRegisterValues ?? [];
    }
    await this.sendMiCommand(`-thread-select ${this.threadId}`).catch(() => undefined);
    if (!this.registerNames) {
      const names = await this.sendMiCommand("-data-list-register-names").catch((err) => {
        if (this.isRunningStateError(err)) {
          return {};
        }
        throw err;
      });
      const raw = names?.["register-names"] ?? [];
      this.registerNames = Array.isArray(raw) ? raw.map((name: string) => name || "") : [];
      this.applyRegisterNameFallback();
    }
    let res = await this.sendMiCommand("-data-list-register-values x").catch((err) => {
      this.log(`register-values x failed: ${String(err)}`);
      return null;
    });
    if (!res || !Array.isArray(res?.["register-values"]) || res["register-values"].length === 0) {
      res = await this.sendMiCommand("-data-list-register-values r").catch((err) => {
        this.log(`register-values r failed: ${String(err)}`);
        if (this.isRunningStateError(err)) {
          return null;
        }
        throw err;
      });
    }
    const values = res?.["register-values"] ?? [];
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
    if (variables.length === 0) {
      return this.lastRegisterValues ?? [];
    }
    this.lastRegisterValues = variables;
    return variables;
  }

  private buildFallbackRegisterValues(): { name: string; value: string; variablesReference: number }[] {
    const names = this.registerNames && this.registerNames.length ? this.registerNames : defaultRiscvRegisterNames();
    const values = names.map((name) => ({ name, value: "<unavailable>", variablesReference: 0 }));
    this.lastRegisterValues = values;
    return values;
  }

  private isInvalidRegisterName(name?: string | null): boolean {
    if (!name) {
      return true;
    }
    const trimmed = name.trim();
    if (!trimmed) {
      return true;
    }
    return /^r?nan$/i.test(trimmed);
  }

  private applyRegisterNameFallback(): void {
    const fallback = defaultRiscvRegisterNames();
    if (!this.registerNames || this.registerNames.length === 0) {
      this.registerNames = [...fallback];
      return;
    }
    const allEmpty = this.registerNames.every((name) => this.isInvalidRegisterName(name));
    if (allEmpty) {
      this.registerNames = [...fallback];
      return;
    }
    for (let i = 0; i < fallback.length; i += 1) {
      if (this.isInvalidRegisterName(this.registerNames[i])) {
        this.registerNames[i] = fallback[i];
      }
    }
    if (this.registerNames.length < fallback.length) {
      for (let i = this.registerNames.length; i < fallback.length; i += 1) {
        this.registerNames.push(fallback[i]);
      }
    }
  }

  private sendMiCommand(command: string): Promise<any> {
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
        }, this.commandTimeoutMs);
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
    this.awaitingInitialStop = false;
    this.entryStopped = false;
    this.clearRecoveryTimers();
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

  private clearRecoveryTimers(): void {
    if (this.stepRecoveryTimer) {
      clearTimeout(this.stepRecoveryTimer);
      this.stepRecoveryTimer = undefined;
    }
    if (this.pauseRecoveryTimer) {
      clearTimeout(this.pauseRecoveryTimer);
      this.pauseRecoveryTimer = undefined;
    }
  }

  private armStepRecovery(): void {
    if (this.stepRecoveryTimer) {
      clearTimeout(this.stepRecoveryTimer);
    }
    this.stepRecoveryTimer = setTimeout(() => {
      this.stepRecoveryTimer = undefined;
      void this.forceStopRecovery("step");
    }, 7000);
  }

  private armPauseRecovery(): void {
    if (this.pauseRecoveryTimer) {
      clearTimeout(this.pauseRecoveryTimer);
    }
    this.pauseRecoveryTimer = setTimeout(() => {
      this.pauseRecoveryTimer = undefined;
      void this.forceStopRecovery("pause");
    }, 5000);
  }

  private async forceStopRecovery(reason: "step" | "pause"): Promise<void> {
    if (!this.isRunning || this.shuttingDown) {
      return;
    }
    this.log(`${reason} recovery: forcing interrupt`);
    await this.sendMiCommand("-exec-interrupt").catch((err) => {
      this.log(`${reason} recovery interrupt failed: ${String(err)}`);
    });
    const stopped = await this.waitForThreadStop(1500);
    if (!stopped || !this.isRunning) {
      this.isRunning = false;
      this.sendEvent("stopped", {
        reason,
        threadId: this.threadId,
        allThreadsStopped: true,
      });
    }
  }

  private isRunningStateError(err: unknown): boolean {
    const message = String(err ?? "").toLowerCase();
    return (
      message.includes("selected thread is running") ||
      message.includes("thread is running") ||
      message.includes("running thread is required") ||
      message.includes("cannot execute this command while")
    );
  }

  private async refreshRunningStateFromThreadInfo(): Promise<void> {
    try {
      const info = await this.sendMiCommand("-thread-info");
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
    if (!err || typeof err !== "object") {
      return false;
    }
    const code = (err as NodeJS.ErrnoException).code;
    return code === "EPIPE" || code === "ERR_STREAM_DESTROYED";
  }
}

function mapStopReason(reason: string): string {
  switch (reason) {
    case "breakpoint-hit":
      return "breakpoint";
    case "end-stepping-range":
      return "step";
    case "signal-received":
      return "signal";
    case "exited-normally":
      return "exited";
    default:
      return "pause";
  }
}

function escapeMiString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function parseNumber(value: string): number {
  if (value.startsWith("0x") || value.startsWith("0X")) {
    return Number.parseInt(value, 16);
  }
  return Number.parseInt(value, 10) || 0;
}

function parseMiLine(line: string): MiRecord | null {
  if (!line) {
    return null;
  }
  const streamTypes = ["~", "&", "@"]; 
  if (streamTypes.includes(line[0])) {
    return { type: line[0], output: parseMiCString(line.slice(1)) };
  }
  let i = 0;
  let tokenStr = "";
  while (i < line.length && /[0-9]/.test(line[i])) {
    tokenStr += line[i];
    i += 1;
  }
  const token = tokenStr ? Number.parseInt(tokenStr, 10) : undefined;
  const type = line[i];
  if (!type || !["^", "*", "="].includes(type)) {
    return null;
  }
  const rest = line.slice(i + 1);
  const commaIndex = rest.indexOf(",");
  const cls = commaIndex === -1 ? rest : rest.slice(0, commaIndex);
  const resultsText = commaIndex === -1 ? "" : rest.slice(commaIndex + 1);
  const results = resultsText ? parseMiResults(resultsText).results : {};
  return { token, type, class: cls, results };
}

function parseMiResults(text: string): { results: any; index: number } {
  const results: any = {};
  let index = 0;
  while (index < text.length) {
    const parsed = parseMiResult(text, index);
    results[parsed.key] = parsed.value;
    index = parsed.index;
    if (text[index] === ",") {
      index += 1;
      continue;
    }
    break;
  }
  return { results, index };
}

function parseMiResult(text: string, start: number): { key: string; value: any; index: number } {
  let index = start;
  let key = "";
  while (index < text.length && text[index] !== "=") {
    key += text[index];
    index += 1;
  }
  index += 1; // skip '='
  const parsed = parseMiValue(text, index);
  return { key: key.trim(), value: parsed.value, index: parsed.index };
}

function parseMiValue(text: string, start: number): { value: any; index: number } {
  let index = start;
  const ch = text[index];
  if (ch === '"') {
    const { value, index: nextIndex } = parseMiCStringWithIndex(text, index);
    return { value, index: nextIndex };
  }
  if (ch === "{") {
    index += 1;
    const parsed = parseMiResults(text.slice(index));
    index += parsed.index;
    if (text[index] === "}") {
      index += 1;
    }
    return { value: parsed.results, index };
  }
  if (ch === "[") {
    index += 1;
    const items: any[] = [];
    while (index < text.length && text[index] !== "]") {
      if (text[index] === ",") {
        index += 1;
        continue;
      }
      const item = parseMiListItem(text, index);
      items.push(item.value);
      index = item.index;
      if (text[index] === ",") {
        index += 1;
      }
    }
    if (text[index] === "]") {
      index += 1;
    }
    return { value: items, index };
  }
  let raw = "";
  while (index < text.length && !",]".includes(text[index])) {
    raw += text[index];
    index += 1;
  }
  return { value: raw, index };
}

function parseMiListItem(text: string, start: number): { value: any; index: number } {
  let cursor = start;
  let inString = false;
  while (cursor < text.length) {
    const ch = text[cursor];
    if (ch === '"' && text[cursor - 1] !== "\\") {
      inString = !inString;
    }
    if (!inString && ch === "=") {
      const key = text.slice(start, cursor).trim();
      const parsed = parseMiValue(text, cursor + 1);
      const obj: any = {};
      obj[key] = parsed.value;
      return { value: obj, index: parsed.index };
    }
    if (!inString && (ch === "," || ch === "]")) {
      break;
    }
    cursor += 1;
  }
  const parsed = parseMiValue(text, start);
  return { value: parsed.value, index: parsed.index };
}

function parseMiCString(text: string): string {
  const parsed = parseMiCStringWithIndex(text, 0);
  return parsed.value;
}

function parseMiCStringWithIndex(text: string, start: number): { value: string; index: number } {
  let index = start;
  if (text[index] === '"') {
    index += 1;
  }
  let value = "";
  while (index < text.length) {
    const ch = text[index];
    if (ch === '"' && text[index - 1] !== "\\") {
      index += 1;
      break;
    }
    if (ch === "\\" && index + 1 < text.length) {
      const next = text[index + 1];
      if (next === "n") {
        value += "\n";
      } else if (next === "t") {
        value += "\t";
      } else {
        value += next;
      }
      index += 2;
      continue;
    }
    value += ch;
    index += 1;
  }
  return { value, index };
}

function defaultRiscvRegisterNames(): string[] {
  return [
    "x0 (zero)",
    "x1 (ra)",
    "x2 (sp)",
    "x3 (gp)",
    "x4 (tp)",
    "x5 (t0)",
    "x6 (t1)",
    "x7 (t2)",
    "x8 (s0/fp)",
    "x9 (s1)",
    "x10 (a0)",
    "x11 (a1)",
    "x12 (a2)",
    "x13 (a3)",
    "x14 (a4)",
    "x15 (a5)",
    "x16 (a6)",
    "x17 (a7)",
    "x18 (s2)",
    "x19 (s3)",
    "x20 (s4)",
    "x21 (s5)",
    "x22 (s6)",
    "x23 (s7)",
    "x24 (s8)",
    "x25 (s9)",
    "x26 (s10)",
    "x27 (s11)",
    "x28 (t3)",
    "x29 (t4)",
    "x30 (t5)",
    "x31 (t6)",
  ];
}

function parseUnixAddress(address: string): string | null {
  if (!address) {
    return null;
  }
  if (address.startsWith("unix://")) {
    return address.slice("unix://".length);
  }
  if (address.startsWith("unix:")) {
    return address.slice("unix:".length);
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function buildShellCommand(args: string[]): string {
  return args.map(shellEscape).join(" ");
}

if (require.main === module) {
  new Rv32SimDebugAdapter().start();
}
