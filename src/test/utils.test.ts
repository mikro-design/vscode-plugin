import { describe, it, expect, vi, beforeEach } from "vitest";
import * as os from "os";
import * as path from "path";
import { resolvePath, getWorkspaceRoot } from "../utils";
import { workspace, Uri } from "./__mocks__/vscode";

// The utils module imports vscode, which is aliased to our mock.
// getWorkspaceRoot reads workspace.workspaceFolders

describe("getWorkspaceRoot", () => {
  beforeEach(() => {
    workspace.workspaceFolders = undefined;
  });

  it("returns undefined when no workspace folders", () => {
    workspace.workspaceFolders = undefined;
    expect(getWorkspaceRoot()).toBeUndefined();
  });

  it("returns fsPath of first workspace folder", () => {
    workspace.workspaceFolders = [{ uri: Uri.file("/home/user/project") }];
    expect(getWorkspaceRoot()).toBe("/home/user/project");
  });

  it("returns first folder when multiple exist", () => {
    workspace.workspaceFolders = [
      { uri: Uri.file("/first") },
      { uri: Uri.file("/second") },
    ];
    expect(getWorkspaceRoot()).toBe("/first");
  });
});

describe("resolvePath", () => {
  it("returns undefined for empty input", () => {
    expect(resolvePath("")).toBeUndefined();
    expect(resolvePath(undefined)).toBeUndefined();
    expect(resolvePath("  ")).toBeUndefined();
  });

  it("returns absolute path unchanged", () => {
    expect(resolvePath("/absolute/path")).toBe("/absolute/path");
  });

  it("expands ~ to home directory", () => {
    const result = resolvePath("~/projects/foo");
    expect(result).toBe(path.join(os.homedir(), "projects/foo"));
  });

  it("resolves relative path against baseFolder", () => {
    const result = resolvePath("relative/file.c", "/base");
    expect(result).toBe(path.join("/base", "relative/file.c"));
  });

  it("resolves relative path against workspace when no base", () => {
    workspace.workspaceFolders = [{ uri: Uri.file("/workspace") }];
    const result = resolvePath("src/main.c");
    expect(result).toBe(path.join("/workspace", "src/main.c"));
  });

  it("returns relative path as-is when no base and no workspace", () => {
    workspace.workspaceFolders = undefined;
    const result = resolvePath("just/a/name");
    expect(result).toBe("just/a/name");
  });

  it("trims whitespace from input", () => {
    expect(resolvePath("  /trimmed  ")).toBe("/trimmed");
  });

  it("handles tilde with just slash", () => {
    const result = resolvePath("~/");
    expect(result).toBe(path.join(os.homedir(), "/"));
  });
});
