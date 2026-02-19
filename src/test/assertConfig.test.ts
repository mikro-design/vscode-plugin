import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { isAssertFileEmpty } from "../assertConfig";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "assert-cfg-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("isAssertFileEmpty", () => {
  it("returns true for nonexistent file", () => {
    expect(isAssertFileEmpty(path.join(tmpDir, "nope.json"))).toBe(true);
  });

  it("returns true for empty file", () => {
    const p = path.join(tmpDir, "empty.json");
    fs.writeFileSync(p, "");
    expect(isAssertFileEmpty(p)).toBe(true);
  });

  it("returns true for whitespace-only file", () => {
    const p = path.join(tmpDir, "ws.json");
    fs.writeFileSync(p, "   \n\n  ");
    expect(isAssertFileEmpty(p)).toBe(true);
  });

  it("returns true for null JSON", () => {
    const p = path.join(tmpDir, "null.json");
    fs.writeFileSync(p, "null");
    expect(isAssertFileEmpty(p)).toBe(true);
  });

  it("returns true for empty object", () => {
    const p = path.join(tmpDir, "obj.json");
    fs.writeFileSync(p, "{}");
    expect(isAssertFileEmpty(p)).toBe(true);
  });

  it("returns true for empty array", () => {
    const p = path.join(tmpDir, "arr.json");
    fs.writeFileSync(p, "[]");
    expect(isAssertFileEmpty(p)).toBe(true);
  });

  it("returns true for {assertions: {}}", () => {
    const p = path.join(tmpDir, "assertions.json");
    fs.writeFileSync(p, JSON.stringify({ assertions: {} }));
    expect(isAssertFileEmpty(p)).toBe(true);
  });

  it("returns true for {entries: []}", () => {
    const p = path.join(tmpDir, "entries.json");
    fs.writeFileSync(p, JSON.stringify({ entries: [] }));
    expect(isAssertFileEmpty(p)).toBe(true);
  });

  it("returns true for {rules: []}", () => {
    const p = path.join(tmpDir, "rules.json");
    fs.writeFileSync(p, JSON.stringify({ rules: [] }));
    expect(isAssertFileEmpty(p)).toBe(true);
  });

  it("returns false for {assertions: {some: data}}", () => {
    const p = path.join(tmpDir, "filled.json");
    fs.writeFileSync(p, JSON.stringify({ assertions: { "0x4000": "0x1" } }));
    expect(isAssertFileEmpty(p)).toBe(false);
  });

  it("returns false for non-empty array", () => {
    const p = path.join(tmpDir, "data.json");
    fs.writeFileSync(p, JSON.stringify([{ addr: 1 }]));
    expect(isAssertFileEmpty(p)).toBe(false);
  });

  it("returns false for {entries: [item]}", () => {
    const p = path.join(tmpDir, "entries2.json");
    fs.writeFileSync(p, JSON.stringify({ entries: [{ addr: 1 }] }));
    expect(isAssertFileEmpty(p)).toBe(false);
  });

  it("returns false for {rules: [rule]}", () => {
    const p = path.join(tmpDir, "rules2.json");
    fs.writeFileSync(p, JSON.stringify({ rules: [{ match: "*" }] }));
    expect(isAssertFileEmpty(p)).toBe(false);
  });

  it("returns false for object with arbitrary keys", () => {
    const p = path.join(tmpDir, "arb.json");
    fs.writeFileSync(p, JSON.stringify({ foo: "bar" }));
    expect(isAssertFileEmpty(p)).toBe(false);
  });

  it("returns true for invalid JSON (parse error)", () => {
    const p = path.join(tmpDir, "bad.json");
    fs.writeFileSync(p, "{not valid json");
    expect(isAssertFileEmpty(p)).toBe(true);
  });

  it("handles pretty-printed JSON with newlines", () => {
    const p = path.join(tmpDir, "pretty.json");
    fs.writeFileSync(p, JSON.stringify({ assertions: {} }, null, 2) + "\n");
    expect(isAssertFileEmpty(p)).toBe(true);
  });

  it("handles nested assertions with data", () => {
    const p = path.join(tmpDir, "nested.json");
    fs.writeFileSync(p, JSON.stringify({
      assertions: {
        "0x40000100": { type: "read", value: "0x0" },
      },
    }));
    expect(isAssertFileEmpty(p)).toBe(false);
  });
});
