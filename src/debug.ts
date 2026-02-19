import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { spawnSync } from "child_process";
import { Rv32SimController } from "./rv32simController";
import { autoConfigureFromActiveEditor, buildFirmware, ensureBuildInfo, resolveBuildInfo, resolveToolchainBin } from "./sdkBuild";
import { resolvePath } from "./utils";
import { deriveMemRegionsFromElf } from "./memMap";
import { autoCreateAssertFileIfNeeded } from "./assertConfig";
import { createGdbServer, GdbServerType, GdbServerConfig } from "./gdbServer";

interface MikroDebugConfiguration extends vscode.DebugConfiguration {
  mikroDesign?: boolean;
}

let lastKnownRv32simPath: string | undefined;
let lastKnownRv32simWorkspace: string | undefined;

export class MikroDebugConfigurationProvider implements vscode.DebugConfigurationProvider {
  constructor(
    private readonly sim: Rv32SimController,
    private readonly output: vscode.OutputChannel,
    private readonly extensionRoot?: string
  ) {}

  async provideDebugConfigurations(): Promise<MikroDebugConfiguration[]> {
    return [
      {
        name: "Mikro: rv32sim",
        type: "mikroDesign",
        request: "launch",
        mikroDesign: true,
        stopAtEntry: true,
      },
    ];
  }

  async resolveDebugConfiguration(
    _folder: vscode.WorkspaceFolder | undefined,
    config: MikroDebugConfiguration
  ): Promise<MikroDebugConfiguration | null | undefined> {
    const log = createLogger(this.output);
    log("resolveDebugConfiguration start");
    const isMikroConfig = config.mikroDesign || config.name?.startsWith("Mikro: rv32sim");
    if (!isMikroConfig) {
      log("config not handled");
      return config;
    }
    config.type = "mikroDesign";
    if (config.preLaunchTask) {
      log(`clearing preLaunchTask=${config.preLaunchTask}`);
      delete config.preLaunchTask;
    }

    await autoConfigureFromActiveEditor(this.output).catch(() => undefined);
    const configSettings = vscode.workspace.getConfiguration();
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (this.sim.isRunning) {
      log("rv32sim already running; stopping before new debug launch");
      this.sim.stop();
    }
    const clearBreakpoints = configSettings.get<boolean>("mikroDesign.clearBreakpointsOnDebug") ?? true;
    if (clearBreakpoints) {
      clearExternalBreakpoints(log);
    }
    const gdbMmioReads = configSettings.get<boolean>("mikroDesign.gdbMmioReads") ?? true;
    const strictMode = configSettings.get<boolean>("mikroDesign.strictMode") ?? false;
    const debugTarget = (configSettings.get<string>("mikroDesign.debugTarget") ?? "rv32sim").trim();
    log(`autoConfigureFromActiveEditor done gdbMmioReads=${gdbMmioReads} strictMode=${strictMode}`);

    const buildOnDebug = configSettings.get<boolean>("mikroDesign.buildOnDebug") ?? true;
    const configuredElf = resolvePath(configSettings.get<string>("mikroDesign.elfPath"));
    const hasReadyElf = Boolean(configuredElf && fs.existsSync(configuredElf));
    if (buildOnDebug && !hasReadyElf) {
      const info = await buildFirmware(this.output);
      if (!info) {
        log("build failed");
        return null;
      }
      await vscode.workspace.getConfiguration().update(
        "mikroDesign.elfPath",
        info.elfPath,
        vscode.ConfigurationTarget.Workspace
      );
      log(`build ok, elfPath=${info.elfPath}`);
    } else if (buildOnDebug && hasReadyElf) {
      log(`build skipped: ready elfPath=${configuredElf}`);
    }

    const buildInfo = resolveBuildInfo(this.output) ?? (await ensureBuildInfo(this.output));
    const configuredElfPath = resolvePath(configSettings.get<string>("mikroDesign.elfPath"));
    log(`buildInfo: ${buildInfo ? `sdkPath=${buildInfo.sdkPath} elfPath=${buildInfo.elfPath}` : "<none>"}`);
    log(`configuredElfPath: ${configuredElfPath ?? "<none>"} exists=${configuredElfPath ? fs.existsSync(configuredElfPath) : false}`);
    let sdkPathForResolve = buildInfo?.sdkPath;
    if (!buildInfo) {
      if (!configuredElfPath || !fs.existsSync(configuredElfPath)) {
        log("buildInfo missing and no valid elfPath configured — cannot start debug session");
        vscode.window.showErrorMessage(
          "No ELF file configured. Run 'Mikro: Setup Project (SDK)' or set mikroDesign.elfPath. Check the \"Mikro Design\" output panel for details."
        );
        return null;
      }
      log(`buildInfo missing; using ELF-only debug mode elfPath=${configuredElfPath}`);
      sdkPathForResolve = workspaceRoot ?? path.dirname(configuredElfPath);
    }

    const elfPath = configuredElfPath ?? buildInfo?.elfPath;
    const configuredRv32sim = configSettings.get<string>("mikroDesign.rv32simPath");
    log(`rv32simPath from config: ${configuredRv32sim}`);
    let rv32simResolved: string | undefined;

    // If configured path is absolute and exists, use it directly
    if (configuredRv32sim && path.isAbsolute(configuredRv32sim) && fs.existsSync(configuredRv32sim)) {
      rv32simResolved = configuredRv32sim;
      log(`Using configured absolute rv32simPath: ${rv32simResolved}`);
    } else {
      // Otherwise, try to resolve it
      rv32simResolved = resolveRv32simPath(
        configuredRv32sim ?? "../rv32sim/rv32sim.py",
        workspaceRoot,
        sdkPathForResolve,
        this.extensionRoot
      );
      log(`rv32simPath resolved to: ${rv32simResolved}`);
      // Do not rewrite workspace settings from auto-detection, because
      // generated/temporary workspaces can churn and invalidate relative paths.
      if (rv32simResolved && fs.existsSync(rv32simResolved)) {
        const currentRv32sim = resolvePath(configuredRv32sim, workspaceRoot);
        if (!currentRv32sim || !fs.existsSync(currentRv32sim)) {
          log(`rv32simPath auto-detected (runtime only): ${rv32simResolved}`);
        }
      }
    }
    if ((!rv32simResolved || !fs.existsSync(rv32simResolved)) && lastKnownRv32simPath && lastKnownRv32simWorkspace === workspaceRoot && fs.existsSync(lastKnownRv32simPath)) {
      rv32simResolved = lastKnownRv32simPath;
      log(`rv32simPath fallback from last-known-good: ${rv32simResolved}`);
    }
    log(`rv32simPath FINAL being passed to controller: ${rv32simResolved}`);
    if (!rv32simResolved || !fs.existsSync(rv32simResolved)) {
      log(`rv32sim path validation failed: tried ${rv32simResolved ?? "<none>"}`);
      vscode.window.showErrorMessage(
        `rv32sim.py not found at "${rv32simResolved ?? "<not set>"}". Set mikroDesign.rv32simPath in settings. Check the "Mikro Design" output panel for details.`
      );
      return null;
    }
    lastKnownRv32simPath = rv32simResolved;
    lastKnownRv32simWorkspace = workspaceRoot;
    let gdbPath = configSettings.get<string>("mikroDesign.gdbPath") ?? "riscv-none-elf-gdb";
    log(`gdbPath from settings: ${gdbPath}`);
    if (!commandExists(gdbPath)) {
      log(`gdbPath not found in PATH or as absolute: ${gdbPath}`);
      const toolchainBin = resolveToolchainBin();
      log(`toolchainBin resolved to: ${toolchainBin ?? "<none>"}`);
      if (toolchainBin) {
        for (const name of ["riscv-none-elf-gdb", "riscv32-unknown-elf-gdb"]) {
          const candidate = path.join(toolchainBin, name);
          log(`trying toolchain gdb candidate: ${candidate} exists=${fs.existsSync(candidate)}`);
          if (fs.existsSync(candidate)) {
            gdbPath = candidate;
            break;
          }
        }
      }
    }
    if (!commandExists(gdbPath)) {
      log(`gdbPath still not found after toolchain check, trying PATH fallbacks`);
      for (const fallback of ["riscv-none-elf-gdb", "riscv32-unknown-elf-gdb"]) {
        const found = commandExists(fallback);
        log(`PATH fallback ${fallback}: ${found ? "found" : "not found"}`);
        if (found) {
          gdbPath = fallback;
          break;
        }
      }
    }
    if (!commandExists(gdbPath)) {
      const pathVar = process.env.PATH ?? "";
      log(`GDB not found. PATH=${pathVar}`);
      log(`Set mikroDesign.gdbPath to the full path of your RISC-V GDB executable, or add its directory to PATH.`);
      vscode.window.showErrorMessage(
        `GDB not found: ${gdbPath}. Set mikroDesign.gdbPath in settings or ensure the RISC-V toolchain bin directory is in PATH. Check the "Mikro Design" output panel for details.`
      );
      return null;
    }
    log(`gdbPath FINAL: ${gdbPath}`);
    const configuredPort = configSettings.get<number>("mikroDesign.gdbPort") ?? 3333;
    let port = configuredPort;
    let gdbPort: number | string = port;
    let serverAddress = `localhost:${port}`;
    if (debugTarget === "rv32sim") {
      await autoCreateAssertFileIfNeeded().catch(() => undefined);
    }
    let entryPoint: number | null = null;
    if (debugTarget === "rv32sim") {
      let runtimeConfig = vscode.workspace.getConfiguration();
      let assertMode = (runtimeConfig.get<string>("mikroDesign.assertMode") ?? "assist").toLowerCase();
      let assertFile = resolvePath(runtimeConfig.get<string>("mikroDesign.assertFile"));
      let assertWrites = runtimeConfig.get<boolean>("mikroDesign.assertWrites") ?? false;
      const forceAssist = process.env.MIKRO_FORCE_ASSERT_ASSIST === "1";
      const forceWrites = process.env.MIKRO_FORCE_ASSERT_WRITES === "1";
      const forceAssertFileRaw = process.env.MIKRO_FORCE_ASSERT_FILE;
      if (forceAssertFileRaw) {
        const forcedPath = resolvePath(forceAssertFileRaw, workspaceRoot);
        if (forcedPath) {
          assertFile = forcedPath;
        }
      }
      if (forceAssist) {
        assertMode = "assist";
        assertWrites = forceWrites || assertWrites;
        log("assertMode forced to assist via MIKRO_FORCE_ASSERT_ASSIST");
      } else if (forceWrites) {
        assertWrites = true;
        log("assertWrites forced via MIKRO_FORCE_ASSERT_WRITES");
      }
      const assertEmpty = isAssertFileEmpty(assertFile);
      if (assertEmpty && assertMode === "enforce") {
        await vscode.workspace.getConfiguration().update(
          "mikroDesign.assertMode",
          "assist",
          vscode.ConfigurationTarget.Workspace
        );
        await vscode.workspace.getConfiguration().update(
          "mikroDesign.assertWrites",
          false,
          vscode.ConfigurationTarget.Workspace
        );
        log("assertMode auto-switched to assist (assert file empty, writes disabled)");
        assertMode = "assist";
        assertWrites = false;
      }
      if (assertMode === "assist" && assertFile) {
        ensureAssertFileExists(assertFile);
      }
      const memRegionsSetting = configSettings.get<string[]>("mikroDesign.memRegions") ?? [];
      const toolchainBin = resolveToolchainBin();
      const derivedMemRegions = elfPath ? deriveMemRegionsFromElf(elfPath, toolchainBin) : [];
      entryPoint = elfPath ? deriveEntryPointFromElf(elfPath, toolchainBin) : null;
      const memRegions = derivedMemRegions.length > 0 ? derivedMemRegions : memRegionsSetting;
      if (memRegions.length) {
        log(`memRegions=${memRegions.join(",")}`);
        if (!derivedMemRegions.length && memRegionsSetting.length) {
          log("memRegions: using configured values (auto-derive empty)");
        } else if (derivedMemRegions.length && memRegionsSetting.length) {
          log("memRegions: auto-derived values override configured list");
        }
      }
      if (entryPoint !== null) {
        log(`entryPoint=0x${entryPoint.toString(16)}`);
      }
      const tcpBlocked = await isTcpBlocked().catch(() => false);
      if (!tcpBlocked) {
        const available = await isPortAvailable(port).catch(() => true);
        if (!available) {
          const fallbackPort = await getFreePort();
          this.output.appendLine(
            `[SIM] GDB port ${port} is busy. Switching to available port ${fallbackPort}.`
          );
          log(`gdb port ${port} busy; switching to ${fallbackPort}`);
          port = fallbackPort;
          gdbPort = port;
          serverAddress = `localhost:${port}`;
        }
      }
      if (tcpBlocked) {
        const socketPath = path.join(os.tmpdir(), `rv32sim-gdb-${process.pid}-${Date.now()}.sock`);
        gdbPort = `unix:${socketPath}`;
        serverAddress = `unix:${socketPath}`;
        log(`tcp blocked, using unix socket ${socketPath}`);
      }
      runtimeConfig = vscode.workspace.getConfiguration();
      this.sim.start({
        rv32simPath: rv32simResolved,
        pythonPath: configSettings.get<string>("mikroDesign.pythonPath") ?? "python3",
        gdbPort,
        gdbMmioReads,
        strictMode,
        svdPath: resolvePath(configSettings.get<string>("mikroDesign.svdPath")),
        elfPath,
        memRegions,
        assertMode: assertMode as any,
        assertFile,
        assertShowAsm: true,
        assertVerbose: false,
        assertWrites,
      });
      log("rv32sim started");
      const gdbReady = tcpBlocked
        ? await waitForUnixSocket(String(gdbPort).replace(/^unix:/, ""), 10000)
            .then(() => true)
            .catch(() => false)
        : await waitForPort(port, 10000)
            .then(() => true)
            .catch(() => false);
      if (!gdbReady) {
        log(tcpBlocked ? "gdb unix socket wait timed out" : "gdb port wait timed out");
        this.sim.stop();
        vscode.window.showErrorMessage(
          tcpBlocked
            ? "rv32sim did not open the GDB unix socket in time. Debug start aborted. Check .mikro-sim.log for details."
            : "rv32sim did not open the GDB port in time. Debug start aborted. Check .mikro-sim.log for details."
        );
        return null;
      }
    } else {
      log(`non-rv32sim target selected: ${debugTarget} (gdb port ${port})`);
      const serverTypeRaw = (config.serverType as string) ?? debugTarget;
      const serverType: GdbServerType =
        serverTypeRaw === "embedded" ? "external" : (serverTypeRaw as GdbServerType);
      const serverConfig: GdbServerConfig = {
        serverPath: config.serverPath as string | undefined,
        serverArgs: config.serverArgs as string[] | undefined,
        configFiles: config.configFiles as string[] | undefined,
        device: config.device as string | undefined,
        interface: config.interface as "swd" | "jtag" | undefined,
        port,
        hwBreakpointLimit: config.hwBreakpointLimit as number | undefined,
      };
      try {
        const server = createGdbServer(serverType, serverConfig);
        const result = await server.start();
        serverAddress = result.serverAddress;
        const caps = result.capabilities;
        const postConnect = server.getPostConnectCommands();
        const loadCmd = elfPath ? server.getLoadCommand(elfPath) : "load";
        config._serverCapabilities = caps;
        config._postConnectCommands = postConnect;
        config._loadCommand = loadCmd;
        config._gdbServer = server;
        log(`server started: ${serverAddress} caps=${JSON.stringify(caps)}`);
      } catch (err) {
        log(`server start failed: ${String(err)}`);
        vscode.window.showErrorMessage(`GDB server start failed: ${String(err)}`);
        return null;
      }
    }

    const stopAtEntry = configSettings.get<boolean>("mikroDesign.debugStopAtEntry") ?? true;

    log(`launching: program=${elfPath ?? "<none>"} gdb=${gdbPath} server=${serverAddress} stopAtEntry=${stopAtEntry} entryPoint=${entryPoint !== null ? `0x${entryPoint.toString(16)}` : "auto"}`);
    return {
      ...config,
      request: "launch",
      name: config.name ?? "Mikro: rv32sim",
      program: elfPath,
      miDebuggerServerAddress: serverAddress,
      gdbPath,
      miDebuggerPath: gdbPath,
      stopAtEntry,
      entryPoint: entryPoint ?? undefined,
    };
  }
}

async function isTcpBlocked(): Promise<boolean> {
  const net = await import("net");
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", (err: NodeJS.ErrnoException) => {
      resolve(err.code === "EPERM");
    });
    server.listen(0, "127.0.0.1", () => {
      server.close(() => resolve(false));
    });
  });
}

async function isPortAvailable(port: number): Promise<boolean> {
  const net = await import("net");
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", (err: NodeJS.ErrnoException) => {
      resolve(err.code !== "EADDRINUSE");
    });
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

async function getFreePort(): Promise<number> {
  const net = await import("net");
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

function commandExists(cmd: string): boolean {
  if (path.isAbsolute(cmd)) {
    return fs.existsSync(cmd);
  }
  const pathVar = process.env.PATH ?? "";
  for (const part of pathVar.split(path.delimiter)) {
    if (!part) {
      continue;
    }
    const candidate = path.join(part, cmd);
    if (fs.existsSync(candidate)) {
      return true;
    }
  }
  return false;
}

function deriveEntryPointFromElf(elfPath: string, toolchainBin?: string): number | null {
  const candidates: string[] = [];
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

async function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const net = await import("net");
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    let resolved = false;
    const tryConnect = () => {
      if (resolved) {
        return;
      }
      const socket = new net.Socket();
      socket.setTimeout(500);
      socket.once("connect", () => {
        if (!resolved) {
          resolved = true;
          socket.destroy();
          resolve();
        }
      });
      socket.once("timeout", () => {
        socket.destroy();
        if (!resolved) {
          retry();
        }
      });
      socket.once("error", () => {
        socket.destroy();
        if (!resolved) {
          retry();
        }
      });
      socket.connect(port, "127.0.0.1");
    };
    const retry = () => {
      if (resolved) {
        return;
      }
      if (Date.now() >= deadline) {
        if (!resolved) {
          resolved = true;
          reject(new Error(`Port ${port} did not open`));
        }
        return;
      }
      setTimeout(tryConnect, 250);
    };
    tryConnect();
  });
}

async function waitForUnixSocket(socketPath: string, timeoutMs: number): Promise<void> {
  const net = await import("net");
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    let resolved = false;
    const tryConnect = () => {
      if (resolved) {
        return;
      }
      const socket = new net.Socket();
      socket.setTimeout(500);
      socket.once("connect", () => {
        if (!resolved) {
          resolved = true;
          socket.destroy();
          resolve();
        }
      });
      socket.once("timeout", () => {
        socket.destroy();
        if (!resolved) {
          retry();
        }
      });
      socket.once("error", () => {
        socket.destroy();
        if (!resolved) {
          retry();
        }
      });
      socket.connect(socketPath);
    };
    const retry = () => {
      if (resolved) {
        return;
      }
      if (Date.now() >= deadline) {
        if (!resolved) {
          resolved = true;
          reject(new Error(`Socket ${socketPath} did not open`));
        }
        return;
      }
      setTimeout(tryConnect, 250);
    };
    tryConnect();
  });
}

function createLogger(output?: vscode.OutputChannel): (message: string) => void {
  const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const logPath = workspace ? path.join(workspace, ".mikro-debug.log") : null;
  return (message: string) => {
    if (output) {
      output.appendLine(`[Debug] ${message}`);
    }
    if (logPath) {
      try {
        fs.appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`);
      } catch {
        // ignore
      }
    }
  };
}

function clearExternalBreakpoints(log: (message: string) => void): void {
  const config = vscode.workspace.getConfiguration();
  const sdkPathRaw = config.get<string>("mikroDesign.sdkPath") ?? "";
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const root = resolvePath(sdkPathRaw, workspaceRoot) ?? workspaceRoot;
  if (!root) {
    const all = [...vscode.debug.breakpoints];
    if (all.length) {
      vscode.debug.removeBreakpoints(all);
      log(`removed ${all.length} breakpoints (no workspace root)`);
    }
    return;
  }
  const rootWithSep = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  const toRemove: vscode.Breakpoint[] = [];
  for (const bp of vscode.debug.breakpoints) {
    if (bp instanceof vscode.SourceBreakpoint) {
      const filePath = bp.location.uri.fsPath;
      if (!fs.existsSync(filePath)) {
        toRemove.push(bp);
        continue;
      }
      if (!filePath.startsWith(rootWithSep)) {
        toRemove.push(bp);
      }
    } else {
      toRemove.push(bp);
    }
  }
  if (toRemove.length) {
    vscode.debug.removeBreakpoints(toRemove);
    log(`removed ${toRemove.length} external breakpoints`);
  }
}

function isAssertFileEmpty(assertFile?: string): boolean {
  if (!assertFile) {
    return true;
  }
  try {
    if (!fs.existsSync(assertFile)) {
      return true;
    }
    const raw = fs.readFileSync(assertFile, "utf8").trim();
    if (!raw) {
      return true;
    }
    const parsed = JSON.parse(raw);
    if (parsed === null || parsed === undefined) {
      return true;
    }
    if (Array.isArray(parsed)) {
      return parsed.length === 0;
    }
    if (typeof parsed === "object") {
      const assertions = parsed.assertions;
      if (assertions && typeof assertions === "object") {
        return Object.keys(assertions).length === 0;
      }
      if (Array.isArray(parsed.entries)) {
        return parsed.entries.length === 0;
      }
      if (Array.isArray(parsed.rules)) {
        return parsed.rules.length === 0;
      }
      return Object.keys(parsed).length === 0;
    }
  } catch {
    return true;
  }
  return false;
}

function ensureAssertFileExists(assertFile: string): void {
  try {
    if (fs.existsSync(assertFile)) {
      return;
    }
    const dir = path.dirname(assertFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(assertFile, JSON.stringify({ assertions: {} }, null, 2) + "\n", "utf8");
  } catch {
    // ignore
  }
}

function resolveRv32simPath(
  configValue: string | undefined,
  workspaceRoot?: string,
  sdkPath?: string,
  extensionRoot?: string
): string | undefined {
  if (lastKnownRv32simPath && lastKnownRv32simWorkspace === workspaceRoot && fs.existsSync(lastKnownRv32simPath)) {
    return lastKnownRv32simPath;
  }
  const envPath = process.env.MIKRO_RV32SIM_PATH;
  if (envPath && fs.existsSync(envPath)) {
    return envPath;
  }
  const resolved = resolvePath(configValue ?? "../rv32sim/rv32sim.py", workspaceRoot);
  if (resolved && fs.existsSync(resolved)) {
    return resolved;
  }
  const candidate = findRv32simCandidate(workspaceRoot, sdkPath, extensionRoot);
  if (candidate) {
    return candidate;
  }
  return resolved;
}

function findRv32simCandidate(workspaceRoot?: string, sdkPath?: string, extensionRoot?: string): string | undefined {
  const home = os.homedir();
  const directCandidates: string[] = [
    path.join(home, "work", "git", "rv32sim", "rv32sim.py"),
    path.join(home, "work", "git", "rv32sim.py", "rv32sim.py"),
    path.join(home, "git", "rv32sim", "rv32sim.py"),
    path.join(home, "git", "rv32sim.py", "rv32sim.py"),
    path.join(home, "work", "gitlab", "rv32sim", "rv32sim.py"),
    path.join(home, "work", "gitlab", "rv32sim.py", "rv32sim.py"),
  ];
  if (sdkPath) {
    directCandidates.push(path.join(sdkPath, "..", "rv32sim", "rv32sim.py"));
    directCandidates.push(path.join(sdkPath, "..", "rv32sim.py", "rv32sim.py"));
    directCandidates.push(path.join(sdkPath, "..", "..", "rv32sim", "rv32sim.py"));
    directCandidates.push(path.join(sdkPath, "..", "..", "rv32sim.py", "rv32sim.py"));
  }
  if (extensionRoot) {
    directCandidates.push(path.join(extensionRoot, "..", "rv32sim", "rv32sim.py"));
    directCandidates.push(path.join(extensionRoot, "..", "rv32sim.py", "rv32sim.py"));
    directCandidates.push(path.join(extensionRoot, "..", "..", "rv32sim", "rv32sim.py"));
    directCandidates.push(path.join(extensionRoot, "..", "..", "rv32sim.py", "rv32sim.py"));
  }
  for (const candidate of directCandidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  if (!workspaceRoot) {
    return undefined;
  }
  let current = workspaceRoot;
  for (let depth = 0; depth < 12; depth += 1) {
    const candidates = [
      path.join(current, "rv32sim", "rv32sim.py"),
      path.join(current, "rv32sim.py", "rv32sim.py"),
      path.join(current, "git", "rv32sim", "rv32sim.py"),
      path.join(current, "git", "rv32sim.py", "rv32sim.py"),
      path.join(current, "gitlab", "rv32sim", "rv32sim.py"),
      path.join(current, "gitlab", "rv32sim.py", "rv32sim.py"),
      path.resolve(current, "..", "rv32sim", "rv32sim.py"),
      path.resolve(current, "..", "rv32sim.py", "rv32sim.py"),
      path.resolve(current, "..", "git", "rv32sim", "rv32sim.py"),
      path.resolve(current, "..", "git", "rv32sim.py", "rv32sim.py"),
      path.resolve(current, "..", "gitlab", "rv32sim", "rv32sim.py"),
      path.resolve(current, "..", "gitlab", "rv32sim.py", "rv32sim.py"),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return undefined;
}
