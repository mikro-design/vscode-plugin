import { describe, it, expect } from "vitest";
import { AssertPromptParser, AssertPrompt } from "../assertPrompt";

function createParser() {
  const updates: (AssertPrompt | null)[] = [];
  const parser = new AssertPromptParser((prompt) => updates.push(prompt ? { ...prompt, hints: [...prompt.hints], decisions: [...prompt.decisions], rawLines: [...prompt.rawLines] } : null));
  return { parser, updates };
}

describe("AssertPromptParser", () => {
  it("parses complete MMIO READ prompt", () => {
    const { parser, updates } = createParser();
    parser.feed(
      "[ASSERT] MMIO READ at 0x40000100 size=4 PC=0x00001234\n" +
      "[ASSERT] Register: GPIOA_ODR (Output Data Register)\n" +
      "[ASSERT] Reset: 0x00000000\n" +
      "[ASSERT] Fields: PIN0[0] PIN1[1] PIN2[2]\n" +
      "[ASSERT] Hint: No branch uses this value\n" +
      "[ASSERT] Read value (hex):\n"
    );

    expect(updates.length).toBeGreaterThanOrEqual(1);
    const last = updates[updates.length - 1]!;
    expect(last.type).toBe("read");
    expect(last.addr).toBe(0x40000100);
    expect(last.size).toBe(4);
    expect(last.pc).toBe(0x00001234);
    expect(last.register).toBe("GPIOA_ODR (Output Data Register)");
    expect(last.reset).toBe("0x00000000");
    expect(last.fields).toBe("PIN0[0] PIN1[1] PIN2[2]");
    expect(last.hints).toContain("No branch uses this value");
  });

  it("parses complete MMIO WRITE prompt", () => {
    const { parser, updates } = createParser();
    parser.feed(
      "[ASSERT] MMIO WRITE at 0x40000200 size=4 PC=0x00005678\n" +
      "[ASSERT] Register: UART_DR\n" +
      "[ASSERT] Value: 0x00000041\n" +
      "[ASSERT] Write expect (hex):\n"
    );

    const last = updates[updates.length - 1]!;
    expect(last.type).toBe("write");
    expect(last.addr).toBe(0x40000200);
    expect(last.pc).toBe(0x00005678);
    expect(last.value).toBe("0x00000041");
  });

  it("parses decisions with target addresses and notes", () => {
    const { parser, updates } = createParser();
    parser.feed(
      "[ASSERT] MMIO READ at 0x40000100 size=4 PC=0x00001000\n" +
      "[ASSERT] Decision\n" +
      "[ASSERT] 0x00000001 -> 0x00001008: beq a0, zero (taken branch)\n" +
      "[ASSERT] 0x00000000 -> 0x0000100c: addi a0, a0, 1 (fallthrough)\n"
    );

    const last = updates[updates.length - 1]!;
    expect(last.decisions.length).toBe(2);
    expect(last.decisions[0].input).toBe("0x00000001");
    expect(last.decisions[0].target).toBe("0x00001008: beq a0, zero");
    expect(last.decisions[0].targetPc).toBe(0x00001008);
    expect(last.decisions[0].targetAsm).toBe("beq a0, zero");
    expect(last.decisions[0].note).toBe("taken branch");
    expect(last.decisions[1].input).toBe("0x00000000");
    expect(last.decisions[1].note).toBe("fallthrough");
  });

  it("decision input strips field annotations (only hex value)", () => {
    const { parser, updates } = createParser();
    parser.feed(
      "[ASSERT] MMIO READ at 0x40000100 size=4 PC=0x00001000\n" +
      "[ASSERT] Decision\n" +
      "[ASSERT] 0x00000010 PIN=0x1 -> 0x00001008: beq a0, zero (taken branch)\n" +
      "[ASSERT] 0x00000000 -> 0x0000100c: addi a0, a0, 1 (fallthrough)\n"
    );

    const last = updates[updates.length - 1]!;
    expect(last.decisions.length).toBe(2);
    // input should be just the hex value, not "0x00000010 PIN=0x1"
    expect(last.decisions[0].input).toBe("0x00000010");
    expect(last.decisions[1].input).toBe("0x00000000");
  });

  it("handles partial line buffering (chunks split mid-line)", () => {
    const { parser, updates } = createParser();
    parser.feed("[ASSERT] MMIO READ at 0x4000");
    expect(updates.length).toBe(0);
    parser.feed("0100 size=4 PC=0x00001234\n");
    expect(updates.length).toBe(1);
    expect(updates[0]!.addr).toBe(0x40000100);
  });

  it("handles multiple sequential prompts", () => {
    const { parser, updates } = createParser();
    parser.feed("[ASSERT] MMIO READ at 0x40000100 size=4 PC=0x00001000\n");
    parser.feed("[ASSERT] Read value (hex):\n");
    const firstCount = updates.length;

    parser.feed("[ASSERT] MMIO READ at 0x40000200 size=2 PC=0x00002000\n");
    parser.feed("[ASSERT] Read value (hex):\n");

    expect(updates.length).toBeGreaterThan(firstCount);
    const last = updates[updates.length - 1]!;
    expect(last.addr).toBe(0x40000200);
    expect(last.size).toBe(2);
  });

  it("clear resets parser state", () => {
    const { parser, updates } = createParser();
    parser.feed("[ASSERT] MMIO READ at 0x40000100 size=4 PC=0x00001000\n");
    expect(updates.length).toBe(1);

    parser.clear();
    // After clear, subsequent lines without a new header shouldn't produce prompts
    parser.feed("[ASSERT] Hint: stale hint\n");
    // The hint goes to null current, so no new update for the prompt
    expect(updates.length).toBe(1);
  });

  it("parses peripheral field", () => {
    const { parser, updates } = createParser();
    parser.feed(
      "[ASSERT] MMIO READ at 0x40000100 size=4 PC=0x00001000\n" +
      "[ASSERT] Peripheral: GPIOA\n"
    );
    const last = updates[updates.length - 1]!;
    expect(last.peripheral).toBe("GPIOA");
  });

  // B1.1 — Missing size field: no prompt created
  it("ignores line without size field", () => {
    const { parser, updates } = createParser();
    parser.feed("[ASSERT] MMIO READ at 0x40000100 PC=0x1234\n");
    // Regex requires size=(\d+), no match → no prompt
    expect(updates.length).toBe(0);
  });

  // B1.2 — Duplicate register field: second overwrites
  it("duplicate register field, second overwrites first", () => {
    const { parser, updates } = createParser();
    parser.feed(
      "[ASSERT] MMIO READ at 0x40000100 size=4 PC=0x1234\n" +
      "[ASSERT] Register: A\n" +
      "[ASSERT] Register: B\n"
    );
    const last = updates[updates.length - 1]!;
    expect(last.register).toBe("B");
  });

  // B1.3 — Empty hint text
  it("handles empty hint text", () => {
    const { parser, updates } = createParser();
    parser.feed(
      "[ASSERT] MMIO READ at 0x40000100 size=4 PC=0x1234\n" +
      "[ASSERT] Hint: \n"
    );
    const last = updates[updates.length - 1]!;
    expect(last.hints.length).toBe(1);
    expect(last.hints[0]).toBe("");
  });

  // B1.4 — Decision block, no arrow → no decisions
  it("decision block with no arrow produces no decisions", () => {
    const { parser, updates } = createParser();
    parser.feed(
      "[ASSERT] MMIO READ at 0x40000100 size=4 PC=0x1234\n" +
      "[ASSERT] Decision\n" +
      "[ASSERT] something\n"
    );
    const last = updates[updates.length - 1]!;
    expect(last.decisions.length).toBe(0);
  });

  // B1.5 — Decision with arrow but no target
  it("decision with arrow but empty target", () => {
    const { parser, updates } = createParser();
    parser.feed(
      "[ASSERT] MMIO READ at 0x40000100 size=4 PC=0x1234\n" +
      "[ASSERT] Decision\n" +
      "[ASSERT] 0x1 ->\n"
    );
    const last = updates[updates.length - 1]!;
    expect(last.decisions.length).toBe(1);
    expect(last.decisions[0].input).toBe("0x1");
    expect(last.decisions[0].target).toBe("");
  });

  // B1.6 — Write prompt without Value line
  it("write prompt without Value line leaves value undefined", () => {
    const { parser, updates } = createParser();
    parser.feed(
      "[ASSERT] MMIO WRITE at 0x40000200 size=4 PC=0x5678\n" +
      "[ASSERT] Write expect\n"
    );
    const last = updates[updates.length - 1]!;
    expect(last.type).toBe("write");
    expect(last.value).toBeUndefined();
  });

  // B1.7 — Size=1 and size=2
  it("parses size=1 and size=2 correctly", () => {
    const { parser, updates } = createParser();
    parser.feed("[ASSERT] MMIO READ at 0x40000100 size=1 PC=0x1000\n");
    const first = updates[updates.length - 1]!;
    expect(first.size).toBe(1);

    parser.feed("[ASSERT] MMIO READ at 0x40000200 size=2 PC=0x2000\n");
    const second = updates[updates.length - 1]!;
    expect(second.size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Pedantic decision parser tests — every real rv32sim output format
// ---------------------------------------------------------------------------

describe("parseDecision — field annotations", () => {
  function createParser() {
    const updates: (AssertPrompt | null)[] = [];
    const parser = new AssertPromptParser((prompt) =>
      updates.push(
        prompt
          ? { ...prompt, hints: [...prompt.hints], decisions: [...prompt.decisions], rawLines: [...prompt.rawLines] }
          : null,
      ),
    );
    return { parser, updates };
  }

  function feedDecisions(decisionLines: string[]): AssertPrompt {
    const { parser, updates } = createParser();
    parser.feed(
      "[ASSERT] MMIO READ at 0x40000100 size=4 PC=0x00001000\n" +
      "[ASSERT] Decision\n" +
      decisionLines.map((l) => `[ASSERT] ${l}\n`).join(""),
    );
    return updates[updates.length - 1]!;
  }

  it("single field annotation stripped from input", () => {
    const prompt = feedDecisions([
      "0x00000010 PIN=0x1 -> 0x00002000: lw a0, 0(sp) (taken branch)",
    ]);
    expect(prompt.decisions[0].input).toBe("0x00000010");
    expect(prompt.decisions[0].note).toBe("taken branch");
  });

  it("multiple field annotations stripped from input", () => {
    const prompt = feedDecisions([
      "0x00000013 PIN0=0x1 PIN1=0x1 -> 0x00002000: beq a0, zero",
    ]);
    expect(prompt.decisions[0].input).toBe("0x00000013");
  });

  it("decimal value with field annotation", () => {
    const prompt = feedDecisions([
      "16 PIN=1 -> 0x00002000: beq a0, zero",
    ]);
    expect(prompt.decisions[0].input).toBe("16");
  });

  it("zero value with field annotation", () => {
    const prompt = feedDecisions([
      "0x00000000 PIN=0x0 -> 0x00002000: nop (fallthrough)",
    ]);
    expect(prompt.decisions[0].input).toBe("0x00000000");
  });

  it("large hex value with complex field annotation", () => {
    const prompt = feedDecisions([
      "0xDEADBEEF DATA_OUT=0xFF CTRL=0x1 -> 0x00003000: sw a0, 0(sp)",
    ]);
    expect(prompt.decisions[0].input).toBe("0xDEADBEEF");
  });

  it("no field annotation — input is plain hex", () => {
    const prompt = feedDecisions([
      "0x00000001 -> 0x00002000: beq a0, zero (taken branch)",
    ]);
    expect(prompt.decisions[0].input).toBe("0x00000001");
  });

  it("mixed: some decisions have field annotations, some don't", () => {
    const prompt = feedDecisions([
      "0x00000010 PIN=0x1 -> 0x00002000: beq a0, zero (taken branch)",
      "0x00000000 -> 0x00002004: addi a0, a0, 1 (fallthrough)",
    ]);
    expect(prompt.decisions.length).toBe(2);
    expect(prompt.decisions[0].input).toBe("0x00000010");
    expect(prompt.decisions[1].input).toBe("0x00000000");
  });

  it("decision input never contains spaces", () => {
    // This is the invariant: decision.input must be a clean value that
    // rv32sim accepts on stdin — never includes field annotations.
    const prompt = feedDecisions([
      "0x00000010 PIN=0x1 -> 0x00002000: beq a0, zero",
      "0x00000013 A=1 B=2 C=3 -> 0x00002004: nop",
      "42 FOO=bar -> 0x00002008: nop",
      "0xDEADBEEF -> 0x0000200c: nop",
    ]);
    for (const d of prompt.decisions) {
      expect(d.input).not.toContain(" ");
      expect(d.input).not.toContain("=");
    }
  });
});
