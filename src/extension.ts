import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { SvdTreeProvider } from "./registerTree";
import { AssertCodeLensProvider } from "./assertLens";
import { AssertMode, Rv32SimController } from "./rv32simController";
import {
  MikroTaskProvider,
  resolveBuildInfo,
  createBuildTask,
  ensureBuildInfo,
  autoConfigureFromActiveEditor,
  detectToolchainInfo,
  listApps,
  scanAppConfig,
  resolveToolchainBin,
} from "./sdkBuild";
import { MikroDebugConfigurationProvider } from "./debug";
import { getWorkspaceRoot, resolvePath } from "./utils";
import { AssertPrompt } from "./assertPrompt";
import { AssertTraceStore, AssertTracePanel, AssertLocation, AssertRecommendation as TraceRecommendation } from "./assertTrace";
import { deriveMemRegionsFromElf } from "./memMap";
import { configureAssertSettings } from "./assertConfig";
import { parseSvd } from "./svd";

function sanitizeEnv(env: NodeJS.ProcessEnv): { [key: string]: string } {
  const filtered: { [key: string]: string } = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      filtered[key] = value;
    }
  }
  return filtered;
}

class Rv32SimDebugAdapterFactory implements vscode.DebugAdapterDescriptorFactory {
  constructor(private readonly context: vscode.ExtensionContext) {}

  createDebugAdapterDescriptor(_session: vscode.DebugSession): vscode.DebugAdapterDescriptor {
    const adapterPath = path.join(this.context.extensionPath, "out", "rv32simDebugAdapter.js");
    const env = sanitizeEnv(process.env);
    const logPath = path.join(getWorkspaceRoot() ?? this.context.extensionPath, ".mikro-adapter.log");
    env.MIKRO_DEBUG_ADAPTER_LOG = logPath;
    return new vscode.DebugAdapterExecutable(process.execPath, [adapterPath], {
      env,
    });
  }
}

type AssertPickAction = "default" | "ignore" | "decision" | "hint" | "separator";
type AssertPickItem = vscode.QuickPickItem & { action?: AssertPickAction; input?: string };
type AssertRecommendation = { action: AssertPickAction; input?: string; reason: string };
type AssertRegister = { name: string; value: string };

class AssertHelperPanel implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | null = null;
  private prompt: AssertPrompt | null = null;
  private recommendation: AssertRecommendation | null = null;
  private registers: AssertRegister[] = [];
  private messageDisposable: vscode.Disposable | null = null;
  private lastStateKey = "";
  private revealInFlight = false;

  constructor(private readonly controller: Rv32SimController) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    token: vscode.CancellationToken
  ): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [],
    };
    webviewView.webview.html = renderAssertHelperShellHtml(webviewView.webview);

    // Dispose old message handler if exists
    if (this.messageDisposable) {
      this.messageDisposable.dispose();
    }

    this.messageDisposable = webviewView.webview.onDidReceiveMessage((message) => {
      if (!this.prompt) {
        return;
      }
      if (message?.type === "select") {
        const input = String(message.value ?? "");
        this.controller.sendAssertResponse(input);
      }
    });

    webviewView.onDidDispose(() => {
      if (this.messageDisposable) {
        this.messageDisposable.dispose();
        this.messageDisposable = null;
      }
      this.view = null;
    });

    this.postState();
  }

  show(prompt: AssertPrompt, recommendation: AssertRecommendation | null, registers: AssertRegister[] = []): void {
    this.prompt = prompt;
    this.recommendation = recommendation;
    this.registers = registers;

    // If unresolved, keep prompt state and render when the view resolves.
    if (!this.view) {
      return;
    } else {
      this.postState();
    }
  }

  reveal(): void {
    if (this.view && typeof this.view.show === "function") {
      this.view.show(true);
      return;
    }
    if (this.revealInFlight) {
      return;
    }
    this.revealInFlight = true;
    void vscode.commands.executeCommand("mikroDesign.assertHelper.focus").then(
      () => {
        this.revealInFlight = false;
      },
      () => {
        this.revealInFlight = false;
      }
    );
  }

  clear(): void {
    this.prompt = null;
    this.recommendation = null;
    this.registers = [];
    this.lastStateKey = "";
    this.postState();
  }

  private postState(): void {
    if (!this.view || !this.view.webview) {
      return;
    }
    const stateKey = this.buildRenderKey();
    if (stateKey === this.lastStateKey) {
      return;
    }
    this.lastStateKey = stateKey;
    try {
      this.view.webview.postMessage({
        type: "state",
        prompt: this.prompt,
        recommendation: this.recommendation,
        registers: this.registers,
      });
    } catch (err) {
      // Webview may not be ready yet
    }
  }

  dispose(): void {
    if (this.messageDisposable) {
      this.messageDisposable.dispose();
      this.messageDisposable = null;
    }
    this.prompt = null;
    this.recommendation = null;
    this.registers = [];
    this.view = null;
    this.lastStateKey = "";
    this.revealInFlight = false;
  }

  private buildRenderKey(): string {
    if (!this.prompt) {
      return "empty";
    }
    const prompt = this.prompt;
    const decisionKey = prompt.decisions.map((item) => `${item.input}|${item.target}`).join(",");
    const hintsKey = prompt.hints.join("|");
    const recommendationKey = this.recommendation
      ? `${this.recommendation.action}|${this.recommendation.input ?? ""}|${this.recommendation.reason}`
      : "none";
    return [
      prompt.type,
      prompt.addr.toString(16),
      prompt.size.toString(10),
      prompt.pc.toString(16),
      prompt.register ?? "",
      prompt.peripheral ?? "",
      prompt.reset ?? "",
      prompt.fields ?? "",
      prompt.value ?? "",
      hintsKey,
      decisionKey,
      recommendationKey,
      this.registers.map((item) => `${item.name}=${item.value}`).join("|"),
    ].join("::");
  }
}

function describeAssertPrompt(prompt: AssertPrompt): { title: string; placeHolder: string } {
  const title = `MMIO ${prompt.type.toUpperCase()} 0x${prompt.addr.toString(16)} size=${prompt.size} pc=0x${prompt.pc.toString(16)}`;
  const parts: string[] = [];
  if (prompt.register) {
    parts.push(`Register: ${prompt.register}`);
  } else if (prompt.peripheral) {
    parts.push(`Peripheral: ${prompt.peripheral}`);
  }
  if (prompt.reset) {
    parts.push(`Reset: ${prompt.reset}`);
  }
  if (prompt.fields) {
    parts.push(`Fields: ${prompt.fields}`);
  }
  return { title, placeHolder: parts.join(" | ") };
}

function recommendAssertAction(prompt: AssertPrompt): AssertRecommendation | null {
  const hints = prompt.hints.join(" ").toLowerCase();
  if (prompt.decisions.length === 1) {
    return {
      action: "decision",
      input: prompt.decisions[0].input,
      reason: "Only one decision option available.",
    };
  }
  if (hints.includes("no branch uses this value")) {
    return { action: "default", reason: "No branch uses this value in the next instructions." };
  }
  if (prompt.type === "write") {
    if (hints.includes("write-only register")) {
      return { action: "ignore", reason: "Write-only register; ignoring is typically safe." };
    }
    return { action: "default", reason: "Default equals the written value." };
  }
  if (prompt.reset) {
    return { action: "default", reason: `Reset value available (${prompt.reset}).` };
  }
  return { action: "default", reason: "Default is a safe starting point." };
}

async function showAssertQuickPick(
  prompt: AssertPrompt,
  controller: Rv32SimController,
  recommendation: AssertRecommendation | null
): Promise<void> {
  const items: AssertPickItem[] = [];
  const defaultValue = prompt.type === "write" ? prompt.value ?? "0x0" : prompt.reset ?? "0x0";
  const defaultDesc =
    prompt.type === "write" ? `Use write value ${defaultValue}` : `Use reset ${defaultValue}`;
  const defaultLabel =
    recommendation?.action === "default" ? "Default (Enter) — recommended" : "Default (Enter)";
  items.push({ label: defaultLabel, description: defaultDesc, action: "default" });
  items.push({ label: "Ignore (-)", description: "Ignore this access", action: "ignore" });

  if (prompt.decisions.length) {
    items.push({ label: "— Decisions —", action: "separator" });
    for (const decision of prompt.decisions) {
      const detail = [decision.note, decision.targetAsm].filter(Boolean).join(" | ");
      items.push({
        label: decision.input,
        description: decision.target,
        detail: detail || undefined,
        action: "decision",
        input: decision.input,
      });
    }
  }

  if (prompt.hints.length) {
    items.push({ label: "— Hints —", action: "separator" });
    for (const hint of prompt.hints) {
      items.push({ label: `Hint: ${hint}`, action: "hint" });
    }
  }

  const meta = describeAssertPrompt(prompt);
  const recommendText = recommendation ? ` • Recommended: ${recommendation.action}` : "";
  const pick = await vscode.window.showQuickPick<AssertPickItem>(items, {
    placeHolder: meta.placeHolder
      ? `${meta.title}${recommendText} • ${meta.placeHolder}`
      : `${meta.title}${recommendText}`,
    ignoreFocusOut: true,
  });
  if (!pick) {
    return;
  }
  if (pick.action === "separator" || pick.action === "hint") {
    return;
  }
  if (pick.action === "default") {
    controller.sendAssertResponse("");
    return;
  }
  if (pick.action === "ignore") {
    controller.sendAssertResponse("-");
    return;
  }
  if (pick.action === "decision" && pick.input) {
    controller.sendAssertResponse(pick.input);
  }
}

// Global cleanup state
let globalCleanupHandlers: (() => void)[] = [];
let mikroSelectedThreadRunning = false;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  globalCleanupHandlers = [];
  mikroSelectedThreadRunning = false;
  const output = vscode.window.createOutputChannel("rv32sim");
  output.appendLine("[Mikro] Extension activated");
  appendDebugLog("Extension activated");
  void dockAssertViewsToRightSidebar();
  if (process.env.MIKRO_DEBUG_EXTENSIONS === "1") {
    const ids = vscode.extensions.all.map((ext) => ext.id).sort().join(", ");
    const logPath = path.join(getWorkspaceRoot() ?? process.cwd(), ".mikro-debug.log");
    try {
      fs.appendFileSync(logPath, `${new Date().toISOString()} extensions: ${ids}\n`);
    } catch {
      // ignore
    }
    output.appendLine(`[Mikro] Extensions: ${ids}`);
  }
  const svdTree = new SvdTreeProvider(output);
  const simController = new Rv32SimController(output);
  const codeLensProvider = new AssertCodeLensProvider(simController);
  const traceStore = new AssertTraceStore(getConfig<number>("mikroDesign.assertTraceMaxEntries") ?? 200);
  const tracePanel = new AssertTracePanel(context, traceStore, async (path, line) => {
    const uri = vscode.Uri.file(path);
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    const targetLine = Math.max(0, line - 1);
    const range = new vscode.Range(targetLine, 0, targetLine, 0);
    editor.selection = new vscode.Selection(range.start, range.end);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
  });
  const taskProvider = new MikroTaskProvider(output);
  const debugProvider = new MikroDebugConfigurationProvider(simController, output, context.extensionPath);
  const traceStoreWatcher = traceStore.onDidChange(() => tracePanel.refresh());

  context.subscriptions.push(traceStoreWatcher);
  context.subscriptions.push({ dispose: () => traceStore.dispose() });
  context.subscriptions.push({ dispose: () => tracePanel.dispose() });

  const treeView = vscode.window.createTreeView("mikroDesign.registerMap", {
    treeDataProvider: svdTree,
  });
  const traceViewProvider = vscode.window.registerWebviewViewProvider("mikroDesign.assertTrace", tracePanel);
  context.subscriptions.push(traceViewProvider);
  let svdViewVisible = false;
  let loadedSvdPath: string | null = null;
  let debugSessionActive = vscode.debug.activeDebugSession?.type === "mikroDesign";
  const declinedSvdSwitches = new Set<string>();

  const setMikroSessionContext = (active: boolean) => {
    void vscode.commands.executeCommand("setContext", "mikroDesignSessionActive", active);
  };
  setMikroSessionContext(debugSessionActive);

  const maybeLoadSvd = async () => {
    if (!svdViewVisible || !debugSessionActive) {
      return;
    }
    const svdPath = resolvePath(getConfig<string>("mikroDesign.svdPath"));
    if (!svdPath || !fs.existsSync(svdPath)) {
      return;
    }
    if (svdPath !== loadedSvdPath) {
      svdTree.loadFromFile(svdPath);
      loadedSvdPath = svdPath;
    }
  };

  const svdContainsAddress = (svdPath: string, address: number): boolean => {
    try {
      const content = fs.readFileSync(svdPath, "utf8");
      const device = parseSvd(content);
      for (const peripheral of device.peripherals) {
        for (const reg of peripheral.registers) {
          const sizeBytes = Math.max(1, Math.ceil(reg.sizeBits / 8));
          if (address >= reg.address && address < reg.address + sizeBytes) {
            return true;
          }
        }
      }
    } catch {
      // ignore parse failures
    }
    return false;
  };

  const resolveSvdCandidates = (): string[] => {
    const workspaceRoot = getWorkspaceRoot();
    const sdkPath = resolvePath(getConfig<string>("mikroDesign.sdkPath"));
    const configured = resolvePath(getConfig<string>("mikroDesign.svdPath"));
    const candidates = [
      configured,
      sdkPath ? path.join(sdkPath, "chip", "pegasus_v3", "core", "regdef.svd") : undefined,
      workspaceRoot ? path.join(workspaceRoot, "chip", "pegasus_v3", "core", "regdef.svd") : undefined,
      "/home/veba/work/gitlab/onio.firmware.c/chip/pegasus_v3/core/regdef.svd",
    ].filter((entry): entry is string => !!entry);
    const unique: string[] = [];
    const seen = new Set<string>();
    for (const candidate of candidates) {
      if (seen.has(candidate)) {
        continue;
      }
      seen.add(candidate);
      unique.push(candidate);
    }
    return unique;
  };

  const maybeRepairSvdForAddress = async (address: number): Promise<void> => {
    await maybeLoadSvd();
    if (svdTree.findRegisterByAddress(address)) {
      return;
    }
    const current = resolvePath(getConfig<string>("mikroDesign.svdPath"));
    const candidates = resolveSvdCandidates().filter(
      (candidate) => candidate !== current && fs.existsSync(candidate)
    );
    const match = candidates.find((candidate) => svdContainsAddress(candidate, address));
    if (!match) {
      return;
    }
    const key = `${current ?? "<none>"}=>${match}@${address.toString(16)}`;
    if (declinedSvdSwitches.has(key)) {
      return;
    }
    await updateConfig("mikroDesign.svdPath", match);
    loadedSvdPath = match;
    if (svdViewVisible || debugSessionActive) {
      svdTree.loadFromFile(match);
    }
    output.appendLine(`[SVD] Auto-switched SVD for MMIO 0x${address.toString(16)} -> ${match}`);
    void vscode.window.showInformationMessage(
      `Mikro SVD auto-switched for MMIO 0x${address.toString(16)}`
    );
  };

  let isRevealing = false;
  const treeVisibilityWatcher = treeView.onDidChangeVisibility(async (event) => {
    if (!event.visible) {
      svdViewVisible = false;
      return;
    }
    svdViewVisible = true;
    if (debugSessionActive && !isRevealing) {
      isRevealing = true;
      try {
        await maybeLoadSvd();
        await revealSvdRoot(treeView, svdTree);
      } finally {
        isRevealing = false;
      }
    } else if (!debugSessionActive) {
      svdTree.clear();
      loadedSvdPath = null;
    }
  });

  let mikroSidebarOpened = false;
  const debugSessionWatcher = vscode.debug.onDidChangeActiveDebugSession((session) => {
    svdTree.setDebugSession(session ?? null);
    debugSessionActive = session?.type === "mikroDesign";
    setMikroSessionContext(debugSessionActive);
    if (!debugSessionActive) {
      mikroSelectedThreadRunning = false;
      svdTree.clear();
      loadedSvdPath = null;
      mikroSidebarOpened = false;
      return;
    }
    if (debugSessionActive && !mikroSidebarOpened) {
      // Show debug sidebar when debugging starts
      mikroSidebarOpened = true;
      // Don't auto-toggle - let user manually position sidebar on right if desired
    }
    if (svdViewVisible && !isRevealing) {
      isRevealing = true;
      void (async () => {
        try {
          await maybeLoadSvd();
          await revealSvdRoot(treeView, svdTree);
        } finally {
          isRevealing = false;
        }
      })();
    }
  });

  const debugTrackerFactory = vscode.debug.registerDebugAdapterTrackerFactory("mikroDesign", {
    createDebugAdapterTracker(session) {
      svdTree.setDebugSession(session);
      return {
        onDidSendMessage: (message) => {
          if (message?.type === "event" && message.event === "stopped") {
            mikroSelectedThreadRunning = false;
            svdTree.refreshValues(true);
            return;
          }
          if (message?.type === "event" && message.event === "continued") {
            mikroSelectedThreadRunning = true;
            return;
          }
          if (
            message?.type === "event" &&
            (message.event === "terminated" || message.event === "exited")
          ) {
            mikroSelectedThreadRunning = false;
          }
        },
        onExit: () => {
          mikroSelectedThreadRunning = false;
          if (vscode.debug.activeDebugSession?.id === session.id) {
            svdTree.setDebugSession(null);
          }
        },
      };
    },
  });

  context.subscriptions.push(
    output,
    treeView,
    traceViewProvider,
    treeVisibilityWatcher,
    debugSessionWatcher,
    debugTrackerFactory,
    traceStoreWatcher,
    vscode.tasks.registerTaskProvider("mikroDesign", taskProvider),
    vscode.debug.registerDebugConfigurationProvider("mikroDesign", debugProvider),
    vscode.debug.registerDebugAdapterDescriptorFactory(
      "mikroDesign",
      new Rv32SimDebugAdapterFactory(context)
    ),
    vscode.languages.registerCodeLensProvider(
      [
        { language: "c" },
        { language: "cpp" },
        { language: "asm" },
        { language: "s" },
      ],
      codeLensProvider
    )
  );
  svdTree.setDebugSession(vscode.debug.activeDebugSession ?? null);

  let autoPromptTimer: NodeJS.Timeout | undefined;
  let autoApplyTimer: NodeJS.Timeout | undefined;
  let autoPromptKey: string | null = null;
  let latestPrompt: AssertPrompt | null = null;
  let autoPromptInFlight = false;
  let pauseOnAssertKey: string | null = null;
  const assertRegistersByKey = new Map<string, AssertRegister[]>();
  const assertPanel = new AssertHelperPanel(simController);
  const helperViewProvider = vscode.window.registerWebviewViewProvider("mikroDesign.assertHelper", assertPanel);
  context.subscriptions.push(helperViewProvider);

  const clearTimers = () => {
    if (autoPromptTimer) {
      clearTimeout(autoPromptTimer);
      autoPromptTimer = undefined;
    }
    if (autoApplyTimer) {
      clearTimeout(autoApplyTimer);
      autoApplyTimer = undefined;
    }
  };

  globalCleanupHandlers.push(() => {
    clearTimers();
    assertPanel.dispose();
    simController.dispose();
  });

  simController.onPromptChanged(async (prompt) => {
    if (prompt) {
      await maybeRepairSvdForAddress(prompt.addr);
    }
    svdTree.setActiveAddress(prompt ? prompt.addr : null);
    // Don't auto-reveal location to avoid focus fighting
    if (!prompt) {
      latestPrompt = null;
      autoPromptKey = null;
      pauseOnAssertKey = null;
      autoPromptInFlight = false;
      assertRegistersByKey.clear();
      clearTimers();
      assertPanel.clear();
      return;
    }
    latestPrompt = prompt;
    if (prompt.type === "write") {
      return;
    }
    const promptReady = isAssertPromptReady(prompt);
    const pauseOnAssert = getConfig<boolean>("mikroDesign.pauseOnAssert") ?? true;
    const key = `${prompt.type}:${prompt.addr}:${prompt.size}:${prompt.pc}`;
    if (pauseOnAssert && promptReady) {
      if (pauseOnAssertKey !== key) {
        pauseOnAssertKey = key;
        await forcePauseOnAssert();
      }
    }
    if (!promptReady) {
      return;
    }
    const showPanel = getConfig<boolean>("mikroDesign.assertShowPanel") ?? true;
    const autoShowTrace = getConfig<boolean>("mikroDesign.assertTraceAutoShow") ?? true;
    const autoApply = getConfig<boolean>("mikroDesign.assertAutoApplyRecommendation") ?? false;
    const recommendation = recommendAssertAction(prompt);
    let location: AssertLocation | null = null;
    try {
      const loc = await codeLensProvider.getPromptLocation();
      if (loc) {
        location = { path: loc.uri.fsPath, line: loc.line + 1 };
      }
    } catch {
      // ignore mapping failures
    }
    let registers = assertRegistersByKey.get(key);
    if (!registers) {
      registers = await captureAssertRegisters();
      if (registers.length) {
        assertRegistersByKey.set(key, registers);
      }
    }
    traceStore.upsertPrompt(prompt, location, recommendation as TraceRecommendation, registers);

    // Update and optionally reveal helper panel on actionable prompt.
    assertPanel.show(prompt, recommendation, registers ?? []);
    if (showPanel) {
      assertPanel.reveal();
    }
    if (process.env.MIKRO_DEBUG_EXTENSIONS === "1") {
      appendDebugLog("assert helper panel shown");
    }
    tracePanel.refresh();
    if (autoShowTrace) {
      tracePanel.reveal();
    }
    // Disable auto-prompt quick pick - use sidebar panels instead
    if (autoPromptKey === key) {
      return;
    }
    autoPromptKey = key;
  });

  const assertResponseWatcher = simController.onAssertResponse((event) => {
    traceStore.markResponse(event.prompt, event.response);
    const resumeOnAssert = getConfig<boolean>("mikroDesign.resumeOnAssertResponse") ?? false;
    if (resumeOnAssert) {
      void resumeDebugSession();
    }
  });

  const debugStartWatcher = vscode.debug.onDidStartDebugSession(async (session) => {
    if (session.type !== "mikroDesign") {
      return;
    }
    mikroSelectedThreadRunning = false;
    setMikroSessionContext(true);
    await dockAssertViewsToRightSidebar();
    const showPanel = getConfig<boolean>("mikroDesign.assertShowPanel") ?? true;
    const autoShowTrace = getConfig<boolean>("mikroDesign.assertTraceAutoShow") ?? true;
    if (showPanel) {
      assertPanel.reveal();
    }
    if (autoShowTrace) {
      tracePanel.reveal();
    }
  });

  const selectSvdCommand = vscode.commands.registerCommand("mikroDesign.selectSvd", async () => {
    const uri = await vscode.window.showOpenDialog({
      canSelectMany: false,
      filters: { SVD: ["svd"] },
    });
    if (!uri || uri.length === 0) {
      return;
    }
    const svdPath = uri[0].fsPath;
    await updateConfig("mikroDesign.svdPath", svdPath);
    if (svdViewVisible) {
      svdTree.loadFromFile(svdPath);
      loadedSvdPath = svdPath;
    } else {
      loadedSvdPath = null;
    }
    await focusSvdView(treeView);
    await maybeLoadSvd();
    await revealSvdRoot(treeView, svdTree);
  });

  const refreshSvdCommand = vscode.commands.registerCommand("mikroDesign.refreshSvd", async () => {
    const svdPath = getConfig<string>("mikroDesign.svdPath");
    if (!svdPath) {
      vscode.window.showWarningMessage("No SVD path configured.");
      return;
    }
    const resolved = resolvePath(svdPath);
    if (!resolved || !fs.existsSync(resolved)) {
      vscode.window.showWarningMessage("SVD path not found.");
      return;
    }
    if (svdViewVisible) {
      svdTree.loadFromFile(resolved);
      loadedSvdPath = resolved;
    } else {
      loadedSvdPath = null;
    }
    await focusSvdView(treeView);
    await maybeLoadSvd();
    await revealSvdRoot(treeView, svdTree);
  });

  const startSimCommand = vscode.commands.registerCommand("mikroDesign.startSim", async () => {
    const config = vscode.workspace.getConfiguration();
    const svdPath = resolvePath(config.get<string>("mikroDesign.svdPath"));
    const elfPath = resolvePath(config.get<string>("mikroDesign.elfPath"));
    const assertFile = resolvePath(config.get<string>("mikroDesign.assertFile"));

    const assertMode = (config.get<string>("mikroDesign.assertMode") ?? "assist") as AssertMode;
    simController.start({
      rv32simPath: config.get<string>("mikroDesign.rv32simPath") ?? "../rv32sim/rv32sim.py",
      pythonPath: config.get<string>("mikroDesign.pythonPath") ?? "python3",
      gdbPort: config.get<number>("mikroDesign.gdbPort") ?? 3333,
      gdbMmioReads: config.get<boolean>("mikroDesign.gdbMmioReads") ?? true,
      strictMode: config.get<boolean>("mikroDesign.strictMode") ?? false,
      svdPath,
      elfPath,
      memRegions: (() => {
        const memRegionsSetting = config.get<string[]>("mikroDesign.memRegions") ?? [];
        if (memRegionsSetting.length) {
          return memRegionsSetting;
        }
        const toolchainBin = resolveToolchainBin();
        return elfPath ? deriveMemRegionsFromElf(elfPath, toolchainBin) : [];
      })(),
      assertMode,
      assertFile,
      assertShowAsm: config.get<boolean>("mikroDesign.assertShowAsm") ?? true,
      assertVerbose: config.get<boolean>("mikroDesign.assertVerbose") ?? false,
      assertWrites: config.get<boolean>("mikroDesign.assertWrites") ?? false,
    });
    output.show(true);
  });

  const buildCommand = vscode.commands.registerCommand("mikroDesign.buildFirmware", async () => {
    const info = await ensureBuildInfo(output);
    if (!info) {
      return;
    }
    const task = createBuildTask(info);
    await vscode.tasks.executeTask(task);
  });

  const detectToolchainCommand = vscode.commands.registerCommand("mikroDesign.detectToolchain", async () => {
    const info = detectToolchainInfo();
    if (!info) {
      vscode.window.showWarningMessage(
        "RISC-V toolchain not found. Set RISCV_TOOLCHAIN_BIN or update mikroDesign.sdkPath/toolchain settings."
      );
      return;
    }
    output.appendLine(`[Toolchain] bin=${info.bin} source=${info.source}`);
    vscode.window.showInformationMessage(`RISC-V toolchain: ${info.bin} (${info.source})`);
  });

  const debugCommand = vscode.commands.registerCommand("mikroDesign.debug", async () => {
    const config = vscode.workspace.getConfiguration();
    const clearBreakpoints = config.get<boolean>("mikroDesign.clearBreakpointsOnDebug") ?? true;
    if (clearBreakpoints) {
      clearExternalBreakpoints();
    }
    if (vscode.debug.activeDebugSession?.type === "mikroDesign") {
      await vscode.commands.executeCommand("workbench.action.debug.stop");
    }
    const configs = await debugProvider.provideDebugConfigurations();
    if (!configs.length) {
      vscode.window.showErrorMessage("No Mikro debug configuration available.");
      return;
    }
    const ok = await vscode.debug.startDebugging(undefined, configs[0]);
    appendDebugLog(`startDebugging result=${ok} type=${configs[0].type}`);
  });

  const smartContinueCommand = vscode.commands.registerCommand("mikroDesign.debug.smartContinue", async () => {
    await continueDebugSessionSafe();
  });

  const stopSimCommand = vscode.commands.registerCommand("mikroDesign.stopSim", () => {
    simController.stop();
  });

  const selectAssertFileCommand = vscode.commands.registerCommand("mikroDesign.selectAssertFile", async () => {
    const config = vscode.workspace.getConfiguration();
    const elfPath = resolvePath(config.get<string>("mikroDesign.elfPath"));
    const suggestedPath = elfPath
      ? path.join(path.dirname(elfPath), `${path.basename(elfPath, ".elf")}.assert.json`)
      : undefined;
    const result = await configureAssertSettings("select", { suggestedPath });
    if (result) {
      output.appendLine(`[SIM] Assert file set to ${result}`);
    }
  });

  const createAssertFileCommand = vscode.commands.registerCommand("mikroDesign.createAssertFile", async () => {
    const config = vscode.workspace.getConfiguration();
    const elfPath = resolvePath(config.get<string>("mikroDesign.elfPath"));
    const suggestedPath = elfPath
      ? path.join(path.dirname(elfPath), `${path.basename(elfPath, ".elf")}.assert.json`)
      : undefined;
    const result = await configureAssertSettings("create", { suggestedPath });
    if (result) {
      output.appendLine(`[SIM] Assert file created at ${result}`);
    }
  });

  const runSetupProject = async (): Promise<void> => {
    if (!getWorkspaceRoot()) {
      const sdkPick = await pickSdkPath(undefined);
      if (!sdkPick) {
        return;
      }
      const uri = vscode.Uri.file(sdkPick);
      await vscode.commands.executeCommand("vscode.openFolder", uri, false);
      vscode.window.showInformationMessage(
        "Opened SDK folder. Re-run 'Mikro: Setup Project (SDK)' to finish setup."
      );
      return;
    }
    const config = vscode.workspace.getConfiguration();
    const sdkPick = await pickSdkPath(
      resolvePath(config.get<string>("mikroDesign.sdkPath")) ?? undefined
    );
    if (!sdkPick) {
      return;
    }
    await updateConfig("mikroDesign.sdkPath", sdkPick);

    const toolchainPick = await pickToolchainBin(
      resolvePath(config.get<string>("mikroDesign.toolchainBin")) ?? undefined
    );
    if (toolchainPick === null) {
      return;
    }
    if (toolchainPick !== undefined) {
      await updateConfig("mikroDesign.toolchainBin", toolchainPick);
      const gdbSetting = (config.get<string>("mikroDesign.gdbPath") ?? "").trim();
      const addr2lineSetting = (config.get<string>("mikroDesign.addr2linePath") ?? "").trim();
      const gdbPath = path.join(toolchainPick, "riscv32-unknown-elf-gdb");
      const addr2linePath = path.join(toolchainPick, "riscv32-unknown-elf-addr2line");
      if (!gdbSetting || gdbSetting === "riscv32-unknown-elf-gdb") {
        await updateConfig("mikroDesign.gdbPath", gdbPath);
      }
      if (!addr2lineSetting || addr2lineSetting === "riscv32-unknown-elf-addr2line") {
        await updateConfig("mikroDesign.addr2linePath", addr2linePath);
      }
    }

    const apps = listApps(sdkPick);
    if (!apps.length) {
      vscode.window.showErrorMessage("No apps found under <sdk>/app.");
      return;
    }
    const currentApp = (config.get<string>("mikroDesign.appName") ?? "").trim();
    const appName = await pickAppName(apps, currentApp);
    if (!appName) {
      return;
    }
    await updateConfig("mikroDesign.appName", appName);

    const appDir = path.join(sdkPick, "app", appName);
    const scan = scanAppConfig(appDir);
    if (!scan.configs.length && !scan.defaultConfig) {
      vscode.window.showErrorMessage(`No configs found in ${appDir}.`);
      return;
    }
    const currentConfig = (config.get<string>("mikroDesign.configName") ?? "").trim();
    const configName = await pickConfigName(scan, currentConfig);
    if (!configName) {
      return;
    }
    await updateConfig("mikroDesign.configName", configName);

    const currentToolchain = (config.get<string>("mikroDesign.toolchain") ?? "").trim();
    const toolchainName = await pickToolchainName(scan, currentToolchain);
    if (!toolchainName) {
      return;
    }
    await updateConfig("mikroDesign.toolchain", toolchainName);

    const targetInfo = parseTargetFromConfig(sdkPick, appName, configName);
    if (targetInfo?.target) {
      await updateConfig("mikroDesign.target", targetInfo.target);
    }

    const currentDebugTarget = (config.get<string>("mikroDesign.debugTarget") ?? "rv32sim").trim();
    const debugTarget = await pickDebugTarget(targetInfo, currentDebugTarget);
    if (!debugTarget) {
      return;
    }
    await updateConfig("mikroDesign.debugTarget", debugTarget);
    if (debugTarget === "rv32sim") {
      const rv32simPick = await pickRv32simPath(
        resolvePath(config.get<string>("mikroDesign.rv32simPath")),
        getWorkspaceRoot()
      );
      if (!rv32simPick) {
        return;
      }
      await updateConfig("mikroDesign.rv32simPath", rv32simPick);
    }

    const elfPath = path.join(sdkPick, "build", appName, configName, toolchainName, `${appName}.elf`);
    await updateConfig("mikroDesign.elfPath", elfPath);
    if (debugTarget === "rv32sim") {
      const assertSuggestedPath = path.join(
        path.dirname(elfPath),
        `${path.basename(elfPath, ".elf")}.assert.json`
      );
      await configureAssertSettings("prompt", { suggestedPath: assertSuggestedPath }).catch(() => undefined);
    }
    await ensureWorkspaceBuildTask({
      sdkPath: sdkPick,
      appName,
      configName,
      toolchain: toolchainName,
      toolchainBin: toolchainPick ?? resolvePath(config.get<string>("mikroDesign.toolchainBin")) ?? undefined,
    });
    output.appendLine(
      `[SDK] Setup: sdkPath=${sdkPick} app=${appName} config=${configName} toolchain=${toolchainName}`
    );
    if (targetInfo?.target) {
      output.appendLine(`[SDK] Target from config: ${targetInfo.target}`);
    }
    output.appendLine(`[SDK] Debug target: ${debugTarget}`);
    output.appendLine(`[SDK] Expected elfPath=${elfPath}`);
    vscode.window.showInformationMessage(
      `Mikro setup: ${appName} (${configName}, ${toolchainName})`
    );
  };

  const setupProjectCommand = vscode.commands.registerCommand("mikroDesign.setupProject", runSetupProject);

  const attachGdbCommand = vscode.commands.registerCommand("mikroDesign.attachGdb", async () => {
    const config = vscode.workspace.getConfiguration();
    const gdbPath = config.get<string>("mikroDesign.gdbPath") ?? "riscv32-unknown-elf-gdb";
    const port = config.get<number>("mikroDesign.gdbPort") ?? 3333;
    const elfPath = await pickElfPath(config.get<string>("mikroDesign.elfPath"));
    if (elfPath) {
      await updateConfig("mikroDesign.elfPath", elfPath);
    }
    const term = vscode.window.createTerminal("rv32sim gdb");
    term.show(true);
    const command = elfPath ? `${gdbPath} ${quotePath(elfPath)}` : gdbPath;
    term.sendText(command, true);
    term.sendText(`target remote :${port}`, true);
    if (elfPath) {
      term.sendText(`monitor load_elf ${quotePath(elfPath)}`, true);
    }
  });

  const loadElfCommand = vscode.commands.registerCommand("mikroDesign.loadElfViaGdb", async () => {
    const config = vscode.workspace.getConfiguration();
    const elfPath = await pickElfPath(config.get<string>("mikroDesign.elfPath"));
    if (!elfPath) {
      return;
    }
    await updateConfig("mikroDesign.elfPath", elfPath);

    const session = vscode.debug.activeDebugSession;
    if (session) {
      try {
        await session.customRequest("evaluate", {
          expression: `monitor load_elf ${elfPath}`,
          context: "repl",
        });
        return;
      } catch (err) {
        output.appendLine(`[GDB] DAP request failed: ${String(err)}`);
      }
    }

    vscode.window.showWarningMessage(
      "No active debug session found. Use 'Mikro: Attach GDB to rv32sim' and run 'monitor load_elf <path>' manually if needed."
    );
  });

  const pickChoiceCommand = vscode.commands.registerCommand("mikroDesign.assert.pickChoice", async () => {
    const prompt = simController.currentPrompt;
    if (!prompt) {
      vscode.window.showWarningMessage("No active assert prompt.");
      return;
    }
    const recommendation = recommendAssertAction(prompt);
    await showAssertQuickPick(prompt, simController, recommendation);
  });

  const sendChoiceCommand = vscode.commands.registerCommand(
    "mikroDesign.assert.sendChoice",
    (choice: string) => {
      if (!choice) {
        vscode.window.showWarningMessage("No choice provided.");
        return;
      }
      simController.sendAssertResponse(choice);
    }
  );

  const ignoreCommand = vscode.commands.registerCommand("mikroDesign.assert.ignore", () => {
    simController.sendAssertResponse("-");
  });

  const defaultCommand = vscode.commands.registerCommand("mikroDesign.assert.default", () => {
    simController.sendDefaultAssertResponse();
  });

  const clearTraceCommand = vscode.commands.registerCommand("mikroDesign.assert.clearTrace", () => {
    traceStore.clear();
    tracePanel.refresh();
  });

  const showTraceCommand = vscode.commands.registerCommand("mikroDesign.assert.showTrace", () => {
    tracePanel.show();
    if (process.env.MIKRO_DEBUG_EXTENSIONS === "1") {
      appendDebugLog("assert trace panel shown");
    }
  });

  const forceDockAssertViewsCommand = vscode.commands.registerCommand("mikroDesign.forceDockAssertViews", async () => {
    await dockAssertViewsToRightSidebar();
  });

  context.subscriptions.push(
    selectSvdCommand,
    refreshSvdCommand,
    buildCommand,
    detectToolchainCommand,
    debugCommand,
    smartContinueCommand,
    startSimCommand,
    stopSimCommand,
    setupProjectCommand,
    selectAssertFileCommand,
    createAssertFileCommand,
    attachGdbCommand,
    loadElfCommand,
    pickChoiceCommand,
    sendChoiceCommand,
    ignoreCommand,
    defaultCommand,
    clearTraceCommand,
    showTraceCommand,
    forceDockAssertViewsCommand,
    debugSessionWatcher,
    treeVisibilityWatcher,
    assertResponseWatcher,
    debugStartWatcher
  );

  // Only load SVD when the view becomes visible.
  ensureLaunchConfig();

  // Don't prompt or auto-configure on activation - only when user debugs
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => {
      // Only auto-configure if already configured (don't prompt)
      const config = vscode.workspace.getConfiguration();
      const alreadyConfigured = config.get<string>("mikroDesign.sdkPath") && config.get<string>("mikroDesign.appName");
      if (alreadyConfigured) {
        autoConfigureFromActiveEditor(output).catch(() => undefined);
      }
    })
  );

  context.subscriptions.push(
    vscode.tasks.onDidEndTaskProcess(async (event) => {
      const definition = event.execution.task.definition as { type?: string } | undefined;
      if (!definition || definition.type !== "mikroDesign") {
        return;
      }
      if (event.exitCode !== 0) {
        return;
      }
      const info = resolveBuildInfo(output);
      if (!info) {
        return;
      }
      await updateConfig("mikroDesign.elfPath", info.elfPath);
      output.appendLine(`[SDK] Updated elfPath to ${info.elfPath}`);
    })
  );

  context.subscriptions.push(
    vscode.debug.onDidStartDebugSession((session) => {
      appendDebugLog(`debug session started type=${session.type}`);
      if (session.type === "mikroDesign") {
        mikroSelectedThreadRunning = false;
        setMikroSessionContext(true);
      }
    }),
    vscode.debug.onDidTerminateDebugSession((session) => {
      appendDebugLog(`debug session ended type=${session.type}`);
      if (session.type === "mikroDesign") {
        mikroSelectedThreadRunning = false;
        simController.stop();
      }
      const stillActive = vscode.debug.activeDebugSession?.type === "mikroDesign";
      setMikroSessionContext(stillActive);
    })
  );
}

export function deactivate(): void {
  for (const cleanup of globalCleanupHandlers) {
    try {
      cleanup();
    } catch (err) {
      // ignore cleanup errors
    }
  }
  globalCleanupHandlers = [];
}

function getConfig<T>(key: string): T | undefined {
  return vscode.workspace.getConfiguration().get<T>(key);
}

async function updateConfig(key: string, value: unknown): Promise<void> {
  await vscode.workspace.getConfiguration().update(key, value, vscode.ConfigurationTarget.Workspace);
}

type SetupPickItem = vscode.QuickPickItem & { value?: string; action?: "browse" | "skip" | "custom" };
type TargetInfo = { target?: string; chip?: string; board?: string; configPath?: string };

function isSdkRoot(candidate: string): boolean {
  const appRoot = path.join(candidate, "app");
  return fs.existsSync(appRoot) && fs.statSync(appRoot).isDirectory();
}

async function pickSdkPath(current: string | undefined): Promise<string | null> {
  const workspaceRoot = getWorkspaceRoot();
  const items: SetupPickItem[] = [];
  if (current && fs.existsSync(current)) {
    items.push({
      label: "Use configured SDK path",
      description: current,
      value: current,
    });
  }
  if (workspaceRoot && isSdkRoot(workspaceRoot)) {
    items.push({
      label: "Use workspace folder",
      description: workspaceRoot,
      value: workspaceRoot,
    });
  }
  items.push({ label: "Browse...", description: "Select SDK folder", action: "browse" });

  while (true) {
    const pick = await vscode.window.showQuickPick(items, {
      placeHolder: "Select ONiO SDK root folder",
    });
    if (!pick) {
      return null;
    }
    if (pick.action === "browse") {
      const uri = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
      });
      if (!uri || uri.length === 0) {
        return null;
      }
      const selected = uri[0].fsPath;
      if (!isSdkRoot(selected)) {
        vscode.window.showWarningMessage("Selected folder does not look like an SDK root (missing app/).");
        continue;
      }
      return selected;
    }
    if (pick.value && isSdkRoot(pick.value)) {
      return pick.value;
    }
    vscode.window.showWarningMessage("Selected folder does not look like an SDK root (missing app/).");
  }
}

function normalizeToolchainBin(candidate: string): string | undefined {
  const resolved = resolvePath(candidate, getWorkspaceRoot());
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

async function pickToolchainBin(current: string | undefined): Promise<string | null | undefined> {
  const detected = detectToolchainInfo();
  const items: SetupPickItem[] = [];
  if (current && fs.existsSync(current)) {
    items.push({
      label: "Keep current toolchain bin",
      description: current,
      value: current,
    });
  }
  if (detected && detected.bin !== current) {
    items.push({
      label: "Use detected toolchain bin",
      description: `${detected.bin} (${detected.source})`,
      value: detected.bin,
    });
  }
  items.push({ label: "Browse...", description: "Select toolchain bin folder", action: "browse" });
  items.push({ label: "Skip", description: "Use PATH/toolchain defaults", action: "skip" });

  while (true) {
    const pick = await vscode.window.showQuickPick(items, {
      placeHolder: "Select RISC-V toolchain bin folder",
    });
    if (!pick) {
      return null;
    }
    if (pick.action === "skip") {
      return undefined;
    }
    if (pick.action === "browse") {
      const uri = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: true,
        canSelectMany: false,
      });
      if (!uri || uri.length === 0) {
        return null;
      }
      const normalized = normalizeToolchainBin(uri[0].fsPath);
      if (!normalized) {
        vscode.window.showWarningMessage("Toolchain bin not found (missing riscv32-unknown-elf-gcc).");
        continue;
      }
      return normalized;
    }
    if (pick.value) {
      const normalized = normalizeToolchainBin(pick.value) ?? pick.value;
      if (!normalized) {
        vscode.window.showWarningMessage("Toolchain bin not found (missing riscv32-unknown-elf-gcc).");
        continue;
      }
      return normalized;
    }
  }
}

async function pickAppName(apps: string[], current: string): Promise<string | null> {
  const items: SetupPickItem[] = apps.map((app) => ({
    label: app,
    description: app === current ? "current" : undefined,
    value: app,
  }));
  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: "Select SDK app",
    matchOnDescription: true,
  });
  if (!pick || !pick.value) {
    return null;
  }
  return pick.value;
}

async function pickConfigName(scan: { configs: string[]; defaultConfig?: string }, current: string): Promise<string | null> {
  const items: SetupPickItem[] = scan.configs.map((name) => ({
    label: name,
    description: name === current ? "current" : name === scan.defaultConfig ? "default" : undefined,
    value: name,
  }));
  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: "Select build config",
    matchOnDescription: true,
  });
  if (!pick || !pick.value) {
    return null;
  }
  return pick.value;
}

async function pickToolchainName(
  scan: { defaultToolchain?: string },
  current: string
): Promise<string | null> {
  const defaults = [current, scan.defaultToolchain, "GNU"].filter(
    (value, index, array) => value && array.indexOf(value) === index
  ) as string[];
  const items: SetupPickItem[] = defaults.map((name) => ({
    label: name,
    description: name === current ? "current" : name === scan.defaultToolchain ? "default" : undefined,
    value: name,
  }));
  items.push({ label: "Custom...", description: "Enter toolchain name", action: "custom" });

  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: "Select toolchain (build folder)",
    matchOnDescription: true,
  });
  if (!pick) {
    return null;
  }
  if (pick.action === "custom") {
    const input = await vscode.window.showInputBox({
      prompt: "Enter toolchain name (e.g. GNU)",
      value: current || scan.defaultToolchain || "GNU",
    });
    if (!input) {
      return null;
    }
    return input.trim();
  }
  return pick.value ?? null;
}

function parseTargetFromConfig(sdkPath: string, appName: string, configName: string): TargetInfo | null {
  const configPath = path.join(sdkPath, "app", appName, `config-${configName}.mk`);
  if (!fs.existsSync(configPath)) {
    return null;
  }
  const text = fs.readFileSync(configPath, "utf8");
  const lines = text.split(/\r?\n/);
  let chip: string | undefined;
  let board: string | undefined;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const chipMatch = trimmed.match(/^CONFIG_CHIP\s*=\s*([A-Za-z0-9_]+)/);
    if (chipMatch) {
      chip = chipMatch[1];
      continue;
    }
    const chipFlag = trimmed.match(/^CONFIG_CHIP_([A-Za-z0-9_]+)\s*=\s*y/i);
    if (chipFlag && !chip) {
      chip = chipFlag[1].toLowerCase();
      continue;
    }
    const boardMatch = trimmed.match(/^CONFIG_BOARD\s*=\s*([A-Za-z0-9_]+)/);
    if (boardMatch) {
      board = boardMatch[1];
      continue;
    }
    const boardFlag = trimmed.match(/^CONFIG_BOARD_([A-Za-z0-9_]+)\s*=\s*y/i);
    if (boardFlag && !board) {
      board = boardFlag[1].toLowerCase();
      continue;
    }
  }
  const target = chip || board || configName;
  return { target, chip, board, configPath };
}

async function pickDebugTarget(info: TargetInfo | null, current: string): Promise<string | null> {
  const targetLabel = info?.target ? `(${info.target})` : "";
  const items: SetupPickItem[] = [
    {
      label: "rv32sim (simulator)",
      description: `Run in rv32sim ${targetLabel}`.trim(),
      value: "rv32sim",
    },
    {
      label: "Embedded target",
      description: `Run on hardware ${targetLabel}`.trim(),
      value: "embedded",
    },
  ];
  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: "Select debug target",
    matchOnDescription: true,
  });
  if (!pick || !pick.value) {
    return null;
  }
  if (pick.value === current) {
    return current;
  }
  return pick.value;
}

function detectRv32simCandidates(workspaceRoot?: string): string[] {
  const candidates = new Set<string>();
  const envPath = process.env.RV32SIM_PATH || process.env.MIKRO_RV32SIM_PATH;
  if (envPath) {
    candidates.add(resolvePath(envPath, workspaceRoot) ?? envPath);
  }
  if (workspaceRoot) {
    candidates.add(path.join(workspaceRoot, "..", "rv32sim", "rv32sim.py"));
    candidates.add(path.join(workspaceRoot, "..", "..", "rv32sim", "rv32sim.py"));
  }
  const home = os.homedir();
  candidates.add(path.join(home, "work", "git", "rv32sim", "rv32sim.py"));
  candidates.add(path.join(home, "work", "gitlab", "rv32sim", "rv32sim.py"));
  return Array.from(candidates).filter((candidate) => candidate && fs.existsSync(candidate));
}

async function pickRv32simPath(
  current: string | undefined,
  workspaceRoot?: string
): Promise<string | null> {
  const candidates = detectRv32simCandidates(workspaceRoot);
  const items: SetupPickItem[] = [];
  if (current && fs.existsSync(current)) {
    items.push({ label: "Use configured rv32sim.py", description: current, value: current });
  }
  for (const candidate of candidates) {
    if (candidate === current) {
      continue;
    }
    items.push({ label: "Use detected rv32sim.py", description: candidate, value: candidate });
  }
  items.push({ label: "Browse...", description: "Select rv32sim.py", action: "browse" });

  while (true) {
    const pick = await vscode.window.showQuickPick(items, {
      placeHolder: "Select rv32sim.py",
      matchOnDescription: true,
    });
    if (!pick) {
      return null;
    }
    if (pick.action === "browse") {
      const uri = await vscode.window.showOpenDialog({
        canSelectMany: false,
        canSelectFiles: true,
        canSelectFolders: false,
        filters: { Python: ["py"] },
      });
      if (!uri || uri.length === 0) {
        return null;
      }
      return uri[0].fsPath;
    }
    if (pick.value) {
      return pick.value;
    }
  }
}

async function ensureWorkspaceBuildTask(params: {
  sdkPath: string;
  appName: string;
  configName: string;
  toolchain: string;
  toolchainBin?: string;
}): Promise<void> {
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) {
    return;
  }
  const vscodeDir = path.join(workspaceRoot, ".vscode");
  const tasksPath = path.join(vscodeDir, "tasks.json");
  const label = `Mikro: Build ${params.appName} (${params.configName})`;
  const cwd = path.join(params.sdkPath, "app", params.appName);
  const envPath = params.toolchainBin
    ? `${params.toolchainBin}${path.delimiter}${process.env.PATH ?? ""}`
    : undefined;

  const task: Record<string, unknown> = {
    label,
    type: "shell",
    command: "make",
    args: ["clean", "all", `CONFIG=${params.configName}`, `TOOLCHAIN=${params.toolchain}`],
    options: {
      cwd,
      env: envPath ? { PATH: envPath } : undefined,
    },
    problemMatcher: ["$gcc"],
    group: {
      kind: "build",
      isDefault: true,
    },
  };

  try {
    if (!fs.existsSync(vscodeDir)) {
      fs.mkdirSync(vscodeDir, { recursive: true });
    }
    let data: { version?: string; tasks?: unknown[] } = { version: "2.0.0", tasks: [] };
    if (fs.existsSync(tasksPath)) {
      const raw = fs.readFileSync(tasksPath, "utf8");
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") {
          data = parsed;
        }
      } catch {
        vscode.window.showWarningMessage("Failed to parse .vscode/tasks.json; not updating build task.");
        return;
      }
    }
    if (!Array.isArray(data.tasks)) {
      data.tasks = [];
    }
    data.version = data.version ?? "2.0.0";
    data.tasks = data.tasks.filter((entry) => {
      if (!entry || typeof entry !== "object") {
        return true;
      }
      const existingLabel = (entry as { label?: string }).label;
      return existingLabel !== label;
    });
    data.tasks.push(task);
    fs.writeFileSync(tasksPath, JSON.stringify(data, null, 2) + "\n", "utf8");
  } catch (err) {
    vscode.window.showWarningMessage(`Failed to update tasks.json: ${String(err)}`);
  }
}

async function focusSvdView(treeView: vscode.TreeView<unknown>): Promise<void> {
  try {
    await vscode.commands.executeCommand("workbench.view.extension.mikroDesign");
  } catch {
    // best-effort focus
  }
  try {
    const commands = await vscode.commands.getCommands(true);
    if (commands.includes("workbench.action.focusView")) {
      await vscode.commands.executeCommand("workbench.action.focusView", "mikroDesign.registerMap");
    }
  } catch {
    // ignore
  }
}

let svdRevealInProgress = false;
async function revealSvdRoot(
  treeView: vscode.TreeView<unknown>,
  provider: SvdTreeProvider
): Promise<void> {
  if (svdRevealInProgress) {
    if (process.env.MIKRO_DEBUG_EXTENSIONS === "1") {
      appendDebugLog("svd reveal root BLOCKED (already in progress)");
    }
    return;
  }
  const root = provider.getRootNode();
  if (!root) {
    return;
  }
  svdRevealInProgress = true;
  if (process.env.MIKRO_DEBUG_EXTENSIONS === "1") {
    const stack = new Error().stack?.split('\n')[2]?.trim() || 'unknown';
    appendDebugLog(`svd reveal root start (from: ${stack})`);
  }
  // Just reveal the root node once, don't trigger any view switching
  try {
    await treeView.reveal(root, { expand: false, focus: false, select: false });
    if (process.env.MIKRO_DEBUG_EXTENSIONS === "1") {
      appendDebugLog("svd reveal root done");
    }
  } catch (err) {
    if (process.env.MIKRO_DEBUG_EXTENSIONS === "1") {
      appendDebugLog(`svd reveal root failed: ${String(err)}`);
    }
  } finally {
    svdRevealInProgress = false;
  }
}

function quotePath(value: string): string {
  if (value.includes(" ")) {
    return `"${value}"`;
  }
  return value;
}

async function dockAssertViewsToRightSidebar(): Promise<void> {
  const viewIds = ["mikroDesign.assertHelper", "mikroDesign.assertTrace"];
  const destinationCandidates = [
    // Prefer a dedicated container in the auxiliary (right) sidebar.
    "_.auxiliarybar.newcontainer",
    // Frequently present in modern VS Code builds and often hosted in the right sidebar.
    "workbench.view.chat",
    "workbench.view.extension.references-view",
    // Fallback containers if right-sidebar containers are unavailable.
    "workbench.view.debug",
    "workbench.view.explorer",
  ];
  for (const destinationId of destinationCandidates) {
    try {
      await vscode.commands.executeCommand("vscode.moveViews", { viewIds, destinationId });
      appendDebugLog(`dock views ok: ${viewIds.join(",")} -> ${destinationId}`);
      try {
        await vscode.commands.executeCommand("workbench.action.openSecondarySideBar");
      } catch {
        // ignore if not available
      }
      try {
        await vscode.commands.executeCommand("workbench.action.focusAuxiliaryBar");
      } catch {
        // ignore if not available
      }
      try {
        await vscode.commands.executeCommand("workbench.action.focusView", "mikroDesign.assertHelper");
      } catch {
        // ignore if not available
      }
      try {
        await vscode.commands.executeCommand("workbench.action.focusView", "mikroDesign.assertTrace");
      } catch {
        // ignore if not available
      }
      return;
    } catch (err) {
      appendDebugLog(`dock views failed: ${viewIds.join(",")} -> ${destinationId} err=${String(err)}`);
    }
  }
}

async function pauseDebugSession(): Promise<void> {
  const session = vscode.debug.activeDebugSession;
  if (!session || session.type !== "mikroDesign") {
    return;
  }
  try {
    await session.customRequest("pause", { threadId: 1 });
  } catch {
    // ignore
  }
}

async function forcePauseOnAssert(): Promise<void> {
  const session = vscode.debug.activeDebugSession;
  if (!session || session.type !== "mikroDesign") {
    appendDebugLog("forcePauseOnAssert skipped: no active mikroDesign session");
    return;
  }
  if (!mikroSelectedThreadRunning) {
    appendDebugLog("forcePauseOnAssert skipped: session already stopped");
    return;
  }
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    appendDebugLog(`forcePauseOnAssert attempt=${attempt}`);
    await pauseDebugSession();
    await new Promise((resolve) => setTimeout(resolve, 80 * attempt));
    if (!mikroSelectedThreadRunning) {
      return;
    }
  }
}

async function resumeDebugSession(): Promise<void> {
  const session = vscode.debug.activeDebugSession;
  if (!session || session.type !== "mikroDesign") {
    return;
  }
  try {
    await session.customRequest("continue", { threadId: 1 });
    mikroSelectedThreadRunning = true;
  } catch {
    // ignore
  }
}

async function captureAssertRegisters(): Promise<AssertRegister[]> {
  const session = vscode.debug.activeDebugSession;
  if (!session || session.type !== "mikroDesign") {
    return [];
  }
  // Give pause a short window to settle into a true stopped state.
  for (let attempt = 0; attempt < 14; attempt += 1) {
    try {
      const response = await session.customRequest("mikro.getRegisters");
      const running = Boolean(response?.running);
      const regs = Array.isArray(response?.registers)
        ? response.registers
            .map((item: any) => ({
              name: String(item?.name ?? "").trim(),
              value: String(item?.value ?? "").trim(),
            }))
            .filter((item: AssertRegister) => item.name.length > 0 && item.value.length > 0)
        : [];
      if (regs.length > 0) {
        return regs;
      }
      if (!running) {
        return [];
      }
      // If still running, ask adapter to pause once more.
      if (attempt % 3 === 2) {
        await forcePauseOnAssert();
      }
    } catch {
      // ignore and retry briefly
    }
    await new Promise((resolve) => setTimeout(resolve, 120 + attempt * 20));
  }
  return [];
}

async function continueDebugSessionSafe(): Promise<void> {
  const session = vscode.debug.activeDebugSession;
  if (!session) {
    appendDebugLog("safe continue: no active session, starting debug");
    await vscode.commands.executeCommand("workbench.action.debug.start");
    return;
  }
  if (session.type !== "mikroDesign") {
    return;
  }
  try {
    appendDebugLog("safe continue: continue request");
    await session.customRequest("continue", { threadId: 1 });
    mikroSelectedThreadRunning = true;
  } catch (err) {
    const message = String(err ?? "");
    const lower = message.toLowerCase();
    if (
      lower.includes("selected thread is running") ||
      lower.includes("already running") ||
      lower.includes("running")
    ) {
      // Ignore to prevent noisy "thread is running" errors on repeated F5.
      mikroSelectedThreadRunning = true;
      appendDebugLog(`safe continue ignored: ${message}`);
      return;
    }
    appendDebugLog(`safe continue failed: ${message}`);
  }
}

function isAssertPromptReady(prompt: AssertPrompt): boolean {
  return prompt.rawLines.some(
    (line) =>
      line.includes("[ASSERT] MMIO READ") ||
      line.includes("[ASSERT] MMIO WRITE") ||
      line.includes("[ASSERT] Read value") ||
      line.includes("[ASSERT] Write expect")
  );
}

function appendDebugLog(message: string): void {
  const logPath = path.join(getWorkspaceRoot() ?? process.cwd(), ".mikro-debug.log");
  try {
    fs.appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`);
  } catch {
    // ignore
  }
}

function clearExternalBreakpoints(): void {
  const config = vscode.workspace.getConfiguration();
  const sdkPathRaw = config.get<string>("mikroDesign.sdkPath") ?? "";
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const root = resolvePath(sdkPathRaw, workspaceRoot) ?? workspaceRoot;
  if (!root) {
    const all = [...vscode.debug.breakpoints];
    if (all.length) {
      vscode.debug.removeBreakpoints(all);
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
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;");
}

function renderAssertHelperShellHtml(webview: vscode.Webview): string {
  const nonce = getNonce();
  return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' 'unsafe-eval';">
    <style>
      * { box-sizing: border-box; }
      :root {
        --border: color-mix(in srgb, var(--vscode-editor-foreground) 14%, transparent);
        --muted: var(--vscode-descriptionForeground);
        --card: color-mix(in srgb, var(--vscode-editorWidget-background) 85%, var(--vscode-editor-background));
      }
      body {
        font-family: var(--vscode-font-family);
        margin: 0;
        padding: 10px;
        color: var(--vscode-foreground);
        background: var(--vscode-editor-background);
        line-height: 1.45;
      }
      .empty {
        padding: 24px 12px;
        text-align: center;
        color: var(--muted);
      }
      .card {
        border: 1px solid var(--border);
        border-radius: 8px;
        background: var(--card);
        overflow: hidden;
      }
      .head {
        padding: 10px 12px;
        border-bottom: 1px solid var(--border);
      }
      .line1 {
        font-weight: 700;
        font-size: 13px;
        letter-spacing: 0.1px;
      }
      .line2, .line3 {
        margin-top: 4px;
        color: var(--muted);
        font-size: 12px;
      }
      .sections { padding: 10px; display: grid; gap: 10px; }
      .block {
        border: 1px solid var(--border);
        border-radius: 6px;
        padding: 8px;
        background: var(--vscode-editor-background);
      }
      .title {
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.6px;
        color: var(--muted);
        margin-bottom: 8px;
      }
      .rec {
        font-size: 12px;
      }
      .actions { display: flex; gap: 8px; flex-wrap: wrap; }
      button {
        border: 1px solid var(--border);
        border-radius: 6px;
        padding: 7px 10px;
        font-size: 12px;
        cursor: pointer;
        color: var(--vscode-button-secondaryForeground);
        background: var(--vscode-button-secondaryBackground);
      }
      button:hover { background: var(--vscode-button-secondaryHoverBackground); }
      .primary {
        color: var(--vscode-button-foreground);
        background: var(--vscode-button-background);
      }
      .fork {
        display: grid;
        gap: 8px;
      }
      .lane {
        border: 1px solid var(--border);
        border-radius: 6px;
        padding: 8px;
      }
      .lanehead {
        font-weight: 600;
        margin-bottom: 6px;
        font-size: 12px;
      }
      .code {
        font-family: var(--vscode-editor-font-family);
        font-size: 12px;
        color: var(--muted);
        white-space: pre-wrap;
      }
      .hint {
        font-size: 12px;
        color: var(--muted);
        margin: 3px 0;
      }
    </style>
  </head>
  <body>
    <div id="root"></div>

    <script nonce="${nonce}">
      (function() {
        try {
          const vscode = acquireVsCodeApi();
          const root = document.getElementById("root");

          function esc(text) {
            return String(text ?? "")
              .replace(/&/g, "&amp;")
              .replace(/</g, "&lt;")
              .replace(/>/g, "&gt;")
              .replace(/\\\"/g, "&quot;");
          }

          function renderEmpty() {
            root.innerHTML = '<div class="empty">No active MMIO assert.</div>';
          }

          function renderState(prompt, recommendation, registers) {
            if (!prompt) {
              renderEmpty();
              return;
            }

            const isRead = prompt.type === "read";
            const registerText = String(prompt.register || prompt.peripheral || "").trim();
            let targetLabel = registerText;
            let registerMeta = "";
            const metaStart = registerText.indexOf(" (");
            if (metaStart > 0) {
              targetLabel = registerText.slice(0, metaStart).trim();
              registerMeta = registerText.slice(metaStart).trim();
            }
            if (!targetLabel) {
              targetLabel = "0x" + Number(prompt.addr).toString(16);
            }
            const line1 =
              "MMIO " + esc(prompt.type.toUpperCase()) +
              " (PC: 0x" + Number(prompt.pc).toString(16) + ") -> " + esc(targetLabel);
            const line2Parts = [];
            if (registerMeta) {
              line2Parts.push(esc(registerMeta));
            } else {
              line2Parts.push(
                "(addr 0x" + Number(prompt.addr).toString(16).padStart(8, "0") + ", " +
                Number(prompt.size * 8) + " bits)"
              );
            }
            if (prompt.reset) {
              line2Parts.push("Reset: " + esc(prompt.reset));
            }
            if (prompt.value && prompt.type === "write") {
              line2Parts.push("Value: " + esc(prompt.value));
            }
            const line3 = prompt.fields ? "Fields: " + esc(prompt.fields) : "Fields: n/a";

            const branchKind = (() => {
              const joined = (prompt.decisions || [])
                .map((d) => (d.targetAsm || d.target || "")).join(" ").toLowerCase();
              const m = joined.match(/\b(beq|bne|blt|bge|bltu|bgeu|beqz|bnez|blez|bgez|bltz|bgtz)\b/);
              return m ? m[1] : "";
            })();

            const laneCards = (prompt.decisions || []).map((decision, idx) => {
              const label = idx === 0 ? "Path A" : idx === 1 ? "Path B" : ("Path " + (idx + 1));
              const condition = branchKind
                ? ("Branch " + branchKind + " with input " + esc(decision.input))
                : ("Input " + esc(decision.input));
              const asm = String(decision.targetAsm || decision.target || "");
              const note = decision.note ? ("\\n" + esc(decision.note)) : "";
              return '<div class="lane">' +
                '<div class="lanehead">' + label + '</div>' +
                '<div class="code">' + condition + '\\n-> ' + esc(asm) + note + '</div>' +
                '<div style="margin-top:8px"><button ' + (idx === 0 ? 'class="primary"' : '') + ' data-input="' + esc(decision.input) + '">Choose ' + esc(decision.input) + '</button></div>' +
              '</div>';
            }).join("");
            const defaultInput = String(
              prompt.type === "write"
                ? (prompt.value ?? "")
                : (prompt.reset ?? "")
            );
            const defaultLabel = defaultInput ? ("Default (" + esc(defaultInput) + ")") : "Default";

            const hints = (prompt.hints || []).map((hint) => '<div class="hint">- ' + esc(hint) + '</div>').join("");
            const recIcon = recommendation?.action === "default" ? "[default]" : recommendation?.action === "ignore" ? "[ignore]" : "[info]";

            const regsPreview = Array.isArray(registers) && registers.length
              ? registers.slice(0, 24).map((r) => esc(r.name) + "=" + esc(r.value)).join(" ")
              : "";

            root.innerHTML =
              '<div class="card">' +
                '<div class="head">' +
                  '<div class="line1">' + line1 + '</div>' +
                  '<div class="line2">' + line2Parts.join(" | ") + '</div>' +
                  '<div class="line3">' + line3 + '</div>' +
                '</div>' +
                '<div class="sections">' +
                  (recommendation ? '<div class="block"><div class="title">Recommendation</div><div class="rec">' + recIcon + ' <strong>' + esc(recommendation.action) + '</strong> | ' + esc(recommendation.reason) + '</div></div>' : '') +
                  '<div class="block"><div class="title">Quick Actions</div><div class="actions"><button class="primary" data-input="' + esc(defaultInput) + '">' + defaultLabel + '</button><button data-input="-">Ignore</button></div></div>' +
                  (laneCards ? '<div class="block"><div class="title">Branch Fork</div><div class="fork">' + laneCards + '</div></div>' : '') +
                  (regsPreview ? '<div class="block"><div class="title">Registers</div><div class="code">' + regsPreview + '</div></div>' : '') +
                  (hints ? '<div class="block"><div class="title">Hints</div>' + hints + '</div>' : '') +
                '</div>' +
              '</div>';
          }

          root.addEventListener("click", (event) => {
            const target = event.target;
            const button = target && target.closest ? target.closest("button[data-input]") : null;
            if (!button) {
              return;
            }
            const value = button.getAttribute("data-input");
            vscode.postMessage({ type: "select", value: value });
          });

          window.addEventListener("message", (event) => {
            if (event.data?.type === "state") {
              renderState(event.data.prompt || null, event.data.recommendation || null, event.data.registers || []);
            }
          });

          renderEmpty();
        } catch (err) {
          // ignore
        }
      })();
    </script>
  </body>
</html>`;
}

function getNonce(): string {
  let text = "";
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

async function pickElfPath(defaultPath?: string): Promise<string | undefined> {
  if (defaultPath) {
    return defaultPath;
  }
  const uri = await vscode.window.showOpenDialog({
    canSelectMany: false,
    filters: { ELF: ["elf"], All: ["*"] },
  });
  if (!uri || uri.length === 0) {
    return undefined;
  }
  return uri[0].fsPath;
}

function ensureLaunchConfig(): void {
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) {
    return;
  }
  const vscodeDir = path.join(workspaceRoot, ".vscode");
  const launchPath = path.join(vscodeDir, "launch.json");
  try {
    fs.mkdirSync(vscodeDir, { recursive: true });
    if (!fs.existsSync(launchPath)) {
      const config = {
        version: "0.2.0",
        configurations: [
          {
            name: "Mikro: rv32sim",
            type: "mikroDesign",
            request: "launch",
            stopAtEntry: true,
            mikroDesign: true,
          },
        ],
      };
      fs.writeFileSync(launchPath, JSON.stringify(config, null, 2));
      return;
    }
    const raw = fs.readFileSync(launchPath, "utf8");
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    const configs = Array.isArray(parsed?.configurations) ? parsed.configurations : [];
    let touched = false;
    let foundMikro = false;
    const nextConfigs: any[] = [];

    for (const entry of configs) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      if (typeof entry.name === "string" && entry.name.startsWith("Mikro: rv32sim")) {
        if (foundMikro) {
          touched = true;
          continue;
        }
        foundMikro = true;
        if (entry.type !== "mikroDesign") {
          entry.type = "mikroDesign";
          touched = true;
        }
        if (entry.name !== "Mikro: rv32sim") {
          entry.name = "Mikro: rv32sim";
          touched = true;
        }
        if (entry.request !== "launch") {
          entry.request = "launch";
          touched = true;
        }
        if (entry.mikroDesign !== true) {
          entry.mikroDesign = true;
          touched = true;
        }
        if (entry.miDebuggerPath && !entry.gdbPath) {
          entry.gdbPath = entry.miDebuggerPath;
          touched = true;
        }
        if (entry.MIMode) {
          delete entry.MIMode;
          touched = true;
        }
        if (entry.targetArchitecture) {
          delete entry.targetArchitecture;
          touched = true;
        }
        if (entry.externalConsole !== undefined) {
          delete entry.externalConsole;
          touched = true;
        }
        if (entry.setupCommands) {
          delete entry.setupCommands;
          touched = true;
        }
      }
      nextConfigs.push(entry);
    }

    if (!foundMikro) {
      configs.push({
        name: "Mikro: rv32sim",
        type: "mikroDesign",
        request: "launch",
        stopAtEntry: true,
        mikroDesign: true,
      });
      touched = true;
    }

    if (touched) {
      parsed.configurations = foundMikro ? nextConfigs : configs;
      fs.writeFileSync(launchPath, JSON.stringify(parsed, null, 2));
    }
  } catch {
    // ignore
  }
}
