/**
 * MI Parser fuzz tests — exercises parseMiLine(), parseMiValue(), parseMiCString()
 * with pathological inputs. Verifies no uncaught exceptions, no infinite loops
 * (via vitest timeout), and no stack overflows.
 */

import { describe, it, expect } from "vitest";
import {
  parseMiLine,
  parseMiValue,
  parseMiCString,
  parseMiCStringWithIndex,
  parseMiResults,
} from "../miParser";

// Seeded LCG for deterministic "random" fuzzing
function createRng(seed: number) {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (1664525 * s + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

describe("MI parser fuzz — pathological inputs", () => {
  it("deeply nested tuples (1000 levels)", { timeout: 5000 }, () => {
    const depth = 1000;
    const input = "^done,a=" + "{".repeat(depth) + "}".repeat(depth);
    expect(() => parseMiLine(input)).not.toThrow();
  });

  it("deeply nested arrays (1000 levels)", { timeout: 5000 }, () => {
    const depth = 1000;
    const input = "^done,a=" + "[".repeat(depth) + "]".repeat(depth);
    expect(() => parseMiLine(input)).not.toThrow();
  });

  it("unterminated string", { timeout: 2000 }, () => {
    const input = '^done,value="no closing quote';
    const result = parseMiLine(input);
    // Should not throw, may return partial parse
    expect(result).not.toBeUndefined();
    if (result) {
      expect(result.type).toBe("^");
    }
  });

  it("empty MI line", { timeout: 2000 }, () => {
    const result = parseMiLine("");
    expect(result).toBeNull();
  });

  it("huge string value (1 MB)", { timeout: 5000 }, () => {
    const bigStr = "A".repeat(1024 * 1024);
    const input = `^done,value="${bigStr}"`;
    const result = parseMiLine(input);
    expect(result).not.toBeNull();
    expect(result!.results?.value.length).toBe(1024 * 1024);
  });

  it("invalid escape sequences", { timeout: 2000 }, () => {
    const input = '^done,value="\\q\\z\\1"';
    const result = parseMiLine(input);
    expect(result).not.toBeNull();
    // Unknown escapes: the parser takes the char after backslash literally
    expect(result!.results?.value).toBe("qz1");
  });

  it("duplicate keys (last wins)", { timeout: 2000 }, () => {
    const input = '^done,a="1",a="2"';
    const result = parseMiLine(input);
    expect(result).not.toBeNull();
    // Last value should win since parseMiResults overwrites
    expect(result!.results?.a).toBe("2");
  });

  it("mixed delimiters {[}]", { timeout: 2000 }, () => {
    const input = "^done,value={[}]";
    // Malformed but should not throw or hang
    expect(() => parseMiLine(input)).not.toThrow();
  });

  it("random bytes through parseMiLine (256 combos)", { timeout: 5000 }, () => {
    for (let byte = 0; byte < 256; byte++) {
      const input = String.fromCharCode(byte);
      expect(() => parseMiLine(input)).not.toThrow();
    }
  });

  it("multi-byte random sequences (256 two-byte combos)", { timeout: 5000 }, () => {
    for (let b1 = 0; b1 < 256; b1 += 16) {
      for (let b2 = 0; b2 < 256; b2 += 16) {
        const input = String.fromCharCode(b1) + String.fromCharCode(b2);
        expect(() => parseMiLine(input)).not.toThrow();
      }
    }
  });

  it("randomized MI-like strings (1000 iterations, seed=42)", { timeout: 10000 }, () => {
    const rng = createRng(42);
    const prefixes = ["^", "*", "=", "~", "&", "@", ""];
    const classes = ["done", "running", "stopped", "error", "connected", ""];
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789"{}[]=,\\';

    for (let i = 0; i < 1000; i++) {
      const prefix = prefixes[Math.floor(rng() * prefixes.length)];
      const cls = classes[Math.floor(rng() * classes.length)];
      const bodyLen = Math.floor(rng() * 100);
      let body = "";
      for (let j = 0; j < bodyLen; j++) {
        body += chars[Math.floor(rng() * chars.length)];
      }
      const token = rng() > 0.5 ? `${Math.floor(rng() * 99999)}` : "";
      const input = `${token}${prefix}${cls}${body ? "," + body : ""}`;
      expect(() => parseMiLine(input)).not.toThrow();
    }
  });

  it("only closing brackets", { timeout: 2000 }, () => {
    expect(() => parseMiLine("^done,a=}}}}}")).not.toThrow();
    expect(() => parseMiLine("^done,a=]]]]]")).not.toThrow();
  });

  it("comma-only results", { timeout: 2000 }, () => {
    expect(() => parseMiLine("^done,,,,")).not.toThrow();
  });

  it("equals-only results", { timeout: 2000 }, () => {
    expect(() => parseMiLine("^done,====")).not.toThrow();
  });

  it("very long key name", { timeout: 2000 }, () => {
    const key = "k".repeat(10000);
    const input = `^done,${key}="v"`;
    const result = parseMiLine(input);
    expect(result).not.toBeNull();
    expect(result!.results?.[key]).toBe("v");
  });

  it("null bytes in string", { timeout: 2000 }, () => {
    const input = '^done,value="hello\x00world"';
    expect(() => parseMiLine(input)).not.toThrow();
  });

  it("newlines in value", { timeout: 2000 }, () => {
    const input = '^done,value="line1\\nline2\\nline3"';
    const result = parseMiLine(input);
    expect(result).not.toBeNull();
    expect(result!.results?.value).toBe("line1\nline2\nline3");
  });

  it("empty tuple", { timeout: 2000 }, () => {
    const input = "^done,value={}";
    const result = parseMiLine(input);
    expect(result).not.toBeNull();
    expect(typeof result!.results?.value).toBe("object");
  });

  it("empty array", { timeout: 2000 }, () => {
    const input = "^done,value=[]";
    const result = parseMiLine(input);
    expect(result).not.toBeNull();
    expect(Array.isArray(result!.results?.value)).toBe(true);
    expect(result!.results?.value.length).toBe(0);
  });

  it("mixed nesting: array of tuples of arrays", { timeout: 2000 }, () => {
    const input = '^done,data=[{a=["1","2"]},{b=["3"]}]';
    const result = parseMiLine(input);
    expect(result).not.toBeNull();
    expect(Array.isArray(result!.results?.data)).toBe(true);
  });

  it("stream output with long escaped string", { timeout: 5000 }, () => {
    const escaped = "\\n".repeat(10000);
    const input = `~"${escaped}"`;
    const result = parseMiLine(input);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("~");
    expect(result!.output!.length).toBe(10000);
  });
});

describe("parseMiCString fuzz", () => {
  it("unterminated string returns content", { timeout: 2000 }, () => {
    expect(() => parseMiCString('"unterminated')).not.toThrow();
    expect(parseMiCString('"unterminated')).toBe("unterminated");
  });

  it("empty input", { timeout: 2000 }, () => {
    expect(() => parseMiCString("")).not.toThrow();
    expect(parseMiCString("")).toBe("");
  });

  it("just a quote", { timeout: 2000 }, () => {
    expect(() => parseMiCString('"')).not.toThrow();
    expect(parseMiCString('"')).toBe("");
  });

  it("backslash at end of string", { timeout: 2000 }, () => {
    // Trailing backslash with nothing after — edge case
    expect(() => parseMiCString('"trailing\\')).not.toThrow();
  });

  it("1000 consecutive escapes", { timeout: 5000 }, () => {
    const input = '"' + "\\n".repeat(1000) + '"';
    const result = parseMiCString(input);
    expect(result.length).toBe(1000);
  });

  it("random bytes through parseMiCString", { timeout: 5000 }, () => {
    for (let byte = 0; byte < 256; byte++) {
      const input = '"' + String.fromCharCode(byte) + '"';
      expect(() => parseMiCString(input)).not.toThrow();
    }
  });
});

describe("parseMiValue fuzz", () => {
  it("empty input at index 0", { timeout: 2000 }, () => {
    expect(() => parseMiValue("", 0)).not.toThrow();
  });

  it("index past end of string", { timeout: 2000 }, () => {
    expect(() => parseMiValue("abc", 100)).not.toThrow();
  });

  it("deeply nested alternating tuple/array (100 levels)", { timeout: 5000 }, () => {
    let input = "";
    for (let i = 0; i < 100; i++) {
      input += i % 2 === 0 ? "{x=" : "[";
    }
    input += '""';
    for (let i = 99; i >= 0; i--) {
      input += i % 2 === 0 ? "}" : "]";
    }
    expect(() => parseMiValue(input, 0)).not.toThrow();
  });

  it("unmatched opening bracket", { timeout: 2000 }, () => {
    expect(() => parseMiValue("{", 0)).not.toThrow();
    expect(() => parseMiValue("[", 0)).not.toThrow();
  });

  it("value is just a comma", { timeout: 2000 }, () => {
    const result = parseMiValue(",rest", 0);
    // Comma terminates raw value parsing, so value should be ""
    expect(result.value).toBe("");
    expect(result.index).toBe(0);
  });
});

describe("parseMiResults fuzz", () => {
  it("empty string", { timeout: 2000 }, () => {
    expect(() => parseMiResults("")).not.toThrow();
  });

  it("key without value (no equals)", { timeout: 2000 }, () => {
    // When there's no =, parseMiResult reads until end as key, then reads value at end
    expect(() => parseMiResults("noequals")).not.toThrow();
  });

  it("100 comma-separated key=value pairs", { timeout: 5000 }, () => {
    const pairs = Array.from({ length: 100 }, (_, i) => `k${i}="${i}"`).join(",");
    const result = parseMiResults(pairs);
    expect(result.results.k0).toBe("0");
    expect(result.results.k99).toBe("99");
  });
});
