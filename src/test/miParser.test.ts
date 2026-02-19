import { describe, it, expect } from "vitest";
import {
  parseMiLine,
  parseMiCString,
  parseMiCStringWithIndex,
  parseMiValue,
  mapStopReason,
  escapeMiString,
  parseNumber,
  parseUnixAddress,
  defaultRiscvRegisterNames,
  shellEscape,
  buildShellCommand,
} from "../miParser";

describe("parseMiLine", () => {
  it("parses result record with token", () => {
    const record = parseMiLine('42^done,msg="hello"');
    expect(record).toBeTruthy();
    expect(record!.token).toBe(42);
    expect(record!.type).toBe("^");
    expect(record!.class).toBe("done");
    expect(record!.results?.msg).toBe("hello");
  });

  it("parses result record without token", () => {
    const record = parseMiLine("^done");
    expect(record).toBeTruthy();
    expect(record!.token).toBeUndefined();
    expect(record!.type).toBe("^");
    expect(record!.class).toBe("done");
  });

  it("parses async stopped record", () => {
    const record = parseMiLine('*stopped,reason="breakpoint-hit",bkptno="1"');
    expect(record).toBeTruthy();
    expect(record!.type).toBe("*");
    expect(record!.class).toBe("stopped");
    expect(record!.results?.reason).toBe("breakpoint-hit");
    expect(record!.results?.bkptno).toBe("1");
  });

  it("parses async running record", () => {
    const record = parseMiLine("*running,thread-id=\"all\"");
    expect(record).toBeTruthy();
    expect(record!.type).toBe("*");
    expect(record!.class).toBe("running");
  });

  it("parses stream output (~)", () => {
    const record = parseMiLine('~"Reading symbols..."');
    expect(record).toBeTruthy();
    expect(record!.type).toBe("~");
    expect(record!.output).toBe("Reading symbols...");
  });

  it("parses log output (&)", () => {
    const record = parseMiLine('&"warning: foo\\n"');
    expect(record).toBeTruthy();
    expect(record!.type).toBe("&");
    expect(record!.output).toBe("warning: foo\n");
  });

  it("parses target output (@)", () => {
    const record = parseMiLine('@"target says hello"');
    expect(record).toBeTruthy();
    expect(record!.type).toBe("@");
    expect(record!.output).toBe("target says hello");
  });

  it("parses error record", () => {
    const record = parseMiLine('42^error,msg="No symbol table"');
    expect(record).toBeTruthy();
    expect(record!.class).toBe("error");
    expect(record!.results?.msg).toBe("No symbol table");
  });

  it("returns null for empty input", () => {
    expect(parseMiLine("")).toBeNull();
  });

  it("returns null for garbage input", () => {
    expect(parseMiLine("this is not MI")).toBeNull();
  });

  it("parses nested tuples", () => {
    const record = parseMiLine('42^done,bkpt={number="1",addr="0x100",func="main"}');
    expect(record).toBeTruthy();
    expect(record!.results?.bkpt?.number).toBe("1");
    expect(record!.results?.bkpt?.addr).toBe("0x100");
    expect(record!.results?.bkpt?.func).toBe("main");
  });

  it("parses register-values array", () => {
    const record = parseMiLine('42^done,register-values=[{number="0",value="0x0"},{number="1",value="0x4000"}]');
    expect(record).toBeTruthy();
    const values = record!.results?.["register-values"];
    expect(Array.isArray(values)).toBe(true);
    expect(values.length).toBe(2);
    expect(values[0].number).toBe("0");
    expect(values[0].value).toBe("0x0");
    expect(values[1].number).toBe("1");
    expect(values[1].value).toBe("0x4000");
  });

  it("parses thread-info response", () => {
    const line = '42^done,threads=[{id="1",target-id="Thread 1",state="stopped"}]';
    const record = parseMiLine(line);
    expect(record).toBeTruthy();
    const threads = record!.results?.threads;
    expect(Array.isArray(threads)).toBe(true);
    expect(threads[0].id).toBe("1");
    expect(threads[0].state).toBe("stopped");
  });

  it("parses = (notify) record", () => {
    const record = parseMiLine('=thread-group-added,id="i1"');
    expect(record).toBeTruthy();
    expect(record!.type).toBe("=");
    expect(record!.class).toBe("thread-group-added");
    expect(record!.results?.id).toBe("i1");
  });
});

describe("parseMiCString", () => {
  it("handles \\n escape", () => {
    expect(parseMiCString('"hello\\nworld"')).toBe("hello\nworld");
  });

  it("handles \\t escape", () => {
    expect(parseMiCString('"hello\\tworld"')).toBe("hello\tworld");
  });

  it("handles \\\\ escape", () => {
    expect(parseMiCString('"back\\\\slash"')).toBe("back\\slash");
  });

  it("handles \\\" escape", () => {
    expect(parseMiCString('"say \\"hello\\""')).toBe('say "hello"');
  });

  it("handles empty string", () => {
    expect(parseMiCString('""')).toBe("");
  });

  it("handles unterminated string", () => {
    expect(parseMiCString('"unterminated')).toBe("unterminated");
  });

  it("handles string without quotes", () => {
    // When fed without leading quote, just reads as-is
    expect(parseMiCString("no quotes")).toBe("no quotes");
  });
});

describe("parseMiCStringWithIndex", () => {
  it("returns correct index after parse", () => {
    const result = parseMiCStringWithIndex('"hello",next', 0);
    expect(result.value).toBe("hello");
    expect(result.index).toBe(7); // after closing quote
  });
});

describe("parseMiValue", () => {
  it("parses quoted string", () => {
    const result = parseMiValue('"hello"', 0);
    expect(result.value).toBe("hello");
  });

  it("parses object/tuple", () => {
    const result = parseMiValue('{a="1",b="2"}', 0);
    expect(result.value.a).toBe("1");
    expect(result.value.b).toBe("2");
  });

  it("parses array/list", () => {
    const result = parseMiValue('["a","b"]', 0);
    expect(Array.isArray(result.value)).toBe(true);
    expect(result.value).toEqual(["a", "b"]);
  });

  it("parses raw unquoted value", () => {
    const result = parseMiValue("raw_value,next", 0);
    expect(result.value).toBe("raw_value");
  });

  it("parses nested structures", () => {
    const result = parseMiValue('{inner={deep="value"}}', 0);
    expect(result.value.inner.deep).toBe("value");
  });
});

describe("mapStopReason", () => {
  it("maps breakpoint-hit", () => {
    expect(mapStopReason("breakpoint-hit")).toBe("breakpoint");
  });

  it("maps end-stepping-range", () => {
    expect(mapStopReason("end-stepping-range")).toBe("step");
  });

  it("maps signal-received", () => {
    expect(mapStopReason("signal-received")).toBe("signal");
  });

  it("maps exited-normally", () => {
    expect(mapStopReason("exited-normally")).toBe("exited");
  });

  it("maps unknown reason to pause", () => {
    expect(mapStopReason("some-unknown-reason")).toBe("pause");
  });

  it("maps empty string to pause", () => {
    expect(mapStopReason("")).toBe("pause");
  });
});

describe("escapeMiString", () => {
  it("escapes backslashes", () => {
    expect(escapeMiString("a\\b")).toBe("a\\\\b");
  });

  it("escapes quotes", () => {
    expect(escapeMiString('say "hello"')).toBe('say \\"hello\\"');
  });

  it("handles string with both", () => {
    expect(escapeMiString('path\\to\\"file"')).toBe('path\\\\to\\\\\\"file\\"');
  });
});

describe("parseNumber", () => {
  it("parses hex 0x prefix", () => {
    expect(parseNumber("0x1a")).toBe(0x1a);
  });

  it("parses hex 0X prefix", () => {
    expect(parseNumber("0X1A")).toBe(0x1a);
  });

  it("parses decimal", () => {
    expect(parseNumber("42")).toBe(42);
  });

  it("returns 0 for non-numeric", () => {
    expect(parseNumber("abc")).toBe(0);
  });

  it("returns 0 for empty string", () => {
    expect(parseNumber("")).toBe(0);
  });
});

describe("parseUnixAddress", () => {
  it("parses unix:// prefix", () => {
    expect(parseUnixAddress("unix:///tmp/gdb.sock")).toBe("/tmp/gdb.sock");
  });

  it("parses unix: prefix", () => {
    expect(parseUnixAddress("unix:/tmp/gdb.sock")).toBe("/tmp/gdb.sock");
  });

  it("returns null for TCP address", () => {
    expect(parseUnixAddress("localhost:3333")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseUnixAddress("")).toBeNull();
  });
});

describe("defaultRiscvRegisterNames", () => {
  it("returns 32 register names", () => {
    const names = defaultRiscvRegisterNames();
    expect(names.length).toBe(32);
  });

  it("first register is x0 (zero)", () => {
    expect(defaultRiscvRegisterNames()[0]).toBe("x0 (zero)");
  });

  it("last register is x31 (t6)", () => {
    expect(defaultRiscvRegisterNames()[31]).toBe("x31 (t6)");
  });
});

describe("shellEscape", () => {
  it("wraps in single quotes", () => {
    expect(shellEscape("hello")).toBe("'hello'");
  });

  it("escapes embedded single quotes", () => {
    const result = shellEscape("it's");
    expect(result).toContain("'\"'\"'");
  });
});

describe("buildShellCommand", () => {
  it("joins escaped args with space", () => {
    const result = buildShellCommand(["node", "/path/to/script.js", "arg"]);
    expect(result).toBe("'node' '/path/to/script.js' 'arg'");
  });

  it("handles empty array", () => {
    expect(buildShellCommand([])).toBe("");
  });

  it("handles args with spaces", () => {
    const result = buildShellCommand(["cat", "file with spaces.txt"]);
    expect(result).toBe("'cat' 'file with spaces.txt'");
  });
});

// ─── Additional MI edge cases ──────────────────────────

describe("parseMiLine edge cases", () => {
  it("parses deeply nested tuple results", () => {
    const record = parseMiLine('^done,frame={addr="0x1000",func="main",args=[{name="argc",value="1"},{name="argv",value="0x7fff"}]}');
    expect(record).toBeTruthy();
    expect(record!.results.frame.func).toBe("main");
    expect(record!.results.frame.addr).toBe("0x1000");
    expect(record!.results.frame.args).toHaveLength(2);
    expect(record!.results.frame.args[0].name).toBe("argc");
  });

  it("parses *stopped with all fields", () => {
    const record = parseMiLine('*stopped,reason="breakpoint-hit",disp="keep",bkptno="1",frame={addr="0x100",func="main"},thread-id="1",stopped-threads="all"');
    expect(record).toBeTruthy();
    expect(record!.type).toBe("*");
    expect(record!.class).toBe("stopped");
    expect(record!.results.reason).toBe("breakpoint-hit");
    expect(record!.results.bkptno).toBe("1");
    expect(record!.results.frame.func).toBe("main");
    expect(record!.results["thread-id"]).toBe("1");
  });

  it("parses *running record", () => {
    const record = parseMiLine('*running,thread-id="all"');
    expect(record).toBeTruthy();
    expect(record!.type).toBe("*");
    expect(record!.class).toBe("running");
  });

  it("parses =thread-group-added notification", () => {
    const record = parseMiLine('=thread-group-added,id="i1"');
    expect(record).toBeTruthy();
    expect(record!.type).toBe("=");
    expect(record!.class).toBe("thread-group-added");
    expect(record!.results.id).toBe("i1");
  });

  it("parses ^error with message", () => {
    const record = parseMiLine('^error,msg="No symbol table is loaded."');
    expect(record).toBeTruthy();
    expect(record!.class).toBe("error");
    expect(record!.results.msg).toBe("No symbol table is loaded.");
  });

  it("handles console stream output (~)", () => {
    const record = parseMiLine('~"Reading symbols from /path/to/elf..."');
    expect(record).toBeTruthy();
    expect(record!.type).toBe("~");
    expect(record!.output).toContain("Reading symbols");
  });

  it("handles log stream output (&)", () => {
    const record = parseMiLine('&"warning: something happened\\n"');
    expect(record).toBeTruthy();
    expect(record!.type).toBe("&");
    expect(record!.output).toContain("warning");
  });

  it("handles target stream output (@)", () => {
    const record = parseMiLine('@"Hello from target\\n"');
    expect(record).toBeTruthy();
    expect(record!.type).toBe("@");
  });

  it("returns null for empty string", () => {
    expect(parseMiLine("")).toBeNull();
  });

  it("returns null for (gdb) prompt", () => {
    expect(parseMiLine("(gdb)")).toBeNull();
  });

  it("returns null for plain text", () => {
    expect(parseMiLine("some random text")).toBeNull();
  });

  it("parses large token numbers", () => {
    const record = parseMiLine('999999^done');
    expect(record).toBeTruthy();
    expect(record!.token).toBe(999999);
  });

  it("parses breakpoint-insert result with multiple fields", () => {
    const line = '10^done,bkpt={number="1",type="breakpoint",disp="keep",enabled="y",addr="0x00001000",func="main",file="main.c",fullname="/src/main.c",line="5",thread-groups=["i1"],times="0",original-location="main.c:5"}';
    const record = parseMiLine(line);
    expect(record).toBeTruthy();
    expect(record!.results.bkpt.number).toBe("1");
    expect(record!.results.bkpt.func).toBe("main");
    expect(record!.results.bkpt.line).toBe("5");
    expect(record!.results.bkpt["thread-groups"]).toBeInstanceOf(Array);
  });

  it("parses register-names list", () => {
    const line = '^done,register-names=["x0","x1","x2","x3"]';
    const record = parseMiLine(line);
    expect(record).toBeTruthy();
    const names = record!.results["register-names"];
    expect(names).toEqual(["x0", "x1", "x2", "x3"]);
  });

  it("parses register-values list", () => {
    const line = '^done,register-values=[{number="0",value="0x00000000"},{number="1",value="0x80001000"}]';
    const record = parseMiLine(line);
    expect(record).toBeTruthy();
    const values = record!.results["register-values"];
    expect(values).toHaveLength(2);
    expect(values[0].number).toBe("0");
    expect(values[0].value).toBe("0x00000000");
    expect(values[1].number).toBe("1");
    expect(values[1].value).toBe("0x80001000");
  });

  it("parses stack-list-frames result", () => {
    const line = '^done,stack=[frame={level="0",addr="0x1000",func="main",file="main.c",fullname="/src/main.c",line="10"},frame={level="1",addr="0x800",func="_start"}]';
    const record = parseMiLine(line);
    expect(record).toBeTruthy();
    const stack = record!.results.stack;
    expect(stack).toHaveLength(2);
    expect(stack[0].frame.level).toBe("0");
    expect(stack[0].frame.func).toBe("main");
    expect(stack[1].frame.func).toBe("_start");
  });

  it("parses memory read result", () => {
    const line = '^done,memory=[{begin="0x20000000",offset="0x00000000",end="0x20000010",contents="deadbeef00112233"}]';
    const record = parseMiLine(line);
    expect(record).toBeTruthy();
    const mem = record!.results.memory;
    expect(mem).toHaveLength(1);
    expect(mem[0].contents).toBe("deadbeef00112233");
    expect(mem[0].begin).toBe("0x20000000");
  });

  it("parses thread-info result", () => {
    const line = '^done,threads=[{id="1",target-id="Thread 1",state="stopped"}],current-thread-id="1"';
    const record = parseMiLine(line);
    expect(record).toBeTruthy();
    const threads = record!.results.threads;
    expect(threads).toHaveLength(1);
    expect(threads[0].id).toBe("1");
    expect(threads[0].state).toBe("stopped");
    expect(record!.results["current-thread-id"]).toBe("1");
  });
});

describe("parseMiCString edge cases", () => {
  it("handles empty string", () => {
    expect(parseMiCString('""')).toBe("");
  });

  it("handles escaped backslash", () => {
    expect(parseMiCString('"path\\\\to\\\\file"')).toBe("path\\to\\file");
  });

  it("handles escaped newline", () => {
    expect(parseMiCString('"line1\\nline2"')).toBe("line1\nline2");
  });

  it("handles escaped tab", () => {
    expect(parseMiCString('"col1\\tcol2"')).toBe("col1\tcol2");
  });

  it("handles escaped quote", () => {
    expect(parseMiCString('"say \\"hello\\""')).toBe('say "hello"');
  });

  it("handles string without quotes", () => {
    expect(parseMiCString("no quotes")).toBe("no quotes");
  });

  it("handles multiple escape sequences", () => {
    expect(parseMiCString('"\\n\\t\\\\\\""')).toBe('\n\t\\"');
  });
});

describe("parseNumber edge cases", () => {
  it("parses 0x prefix (lowercase)", () => {
    expect(parseNumber("0x1a")).toBe(26);
  });

  it("parses 0X prefix (uppercase)", () => {
    expect(parseNumber("0X1A")).toBe(26);
  });

  it("parses plain decimal", () => {
    expect(parseNumber("42")).toBe(42);
  });

  it("returns 0 for non-numeric", () => {
    expect(parseNumber("abc")).toBe(0);
    expect(parseNumber("")).toBe(0);
  });

  it("parses large hex addresses", () => {
    expect(parseNumber("0x80000000")).toBe(0x80000000);
  });

  it("parses zero", () => {
    expect(parseNumber("0")).toBe(0);
    expect(parseNumber("0x0")).toBe(0);
  });
});

describe("parseUnixAddress edge cases", () => {
  it("returns null for empty string", () => {
    expect(parseUnixAddress("")).toBeNull();
  });

  it("returns null for undefined", () => {
    expect(parseUnixAddress(undefined as any)).toBeNull();
  });

  it("returns null for TCP address", () => {
    expect(parseUnixAddress("localhost:3333")).toBeNull();
  });

  it("parses unix:// prefix", () => {
    expect(parseUnixAddress("unix:///tmp/gdb.sock")).toBe("/tmp/gdb.sock");
  });

  it("parses unix: prefix (no double slash)", () => {
    expect(parseUnixAddress("unix:/tmp/gdb.sock")).toBe("/tmp/gdb.sock");
  });

  it("returns null for http://", () => {
    expect(parseUnixAddress("http://localhost")).toBeNull();
  });
});

describe("mapStopReason edge cases", () => {
  it("maps all known reasons", () => {
    expect(mapStopReason("breakpoint-hit")).toBe("breakpoint");
    expect(mapStopReason("end-stepping-range")).toBe("step");
    expect(mapStopReason("signal-received")).toBe("signal");
    expect(mapStopReason("exited-normally")).toBe("exited");
  });

  it("maps unknown reasons to pause", () => {
    expect(mapStopReason("watchpoint-trigger")).toBe("pause");
    expect(mapStopReason("")).toBe("pause");
    expect(mapStopReason("something-new")).toBe("pause");
  });
});

describe("escapeMiString edge cases", () => {
  it("escapes backslashes", () => {
    expect(escapeMiString("path\\to\\file")).toBe("path\\\\to\\\\file");
  });

  it("escapes double quotes", () => {
    expect(escapeMiString('say "hello"')).toBe('say \\"hello\\"');
  });

  it("escapes both", () => {
    expect(escapeMiString('path\\to\\"file"')).toBe('path\\\\to\\\\\\"file\\"');
  });

  it("returns empty string unchanged", () => {
    expect(escapeMiString("")).toBe("");
  });

  it("returns plain string unchanged", () => {
    expect(escapeMiString("hello")).toBe("hello");
  });
});
