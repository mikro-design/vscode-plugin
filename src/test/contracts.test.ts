/**
 * Cross-module contract tests.
 *
 * These tests verify properties that span multiple modules and match
 * external system requirements.  Every test here is motivated by a
 * real bug or a real protocol constraint.
 *
 * Rule: a contract test must fail when the bug it guards is reintroduced.
 * If it can't fail, it's not a contract test.
 */

import { describe, it, expect } from "vitest";
import { AssertPromptParser, type AssertPrompt, type AssertDecision } from "../assertPrompt";
import { sanitizeAssertValue } from "../rv32simController";
import { isRunningStateErrorMessage } from "../rv32simDebugAdapter";
import { nudgeToCode } from "../assertLens";

// ---------------------------------------------------------------------------
// Contract 1: rv32sim stdin acceptance
//
// rv32sim reads a single line from stdin as the assert response.
// Valid formats:
//   - Hex: "0x00000000" through "0xFFFFFFFF"
//   - Decimal: "0" through "4294967295"
//   - Ignore marker: "-"
//   - Empty string (for writes, means "accept written value")
//
// INVALID formats that rv32sim REJECTS:
//   - Commas: "0x10,PIN=0x1" — rejected with "Expected FIELD=VAL"
//   - Field annotations: "0x10 PIN=0x1" — may cause parser confusion
//   - Multi-line: anything with \n in the middle
//   - [ASSERT] prefix: would be re-parsed as a new prompt
// ---------------------------------------------------------------------------

describe("Contract: rv32sim stdin acceptance", () => {
  /**
   * Parse decision lines from rv32sim output and verify the extracted
   * input value is safe to write to rv32sim stdin.
   */
  function extractDecisionInputs(lines: string[]): AssertDecision[] {
    const updates: AssertPrompt[] = [];
    const parser = new AssertPromptParser((prompt) => {
      if (prompt) {
        updates.push({
          ...prompt,
          hints: [...prompt.hints],
          decisions: [...prompt.decisions],
          rawLines: [...prompt.rawLines],
        });
      }
    });
    parser.feed(
      "[ASSERT] MMIO READ at 0x40000100 size=4 PC=0x00001000\n" +
      "[ASSERT] Decision\n" +
      lines.map((l) => l + "\n").join(""),
    );
    return updates[updates.length - 1]?.decisions ?? [];
  }

  // Real rv32sim decision output formats captured from actual sessions
  const REAL_RV32SIM_OUTPUTS = [
    // Simple hex values
    "[ASSERT] 0x00000000 -> 0x0000100c: addi a0, a0, 1 (fallthrough)",
    "[ASSERT] 0x00000001 -> 0x00001008: beq a0, zero (taken branch)",
    // Field-annotated values (THE BUG: these had annotations leaking through)
    "[ASSERT] 0x00000010 PIN=0x1 -> 0x00002000: lw a0, 0(sp)",
    "[ASSERT] 0x00000013 PIN0=0x1 PIN1=0x1 -> 0x00002004: beq a0, zero",
    "[ASSERT] 0x00000000 PIN=0x0 -> 0x00003004: nop (fallthrough)",
    // Large values with annotations
    "[ASSERT] 0xDEADBEEF DATA_OUT=0xFF CTRL=0x1 -> 0x00003000: sw a0, 0(sp)",
    // Decimal with annotations
    "[ASSERT] 255 CTRL=0x1 -> 0x0000300c: nop",
    // Simple decimal
    "[ASSERT] 42 -> 0x00003008: nop",
  ];

  for (const line of REAL_RV32SIM_OUTPUTS) {
    it(`stdin-safe: ${line.slice(9, 55)}`, () => {
      const decisions = extractDecisionInputs([line]);
      expect(decisions.length).toBe(1);

      const input = decisions[0].input;
      const sanitized = sanitizeAssertValue(input);

      // INVARIANT: what we write to stdin must be a clean numeric value
      expect(sanitized).toMatch(/^(0x[0-9a-fA-F]+|\d+)$/);
      // INVARIANT: no commas (rv32sim rejects "0x10,PIN=0x1")
      expect(sanitized).not.toContain(",");
      // INVARIANT: no spaces
      expect(sanitized).not.toContain(" ");
      // INVARIANT: no field annotations
      expect(sanitized).not.toContain("=");
    });
  }

  it("sanitize does NOT add commas to comma-free input", () => {
    // The production bug: sanitize ADDED commas where there were none.
    // "0x0 PIN=0x1" → "0x0,PIN=0x1" — the comma was inserted by sanitize.
    const commaFreeInputs = [
      "0x0", "0xFFFFFFFF", "0xDEADBEEF", "42", "0", "255",
      "0x0 PIN=0x1", "0x10 A=1 B=2 C=3",
      "-", "", "  0x1  ", "hello world",
      "[ASSERT] MMIO READ at 0x4000",
    ];
    for (const input of commaFreeInputs) {
      const result = sanitizeAssertValue(input);
      expect(result).not.toContain(",");
    }
  });

  it("sanitize blocks [ASSERT] injection via decision.input", () => {
    // If an attacker could craft a decision line where the "input" starts
    // with [ASSERT], it would be re-parsed as a new prompt by rv32sim.
    const injections = [
      "[ASSERT] MMIO READ at 0x4000",
      "[ASSERT] anything",
      "[ASSERT]",
    ];
    for (const input of injections) {
      expect(sanitizeAssertValue(input)).toBe("");
    }
  });

  it("decision.input is always single-line", () => {
    // Multi-line would confuse rv32sim stdin reading
    for (const line of REAL_RV32SIM_OUTPUTS) {
      const decisions = extractDecisionInputs([line]);
      for (const d of decisions) {
        expect(d.input).not.toContain("\n");
        expect(d.input).not.toContain("\r");
      }
    }
  });

  it("default response for read prompt is valid", () => {
    // When the user clicks "Default", we send prompt.reset ?? ""
    const updates: AssertPrompt[] = [];
    const parser = new AssertPromptParser((p) => {
      if (p) updates.push({ ...p, hints: [...p.hints], decisions: [...p.decisions], rawLines: [...p.rawLines] });
    });
    parser.feed(
      "[ASSERT] MMIO READ at 0x40000100 size=4 PC=0x1234\n" +
      "[ASSERT] Reset: 0x00000000\n" +
      "[ASSERT] Read value (hex):\n",
    );
    const prompt = updates[updates.length - 1]!;
    const defaultValue = prompt.reset ?? "";
    const sanitized = sanitizeAssertValue(defaultValue);
    expect(sanitized).toMatch(/^(0x[0-9a-fA-F]+|\d+|)$/);
  });

  it("ignore marker passes through sanitize unchanged", () => {
    // "-" means "ignore this assert" in rv32sim
    expect(sanitizeAssertValue("-")).toBe("-");
  });
});

// ---------------------------------------------------------------------------
// Contract 2: GDB/MI state machine
//
// GDB has strict rules about what commands are valid in what states:
// - When target is running: ONLY -exec-interrupt is valid
// - When target is stopped: -exec-continue, -exec-next, etc. are valid
// - "Selected thread is running" is the error GDB returns for violations
//
// The adapter must detect these errors and NOT retry the same command.
// ---------------------------------------------------------------------------

describe("Contract: GDB state machine error detection", () => {
  // Real GDB error messages captured from actual sessions
  const REAL_GDB_RUNNING_ERRORS = [
    'mi_cmd_exec_continue: Selected thread is running.',
    'Cannot execute this command while the selected thread is running.',
    'Selected thread is running.',
    '^error,msg="Cannot execute this command while the target is running"',
    'Running thread is required for this command',
  ];

  for (const msg of REAL_GDB_RUNNING_ERRORS) {
    it(`detects running-state error: "${msg.slice(0, 50)}"`, () => {
      expect(isRunningStateErrorMessage(msg)).toBe(true);
    });
  }

  const NOT_RUNNING_ERRORS = [
    'No symbol table is loaded.',
    'Breakpoint 1, main () at main.c:5',
    'No registers.',
    '',
    null,
    undefined,
  ];

  for (const msg of NOT_RUNNING_ERRORS) {
    it(`does NOT false-positive: ${JSON.stringify(msg)?.slice(0, 40)}`, () => {
      expect(isRunningStateErrorMessage(msg)).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// Contract 3: Visual line placement
//
// When we show CodeLens or reveal a source location, the line MUST have
// visible content.  An empty line or whitespace-only line means the user
// sees a floating CodeLens with no code context — confusing and wrong.
//
// addr2line commonly returns off-by-one lines due to:
// - Macro expansion
// - Compiler debug info rounding
// - Blank lines between function signature and first statement
// - Empty lines after #include blocks
// ---------------------------------------------------------------------------

describe("Contract: visual line placement", () => {
  function doc(lines: string[]) {
    return (i: number) => (i >= 0 && i < lines.length ? lines[i] : undefined);
  }

  // Real embedded C source patterns where addr2line returns wrong line
  const REAL_PATTERNS: { name: string; lines: string[]; addr2lineLine: number; mustNotBe: number[] }[] = [
    {
      name: "blank after function brace",
      lines: [
        "void foo(void) {",  // 0
        "",                   // 1 ← addr2line says this
        "    int x = 0;",    // 2
        "}",                 // 3
      ],
      addr2lineLine: 1,
      mustNotBe: [1],  // must NOT stay on empty line
    },
    {
      name: "blank between #include and code",
      lines: [
        "#include <stdint.h>",  // 0
        "",                      // 1 ← addr2line
        "int main(void) {",     // 2
      ],
      addr2lineLine: 1,
      mustNotBe: [1],
    },
    {
      name: "blank after volatile write",
      lines: [
        "    *(volatile uint32_t*)0x40000200 = 0x10;",  // 0
        "",                                                // 1 ← addr2line
        "    while(1) {",                                 // 2
      ],
      addr2lineLine: 1,
      mustNotBe: [1],
    },
    {
      name: "multiple consecutive blanks",
      lines: [
        "    int x = 0;",  // 0
        "",                 // 1
        "",                 // 2
        "",                 // 3 ← addr2line
        "    int y = 1;",  // 4
      ],
      addr2lineLine: 3,
      mustNotBe: [1, 2, 3],
    },
    {
      name: "whitespace-only line (tabs/spaces)",
      lines: [
        "    int x = 0;",   // 0
        "   \t  ",          // 1 ← addr2line
        "    int y = 1;",   // 2
      ],
      addr2lineLine: 1,
      mustNotBe: [1],
    },
  ];

  for (const pattern of REAL_PATTERNS) {
    it(`never lands on empty line: ${pattern.name}`, () => {
      const result = nudgeToCode(
        pattern.addr2lineLine,
        pattern.lines.length,
        doc(pattern.lines),
      );
      for (const bad of pattern.mustNotBe) {
        expect(result).not.toBe(bad);
      }
      // The result line must have visible content
      const text = pattern.lines[result];
      expect(text).toBeDefined();
      expect(text!.trim().length).toBeGreaterThan(0);
    });
  }

  it("INVARIANT: nudgeToCode output always has visible content (when available)", () => {
    // Generative test: random documents, verify invariant
    const rng = (seed: number) => {
      let s = seed;
      return () => {
        s = (s * 1103515245 + 12345) & 0x7fffffff;
        return s / 0x7fffffff;
      };
    };
    const rand = rng(42);

    for (let trial = 0; trial < 200; trial++) {
      const lineCount = Math.floor(rand() * 20) + 1;
      const lines: string[] = [];
      let hasCode = false;
      for (let i = 0; i < lineCount; i++) {
        if (rand() < 0.4) {
          lines.push("");
        } else if (rand() < 0.2) {
          lines.push("   \t  ");
        } else {
          lines.push(`code_line_${i}`);
          hasCode = true;
        }
      }

      const targetLine = Math.floor(rand() * lineCount);
      const result = nudgeToCode(targetLine, lineCount, (i) =>
        i >= 0 && i < lines.length ? lines[i] : undefined,
      );

      // If there's ANY code within ±5 lines, we must land on code
      const nearby = lines.slice(
        Math.max(0, targetLine - 5),
        Math.min(lineCount, targetLine + 6),
      );
      const hasNearbyCode = nearby.some((l) => l.trim().length > 0);

      if (hasNearbyCode) {
        const text = lines[result];
        expect(text?.trim().length).toBeGreaterThan(0);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Contract 4: Parser completeness against rv32sim output
//
// The parser must handle every format rv32sim outputs.  Missing a format
// means the assert prompt never reaches the UI, or reaches it with wrong
// data.  The decision.input specifically must be safe for stdin.
// ---------------------------------------------------------------------------

describe("Contract: parser handles all rv32sim output formats", () => {
  function parsePrompt(text: string): AssertPrompt {
    const updates: AssertPrompt[] = [];
    const parser = new AssertPromptParser((p) => {
      if (p) updates.push({ ...p, hints: [...p.hints], decisions: [...p.decisions], rawLines: [...p.rawLines] });
    });
    parser.feed(text);
    return updates[updates.length - 1]!;
  }

  // Full rv32sim output for a read prompt with decisions
  it("full read prompt with field-annotated decisions", () => {
    const prompt = parsePrompt(
      "[ASSERT] MMIO READ at 0x40000100 size=4 PC=0x00001234\n" +
      "[ASSERT] Peripheral: GPIOA\n" +
      "[ASSERT] Register: GPIOA_IDR (Input Data Register)\n" +
      "[ASSERT] Reset: 0x00000000\n" +
      "[ASSERT] Fields: PIN0[0] PIN1[1] PIN2[2] PIN3[3]\n" +
      "[ASSERT] Hint: No branch uses this value\n" +
      "[ASSERT] Decision\n" +
      "[ASSERT] 0x00000010 PIN4=0x1 -> 0x00002000: beq a0, zero (taken branch)\n" +
      "[ASSERT] 0x00000000 -> 0x00002004: addi a0, a0, 1 (fallthrough)\n" +
      "[ASSERT] Read value (hex, default=0x00000000, '-'=ignore):\n",
    );

    expect(prompt.type).toBe("read");
    expect(prompt.addr).toBe(0x40000100);
    expect(prompt.pc).toBe(0x00001234);
    expect(prompt.peripheral).toBe("GPIOA");
    expect(prompt.register).toBe("GPIOA_IDR (Input Data Register)");
    expect(prompt.reset).toBe("0x00000000");
    expect(prompt.fields).toBe("PIN0[0] PIN1[1] PIN2[2] PIN3[3]");
    expect(prompt.hints).toContain("No branch uses this value");
    expect(prompt.decisions.length).toBe(2);

    // THE KEY INVARIANT: decision.input is a clean value for rv32sim stdin
    expect(prompt.decisions[0].input).toBe("0x00000010");
    expect(prompt.decisions[0].input).not.toContain(" ");
    expect(prompt.decisions[0].input).not.toContain("=");
    expect(prompt.decisions[1].input).toBe("0x00000000");
  });

  // Full rv32sim output for a write prompt
  it("full write prompt", () => {
    const prompt = parsePrompt(
      "[ASSERT] MMIO WRITE at 0x40000200 size=4 PC=0x00005678\n" +
      "[ASSERT] Peripheral: GPIOA\n" +
      "[ASSERT] Register: GPIOA_ODR (Output Data Register)\n" +
      "[ASSERT] Value: 0x00000041\n" +
      "[ASSERT] Write expect (hex, default=written, '-'=ignore):\n",
    );

    expect(prompt.type).toBe("write");
    expect(prompt.addr).toBe(0x40000200);
    expect(prompt.pc).toBe(0x00005678);
    expect(prompt.value).toBe("0x00000041");

    // For write auto-reply, we send prompt.value back — must be valid
    const sanitized = sanitizeAssertValue(prompt.value!);
    expect(sanitized).toMatch(/^0x[0-9a-fA-F]+$/);
  });

  // Parser must fire onUpdate for every line (the UI relies on incremental updates)
  it("fires update on every meaningful line", () => {
    let updateCount = 0;
    const parser = new AssertPromptParser((p) => {
      if (p) updateCount++;
    });
    parser.feed("[ASSERT] MMIO READ at 0x40000100 size=4 PC=0x1234\n");
    expect(updateCount).toBe(1);
    parser.feed("[ASSERT] Register: REG\n");
    expect(updateCount).toBe(2);
    parser.feed("[ASSERT] Reset: 0x0\n");
    expect(updateCount).toBe(3);
    parser.feed("[ASSERT] Fields: F[0]\n");
    expect(updateCount).toBe(4);
    parser.feed("[ASSERT] Hint: test hint\n");
    expect(updateCount).toBe(5);
  });

  it("chunked input produces same result as single input", () => {
    const fullText =
      "[ASSERT] MMIO READ at 0x40000100 size=4 PC=0x1234\n" +
      "[ASSERT] Register: GPIOA_IDR\n" +
      "[ASSERT] Reset: 0x00000000\n" +
      "[ASSERT] Decision\n" +
      "[ASSERT] 0x00000010 PIN=0x1 -> 0x00002000: beq a0, zero (taken)\n" +
      "[ASSERT] Read value (hex):\n";

    // Parse as single chunk
    const single = parsePrompt(fullText);

    // Parse as individual bytes (worst-case chunking)
    const updates: AssertPrompt[] = [];
    const parser = new AssertPromptParser((p) => {
      if (p) updates.push({ ...p, hints: [...p.hints], decisions: [...p.decisions], rawLines: [...p.rawLines] });
    });
    for (let i = 0; i < fullText.length; i++) {
      parser.feed(fullText[i]);
    }
    const chunked = updates[updates.length - 1]!;

    // Same result regardless of chunking
    expect(chunked.type).toBe(single.type);
    expect(chunked.addr).toBe(single.addr);
    expect(chunked.pc).toBe(single.pc);
    expect(chunked.register).toBe(single.register);
    expect(chunked.reset).toBe(single.reset);
    expect(chunked.decisions.length).toBe(single.decisions.length);
    expect(chunked.decisions[0]?.input).toBe(single.decisions[0]?.input);
  });
});

// ---------------------------------------------------------------------------
// Contract 5: Controller → stdin round-trip
//
// When the controller calls sendAssertResponse(decision.input), the value
// that hits proc.stdin.write must be what rv32sim expects.  This is the
// FULL pipeline test: parser → controller → sanitize → stdin.
// ---------------------------------------------------------------------------

describe("Contract: controller stdin round-trip", () => {
  // We can't easily instantiate the full controller in unit tests without
  // the vscode mock, but we CAN test the pipeline at the function level:
  // parseDecision extracts input → sanitizeAssertValue cleans it →
  // the result goes to stdin.  The controller just calls these in sequence.

  it("field-annotated decision → sanitize → valid stdin value", () => {
    const updates: AssertPrompt[] = [];
    const parser = new AssertPromptParser((p) => {
      if (p) updates.push({ ...p, hints: [...p.hints], decisions: [...p.decisions], rawLines: [...p.rawLines] });
    });

    // This is EXACTLY what rv32sim outputs when a GPIO pin read has a
    // field annotation showing which bit is set
    parser.feed(
      "[ASSERT] MMIO READ at 0x40000100 size=4 PC=0x00001000\n" +
      "[ASSERT] Decision\n" +
      "[ASSERT] 0x00000010 PIN=0x1 -> 0x00002000: beq a0, zero (taken branch)\n" +
      "[ASSERT] 0x00000000 -> 0x00002004: nop (fallthrough)\n" +
      "[ASSERT] Read value (hex):\n",
    );

    const prompt = updates[updates.length - 1]!;
    const decision = prompt.decisions[0];

    // This is what the extension sends to controller.sendAssertResponse()
    const valueForStdin = sanitizeAssertValue(decision.input);

    // This is what hits rv32sim stdin
    expect(valueForStdin).toBe("0x00000010");
    // NOT "0x00000010,PIN=0x1" (the old bug)
    // NOT "0x00000010 PIN=0x1" (the raw left side)
  });
});
