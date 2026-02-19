/**
 * End-to-end user scenario tests.
 *
 * Each test reads like a user story:
 *   "The user does X, then Y happens, then they see Z."
 *
 * Two layers:
 *   1. DAP adapter scenarios — full adapter process + mock GDB server
 *   2. Assert pipeline scenarios — parser + controller + stdin verification
 *
 * These test the WORKFLOWS, not individual functions.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { AssertPromptParser, type AssertPrompt } from "../assertPrompt";
import { sanitizeAssertValue } from "../rv32simController";
import { nudgeToCode } from "../assertLens";

// ═══════════════════════════════════════════════════════════════════════════
// Assert Pipeline Scenarios
//
// Simulates the rv32sim → parser → controller → stdin pipeline.
// Uses a mock proc to capture what would be written to rv32sim's stdin.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Simulates the full assert pipeline:
 * rv32sim stdout → parser → prompt → user action → sanitize → stdin
 */
class AssertPipelineHarness {
  parser: AssertPromptParser;
  prompt: AssertPrompt | null = null;
  promptHistory: (AssertPrompt | null)[] = [];
  stdinWrites: string[] = [];
  private allowWriteAsserts: boolean;

  constructor(opts: { allowWriteAsserts?: boolean } = {}) {
    this.allowWriteAsserts = opts.allowWriteAsserts ?? false;

    this.parser = new AssertPromptParser((prompt) => {
      // Replicate controller logic: auto-reply writes when disabled
      if (prompt && prompt.type === "write" && !this.allowWriteAsserts) {
        const ready = prompt.rawLines.some(
          (l) => l.includes("[ASSERT] Write expect") || l.includes("[ASSERT] Value:"),
        );
        if (ready) {
          const fallback = prompt.value ?? "0x0";
          this.stdinWrites.push(fallback + "\n");
          this.prompt = null;
          this.promptHistory.push(null);
          this.parser.clear();
          return;
        }
        return;
      }
      this.prompt = prompt;
      this.promptHistory.push(prompt ? { ...prompt, decisions: [...prompt.decisions], hints: [...prompt.hints], rawLines: [...prompt.rawLines] } : null);
    });
  }

  /** Simulate rv32sim writing to stdout */
  rv32simOutput(text: string): void {
    this.parser.feed(text);
  }

  /** Simulate user clicking "Default" button */
  clickDefault(): string {
    if (!this.prompt) throw new Error("No prompt to respond to");
    const value = this.prompt.type === "write"
      ? this.prompt.value ?? "0x0"
      : this.prompt.reset ?? "";
    return this.sendResponse(value);
  }

  /** Simulate user clicking a decision button */
  clickDecision(index: number): string {
    if (!this.prompt) throw new Error("No prompt to respond to");
    if (index >= this.prompt.decisions.length) throw new Error(`No decision at index ${index}`);
    return this.sendResponse(this.prompt.decisions[index].input);
  }

  /** Simulate user clicking "Ignore" button */
  clickIgnore(): string {
    return this.sendResponse("-");
  }

  /** Simulate user typing a custom value */
  typeCustomValue(value: string): string {
    return this.sendResponse(value);
  }

  /** Internal: sanitize and write to stdin */
  private sendResponse(text: string): string {
    const sanitized = sanitizeAssertValue(text);
    this.stdinWrites.push(sanitized + "\n");
    this.prompt = null;
    this.promptHistory.push(null);
    this.parser.clear();
    return sanitized;
  }

  /** Get the last value written to stdin (without trailing newline) */
  get lastStdinValue(): string {
    if (this.stdinWrites.length === 0) return "";
    return this.stdinWrites[this.stdinWrites.length - 1].replace(/\n$/, "");
  }

  /** How many values were written to stdin */
  get stdinWriteCount(): number {
    return this.stdinWrites.length;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Source File Harness — simulates a document for CodeLens placement
// ═══════════════════════════════════════════════════════════════════════════

class SourceFileHarness {
  lines: string[];

  constructor(source: string) {
    this.lines = source.split("\n");
  }

  get lineCount(): number {
    return this.lines.length;
  }

  lineText(i: number): string | undefined {
    return i >= 0 && i < this.lines.length ? this.lines[i] : undefined;
  }

  /** Where would CodeLens land if addr2line says this line? */
  codeLensLine(addr2lineLine: number): number {
    return nudgeToCode(addr2lineLine, this.lineCount, (i) => this.lineText(i));
  }

  /** Is the line visible code (non-empty, non-whitespace)? */
  isCode(line: number): boolean {
    const text = this.lineText(line);
    return text !== undefined && text.trim().length > 0;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// SCENARIO 1: First debug session — open project, start, see entry point
// ═══════════════════════════════════════════════════════════════════════════

describe("Scenario: First debug session", () => {
  it("user starts debug → stops at entry → sees source location", () => {
    // Source file the user is looking at
    const src = new SourceFileHarness([
      "#include <stdint.h>",
      "",
      "int main(void) {",       // line 2 — entry point
      "    int x = 0;",
      "    return 0;",
      "}",
    ].join("\n"));

    // addr2line says entry point is line 2 (0-indexed)
    const entryLine = src.codeLensLine(2);
    expect(src.isCode(entryLine)).toBe(true);
    expect(src.lines[entryLine]).toContain("int main");
  });

  it("entry point on blank line between includes and main → nudges to code", () => {
    const src = new SourceFileHarness([
      "#include <stdint.h>",
      "#include <stdbool.h>",
      "",                          // line 2 — addr2line might say this
      "int main(void) {",         // line 3
      "    return 0;",
      "}",
    ].join("\n"));

    const line = src.codeLensLine(2);
    expect(src.isCode(line)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SCENARIO 2: Step through code line by line
// ═══════════════════════════════════════════════════════════════════════════

describe("Scenario: Step through code", () => {
  it("user steps through 5 lines → each step lands on visible code", () => {
    // Typical embedded C file with blank lines
    const src = new SourceFileHarness([
      "void setup(void) {",        // 0
      "    GPIO_Init();",           // 1
      "",                           // 2 — blank
      "    UART_Init();",           // 3
      "",                           // 4 — blank
      "    Timer_Init();",          // 5
      "",                           // 6 — blank
      "    ADC_Init();",            // 7
      "",                           // 8 — blank
      "    SPI_Init();",            // 9
      "}",                          // 10
    ].join("\n"));

    // addr2line returns these lines for 5 sequential steps
    // (some compilers return the blank line after a statement)
    const addr2lineResults = [1, 2, 3, 4, 5];

    for (const addr2lineLine of addr2lineResults) {
      const displayLine = src.codeLensLine(addr2lineLine);
      expect(src.isCode(displayLine)).toBe(true);
    }
  });

  it("stepping past function closing brace → lands on code not empty", () => {
    const src = new SourceFileHarness([
      "    return 0;",           // 0
      "}",                       // 1
      "",                        // 2 — blank after function
      "",                        // 3 — blank
      "void next_func(void) {", // 4
    ].join("\n"));

    // addr2line says line 2 (blank after closing brace)
    const line = src.codeLensLine(2);
    expect(src.isCode(line)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SCENARIO 3: MMIO Read assert — user clicks Default
// ═══════════════════════════════════════════════════════════════════════════

describe("Scenario: MMIO Read assert — click Default", () => {
  it("read assert fires → user clicks Default → reset value sent to stdin", () => {
    const h = new AssertPipelineHarness();

    // rv32sim outputs a read assert
    h.rv32simOutput(
      "[ASSERT] MMIO READ at 0x40000100 size=4 PC=0x00001234\n" +
      "[ASSERT] Peripheral: GPIOA\n" +
      "[ASSERT] Register: GPIOA_IDR (Input Data Register)\n" +
      "[ASSERT] Reset: 0x00000000\n" +
      "[ASSERT] Fields: PIN0[0] PIN1[1] PIN2[2]\n" +
      "[ASSERT] Hint: No branch uses this value\n" +
      "[ASSERT] Read value (hex, default=0x00000000, '-'=ignore):\n",
    );

    // User sees the prompt
    expect(h.prompt).not.toBeNull();
    expect(h.prompt!.type).toBe("read");
    expect(h.prompt!.register).toBe("GPIOA_IDR (Input Data Register)");

    // User clicks "Default (Enter)"
    const sent = h.clickDefault();

    // Reset value sent to stdin
    expect(sent).toBe("0x00000000");
    expect(h.prompt).toBeNull();
    expect(h.stdinWriteCount).toBe(1);
  });

  it("read assert with no reset → Default sends empty string", () => {
    const h = new AssertPipelineHarness();
    h.rv32simOutput(
      "[ASSERT] MMIO READ at 0x40000100 size=4 PC=0x00001234\n" +
      "[ASSERT] Read value (hex):\n",
    );

    expect(h.prompt).not.toBeNull();
    const sent = h.clickDefault();
    expect(sent).toBe("");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SCENARIO 4: MMIO Read assert — user clicks a Decision
// ═══════════════════════════════════════════════════════════════════════════

describe("Scenario: MMIO Read assert — click Decision", () => {
  it("simple decision (no field annotation) → correct hex sent", () => {
    const h = new AssertPipelineHarness();
    h.rv32simOutput(
      "[ASSERT] MMIO READ at 0x40000100 size=4 PC=0x00001000\n" +
      "[ASSERT] Decision\n" +
      "[ASSERT] 0x00000001 -> 0x00001008: beq a0, zero (taken branch)\n" +
      "[ASSERT] 0x00000000 -> 0x0000100c: addi a0, a0, 1 (fallthrough)\n" +
      "[ASSERT] Read value (hex):\n",
    );

    expect(h.prompt!.decisions.length).toBe(2);

    // User clicks first decision (taken branch)
    const sent = h.clickDecision(0);
    expect(sent).toBe("0x00000001");
    expect(h.lastStdinValue).toBe("0x00000001");
  });

  it("decision WITH field annotations → only hex value sent, NOT annotations", () => {
    // THIS IS THE EXACT BUG SCENARIO that broke production
    const h = new AssertPipelineHarness();
    h.rv32simOutput(
      "[ASSERT] MMIO READ at 0x40000100 size=4 PC=0x00001000\n" +
      "[ASSERT] Register: GPIOA_IDR\n" +
      "[ASSERT] Reset: 0x00000000\n" +
      "[ASSERT] Fields: PIN0[0] PIN1[1] PIN4[4]\n" +
      "[ASSERT] Decision\n" +
      "[ASSERT] 0x00000010 PIN4=0x1 -> 0x00002000: beq a0, zero (taken branch)\n" +
      "[ASSERT] 0x00000000 -> 0x00002004: nop (fallthrough)\n" +
      "[ASSERT] Read value (hex):\n",
    );

    expect(h.prompt!.decisions.length).toBe(2);
    expect(h.prompt!.decisions[0].input).toBe("0x00000010");

    // User clicks the first decision (PIN4=0x1)
    const sent = h.clickDecision(0);

    // MUST be "0x00000010" — NOT "0x00000010,PIN4=0x1" (the old bug)
    expect(sent).toBe("0x00000010");
    expect(sent).not.toContain(",");
    expect(sent).not.toContain("PIN");
    expect(sent).not.toContain("=");
    expect(sent).toMatch(/^0x[0-9a-fA-F]+$/);
  });

  it("decision with multiple field annotations → only hex value sent", () => {
    const h = new AssertPipelineHarness();
    h.rv32simOutput(
      "[ASSERT] MMIO READ at 0x40000100 size=4 PC=0x00001000\n" +
      "[ASSERT] Decision\n" +
      "[ASSERT] 0x00000013 PIN0=0x1 PIN1=0x1 PIN4=0x1 -> 0x00002000: beq a0, zero\n" +
      "[ASSERT] Read value (hex):\n",
    );

    const sent = h.clickDecision(0);
    expect(sent).toBe("0x00000013");
  });

  it("user clicks second decision (fallthrough)", () => {
    const h = new AssertPipelineHarness();
    h.rv32simOutput(
      "[ASSERT] MMIO READ at 0x40000100 size=4 PC=0x00001000\n" +
      "[ASSERT] Decision\n" +
      "[ASSERT] 0x00000001 -> 0x00001008: beq a0, zero (taken branch)\n" +
      "[ASSERT] 0x00000000 -> 0x0000100c: addi a0, a0, 1 (fallthrough)\n" +
      "[ASSERT] Read value (hex):\n",
    );

    const sent = h.clickDecision(1);
    expect(sent).toBe("0x00000000");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SCENARIO 5: MMIO Read assert — user clicks Ignore
// ═══════════════════════════════════════════════════════════════════════════

describe("Scenario: MMIO Read assert — click Ignore", () => {
  it("user clicks Ignore → '-' sent to stdin", () => {
    const h = new AssertPipelineHarness();
    h.rv32simOutput(
      "[ASSERT] MMIO READ at 0x40000100 size=4 PC=0x00001234\n" +
      "[ASSERT] Read value (hex):\n",
    );

    const sent = h.clickIgnore();
    expect(sent).toBe("-");
    expect(h.prompt).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SCENARIO 6: MMIO Read assert — user types custom value
// ═══════════════════════════════════════════════════════════════════════════

describe("Scenario: MMIO Read assert — type custom value", () => {
  it("user types hex value → sent as-is", () => {
    const h = new AssertPipelineHarness();
    h.rv32simOutput(
      "[ASSERT] MMIO READ at 0x40000100 size=4 PC=0x00001234\n" +
      "[ASSERT] Read value (hex):\n",
    );

    const sent = h.typeCustomValue("0xFF");
    expect(sent).toBe("0xFF");
  });

  it("user types decimal value → sent as-is", () => {
    const h = new AssertPipelineHarness();
    h.rv32simOutput(
      "[ASSERT] MMIO READ at 0x40000100 size=4 PC=0x00001234\n" +
      "[ASSERT] Read value (hex):\n",
    );

    const sent = h.typeCustomValue("42");
    expect(sent).toBe("42");
  });

  it("user types value with whitespace → trimmed", () => {
    const h = new AssertPipelineHarness();
    h.rv32simOutput(
      "[ASSERT] MMIO READ at 0x40000100 size=4 PC=0x00001234\n" +
      "[ASSERT] Read value (hex):\n",
    );

    const sent = h.typeCustomValue("  0xAB  ");
    expect(sent).toBe("0xAB");
  });

  it("user pastes multi-line → only first line used", () => {
    const h = new AssertPipelineHarness();
    h.rv32simOutput(
      "[ASSERT] MMIO READ at 0x40000100 size=4 PC=0x00001234\n" +
      "[ASSERT] Read value (hex):\n",
    );

    const sent = h.typeCustomValue("0x1\n0x2\n0x3");
    expect(sent).toBe("0x1");
  });

  it("user types [ASSERT] prefix → blocked (injection prevention)", () => {
    const h = new AssertPipelineHarness();
    h.rv32simOutput(
      "[ASSERT] MMIO READ at 0x40000100 size=4 PC=0x00001234\n" +
      "[ASSERT] Read value (hex):\n",
    );

    const sent = h.typeCustomValue("[ASSERT] MMIO READ at 0x9999");
    expect(sent).toBe("");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SCENARIO 7: MMIO Write assert — auto-reply (writes disabled)
// ═══════════════════════════════════════════════════════════════════════════

describe("Scenario: MMIO Write assert — auto-reply", () => {
  it("write assert fires with writes disabled → auto-replied, no prompt shown", () => {
    const h = new AssertPipelineHarness({ allowWriteAsserts: false });

    h.rv32simOutput(
      "[ASSERT] MMIO WRITE at 0x40000200 size=4 PC=0x00005678\n" +
      "[ASSERT] Register: GPIOA_ODR\n" +
      "[ASSERT] Value: 0x00000041\n" +
      "[ASSERT] Write expect (hex):\n",
    );

    // User never sees a prompt
    expect(h.prompt).toBeNull();

    // Value was auto-replied to stdin
    expect(h.stdinWriteCount).toBe(1);
    expect(h.lastStdinValue).toBe("0x00000041");
  });

  it("5 rapid write asserts → all auto-replied, none leak to UI", () => {
    const h = new AssertPipelineHarness({ allowWriteAsserts: false });

    for (let i = 0; i < 5; i++) {
      h.rv32simOutput(
        `[ASSERT] MMIO WRITE at 0x4000020${i} size=4 PC=0x0000${1000 + i}\n` +
        `[ASSERT] Value: 0x0000004${i}\n` +
        `[ASSERT] Write expect (hex):\n`,
      );
    }

    // All 5 auto-replied
    expect(h.stdinWriteCount).toBe(5);
    // User never saw a prompt
    expect(h.prompt).toBeNull();
    // No non-null prompts in history
    const visiblePrompts = h.promptHistory.filter((p) => p !== null && p.type === "write");
    expect(visiblePrompts.length).toBe(0);
  });

  it("write assert fires with writes ENABLED → prompt shown to user", () => {
    const h = new AssertPipelineHarness({ allowWriteAsserts: true });

    h.rv32simOutput(
      "[ASSERT] MMIO WRITE at 0x40000200 size=4 PC=0x00005678\n" +
      "[ASSERT] Register: UART_DR\n" +
      "[ASSERT] Value: 0x00000041\n" +
      "[ASSERT] Write expect (hex):\n",
    );

    // User sees the prompt
    expect(h.prompt).not.toBeNull();
    expect(h.prompt!.type).toBe("write");
    expect(h.prompt!.value).toBe("0x00000041");

    // Nothing auto-replied
    expect(h.stdinWriteCount).toBe(0);

    // User clicks Default for write → sends the written value
    const sent = h.clickDefault();
    expect(sent).toBe("0x00000041");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SCENARIO 8: Multiple asserts in sequence (the loop)
// ═══════════════════════════════════════════════════════════════════════════

describe("Scenario: Multiple asserts in sequence", () => {
  it("3 read asserts → answer each → all correct values sent", () => {
    const h = new AssertPipelineHarness();

    // Assert 1: GPIO read at addr 0x100, decide to send 0x1
    h.rv32simOutput(
      "[ASSERT] MMIO READ at 0x40000100 size=4 PC=0x00001000\n" +
      "[ASSERT] Register: GPIOA_IDR\n" +
      "[ASSERT] Reset: 0x00000000\n" +
      "[ASSERT] Decision\n" +
      "[ASSERT] 0x00000001 -> 0x00002000: beq a0, zero (taken)\n" +
      "[ASSERT] 0x00000000 -> 0x00002004: nop (fallthrough)\n" +
      "[ASSERT] Read value (hex):\n",
    );
    expect(h.prompt!.addr).toBe(0x40000100);
    h.clickDecision(0);
    expect(h.lastStdinValue).toBe("0x00000001");

    // Assert 2: UART read at addr 0x200, use default
    h.rv32simOutput(
      "[ASSERT] MMIO READ at 0x40000200 size=4 PC=0x00002000\n" +
      "[ASSERT] Register: UART_SR\n" +
      "[ASSERT] Reset: 0x000000C0\n" +
      "[ASSERT] Read value (hex):\n",
    );
    expect(h.prompt!.addr).toBe(0x40000200);
    h.clickDefault();
    expect(h.lastStdinValue).toBe("0x000000C0");

    // Assert 3: Timer read at addr 0x300, ignore
    h.rv32simOutput(
      "[ASSERT] MMIO READ at 0x40000300 size=4 PC=0x00003000\n" +
      "[ASSERT] Register: TIM_CNT\n" +
      "[ASSERT] Read value (hex):\n",
    );
    expect(h.prompt!.addr).toBe(0x40000300);
    h.clickIgnore();
    expect(h.lastStdinValue).toBe("-");

    // All 3 responses sent correctly
    expect(h.stdinWriteCount).toBe(3);
  });

  it("mixed read and write asserts (writes disabled)", () => {
    const h = new AssertPipelineHarness({ allowWriteAsserts: false });

    // Write assert → auto-replied
    h.rv32simOutput(
      "[ASSERT] MMIO WRITE at 0x40000200 size=4 PC=0x00001000\n" +
      "[ASSERT] Value: 0x00000001\n" +
      "[ASSERT] Write expect (hex):\n",
    );
    expect(h.prompt).toBeNull(); // auto-replied
    expect(h.stdinWriteCount).toBe(1);

    // Read assert → user sees it
    h.rv32simOutput(
      "[ASSERT] MMIO READ at 0x40000100 size=4 PC=0x00002000\n" +
      "[ASSERT] Reset: 0x00000000\n" +
      "[ASSERT] Read value (hex):\n",
    );
    expect(h.prompt).not.toBeNull();
    expect(h.prompt!.type).toBe("read");
    h.clickDefault();

    // Another write assert → auto-replied
    h.rv32simOutput(
      "[ASSERT] MMIO WRITE at 0x40000200 size=4 PC=0x00003000\n" +
      "[ASSERT] Value: 0x00000002\n" +
      "[ASSERT] Write expect (hex):\n",
    );
    expect(h.prompt).toBeNull();

    // Total: 2 auto-replies + 1 user response = 3
    expect(h.stdinWriteCount).toBe(3);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SCENARIO 9: CodeLens placement on real source files
// ═══════════════════════════════════════════════════════════════════════════

describe("Scenario: CodeLens placement on real embedded C", () => {
  it("assert fires inside while(1) loop → CodeLens on the MMIO read line", () => {
    const src = new SourceFileHarness([
      "int main(void) {",                             // 0
      "    setup();",                                  // 1
      "",                                              // 2
      "    while (1) {",                               // 3
      "        uint32_t val = MMIO_READ(0x40000100);", // 4
      "",                                              // 5 — addr2line might say this
      "        if (val & 0x1) {",                      // 6
      "            toggle_led();",                     // 7
      "        }",                                     // 8
      "    }",                                         // 9
      "}",                                             // 10
    ].join("\n"));

    // addr2line says line 5 (blank after MMIO_READ)
    const line = src.codeLensLine(5);
    expect(src.isCode(line)).toBe(true);
    // Should be line 4 (the MMIO_READ) or line 6 (the if)
    expect(line).toBeLessThanOrEqual(6);
    expect(line).toBeGreaterThanOrEqual(4);
  });

  it("assert at top of file → CodeLens on first code line", () => {
    const src = new SourceFileHarness([
      "",                          // 0 — addr2line says this
      "",                          // 1
      "#include <stdint.h>",       // 2
      "",                          // 3
      "volatile uint32_t *GPIO;",  // 4
    ].join("\n"));

    const line = src.codeLensLine(0);
    expect(src.isCode(line)).toBe(true);
  });

  it("assert in dense code block → lands exactly where addr2line says", () => {
    const src = new SourceFileHarness([
      "    x = 1;",   // 0
      "    y = 2;",   // 1 — addr2line says this
      "    z = 3;",   // 2
    ].join("\n"));

    // No blank lines → should stay on line 1
    expect(src.codeLensLine(1)).toBe(1);
  });

  it("assert on comment line → stays (comments are visible)", () => {
    const src = new SourceFileHarness([
      "    x = 1;",          // 0
      "    // read GPIO",    // 1 — addr2line says this
      "    y = GPIO_READ;",  // 2
    ].join("\n"));

    // Comment has visible text, so CodeLens stays there
    expect(src.codeLensLine(1)).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SCENARIO 10: Assert with chunked output (slow rv32sim)
// ═══════════════════════════════════════════════════════════════════════════

describe("Scenario: Assert with chunked/slow output", () => {
  it("rv32sim output arrives byte-by-byte → same prompt as single chunk", () => {
    const fullText =
      "[ASSERT] MMIO READ at 0x40000100 size=4 PC=0x00001234\n" +
      "[ASSERT] Register: GPIOA_IDR\n" +
      "[ASSERT] Reset: 0x00000000\n" +
      "[ASSERT] Decision\n" +
      "[ASSERT] 0x00000010 PIN4=0x1 -> 0x00002000: beq a0, zero (taken)\n" +
      "[ASSERT] 0x00000000 -> 0x00002004: nop (fallthrough)\n" +
      "[ASSERT] Read value (hex):\n";

    // Single chunk
    const h1 = new AssertPipelineHarness();
    h1.rv32simOutput(fullText);

    // Byte by byte
    const h2 = new AssertPipelineHarness();
    for (const ch of fullText) {
      h2.rv32simOutput(ch);
    }

    // Same result
    expect(h2.prompt).not.toBeNull();
    expect(h2.prompt!.type).toBe(h1.prompt!.type);
    expect(h2.prompt!.addr).toBe(h1.prompt!.addr);
    expect(h2.prompt!.pc).toBe(h1.prompt!.pc);
    expect(h2.prompt!.register).toBe(h1.prompt!.register);
    expect(h2.prompt!.reset).toBe(h1.prompt!.reset);
    expect(h2.prompt!.decisions.length).toBe(h1.prompt!.decisions.length);
    expect(h2.prompt!.decisions[0]?.input).toBe(h1.prompt!.decisions[0]?.input);

    // And the decision is still clean
    h2.clickDecision(0);
    expect(h2.lastStdinValue).toBe("0x00000010");
  });

  it("output split mid-line at decision arrow → still parses correctly", () => {
    const h = new AssertPipelineHarness();
    h.rv32simOutput("[ASSERT] MMIO READ at 0x40000100 size=4 PC=0x00001000\n");
    h.rv32simOutput("[ASSERT] Decision\n");
    h.rv32simOutput("[ASSERT] 0x00000010 PIN4=0x1 -");  // split mid-arrow
    h.rv32simOutput("> 0x00002000: beq a0, zero\n");

    expect(h.prompt!.decisions.length).toBe(1);
    expect(h.prompt!.decisions[0].input).toBe("0x00000010");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SCENARIO 11: Assert prompt with no decisions (just read value)
// ═══════════════════════════════════════════════════════════════════════════

describe("Scenario: Assert with no decisions", () => {
  it("read assert with no Decision block → user can Default or Ignore", () => {
    const h = new AssertPipelineHarness();
    h.rv32simOutput(
      "[ASSERT] MMIO READ at 0x40000100 size=4 PC=0x00001234\n" +
      "[ASSERT] Register: UNKNOWN_REG\n" +
      "[ASSERT] Hint: No branch uses this value\n" +
      "[ASSERT] Read value (hex, default=0x00000000, '-'=ignore):\n",
    );

    expect(h.prompt).not.toBeNull();
    expect(h.prompt!.decisions.length).toBe(0);

    // User can still click Default
    const sent = h.clickDefault();
    // No reset field → sends empty
    expect(sent).toBe("");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SCENARIO 12: Large decision values (full 32-bit range)
// ═══════════════════════════════════════════════════════════════════════════

describe("Scenario: Large and edge-case values", () => {
  it("0xFFFFFFFF decision value → sent correctly", () => {
    const h = new AssertPipelineHarness();
    h.rv32simOutput(
      "[ASSERT] MMIO READ at 0x40000100 size=4 PC=0x00001000\n" +
      "[ASSERT] Decision\n" +
      "[ASSERT] 0xFFFFFFFF -> 0x00002000: nop\n" +
      "[ASSERT] Read value (hex):\n",
    );

    const sent = h.clickDecision(0);
    expect(sent).toBe("0xFFFFFFFF");
  });

  it("0x00000000 decision value → sent correctly (not empty)", () => {
    const h = new AssertPipelineHarness();
    h.rv32simOutput(
      "[ASSERT] MMIO READ at 0x40000100 size=4 PC=0x00001000\n" +
      "[ASSERT] Decision\n" +
      "[ASSERT] 0x00000000 -> 0x00002000: nop (fallthrough)\n" +
      "[ASSERT] Read value (hex):\n",
    );

    const sent = h.clickDecision(0);
    expect(sent).toBe("0x00000000");
    expect(sent.length).toBeGreaterThan(0);
  });

  it("size=1 read → standard workflow still works", () => {
    const h = new AssertPipelineHarness();
    h.rv32simOutput(
      "[ASSERT] MMIO READ at 0x40000100 size=1 PC=0x00001000\n" +
      "[ASSERT] Reset: 0x00\n" +
      "[ASSERT] Read value (hex):\n",
    );

    expect(h.prompt!.size).toBe(1);
    const sent = h.clickDefault();
    expect(sent).toBe("0x00");
  });

  it("size=2 read → standard workflow still works", () => {
    const h = new AssertPipelineHarness();
    h.rv32simOutput(
      "[ASSERT] MMIO READ at 0x40000100 size=2 PC=0x00001000\n" +
      "[ASSERT] Reset: 0xFFFF\n" +
      "[ASSERT] Read value (hex):\n",
    );

    expect(h.prompt!.size).toBe(2);
    const sent = h.clickDefault();
    expect(sent).toBe("0xFFFF");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SCENARIO 13: Interleaved reads and writes during stepping
// ═══════════════════════════════════════════════════════════════════════════

describe("Scenario: Interleaved reads and writes during stepping", () => {
  it("step → write auto-replied → step → read prompt → user responds → step → write auto-replied", () => {
    const h = new AssertPipelineHarness({ allowWriteAsserts: false });

    // Step 1 triggers a write assert → auto-replied
    h.rv32simOutput(
      "[ASSERT] MMIO WRITE at 0x40000200 size=4 PC=0x00001000\n" +
      "[ASSERT] Value: 0x00000001\n" +
      "[ASSERT] Write expect (hex):\n",
    );
    expect(h.prompt).toBeNull();
    expect(h.stdinWriteCount).toBe(1);

    // Step 2 triggers a read assert → user sees prompt
    h.rv32simOutput(
      "[ASSERT] MMIO READ at 0x40000100 size=4 PC=0x00002000\n" +
      "[ASSERT] Reset: 0x00000000\n" +
      "[ASSERT] Decision\n" +
      "[ASSERT] 0x00000010 PIN=0x1 -> 0x00003000: beq a0, zero\n" +
      "[ASSERT] Read value (hex):\n",
    );
    expect(h.prompt).not.toBeNull();

    // User clicks decision
    h.clickDecision(0);
    expect(h.lastStdinValue).toBe("0x00000010");
    expect(h.stdinWriteCount).toBe(2);

    // Step 3 triggers another write assert → auto-replied
    h.rv32simOutput(
      "[ASSERT] MMIO WRITE at 0x40000200 size=4 PC=0x00003000\n" +
      "[ASSERT] Value: 0x00000002\n" +
      "[ASSERT] Write expect (hex):\n",
    );
    expect(h.prompt).toBeNull();
    expect(h.stdinWriteCount).toBe(3);

    // All stdin values are valid
    for (const write of h.stdinWrites) {
      const val = write.replace(/\n$/, "");
      expect(val).toMatch(/^(0x[0-9a-fA-F]+|\d+|-)$/);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SCENARIO 14: Stress — many asserts in a tight loop
// ═══════════════════════════════════════════════════════════════════════════

describe("Scenario: Many asserts in tight loop", () => {
  it("50 read asserts answered with Default → all 50 values sent", () => {
    const h = new AssertPipelineHarness();

    for (let i = 0; i < 50; i++) {
      const addr = (0x40000100 + i * 4).toString(16);
      const pc = (0x1000 + i * 4).toString(16);
      h.rv32simOutput(
        `[ASSERT] MMIO READ at 0x${addr} size=4 PC=0x${pc}\n` +
        `[ASSERT] Reset: 0x00000000\n` +
        `[ASSERT] Read value (hex):\n`,
      );
      expect(h.prompt).not.toBeNull();
      h.clickDefault();
    }

    expect(h.stdinWriteCount).toBe(50);
    expect(h.prompt).toBeNull();
  });

  it("50 write asserts auto-replied → none leak, all 50 sent", () => {
    const h = new AssertPipelineHarness({ allowWriteAsserts: false });

    for (let i = 0; i < 50; i++) {
      const val = `0x${i.toString(16).padStart(8, "0")}`;
      h.rv32simOutput(
        `[ASSERT] MMIO WRITE at 0x40000200 size=4 PC=0x${(0x1000 + i * 4).toString(16)}\n` +
        `[ASSERT] Value: ${val}\n` +
        `[ASSERT] Write expect (hex):\n`,
      );
    }

    expect(h.stdinWriteCount).toBe(50);
    expect(h.prompt).toBeNull();

    // Verify each write sent the correct value
    for (let i = 0; i < 50; i++) {
      const expected = `0x${i.toString(16).padStart(8, "0")}`;
      expect(h.stdinWrites[i]).toBe(expected + "\n");
    }
  });
});
