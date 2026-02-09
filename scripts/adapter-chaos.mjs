import { spawn, spawnSync } from "child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import path from "path";
import net from "net";
import { pathToFileURL } from "url";

const workspace = process.cwd();
const settingsPath = path.join(workspace, ".vscode", "settings.json");
const trace = process.env.MIKRO_CHAOS_TRACE === "1";
const cycles = Number.parseInt(process.env.MIKRO_CHAOS_CYCLES ?? "4", 10);
const stepsPerCycle = Number.parseInt(process.env.MIKRO_CHAOS_STEPS ?? "28", 10);
const baseSeed = Number.parseInt(process.env.MIKRO_CHAOS_SEED ?? `${Date.now()}`, 10);
const assertWrites = process.env.MIKRO_CHAOS_ASSERT_WRITES !== "0";
const assertVerbose = process.env.MIKRO_CHAOS_ASSERT_VERBOSE === "1";
const raceMode = process.env.MIKRO_CHAOS_RACE_MODE !== "0";

function log(msg) {
  console.log(`adapter-chaos: ${msg}`);
}

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

function createRng(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (1664525 * s + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function commandExists(cmd) {
  if (!cmd) {
    return false;
  }
  if (path.isAbsolute(cmd)) {
    return existsSync(cmd);
  }
  const pathVar = process.env.PATH ?? "";
  for (const part of pathVar.split(path.delimiter)) {
    if (!part) {
      continue;
    }
    const candidate = path.join(part, cmd);
    if (existsSync(candidate)) {
      return true;
    }
  }
  return false;
}

function findRv32simCandidate(root) {
  const home = process.env.HOME || "";
  const direct = [
    path.join(home, "work", "git", "rv32sim", "rv32sim.py"),
    path.join(home, "work", "gitlab", "rv32sim", "rv32sim.py"),
    path.join(home, "git", "rv32sim", "rv32sim.py"),
  ];
  for (const candidate of direct) {
    if (candidate && existsSync(candidate)) {
      return candidate;
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
      path.join(current, "gitlab", "rv32sim", "rv32sim.py"),
      path.resolve(current, "..", "rv32sim", "rv32sim.py"),
      path.resolve(current, "..", "git", "rv32sim", "rv32sim.py"),
      path.resolve(current, "..", "gitlab", "rv32sim", "rv32sim.py"),
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        return candidate;
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

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") {
          resolve(address.port);
          return;
        }
        reject(new Error("Failed to resolve free port"));
      });
    });
  });
}

async function waitForPort(port, timeoutMs = 12000) {
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
      setTimeout(tryConnect, 200);
    };
    tryConnect();
  });
}

function deriveEntryPoint(elfPath, toolchainBin) {
  const candidates = [];
  if (toolchainBin) {
    candidates.push(path.join(toolchainBin, "riscv32-unknown-elf-readelf"));
  }
  candidates.push("riscv32-unknown-elf-readelf", "readelf");
  for (const readelf of candidates) {
    if (!commandExists(readelf)) {
      continue;
    }
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

function sendDAP(stream, message) {
  const json = JSON.stringify(message);
  const payload = `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`;
  stream.write(payload);
}

function nowMs() {
  return Date.now();
}

function cleanupStaleChaosProcesses() {
  const probes = [
    "ps -eo pid,cmd",
    "ps ax -o pid= -o command=",
  ];
  for (const probe of probes) {
    try {
      const res = spawnSync("/usr/bin/zsh", ["-lc", probe], { encoding: "utf8" });
      if (res.status !== 0 || !res.stdout) {
        continue;
      }
      const lines = res.stdout.split(/\r?\n/);
      const victims = [];
      for (const line of lines) {
        const m = line.trim().match(/^(\d+)\s+(.*)$/);
        if (!m) {
          continue;
        }
        const pid = Number.parseInt(m[1], 10);
        const cmd = m[2] || "";
        if (!Number.isFinite(pid) || pid <= 0 || pid === process.pid) {
          continue;
        }
        const isRv32 = cmd.includes("rv32sim.py");
        const isAdapter = cmd.includes("rv32simDebugAdapter.js");
        const isChaosOwned = cmd.includes(".tmp/chaos-") || cmd.includes("adapter-chaos.mjs");
        if ((isRv32 || isAdapter) && isChaosOwned) {
          victims.push(pid);
        }
      }
      for (const pid of victims) {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          // ignore
        }
      }
      if (victims.length > 0) {
        if (trace) {
          log(`cleanup stale pids: ${victims.join(",")}`);
        }
        try {
          spawnSync("/usr/bin/zsh", ["-lc", `sleep 0.2; for p in ${victims.join(" ")}; do kill -0 "$p" 2>/dev/null && kill -KILL "$p" 2>/dev/null || true; done`], { encoding: "utf8" });
        } catch {
          // ignore
        }
      }
      return;
    } catch {
      // try next probe
    }
  }
}

function createDAPReader(stream) {
  let buffer = Buffer.alloc(0);
  let expected = null;
  const queue = [];
  const listeners = new Set();

  function notify(msg) {
    if (trace) {
      const tag = msg.type === "event" ? `event:${msg.event}` : `${msg.type}:${msg.command}`;
      const reason = msg?.body?.reason ? ` reason=${msg.body.reason}` : "";
      log(`dap ${tag}${reason}`);
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
        // ignore malformed records
      }
    }
  });

  function waitFor(predicate, timeoutMs = 10000, label = "DAP message") {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs;
      const timer = setTimeout(() => {
        listeners.delete(check);
        reject(new Error(`Timeout waiting for ${label}`));
      }, timeoutMs);
      const check = () => {
        for (let i = 0; i < queue.length; i += 1) {
          const msg = queue[i];
          if (predicate(msg)) {
            queue.splice(i, 1);
            listeners.delete(check);
            clearTimeout(timer);
            resolve(msg);
            return;
          }
        }
        if (Date.now() >= deadline) {
          listeners.delete(check);
          clearTimeout(timer);
          reject(new Error(`Timeout waiting for ${label}`));
        }
      };
      listeners.add(check);
      check();
    });
  }

  return { waitFor };
}

async function shutdownProcess(proc, name) {
  if (!proc || proc.exitCode !== null || proc.killed) {
    return;
  }
  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      resolve();
    };
    const forceTimer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // ignore
      }
    }, 1000);
    const doneTimer = setTimeout(() => {
      log(`${name} did not exit in time`);
      finish();
    }, 5000);
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

function createAssertAutoResponder(simProc) {
  const state = {
    parser: null,
    pendingKey: "",
    count: 0,
  };

  return {
    async init() {
      const parserUrl = pathToFileURL(path.join(workspace, "out", "assertPrompt.js"));
      const module = await import(parserUrl.href);
      state.parser = new module.AssertPromptParser((prompt) => {
        if (!prompt) {
          return;
        }
        const ready = prompt.rawLines.some(
          (line) =>
            line.includes("[ASSERT] MMIO READ") ||
            line.includes("[ASSERT] MMIO WRITE") ||
            line.includes("[ASSERT] Read value") ||
            line.includes("[ASSERT] Write expect")
        );
        if (!ready) {
          return;
        }
        const key = `${prompt.type}:${prompt.addr}:${prompt.pc}:${prompt.size}`;
        if (state.pendingKey === key) {
          return;
        }
        state.pendingKey = key;
        const response = prompt.type === "write" ? (prompt.value ?? "0x0") : (prompt.reset ?? "0x0");
        try {
          simProc.stdin.write(`${response}\n`);
          state.count += 1;
          if (trace) {
            log(`assert auto-reply ${response} for ${key}`);
          }
          state.pendingKey = "";
          state.parser.clear();
        } catch {
          // ignore broken pipe
        }
      });
    },
    feed(text) {
      if (state.parser) {
        state.parser.feed(text);
      }
    },
    count() {
      return state.count;
    },
  };
}

async function startSession(settings, seed) {
  const elfPath = process.env.MIKRO_TEST_ELF || settings["mikroDesign.elfPath"];
  const svdPath = process.env.MIKRO_TEST_SVD || settings["mikroDesign.svdPath"];
  const gdbPath = process.env.MIKRO_TEST_GDB || settings["mikroDesign.gdbPath"] || "riscv32-unknown-elf-gdb";
  let rv32simPath = process.env.MIKRO_TEST_RV32SIM || settings["mikroDesign.rv32simPath"];
  if (!rv32simPath || !existsSync(rv32simPath)) {
    const candidate = findRv32simCandidate(workspace);
    if (candidate) {
      rv32simPath = candidate;
    }
  }
  if (!elfPath || !rv32simPath) {
    throw new Error("Missing ELF or rv32sim path");
  }
  if (!commandExists(gdbPath)) {
    throw new Error(`GDB not found: ${gdbPath}`);
  }

  let memRegions = settings["mikroDesign.memRegions"] || [];
  if (!Array.isArray(memRegions) || memRegions.length === 0) {
    try {
      const memMapUrl = pathToFileURL(path.join(workspace, "out", "memMap.js"));
      const module = await import(memMapUrl.href);
      memRegions = module.deriveMemRegionsFromElf(elfPath);
    } catch {
      memRegions = [];
    }
  }

  const assertDir = path.join(workspace, ".tmp");
  mkdirSync(assertDir, { recursive: true });
  const assertFile = path.join(assertDir, `chaos-${process.pid}.assert.json`);
  if (!existsSync(assertFile)) {
    writeFileSync(assertFile, JSON.stringify({ assertions: {} }, null, 2) + "\n", "utf8");
  }

  const port = await getFreePort();
  const gdbAddress = `localhost:${port}`;
  const simArgs = [
    elfPath,
    `--port=${port}`,
    "--gdb-mmio-reads",
    "--permissive",
    "--assert-assist",
    `--assert=${assertFile}`,
    `--assert-out=${assertFile}`,
    "--assert-asm",
  ];
  if (assertWrites) {
    simArgs.push("--assert-writes");
  }
  if (assertVerbose) {
    simArgs.push("--assert-verbose");
  }
  if (svdPath) {
    simArgs.push(`--svd=${svdPath}`);
  }
  for (const region of memRegions) {
    simArgs.push(`--mem-region=${region}`);
  }

  const simIsPython = rv32simPath.endsWith(".py");
  const simCmd = simIsPython ? (process.env.MIKRO_TEST_PYTHON || "python3") : rv32simPath;
  const simCommandArgs = simIsPython ? [rv32simPath, ...simArgs] : simArgs;
  log(`seed=${seed} start sim ${simCmd} ${simCommandArgs.join(" ")}`);
  const sim = spawn(simCmd, simCommandArgs, { stdio: ["pipe", "pipe", "pipe"] });

  const assertResponder = createAssertAutoResponder(sim);
  await assertResponder.init();

  const onSimData = (chunk) => {
    const text = chunk.toString();
    if (trace) {
      process.stdout.write(text);
    }
    assertResponder.feed(text);
  };
  sim.stdout.on("data", onSimData);
  sim.stderr.on("data", onSimData);

  await waitForPort(port, 15000);

  const adapterPath = path.join(workspace, "out", "rv32simDebugAdapter.js");
  const adapterLog = path.join(workspace, ".mikro-adapter.log");
  const adapter = spawn(process.execPath, [adapterPath], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, MIKRO_DEBUG_ADAPTER_LOG: adapterLog },
  });
  adapter.stderr.on("data", (chunk) => {
    if (trace) {
      process.stderr.write(chunk.toString());
    }
  });
  const reader = createDAPReader(adapter.stdout);
  let seq = 1;
  let running = false;
  const stats = {
    requests: 0,
    races: 0,
    raceErrors: 0,
  };

  async function request(command, args = {}, timeout = 12000) {
    const id = seq++;
    stats.requests += 1;
    sendDAP(adapter.stdin, { seq: id, type: "request", command, arguments: args });
    const response = await reader.waitFor(
      (m) => m.type === "response" && m.request_seq === id,
      timeout,
      `response:${command}`
    );
    if (!response.success) {
      const msg = response.message || "request failed";
      throw new Error(`${command} failed: ${msg}`);
    }
    return response;
  }

  async function raceRequests(ops, timeoutMs = 12000) {
    const ids = [];
    const promises = [];
    for (const op of ops) {
      const id = seq++;
      stats.requests += 1;
      sendDAP(adapter.stdin, { seq: id, type: "request", command: op.command, arguments: op.args ?? {} });
      ids.push({ id, command: op.command });
      promises.push(
        reader.waitFor(
          (m) => m.type === "response" && m.request_seq === id,
          timeoutMs,
          `response:${op.command}`
        )
      );
    }
    stats.races += 1;
    const results = await Promise.allSettled(promises);
    let failures = 0;
    for (let i = 0; i < results.length; i += 1) {
      const r = results[i];
      if (r.status === "fulfilled") {
        if (!r.value.success) {
          failures += 1;
        }
      } else {
        failures += 1;
      }
    }
    if (failures > 0) {
      stats.raceErrors += failures;
      if (trace) {
        const label = ids.map((x) => x.command).join(",");
        log(`race failures=${failures} ops=${label}`);
      }
    }
    return { ids, results, failures };
  }

  async function waitEvent(event, timeout = 12000, predicate = null) {
    const msg = await reader.waitFor(
      (m) => m.type === "event" && m.event === event && (!predicate || predicate(m)),
      timeout,
      `event:${event}`
    );
    if (event === "continued") {
      running = true;
    }
    if (event === "stopped") {
      running = false;
    }
    return msg;
  }

  await request("initialize", { adapterID: "mikroDesign" });
  await waitEvent("initialized", 5000);

  const entryPoint = deriveEntryPoint(elfPath, settings["mikroDesign.toolchainBin"]);
  await request("launch", {
    program: elfPath,
    gdbPath,
    miDebuggerServerAddress: gdbAddress,
    stopAtEntry: true,
    entryPoint: Number.isFinite(entryPoint) ? entryPoint : undefined,
  }, 20000);
  await request("configurationDone");
  await waitEvent("stopped", 20000, (m) => m.body?.reason === "entry");
  running = false;

  return {
    request,
    raceRequests,
    waitEvent,
    isRunning: () => running,
    assertCount: () => assertResponder.count(),
    stats: () => ({ ...stats }),
    async close() {
      try {
        await request("disconnect", {}, 6000);
      } catch {
        // ignore disconnect failure
      }
      await shutdownProcess(adapter, "adapter");
      await shutdownProcess(sim, "sim");
    },
  };
}

async function runChaosCycle(settings, cycle, seed) {
  cleanupStaleChaosProcesses();
  const rng = createRng(seed);
  let session = await startSession(settings, seed);
  let operations = 0;
  let resets = 0;
  let assertCountTotal = 0;
  let opErrors = 0;
  let benignRaceErrors = 0;
  let hardErrors = 0;
  let totalRequests = 0;
  let totalRaces = 0;
  let totalRaceErrors = 0;

  function classifyError(err) {
    const msg = String(err ?? "").toLowerCase();
    if (
      msg.includes("selected thread is running") ||
      msg.includes("cannot execute this command while") ||
      msg.includes("running thread is required") ||
      msg.includes("unable to read memory")
    ) {
      return "benign";
    }
    return "hard";
  }

  function collectSessionStats() {
    const s = session.stats();
    totalRequests += s.requests;
    totalRaces += s.races;
    totalRaceErrors += s.raceErrors;
  }

  async function safeWaitStopped(timeoutMs = 10000) {
    try {
      await session.waitEvent("stopped", timeoutMs);
      return true;
    } catch {
      return false;
    }
  }

  async function safeWaitContinued(timeoutMs = 8000) {
    try {
      await session.waitEvent("continued", timeoutMs);
      return true;
    } catch {
      return false;
    }
  }

  async function probeState() {
    const t = await session.request("threads", {}, 6000);
    const threads = t.body?.threads ?? [];
    const threadId = threads?.[0]?.id ?? 1;
    const st = await session.request("stackTrace", { threadId, startFrame: 0, levels: 3 }, 6000);
    const frames = st.body?.stackFrames ?? [];
    if (frames.length > 0) {
      const scopes = await session.request("scopes", { frameId: frames[0].id }, 6000);
      const list = scopes.body?.scopes ?? [];
      for (const scope of list.slice(0, 2)) {
        if (scope?.variablesReference > 0) {
          await session.request("variables", { variablesReference: scope.variablesReference }, 6000);
        }
      }
    }
    await session.request("mikro.getRegisters", {}, 6000);
    await session.request("evaluate", { expression: "$pc", context: "watch" }, 6000);
    await session.request("readMemory", { memoryReference: "0xa00f4", offset: 0, count: 4 }, 6000);
  }

  async function resetSession() {
    assertCountTotal += session.assertCount();
    collectSessionStats();
    await session.close();
    const resetSeed = ((seed + resets + 1) * 2654435761) >>> 0;
    session = await startSession(settings, resetSeed);
    resets += 1;
  }

  try {
    for (let i = 0; i < stepsPerCycle; i += 1) {
      const forcedSequence = (process.env.MIKRO_CHAOS_SEQUENCE ?? "")
        .split(",")
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean);
      const forcedOp = forcedSequence.length ? forcedSequence[i % forcedSequence.length] : "";
      const r = rng();
      const doOp = async (op) => {
        if (trace) {
          log(`cycle=${cycle} step=${i + 1} op=${op} running=${session.isRunning()}`);
        }
        if (op === "pause") {
          await session.request("pause", { threadId: 1 }, 6000);
          await session.waitEvent("stopped", 10000);
          return;
        }
        if (op === "continue") {
          await session.request("continue", { threadId: 1 }, 6000);
          await session.waitEvent("continued", 8000);
          return;
        }
        if (op === "stepin") {
          await session.request("stepIn", { threadId: 1 }, 6000);
          await session.waitEvent("stopped", 10000);
          return;
        }
        if (op === "next") {
          await session.request("next", { threadId: 1 }, 6000);
          await session.waitEvent("stopped", 10000);
          return;
        }
        if (op === "stack") {
          await session.request("stackTrace", { threadId: 1, startFrame: 0, levels: 4 }, 6000);
          return;
        }
        if (op === "threads") {
          await session.request("threads", {}, 6000);
          return;
        }
        if (op === "eval") {
          await session.request("evaluate", { expression: "$pc", context: "watch" }, 6000);
          return;
        }
        if (op === "readmem") {
          await session.request("readMemory", { memoryReference: "0xa00f4", offset: 0, count: 4 }, 6000);
          return;
        }
        if (op === "probe") {
          await probeState();
          return;
        }
        if (op === "reset") {
          await resetSession();
          return;
        }
        if (op === "storm-continue-pause") {
          if (!raceMode) {
            await session.request("continue", { threadId: 1 }, 6000);
            await safeWaitContinued(5000);
            await session.request("pause", { threadId: 1 }, 6000);
            await safeWaitStopped(7000);
            return;
          }
          await session.raceRequests(
            [
              { command: "continue", args: { threadId: 1 } },
              { command: "pause", args: { threadId: 1 } },
            ],
            8000
          );
          if (session.isRunning()) {
            await session.request("pause", { threadId: 1 }, 6000);
          }
          await safeWaitStopped(7000);
          return;
        }
        if (op === "storm-pause-continue") {
          if (!raceMode) {
            await session.request("pause", { threadId: 1 }, 6000);
            await safeWaitStopped(7000);
            await session.request("continue", { threadId: 1 }, 6000);
            await safeWaitContinued(5000);
            return;
          }
          await session.raceRequests(
            [
              { command: "pause", args: { threadId: 1 } },
              { command: "continue", args: { threadId: 1 } },
            ],
            8000
          );
          if (!session.isRunning()) {
            await session.request("continue", { threadId: 1 }, 6000);
            await safeWaitContinued(5000);
          }
          return;
        }
        if (op === "storm-double-pause") {
          await session.raceRequests(
            [
              { command: "pause", args: { threadId: 1 } },
              { command: "pause", args: { threadId: 1 } },
            ],
            8000
          );
          await safeWaitStopped(7000);
          return;
        }
        if (op === "storm-double-continue") {
          await session.raceRequests(
            [
              { command: "continue", args: { threadId: 1 } },
              { command: "continue", args: { threadId: 1 } },
            ],
            8000
          );
          await safeWaitContinued(5000);
          return;
        }
        await session.request("mikro.getRegisters", {}, 6000);
      };
      if (session.isRunning()) {
        try {
          if (forcedOp) {
            await doOp(forcedOp === "stepin" || forcedOp === "next" ? "pause" : forcedOp);
          } else if (r < 0.32) {
            await doOp("pause");
          } else if (r < 0.48) {
            await doOp("storm-continue-pause");
          } else if (r < 0.58) {
            await doOp("storm-double-pause");
          } else if (r < 0.72) {
            await doOp("threads");
          } else if (r < 0.84) {
            await doOp("probe");
          } else {
            await doOp("regs");
          }
        } catch (err) {
          const kind = classifyError(err);
          opErrors += 1;
          if (kind === "benign") {
            benignRaceErrors += 1;
          } else {
            hardErrors += 1;
          }
          if (trace) {
            log(`op error (running): ${String(err)}`);
          }
          try {
            await session.request("pause", { threadId: 1 }, 4000);
          } catch {
            // ignore
          }
          await safeWaitStopped(5000);
        }
        operations += 1;
        continue;
      }

      try {
        if (forcedOp) {
          await doOp(forcedOp);
        } else if (r < 0.10) {
          await doOp("stepin");
        } else if (r < 0.20) {
          await doOp("next");
        } else if (r < 0.30) {
          await doOp("stack");
        } else if (r < 0.40) {
          await doOp("probe");
        } else if (r < 0.50) {
          await doOp("eval");
        } else if (r < 0.58) {
          await doOp("readmem");
        } else if (r < 0.66) {
          await doOp("threads");
        } else if (r < 0.74) {
          await doOp("storm-double-continue");
        } else if (r < 0.82) {
          await doOp("storm-pause-continue");
        } else if (r < 0.90) {
          await doOp("reset");
        } else {
          await doOp("continue");
        }
      } catch (err) {
        const kind = classifyError(err);
        opErrors += 1;
        if (kind === "benign") {
          benignRaceErrors += 1;
        } else {
          hardErrors += 1;
        }
        if (trace) {
          log(`op error (stopped): ${String(err)}`);
        }
        await resetSession();
      }
      operations += 1;
    }
  } finally {
    const assertCount = assertCountTotal + session.assertCount();
    collectSessionStats();
    await session.close();
    log(
      `cycle=${cycle} done operations=${operations} asserts=${assertCount} resets=${resets} opErrors=${opErrors} benignErrors=${benignRaceErrors} hardErrors=${hardErrors} requests=${totalRequests} races=${totalRaces} raceErrors=${totalRaceErrors}`
    );
  }
}

async function main() {
  const settings = readSettings();
  log(`cycles=${cycles} steps=${stepsPerCycle} seed=${baseSeed}`);
  for (let cycle = 0; cycle < cycles; cycle += 1) {
    const seed = (baseSeed + cycle * 9973) >>> 0;
    await runChaosCycle(settings, cycle + 1, seed);
  }
  log("PASS");
}

main().catch((err) => {
  console.error(`adapter-chaos failed: ${err.message || err}`);
  process.exit(1);
});
