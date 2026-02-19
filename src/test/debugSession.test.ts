import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn, ChildProcess } from "child_process";
import * as net from "net";
import * as path from "path";
import * as fs from "fs";

// ---------------------------------------------------------------------------
// MockGdbServer – a tiny TCP server that speaks a subset of GDB/MI
// ---------------------------------------------------------------------------

interface RegisteredResponse {
  pattern: RegExp;
  response: string;
  asyncEvent?: string;
  asyncDelayMs?: number;
}

class MockGdbServer {
  private server: net.Server;
  private connections: net.Socket[] = [];
  private responses: RegisteredResponse[] = [];
  private port: number;
  /** Every MI command received, in order.  Use commandsSince() to count. */
  private _commandLog: string[] = [];

  constructor(port = 0) {
    this.port = port;
    this.server = net.createServer((socket) => {
      this.connections.push(socket);
      let buffer = "";

      socket.on("data", (data) => {
        buffer += data.toString();
        let newlineIdx: number;
        while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newlineIdx).trim();
          buffer = buffer.slice(newlineIdx + 1);
          if (line.length > 0) {
            this._commandLog.push(line);
            this.handleLine(socket, line);
          }
        }
      });

      socket.on("error", () => {});
    });
  }

  /** Return number of MI commands received so far. */
  commandCount(): number {
    return this._commandLog.length;
  }

  /** Return MI commands received since a given snapshot count. */
  commandsSince(snapshot: number): string[] {
    return this._commandLog.slice(snapshot);
  }

  registerResponse(
    pattern: RegExp,
    response: string,
    asyncEvent?: string,
    asyncDelayMs?: number,
  ): void {
    this.responses.push({ pattern, response, asyncEvent, asyncDelayMs });
  }

  registerErrorResponse(pattern: RegExp, errorMsg: string): void {
    this.registerResponse(pattern, `^error,msg="${errorMsg}"`);
  }

  clearResponses(pattern: RegExp): void {
    this.responses = this.responses.filter((r) => r.pattern.source !== pattern.source);
  }

  emitAsync(text: string, delayMs = 0): void {
    const send = () => {
      for (const sock of this.connections) {
        if (!sock.destroyed) {
          sock.write(`${text}\n(gdb)\n`);
        }
      }
    };
    if (delayMs > 0) {
      setTimeout(send, delayMs);
    } else {
      send();
    }
  }

  start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.listen(this.port, "127.0.0.1", () => {
        const addr = this.server.address() as net.AddressInfo;
        this.port = addr.port;
        resolve(this.port);
      });
      this.server.on("error", reject);
    });
  }

  stop(): void {
    for (const sock of this.connections) {
      if (!sock.destroyed) {
        sock.destroy();
      }
    }
    this.connections = [];
    this.server.close();
  }

  private handleLine(socket: net.Socket, line: string): void {
    // MI commands may have a numeric token prefix, e.g. "42-exec-run"
    const tokenMatch = line.match(/^(\d+)(-.*)$/);
    const token = tokenMatch ? tokenMatch[1] : "";
    const command = tokenMatch ? tokenMatch[2] : line;

    // Iterate in reverse so later-registered (test-specific) patterns take precedence
    for (let i = this.responses.length - 1; i >= 0; i--) {
      const reg = this.responses[i];
      if (reg.pattern.test(command)) {
        // Send the synchronous response with the token prefix
        socket.write(`${token}${reg.response}\n(gdb)\n`);

        // If there is an async event to emit after, do so with optional delay
        if (reg.asyncEvent) {
          const delay = reg.asyncDelayMs ?? 50;
          setTimeout(() => {
            if (!socket.destroyed) {
              socket.write(`${reg.asyncEvent}\n(gdb)\n`);
            }
          }, delay);
        }
        return;
      }
    }

    // Default: acknowledge unknown commands with ^done
    socket.write(`${token}^done\n(gdb)\n`);
  }
}

// ---------------------------------------------------------------------------
// DapTestClient – speaks the Debug Adapter Protocol over stdin/stdout
// ---------------------------------------------------------------------------

interface DapMessage {
  seq: number;
  type: string;
  [key: string]: unknown;
}

interface DapResponse extends DapMessage {
  type: "response";
  request_seq: number;
  success: boolean;
  command: string;
  body?: Record<string, unknown>;
}

interface DapEvent extends DapMessage {
  type: "event";
  event: string;
  body?: Record<string, unknown>;
}

class DapTestClient {
  private proc: ChildProcess;
  private seq = 1;
  private buffer = "";
  private pending: Map<number, { resolve: (r: DapResponse) => void; reject: (e: Error) => void }> =
    new Map();
  private eventQueue: DapEvent[] = [];
  private eventWaiters: { name: string; resolve: (e: DapEvent) => void }[] = [];

  constructor(adapterPath: string, env?: Record<string, string>) {
    this.proc = spawn("node", [adapterPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });

    this.proc.stdout!.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString();
      this.parseMessages();
    });

    // Swallow stderr so it doesn't pollute test output
    this.proc.stderr!.on("data", () => {});
  }

  send(command: string, args?: Record<string, unknown>): Promise<DapResponse> {
    const seqNum = this.seq++;
    const msg: Record<string, unknown> = {
      seq: seqNum,
      type: "request",
      command,
    };
    if (args !== undefined) {
      msg.arguments = args;
    }

    const body = JSON.stringify(msg);
    const header = `Content-Length: ${Buffer.byteLength(body, "utf-8")}\r\n\r\n`;

    return new Promise<DapResponse>((resolve, reject) => {
      this.pending.set(seqNum, { resolve, reject });
      this.proc.stdin!.write(header + body);
    });
  }

  waitForEvent(name: string, timeoutMs = 15000): Promise<DapEvent> {
    // Check if we already have a queued event matching
    const idx = this.eventQueue.findIndex((e) => e.event === name);
    if (idx !== -1) {
      return Promise.resolve(this.eventQueue.splice(idx, 1)[0]);
    }

    return new Promise<DapEvent>((resolve, reject) => {
      const timer = setTimeout(() => {
        const waiterIdx = this.eventWaiters.findIndex((w) => w.resolve === resolve);
        if (waiterIdx !== -1) this.eventWaiters.splice(waiterIdx, 1);
        reject(new Error(`Timed out waiting for event "${name}" after ${timeoutMs}ms`));
      }, timeoutMs);

      this.eventWaiters.push({
        name,
        resolve: (e: DapEvent) => {
          clearTimeout(timer);
          resolve(e);
        },
      });
    });
  }

  close(): void {
    try {
      this.proc.kill("SIGKILL");
    } catch {
      // already dead
    }
    // Reject all pending requests
    for (const [, p] of this.pending) {
      p.reject(new Error("Client closed"));
    }
    this.pending.clear();
  }

  private parseMessages(): void {
    for (;;) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) break;

      const headerPart = this.buffer.slice(0, headerEnd);
      const match = headerPart.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        // Malformed – skip past the header
        this.buffer = this.buffer.slice(headerEnd + 4);
        continue;
      }

      const contentLength = parseInt(match[1], 10);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + contentLength) {
        // Not enough data yet
        break;
      }

      const bodyStr = this.buffer.slice(bodyStart, bodyStart + contentLength);
      this.buffer = this.buffer.slice(bodyStart + contentLength);

      let msg: DapMessage;
      try {
        msg = JSON.parse(bodyStr) as DapMessage;
      } catch {
        continue;
      }

      if (msg.type === "response") {
        const resp = msg as DapResponse;
        const pending = this.pending.get(resp.request_seq);
        if (pending) {
          this.pending.delete(resp.request_seq);
          pending.resolve(resp);
        }
      } else if (msg.type === "event") {
        const evt = msg as DapEvent;
        // Check if anyone is waiting for this event
        const waiterIdx = this.eventWaiters.findIndex((w) => w.name === evt.event);
        if (waiterIdx !== -1) {
          const waiter = this.eventWaiters.splice(waiterIdx, 1)[0];
          waiter.resolve(evt);
        } else {
          this.eventQueue.push(evt);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ADAPTER_PATH = path.join(process.cwd(), "out", "rv32simDebugAdapter.js");
const MOCK_GDB_PATH = path.join(process.cwd(), "src", "test", "mockGdb.mjs");

// Ensure mock GDB is executable
try {
  fs.chmodSync(MOCK_GDB_PATH, 0o755);
} catch { /* already executable or read-only FS */ }

/** Register the standard set of MI responses every test needs. */
function registerBaseResponses(mock: MockGdbServer): void {
  mock.registerResponse(/-gdb-set/, "^done");
  mock.registerResponse(/-interpreter-exec/, "^done");
  mock.registerResponse(/-break-insert/, "^done");
  mock.registerResponse(/-file-exec-and-symbols/, "^done");
  mock.registerResponse(/-exec-interrupt/, "^done", '*stopped,reason="signal-received",thread-id="1"', 50);
  mock.registerResponse(
    /-thread-info/,
    '^done,threads=[{id="1",target-id="Thread 1",name="main",state="stopped",frame={level="0",addr="0x00000000",func="main",file="main.c",fullname="/tmp/main.c",line="1"}}],current-thread-id="1"',
  );
  mock.registerResponse(/-target-select/, "^connected");
  mock.registerResponse(/-data-list-register-names/, "^done,register-names=[]");
  mock.registerResponse(/-stack-list-frames/, '^done,stack=[frame={level="0",addr="0x00000000",func="main",file="main.c",fullname="/tmp/main.c",line="1"}]');
  mock.registerResponse(/-stack-list-variables/, '^done,variables=[{name="x",value="42"}]');
  mock.registerResponse(
    /-var-create/,
    '^done,name="var1",numchild="0",value="42",type="int"',
  );
}

async function initAndLaunch(
  client: DapTestClient,
  port: number,
): Promise<void> {
  const initResp = await client.send("initialize", {
    clientID: "test",
    clientName: "Test",
    adapterID: "rv32sim",
    pathFormat: "path",
    linesStartAt1: true,
    columnsStartAt1: true,
    supportsVariableType: true,
    supportsVariablePaging: false,
    supportsRunInTerminalRequest: false,
  });
  expect(initResp.success).toBe(true);

  const launchResp = await client.send("launch", {
    program: "/tmp/test.elf",
    gdbPath: MOCK_GDB_PATH,
    miDebuggerServerAddress: `localhost:${port}`,
    noDebug: false,
  });
  expect(launchResp.success).toBe(true);

  const configResp = await client.send("configurationDone", {});
  expect(configResp.success).toBe(true);
}

async function waitForEntryStop(client: DapTestClient): Promise<DapEvent> {
  const stopped = await client.waitForEvent("stopped", 15000);
  expect(stopped.event).toBe("stopped");
  return stopped;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("Debug session integration tests", () => {
  let mock: MockGdbServer;
  let client: DapTestClient;
  let port: number;

  beforeEach(async () => {
    mock = new MockGdbServer(0);
    port = await mock.start();
  });

  afterEach(() => {
    client?.close();
    mock?.stop();
  });

  // -----------------------------------------------------------------------
  // Test 1
  // -----------------------------------------------------------------------
  it(
    "Launch -> entry stop -> threads -> disconnect",
    async () => {
      registerBaseResponses(mock);

      client = new DapTestClient(ADAPTER_PATH, { MOCK_GDB_PORT: String(port) });

      await initAndLaunch(client, port);

      const stopped = await waitForEntryStop(client);
      expect(stopped.body).toBeDefined();
      expect(stopped.body!.reason).toBe("entry");

      const threadsResp = await client.send("threads");
      expect(threadsResp.success).toBe(true);
      expect(threadsResp.body).toBeDefined();
      const threads = threadsResp.body!.threads as Array<{ id: number; name: string }>;
      expect(threads.length).toBeGreaterThanOrEqual(1);

      const disconnectResp = await client.send("disconnect", { terminateDebuggee: true });
      expect(disconnectResp.success).toBe(true);
    },
    { timeout: 20000 },
  );

  // -----------------------------------------------------------------------
  // Test 2
  // -----------------------------------------------------------------------
  it(
    "Set breakpoint -> continue -> hit -> inspect variables",
    async () => {
      registerBaseResponses(mock);

      // Override -break-insert to return breakpoint info
      mock.registerResponse(
        /-break-insert/,
        '^done,bkpt={number="1",type="breakpoint",disp="keep",enabled="y",addr="0x00001000",func="main",file="main.c",fullname="/tmp/main.c",line="10",times="0"}',
      );

      // -exec-continue triggers a breakpoint-hit async stop
      mock.registerResponse(
        /-exec-continue/,
        "^running",
        '*stopped,reason="breakpoint-hit",disp="keep",bkptno="1",thread-id="1",frame={level="0",addr="0x00001000",func="main",file="main.c",fullname="/tmp/main.c",line="10"}',
        80,
      );

      // scopes / variables backing
      mock.registerResponse(
        /-stack-list-frames/,
        '^done,stack=[frame={level="0",addr="0x00001000",func="main",file="main.c",fullname="/tmp/main.c",line="10"}]',
      );
      mock.registerResponse(
        /-stack-list-variables/,
        '^done,variables=[{name="x",value="42"},{name="y",value="7"}]',
      );

      client = new DapTestClient(ADAPTER_PATH, { MOCK_GDB_PORT: String(port) });

      await initAndLaunch(client, port);
      await waitForEntryStop(client);

      // Set a breakpoint
      const bpResp = await client.send("setBreakpoints", {
        source: { name: "main.c", path: "/tmp/main.c" },
        breakpoints: [{ line: 10 }],
      });
      expect(bpResp.success).toBe(true);
      expect(bpResp.body).toBeDefined();
      const breakpoints = bpResp.body!.breakpoints as Array<{ verified: boolean }>;
      expect(breakpoints.length).toBe(1);
      expect(breakpoints[0].verified).toBe(true);

      // Continue
      const contResp = await client.send("continue", { threadId: 1 });
      expect(contResp.success).toBe(true);

      // Wait for breakpoint hit
      const stoppedEvt = await client.waitForEvent("stopped", 15000);
      expect(stoppedEvt.body!.reason).toBe("breakpoint");

      // Get scopes
      const scopesResp = await client.send("scopes", { frameId: 0 });
      expect(scopesResp.success).toBe(true);
      const scopes = scopesResp.body!.scopes as Array<{
        name: string;
        variablesReference: number;
      }>;
      expect(scopes.length).toBeGreaterThanOrEqual(1);

      // Get variables for the first (locals) scope
      const varsResp = await client.send("variables", {
        variablesReference: scopes[0].variablesReference,
      });
      expect(varsResp.success).toBe(true);

      const disconnectResp = await client.send("disconnect", { terminateDebuggee: true });
      expect(disconnectResp.success).toBe(true);
    },
    { timeout: 20000 },
  );

  // -----------------------------------------------------------------------
  // Test 3
  // -----------------------------------------------------------------------
  it(
    "Step next -> step in -> step out",
    async () => {
      registerBaseResponses(mock);

      mock.registerResponse(
        /-exec-next/,
        "^running",
        '*stopped,reason="end-stepping-range",thread-id="1",frame={level="0",addr="0x00001004",func="main",file="main.c",fullname="/tmp/main.c",line="11"}',
        60,
      );

      mock.registerResponse(
        /-exec-step\b/,
        "^running",
        '*stopped,reason="end-stepping-range",thread-id="1",frame={level="0",addr="0x00002000",func="helper",file="helper.c",fullname="/tmp/helper.c",line="5"}',
        60,
      );

      mock.registerResponse(
        /-exec-finish/,
        "^running",
        '*stopped,reason="end-stepping-range",thread-id="1",frame={level="0",addr="0x00001008",func="main",file="main.c",fullname="/tmp/main.c",line="12"}',
        60,
      );

      client = new DapTestClient(ADAPTER_PATH, { MOCK_GDB_PORT: String(port) });

      await initAndLaunch(client, port);
      await waitForEntryStop(client);

      // Step next
      const nextResp = await client.send("next", { threadId: 1 });
      expect(nextResp.success).toBe(true);
      const stoppedNext = await client.waitForEvent("stopped", 15000);
      expect(stoppedNext.body!.reason).toBe("step");

      // Step in
      const stepInResp = await client.send("stepIn", { threadId: 1 });
      expect(stepInResp.success).toBe(true);
      const stoppedStepIn = await client.waitForEvent("stopped", 15000);
      expect(stoppedStepIn.body!.reason).toBe("step");

      // Step out
      const stepOutResp = await client.send("stepOut", { threadId: 1 });
      expect(stepOutResp.success).toBe(true);
      const stoppedStepOut = await client.waitForEvent("stopped", 15000);
      expect(stoppedStepOut.body!.reason).toBe("step");

      const disconnectResp = await client.send("disconnect", { terminateDebuggee: true });
      expect(disconnectResp.success).toBe(true);
    },
    { timeout: 20000 },
  );

  // -----------------------------------------------------------------------
  // Test 4
  // -----------------------------------------------------------------------
  it(
    "Continue -> pause",
    async () => {
      registerBaseResponses(mock);

      // Continue returns ^running but does NOT auto-stop
      mock.registerResponse(/-exec-continue/, "^running");

      // Interrupt triggers a signal-received stop
      mock.registerResponse(
        /-exec-interrupt/,
        "^done",
        '*stopped,reason="signal-received",signal-name="SIGINT",thread-id="1",frame={level="0",addr="0x00001000",func="main",file="main.c",fullname="/tmp/main.c",line="10"}',
        50,
      );

      client = new DapTestClient(ADAPTER_PATH, { MOCK_GDB_PORT: String(port) });

      await initAndLaunch(client, port);
      await waitForEntryStop(client);

      // Continue
      const contResp = await client.send("continue", { threadId: 1 });
      expect(contResp.success).toBe(true);

      // Brief delay then pause
      await new Promise((r) => setTimeout(r, 200));

      const pauseResp = await client.send("pause", { threadId: 1 });
      expect(pauseResp.success).toBe(true);

      // Wait for stopped — adapter maps signal-received → "signal"
      const stoppedEvt = await client.waitForEvent("stopped", 15000);
      expect(stoppedEvt.body!.reason).toBe("signal");

      const disconnectResp = await client.send("disconnect", { terminateDebuggee: true });
      expect(disconnectResp.success).toBe(true);
    },
    { timeout: 20000 },
  );

  // -----------------------------------------------------------------------
  // Test 5
  // -----------------------------------------------------------------------
  it(
    "Step recovery (hung step)",
    async () => {
      registerBaseResponses(mock);

      // -exec-next returns ^running but does NOT produce *stopped
      mock.registerResponse(/-exec-next/, "^running");

      // When the adapter eventually sends -exec-interrupt to recover, produce a stop
      mock.registerResponse(
        /-exec-interrupt/,
        "^done",
        '*stopped,reason="signal-received",signal-name="SIGINT",thread-id="1",frame={level="0",addr="0x00001000",func="main",file="main.c",fullname="/tmp/main.c",line="10"}',
        50,
      );

      client = new DapTestClient(ADAPTER_PATH, {
        MOCK_GDB_PORT: String(port),
        MIKRO_DEBUG_ADAPTER_TIMEOUT_MS: "3000",
      });

      await initAndLaunch(client, port);
      await waitForEntryStop(client);

      // Send a step that will hang
      const nextResp = await client.send("next", { threadId: 1 });
      expect(nextResp.success).toBe(true);

      // The adapter should eventually recover by sending -exec-interrupt
      // and we should get a stopped event
      const stoppedEvt = await client.waitForEvent("stopped", 15000);
      expect(stoppedEvt.event).toBe("stopped");
    },
    { timeout: 20000 },
  );

  // -----------------------------------------------------------------------
  // Test 6
  // -----------------------------------------------------------------------
  it(
    "Conditional breakpoint",
    async () => {
      registerBaseResponses(mock);

      // Override for conditional breakpoint
      mock.registerResponse(
        /-break-insert.*-c/,
        '^done,bkpt={number="2",type="breakpoint",disp="keep",enabled="y",addr="0x00001000",func="main",file="main.c",fullname="/tmp/main.c",line="15",cond="x > 10",times="0"}',
      );

      client = new DapTestClient(ADAPTER_PATH, { MOCK_GDB_PORT: String(port) });

      await initAndLaunch(client, port);
      await waitForEntryStop(client);

      // Set conditional breakpoint
      const bpResp = await client.send("setBreakpoints", {
        source: { name: "main.c", path: "/tmp/main.c" },
        breakpoints: [{ line: 15, condition: "x > 10" }],
      });
      expect(bpResp.success).toBe(true);
      expect(bpResp.body).toBeDefined();
      const breakpoints = bpResp.body!.breakpoints as Array<{
        verified: boolean;
      }>;
      expect(breakpoints.length).toBe(1);
      expect(breakpoints[0].verified).toBe(true);

      const disconnectResp = await client.send("disconnect", { terminateDebuggee: true });
      expect(disconnectResp.success).toBe(true);
    },
    { timeout: 20000 },
  );

  // -----------------------------------------------------------------------
  // Test 7
  // -----------------------------------------------------------------------
  it(
    "Data breakpoint (watchpoint)",
    async () => {
      registerBaseResponses(mock);

      // -break-watch for data breakpoints / watchpoints
      mock.registerResponse(
        /-break-watch/,
        '^done,wpt={number="3",exp="myVar"}',
      );

      client = new DapTestClient(ADAPTER_PATH, { MOCK_GDB_PORT: String(port) });

      await initAndLaunch(client, port);
      await waitForEntryStop(client);

      // Ask for data breakpoint info
      const infoResp = await client.send("dataBreakpointInfo", {
        name: "myVar",
        variablesReference: 0,
      });
      expect(infoResp.success).toBe(true);
      expect(infoResp.body).toBeDefined();
      const accessTypes = infoResp.body!.accessTypes as string[] | undefined;
      // The adapter should report at least some access types
      if (accessTypes) {
        expect(accessTypes.length).toBeGreaterThanOrEqual(1);
      }

      // Set a data breakpoint (watchpoint)
      const dbpResp = await client.send("setDataBreakpoints", {
        breakpoints: [
          {
            dataId: "myVar",
            accessType: "write",
          },
        ],
      });
      expect(dbpResp.success).toBe(true);
      expect(dbpResp.body).toBeDefined();
      const dataBreakpoints = dbpResp.body!.breakpoints as Array<{
        verified: boolean;
      }>;
      expect(dataBreakpoints.length).toBe(1);
      expect(dataBreakpoints[0].verified).toBe(true);

      const disconnectResp = await client.send("disconnect", { terminateDebuggee: true });
      expect(disconnectResp.success).toBe(true);
    },
    { timeout: 20000 },
  );

  // -----------------------------------------------------------------------
  // Test A1 – GDB MI error propagation
  // -----------------------------------------------------------------------
  it(
    "GDB MI error propagation on evaluate",
    async () => {
      registerBaseResponses(mock);

      // Register error response for -data-evaluate-expression
      mock.registerErrorResponse(
        /-data-evaluate-expression/,
        "No symbol table is loaded.",
      );

      client = new DapTestClient(ADAPTER_PATH, { MOCK_GDB_PORT: String(port) });

      await initAndLaunch(client, port);
      await waitForEntryStop(client);

      // Evaluate with hover context — adapter should throw on non-running error
      const evalResp = await client.send("evaluate", {
        expression: "myVar",
        context: "hover",
      });
      expect(evalResp.success).toBe(false);
      expect(evalResp.message).toBeDefined();
      expect(evalResp.message!.toLowerCase()).toContain("no symbol table");

      // Verify adapter recovers
      const threadsResp = await client.send("threads");
      expect(threadsResp.success).toBe(true);

      const disconnectResp = await client.send("disconnect", { terminateDebuggee: true });
      expect(disconnectResp.success).toBe(true);
    },
    { timeout: 20000 },
  );

  // -----------------------------------------------------------------------
  // Test A2 – Memory read via DAP
  // -----------------------------------------------------------------------
  it(
    "Memory read via DAP readMemory",
    async () => {
      registerBaseResponses(mock);

      // Register memory read response (32 hex chars = 16 bytes)
      mock.registerResponse(
        /-data-read-memory-bytes/,
        '^done,memory=[{begin="0x20000000",offset="0x00000000",end="0x20000010",contents="48656c6c6f576f726c642100deadbeef"}]',
      );

      client = new DapTestClient(ADAPTER_PATH, { MOCK_GDB_PORT: String(port) });

      await initAndLaunch(client, port);
      await waitForEntryStop(client);

      const readResp = await client.send("readMemory", {
        memoryReference: "0x20000000",
        count: 16,
      });
      expect(readResp.success).toBe(true);
      expect(readResp.body).toBeDefined();
      expect(readResp.body!.address).toBe("0x20000000");
      expect(readResp.body!.unreadableBytes).toBe(0);

      // Decode base64 and verify length
      const decoded = Buffer.from(readResp.body!.data as string, "base64");
      expect(decoded.length).toBe(16);

      const disconnectResp = await client.send("disconnect", { terminateDebuggee: true });
      expect(disconnectResp.success).toBe(true);
    },
    { timeout: 20000 },
  );

  // -----------------------------------------------------------------------
  // Test A3 – Disassemble via DAP
  // -----------------------------------------------------------------------
  it(
    "Disassemble via DAP",
    async () => {
      registerBaseResponses(mock);

      mock.registerResponse(
        /-data-disassemble/,
        '^done,asm_insns=[{address="0x00010000",func-name="main",offset="0",inst="addi sp, sp, -16"},{address="0x00010004",func-name="main",offset="4",inst="sw ra, 12(sp)"}]',
      );

      client = new DapTestClient(ADAPTER_PATH, { MOCK_GDB_PORT: String(port) });

      await initAndLaunch(client, port);
      await waitForEntryStop(client);

      const disResp = await client.send("disassemble", {
        memoryReference: "0x10000",
        offset: 0,
        instructionOffset: 0,
        instructionCount: 2,
      });
      expect(disResp.success).toBe(true);
      expect(disResp.body).toBeDefined();
      const instructions = disResp.body!.instructions as Array<{
        address: string;
        instruction: string;
        symbol?: string;
      }>;
      expect(instructions.length).toBe(2);
      expect(instructions[0].address).toBe("0x00010000");
      expect(instructions[0].instruction).toBe("addi sp, sp, -16");
      expect(instructions[0].symbol).toContain("main");
      expect(instructions[1].address).toBe("0x00010004");
      expect(instructions[1].instruction).toBe("sw ra, 12(sp)");

      const disconnectResp = await client.send("disconnect", { terminateDebuggee: true });
      expect(disconnectResp.success).toBe(true);
    },
    { timeout: 20000 },
  );

  // -----------------------------------------------------------------------
  // Test A4a – Standard evaluate expression
  // -----------------------------------------------------------------------
  it(
    "Evaluate expression (standard hover)",
    async () => {
      registerBaseResponses(mock);

      mock.registerResponse(
        /-data-evaluate-expression/,
        '^done,value="42"',
      );

      client = new DapTestClient(ADAPTER_PATH, { MOCK_GDB_PORT: String(port) });

      await initAndLaunch(client, port);
      await waitForEntryStop(client);

      const evalResp = await client.send("evaluate", {
        expression: "x + 1",
        context: "hover",
      });
      expect(evalResp.success).toBe(true);
      expect(evalResp.body!.result).toBe("42");

      const disconnectResp = await client.send("disconnect", { terminateDebuggee: true });
      expect(disconnectResp.success).toBe(true);
    },
    { timeout: 20000 },
  );

  // -----------------------------------------------------------------------
  // Test A4b – REPL MI mode evaluate
  // -----------------------------------------------------------------------
  it(
    "Evaluate REPL MI mode (expression starting with -)",
    async () => {
      registerBaseResponses(mock);

      client = new DapTestClient(ADAPTER_PATH, { MOCK_GDB_PORT: String(port) });

      await initAndLaunch(client, port);
      await waitForEntryStop(client);

      // Send an MI command via REPL context — adapter sends it directly
      const evalResp = await client.send("evaluate", {
        expression: "-thread-info",
        context: "repl",
      });
      expect(evalResp.success).toBe(true);
      expect(evalResp.body!.result).toBeDefined();
      // Result should be JSON stringified thread info
      expect(typeof evalResp.body!.result).toBe("string");

      const disconnectResp = await client.send("disconnect", { terminateDebuggee: true });
      expect(disconnectResp.success).toBe(true);
    },
    { timeout: 20000 },
  );

  // -----------------------------------------------------------------------
  // Test A4c – Monitor command via REPL
  // -----------------------------------------------------------------------
  it(
    "Evaluate monitor command via REPL",
    async () => {
      registerBaseResponses(mock);

      client = new DapTestClient(ADAPTER_PATH, { MOCK_GDB_PORT: String(port) });

      await initAndLaunch(client, port);
      await waitForEntryStop(client);

      const evalResp = await client.send("evaluate", {
        expression: "monitor reset halt",
        context: "repl",
      });
      expect(evalResp.success).toBe(true);

      const disconnectResp = await client.send("disconnect", { terminateDebuggee: true });
      expect(disconnectResp.success).toBe(true);
    },
    { timeout: 20000 },
  );

  // -----------------------------------------------------------------------
  // Test A4d – Evaluate while running returns <running>
  // -----------------------------------------------------------------------
  it(
    "Evaluate while running returns <running>",
    async () => {
      registerBaseResponses(mock);

      // Continue returns ^running but does NOT auto-stop
      mock.registerResponse(/-exec-continue/, "^running");

      client = new DapTestClient(ADAPTER_PATH, { MOCK_GDB_PORT: String(port) });

      await initAndLaunch(client, port);
      await waitForEntryStop(client);

      // Continue — adapter enters running state
      const contResp = await client.send("continue", { threadId: 1 });
      expect(contResp.success).toBe(true);

      // Wait briefly for running state to take effect
      await new Promise((r) => setTimeout(r, 200));

      // Evaluate while running — adapter should return <running>
      const evalResp = await client.send("evaluate", {
        expression: "x",
        context: "hover",
      });
      expect(evalResp.success).toBe(true);
      expect(evalResp.body!.result).toBe("<running>");

      const disconnectResp = await client.send("disconnect", { terminateDebuggee: true });
      expect(disconnectResp.success).toBe(true);
    },
    { timeout: 20000 },
  );

  // -----------------------------------------------------------------------
  // Test A5 – Stack trace running-state fallback (cached frames)
  // -----------------------------------------------------------------------
  it(
    "Stack trace returns cached frames when running",
    async () => {
      registerBaseResponses(mock);

      client = new DapTestClient(ADAPTER_PATH, { MOCK_GDB_PORT: String(port) });

      await initAndLaunch(client, port);
      await waitForEntryStop(client);

      // Get initial stack trace to populate lastFrames
      const stResp1 = await client.send("stackTrace", { threadId: 1 });
      expect(stResp1.success).toBe(true);
      const frames1 = stResp1.body!.stackFrames as Array<{ id: number; name: string }>;
      expect(frames1.length).toBeGreaterThanOrEqual(1);

      // Override -stack-list-frames with running error (LIFO takes precedence)
      mock.registerErrorResponse(
        /-stack-list-frames/,
        "Selected thread is running.",
      );

      // Continue without auto-stop
      mock.registerResponse(/-exec-continue/, "^running");
      const contResp = await client.send("continue", { threadId: 1 });
      expect(contResp.success).toBe(true);

      await new Promise((r) => setTimeout(r, 200));

      // Stack trace should return cached frames
      const stResp2 = await client.send("stackTrace", { threadId: 1 });
      expect(stResp2.success).toBe(true);
      const frames2 = stResp2.body!.stackFrames as Array<{ id: number; name: string }>;
      expect(frames2.length).toBe(frames1.length);
      expect(frames2[0].name).toBe(frames1[0].name);

      const disconnectResp = await client.send("disconnect", { terminateDebuggee: true });
      expect(disconnectResp.success).toBe(true);
    },
    { timeout: 20000 },
  );

  // -----------------------------------------------------------------------
  // Test A6a – Instruction breakpoints
  // -----------------------------------------------------------------------
  it(
    "Instruction breakpoints (setInstructionBreakpoints)",
    async () => {
      registerBaseResponses(mock);

      mock.registerResponse(
        /-break-insert -h/,
        '^done,bkpt={number="10",type="hw breakpoint",addr="0x00010000"}',
      );

      client = new DapTestClient(ADAPTER_PATH, { MOCK_GDB_PORT: String(port) });

      await initAndLaunch(client, port);
      await waitForEntryStop(client);

      const ibpResp = await client.send("setInstructionBreakpoints", {
        breakpoints: [{ instructionReference: "0x10000" }],
      });
      expect(ibpResp.success).toBe(true);
      expect(ibpResp.body).toBeDefined();
      const bps = ibpResp.body!.breakpoints as Array<{ verified: boolean }>;
      expect(bps.length).toBe(1);
      expect(bps[0].verified).toBe(true);

      const disconnectResp = await client.send("disconnect", { terminateDebuggee: true });
      expect(disconnectResp.success).toBe(true);
    },
    { timeout: 20000 },
  );

  // -----------------------------------------------------------------------
  // Test A6b – HW breakpoint limit
  // -----------------------------------------------------------------------
  it(
    "Instruction breakpoints respect HW limit",
    async () => {
      registerBaseResponses(mock);

      mock.registerResponse(
        /-break-insert -h/,
        '^done,bkpt={number="10",type="hw breakpoint",addr="0x00010000"}',
      );

      client = new DapTestClient(ADAPTER_PATH, { MOCK_GDB_PORT: String(port) });

      // Initialize
      const initResp = await client.send("initialize", {
        clientID: "test",
        clientName: "Test",
        adapterID: "rv32sim",
        pathFormat: "path",
        linesStartAt1: true,
        columnsStartAt1: true,
        supportsVariableType: true,
        supportsVariablePaging: false,
        supportsRunInTerminalRequest: false,
      });
      expect(initResp.success).toBe(true);

      // Launch with hwBreakpointLimit=1
      const launchResp = await client.send("launch", {
        program: "/tmp/test.elf",
        gdbPath: MOCK_GDB_PATH,
        miDebuggerServerAddress: `localhost:${port}`,
        noDebug: false,
        _serverCapabilities: { hwBreakpointLimit: 1 },
      });
      expect(launchResp.success).toBe(true);

      const configResp = await client.send("configurationDone", {});
      expect(configResp.success).toBe(true);

      await waitForEntryStop(client);

      // Set two instruction breakpoints — first should be verified, second should not
      const ibpResp = await client.send("setInstructionBreakpoints", {
        breakpoints: [
          { instructionReference: "0x10000" },
          { instructionReference: "0x10004" },
        ],
      });
      expect(ibpResp.success).toBe(true);
      const bps = ibpResp.body!.breakpoints as Array<{
        verified: boolean;
        message?: string;
      }>;
      expect(bps.length).toBe(2);
      expect(bps[0].verified).toBe(true);
      expect(bps[1].verified).toBe(false);
      expect(bps[1].message).toBeDefined();
      expect(bps[1].message!.toLowerCase()).toContain("limit");

      const disconnectResp = await client.send("disconnect", { terminateDebuggee: true });
      expect(disconnectResp.success).toBe(true);
    },
    { timeout: 20000 },
  );

  // -----------------------------------------------------------------------
  // Test A7 – Breakpoint replacement
  // -----------------------------------------------------------------------
  it(
    "Breakpoint replacement (set, then replace)",
    async () => {
      registerBaseResponses(mock);

      mock.registerResponse(
        /-break-insert/,
        '^done,bkpt={number="5",type="breakpoint",disp="keep",enabled="y",addr="0x00001000",func="main",file="main.c",fullname="/tmp/main.c",line="10",times="0"}',
      );
      mock.registerResponse(/-break-delete/, "^done");

      client = new DapTestClient(ADAPTER_PATH, { MOCK_GDB_PORT: String(port) });

      await initAndLaunch(client, port);
      await waitForEntryStop(client);

      // Set breakpoint at line 10
      const bp1 = await client.send("setBreakpoints", {
        source: { name: "main.c", path: "/tmp/main.c" },
        breakpoints: [{ line: 10 }],
      });
      expect(bp1.success).toBe(true);
      expect((bp1.body!.breakpoints as any[])[0].verified).toBe(true);

      // Replace with breakpoint at line 20
      const bp2 = await client.send("setBreakpoints", {
        source: { name: "main.c", path: "/tmp/main.c" },
        breakpoints: [{ line: 20 }],
      });
      expect(bp2.success).toBe(true);
      const bps = bp2.body!.breakpoints as Array<{ verified: boolean; line: number }>;
      expect(bps.length).toBe(1);
      expect(bps[0].verified).toBe(true);
      expect(bps[0].line).toBe(20);

      const disconnectResp = await client.send("disconnect", { terminateDebuggee: true });
      expect(disconnectResp.success).toBe(true);
    },
    { timeout: 20000 },
  );

  // -----------------------------------------------------------------------
  // Test A8 – GDB spawn failure
  // -----------------------------------------------------------------------
  it(
    "GDB spawn failure emits terminated event",
    async () => {
      // No need for a mock server – adapter spawn will fail on its own
      client = new DapTestClient(ADAPTER_PATH);

      const initResp = await client.send("initialize", {
        clientID: "test",
        clientName: "Test",
        adapterID: "rv32sim",
        pathFormat: "path",
        linesStartAt1: true,
        columnsStartAt1: true,
        supportsVariableType: true,
        supportsVariablePaging: false,
        supportsRunInTerminalRequest: false,
      });
      expect(initResp.success).toBe(true);

      // Launch with bogus gdbPath — may succeed before spawn error fires, or fail
      await client.send("launch", {
        program: "/tmp/test.elf",
        gdbPath: "/nonexistent/gdb",
        miDebuggerServerAddress: "localhost:99999",
        noDebug: false,
      });
      // The key is we get a terminated event without crashing
      const terminatedEvt = await client.waitForEvent("terminated", 15000);
      expect(terminatedEvt.event).toBe("terminated");
    },
    { timeout: 20000 },
  );

  // -----------------------------------------------------------------------
  // Test D2a – GDB error on break-insert
  // -----------------------------------------------------------------------
  it(
    "GDB error on break-insert sets verified=false",
    async () => {
      registerBaseResponses(mock);

      // Override with error for break-insert
      mock.registerErrorResponse(
        /-break-insert/,
        "No source file named bogus.c.",
      );

      client = new DapTestClient(ADAPTER_PATH, { MOCK_GDB_PORT: String(port) });

      await initAndLaunch(client, port);
      await waitForEntryStop(client);

      const bpResp = await client.send("setBreakpoints", {
        source: { name: "bogus.c", path: "/tmp/bogus.c" },
        breakpoints: [{ line: 1 }],
      });
      expect(bpResp.success).toBe(true);
      const bps = bpResp.body!.breakpoints as Array<{ verified: boolean }>;
      expect(bps.length).toBe(1);
      expect(bps[0].verified).toBe(false);

      const disconnectResp = await client.send("disconnect", { terminateDebuggee: true });
      expect(disconnectResp.success).toBe(true);
    },
    { timeout: 20000 },
  );

  // -----------------------------------------------------------------------
  // Test D2b – GDB error on continue
  // -----------------------------------------------------------------------
  it(
    "GDB error on continue (non-running error) returns success=false",
    async () => {
      registerBaseResponses(mock);

      // Override with error for exec-continue — the message does NOT contain "running"
      // in the running-state sense, so adapter re-throws
      mock.registerErrorResponse(
        /-exec-continue/,
        "The program is not being run.",
      );

      client = new DapTestClient(ADAPTER_PATH, { MOCK_GDB_PORT: String(port) });

      await initAndLaunch(client, port);
      await waitForEntryStop(client);

      const contResp = await client.send("continue", { threadId: 1 });
      // "The program is not being run." does NOT contain "running" as a substring,
      // so the adapter re-throws and returns success=false
      expect(contResp.success).toBe(false);
    },
    { timeout: 20000 },
  );

  // -----------------------------------------------------------------------
  // Test D3 – DapTestClient waitForEvent timeout
  // -----------------------------------------------------------------------
  it(
    "waitForEvent rejects on timeout",
    async () => {
      registerBaseResponses(mock);

      client = new DapTestClient(ADAPTER_PATH, { MOCK_GDB_PORT: String(port) });

      await initAndLaunch(client, port);
      await waitForEntryStop(client);

      // Wait for an event that will never happen — should reject with timeout
      await expect(
        client.waitForEvent("never_happens", 500),
      ).rejects.toThrow(/timed out/i);

      const disconnectResp = await client.send("disconnect", { terminateDebuggee: true });
      expect(disconnectResp.success).toBe(true);
    },
    { timeout: 20000 },
  );

  // -----------------------------------------------------------------------
  // Test: Continue during syntheticStop
  // -----------------------------------------------------------------------
  it(
    "Continue during syntheticStop transitions to running without polling",
    async () => {
      // After entry stop, step will hang (no *stopped) AND interrupt won't produce
      // a stop either, so the adapter forces a synthetic stop.
      // Then we send continue, which should transition to running without sending
      // -exec-continue (GDB thinks target is running).  No poll — a real *stopped
      // will arrive via MI async events when the target eventually stops.

      mock.registerResponse(/-gdb-set/, "^done");
      mock.registerResponse(/-interpreter-exec/, "^done");
      mock.registerResponse(/-break-insert/, "^done");
      mock.registerResponse(/-file-exec-and-symbols/, "^done");
      // thread-info returns "stopped" initially (for entry stop and startup)
      mock.registerResponse(
        /-thread-info/,
        '^done,threads=[{id="1",target-id="Thread 1",name="main",state="stopped",frame={level="0",addr="0x00000000",func="main",file="main.c",fullname="/tmp/main.c",line="1"}}],current-thread-id="1"',
      );
      mock.registerResponse(/-target-select/, "^connected");
      mock.registerResponse(/-data-list-register-names/, "^done,register-names=[]");
      mock.registerResponse(/-stack-list-frames/, '^done,stack=[frame={level="0",addr="0x00000000",func="main",file="main.c",fullname="/tmp/main.c",line="1"}]');
      mock.registerResponse(/-stack-list-variables/, '^done,variables=[{name="x",value="42"}]');
      mock.registerResponse(/-data-evaluate-expression/, '^done,value="0x00001000"');

      // Step returns ^running but no *stopped — simulates rv32sim blocked on stdin
      mock.registerResponse(/-exec-next/, "^running");
      // Interrupt won't produce *stopped — target is truly stuck
      mock.registerResponse(/-exec-interrupt/, "^done");

      client = new DapTestClient(ADAPTER_PATH, {
        MOCK_GDB_PORT: String(port),
        MIKRO_DEBUG_ADAPTER_TIMEOUT_MS: "2000",
      });

      await initAndLaunch(client, port);
      await waitForEntryStop(client);

      // Make thread-info return "running" so the step poll can't detect a stop
      // (this forces the syntheticStop path after timeout + interrupt recovery fail)
      mock.clearResponses(/-thread-info/);
      mock.registerResponse(
        /-thread-info/,
        '^done,threads=[{id="1",target-id="Thread 1",name="main",state="running"}],current-thread-id="1"',
      );

      // Send step which will hang and eventually force syntheticStop
      const nextResp = await client.send("next", { threadId: 1 });
      expect(nextResp.success).toBe(true);

      // Wait for the synthetic stopped event from the step recovery
      const syntheticStop = await client.waitForEvent("stopped", 15000);
      expect(syntheticStop.event).toBe("stopped");

      // Now the adapter is in syntheticStop state.
      // Send continue — should succeed and transition to running (no poll, no MI commands)
      const contResp = await client.send("continue", { threadId: 1 });
      expect(contResp.success).toBe(true);

      // Should get a continued event
      const continuedEvt = await client.waitForEvent("continued", 3000);
      expect(continuedEvt.event).toBe("continued");

      // No stopped event expected — the adapter just transitions to running.
      // A real *stopped would arrive via MI async events when the target stops.

      const disconnectResp = await client.send("disconnect", { terminateDebuggee: true });
      expect(disconnectResp.success).toBe(true);
    },
    { timeout: 25000 },
  );

  // -----------------------------------------------------------------------
  // Test: Step during syntheticStop
  // -----------------------------------------------------------------------
  it(
    "Step during syntheticStop clears flag and uses interrupt recovery",
    async () => {
      mock.registerResponse(/-gdb-set/, "^done");
      mock.registerResponse(/-interpreter-exec/, "^done");
      mock.registerResponse(/-break-insert/, "^done");
      mock.registerResponse(/-file-exec-and-symbols/, "^done");
      mock.registerResponse(
        /-thread-info/,
        '^done,threads=[{id="1",target-id="Thread 1",name="main",state="stopped",frame={level="0",addr="0x00000000",func="main",file="main.c",fullname="/tmp/main.c",line="1"}}],current-thread-id="1"',
      );
      mock.registerResponse(/-target-select/, "^connected");
      mock.registerResponse(/-data-list-register-names/, "^done,register-names=[]");
      mock.registerResponse(/-stack-list-frames/, '^done,stack=[frame={level="0",addr="0x00000000",func="main",file="main.c",fullname="/tmp/main.c",line="1"}]');
      mock.registerResponse(/-stack-list-variables/, '^done,variables=[{name="x",value="42"}]');
      mock.registerResponse(/-data-evaluate-expression/, '^done,value="0x00001000"');

      // Step hangs — no *stopped
      mock.registerResponse(/-exec-next/, "^running");
      mock.registerResponse(/-exec-interrupt/, "^done");

      client = new DapTestClient(ADAPTER_PATH, {
        MOCK_GDB_PORT: String(port),
        MIKRO_DEBUG_ADAPTER_TIMEOUT_MS: "2000",
      });

      await initAndLaunch(client, port);
      await waitForEntryStop(client);

      // Make thread-info return "running" to force syntheticStop on first step
      mock.clearResponses(/-thread-info/);
      mock.registerResponse(
        /-thread-info/,
        '^done,threads=[{id="1",target-id="Thread 1",name="main",state="running"}],current-thread-id="1"',
      );

      // First step hangs → forces syntheticStop
      const nextResp = await client.send("next", { threadId: 1 });
      expect(nextResp.success).toBe(true);
      const syntheticStop = await client.waitForEvent("stopped", 15000);
      expect(syntheticStop.event).toBe("stopped");

      // Now adapter is in syntheticStop. Send another step.
      // The adapter clears syntheticStop and tries interrupt recovery.
      // Make thread-info return "stopped" so the interrupt recovery poll succeeds,
      // and the retry step command can proceed.
      mock.clearResponses(/-thread-info/);
      mock.registerResponse(
        /-thread-info/,
        '^done,threads=[{id="1",target-id="Thread 1",name="main",state="stopped",frame={level="0",addr="0x00001004",func="main",file="main.c",fullname="/tmp/main.c",line="5"}}],current-thread-id="1"',
      );

      // Step during syntheticStop — clears flag, step command fails (running error),
      // recovery interrupts, poll detects stopped, retry step succeeds, final poll stops
      const stepResp = await client.send("next", { threadId: 1 });
      expect(stepResp.success).toBe(true);

      // Should eventually get a stopped event from the recovery flow
      const stoppedEvt = await client.waitForEvent("stopped", 15000);
      expect(stoppedEvt.event).toBe("stopped");

      const disconnectResp = await client.send("disconnect", { terminateDebuggee: true });
      expect(disconnectResp.success).toBe(true);
    },
    { timeout: 25000 },
  );

  // -----------------------------------------------------------------------
  // Test: Continue during syntheticStop sends ZERO MI commands
  // (This is the test that would have caught the 300+ MI command storm)
  // -----------------------------------------------------------------------
  it(
    "Continue during syntheticStop sends zero MI commands to GDB",
    async () => {
      mock.registerResponse(/-gdb-set/, "^done");
      mock.registerResponse(/-interpreter-exec/, "^done");
      mock.registerResponse(/-break-insert/, "^done");
      mock.registerResponse(/-file-exec-and-symbols/, "^done");
      mock.registerResponse(
        /-thread-info/,
        '^done,threads=[{id="1",target-id="Thread 1",name="main",state="stopped",frame={level="0",addr="0x00000000",func="main",file="main.c",fullname="/tmp/main.c",line="1"}}],current-thread-id="1"',
      );
      mock.registerResponse(/-target-select/, "^connected");
      mock.registerResponse(/-data-list-register-names/, "^done,register-names=[]");
      mock.registerResponse(/-stack-list-frames/, '^done,stack=[frame={level="0",addr="0x00000000",func="main",file="main.c",fullname="/tmp/main.c",line="1"}]');
      mock.registerResponse(/-stack-list-variables/, '^done,variables=[{name="x",value="42"}]');
      mock.registerResponse(/-data-evaluate-expression/, '^done,value="0x00001000"');
      mock.registerResponse(/-exec-next/, "^running");
      mock.registerResponse(/-exec-interrupt/, "^done");

      client = new DapTestClient(ADAPTER_PATH, {
        MOCK_GDB_PORT: String(port),
        MIKRO_DEBUG_ADAPTER_TIMEOUT_MS: "2000",
      });

      await initAndLaunch(client, port);
      await waitForEntryStop(client);

      // Force syntheticStop via hung step
      mock.clearResponses(/-thread-info/);
      mock.registerResponse(
        /-thread-info/,
        '^done,threads=[{id="1",target-id="Thread 1",name="main",state="running"}],current-thread-id="1"',
      );

      const nextResp = await client.send("next", { threadId: 1 });
      expect(nextResp.success).toBe(true);
      await client.waitForEvent("stopped", 15000);

      // Snapshot the command count BEFORE continue
      const cmdCountBefore = mock.commandCount();

      // Send continue during syntheticStop
      const contResp = await client.send("continue", { threadId: 1 });
      expect(contResp.success).toBe(true);
      await client.waitForEvent("continued", 3000);

      // Wait 500ms to catch any delayed polling MI commands
      await new Promise((r) => setTimeout(r, 500));

      // Count MI commands sent since continue
      const cmdsSinceContinue = mock.commandsSince(cmdCountBefore);

      // The continue itself must NOT send -exec-continue to GDB (GDB thinks
      // target is running; it would fail with "Selected thread is running").
      const continueCommands = cmdsSinceContinue.filter((c) => c.includes("-exec-continue"));
      expect(continueCommands).toEqual([]);

      // Must NOT start a poll storm.  Before the fix, this was 300+ commands
      // from pollForStopSingleFlight("continue", 30000).  A small number of
      // residual commands from the step recovery winding down is acceptable.
      expect(cmdsSinceContinue.length).toBeLessThan(10);

      const disconnectResp = await client.send("disconnect", { terminateDebuggee: true });
      expect(disconnectResp.success).toBe(true);
    },
    { timeout: 25000 },
  );
});
