import { describe, it, expect } from "vitest";
import { describeAssertPrompt, recommendAssertAction } from "../extension";
import type { AssertPrompt } from "../assertPrompt";

function makePrompt(overrides: Partial<AssertPrompt> = {}): AssertPrompt {
  return {
    type: "read",
    addr: 0x40000100,
    size: 4,
    pc: 0x1234,
    hints: [],
    decisions: [],
    rawLines: [],
    ...overrides,
  };
}

describe("describeAssertPrompt", () => {
  it("formats basic read prompt", () => {
    const result = describeAssertPrompt(makePrompt());
    expect(result.title).toBe("MMIO READ 0x40000100 size=4 pc=0x1234");
    expect(result.placeHolder).toBe("");
  });

  it("includes register in placeholder", () => {
    const result = describeAssertPrompt(makePrompt({ register: "GPIOA_ODR" }));
    expect(result.placeHolder).toContain("Register: GPIOA_ODR");
  });

  it("includes peripheral when no register", () => {
    const result = describeAssertPrompt(makePrompt({ peripheral: "UART1" }));
    expect(result.placeHolder).toContain("Peripheral: UART1");
  });

  it("prefers register over peripheral", () => {
    const result = describeAssertPrompt(
      makePrompt({ register: "REG", peripheral: "PER" })
    );
    expect(result.placeHolder).toContain("Register: REG");
    expect(result.placeHolder).not.toContain("Peripheral: PER");
  });

  it("includes reset in placeholder", () => {
    const result = describeAssertPrompt(makePrompt({ reset: "0x00000000" }));
    expect(result.placeHolder).toContain("Reset: 0x00000000");
  });

  it("includes fields in placeholder", () => {
    const result = describeAssertPrompt(makePrompt({ fields: "PIN0[0] PIN1[1]" }));
    expect(result.placeHolder).toContain("Fields: PIN0[0] PIN1[1]");
  });

  it("joins multiple parts with pipe", () => {
    const result = describeAssertPrompt(
      makePrompt({ register: "REG", reset: "0x0", fields: "F[0]" })
    );
    expect(result.placeHolder).toBe("Register: REG | Reset: 0x0 | Fields: F[0]");
  });

  it("formats write prompt", () => {
    const result = describeAssertPrompt(makePrompt({ type: "write" }));
    expect(result.title).toContain("WRITE");
  });
});

describe("recommendAssertAction", () => {
  it("recommends decision when only one option", () => {
    const prompt = makePrompt({
      decisions: [
        { input: "0x1", target: "0x1000", raw: "0x1 -> 0x1000" },
      ],
    });
    const rec = recommendAssertAction(prompt);
    expect(rec).not.toBeNull();
    expect(rec!.action).toBe("decision");
    expect(rec!.input).toBe("0x1");
  });

  it("recommends default when 'no branch uses this value' hint present", () => {
    const prompt = makePrompt({
      hints: ["No branch uses this value"],
    });
    const rec = recommendAssertAction(prompt);
    expect(rec).not.toBeNull();
    expect(rec!.action).toBe("default");
    expect(rec!.reason).toContain("No branch");
  });

  it("recommends ignore for write-only register write", () => {
    const prompt = makePrompt({
      type: "write",
      hints: ["Write-only register"],
    });
    const rec = recommendAssertAction(prompt);
    expect(rec).not.toBeNull();
    expect(rec!.action).toBe("ignore");
  });

  it("recommends default for write without write-only hint", () => {
    const prompt = makePrompt({ type: "write" });
    const rec = recommendAssertAction(prompt);
    expect(rec).not.toBeNull();
    expect(rec!.action).toBe("default");
    expect(rec!.reason).toContain("written value");
  });

  it("recommends default when reset value available", () => {
    const prompt = makePrompt({ reset: "0x00000000" });
    const rec = recommendAssertAction(prompt);
    expect(rec).not.toBeNull();
    expect(rec!.action).toBe("default");
    expect(rec!.reason).toContain("Reset value");
  });

  it("recommends default as fallback", () => {
    const prompt = makePrompt();
    const rec = recommendAssertAction(prompt);
    expect(rec).not.toBeNull();
    expect(rec!.action).toBe("default");
    expect(rec!.reason).toContain("safe starting point");
  });

  it("single decision takes priority over hints", () => {
    const prompt = makePrompt({
      hints: ["No branch uses this value"],
      decisions: [
        { input: "0x1", target: "0x1000", raw: "0x1 -> 0x1000" },
      ],
    });
    const rec = recommendAssertAction(prompt);
    expect(rec!.action).toBe("decision");
  });

  it("multiple decisions fall through to hint-based logic", () => {
    const prompt = makePrompt({
      hints: ["No branch uses this value"],
      decisions: [
        { input: "0x0", target: "0x1000", raw: "0x0 -> 0x1000" },
        { input: "0x1", target: "0x2000", raw: "0x1 -> 0x2000" },
      ],
    });
    const rec = recommendAssertAction(prompt);
    expect(rec!.action).toBe("default");
  });

  // B3.1 — Unknown hint text falls to default
  it("unknown hint text falls to default", () => {
    const prompt = makePrompt({
      hints: ["Random unknown hint"],
    });
    const rec = recommendAssertAction(prompt);
    expect(rec).not.toBeNull();
    expect(rec!.action).toBe("default");
  });

  // B3.2 — Three decisions, no single-decision shortcut
  it("three decisions with no hints falls to default", () => {
    const prompt = makePrompt({
      decisions: [
        { input: "0x0", target: "0x1000", raw: "0x0 -> 0x1000" },
        { input: "0x1", target: "0x2000", raw: "0x1 -> 0x2000" },
        { input: "0x2", target: "0x3000", raw: "0x2 -> 0x3000" },
      ],
    });
    const rec = recommendAssertAction(prompt);
    expect(rec).not.toBeNull();
    expect(rec!.action).toBe("default");
  });

  // B3.3 — Null/undefined optional fields → default with "safe starting point"
  it("null/undefined optional fields returns default safe starting point", () => {
    const prompt = makePrompt({
      reset: undefined,
      register: undefined,
      hints: [],
      decisions: [],
    });
    const rec = recommendAssertAction(prompt);
    expect(rec).not.toBeNull();
    expect(rec!.action).toBe("default");
    expect(rec!.reason.toLowerCase()).toContain("safe starting point");
  });

  // B3.4 — Empty decisions with reset present → uses reset
  it("empty decisions with reset present mentions reset", () => {
    const prompt = makePrompt({
      decisions: [],
      reset: "0x0",
      hints: [],
    });
    const rec = recommendAssertAction(prompt);
    expect(rec).not.toBeNull();
    expect(rec!.action).toBe("default");
    expect(rec!.reason.toLowerCase()).toContain("reset");
  });
});
