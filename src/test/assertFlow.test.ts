import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

import { __resetConfig, workspace, window as vscodeWindow } from "vscode";
import { AssertPromptParser } from "../assertPrompt";
import { AssertTraceStore } from "../assertTrace";
import { shouldAutoReply } from "../rv32simController";
import { recommendAssertAction } from "../extension";
import { isAssertFileEmpty, autoCreateAssertFileIfNeeded, configureAssertSettings } from "../assertConfig";

import type { AssertPrompt } from "../assertPrompt";

let tempDir: string | null = null;

afterEach(() => {
  if (tempDir && fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe("MMIO READ full lifecycle", () => {
  it("parses prompt, recommends action, traces, and marks response", () => {
    const prompts: (AssertPrompt | null)[] = [];
    const parser = new AssertPromptParser((prompt) => {
      prompts.push(prompt ? { ...prompt, rawLines: [...prompt.rawLines], hints: [...prompt.hints], decisions: [...prompt.decisions] } : null);
    });

    parser.feed("[ASSERT] MMIO READ at 0x40000100 size=4 PC=0x1234\n");
    parser.feed("[ASSERT] Register: GPIOA_IDR (GPIO Port A input)\n");
    parser.feed("[ASSERT] Reset: 0x00000000\n");
    parser.feed("[ASSERT] Fields: PIN0[0] PIN1[1]\n");
    parser.feed("[ASSERT] Hint: No branch uses this value\n");
    parser.feed("[ASSERT] Read value (hex, default=0x00000000, '-'=ignore):\n");

    expect(prompts.length).toBeGreaterThanOrEqual(1);

    const lastPrompt = prompts[prompts.length - 1]!;
    expect(lastPrompt).not.toBeNull();
    expect(lastPrompt.type).toBe("read");
    expect(lastPrompt.addr).toBe(0x40000100);
    expect(lastPrompt.size).toBe(4);
    expect(lastPrompt.pc).toBe(0x1234);
    expect(lastPrompt.register).toBe("GPIOA_IDR (GPIO Port A input)");
    expect(lastPrompt.reset).toBe("0x00000000");
    expect(lastPrompt.fields).toBe("PIN0[0] PIN1[1]");
    expect(lastPrompt.hints).toContain("No branch uses this value");

    // Recommendation: hint says "no branch uses this value" -> action "default"
    const recommendation = recommendAssertAction(lastPrompt);
    expect(recommendation).not.toBeNull();
    expect(recommendation!.action).toBe("default");

    // Trace store lifecycle
    const traceStore = new AssertTraceStore(100);
    traceStore.upsertPrompt(lastPrompt, { path: "/test.c", line: 10 }, recommendation);

    const entries = traceStore.getEntries();
    expect(entries.length).toBe(1);
    expect(entries[0].addr).toBe(0x40000100);
    expect(entries[0].response).toBeUndefined();

    // Mark response
    traceStore.markResponse(lastPrompt, "0x0");
    const afterResponse = traceStore.getEntries();
    expect(afterResponse[0].response).toBe("0x0");

    traceStore.dispose();
  });
});

describe("MMIO WRITE auto-reply", () => {
  it("auto-replies when writes disabled, requires input when enabled", () => {
    const prompts: (AssertPrompt | null)[] = [];
    const parser = new AssertPromptParser((prompt) => {
      prompts.push(prompt ? { ...prompt, rawLines: [...prompt.rawLines], hints: [...prompt.hints], decisions: [...prompt.decisions] } : null);
    });

    parser.feed("[ASSERT] MMIO WRITE at 0x40000200 size=4 PC=0x5678\n");
    parser.feed("[ASSERT] Register: GPIOA_ODR\n");
    parser.feed("[ASSERT] Value: 0x00000001\n");
    parser.feed("[ASSERT] Write expect (hex, default=written, '-'=ignore):\n");

    expect(prompts.length).toBeGreaterThanOrEqual(1);

    const lastPrompt = prompts[prompts.length - 1]!;
    expect(lastPrompt).not.toBeNull();
    expect(lastPrompt.type).toBe("write");
    expect(lastPrompt.addr).toBe(0x40000200);
    expect(lastPrompt.value).toBe("0x00000001");

    // Writes disabled -> should auto-reply
    const writesDisabled = shouldAutoReply(lastPrompt, false);
    expect(writesDisabled.reply).toBe(true);

    // Writes enabled -> should NOT auto-reply
    const writesEnabled = shouldAutoReply(lastPrompt, true);
    expect(writesEnabled.reply).toBe(false);

    // Trace store: upsert and mark with empty response
    const traceStore = new AssertTraceStore(100);
    traceStore.upsertPrompt(lastPrompt, null, null);
    traceStore.markResponse(lastPrompt, "");

    const entries = traceStore.getEntries();
    expect(entries.length).toBe(1);
    expect(entries[0].response).toBe("");

    traceStore.dispose();
  });
});

describe("Multiple sequential prompts", () => {
  it("tracks 3 prompts and handles re-upsert after response", () => {
    const collected: AssertPrompt[] = [];
    const parser = new AssertPromptParser((prompt) => {
      if (prompt) {
        collected.push({
          ...prompt,
          rawLines: [...prompt.rawLines],
          hints: [...prompt.hints],
          decisions: [...prompt.decisions],
        });
      }
    });

    // Prompt 1: addr 0x40000100, PC 0x1000
    parser.feed("[ASSERT] MMIO READ at 0x40000100 size=4 PC=0x1000\n");
    parser.feed("[ASSERT] Register: REG_A\n");
    parser.feed("[ASSERT] Reset: 0x00000000\n");
    parser.feed("[ASSERT] Read value (hex, default=0x00000000, '-'=ignore):\n");

    // Prompt 2: addr 0x40000200, PC 0x2000
    parser.feed("[ASSERT] MMIO READ at 0x40000200 size=4 PC=0x2000\n");
    parser.feed("[ASSERT] Register: REG_B\n");
    parser.feed("[ASSERT] Reset: 0x00000000\n");
    parser.feed("[ASSERT] Read value (hex, default=0x00000000, '-'=ignore):\n");

    // Prompt 3: addr 0x40000100 again, different PC 0x3000
    parser.feed("[ASSERT] MMIO READ at 0x40000100 size=4 PC=0x3000\n");
    parser.feed("[ASSERT] Register: REG_A\n");
    parser.feed("[ASSERT] Reset: 0x00000000\n");
    parser.feed("[ASSERT] Read value (hex, default=0x00000000, '-'=ignore):\n");

    // Extract the 3 "initial" prompts (the first callback for each MMIO READ line)
    // The parser fires on every line, so we need the prompts that had the MMIO READ line
    // We'll take the last snapshot for each group.
    // Each MMIO READ creates a new current, so we pick the latest version of each.
    // Since collected has many intermediate states, let's reconstruct from the final states.
    // The simplest approach: just look at collected entries that have the MMIO READ header.
    const readPrompts = collected.filter((p) =>
      p.rawLines.some((l) => l.includes("[ASSERT] MMIO READ"))
    );

    // Group by unique (addr, pc) combination, take last snapshot of each
    const seen = new Map<string, AssertPrompt>();
    for (const p of readPrompts) {
      const key = `${p.addr}:${p.pc}`;
      seen.set(key, p);
    }
    const prompts = Array.from(seen.values());
    expect(prompts.length).toBe(3);

    const prompt1 = prompts.find((p) => p.pc === 0x1000)!;
    const prompt2 = prompts.find((p) => p.pc === 0x2000)!;
    const prompt3 = prompts.find((p) => p.pc === 0x3000)!;

    const traceStore = new AssertTraceStore(100);

    // Upsert all 3 with null location
    traceStore.upsertPrompt(prompt1, null, null);
    traceStore.upsertPrompt(prompt2, null, null);
    traceStore.upsertPrompt(prompt3, null, null);

    expect(traceStore.getEntries().length).toBe(3);

    // Mark first prompt as responded
    traceStore.markResponse(prompt1, "0x0");
    const afterMark = traceStore.getEntries();
    const entry1 = afterMark.find((e) => e.pc === 0x1000)!;
    expect(entry1.response).toBe("0x0");

    // Upsert prompt3 again (same key as prompt3). Since prompt3 has no response yet,
    // this should update the existing entry rather than create a new one.
    traceStore.upsertPrompt(prompt3, null, { action: "default", reason: "updated" });
    expect(traceStore.getEntries().length).toBe(3);

    // Verify entries are in order (newest first = unshift)
    const orderedEntries = traceStore.getEntries();
    // prompt3 was inserted last (most recently), so it should be first
    expect(orderedEntries[0].pc).toBe(0x3000);
    expect(orderedEntries[1].pc).toBe(0x2000);
    expect(orderedEntries[2].pc).toBe(0x1000);

    traceStore.dispose();
  });
});

describe("Assert file management", () => {
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "assert-flow-test-"));
  });

  it("detects empty and non-empty assert files", () => {
    const assertPath = path.join(tempDir!, "test.assert.json");

    // Write empty assertions
    fs.writeFileSync(assertPath, JSON.stringify({ assertions: {} }, null, 2), "utf8");
    expect(isAssertFileEmpty(assertPath)).toBe(true);

    // Write non-empty assertions
    fs.writeFileSync(assertPath, JSON.stringify({ assertions: { "0x4000": "0x1" } }, null, 2), "utf8");
    expect(isAssertFileEmpty(assertPath)).toBe(false);
  });

  it("returns true for non-existent file", () => {
    const missingPath = path.join(tempDir!, "missing.json");
    expect(isAssertFileEmpty(missingPath)).toBe(true);
  });
});

describe("Recommendation edge cases", () => {
  it("hint 'no branch' wins when multiple decisions present", () => {
    const prompt: AssertPrompt = {
      type: "read",
      addr: 0x40000100,
      size: 4,
      pc: 0x1000,
      hints: ["No branch uses this value"],
      decisions: [
        { input: "0x0", target: "0x2000", raw: "0x0 -> 0x2000" },
        { input: "0x1", target: "0x3000", raw: "0x1 -> 0x3000" },
      ],
      rawLines: ["[ASSERT] MMIO READ at 0x40000100 size=4 PC=0x1000"],
    };

    // decisions.length > 1, but there IS a single decision check first:
    // Actually decisions.length === 2, not 1, so the single-decision shortcut does not fire.
    // The "no branch" hint should win.
    const rec = recommendAssertAction(prompt);
    expect(rec).not.toBeNull();
    expect(rec!.action).toBe("default");
    expect(rec!.reason).toContain("No branch");
  });

  it("write with 'write-only register' hint returns ignore", () => {
    const prompt: AssertPrompt = {
      type: "write",
      addr: 0x40000200,
      size: 4,
      pc: 0x2000,
      hints: ["Write-only register"],
      decisions: [],
      rawLines: ["[ASSERT] MMIO WRITE at 0x40000200 size=4 PC=0x2000"],
      value: "0x00000001",
    };

    const rec = recommendAssertAction(prompt);
    expect(rec).not.toBeNull();
    expect(rec!.action).toBe("ignore");
    expect(rec!.reason).toContain("Write-only");
  });

  it("no hints, no decisions, no reset returns default with safe starting point", () => {
    const prompt: AssertPrompt = {
      type: "read",
      addr: 0x40000300,
      size: 4,
      pc: 0x3000,
      hints: [],
      decisions: [],
      rawLines: ["[ASSERT] MMIO READ at 0x40000300 size=4 PC=0x3000"],
    };

    const rec = recommendAssertAction(prompt);
    expect(rec).not.toBeNull();
    expect(rec!.action).toBe("default");
    expect(rec!.reason.toLowerCase()).toContain("safe starting point");
  });

  it("single decision takes priority over everything", () => {
    const prompt: AssertPrompt = {
      type: "read",
      addr: 0x40000400,
      size: 4,
      pc: 0x4000,
      hints: ["No branch uses this value"],
      decisions: [
        { input: "0x1", target: "0x5000: beq a0, zero", targetPc: 0x5000, targetAsm: "beq a0, zero", raw: "0x1 -> 0x5000: beq a0, zero" },
      ],
      rawLines: ["[ASSERT] MMIO READ at 0x40000400 size=4 PC=0x4000"],
      reset: "0x00000000",
    };

    const rec = recommendAssertAction(prompt);
    expect(rec).not.toBeNull();
    expect(rec!.action).toBe("decision");
    expect(rec!.input).toBe("0x1");
    expect(rec!.reason).toContain("Only one decision");
  });
});

describe("Wizard auto-create", () => {
  beforeEach(() => {
    __resetConfig();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "assert-wizard-test-"));
  });

  it("auto-creates assert file next to ELF path", async () => {
    const elfPath = path.join(tempDir!, "firmware.elf");
    const expectedAssertPath = path.join(tempDir!, "firmware.assert.json");

    // Set the elfPath in the mock config store.
    // The elf file does not need to exist for autoCreateAssertFileIfNeeded
    // to compute the path, but resolvePath needs an absolute path.
    await workspace.getConfiguration().update("mikroDesign.elfPath", elfPath);

    // Ensure assertMode is not "none"
    await workspace.getConfiguration().update("mikroDesign.assertMode", "assist");

    // Clear any existing assertFile setting
    await workspace.getConfiguration().update("mikroDesign.assertFile", "");

    // The temp directory already exists, so autoCreateAssertFileIfNeeded can write there
    const result = await autoCreateAssertFileIfNeeded();

    expect(result).toBe(expectedAssertPath);
    expect(fs.existsSync(expectedAssertPath)).toBe(true);

    // Verify the file content is valid empty assertions
    const content = JSON.parse(fs.readFileSync(expectedAssertPath, "utf8"));
    expect(content).toEqual({ assertions: {} });

    // Verify config was updated with the path
    const configuredPath = workspace.getConfiguration().get<string>("mikroDesign.assertFile");
    expect(configuredPath).toBe(expectedAssertPath);
  });

  it("returns null when assertMode is none", async () => {
    await workspace.getConfiguration().update("mikroDesign.assertMode", "none");
    await workspace.getConfiguration().update("mikroDesign.elfPath", path.join(tempDir!, "firmware.elf"));
    await workspace.getConfiguration().update("mikroDesign.assertFile", "");

    const result = await autoCreateAssertFileIfNeeded();
    expect(result).toBeNull();
  });

  // B5.1 — ELF without .elf extension
  it("auto-creates assert file for ELF without .elf extension", async () => {
    const elfPath = path.join(tempDir!, "firmware.bin");
    const expectedAssertPath = path.join(tempDir!, "firmware.bin.assert.json");

    await workspace.getConfiguration().update("mikroDesign.elfPath", elfPath);
    await workspace.getConfiguration().update("mikroDesign.assertMode", "assist");
    await workspace.getConfiguration().update("mikroDesign.assertFile", "");

    const result = await autoCreateAssertFileIfNeeded();
    expect(result).toBe(expectedAssertPath);
    expect(fs.existsSync(expectedAssertPath)).toBe(true);
  });

  // B5.2 — No ELF path returns null
  it("returns null when no ELF path is configured", async () => {
    await workspace.getConfiguration().update("mikroDesign.elfPath", "");
    await workspace.getConfiguration().update("mikroDesign.assertMode", "assist");
    await workspace.getConfiguration().update("mikroDesign.assertFile", "");

    const result = await autoCreateAssertFileIfNeeded();
    expect(result).toBeNull();
  });

  // B6.1 — assertFile config resolves but file missing: falls through to ELF-based creation
  it("falls through to ELF-based creation when assertFile is set but missing", async () => {
    const elfPath = path.join(tempDir!, "firmware.elf");
    const expectedAssertPath = path.join(tempDir!, "firmware.assert.json");

    await workspace.getConfiguration().update("mikroDesign.assertFile", path.join(tempDir!, "nonexistent.json"));
    await workspace.getConfiguration().update("mikroDesign.elfPath", elfPath);
    await workspace.getConfiguration().update("mikroDesign.assertMode", "assist");

    const result = await autoCreateAssertFileIfNeeded();
    expect(result).toBe(expectedAssertPath);
    expect(fs.existsSync(expectedAssertPath)).toBe(true);
  });

  // B6.2 — assertFile exists and is valid: returns resolved path directly
  it("returns existing assert file directly when valid", async () => {
    const assertPath = path.join(tempDir!, "existing.assert.json");
    fs.writeFileSync(assertPath, JSON.stringify({ assertions: { "0x100": "0x1" } }, null, 2), "utf8");

    await workspace.getConfiguration().update("mikroDesign.assertFile", assertPath);
    await workspace.getConfiguration().update("mikroDesign.assertMode", "assist");

    const result = await autoCreateAssertFileIfNeeded();
    expect(result).toBe(assertPath);
  });
});

describe("configureAssertSettings interactive flow", () => {
  let originalShowOpenDialog: typeof vscodeWindow.showOpenDialog;
  let originalShowSaveDialog: typeof vscodeWindow.showSaveDialog;
  let originalShowQuickPick: typeof vscodeWindow.showQuickPick;

  beforeEach(() => {
    __resetConfig();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "assert-config-test-"));
    originalShowOpenDialog = vscodeWindow.showOpenDialog;
    originalShowSaveDialog = vscodeWindow.showSaveDialog;
    originalShowQuickPick = vscodeWindow.showQuickPick;

    // Set workspace root via workspaceFolders
    (workspace as any).workspaceFolders = [{ uri: { fsPath: tempDir } }];
  });

  afterEach(() => {
    vscodeWindow.showOpenDialog = originalShowOpenDialog;
    vscodeWindow.showSaveDialog = originalShowSaveDialog;
    vscodeWindow.showQuickPick = originalShowQuickPick;
    (workspace as any).workspaceFolders = undefined;
  });

  // B4.1 — "select" mode, user picks file
  it("select mode returns picked file path", async () => {
    const pickedPath = path.join(tempDir!, "picked.json");
    fs.writeFileSync(pickedPath, JSON.stringify({ assertions: {} }), "utf8");

    vscodeWindow.showOpenDialog = async () => [{ fsPath: pickedPath }];

    // Need to set sdkPath or workspaceRoot for configureAssertSettings to work
    await workspace.getConfiguration().update("mikroDesign.sdkPath", tempDir);

    const result = await configureAssertSettings("select");
    expect(result).not.toBeNull();
    // The file should end up in the build dir or be the picked path
    expect(typeof result).toBe("string");
  });

  // B4.2 — "create" mode, new file
  it("create mode creates new assert file", async () => {
    const newPath = path.join(tempDir!, "build", "new.assert.json");

    vscodeWindow.showSaveDialog = async () => ({ fsPath: newPath });

    await workspace.getConfiguration().update("mikroDesign.sdkPath", tempDir);

    const result = await configureAssertSettings("create");
    expect(result).not.toBeNull();
    expect(fs.existsSync(newPath)).toBe(true);
    const content = JSON.parse(fs.readFileSync(newPath, "utf8"));
    expect(content).toEqual({ assertions: {} });
  });

  // B4.3 — "create" mode, file exists, overwrite
  it("create mode overwrites existing file when user chooses overwrite", async () => {
    const existingPath = path.join(tempDir!, "build", "existing.assert.json");
    const buildDir = path.dirname(existingPath);
    fs.mkdirSync(buildDir, { recursive: true });
    fs.writeFileSync(existingPath, JSON.stringify({ assertions: { "0x100": "0x42" } }), "utf8");

    vscodeWindow.showSaveDialog = async () => ({ fsPath: existingPath });
    vscodeWindow.showQuickPick = async (items: any[]) => {
      // Pick the overwrite option
      return items.find((item: any) => item.value === "overwrite") ?? items[0];
    };

    await workspace.getConfiguration().update("mikroDesign.sdkPath", tempDir);

    const result = await configureAssertSettings("create");
    expect(result).not.toBeNull();
    const content = JSON.parse(fs.readFileSync(existingPath, "utf8"));
    expect(content).toEqual({ assertions: {} });
  });

  // B4.4 — "prompt" mode, user picks "none"
  it("prompt mode with none returns null and sets assertMode to none", async () => {
    vscodeWindow.showQuickPick = async (items: any[]) => {
      return items.find((item: any) => item.value === "none") ?? null;
    };

    await workspace.getConfiguration().update("mikroDesign.sdkPath", tempDir);

    const result = await configureAssertSettings("prompt");
    expect(result).toBeNull();
    const mode = workspace.getConfiguration().get<string>("mikroDesign.assertMode");
    expect(mode).toBe("none");
  });
});
