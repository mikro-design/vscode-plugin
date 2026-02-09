import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

export function getWorkspaceRoot(): string | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder?.uri.fsPath;
}

export function resolvePath(input?: string, baseFolder?: string): string | undefined {
  if (!input) {
    return undefined;
  }
  let value = input.trim();
  if (!value) {
    return undefined;
  }
  if (value.startsWith("~")) {
    value = path.join(os.homedir(), value.slice(1));
  }
  if (!path.isAbsolute(value)) {
    const base = baseFolder ?? getWorkspaceRoot();
    if (base) {
      value = path.join(base, value);
    }
  }
  return value;
}
