import { spawn, spawnSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import path from "path";
import net from "net";
import { pathToFileURL } from "url";

const workspace = process.cwd();
const settingsPath = path.join(workspace, ".vscode", "settings.json");

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

async function isTcpBlocked() {
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

function sendDAP(stream, message) {
  const json = JSON.stringify(message);
  const payload = `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`;
  stream.write(payload);
}

function createDAPReader(stream) {
  const trace = process.env.MIKRO_SMOKE_TRACE === "1";
  let buffer = Buffer.alloc(0);
  let expected = null;
  const queue = [];
  const listeners = new Set();

  function notify(msg) {
    if (trace) {
      const kind = msg.type === "event" ? `event:${msg.event}` : `${msg.type}:${msg.command ?? ""}`;
      const reason = msg?.body?.reason ? ` reason=${msg.body.reason}` : "";
      console.log(`adapter-smoke: dap ${kind}${reason}`);
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
        // ignore
      }
    }
  });

  return {
    waitFor(predicate, timeoutMs = 10000) {
      return new Promise((resolve, reject) => {
        const deadline = Date.now() + timeoutMs;
        const check = () => {
          for (let i = 0; i < queue.length; i += 1) {
            const msg = queue[i];
            if (predicate(msg)) {
              queue.splice(i, 1);
              listeners.delete(check);
              resolve(msg);
              return;
            }
          }
          if (Date.now() >= deadline) {
            listeners.delete(check);
            reject(new Error("Timeout waiting for DAP message"));
          }
        };
        listeners.add(check);
        check();
      });
    },
  };
}

function shutdownProcess(proc, name) {
  return new Promise((resolve) => {
    if (!proc || proc.exitCode !== null || proc.killed) {
      resolve();
      return;
    }
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
      console.warn(`adapter-smoke: ${name} did not exit in time`);
      finish();
    }, 4000);
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

async function main() {
  const settings = readSettings();
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
    throw new Error(
      "Missing ELF or rv32simPath (set in settings.json or via env MIKRO_TEST_ELF/MIKRO_TEST_RV32SIM)"
    );
  }
  const forceTcp = process.env.MIKRO_TEST_FORCE_TCP === "1";
  const tcpBlocked = forceTcp ? false : await isTcpBlocked().catch(() => false);
  let port = Number.parseInt(process.env.MIKRO_TEST_GDB_PORT || "0", 10);
  if (!port) {
    port = await getFreePort();
  }
  let gdbAddress = `localhost:${port}`;
  let gdbPortFlag = `--port=${port}`;
  if (tcpBlocked) {
    const socketPath = path.join("/tmp", `rv32sim-gdb-${process.pid}-${Date.now()}.sock`);
    gdbAddress = `unix:${socketPath}`;
    gdbPortFlag = `--port=unix:${socketPath}`;
    console.log(`adapter-smoke: tcp blocked, using unix socket ${socketPath}`);
  }

  let memRegions = settings["mikroDesign.memRegions"] || [];
  const envRegions = process.env.MIKRO_TEST_MEM_REGIONS;
  if (envRegions) {
    memRegions = envRegions.split(",").map((item) => item.trim()).filter(Boolean);
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
  console.log(`adapter-smoke: memRegions=${memRegions.join(",") || "(none)"}`);

  const simArgs = [elfPath, gdbPortFlag, "--gdb-mmio-reads", "--permissive"];
  if (svdPath) {
    simArgs.push(`--svd=${svdPath}`);
  }
  for (const region of memRegions) {
    simArgs.push(`--mem-region=${region}`);
  }

  const simIsPython = rv32simPath.endsWith(".py");
  const simCmd = simIsPython ? "python3" : rv32simPath;
  const simCommandArgs = simIsPython ? [rv32simPath, ...simArgs] : simArgs;
  console.log(`adapter-smoke: starting ${simCmd} ${simCommandArgs.join(" ")}`);
  const sim = spawn(simCmd, simCommandArgs, { stdio: "inherit" });
  if (gdbAddress.startsWith("unix:")) {
    await waitForSocket(gdbAddress.slice("unix:".length), 15000);
  } else {
    await waitForPort(port, 15000);
  }

  const adapterPath = path.join(workspace, "out", "rv32simDebugAdapter.js");
  const adapterLog = path.join(workspace, ".mikro-sim.log");
  const adapter = spawn(process.execPath, [adapterPath], {
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env, MIKRO_DEBUG_ADAPTER_LOG: adapterLog },
  });
  const reader = createDAPReader(adapter.stdout);

  let seq = 1;
  const send = (command, args = {}) => {
    sendDAP(adapter.stdin, { seq: seq++, type: "request", command, arguments: args });
  };

  send("initialize", { adapterID: "mikroDesign" });
  await reader.waitFor((m) => m.type === "response" && m.command === "initialize");

  const entryPoint =
    process.env.MIKRO_TEST_ENTRY && process.env.MIKRO_TEST_ENTRY.trim().length
      ? Number.parseInt(process.env.MIKRO_TEST_ENTRY, 16)
      : deriveEntryPoint(elfPath, settings["mikroDesign.toolchainBin"]);

  send("launch", {
    program: elfPath,
    gdbPath,
    miDebuggerServerAddress: gdbAddress,
    stopAtEntry: true,
    entryPoint: Number.isFinite(entryPoint) ? entryPoint : undefined,
  });
  await reader.waitFor((m) => m.type === "response" && m.command === "launch", 15000);

  send("configurationDone");
  await reader.waitFor((m) => m.type === "response" && m.command === "configurationDone");

  await reader.waitFor(
    (m) => m.type === "event" && m.event === "stopped" && m.body?.reason === "entry",
    15000
  );

  console.log("adapter-smoke: entry stop observed");

  if (process.env.MIKRO_SMOKE_ASSERT_PAUSE === "1") {
    send("continue", { threadId: 1 });
    await reader.waitFor((m) => m.type === "response" && m.command === "continue", 5000);
    await reader.waitFor((m) => m.type === "event" && m.event === "continued", 5000);
    console.log("adapter-smoke: continued, issuing pause attempts");
    // Mirror extension behavior: force pause in a short burst.
    for (let i = 0; i < 5; i += 1) {
      send("pause", { threadId: 1 });
      await new Promise((resolve) => setTimeout(resolve, 80 * (i + 1)));
    }
    await reader.waitFor(
      (m) =>
        m.type === "event" &&
        m.event === "stopped" &&
        (m.body?.reason === "pause" || m.body?.reason === "signal"),
      8000
    );
    console.log("adapter-smoke: stopped observed after pause");
  }

  send("disconnect");
  await reader.waitFor((m) => m.type === "response" && m.command === "disconnect");

  await shutdownProcess(adapter, "adapter");
  await shutdownProcess(sim, "sim");
}

main().catch((err) => {
  console.error(`adapter-smoke failed: ${err.message || err}`);
  process.exit(1);
});
