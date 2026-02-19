import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { getWorkspaceRoot, resolvePath } from "./utils";

export interface MikroBuildInfo {
  sdkPath: string;
  appName: string;
  configName: string;
  toolchain: string;
  appDir: string;
  elfPath: string;
}

interface ConfigScan {
  configs: string[];
  defaultConfig?: string;
  defaultToolchain?: string;
}

interface InferredBuildPath {
  sdkPath: string;
  appName: string;
  configName: string;
  toolchain: string;
  elfPath: string;
}

function isValidSdkRoot(dir: string): boolean {
  return (
    fs.existsSync(path.join(dir, "app")) &&
    fs.existsSync(path.join(dir, "make", "app.mk"))
  );
}

/** Walk up from `start` looking for a directory that passes `isValidSdkRoot`. */
function findSdkRootUpwards(start: string): string | undefined {
  let dir = path.resolve(start);
  const root = path.parse(dir).root;
  while (true) {
    if (isValidSdkRoot(dir)) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir || parent === root) {
      break;
    }
    dir = parent;
  }
  return undefined;
}

function readMakeDefault(makefileText: string, key: string): string | undefined {
  const pattern = new RegExp(`^\\s*${key}\\s*[:?+]?=\\s*([^\\s#]+)`, "m");
  const match = makefileText.match(pattern);
  return match ? match[1].trim() : undefined;
}

export function scanAppConfig(appDir: string): ConfigScan {
  const configs: string[] = [];
  const makefile = path.join(appDir, "Makefile");
  let defaultConfig: string | undefined;
  let defaultToolchain: string | undefined;
  if (fs.existsSync(makefile)) {
    const text = fs.readFileSync(makefile, "utf8");
    defaultConfig = readMakeDefault(text, "DEFAULT_CONFIG");
    defaultToolchain = readMakeDefault(text, "DEFAULT_TOOLCHAIN");
  }
  if (fs.existsSync(appDir)) {
    const entries = fs.readdirSync(appDir);
    for (const entry of entries) {
      if (entry.startsWith("config-") && entry.endsWith(".mk")) {
        const name = entry.slice("config-".length, entry.length - ".mk".length);
        if (name) {
          configs.push(name);
        }
      }
    }
  }
  configs.sort();
  return { configs, defaultConfig, defaultToolchain };
}

export function listApps(sdkPath: string): string[] {
  const appRoot = path.join(sdkPath, "app");
  if (!fs.existsSync(appRoot)) {
    return [];
  }
  return fs
    .readdirSync(appRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort();
}

function setConfigValue(key: string, value: string): Thenable<void> {
  return vscode.workspace.getConfiguration().update(key, value, vscode.ConfigurationTarget.Workspace);
}

async function ensureSdkPath(output: vscode.OutputChannel): Promise<string | null> {
  const config = vscode.workspace.getConfiguration();
  const sdkPathRaw = config.get<string>("mikroDesign.sdkPath");
  const candidate = sdkPathRaw?.trim() || undefined;
  const workspaceRoot = getWorkspaceRoot();
  const sdkPath = candidate ? resolvePath(candidate, workspaceRoot) : undefined;
  // Accept configured path only if it is a valid SDK root.
  if (sdkPath && fs.existsSync(sdkPath) && isValidSdkRoot(sdkPath)) {
    if (sdkPathRaw !== sdkPath) {
      await setConfigValue("mikroDesign.sdkPath", sdkPath);
      output.appendLine(`[SDK] Set sdkPath to ${sdkPath}`);
    }
    return sdkPath;
  }
  // Auto-detect: walk up from workspace root (handles build-output directories).
  const found = workspaceRoot ? findSdkRootUpwards(workspaceRoot) : undefined;
  if (found) {
    await setConfigValue("mikroDesign.sdkPath", found);
    output.appendLine(`[SDK] Set sdkPath to ${found}`);
    return found;
  }
  // Don't show error - just return null silently (only show errors when user actively debugs)
  return null;
}

function appFromEditor(sdkPath: string): string | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return undefined;
  }
  const filePath = editor.document.uri.fsPath;
  const appRoot = path.join(sdkPath, "app") + path.sep;
  if (!filePath.startsWith(appRoot)) {
    return undefined;
  }
  const relative = filePath.slice(appRoot.length);
  const parts = relative.split(path.sep).filter((part) => part.length > 0);
  return parts.length > 0 ? parts[0] : undefined;
}

function inferFromElfPath(elfPathRaw: string | undefined, sdkPathHint?: string): InferredBuildPath | null {
  if (!elfPathRaw) {
    return null;
  }
  const elfPath = path.resolve(elfPathRaw);
  if (!elfPath.endsWith(".elf")) {
    return null;
  }
  const toolchainDir = path.dirname(elfPath);
  const configDir = path.dirname(toolchainDir);
  const appDir = path.dirname(configDir);
  const buildDir = path.dirname(appDir);
  if (path.basename(buildDir) !== "build") {
    return null;
  }
  const appName = path.basename(appDir);
  const configName = path.basename(configDir);
  const toolchain = path.basename(toolchainDir);
  const sdkPath = path.dirname(buildDir);
  if (sdkPathHint && path.resolve(sdkPathHint) !== sdkPath) {
    return null;
  }
  if (!appName || !configName || !toolchain) {
    return null;
  }
  return {
    sdkPath,
    appName,
    configName,
    toolchain,
    elfPath,
  };
}

function inferFromActiveEditorPath(sdkPath: string): InferredBuildPath | null {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return null;
  }
  const filePath = editor.document.uri.fsPath;
  const sdkBuildRoot = path.join(sdkPath, "build") + path.sep;
  if (!filePath.startsWith(sdkBuildRoot)) {
    return null;
  }
  const relative = filePath.slice(sdkBuildRoot.length);
  const parts = relative.split(path.sep).filter((part) => part.length > 0);
  if (parts.length < 3) {
    return null;
  }
  const [appName, configName, toolchain] = parts;
  const elfPath = path.join(sdkPath, "build", appName, configName, toolchain, `${appName}.elf`);
  return {
    sdkPath,
    appName,
    configName,
    toolchain,
    elfPath,
  };
}

function inferBuildPathFromContext(sdkPath: string): InferredBuildPath | null {
  const config = vscode.workspace.getConfiguration();
  const configuredElf = resolvePath(config.get<string>("mikroDesign.elfPath"), getWorkspaceRoot()) ?? undefined;
  const fromElf = inferFromElfPath(configuredElf, sdkPath);
  if (fromElf) {
    return fromElf;
  }
  return inferFromActiveEditorPath(sdkPath);
}

export async function autoConfigureFromActiveEditor(output: vscode.OutputChannel): Promise<void> {
  const sdkPath = await ensureSdkPath(output);
  if (!sdkPath) {
    return;
  }
  const inferred = inferBuildPathFromContext(sdkPath);
  if (inferred) {
    const config = vscode.workspace.getConfiguration();
    const currentSdk = resolvePath(config.get<string>("mikroDesign.sdkPath"), getWorkspaceRoot()) ?? "";
    const currentApp = (config.get<string>("mikroDesign.appName") ?? "").trim();
    const currentCfg = (config.get<string>("mikroDesign.configName") ?? "").trim();
    const currentToolchain = (config.get<string>("mikroDesign.toolchain") ?? "").trim();
    const currentElf = resolvePath(config.get<string>("mikroDesign.elfPath"), getWorkspaceRoot()) ?? "";
    if (currentSdk !== inferred.sdkPath) {
      await setConfigValue("mikroDesign.sdkPath", inferred.sdkPath);
      output.appendLine(`[SDK] Set sdkPath to ${inferred.sdkPath}`);
    }
    if (currentApp !== inferred.appName) {
      await setConfigValue("mikroDesign.appName", inferred.appName);
      output.appendLine(`[SDK] Set appName to ${inferred.appName}`);
    }
    if (currentCfg !== inferred.configName) {
      await setConfigValue("mikroDesign.configName", inferred.configName);
      output.appendLine(`[SDK] Set configName to ${inferred.configName}`);
    }
    if (!currentToolchain || currentToolchain !== inferred.toolchain) {
      await setConfigValue("mikroDesign.toolchain", inferred.toolchain);
      output.appendLine(`[SDK] Set toolchain to ${inferred.toolchain}`);
    }
    if (currentElf !== inferred.elfPath) {
      await setConfigValue("mikroDesign.elfPath", inferred.elfPath);
      output.appendLine(`[SDK] Set elfPath to ${inferred.elfPath}`);
    }
  }
  const config = vscode.workspace.getConfiguration();
  const appNameSetting = config.get<string>("mikroDesign.appName") ?? "";
  const appNameFromEditor = appFromEditor(sdkPath);
  if (appNameFromEditor && appNameFromEditor !== appNameSetting) {
    await setConfigValue("mikroDesign.appName", appNameFromEditor);
    output.appendLine(`[SDK] Set appName to ${appNameFromEditor}`);
  }

  const appName = appNameFromEditor || appNameSetting;
  if (!appName) {
    return;
  }
  const appDir = path.join(sdkPath, "app", appName);
  const scan = scanAppConfig(appDir);
  const configNameSetting = config.get<string>("mikroDesign.configName") ?? "";
  const toolchainSetting = config.get<string>("mikroDesign.toolchain") ?? "";
  if (!configNameSetting && scan.defaultConfig) {
    await setConfigValue("mikroDesign.configName", scan.defaultConfig);
    output.appendLine(`[SDK] Set configName to ${scan.defaultConfig}`);
  }
  if (!toolchainSetting && scan.defaultToolchain) {
    await setConfigValue("mikroDesign.toolchain", scan.defaultToolchain);
    output.appendLine(`[SDK] Set toolchain to ${scan.defaultToolchain}`);
  }
}

export async function ensureBuildInfo(output: vscode.OutputChannel): Promise<MikroBuildInfo | null> {
  const sdkPath = await ensureSdkPath(output);
  if (!sdkPath) {
    return null;
  }
  const config = vscode.workspace.getConfiguration();
  const inferred = inferBuildPathFromContext(sdkPath);
  if (inferred) {
    const currentApp = (config.get<string>("mikroDesign.appName") ?? "").trim();
    const currentCfg = (config.get<string>("mikroDesign.configName") ?? "").trim();
    const currentToolchain = (config.get<string>("mikroDesign.toolchain") ?? "").trim();
    const currentElf = resolvePath(config.get<string>("mikroDesign.elfPath"), getWorkspaceRoot()) ?? "";
    if (!currentApp || currentApp !== inferred.appName) {
      await setConfigValue("mikroDesign.appName", inferred.appName);
      output.appendLine(`[SDK] Set appName to ${inferred.appName}`);
    }
    if (!currentCfg || currentCfg !== inferred.configName) {
      await setConfigValue("mikroDesign.configName", inferred.configName);
      output.appendLine(`[SDK] Set configName to ${inferred.configName}`);
    }
    if (!currentToolchain || currentToolchain !== inferred.toolchain) {
      await setConfigValue("mikroDesign.toolchain", inferred.toolchain);
      output.appendLine(`[SDK] Set toolchain to ${inferred.toolchain}`);
    }
    if (currentElf !== inferred.elfPath) {
      await setConfigValue("mikroDesign.elfPath", inferred.elfPath);
      output.appendLine(`[SDK] Set elfPath to ${inferred.elfPath}`);
    }
    return {
      sdkPath: inferred.sdkPath,
      appName: inferred.appName,
      configName: inferred.configName,
      toolchain: inferred.toolchain,
      appDir: path.join(inferred.sdkPath, "app", inferred.appName),
      elfPath: inferred.elfPath,
    };
  }

  let appName = (config.get<string>("mikroDesign.appName") ?? "").trim();
  if (!appName) {
    const apps = listApps(sdkPath);
    if (apps.length === 0) {
      vscode.window.showErrorMessage("No apps found under <sdk>/app.");
      return null;
    }
    const pick = await vscode.window.showQuickPick(apps, {
      placeHolder: "Select ONiO app to build",
    });
    if (!pick) {
      return null;
    }
    appName = pick;
    await setConfigValue("mikroDesign.appName", appName);
    output.appendLine(`[SDK] Set appName to ${appName}`);
  }

  const appDir = path.join(sdkPath, "app", appName);
  const scan = scanAppConfig(appDir);
  let configName = (config.get<string>("mikroDesign.configName") ?? "").trim();
  if (!configName) {
    if (scan.configs.length) {
      const pick = await vscode.window.showQuickPick(scan.configs, {
        placeHolder: "Select config",
      });
      if (!pick) {
        return null;
      }
      configName = pick;
      await setConfigValue("mikroDesign.configName", configName);
      output.appendLine(`[SDK] Set configName to ${configName}`);
    } else if (scan.defaultConfig) {
      configName = scan.defaultConfig;
      await setConfigValue("mikroDesign.configName", configName);
      output.appendLine(`[SDK] Set configName to ${configName}`);
    }
  }

  let toolchain = (config.get<string>("mikroDesign.toolchain") ?? "").trim();
  if (!toolchain) {
    toolchain = scan.defaultToolchain || "GNU";
    await setConfigValue("mikroDesign.toolchain", toolchain);
    output.appendLine(`[SDK] Set toolchain to ${toolchain}`);
  }

  const elfPath = path.join(sdkPath, "build", appName, configName, toolchain, `${appName}.elf`);

  return {
    sdkPath,
    appName,
    configName,
    toolchain,
    appDir,
    elfPath,
  };
}

function findExecutableInPath(name: string): string | undefined {
  const pathVar = process.env.PATH ?? "";
  const parts = pathVar.split(path.delimiter);
  for (const part of parts) {
    if (!part) {
      continue;
    }
    const candidate = path.join(part, name);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

export interface ToolchainInfo {
  bin: string;
  source: string;
}

function resolveToolchainFromEnv(): ToolchainInfo | null {
  const envVars = [
    "RISCV_TOOLCHAIN_BIN",
    "RISCV32_TOOLCHAIN_BIN",
    "RISCV_TOOLCHAIN",
    "RISCV",
    "RISCV_GCC",
  ];
  for (const key of envVars) {
    const value = process.env[key];
    if (!value) {
      continue;
    }
    const candidate = value.trim();
    if (!candidate) {
      continue;
    }
    if (candidate.endsWith("riscv32-unknown-elf-gcc")) {
      const binDir = path.dirname(candidate);
      if (fs.existsSync(path.join(binDir, "riscv32-unknown-elf-gcc"))) {
        return { bin: binDir, source: `env:${key}` };
      }
      continue;
    }
    const binDir = candidate.endsWith(path.sep) ? candidate.slice(0, -1) : candidate;
    if (fs.existsSync(path.join(binDir, "riscv32-unknown-elf-gcc"))) {
      return { bin: binDir, source: `env:${key}` };
    }
    if (fs.existsSync(path.join(binDir, "bin", "riscv32-unknown-elf-gcc"))) {
      return { bin: path.join(binDir, "bin"), source: `env:${key}` };
    }
  }
  return null;
}

function scanOptToolchains(): ToolchainInfo | null {
  const optRoot = "/opt";
  if (!fs.existsSync(optRoot)) {
    return null;
  }
  const entries = fs.readdirSync(optRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  for (const entry of entries) {
    const base = path.join(optRoot, entry.name);
    const direct = path.join(base, "bin", "riscv32-unknown-elf-gcc");
    if (fs.existsSync(direct)) {
      return { bin: path.join(base, "bin"), source: `scan:${base}` };
    }
    const subdirs = fs.readdirSync(base, { withFileTypes: true }).filter((child) => child.isDirectory());
    for (const child of subdirs) {
      const nested = path.join(base, child.name, "bin", "riscv32-unknown-elf-gcc");
      if (fs.existsSync(nested)) {
        return { bin: path.join(base, child.name, "bin"), source: `scan:${path.join(base, child.name)}` };
      }
    }
  }
  return null;
}

function resolveToolchainFromConfig(): string | undefined {
  const config = vscode.workspace.getConfiguration();
  const raw = (config.get<string>("mikroDesign.toolchainBin") ?? "").trim();
  if (!raw) {
    return undefined;
  }
  const resolved = resolvePath(raw, getWorkspaceRoot());
  if (!resolved) {
    return undefined;
  }
  if (resolved.endsWith("riscv32-unknown-elf-gcc")) {
    const binDir = path.dirname(resolved);
    if (fs.existsSync(path.join(binDir, "riscv32-unknown-elf-gcc"))) {
      return binDir;
    }
  }
  if (fs.existsSync(path.join(resolved, "riscv32-unknown-elf-gcc"))) {
    return resolved;
  }
  if (fs.existsSync(path.join(resolved, "bin", "riscv32-unknown-elf-gcc"))) {
    return path.join(resolved, "bin");
  }
  return undefined;
}

export function resolveToolchainBin(): string | undefined {
  const fromConfig = resolveToolchainFromConfig();
  if (fromConfig) {
    return fromConfig;
  }
  const inPath = findExecutableInPath("riscv32-unknown-elf-gcc");
  if (inPath) {
    return path.dirname(inPath);
  }
  const envToolchain = resolveToolchainFromEnv();
  if (envToolchain) {
    return envToolchain.bin;
  }
  const candidates = [
    "/opt/riscv/bin",
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, "riscv32-unknown-elf-gcc"))) {
      return candidate;
    }
  }
  const optScan = scanOptToolchains();
  if (optScan) {
    return optScan.bin;
  }
  return undefined;
}

export function detectToolchainInfo(): ToolchainInfo | null {
  const inPath = findExecutableInPath("riscv32-unknown-elf-gcc");
  if (inPath) {
    return { bin: path.dirname(inPath), source: "PATH" };
  }
  const envToolchain = resolveToolchainFromEnv();
  if (envToolchain) {
    return envToolchain;
  }
  const candidates = [
    "/opt/riscv/bin",
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, "riscv32-unknown-elf-gcc"))) {
      return { bin: candidate, source: `candidate:${candidate}` };
    }
  }
  const optScan = scanOptToolchains();
  if (optScan) {
    return optScan;
  }
  return null;
}

export function resolveBuildInfo(output: vscode.OutputChannel): MikroBuildInfo | null {
  const config = vscode.workspace.getConfiguration();
  const sdkPathRaw = config.get<string>("mikroDesign.sdkPath");
  const appName = (config.get<string>("mikroDesign.appName") ?? "").trim();
  const configName = (config.get<string>("mikroDesign.configName") ?? "").trim();
  const toolchainSetting = (config.get<string>("mikroDesign.toolchain") ?? "").trim();

  let sdkPath = resolvePath(sdkPathRaw, getWorkspaceRoot());
  if (!sdkPath || !fs.existsSync(sdkPath) || !isValidSdkRoot(sdkPath)) {
    // Configured path missing or not a valid SDK root — try walking up.
    const workspaceRoot = getWorkspaceRoot();
    sdkPath = workspaceRoot ? findSdkRootUpwards(workspaceRoot) : undefined;
    if (!sdkPath) {
      return null;
    }
  }
  const inferred = inferBuildPathFromContext(sdkPath);
  if (inferred) {
    output.appendLine(`[SDK] sdkPath=${inferred.sdkPath}`);
    output.appendLine(
      `[SDK] app=${inferred.appName} config=${inferred.configName} toolchain=${inferred.toolchain}`
    );
    output.appendLine(`[SDK] elf=${inferred.elfPath}`);
    return {
      sdkPath: inferred.sdkPath,
      appName: inferred.appName,
      configName: inferred.configName,
      toolchain: inferred.toolchain,
      appDir: path.join(inferred.sdkPath, "app", inferred.appName),
      elfPath: inferred.elfPath,
    };
  }
  if (!appName) {
    // Don't show error - just return null silently
    return null;
  }

  const appDir = path.join(sdkPath, "app", appName);
  if (!fs.existsSync(appDir)) {
    // Don't show error - just return null silently
    return null;
  }

  const scan = scanAppConfig(appDir);
  const effectiveConfig = configName || scan.defaultConfig;
  if (!effectiveConfig) {
    // Don't show error - just return null silently
    return null;
  }
  if (!scan.configs.includes(effectiveConfig)) {
    // Don't show error - just return null silently
    return null;
  }

  const toolchain = toolchainSetting || scan.defaultToolchain || "GNU";
  const elfPath = path.join(sdkPath, "build", appName, effectiveConfig, toolchain, `${appName}.elf`);

  output.appendLine(`[SDK] sdkPath=${sdkPath}`);
  output.appendLine(`[SDK] app=${appName} config=${effectiveConfig} toolchain=${toolchain}`);
  output.appendLine(`[SDK] elf=${elfPath}`);

  return {
    sdkPath,
    appName,
    configName: effectiveConfig,
    toolchain,
    appDir,
    elfPath,
  };
}

export function createBuildTask(info: MikroBuildInfo): vscode.Task {
  const definition: vscode.TaskDefinition = {
    type: "mikroDesign",
    task: "build",
    app: info.appName,
    config: info.configName,
    toolchain: info.toolchain,
    sdkPath: info.sdkPath,
  };

  const args = ["clean", "all", `CONFIG=${info.configName}`, `TOOLCHAIN=${info.toolchain}`];
  const env: { [key: string]: string } = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  const toolchainBin = resolveToolchainBin();
  if (toolchainBin) {
    env.PATH = `${toolchainBin}${path.delimiter}${env.PATH ?? ""}`;
  }
  const execution = new vscode.ShellExecution("make", args, { cwd: info.appDir, env });
  const task = new vscode.Task(
    definition,
    vscode.TaskScope.Workspace,
    `Build ${info.appName} (${info.configName})`,
    "mikroDesign",
    execution
  );
  task.group = vscode.TaskGroup.Build;
  return task;
}

export async function buildFirmware(output: vscode.OutputChannel): Promise<MikroBuildInfo | null> {
  const info = await ensureBuildInfo(output);
  if (!info) {
    return null;
  }
  const task = createBuildTask(info);
  const execution = await vscode.tasks.executeTask(task);
  const exitCode = await waitForTask(execution);
  if (exitCode !== 0) {
    vscode.window.showErrorMessage("Build failed.");
    return null;
  }
  return info;
}

export async function promptForSdkConfig(output: vscode.OutputChannel): Promise<MikroBuildInfo | null> {
  return ensureBuildInfo(output);
}

function waitForTask(execution: vscode.TaskExecution): Promise<number | undefined> {
  return new Promise((resolve) => {
    const disposable = vscode.tasks.onDidEndTaskProcess((event) => {
      if (event.execution === execution) {
        disposable.dispose();
        resolve(event.exitCode);
      }
    });
  });
}

export class MikroTaskProvider implements vscode.TaskProvider {
  constructor(private readonly output: vscode.OutputChannel) {}

  provideTasks(): vscode.Task[] {
    const info = resolveBuildInfo(this.output);
    if (!info) {
      return [];
    }
    return [createBuildTask(info)];
  }

  resolveTask(task: vscode.Task): vscode.Task | undefined {
    return task;
  }
}
