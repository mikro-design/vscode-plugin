import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { spawn, spawnSync, ChildProcessWithoutNullStreams } from "child_process";
import { AssertPrompt, AssertPromptParser } from "./assertPrompt";
import { resolvePath, getWorkspaceRoot } from "./utils";

export type AssertMode = "none" | "assist" | "enforce";

/** Check if a write prompt should be auto-replied (writes disabled). */
export function shouldAutoReply(
  prompt: { type: string; addr: number; size: number; pc: number; rawLines: string[] },
  allowWriteAsserts: boolean,
): { reply: boolean } {
  if (prompt.type !== "write" || allowWriteAsserts) {
    return { reply: false };
  }
  const ready = prompt.rawLines.some(
    (line) => line.includes("[ASSERT] Write expect") || line.includes("[ASSERT] Value:")
  );
  return { reply: ready };
}

/** Buffer text and extract complete lines containing [ASSERT].
 *  Returns lines to log and remaining buffer. */
export function extractAssertLines(
  existingBuffer: string,
  newText: string
): { lines: string[]; buffer: string } {
  const lines: string[] = [];
  let buf = existingBuffer + newText;
  let idx = buf.indexOf("\n");
  while (idx >= 0) {
    const line = buf.slice(0, idx).replace(/\r$/, "");
    buf = buf.slice(idx + 1);
    if (line.includes("[ASSERT]")) {
      lines.push(line);
    }
    idx = buf.indexOf("\n");
  }
  // Flush partial lines that look like assert prompts
  if (
    buf &&
    !buf.includes("\n") &&
    (buf.includes("[ASSERT] Read value") ||
      buf.includes("[ASSERT] Write expect") ||
      buf.includes("[ASSERT] MMIO"))
  ) {
    lines.push(buf.replace(/\r$/, ""));
    buf = "";
  }
  return { lines, buffer: buf };
}

export function sanitizeAssertValue(input: string): string {
  let firstLine = String(input ?? "")
    .replace(/\r/g, "")
    .split("\n", 1)[0]
    .trim();
  if (!firstLine) {
    return "";
  }
  if (firstLine.startsWith("[ASSERT]")) {
    return "";
  }
  return firstLine;
}

export interface StartOptions {
  rv32simPath: string;
  pythonPath: string;
  gdbPort: number | string;
  gdbMmioReads: boolean;
  strictMode: boolean;
  svdPath?: string;
  elfPath?: string;
  memRegions?: string[];
  assertMode: AssertMode;
  assertFile?: string;
  assertShowAsm: boolean;
  assertVerbose: boolean;
  assertWrites: boolean;
}

export class Rv32SimController {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private simStartMs = 0;
  private lastIoMs = 0;
  private stopRequested = false;
  private healthTimer: NodeJS.Timeout | undefined;
  private lastHeartbeatMs = 0;
  private parser: AssertPromptParser;
  private prompt: AssertPrompt | null = null;
  private assertLogPath: string | null = null;
  private simLogPath: string | null = null;
  private assertLogBuffer = "";
  private onPromptEmitter = new vscode.EventEmitter<AssertPrompt | null>();
  readonly onPromptChanged = this.onPromptEmitter.event;
  private onAssertResponseEmitter = new vscode.EventEmitter<{ prompt: AssertPrompt | null; response: string }>();
  readonly onAssertResponse = this.onAssertResponseEmitter.event;
  private allowWriteAsserts = false;

  constructor(private readonly output: vscode.OutputChannel) {
    const workspaceRoot = getWorkspaceRoot();
    if (workspaceRoot) {
      this.assertLogPath = path.join(workspaceRoot, ".mikro-assert.log");
    }
    if (workspaceRoot) {
      this.simLogPath = path.join(workspaceRoot, ".mikro-sim.log");
    }
    this.parser = new AssertPromptParser((prompt) => {
      // When write assertions are disabled, suppress all write prompts from the UI.
      // Auto-reply when the prompt is ready; otherwise just swallow it silently
      // so CodeLens and panels never see write prompts.
      if (prompt && prompt.type === "write" && !this.allowWriteAsserts) {
        if (this.isWritePromptReady(prompt) && this.proc) {
          const fallback = prompt.value ?? "0x0";
          this.output.appendLine(`[SIM] Auto-reply write assert with ${fallback} (writes disabled)`);
          this.appendSimLog(`[SIM] Auto-reply write assert with ${fallback} (writes disabled)\n`);
          this.proc.stdin.write(`${fallback}\n`);
          this.onAssertResponseEmitter.fire({ prompt, response: fallback });
          this.prompt = null;
          this.parser.clear();
          this.onPromptEmitter.fire(null);
        }
        // Don't set as currentPrompt — write prompts are invisible when disabled
        return;
      }
      this.prompt = prompt;
      this.onPromptEmitter.fire(prompt);
    });
  }

  get currentPrompt(): AssertPrompt | null {
    return this.prompt;
  }

  get isRunning(): boolean {
    return this.proc !== null;
  }

  start(options: StartOptions): void {
    if (this.proc) {
      this.stop();
    }
    this.stopRequested = false;
    this.allowWriteAsserts = options.assertWrites;
    this.simStartMs = Date.now();
    this.lastIoMs = this.simStartMs;
    this.lastHeartbeatMs = 0;
    const workspaceRoot = getWorkspaceRoot();
    if (workspaceRoot) {
      this.assertLogPath = path.join(workspaceRoot, ".mikro-assert.log");
      this.simLogPath = path.join(workspaceRoot, ".mikro-sim.log");
    } else {
      this.assertLogPath = null;
      this.simLogPath = null;
    }
    if (options.assertMode === "enforce" && !options.assertFile) {
      vscode.window.showErrorMessage("assertMode=enforce requires an assertFile path.");
      return;
    }
    // If rv32simPath is already absolute and exists, use it directly
    this.output.appendLine(`[SIM] rv32simPath received: ${options.rv32simPath}`);
    this.output.appendLine(`[SIM] workspaceRoot: ${workspaceRoot}`);
    let rv32simPath: string;
    if (path.isAbsolute(options.rv32simPath) && fs.existsSync(options.rv32simPath)) {
      rv32simPath = options.rv32simPath;
      this.output.appendLine(`[SIM] Using absolute path: ${rv32simPath}`);
    } else {
      const resolved = resolvePath(options.rv32simPath, workspaceRoot);
      this.output.appendLine(`[SIM] Resolved to: ${resolved}`);
      if (!resolved) {
        vscode.window.showErrorMessage("rv32simPath is not set.");
        return;
      }
      rv32simPath = resolved;
    }
    if (rv32simPath.endsWith(".py") && !fs.existsSync(rv32simPath)) {
      vscode.window.showErrorMessage(`rv32sim.py not found at ${rv32simPath}`);
      this.output.appendLine(`[SIM] ERROR: File does not exist at ${rv32simPath}`);
      return;
    }

    const args: string[] = [];
    if (options.elfPath) {
      args.push(options.elfPath);
    }
    if (options.gdbPort !== undefined && options.gdbPort !== null) {
      args.push(`--port=${options.gdbPort}`);
    }
    if (options.svdPath) {
      args.push(`--svd=${options.svdPath}`);
    }
    if (options.gdbMmioReads) {
      args.push("--gdb-mmio-reads");
    }
    if (options.strictMode === false) {
      args.push("--permissive");
    } else if (options.strictMode === true) {
      args.push("--strict");
    }
    if (options.memRegions && options.memRegions.length) {
      for (const region of options.memRegions) {
        args.push(`--mem-region=${region}`);
      }
    }

    if (options.assertMode === "assist") {
      args.push("--assert-assist");
      if (options.assertFile) {
        args.push(`--assert=${options.assertFile}`);
        args.push(`--assert-out=${options.assertFile}`);
      }
    } else if (options.assertMode === "enforce") {
      if (options.assertFile) {
        args.push(`--assert=${options.assertFile}`);
      }
    }

    if (options.assertShowAsm) {
      args.push("--assert-asm");
    }
    if (options.assertVerbose) {
      args.push("--assert-verbose");
    }
    if (options.assertWrites && options.assertMode !== "none") {
      args.push("--assert-writes");
    }

    const commandIsPython = rv32simPath.endsWith(".py");
    const command = commandIsPython ? options.pythonPath : rv32simPath;
    const commandArgs = commandIsPython ? ["-u", rv32simPath, ...args] : args;

    this.output.appendLine(`[SIM] Starting: ${command} ${commandArgs.join(" ")}`);
    this.appendSimLog(`[SIM] Starting: ${command} ${commandArgs.join(" ")}`);

    if (!this.verifyRv32Sim(command, commandIsPython, rv32simPath)) {
      return;
    }

    if (this.assertLogPath && options.assertMode !== "none") {
      try {
        fs.closeSync(fs.openSync(this.assertLogPath, "a"));
      } catch {
        // ignore log failures
      }
    }
    if (this.assertLogPath && process.env.MIKRO_DEBUG_EXTENSIONS === "1") {
      try {
        fs.writeFileSync(this.assertLogPath, "");
      } catch {
        // ignore log failures
      }
    }

    this.proc = spawn(command, commandArgs, {
      cwd: workspaceRoot ?? process.cwd(),
      env: {
        ...process.env,
        PYTHONUNBUFFERED: "1",
        PYTHONIOENCODING: "utf-8",
      },
      stdio: "pipe",
    });
    this.output.appendLine(`[SIM] Spawned pid=${this.proc.pid ?? "unknown"}`);
    this.appendSimLog(`\n[SIM] Spawned pid=${this.proc.pid ?? "unknown"}\n`);
    this.installHealthTimer();

    this.proc.stdout.on("data", (data: Buffer) => {
      const text = data.toString();
      this.lastIoMs = Date.now();
      this.output.append(text);
      this.appendSimLog(text);
      this.logAssertChunk(text);
      this.parser.feed(text);
    });

    this.proc.stderr.on("data", (data: Buffer) => {
      const text = data.toString();
      this.lastIoMs = Date.now();
      this.output.append(text);
      this.appendSimLog(text);
      this.logAssertChunk(text);
      this.parser.feed(text);
    });

    this.proc.on("error", (err) => {
      this.output.appendLine(`[SIM] Failed to start: ${String(err)}`);
      this.appendSimLog(`[SIM] Failed to start: ${String(err)}`);
    });

    this.proc.on("close", (code, signal) => {
      this.output.appendLine(`[SIM] Closed code=${code ?? "unknown"} signal=${signal ?? "none"}`);
      this.appendSimLog(`[SIM] Closed code=${code ?? "unknown"} signal=${signal ?? "none"}\n`);
    });

    const spawnedProc = this.proc;
    this.proc.on("exit", (code, signal) => {
      const now = Date.now();
      const uptimeMs = this.simStartMs > 0 ? now - this.simStartMs : 0;
      const idleMs = this.lastIoMs > 0 ? now - this.lastIoMs : 0;
      this.output.appendLine(
        `\n[SIM] Exited code=${code ?? "unknown"} signal=${signal ?? "none"} requestedStop=${this.stopRequested} uptimeMs=${uptimeMs} idleMs=${idleMs}`
      );
      this.appendSimLog(
        `\n[SIM] Exited code=${code ?? "unknown"} signal=${signal ?? "none"} requestedStop=${this.stopRequested} uptimeMs=${uptimeMs} idleMs=${idleMs}\n`
      );
      this.clearHealthTimer();
      // Only clear state if this is still the active process (a new start() may have replaced it)
      if (this.proc === spawnedProc) {
        this.proc = null;
        this.prompt = null;
        this.onPromptEmitter.fire(null);
      }
    });
  }

  stop(): void {
    if (!this.proc) {
      return;
    }
    const proc = this.proc;
    this.proc = null;
    this.stopRequested = true;
    this.output.appendLine(`[SIM] Stop requested pid=${proc.pid ?? "unknown"}`);
    this.appendSimLog(`[SIM] Stop requested pid=${proc.pid ?? "unknown"}\n`);
    // Graceful shutdown
    try {
      proc.stdin.end();
      proc.kill("SIGTERM");
      // Force kill after timeout
      setTimeout(() => {
        if (proc && !proc.killed) {
          this.output.appendLine(`[SIM] Force kill pid=${proc.pid ?? "unknown"} with SIGKILL`);
          this.appendSimLog(`[SIM] Force kill pid=${proc.pid ?? "unknown"} with SIGKILL\n`);
          proc.kill("SIGKILL");
        }
      }, 1000);
    } catch {
      // ignore
    }
    this.clearHealthTimer();
    this.prompt = null;
    this.parser.clear();
    this.onPromptEmitter.fire(null);
    this.output.appendLine("[SIM] Stopped");
    this.appendSimLog("[SIM] Stopped");
  }

  dispose(): void {
    this.stop();
    this.onPromptEmitter.dispose();
    this.onAssertResponseEmitter.dispose();
  }

  sendAssertResponse(text: string): void {
    if (!this.proc) {
      vscode.window.showWarningMessage("rv32sim is not running.");
      return;
    }
    try {
      const prompt = this.prompt;
      const sanitized = this.sanitizeAssertInput(text);
      this.output.appendLine(
        `[SIM] Assert reply pid=${this.proc.pid ?? "unknown"} value="${sanitized || "<empty>"}"`
      );
      this.appendSimLog(`[SIM] Assert reply value="${sanitized || "<empty>"}"\n`);
      this.proc.stdin.write(`${sanitized}\n`);
      this.onAssertResponseEmitter.fire({ prompt, response: sanitized });
      if (this.prompt) {
        this.prompt = null;
        this.parser.clear();
        this.onPromptEmitter.fire(null);
      }
    } catch (err) {
      this.output.appendLine(`[SIM] Failed to send input: ${String(err)}`);
    }
  }

  sendDefaultAssertResponse(): void {
    const prompt = this.prompt;
    if (!prompt) {
      this.sendAssertResponse("");
      return;
    }
    const fallback = prompt.type === "write" ? prompt.value ?? "0x0" : prompt.reset ?? "";
    this.sendAssertResponse(fallback);
  }

  private isWritePromptReady(prompt: AssertPrompt): boolean {
    return prompt.rawLines.some(
      (line) => line.includes("[ASSERT] Write expect") || line.includes("[ASSERT] Value:")
    );
  }

  private verifyRv32Sim(command: string, commandIsPython: boolean, rv32simPath: string): boolean {
    const checkArgs = commandIsPython ? [rv32simPath, "--help"] : ["--help"];
    const result = spawnSync(command, checkArgs, {
      encoding: "utf8",
      timeout: 2000,
    });
    if (result.error) {
      const err = result.error as NodeJS.ErrnoException;
      const message = `[SIM] rv32sim preflight failed: ${String(err.message || err)}`;
      this.output.appendLine(message);
      this.appendSimLog(`${message}\n`);
      if (err.code === "ENOENT") {
        vscode.window.showErrorMessage(`rv32sim not found: ${command}`);
        return false;
      }
      if (err.code === "EACCES") {
        vscode.window.showErrorMessage(`rv32sim not executable: ${command}`);
        return false;
      }
      if (err.code === "ETIMEDOUT") {
        vscode.window.showWarningMessage("rv32sim preflight timed out; continuing anyway.");
        return true;
      }
      vscode.window.showWarningMessage(`rv32sim preflight warning: ${String(err.message || err)}`);
      return true;
    }
    if (result.status !== 0) {
      const stdout = result.stdout ? result.stdout.toString() : "";
      const stderr = result.stderr ? result.stderr.toString() : "";
      const msg = `[SIM] rv32sim preflight returned ${result.status}`;
      this.output.appendLine(msg);
      this.appendSimLog(`${msg}\n${stdout}${stderr}`);
    }
    return true;
  }

  private logAssertChunk(text: string): void {
    if (!this.assertLogPath) {
      return;
    }
    const result = extractAssertLines(this.assertLogBuffer, text);
    this.assertLogBuffer = result.buffer;
    for (const line of result.lines) {
      try {
        fs.appendFileSync(this.assertLogPath, `${line}\n`);
      } catch {
        // ignore log failures
      }
    }
  }

  resolveElfPath(configValue?: string): string | undefined {
    const workspaceRoot = getWorkspaceRoot();
    return resolvePath(configValue, workspaceRoot);
  }

  private appendSimLog(text: string): void {
    if (!this.simLogPath) {
      return;
    }
    try {
      fs.appendFileSync(this.simLogPath, text);
    } catch {
      // ignore log failures
    }
  }

  private sanitizeAssertInput(input: string): string {
    return sanitizeAssertValue(input);
  }

  private installHealthTimer(): void {
    this.clearHealthTimer();
    this.healthTimer = setInterval(() => {
      if (!this.proc) {
        return;
      }
      const now = Date.now();
      const idleMs = this.lastIoMs > 0 ? now - this.lastIoMs : 0;
      if (idleMs < 10000 && !this.prompt) {
        return;
      }
      if (now - this.lastHeartbeatMs < 10000) {
        return;
      }
      this.lastHeartbeatMs = now;
      const uptimeMs = this.simStartMs > 0 ? now - this.simStartMs : 0;
      const line = `[SIM] Heartbeat pid=${this.proc.pid ?? "unknown"} prompt=${this.prompt ? "yes" : "no"} idleMs=${idleMs} uptimeMs=${uptimeMs}`;
      this.output.appendLine(line);
      this.appendSimLog(`${line}\n`);
    }, 2000);
  }

  private clearHealthTimer(): void {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = undefined;
    }
  }
}
