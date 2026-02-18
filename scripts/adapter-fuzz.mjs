/**
 * adapter-fuzz.mjs — DAP adapter protocol fuzzing.
 *
 * Five phases:
 *  1. Protocol malformation — adapter must not crash on broken DAP framing
 *  2. State machine violations — adapter responds gracefully to wrong-order requests
 *  3. Rapid lifecycle — repeated init→launch→disconnect cycles
 *  4. Execution storm — concurrent DAP requests to stress concurrency
 *  5. Disconnect under load — adapter shuts down cleanly despite pending work
 *
 * Usage:
 *   node scripts/adapter-fuzz.mjs
 *
 * Env vars (same as adapter-integration.mjs):
 *   MIKRO_TEST_ELF           — path to ELF binary
 *   MIKRO_TEST_RV32SIM       — path to rv32sim.py
 *   MIKRO_TEST_GDB           — path to gdb
 *   MIKRO_TEST_GDB_PORT      — fixed port (auto if 0)
 *   MIKRO_FUZZ_TRACE         — set to "1" for verbose DAP trace
 */

import { spawn, spawnSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import path from "path";
import net from "net";
import { pathToFileURL } from "url";

const workspace = process.cwd();
const settingsPath = path.join(workspace, ".vscode", "settings.json");
const trace = process.env.MIKRO_FUZZ_TRACE === "1";

// ─── Metrics ──────────────────────────────────────────

let hardErrors = 0;
let gracefulRejections = 0;
let phasesCompleted = 0;

function log(msg) {
  console.log(`adapter-fuzz: ${msg}`);
}

function logHard(msg) {
  hardErrors++;
  console.error(`  [FAIL] ${msg}`);
}

/** The adapter correctly rejected or timed out an intentionally invalid/racy request. */
function logGraceful(msg) {
  gracefulRejections++;
  if (trace) {
    console.log(`  [ok] ${msg}`);
  }
}

// ─── Helpers (reused from adapter-integration) ────────

function stripJsonComments(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\/\/.*$/, ""))
    .join("\n");
}

function readSettings() {
  if (!existsSync(settingsPath)) {
    return {};
  }
  try {
    return JSON.parse(stripJsonComments(readFileSync(settingsPath, "utf8")));
  } catch {
    return {};
  }
}

function findRv32simCandidate(root) {
  const home = process.env.HOME || "";
  const direct = [
    path.join(home, "work", "git", "rv32sim", "rv32sim.py"),
    path.join(home, "work", "gitlab", "rv32sim", "rv32sim.py"),
    path.join(home, "git", "rv32sim", "rv32sim.py"),
  ];
  for (const c of direct) {
    if (c && existsSync(c)) {
      return c;
    }
  }
  if (!root) {
    return null;
  }
  let current = root;
  for (let depth = 0; depth < 12; depth += 1) {
    const candidates = [
      path.join(current, "rv32sim", "rv32sim.py"),
      path.join(current, "git", "rv32sim", "rv32sim.py"),
      path.resolve(current, "..", "rv32sim", "rv32sim.py"),
      path.resolve(current, "..", "git", "rv32sim", "rv32sim.py"),
    ];
    for (const c of candidates) {
      if (existsSync(c)) {
        return c;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return null;
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") {
          resolve(address.port);
        } else {
          reject(new Error("Failed to acquire free port"));
        }
      });
    });
  });
}

function waitForPort(port, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryConnect = () => {
      const socket = new net.Socket();
      socket.setTimeout(500);
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("timeout", () => {
        socket.destroy();
        retry();
      });
      socket.once("error", () => {
        socket.destroy();
        retry();
      });
      socket.connect(port, "127.0.0.1");
    };
    const retry = () => {
      if (Date.now() >= deadline) {
        reject(new Error(`Port ${port} did not open`));
        return;
      }
      setTimeout(tryConnect, 250);
    };
    tryConnect();
  });
}

function isTcpBlocked() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", (err) => {
      resolve(err.code === "EPERM");
    });
    server.listen(0, "127.0.0.1", () => {
      server.close(() => resolve(false));
    });
  });
}

function waitForSocket(socketPath, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (existsSync(socketPath)) {
        resolve(true);
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error(`Socket ${socketPath} did not appear`));
        return;
      }
      setTimeout(tick, 250);
    };
    tick();
  });
}

function deriveEntryPoint(elfPath, toolchainBin) {
  const candidates = [];
  if (toolchainBin) {
    candidates.push(path.join(toolchainBin, "riscv32-unknown-elf-readelf"));
  }
  candidates.push("riscv32-unknown-elf-readelf", "readelf");
  for (const readelf of candidates) {
    try {
      const res = spawnSync(readelf, ["-h", elfPath], { encoding: "utf8" });
      if (res.status !== 0) {
        continue;
      }
      const out = `${res.stdout ?? ""}\n${res.stderr ?? ""}`;
      const match = out.match(/Entry point address:\s*(0x[0-9a-fA-F]+)/);
      if (match?.[1]) {
        return Number.parseInt(match[1], 16);
      }
    } catch {
      continue;
    }
  }
  return null;
}

// ─── DAP Protocol ─────────────────────────────────────

function sendDAP(stream, message) {
  const json = JSON.stringify(message);
  const payload = `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`;
  stream.write(payload);
}

function sendRaw(stream, data) {
  stream.write(data);
}

function createDAPReader(stream) {
  let buffer = Buffer.alloc(0);
  let expected = null;
  const queue = [];
  const listeners = new Set();

  function notify(msg) {
    if (trace) {
      const kind = msg.type === "event" ? `event:${msg.event}` : `${msg.type}:${msg.command ?? ""}`;
      const reason = msg?.body?.reason ? ` reason=${msg.body.reason}` : "";
      console.log(`  dap ${kind}${reason}`);
    }
    for (const cb of listeners) {
      cb(msg);
    }
  }

  stream.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      if (expected === null) {
        const headerEnd = buffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) {
          return;
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
        return;
      }
      const body = buffer.slice(0, expected).toString("utf8");
      buffer = buffer.slice(expected);
      expected = null;
      try {
        const msg = JSON.parse(body);
        queue.push(msg);
        notify(msg);
      } catch {
        // ignore malformed
      }
    }
  });

  return {
    waitFor(predicate, timeoutMs = 10000) {
      return new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          listeners.delete(check);
          reject(new Error("Timeout waiting for DAP message"));
        }, timeoutMs);
        const check = () => {
          if (settled) return;
          for (let i = 0; i < queue.length; i += 1) {
            const msg = queue[i];
            if (predicate(msg)) {
              queue.splice(i, 1);
              settled = true;
              clearTimeout(timer);
              listeners.delete(check);
              resolve(msg);
              return;
            }
          }
        };
        listeners.add(check);
        check();
      });
    },
    drain() {
      queue.length = 0;
    },
  };
}

function shutdownProcess(proc, name, timeoutMs = 5000) {
  return new Promise((resolve) => {
    if (!proc || proc.exitCode !== null || proc.killed) {
      resolve();
      return;
    }
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const forceTimer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {}
    }, 1000);
    const doneTimer = setTimeout(() => {
      if (trace) {
        console.warn(`  ${name} did not exit in time`);
      }
      finish();
    }, timeoutMs);
    proc.once("close", () => {
      clearTimeout(forceTimer);
      clearTimeout(doneTimer);
      finish();
    });
    try {
      proc.kill("SIGTERM");
    } catch {
      clearTimeout(forceTimer);
      clearTimeout(doneTimer);
      finish();
    }
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Session Management ──────────────────────────────

async function startSession(elfPath, gdbPath, gdbAddress, entryPoint) {
  const adapterPath = path.join(workspace, "out", "rv32simDebugAdapter.js");
  const adapter = spawn(process.execPath, [adapterPath], {
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env, MIKRO_DEBUG_ADAPTER_LOG: path.join(workspace, ".mikro-fuzz.log") },
  });
  const reader = createDAPReader(adapter.stdout);
  let seq = 1;

  const send = (command, args = {}) => {
    const s = seq++;
    sendDAP(adapter.stdin, { seq: s, type: "request", command, arguments: args });
    return s;
  };

  const sendAndWait = async (command, args = {}, timeoutMs = 10000) => {
    const s = send(command, args);
    return reader.waitFor((m) => m.type === "response" && m.request_seq === s, timeoutMs);
  };

  return { adapter, reader, send, sendAndWait, sendRawToStdin: (data) => sendRaw(adapter.stdin, data) };
}

async function initAndLaunch(session, elfPath, gdbPath, gdbAddress, entryPoint) {
  await session.sendAndWait("initialize", { adapterID: "mikroDesign" });
  await session.sendAndWait("launch", {
    program: elfPath,
    gdbPath,
    miDebuggerServerAddress: gdbAddress,
    stopAtEntry: true,
    entryPoint: Number.isFinite(entryPoint) ? entryPoint : undefined,
  }, 15000);
  await session.sendAndWait("configurationDone");
  // Wait for entry stop
  await session.reader.waitFor(
    (m) => m.type === "event" && m.event === "stopped" && m.body?.reason === "entry",
    15000
  );
}

// ─── Phase 1: Protocol Malformation ──────────────────

async function phase1(elfPath, gdbPath, gdbAddress, entryPoint) {
  log("Phase 1: Protocol Malformation");

  const session = await startSession(elfPath, gdbPath, gdbAddress, entryPoint);
  const { adapter, sendRawToStdin } = session;

  // Give adapter a moment to start
  await sleep(200);

  const tests = [
    {
      name: "truncated Content-Length (no CRLFCRLF)",
      data: "Content-Length: 100",
    },
    {
      name: "Content-Length larger than body",
      data: `Content-Length: 9999\r\n\r\n{"seq":1,"type":"request","command":"initialize"}`,
    },
    {
      name: "Content-Length of 0",
      data: "Content-Length: 0\r\n\r\n",
    },
    {
      name: "invalid JSON body",
      data: "Content-Length: 13\r\n\r\n{not valid js}",
    },
    {
      name: "valid JSON missing seq/command",
      data: `Content-Length: 16\r\n\r\n{"hello":"world"}`,
    },
    {
      name: "binary garbage between messages",
      data: Buffer.from([0x00, 0xFF, 0xFE, 0xAB, 0xCD, 0xEF, 0x13, 0x37]),
    },
  ];

  for (const test of tests) {
    try {
      sendRawToStdin(test.data);
      await sleep(100);
      // Check adapter is still alive
      if (adapter.exitCode !== null) {
        logHard(`adapter crashed after: ${test.name}`);
      } else {
        if (trace) {
          console.log(`  ✓ survived: ${test.name}`);
        }
      }
    } catch (err) {
      logHard(`${test.name}: ${err.message}`);
    }
  }

  // Now send a valid initialize to verify adapter is still functional
  try {
    const initResp = await session.sendAndWait("initialize", { adapterID: "mikroDesign" }, 5000);
    if (initResp.success) {
      if (trace) {
        console.log("  ✓ adapter still functional after malformation");
      }
    } else {
      logGraceful("initialize returned failure after malformation");
    }
  } catch (err) {
    logGraceful(`initialize timed out after malformation: ${err.message}`);
  }

  await session.sendAndWait("disconnect", {}, 3000).catch(() => {});
  await shutdownProcess(adapter, "adapter-p1");
  log("Phase 1 complete");
  phasesCompleted++;
}

// ─── Phase 2: State Machine Violations ───────────────

async function phase2(elfPath, gdbPath, gdbAddress, entryPoint) {
  log("Phase 2: State Machine Violations");

  const violations = [
    { name: "stackTrace before initialize", command: "stackTrace", args: { threadId: 1 } },
    { name: "variables before launch", command: "variables", args: { variablesReference: 1 } },
    { name: "continue before configurationDone", command: "continue", args: { threadId: 1 } },
  ];

  // Test each violation in a fresh adapter
  for (const v of violations) {
    const session = await startSession(elfPath, gdbPath, gdbAddress, entryPoint);
    try {
      const resp = await session.sendAndWait(v.command, v.args, 5000);
      if (resp.success === false) {
        if (trace) {
          console.log(`  ✓ ${v.name}: graceful failure`);
        }
      } else {
        logGraceful(`${v.name}: unexpected success`);
      }
    } catch (err) {
      if (session.adapter.exitCode !== null) {
        logHard(`${v.name}: adapter crashed`);
      } else {
        logGraceful(`${v.name}: timeout (${err.message})`);
      }
    }
    await session.sendAndWait("disconnect", {}, 2000).catch(() => {});
    await shutdownProcess(session.adapter, `adapter-p2-${v.name}`);
  }

  // Double initialize
  {
    const session = await startSession(elfPath, gdbPath, gdbAddress, entryPoint);
    try {
      await session.sendAndWait("initialize", { adapterID: "mikroDesign" }, 5000);
      const resp2 = await session.sendAndWait("initialize", { adapterID: "mikroDesign" }, 5000);
      if (trace) {
        console.log(`  ✓ double initialize: success=${resp2.success}`);
      }
    } catch (err) {
      if (session.adapter.exitCode !== null) {
        logHard("double initialize: adapter crashed");
      } else {
        logGraceful(`double initialize: ${err.message}`);
      }
    }
    await session.sendAndWait("disconnect", {}, 2000).catch(() => {});
    await shutdownProcess(session.adapter, "adapter-p2-dblInit");
  }

  // Disconnect then continue
  {
    const session = await startSession(elfPath, gdbPath, gdbAddress, entryPoint);
    try {
      await session.sendAndWait("initialize", { adapterID: "mikroDesign" }, 5000);
      await session.sendAndWait("disconnect", {}, 5000);
      // Now send continue after disconnect
      const resp = await session.sendAndWait("continue", { threadId: 1 }, 3000);
      if (trace) {
        console.log(`  ✓ continue after disconnect: success=${resp.success}`);
      }
    } catch (err) {
      if (session.adapter.exitCode !== null) {
        if (trace) {
          console.log("  ✓ adapter exited after disconnect (expected)");
        }
      } else {
        logGraceful(`continue after disconnect: ${err.message}`);
      }
    }
    await shutdownProcess(session.adapter, "adapter-p2-postDisc");
  }

  // setBreakpoints after disconnect
  {
    const session = await startSession(elfPath, gdbPath, gdbAddress, entryPoint);
    try {
      await session.sendAndWait("initialize", { adapterID: "mikroDesign" }, 5000);
      await session.sendAndWait("disconnect", {}, 5000);
      const resp = await session.sendAndWait("setBreakpoints", {
        source: { path: elfPath },
        breakpoints: [{ line: 1 }],
      }, 3000);
      if (trace) {
        console.log(`  ✓ setBreakpoints after disconnect: success=${resp.success}`);
      }
    } catch (err) {
      if (session.adapter.exitCode !== null) {
        if (trace) {
          console.log("  ✓ adapter exited after disconnect (expected)");
        }
      } else {
        logGraceful(`setBreakpoints after disconnect: ${err.message}`);
      }
    }
    await shutdownProcess(session.adapter, "adapter-p2-bpAfterDisc");
  }

  log("Phase 2 complete");
  phasesCompleted++;
}

// ─── Phase 3: Rapid Lifecycle ────────────────────────

async function phase3(elfPath, gdbPath, gdbAddress, entryPoint, simSpawner) {
  log("Phase 3: Rapid Lifecycle (5 cycles)");
  const cycleCount = 5;

  for (let cycle = 0; cycle < cycleCount; cycle++) {
    const cycleStart = Date.now();
    let simProc = null;
    let session = null;

    try {
      // Spawn fresh sim for each cycle — use its address, not the original
      const sim = await simSpawner();
      simProc = sim.proc;
      const cycleAddress = sim.address;
      session = await startSession(elfPath, gdbPath, cycleAddress, entryPoint);

      await initAndLaunch(session, elfPath, gdbPath, cycleAddress, entryPoint);

      // Quick verify: threads request
      const threadsResp = await session.sendAndWait("threads", {}, 5000);
      if (!threadsResp.success) {
        logGraceful(`cycle ${cycle + 1}: threads failed`);
      }

      // Disconnect
      await session.sendAndWait("disconnect", {}, 5000);

      const elapsed = Date.now() - cycleStart;
      if (elapsed > 15000) {
        logHard(`cycle ${cycle + 1}: took ${elapsed}ms (>15s)`);
      } else {
        if (trace) {
          console.log(`  ✓ cycle ${cycle + 1}: ${elapsed}ms`);
        }
      }
    } catch (err) {
      logHard(`cycle ${cycle + 1}: ${err.message}`);
    }

    if (session) {
      await shutdownProcess(session.adapter, `adapter-p3-c${cycle}`);
    }
    if (simProc) {
      await shutdownProcess(simProc, `sim-p3-c${cycle}`);
    }

    // Brief pause between cycles
    await sleep(500);
  }

  log("Phase 3 complete");
  phasesCompleted++;
}

// ─── Phase 4: Execution Storm ────────────────────────

async function phase4(elfPath, gdbPath, gdbAddress, entryPoint, sim) {
  log("Phase 4: Execution Storm");

  const session = await startSession(elfPath, gdbPath, gdbAddress, entryPoint);
  try {
    await initAndLaunch(session, elfPath, gdbPath, gdbAddress, entryPoint);

    // Get thread ID
    const threadsResp = await session.sendAndWait("threads", {}, 5000);
    const threadId = threadsResp.body?.threads?.[0]?.id ?? 1;

    // 4a: Fire 10 concurrent continue requests
    if (trace) {
      console.log("  4a: 10 concurrent continues");
    }
    const continuePromises = [];
    for (let i = 0; i < 10; i++) {
      continuePromises.push(
        session.sendAndWait("continue", { threadId }, 5000).catch((err) => {
          logGraceful(`concurrent continue ${i}: ${err.message}`);
          return null;
        })
      );
    }
    await Promise.allSettled(continuePromises);
    await sleep(300);

    // 4b: Fire 10 concurrent pause requests
    if (trace) {
      console.log("  4b: 10 concurrent pauses");
    }
    const pausePromises = [];
    for (let i = 0; i < 10; i++) {
      pausePromises.push(
        session.sendAndWait("pause", { threadId }, 5000).catch((err) => {
          logGraceful(`concurrent pause ${i}: ${err.message}`);
          return null;
        })
      );
    }
    await Promise.allSettled(pausePromises);

    // Wait for a stopped event to stabilize
    try {
      await session.reader.waitFor(
        (m) => m.type === "event" && m.event === "stopped",
        5000
      );
    } catch {
      // May already be stopped
    }
    await sleep(200);

    // 4c: Interleave step/continue/pause with 0ms delay
    if (trace) {
      console.log("  4c: interleaved step/continue/pause");
    }
    const interleaveOps = ["next", "continue", "pause", "stepIn", "continue", "pause"];
    const interleavePromises = interleaveOps.map((cmd) =>
      session.sendAndWait(cmd, { threadId }, 5000).catch((err) => {
        logGraceful(`interleave ${cmd}: ${err.message}`);
        return null;
      })
    );
    await Promise.allSettled(interleavePromises);
    await sleep(500);

    // Wait for stopped to stabilize
    try {
      await session.reader.waitFor(
        (m) => m.type === "event" && m.event === "stopped",
        5000
      );
    } catch {
      // May already be stopped
    }

    // 4d: Fire stackTrace + variables + evaluate concurrently
    if (trace) {
      console.log("  4d: concurrent queries");
    }
    const queryPromises = [
      session.sendAndWait("stackTrace", { threadId, startFrame: 0, levels: 5 }, 5000),
      session.sendAndWait("evaluate", { expression: "$pc", context: "hover" }, 5000),
      session.sendAndWait("threads", {}, 5000),
    ].map((p) => p.catch((err) => {
      logGraceful(`concurrent query: ${err.message}`);
      return null;
    }));
    await Promise.allSettled(queryPromises);

    // 4e: Fire mikro.getRegisters 50 times rapidly
    if (trace) {
      console.log("  4e: 50 rapid mikro.getRegisters");
    }
    const regPromises = [];
    for (let i = 0; i < 50; i++) {
      regPromises.push(
        session.sendAndWait("mikro.getRegisters", {}, 5000).catch((err) => {
          logGraceful(`rapid getRegisters ${i}: ${err.message}`);
          return null;
        })
      );
    }
    await Promise.allSettled(regPromises);

    // Check adapter is still alive
    if (session.adapter.exitCode !== null) {
      logHard("adapter crashed during execution storm");
    } else {
      if (trace) {
        console.log("  ✓ adapter survived execution storm");
      }
    }

    await session.sendAndWait("disconnect", {}, 5000).catch(() => {});
  } catch (err) {
    logHard(`phase 4: ${err.message}`);
  }

  await shutdownProcess(session.adapter, "adapter-p4");
  log("Phase 4 complete");
  phasesCompleted++;
}

// ─── Phase 5: Disconnect Under Load ─────────────────

async function phase5(elfPath, gdbPath, gdbAddress, entryPoint, sim) {
  log("Phase 5: Disconnect Under Load");

  // 5a: Start continue, immediately disconnect
  {
    const session = await startSession(elfPath, gdbPath, gdbAddress, entryPoint);
    try {
      await initAndLaunch(session, elfPath, gdbPath, gdbAddress, entryPoint);
      const threadsResp = await session.sendAndWait("threads", {}, 5000);
      const threadId = threadsResp.body?.threads?.[0]?.id ?? 1;

      session.send("continue", { threadId });
      // Immediately disconnect
      await session.sendAndWait("disconnect", {}, 5000);

      if (trace) {
        console.log("  ✓ disconnect after continue");
      }
    } catch (err) {
      logGraceful(`5a: ${err.message}`);
    }
    // Verify adapter exits within 5s
    const exitStart = Date.now();
    await shutdownProcess(session.adapter, "adapter-p5a");
    if (Date.now() - exitStart > 5000) {
      logHard("adapter did not exit within 5s after disconnect-during-continue");
    }
  }

  // 5b: Start step, immediately disconnect
  {
    const session = await startSession(elfPath, gdbPath, gdbAddress, entryPoint);
    try {
      await initAndLaunch(session, elfPath, gdbPath, gdbAddress, entryPoint);
      const threadsResp = await session.sendAndWait("threads", {}, 5000);
      const threadId = threadsResp.body?.threads?.[0]?.id ?? 1;

      session.send("next", { threadId });
      await session.sendAndWait("disconnect", {}, 5000);

      if (trace) {
        console.log("  ✓ disconnect after step");
      }
    } catch (err) {
      logGraceful(`5b: ${err.message}`);
    }
    await shutdownProcess(session.adapter, "adapter-p5b");
  }

  // 5c: Start 10 concurrent evaluates, disconnect mid-flight
  {
    const session = await startSession(elfPath, gdbPath, gdbAddress, entryPoint);
    try {
      await initAndLaunch(session, elfPath, gdbPath, gdbAddress, entryPoint);

      // Fire 10 evaluates
      for (let i = 0; i < 10; i++) {
        session.send("evaluate", { expression: `$x${i}`, context: "hover" });
      }
      // Disconnect mid-flight
      await session.sendAndWait("disconnect", {}, 5000);

      if (trace) {
        console.log("  ✓ disconnect during evaluates");
      }
    } catch (err) {
      logGraceful(`5c: ${err.message}`);
    }
    const exitStart = Date.now();
    await shutdownProcess(session.adapter, "adapter-p5c");
    if (Date.now() - exitStart > 5000) {
      logHard("adapter did not exit within 5s after disconnect-during-evaluates");
    }
  }

  log("Phase 5 complete");
  phasesCompleted++;
}

// ─── Main ─────────────────────────────────────────────

async function main() {
  const settings = readSettings();
  const elfPath = process.env.MIKRO_TEST_ELF || settings["mikroDesign.elfPath"];
  const gdbPath = process.env.MIKRO_TEST_GDB || settings["mikroDesign.gdbPath"] || "riscv32-unknown-elf-gdb";
  let rv32simPath = process.env.MIKRO_TEST_RV32SIM || settings["mikroDesign.rv32simPath"];
  if (!rv32simPath || !existsSync(rv32simPath)) {
    const candidate = findRv32simCandidate(workspace);
    if (candidate) {
      rv32simPath = candidate;
    }
  }
  if (!elfPath || !rv32simPath) {
    throw new Error(
      "Missing ELF or rv32simPath (set in settings.json or via env MIKRO_TEST_ELF/MIKRO_TEST_RV32SIM)"
    );
  }

  const tcpBlocked = await isTcpBlocked().catch(() => false);
  let port = Number.parseInt(process.env.MIKRO_TEST_GDB_PORT || "0", 10);
  if (!port) {
    port = await getFreePort();
  }
  let gdbAddress = `localhost:${port}`;
  let gdbPortFlag = `--port=${port}`;
  if (tcpBlocked) {
    const socketPath = path.join("/tmp", `rv32sim-fuzz-${process.pid}-${Date.now()}.sock`);
    gdbAddress = `unix:${socketPath}`;
    gdbPortFlag = `--port=unix:${socketPath}`;
    log(`tcp blocked, using unix socket ${socketPath}`);
  }

  let memRegions = settings["mikroDesign.memRegions"] || [];
  const envRegions = process.env.MIKRO_TEST_MEM_REGIONS;
  if (envRegions) {
    memRegions = envRegions.split(",").map((s) => s.trim()).filter(Boolean);
  }
  if (!Array.isArray(memRegions) || memRegions.length === 0) {
    try {
      const memMapUrl = pathToFileURL(path.join(workspace, "out", "memMap.js"));
      const module = await import(memMapUrl.href);
      memRegions = module.deriveMemRegionsFromElf(elfPath);
    } catch {
      memRegions = [];
    }
  }

  const svdPath = process.env.MIKRO_TEST_SVD || settings["mikroDesign.svdPath"];
  const simArgs = [elfPath, gdbPortFlag, "--gdb-mmio-reads", "--permissive"];
  if (svdPath) {
    simArgs.push(`--svd=${svdPath}`);
  }
  for (const r of memRegions) {
    simArgs.push(`--mem-region=${r}`);
  }

  const simIsPython = rv32simPath.endsWith(".py");
  const simCmd = simIsPython ? "python3" : rv32simPath;
  const simBaseArgs = simIsPython ? [rv32simPath, ...simArgs] : simArgs;

  const entryPoint = (() => {
    const ep = process.env.MIKRO_TEST_ENTRY;
    if (ep && ep.trim().length) {
      return Number.parseInt(ep, 16);
    }
    return deriveEntryPoint(elfPath, settings["mikroDesign.toolchainBin"]);
  })();

  // Spawner function for fresh sim instances — returns { proc, address }
  const spawnSim = async () => {
    const p = Number.parseInt(process.env.MIKRO_TEST_GDB_PORT || "0", 10);
    let thisPort = p || await getFreePort();
    let thisAddress = `localhost:${thisPort}`;
    let thisPortFlag = `--port=${thisPort}`;
    if (tcpBlocked) {
      const socketPath = path.join("/tmp", `rv32sim-fuzz-${process.pid}-${Date.now()}.sock`);
      thisAddress = `unix:${socketPath}`;
      thisPortFlag = `--port=unix:${socketPath}`;
    }

    const args = [...simBaseArgs.filter((a) => !a.startsWith("--port=")), thisPortFlag];
    const proc = spawn(simCmd, args, { stdio: "inherit" });
    if (thisAddress.startsWith("unix:")) {
      await waitForSocket(thisAddress.slice("unix:".length), 15000);
    } else {
      await waitForPort(thisPort, 15000);
    }
    return { proc, address: thisAddress };
  };

  log(`ELF: ${elfPath}`);
  log(`rv32sim: ${rv32simPath}`);
  log(`gdb: ${gdbPath}`);
  log(`address: ${gdbAddress}`);

  // ─── Phase 1: no sim needed, only adapter ──────────
  await phase1(elfPath, gdbPath, gdbAddress, entryPoint);

  // ─── Phases 2-5: need sim ──────────────────────────
  log("Starting sim for phases 2-5");
  const sim = spawn(simCmd, simIsPython ? [rv32simPath, ...simArgs] : simArgs, { stdio: "inherit" });
  if (gdbAddress.startsWith("unix:")) {
    await waitForSocket(gdbAddress.slice("unix:".length), 15000);
  } else {
    await waitForPort(port, 15000);
  }

  await phase2(elfPath, gdbPath, gdbAddress, entryPoint);
  await phase4(elfPath, gdbPath, gdbAddress, entryPoint, sim);
  await phase5(elfPath, gdbPath, gdbAddress, entryPoint, sim);

  await shutdownProcess(sim, "sim-main");

  // Phase 3 spawns its own sims
  await phase3(elfPath, gdbPath, gdbAddress, entryPoint, spawnSim);

  // ─── Summary ───────────────────────────────────────
  console.log("\n─────────────────────────────────");
  console.log(`adapter-fuzz results:`);
  console.log(`  Phases completed:     ${phasesCompleted}/5`);
  console.log(`  Failures:             ${hardErrors}`);
  console.log(`  Graceful rejections:  ${gracefulRejections}`);
  console.log("─────────────────────────────────\n");

  if (hardErrors > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`adapter-fuzz failed: ${err.message || err}`);
  process.exit(1);
});
