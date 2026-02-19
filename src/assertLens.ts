import * as vscode from "vscode";
import * as path from "path";
import { execFile } from "child_process";
import { AssertDecision } from "./assertPrompt";
import { Rv32SimController } from "./rv32simController";
import { resolveToolchainBin } from "./sdkBuild";
import { getWorkspaceRoot, resolvePath } from "./utils";

/**
 * Given a 0-based line number that may point to an empty or whitespace-only
 * line, return the nearest line that has non-whitespace content.  Searches
 * up to ±maxOffset lines.  Returns the original line if no non-empty
 * neighbour is found.
 *
 * `lineText(i)` must return the text content of line `i`, or undefined if
 * `i` is out of range (< 0 or >= lineCount).
 */
export function nudgeToCode(
  line: number,
  lineCount: number,
  lineText: (i: number) => string | undefined,
  maxOffset = 5,
): number {
  if (line < 0 || line >= lineCount) {
    return Math.max(0, Math.min(line, lineCount - 1));
  }
  const text = lineText(line);
  if (text !== undefined && text.trim()) {
    return line;
  }
  for (let offset = 1; offset <= maxOffset; offset++) {
    const up = line - offset;
    if (up >= 0) {
      const t = lineText(up);
      if (t !== undefined && t.trim()) {
        return up;
      }
    }
    const down = line + offset;
    if (down < lineCount) {
      const t = lineText(down);
      if (t !== undefined && t.trim()) {
        return down;
      }
    }
  }
  return line;
}

export class AssertCodeLensProvider implements vscode.CodeLensProvider {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.onDidChangeEmitter.event;
  private refreshTimer: NodeJS.Timeout | undefined;
  private cachedKey: string | null = null;
  private cachedLocation: { uri: vscode.Uri; line: number } | null = null;
  private pcLocationCache = new Map<number, { uri: vscode.Uri; line: number } | null>();

  constructor(private readonly controller: Rv32SimController) {
    this.controller.onPromptChanged((prompt) => {
      if (prompt) {
        this.startPolling();
      } else {
        this.stopPolling();
      }
      this.cachedKey = null;
      this.cachedLocation = null;
      this.onDidChangeEmitter.fire();
    });
    vscode.window.onDidChangeActiveTextEditor(() => this.onDidChangeEmitter.fire());
    vscode.debug.onDidChangeActiveDebugSession(() => this.onDidChangeEmitter.fire());
  }

  dispose(): void {
    this.stopPolling();
    this.onDidChangeEmitter.dispose();
  }

  async revealPromptLocation(): Promise<void> {
    const location = await this.getPromptLocation();
    if (!location) {
      return;
    }
    const doc = await vscode.workspace.openTextDocument(location.uri);
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    const line = nudgeToCode(
      Math.min(location.line, doc.lineCount - 1),
      doc.lineCount,
      (i) => doc.lineAt(i).text,
    );
    const range = new vscode.Range(line, 0, line, 0);
    editor.selection = new vscode.Selection(range.start, range.end);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
  }

  async provideCodeLenses(document: vscode.TextDocument): Promise<vscode.CodeLens[]> {
    const prompt = this.controller.currentPrompt;
    if (!prompt) {
      return [];
    }

    const location = await this.getPromptLocation();
    if (!location) {
      return [];
    }
    if (path.normalize(location.uri.fsPath) !== path.normalize(document.uri.fsPath)) {
      return [];
    }
    // addr2line may resolve to an empty line (off-by-one from compiler debug
    // info, macro expansion, etc.).  Nudge to the nearest non-empty line so the
    // CodeLens is visible next to actual code.
    const line = nudgeToCode(
      Math.min(location.line, document.lineCount - 1),
      document.lineCount,
      (i) => document.lineAt(i).text,
    );
    const range = new vscode.Range(line, 0, line, 0);
    const lenses: vscode.CodeLens[] = [];

    // Main info codelens - click to focus panel
    lenses.push(
      new vscode.CodeLens(range, {
        title: `MMIO ${prompt.type.toUpperCase()} 0x${prompt.addr.toString(16)} size=${prompt.size} pc=0x${prompt.pc.toString(16)}`,
        command: "mikroDesign.assertHelper.focus",
      })
    );

    // Quick action buttons in CodeLens
    lenses.push(
      new vscode.CodeLens(range, {
        title: "✅ Default (Enter)",
        command: "mikroDesign.assert.default",
      })
    );

    lenses.push(
      new vscode.CodeLens(range, {
        title: "⏭️ Ignore (-)",
        command: "mikroDesign.assert.ignore",
      })
    );

    if (prompt.decisions.length) {
      const max = Math.min(3, prompt.decisions.length);
      for (let i = 0; i < max; i += 1) {
        const decision = prompt.decisions[i];
        const label = await this.formatDecisionLabel(decision);
        lenses.push(
          new vscode.CodeLens(range, {
            title: label,
            command: "mikroDesign.assert.sendChoice",
            arguments: [decision.input],
          })
        );
      }
    }

    return lenses;
  }

  private startPolling(): void {
    if (this.refreshTimer) {
      return;
    }
    this.refreshTimer = setInterval(() => {
      this.onDidChangeEmitter.fire();
    }, 500);
  }

  private stopPolling(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }
  }

  async getPromptLocation(): Promise<{ uri: vscode.Uri; line: number } | null> {
    const session = vscode.debug.activeDebugSession;
    const prompt = this.controller.currentPrompt;
    if (!prompt) {
      return null;
    }
    const key = `${prompt.type}:${prompt.addr.toString(16)}:${prompt.pc.toString(16)}:${prompt.size}`;
    if (this.cachedKey === key && this.cachedLocation) {
      return this.cachedLocation;
    }
    const resolvedByPc = await this.resolveLineWithAddr2line(prompt.pc);
    if (resolvedByPc) {
      this.cachedKey = key;
      this.cachedLocation = resolvedByPc;
      return resolvedByPc;
    }
    if (!session) {
      return null;
    }

    try {
      const threads = await session.customRequest("threads");
      const threadId = threads?.threads?.[0]?.id;
      if (!threadId) {
        return null;
      }
      const stack = await session.customRequest("stackTrace", {
        threadId,
        startFrame: 0,
        levels: 1,
      });
      const frame = stack?.stackFrames?.[0];
      const sourcePath = frame?.source?.path;
      if (!sourcePath || frame?.line === null || frame?.line === undefined) {
        return null;
      }
      const framePath = path.normalize(sourcePath);
      const line = Math.max(0, Number(frame.line) - 1);
      const uri = vscode.Uri.file(framePath);
      this.cachedKey = key;
      this.cachedLocation = { uri, line };
      return this.cachedLocation;
    } catch (err) {
      return null;
    }
  }

  private async resolveLineWithAddr2line(pc: number): Promise<{ uri: vscode.Uri; line: number } | null> {
    const config = vscode.workspace.getConfiguration();
    const elfPath = resolvePath(config.get<string>("mikroDesign.elfPath"), getWorkspaceRoot());
    if (!elfPath) {
      return null;
    }
    let addr2line = config.get<string>("mikroDesign.addr2linePath") ?? "riscv32-unknown-elf-addr2line";
    let output = await execFileAsync(addr2line, ["-e", elfPath, `0x${pc.toString(16)}`]);
    if (!output) {
      const toolchainBin = resolveToolchainBin();
      if (toolchainBin) {
        addr2line = path.join(toolchainBin, "riscv32-unknown-elf-addr2line");
        output = await execFileAsync(addr2line, ["-e", elfPath, `0x${pc.toString(16)}`]);
      }
    }
    if (!output) {
      return null;
    }
    const line = output.trim().split("\n").pop() ?? "";
    const parts = line.split(":");
    if (parts.length < 2) {
      return null;
    }
    const lineNumber = Number.parseInt(parts[parts.length - 1], 10);
    if (!Number.isFinite(lineNumber) || lineNumber <= 0) {
      return null;
    }
    const filePath = parts.slice(0, -1).join(":").trim();
    if (!filePath || filePath === "??") {
      return null;
    }
    const resolved = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(getWorkspaceRoot() ?? process.cwd(), filePath);
    return { uri: vscode.Uri.file(resolved), line: lineNumber - 1 };
  }

  private async resolveLocationForPc(pc: number): Promise<{ uri: vscode.Uri; line: number } | null> {
    if (this.pcLocationCache.has(pc)) {
      return this.pcLocationCache.get(pc) ?? null;
    }
    const resolved = await this.resolveLineWithAddr2line(pc);
    this.pcLocationCache.set(pc, resolved);
    return resolved;
  }

  private async formatDecisionLabel(decision: AssertDecision): Promise<string> {
    if (!decision.targetPc) {
      return `MMIO ${decision.input} -> ${decision.target}`;
    }
    const location = await this.resolveLocationForPc(decision.targetPc);
    if (!location) {
      return `MMIO ${decision.input} -> ${decision.target}`;
    }
    const root = getWorkspaceRoot();
    const rel = root ? path.relative(root, location.uri.fsPath) : location.uri.fsPath;
    const suffix = decision.targetAsm ? ` ${decision.targetAsm}` : "";
    return `MMIO ${decision.input} -> ${rel}:${location.line + 1}${suffix}`;
  }
}

async function execFileAsync(command: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 2000 }, (err, stdout) => {
      if (err) {
        resolve(null);
        return;
      }
      resolve(stdout.toString());
    });
  });
}
