import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { getWorkspaceRoot, resolvePath } from "./utils";

type SetupPickItem = vscode.QuickPickItem & { value?: string };

export type AssertSetupAction = "none" | "select" | "create" | "keep" | "reset";

export interface AssertConfigOptions {
  suggestedPath?: string;
}

async function updateConfig(key: string, value: unknown): Promise<void> {
  await vscode.workspace.getConfiguration().update(key, value, vscode.ConfigurationTarget.Workspace);
}

export async function configureAssertSettings(
  mode: "prompt" | "select" | "create",
  options: AssertConfigOptions = {}
): Promise<string | null> {
  const config = vscode.workspace.getConfiguration();
  const sdkPathRaw = config.get<string>("mikroDesign.sdkPath") ?? "";
  const workspaceRoot = getWorkspaceRoot();
  const root = resolvePath(sdkPathRaw, workspaceRoot) ?? workspaceRoot;
  if (!root) {
    vscode.window.showWarningMessage("Open a workspace before configuring assert files.");
    return null;
  }

  const defaultPathRaw = options.suggestedPath ?? path.join(root, "build", "assertions.json");
  const defaultPath = resolvePath(defaultPathRaw, root) ?? defaultPathRaw;
  const buildDir = path.dirname(defaultPath);
  const existingAssertPath = resolvePath(config.get<string>("mikroDesign.assertFile"), root);
  const existingAssert =
    existingAssertPath && fs.existsSync(existingAssertPath) ? existingAssertPath : undefined;

  let action: AssertSetupAction | "prompt" = mode;
  if (mode === "prompt") {
    const picks: SetupPickItem[] = [];
    if (existingAssert) {
      picks.push(
        {
          label: "Use current assert file",
          description: existingAssert,
          value: "keep",
        },
        {
          label: "Reset current assert file",
          description: "Clear contents and start fresh",
          value: "reset",
        }
      );
    }
    picks.push(
      { label: "No assert file", description: "Disable assertions", value: "none" },
      { label: "Select existing assert file", description: "Use a JSON file", value: "select" },
      { label: "Create new assert file", description: defaultPath, value: "create" }
    );
    const pick = await vscode.window.showQuickPick<SetupPickItem>(picks, {
      placeHolder: "Assertions: select an option",
    });
    if (!pick || !pick.value) {
      return null;
    }
    action = pick.value as AssertSetupAction;
  }

  if (action === "none") {
    await updateConfig("mikroDesign.assertFile", "");
    await updateConfig("mikroDesign.assertMode", "none");
    return null;
  }
  if (action === "keep" && existingAssert) {
    const enforced = enforceInBuildDir(existingAssert, buildDir);
    if (enforced !== existingAssert) {
      await updateConfig("mikroDesign.assertFile", enforced);
    }
    return enforced;
  }

  let assertPath: string | null = null;
  const resetRequested = action === "reset";
  if (resetRequested && existingAssert) {
    assertPath = existingAssert;
    fs.writeFileSync(assertPath, JSON.stringify({ assertions: {} }, null, 2) + "\n", "utf8");
  } else if (action === "select") {
    const uri = await vscode.window.showOpenDialog({
      canSelectMany: false,
      canSelectFiles: true,
      canSelectFolders: false,
      defaultUri: vscode.Uri.file(buildDir),
      filters: { JSON: ["json"] },
    });
    if (!uri || uri.length === 0) {
      return null;
    }
    assertPath = uri[0].fsPath;
  } else if (action === "create") {
    if (!fs.existsSync(buildDir)) {
      fs.mkdirSync(buildDir, { recursive: true });
    }
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(defaultPath),
      filters: { JSON: ["json"] },
    });
    if (!uri) {
      return null;
    }
    assertPath = uri.fsPath;
    if (fs.existsSync(assertPath)) {
      const overwrite = await vscode.window.showQuickPick(
        [
          { label: "Overwrite and start fresh", value: "overwrite" },
          { label: "Keep existing contents", value: "keep" },
        ],
        { placeHolder: "Assert file already exists" }
      );
      if (!overwrite) {
        return null;
      }
      if (overwrite.value === "overwrite") {
        fs.writeFileSync(assertPath, JSON.stringify({ assertions: {} }, null, 2) + "\n", "utf8");
      }
    } else {
      fs.writeFileSync(assertPath, JSON.stringify({ assertions: {} }, null, 2) + "\n", "utf8");
    }
  }

  if (!assertPath) {
    return null;
  }

  const enforcedPath = enforceInBuildDir(assertPath, buildDir);
  if (enforcedPath !== assertPath) {
    vscode.window.showInformationMessage(`Copied assert file to build folder: ${enforcedPath}`);
  }
  await updateConfig("mikroDesign.assertFile", enforcedPath);
  const assertIsEmpty = isAssertFileEmpty(enforcedPath);
  if (assertIsEmpty) {
    await updateConfig("mikroDesign.assertMode", "assist");
    await updateConfig("mikroDesign.assertWrites", false);
    return enforcedPath;
  }
  const currentMode = (config.get<string>("mikroDesign.assertMode") ?? "").toLowerCase();
  if (!currentMode || currentMode === "none") {
    await updateConfig("mikroDesign.assertMode", "enforce");
  }
  return enforcedPath;
}

function enforceInBuildDir(assertPath: string, buildDir: string): string {
  const resolved = path.resolve(assertPath);
  const buildResolved = path.resolve(buildDir);
  if (resolved === buildResolved || resolved.startsWith(buildResolved + path.sep)) {
    return resolved;
  }
  if (!fs.existsSync(buildResolved)) {
    fs.mkdirSync(buildResolved, { recursive: true });
  }
  const dest = path.join(buildResolved, path.basename(resolved));
  if (resolved !== dest) {
    try {
      fs.copyFileSync(resolved, dest);
    } catch (err) {
      vscode.window.showWarningMessage(
        `Failed to copy assert file into build folder. Using original path: ${resolved}`
      );
      return resolved;
    }
  }
  return dest;
}

function isAssertFileEmpty(assertPath: string): boolean {
  try {
    if (!fs.existsSync(assertPath)) {
      return true;
    }
    const raw = fs.readFileSync(assertPath, "utf8").trim();
    if (!raw) {
      return true;
    }
    const parsed = JSON.parse(raw);
    if (parsed == null) {
      return true;
    }
    if (Array.isArray(parsed)) {
      return parsed.length === 0;
    }
    if (typeof parsed === "object") {
      const assertions = (parsed as any).assertions;
      if (assertions && typeof assertions === "object") {
        return Object.keys(assertions).length === 0;
      }
      const entries = (parsed as any).entries;
      if (Array.isArray(entries)) {
        return entries.length === 0;
      }
      const rules = (parsed as any).rules;
      if (Array.isArray(rules)) {
        return rules.length === 0;
      }
      return Object.keys(parsed).length === 0;
    }
  } catch {
    return true;
  }
  return false;
}
