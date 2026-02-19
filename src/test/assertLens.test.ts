import { describe, it, expect } from "vitest";
import { nudgeToCode } from "../assertLens";

// ---------------------------------------------------------------------------
// nudgeToCode — the function that maps addr2line output to a visible code
// line.  This is where "CodeLens on empty lines" bugs live.
// ---------------------------------------------------------------------------

describe("nudgeToCode", () => {
  /** Helper: build lineText from an array of strings. */
  function makeDoc(lines: string[]): (i: number) => string | undefined {
    return (i: number) => (i >= 0 && i < lines.length ? lines[i] : undefined);
  }

  // ── Basic: target line has code ────────────────────────────────────────

  it("returns same line when it has code", () => {
    const doc = makeDoc(["int x = 1;", "", "int y = 2;"]);
    expect(nudgeToCode(0, 3, doc)).toBe(0);
    expect(nudgeToCode(2, 3, doc)).toBe(2);
  });

  // ── Empty line → nudge to nearest code ─────────────────────────────────

  it("empty line nudges UP to nearest code", () => {
    //  0: "int x = 1;"
    //  1: ""            ← addr2line points here
    //  2: "int y = 2;"
    const doc = makeDoc(["int x = 1;", "", "int y = 2;"]);
    // Should prefer line 0 (one above) over line 2 (one below)
    expect(nudgeToCode(1, 3, doc)).toBe(0);
  });

  it("empty line nudges DOWN when nothing above", () => {
    //  0: ""            ← addr2line points here
    //  1: "int x = 1;"
    const doc = makeDoc(["", "int x = 1;"]);
    expect(nudgeToCode(0, 2, doc)).toBe(1);
  });

  // ── Whitespace-only line (tabs/spaces) ─────────────────────────────────

  it("whitespace-only line is treated as empty", () => {
    const doc = makeDoc(["int x;", "   \t  ", "int y;"]);
    expect(nudgeToCode(1, 3, doc)).toBe(0);
  });

  // ── Comment-only lines ─────────────────────────────────────────────────

  it("comment-only line is NOT empty (has visible text)", () => {
    // Comments have non-whitespace characters, so nudgeToCode should
    // treat them as code (they're visible in the editor).
    const doc = makeDoc(["", "// this is a comment", ""]);
    expect(nudgeToCode(0, 3, doc)).toBe(1);
    expect(nudgeToCode(2, 3, doc)).toBe(1);
    // If we're ON the comment line, stay there
    expect(nudgeToCode(1, 3, doc)).toBe(1);
  });

  // ── Multiple consecutive empty lines ───────────────────────────────────

  it("skips multiple empty lines to find code", () => {
    //  0: "int x;"
    //  1: ""
    //  2: ""
    //  3: ""            ← addr2line points here
    //  4: "int y;"
    const doc = makeDoc(["int x;", "", "", "", "int y;"]);
    expect(nudgeToCode(3, 5, doc)).toBe(4);  // 1 away vs 3 away
    expect(nudgeToCode(2, 5, doc)).toBe(0);  // 2 away vs 2 away — prefers up
    expect(nudgeToCode(1, 5, doc)).toBe(0);  // 1 above
  });

  // ── Real scenario: addr2line off-by-one after function brace ───────────

  it("real scenario: off-by-one to blank line between function brace and first stmt", () => {
    //  0: "void foo(void) {"
    //  1: ""                    ← addr2line says this
    //  2: "    int x = 0;"
    //  3: "    return;"
    //  4: "}"
    const doc = makeDoc([
      "void foo(void) {",
      "",
      "    int x = 0;",
      "    return;",
      "}",
    ]);
    expect(nudgeToCode(1, 5, doc)).toBe(0);
  });

  // ── Real scenario: blank line after #include block ─────────────────────

  it("real scenario: blank line after #include and before code", () => {
    //  0: "#include <stdint.h>"
    //  1: ""                    ← addr2line says this
    //  2: "int main(void) {"
    const doc = makeDoc([
      "#include <stdint.h>",
      "",
      "int main(void) {",
    ]);
    expect(nudgeToCode(1, 3, doc)).toBe(0);
  });

  // ── All empty within ±5 range ──────────────────────────────────────────

  it("returns original line when all lines within range are empty", () => {
    // 12 empty lines — line 6 is center, ±5 are all empty
    const lines = Array(12).fill("");
    const doc = makeDoc(lines);
    expect(nudgeToCode(6, 12, doc)).toBe(6);
  });

  it("finds code just at maxOffset boundary", () => {
    // line 0: code, lines 1-5: empty, line 5 target
    const lines = ["int x;", "", "", "", "", ""];
    const doc = makeDoc(lines);
    // line 5, maxOffset=5 → should find line 0 (offset=5)
    expect(nudgeToCode(5, 6, doc, 5)).toBe(0);
  });

  it("does NOT find code beyond maxOffset boundary", () => {
    // line 0: code, lines 1-6: empty
    const lines = ["int x;", "", "", "", "", "", ""];
    const doc = makeDoc(lines);
    // line 6, maxOffset=5 → line 0 is 6 away, beyond range
    expect(nudgeToCode(6, 7, doc, 5)).toBe(6);
  });

  // ── Edge cases ─────────────────────────────────────────────────────────

  it("line beyond lineCount clamps to last line", () => {
    const doc = makeDoc(["code"]);
    expect(nudgeToCode(99, 1, doc)).toBe(0);
  });

  it("negative line clamps to 0", () => {
    const doc = makeDoc(["code"]);
    expect(nudgeToCode(-5, 1, doc)).toBe(0);
  });

  it("single-line document, line has code", () => {
    const doc = makeDoc(["int x;"]);
    expect(nudgeToCode(0, 1, doc)).toBe(0);
  });

  it("single-line document, line is empty", () => {
    const doc = makeDoc([""]);
    expect(nudgeToCode(0, 1, doc)).toBe(0);
  });

  it("empty document (lineCount=0)", () => {
    const doc = makeDoc([]);
    expect(nudgeToCode(0, 0, doc)).toBe(0);
  });

  // ── Preference: up before down at equal distance ───────────────────────

  it("prefers UP when code is equidistant up and down", () => {
    //  0: "above"
    //  1: ""      ← target
    //  2: "below"
    const doc = makeDoc(["above", "", "below"]);
    expect(nudgeToCode(1, 3, doc)).toBe(0);
  });

  // ── Real embedded C pattern: empty line after global volatile ──────────

  it("real scenario: blank between volatile register write and next stmt", () => {
    //  0: "    *(volatile uint32_t*)0x40000200 = 0x10;"
    //  1: ""                                             ← addr2line
    //  2: "    while(1) {"
    const doc = makeDoc([
      "    *(volatile uint32_t*)0x40000200 = 0x10;",
      "",
      "    while(1) {",
    ]);
    expect(nudgeToCode(1, 3, doc)).toBe(0);
  });

  // ── Custom maxOffset ──────────────────────────────────────────────────

  it("respects custom maxOffset", () => {
    const lines = ["code", "", ""];
    const doc = makeDoc(lines);
    // maxOffset=1: line 2 → can reach line 1 (empty), not line 0
    expect(nudgeToCode(2, 3, doc, 1)).toBe(2);
    // maxOffset=2: line 2 → can reach line 0
    expect(nudgeToCode(2, 3, doc, 2)).toBe(0);
  });
});
