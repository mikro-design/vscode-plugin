/**
 * Controller integration tests — validates the real
 * AssertPromptParser → Rv32SimController → currentPrompt/onPromptChanged pipeline.
 *
 * Strategy: create a controller, spawn a tiny node "mock sim" that outputs
 * real [ASSERT] lines on stdout and reads stdin for responses, then observe
 * currentPrompt and onPromptChanged events through the public API.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import * as path from "path";
import * as fs from "fs";
import { Rv32SimController, shouldAutoReply } from "../rv32simController";
import { AssertPrompt } from "../assertPrompt";
import * as vscode from "vscode";

// The mock sim script: outputs [ASSERT] lines from env var MOCK_LINES
// (JSON array of strings), one per line. Then waits for stdin lines and
// prints them back as "[STDIN] <line>". Exit on "EXIT" command.
const MOCK_SIM_SCRIPT = `
const lines = JSON.parse(process.env.MOCK_LINES || "[]");
for (const line of lines) {
  process.stdout.write(line + "\\n");
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  const parts = chunk.split("\\n");
  for (const part of parts) {
    if (part.trim() === "EXIT") {
      process.exit(0);
    }
    if (part.trim()) {
      process.stdout.write("[STDIN] " + part + "\\n");
    }
  }
});
// Keep alive for up to 10s then exit
setTimeout(() => process.exit(0), 10000);
`;

/**
 * Helper: create a controller bound to a recording output channel.
 */
function createTestController() {
  const outputLines: string[] = [];
  const outputChannel = {
    appendLine: (msg: string) => outputLines.push(msg),
    append: (msg: string) => outputLines.push(msg),
    show: () => {},
    clear: () => {},
    dispose: () => {},
  } as unknown as vscode.OutputChannel;

  const controller = new Rv32SimController(outputChannel);
  return { controller, outputLines };
}

/**
 * Helper: collect onPromptChanged events.
 */
function collectPromptEvents(controller: Rv32SimController) {
  const events: (AssertPrompt | null)[] = [];
  const disposable = controller.onPromptChanged((p) => events.push(p));
  return { events, dispose: () => disposable.dispose() };
}

/**
 * Helper: collect onAssertResponse events.
 */
function collectResponseEvents(controller: Rv32SimController) {
  const events: { prompt: AssertPrompt | null; response: string }[] = [];
  const disposable = controller.onAssertResponse((e) => events.push(e));
  return { events, dispose: () => disposable.dispose() };
}

/**
 * Helper: spawn a mock sim (node -e script) that outputs given lines on stdout
 * and returns the child process.
 */
function spawnMockSim(lines: string[]): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, ["-e", MOCK_SIM_SCRIPT], {
    env: { ...process.env, MOCK_LINES: JSON.stringify(lines) },
    stdio: "pipe",
  });
}

/**
 * Helper: wait until a predicate holds (polling), with timeout.
 */
function waitUntil(predicate: () => boolean, timeoutMs = 5000, intervalMs = 50): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error("waitUntil timeout"));
        return;
      }
      setTimeout(check, intervalMs);
    };
    check();
  });
}

// ─── Tests that use the parser directly via the controller ───────────────
// Since spawning a real process through controller.start() requires a valid
// rv32sim binary with --help preflight, we test the parser→controller→UI
// pipeline by feeding data directly into the parser. The parser is private
// but onPromptChanged/currentPrompt are public and driven by the parser
// callback set in the constructor. We access the parser via (controller as any).

describe("Rv32SimController integration (parser pipeline)", () => {
  let controller: Rv32SimController;
  let outputLines: string[];
  let promptEvents: { events: (AssertPrompt | null)[]; dispose: () => void };
  let responseEvents: { events: { prompt: AssertPrompt | null; response: string }[]; dispose: () => void };

  beforeEach(() => {
    const setup = createTestController();
    controller = setup.controller;
    outputLines = setup.outputLines;
    promptEvents = collectPromptEvents(controller);
    responseEvents = collectResponseEvents(controller);
  });

  afterEach(() => {
    promptEvents.dispose();
    responseEvents.dispose();
    controller.dispose();
  });

  function feedParser(text: string) {
    (controller as any).parser.feed(text);
  }

  it("read prompt reaches currentPrompt and fires onPromptChanged", () => {
    feedParser(
      "[ASSERT] MMIO READ at 0x40000100 size=4 PC=0x00001234\n" +
      "[ASSERT] Register: GPIOA_ODR\n" +
      "[ASSERT] Reset: 0x00000000\n" +
      "[ASSERT] Read value (hex):\n"
    );

    const prompt = controller.currentPrompt;
    expect(prompt).not.toBeNull();
    expect(prompt!.type).toBe("read");
    expect(prompt!.addr).toBe(0x40000100);
    expect(prompt!.size).toBe(4);
    expect(prompt!.pc).toBe(0x00001234);
    expect(prompt!.register).toBe("GPIOA_ODR");
    expect(prompt!.reset).toBe("0x00000000");

    // onPromptChanged should have fired at least once with a non-null prompt
    const nonNull = promptEvents.events.filter((e) => e !== null);
    expect(nonNull.length).toBeGreaterThanOrEqual(1);
    expect(nonNull[nonNull.length - 1]!.type).toBe("read");
  });

  it("write prompt suppressed when assertWrites=false (default)", () => {
    // allowWriteAsserts defaults to false in the constructor
    feedParser(
      "[ASSERT] MMIO WRITE at 0x40000200 size=4 PC=0x00005678\n" +
      "[ASSERT] Register: UART_DR\n" +
      "[ASSERT] Value: 0x00000041\n" +
      "[ASSERT] Write expect (hex):\n"
    );

    // Write prompt should NOT reach currentPrompt because writes are disabled
    // and auto-reply should have cleared it
    expect(controller.currentPrompt).toBeNull();

    // onPromptChanged should NOT have fired with a non-null write prompt
    const writePrompts = promptEvents.events.filter(
      (e) => e !== null && e.type === "write"
    );
    expect(writePrompts.length).toBe(0);
  });

  it("write prompt auto-replied when ready and assertWrites=false", () => {
    // To test auto-reply, we need proc to be set so stdin.write works
    // Simulate by setting a mock proc
    const stdinData: string[] = [];
    (controller as any).proc = {
      stdin: {
        write: (data: string) => stdinData.push(data),
        end: () => {},
      },
      pid: 12345,
      kill: () => {},
      killed: false,
    };

    feedParser(
      "[ASSERT] MMIO WRITE at 0x40000200 size=4 PC=0x00005678\n" +
      "[ASSERT] Value: 0x00000041\n" +
      "[ASSERT] Write expect (hex):\n"
    );

    // Auto-reply should have written the fallback value to stdin
    expect(stdinData.length).toBeGreaterThanOrEqual(1);
    expect(stdinData[0]).toContain("0x00000041");

    // currentPrompt should be null (auto-reply clears it)
    expect(controller.currentPrompt).toBeNull();

    // onAssertResponse should have fired
    expect(responseEvents.events.length).toBeGreaterThanOrEqual(1);
    expect(responseEvents.events[0].response).toBe("0x00000041");

    // Cleanup mock proc
    (controller as any).proc = null;
  });

  it("write prompt reaches currentPrompt when assertWrites=true", () => {
    // Set allowWriteAsserts to true
    (controller as any).allowWriteAsserts = true;

    feedParser(
      "[ASSERT] MMIO WRITE at 0x40000200 size=4 PC=0x00005678\n" +
      "[ASSERT] Register: UART_DR\n" +
      "[ASSERT] Value: 0x00000041\n" +
      "[ASSERT] Write expect (hex):\n"
    );

    const prompt = controller.currentPrompt;
    expect(prompt).not.toBeNull();
    expect(prompt!.type).toBe("write");
    expect(prompt!.addr).toBe(0x40000200);
    expect(prompt!.value).toBe("0x00000041");
  });

  it("repeated writes all auto-replied when assertWrites=false", () => {
    const stdinData: string[] = [];
    (controller as any).proc = {
      stdin: {
        write: (data: string) => stdinData.push(data),
        end: () => {},
      },
      pid: 12345,
      kill: () => {},
      killed: false,
    };

    // Fire 5 write prompts
    for (let i = 0; i < 5; i++) {
      feedParser(
        `[ASSERT] MMIO WRITE at 0x4000020${i} size=4 PC=0x0000${1000 + i}\n` +
        `[ASSERT] Value: 0x0000000${i}\n` +
        `[ASSERT] Write expect (hex):\n`
      );
    }

    // All 5 should have been auto-replied
    expect(stdinData.length).toBe(5);
    expect(controller.currentPrompt).toBeNull();

    // No write prompt should have leaked to onPromptChanged
    const writePrompts = promptEvents.events.filter(
      (e) => e !== null && e.type === "write"
    );
    expect(writePrompts.length).toBe(0);

    (controller as any).proc = null;
  });

  it("read prompt cleared after sendAssertResponse", () => {
    // Set up mock proc for sendAssertResponse to use
    const stdinData: string[] = [];
    (controller as any).proc = {
      stdin: {
        write: (data: string) => stdinData.push(data),
        end: () => {},
      },
      pid: 12345,
      kill: () => {},
      killed: false,
    };

    feedParser(
      "[ASSERT] MMIO READ at 0x40000100 size=4 PC=0x00001234\n" +
      "[ASSERT] Reset: 0x00000000\n" +
      "[ASSERT] Read value (hex):\n"
    );

    expect(controller.currentPrompt).not.toBeNull();

    controller.sendAssertResponse("0xFF");

    expect(controller.currentPrompt).toBeNull();
    expect(stdinData.some((d) => d.includes("0xFF"))).toBe(true);

    // onPromptChanged should have fired with null after response
    const lastEvent = promptEvents.events[promptEvents.events.length - 1];
    expect(lastEvent).toBeNull();

    (controller as any).proc = null;
  });

  it("multiple sequential prompts transition correctly", () => {
    const stdinData: string[] = [];
    (controller as any).proc = {
      stdin: {
        write: (data: string) => stdinData.push(data),
        end: () => {},
      },
      pid: 12345,
      kill: () => {},
      killed: false,
    };

    // Prompt 1
    feedParser(
      "[ASSERT] MMIO READ at 0x40000100 size=4 PC=0x00001000\n" +
      "[ASSERT] Reset: 0x00000000\n" +
      "[ASSERT] Read value (hex):\n"
    );
    expect(controller.currentPrompt).not.toBeNull();
    expect(controller.currentPrompt!.addr).toBe(0x40000100);

    // Respond to prompt 1
    controller.sendAssertResponse("0x1");
    expect(controller.currentPrompt).toBeNull();

    // Prompt 2
    feedParser(
      "[ASSERT] MMIO READ at 0x40000200 size=2 PC=0x00002000\n" +
      "[ASSERT] Reset: 0xFFFF\n" +
      "[ASSERT] Read value (hex):\n"
    );
    expect(controller.currentPrompt).not.toBeNull();
    expect(controller.currentPrompt!.addr).toBe(0x40000200);
    expect(controller.currentPrompt!.size).toBe(2);

    (controller as any).proc = null;
  });

  it("sendAssertResponse with no proc shows warning (no crash)", () => {
    feedParser(
      "[ASSERT] MMIO READ at 0x40000100 size=4 PC=0x00001234\n" +
      "[ASSERT] Read value (hex):\n"
    );

    // No proc set, sendAssertResponse should not throw
    expect(() => controller.sendAssertResponse("0x1")).not.toThrow();
  });

  it("sendDefaultAssertResponse uses reset value for read", () => {
    const stdinData: string[] = [];
    (controller as any).proc = {
      stdin: {
        write: (data: string) => stdinData.push(data),
        end: () => {},
      },
      pid: 12345,
      kill: () => {},
      killed: false,
    };

    feedParser(
      "[ASSERT] MMIO READ at 0x40000100 size=4 PC=0x00001234\n" +
      "[ASSERT] Reset: 0xDEADBEEF\n" +
      "[ASSERT] Read value (hex):\n"
    );

    controller.sendDefaultAssertResponse();

    expect(stdinData.some((d) => d.includes("0xDEADBEEF"))).toBe(true);
    expect(controller.currentPrompt).toBeNull();

    (controller as any).proc = null;
  });

  it("onAssertResponse fires with prompt and response on sendAssertResponse", () => {
    const stdinData: string[] = [];
    (controller as any).proc = {
      stdin: {
        write: (data: string) => stdinData.push(data),
        end: () => {},
      },
      pid: 12345,
      kill: () => {},
      killed: false,
    };

    feedParser(
      "[ASSERT] MMIO READ at 0x40000100 size=4 PC=0x00001234\n" +
      "[ASSERT] Read value (hex):\n"
    );

    controller.sendAssertResponse("0x42");

    expect(responseEvents.events.length).toBeGreaterThanOrEqual(1);
    const lastResponse = responseEvents.events[responseEvents.events.length - 1];
    expect(lastResponse.prompt).not.toBeNull();
    expect(lastResponse.prompt!.type).toBe("read");
    expect(lastResponse.response).toBe("0x42");

    (controller as any).proc = null;
  });
});

describe("shouldAutoReply", () => {
  it("returns false for read prompts", () => {
    const prompt = {
      type: "read",
      addr: 0x40000100,
      size: 4,
      pc: 0x1234,
      rawLines: ["[ASSERT] MMIO READ at 0x40000100 size=4 PC=0x1234"],
    };
    expect(shouldAutoReply(prompt, false).reply).toBe(false);
    expect(shouldAutoReply(prompt, true).reply).toBe(false);
  });

  it("returns false for write prompt when allowWriteAsserts=true", () => {
    const prompt = {
      type: "write",
      addr: 0x40000200,
      size: 4,
      pc: 0x5678,
      rawLines: [
        "[ASSERT] MMIO WRITE at 0x40000200 size=4 PC=0x5678",
        "[ASSERT] Value: 0x41",
        "[ASSERT] Write expect (hex):",
      ],
    };
    expect(shouldAutoReply(prompt, true).reply).toBe(false);
  });

  it("returns true for ready write prompt when allowWriteAsserts=false", () => {
    const prompt = {
      type: "write",
      addr: 0x40000200,
      size: 4,
      pc: 0x5678,
      rawLines: [
        "[ASSERT] MMIO WRITE at 0x40000200 size=4 PC=0x5678",
        "[ASSERT] Value: 0x41",
        "[ASSERT] Write expect (hex):",
      ],
    };
    expect(shouldAutoReply(prompt, false).reply).toBe(true);
  });

  it("returns false for incomplete write prompt (no Value line)", () => {
    const prompt = {
      type: "write",
      addr: 0x40000200,
      size: 4,
      pc: 0x5678,
      rawLines: [
        "[ASSERT] MMIO WRITE at 0x40000200 size=4 PC=0x5678",
      ],
    };
    expect(shouldAutoReply(prompt, false).reply).toBe(false);
  });
});
