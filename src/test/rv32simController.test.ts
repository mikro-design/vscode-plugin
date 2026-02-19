import { describe, it, expect } from "vitest";
import { sanitizeAssertValue, shouldAutoReply, extractAssertLines } from "../rv32simController";

// ─── sanitizeAssertValue ───────────────────────────────

describe("sanitizeAssertValue", () => {
  it("returns empty for empty/null input", () => {
    expect(sanitizeAssertValue("")).toBe("");
    expect(sanitizeAssertValue("  ")).toBe("");
    expect(sanitizeAssertValue(null as any)).toBe("");
    expect(sanitizeAssertValue(undefined as any)).toBe("");
  });

  it("strips [ASSERT] prefix to prevent injection", () => {
    expect(sanitizeAssertValue("[ASSERT] MMIO READ at 0x4000")).toBe("");
    expect(sanitizeAssertValue("[ASSERT] anything")).toBe("");
    expect(sanitizeAssertValue("[ASSERT]")).toBe("");
  });

  it("passes through normal hex values", () => {
    expect(sanitizeAssertValue("0x0")).toBe("0x0");
    expect(sanitizeAssertValue("0x12345678")).toBe("0x12345678");
    expect(sanitizeAssertValue("0xFF")).toBe("0xFF");
    expect(sanitizeAssertValue("0xDEADBEEF")).toBe("0xDEADBEEF");
  });

  it("passes through decimal values", () => {
    expect(sanitizeAssertValue("42")).toBe("42");
    expect(sanitizeAssertValue("0")).toBe("0");
    expect(sanitizeAssertValue("255")).toBe("255");
  });

  it("takes only first line of multi-line input", () => {
    expect(sanitizeAssertValue("0x1\n0x2\n0x3")).toBe("0x1");
    expect(sanitizeAssertValue("hello\nworld")).toBe("hello");
    expect(sanitizeAssertValue("first\nsecond\nthird")).toBe("first");
  });

  it("strips carriage returns", () => {
    expect(sanitizeAssertValue("0x1\r\n0x2")).toBe("0x1");
    expect(sanitizeAssertValue("\r\n")).toBe("");
  });

  it("trims whitespace", () => {
    expect(sanitizeAssertValue("  0x1234  ")).toBe("0x1234");
    expect(sanitizeAssertValue("\t0xFF\t")).toBe("0xFF");
  });

  it("passes through field-annotated values unchanged (no comma conversion)", () => {
    expect(sanitizeAssertValue("0x0 PIN=0x1")).toBe("0x0 PIN=0x1");
    expect(sanitizeAssertValue("42 FOO=bar")).toBe("42 FOO=bar");
    expect(sanitizeAssertValue("0xAB LED_EN=0x1")).toBe("0xAB LED_EN=0x1");
    expect(sanitizeAssertValue("0x0 A=1 B=2")).toBe("0x0 A=1 B=2");
  });

  it("does not normalize if no field pattern matches", () => {
    expect(sanitizeAssertValue("hello world")).toBe("hello world");
    expect(sanitizeAssertValue("0x0 0x1")).toBe("0x0 0x1");
    expect(sanitizeAssertValue("abc def")).toBe("abc def");
  });

  it("passes through ignore marker", () => {
    expect(sanitizeAssertValue("-")).toBe("-");
  });

  it("blocks [ASSERT] even with leading whitespace (after trim)", () => {
    expect(sanitizeAssertValue("  [ASSERT] injected")).toBe("");
  });

  it("allows strings that contain ASSERT but don't start with [ASSERT]", () => {
    expect(sanitizeAssertValue("some ASSERT text")).toBe("some ASSERT text");
    expect(sanitizeAssertValue("ASSERT")).toBe("ASSERT");
  });
});

// ─── Round-trip: parser decision → sanitize → rv32sim stdin ──────────

describe("decision → sanitizeAssertValue round-trip", () => {
  // This test verifies the full pipeline: rv32sim outputs a decision line,
  // the parser extracts decision.input, the extension sends it through
  // sanitizeAssertValue, and the result must be a valid rv32sim stdin value.
  //
  // A valid rv32sim stdin value is: a hex number (0x...) or decimal number,
  // with NO commas, NO field annotations, NO spaces.

  function parseDecisionInput(line: string): string {
    // Simulate what parseDecision does to extract input
    const clean = line.replace(/^\[ASSERT\]\s*/, "").trim();
    const arrowIndex = clean.indexOf("->");
    if (arrowIndex <= 0) return "";
    const left = clean.slice(0, arrowIndex).trim();
    const inputMatch = left.match(/^(0x[0-9a-fA-F]+|\d+)/);
    return inputMatch ? inputMatch[1] : left;
  }

  const REAL_RV32SIM_DECISION_LINES = [
    // Simple hex, no annotations
    "[ASSERT] 0x00000001 -> 0x00001008: beq a0, zero (taken branch)",
    "[ASSERT] 0x00000000 -> 0x0000100c: addi a0, a0, 1 (fallthrough)",
    // With field annotations (the bug that caused the fiasco)
    "[ASSERT] 0x00000010 PIN=0x1 -> 0x00002000: lw a0, 0(sp)",
    "[ASSERT] 0x00000013 PIN0=0x1 PIN1=0x1 -> 0x00002004: beq a0, zero",
    // Large values
    "[ASSERT] 0xDEADBEEF DATA=0xFF -> 0x00003000: sw a0, 0(sp)",
    // Zero
    "[ASSERT] 0x00000000 PIN=0x0 -> 0x00003004: nop (fallthrough)",
    // Decimal
    "[ASSERT] 42 -> 0x00003008: nop",
    "[ASSERT] 255 CTRL=0x1 -> 0x0000300c: nop",
  ];

  for (const line of REAL_RV32SIM_DECISION_LINES) {
    it(`round-trip: ${line.slice(0, 60)}...`, () => {
      const input = parseDecisionInput(line);
      const sanitized = sanitizeAssertValue(input);

      // Must not be empty
      expect(sanitized.length).toBeGreaterThan(0);
      // Must not contain commas (rv32sim rejects "0x10,PIN=0x1")
      expect(sanitized).not.toContain(",");
      // Must not contain spaces (would be mangled or rejected)
      expect(sanitized).not.toContain(" ");
      // Must not contain field annotations
      expect(sanitized).not.toContain("=");
      // Must be a valid hex or decimal number
      expect(sanitized).toMatch(/^(0x[0-9a-fA-F]+|\d+)$/);
    });
  }

  it("sanitize never adds commas to any input", () => {
    // Exhaustive: no matter WHAT goes in, commas must never come out.
    // This is the specific bug that was missed.
    const inputs = [
      "0x0", "0x1", "0xFF", "0xDEADBEEF",
      "0", "1", "42", "255",
      "0x0 PIN=0x1",  // field-annotated (shouldn't reach sanitize, but if it does)
      "0x10 A=1 B=2",
      "-",
      "hello",
    ];
    for (const input of inputs) {
      const result = sanitizeAssertValue(input);
      expect(result).not.toContain(",");
    }
  });
});

// ─── shouldAutoReply ──────────────────────────────────

describe("shouldAutoReply", () => {
  function writePrompt(overrides: any = {}) {
    return {
      type: "write",
      addr: 0x40000100,
      size: 4,
      pc: 0x1000,
      rawLines: ["[ASSERT] MMIO WRITE at 0x40000100", "[ASSERT] Value: 0x00000041", "[ASSERT] Write expect (hex):"],
      ...overrides,
    };
  }

  it("returns true for write prompt with writes disabled and ready lines", () => {
    const result = shouldAutoReply(writePrompt(), false);
    expect(result.reply).toBe(true);
  });

  it("returns false for read prompts", () => {
    const result = shouldAutoReply(writePrompt({ type: "read" }), false);
    expect(result.reply).toBe(false);
  });

  it("returns false when writes are allowed", () => {
    const result = shouldAutoReply(writePrompt(), true);
    expect(result.reply).toBe(false);
  });

  it("returns false when prompt not ready (no Write expect / Value line)", () => {
    const result = shouldAutoReply(
      writePrompt({ rawLines: ["[ASSERT] MMIO WRITE at 0x40000100"] }),
      false,
    );
    expect(result.reply).toBe(false);
  });

  it("always auto-replies repeated writes when writes disabled", () => {
    const prompt = writePrompt();
    const first = shouldAutoReply(prompt, false);
    expect(first.reply).toBe(true);

    const second = shouldAutoReply(prompt, false);
    expect(second.reply).toBe(true);
  });

  it("detects readiness via [ASSERT] Value: line", () => {
    const prompt = writePrompt({
      rawLines: ["[ASSERT] MMIO WRITE", "[ASSERT] Value: 0x0"],
    });
    const result = shouldAutoReply(prompt, false);
    expect(result.reply).toBe(true);
  });

  it("detects readiness via [ASSERT] Write expect line", () => {
    const prompt = writePrompt({
      rawLines: ["[ASSERT] MMIO WRITE", "[ASSERT] Write expect (hex):"],
    });
    const result = shouldAutoReply(prompt, false);
    expect(result.reply).toBe(true);
  });
});

// ─── extractAssertLines ────────────────────────────────

describe("extractAssertLines", () => {
  it("extracts complete [ASSERT] lines", () => {
    const result = extractAssertLines("", "[ASSERT] MMIO READ at 0x4000\n");
    expect(result.lines).toEqual(["[ASSERT] MMIO READ at 0x4000"]);
    expect(result.buffer).toBe("");
  });

  it("buffers incomplete lines without flush trigger", () => {
    const result = extractAssertLines("", "[ASSERT] fi");
    expect(result.lines).toEqual([]);
    expect(result.buffer).toBe("[ASSERT] fi");
  });

  it("joins buffered content with new text", () => {
    const r1 = extractAssertLines("", "[ASSERT] fi");
    expect(r1.buffer).toBe("[ASSERT] fi");
    const r2 = extractAssertLines(r1.buffer, "rst line\n");
    expect(r2.lines).toEqual(["[ASSERT] first line"]);
    expect(r2.buffer).toBe("");
  });

  it("filters out non-ASSERT lines", () => {
    const result = extractAssertLines("", "some random output\n[ASSERT] important\nnot assert\n");
    expect(result.lines).toEqual(["[ASSERT] important"]);
    expect(result.buffer).toBe("");
  });

  it("handles multiple [ASSERT] lines", () => {
    const input =
      "[ASSERT] MMIO READ at 0x40000100 size=4 PC=0x00001234\n" +
      "[ASSERT] Register: GPIOA_ODR\n" +
      "[ASSERT] Reset: 0x00000000\n";
    const result = extractAssertLines("", input);
    expect(result.lines).toHaveLength(3);
    expect(result.lines[0]).toContain("MMIO READ");
    expect(result.lines[1]).toContain("Register:");
    expect(result.lines[2]).toContain("Reset:");
  });

  it("flushes partial lines that look like prompt triggers", () => {
    const result = extractAssertLines("", "[ASSERT] Read value (hex):");
    expect(result.lines).toEqual(["[ASSERT] Read value (hex):"]);
    expect(result.buffer).toBe("");
  });

  it("flushes partial lines with Write expect", () => {
    const result = extractAssertLines("", "[ASSERT] Write expect (hex):");
    expect(result.lines).toEqual(["[ASSERT] Write expect (hex):"]);
    expect(result.buffer).toBe("");
  });

  it("flushes partial lines with MMIO", () => {
    const result = extractAssertLines("", "[ASSERT] MMIO READ at 0x4000");
    expect(result.lines).toEqual(["[ASSERT] MMIO READ at 0x4000"]);
    expect(result.buffer).toBe("");
  });

  it("strips \\r from line endings", () => {
    const result = extractAssertLines("", "[ASSERT] test\r\n");
    expect(result.lines).toEqual(["[ASSERT] test"]);
  });

  it("handles empty input", () => {
    const result = extractAssertLines("", "");
    expect(result.lines).toEqual([]);
    expect(result.buffer).toBe("");
  });

  it("handles only newlines", () => {
    const result = extractAssertLines("", "\n\n\n");
    expect(result.lines).toEqual([]);
    expect(result.buffer).toBe("");
  });

  it("accumulates across multiple chunks", () => {
    const r1 = extractAssertLines("", "[ASSERT] fi");
    expect(r1.lines).toEqual([]);

    const r2 = extractAssertLines(r1.buffer, "rst line\n[ASSERT] se");
    expect(r2.lines).toEqual(["[ASSERT] first line"]);

    const r3 = extractAssertLines(r2.buffer, "cond line\n");
    expect(r3.lines).toEqual(["[ASSERT] second line"]);
    expect(r3.buffer).toBe("");
  });

  it("interleaves assert and non-assert content", () => {
    const input = "startup noise\n[ASSERT] a=1\nmore noise\n[ASSERT] b=2\nfinal noise\n";
    const result = extractAssertLines("", input);
    expect(result.lines).toEqual(["[ASSERT] a=1", "[ASSERT] b=2"]);
  });
});
