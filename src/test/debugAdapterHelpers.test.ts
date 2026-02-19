import { describe, it, expect } from "vitest";
import {
  normalizeFrameList,
  normalizeVariableList,
  isRunningStateErrorMessage,
  isInvalidRegName,
  buildRegisterNameFallback,
  isBrokenPipeErrorCode,
  computeDisassemblyRange,
  formatMemoryReadResponse,
  parseDapMessages,
  encodeDapMessage,
  parseStoppedMiRecord,
} from "../rv32simDebugAdapter";
import { defaultRiscvRegisterNames } from "../miParser";

// ─── DAP framing protocol ─────────────────────────────

describe("parseDapMessages", () => {
  it("parses a single complete message", () => {
    const body = JSON.stringify({ type: "request", command: "initialize", seq: 1 });
    const frame = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
    const result = parseDapMessages(Buffer.from(frame), null);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].command).toBe("initialize");
    expect(result.remaining.length).toBe(0);
    expect(result.expectedLength).toBeNull();
  });

  it("parses multiple messages in one chunk", () => {
    const msg1 = JSON.stringify({ seq: 1, type: "request", command: "initialize" });
    const msg2 = JSON.stringify({ seq: 2, type: "request", command: "launch" });
    const frame = `Content-Length: ${Buffer.byteLength(msg1)}\r\n\r\n${msg1}Content-Length: ${Buffer.byteLength(msg2)}\r\n\r\n${msg2}`;
    const result = parseDapMessages(Buffer.from(frame), null);
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].command).toBe("initialize");
    expect(result.messages[1].command).toBe("launch");
  });

  it("handles partial header (incomplete \\r\\n\\r\\n)", () => {
    const result = parseDapMessages(Buffer.from("Content-Length: 10\r\n"), null);
    expect(result.messages).toHaveLength(0);
    expect(result.remaining.toString()).toBe("Content-Length: 10\r\n");
  });

  it("handles partial body (waiting for more bytes)", () => {
    const body = JSON.stringify({ seq: 1, type: "request", command: "test" });
    const partial = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body.slice(0, 5)}`;
    const result = parseDapMessages(Buffer.from(partial), null);
    expect(result.messages).toHaveLength(0);
    expect(result.expectedLength).toBe(Buffer.byteLength(body));
  });

  it("resumes with expectedLength from previous call", () => {
    const body = JSON.stringify({ seq: 1, type: "request", command: "test" });
    // Simulate: header was already parsed, expectedLength is set
    const result = parseDapMessages(Buffer.from(body), Buffer.byteLength(body));
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].command).toBe("test");
    expect(result.expectedLength).toBeNull();
  });

  it("handles chunked delivery across multiple calls", () => {
    const body = JSON.stringify({ seq: 1, type: "request", command: "chunked" });
    const frame = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
    const half = Math.floor(frame.length / 2);
    const chunk1 = Buffer.from(frame.slice(0, half));
    const chunk2 = Buffer.from(frame.slice(half));

    const r1 = parseDapMessages(chunk1, null);
    expect(r1.messages).toHaveLength(0);

    const combined = Buffer.concat([r1.remaining, chunk2]);
    const r2 = parseDapMessages(combined, r1.expectedLength);
    expect(r2.messages).toHaveLength(1);
    expect(r2.messages[0].command).toBe("chunked");
  });

  it("skips headers without Content-Length", () => {
    const body = JSON.stringify({ seq: 1, type: "request", command: "ok" });
    const frame = `X-Custom: foo\r\n\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
    const result = parseDapMessages(Buffer.from(frame), null);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].command).toBe("ok");
  });

  it("skips malformed JSON body gracefully", () => {
    const badBody = "{not valid json}}}";
    const goodBody = JSON.stringify({ seq: 2, type: "request", command: "good" });
    const frame =
      `Content-Length: ${Buffer.byteLength(badBody)}\r\n\r\n${badBody}` +
      `Content-Length: ${Buffer.byteLength(goodBody)}\r\n\r\n${goodBody}`;
    const result = parseDapMessages(Buffer.from(frame), null);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].command).toBe("good");
  });

  it("handles empty buffer", () => {
    const result = parseDapMessages(Buffer.alloc(0), null);
    expect(result.messages).toHaveLength(0);
    expect(result.remaining.length).toBe(0);
  });

  it("handles case-insensitive Content-Length", () => {
    const body = JSON.stringify({ seq: 1, type: "request", command: "ci" });
    const frame = `content-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
    const result = parseDapMessages(Buffer.from(frame), null);
    expect(result.messages).toHaveLength(1);
  });

  it("handles unicode content correctly", () => {
    const body = JSON.stringify({ seq: 1, type: "request", command: "unicode", data: "héllo wörld" });
    const frame = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
    const result = parseDapMessages(Buffer.from(frame), null);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].data).toBe("héllo wörld");
  });
});

describe("encodeDapMessage", () => {
  it("produces valid Content-Length framed output", () => {
    const msg = { seq: 1, type: "response", success: true };
    const encoded = encodeDapMessage(msg);
    expect(encoded).toMatch(/^Content-Length: \d+\r\n\r\n/);
    const body = encoded.split("\r\n\r\n", 2)[1];
    expect(JSON.parse(body)).toEqual(msg);
  });

  it("Content-Length matches actual byte length", () => {
    const msg = { seq: 1, data: "héllo" }; // multi-byte chars
    const encoded = encodeDapMessage(msg);
    const match = encoded.match(/Content-Length: (\d+)/);
    const declaredLength = Number.parseInt(match![1], 10);
    const body = encoded.split("\r\n\r\n", 2)[1];
    expect(Buffer.byteLength(body, "utf8")).toBe(declaredLength);
  });

  it("round-trips through parseDapMessages", () => {
    const original = { seq: 42, type: "event", event: "stopped", body: { reason: "entry" } };
    const encoded = encodeDapMessage(original);
    const parsed = parseDapMessages(Buffer.from(encoded), null);
    expect(parsed.messages).toHaveLength(1);
    expect(parsed.messages[0]).toEqual(original);
  });

  it("round-trips multiple messages", () => {
    const msgs = [
      { seq: 1, type: "response", command: "init" },
      { seq: 2, type: "event", event: "initialized" },
      { seq: 3, type: "response", command: "launch" },
    ];
    const encoded = msgs.map(encodeDapMessage).join("");
    const parsed = parseDapMessages(Buffer.from(encoded), null);
    expect(parsed.messages).toHaveLength(3);
    expect(parsed.messages.map((m: any) => m.seq)).toEqual([1, 2, 3]);
  });
});

// ─── MI stopped record parsing ─────────────────────────

describe("parseStoppedMiRecord", () => {
  it("parses breakpoint-hit with breakpoint number", () => {
    const result = parseStoppedMiRecord({ reason: "breakpoint-hit", bkptno: "3", "thread-id": "1" });
    expect(result.reason).toBe("breakpoint");
    expect(result.hitBreakpointIds).toEqual([3]);
    expect(result.threadId).toBe(1);
  });

  it("parses end-stepping-range", () => {
    const result = parseStoppedMiRecord({ reason: "end-stepping-range", "thread-id": "1" });
    expect(result.reason).toBe("step");
    expect(result.hitBreakpointIds).toEqual([]);
  });

  it("parses signal-received", () => {
    const result = parseStoppedMiRecord({ reason: "signal-received", "thread-id": "1" });
    expect(result.reason).toBe("signal");
  });

  it("parses exited-normally", () => {
    const result = parseStoppedMiRecord({ reason: "exited-normally" });
    expect(result.reason).toBe("exited");
  });

  it("defaults unknown reason to pause", () => {
    const result = parseStoppedMiRecord({ reason: "watchpoint-trigger" });
    expect(result.reason).toBe("pause");
  });

  it("defaults missing reason to breakpoint", () => {
    const result = parseStoppedMiRecord({});
    expect(result.reason).toBe("breakpoint");
  });

  it("defaults thread-id to 1 when missing", () => {
    const result = parseStoppedMiRecord({ reason: "breakpoint-hit" });
    expect(result.threadId).toBe(1);
  });

  it("handles bkpt field instead of bkptno", () => {
    const result = parseStoppedMiRecord({ reason: "breakpoint-hit", bkpt: "7" });
    expect(result.hitBreakpointIds).toEqual([7]);
  });

  it("ignores non-numeric breakpoint numbers", () => {
    const result = parseStoppedMiRecord({ reason: "breakpoint-hit", bkptno: "abc" });
    expect(result.hitBreakpointIds).toEqual([]);
  });

  it("handles null/undefined results", () => {
    const result = parseStoppedMiRecord(null);
    expect(result.reason).toBe("breakpoint");
    expect(result.hitBreakpointIds).toEqual([]);
    expect(result.threadId).toBe(1);
  });
});

// ─── normalizeFrameList ────────────────────────────────

describe("normalizeFrameList", () => {
  it("unwraps {frame: ...} wrappers", () => {
    const input = [
      { frame: { func: "main", line: "10" } },
      { frame: { func: "foo", line: "20" } },
    ];
    const result = normalizeFrameList(input);
    expect(result).toEqual([
      { func: "main", line: "10" },
      { func: "foo", line: "20" },
    ]);
  });

  it("passes through bare frames", () => {
    const input = [{ func: "main", line: "5" }];
    expect(normalizeFrameList(input)).toEqual([{ func: "main", line: "5" }]);
  });

  it("handles mixed wrapped and bare frames", () => {
    const input = [
      { frame: { func: "wrapped" } },
      { func: "bare" },
    ];
    const result = normalizeFrameList(input);
    expect(result[0].func).toBe("wrapped");
    expect(result[1].func).toBe("bare");
  });

  it("filters out null entries from raw array", () => {
    const input = [{ func: "bar" }, null];
    const result = normalizeFrameList(input);
    expect(result).toEqual([{ func: "bar" }]);
  });

  it("falls back to item itself when frame is null (via ?? operator)", () => {
    const input = [{ frame: null }];
    const result = normalizeFrameList(input);
    expect(result).toEqual([{ frame: null }]);
  });

  it("handles non-array input", () => {
    expect(normalizeFrameList("not an array" as any)).toEqual([]);
    expect(normalizeFrameList(null as any)).toEqual([]);
    expect(normalizeFrameList(undefined as any)).toEqual([]);
    expect(normalizeFrameList({} as any)).toEqual([]);
    expect(normalizeFrameList(42 as any)).toEqual([]);
  });

  it("handles empty array", () => {
    expect(normalizeFrameList([])).toEqual([]);
  });

  it("preserves all frame fields", () => {
    const input = [
      { frame: { func: "main", line: "5", file: "main.c", fullname: "/src/main.c", addr: "0x1000" } },
    ];
    const result = normalizeFrameList(input);
    expect(result[0]).toEqual({ func: "main", line: "5", file: "main.c", fullname: "/src/main.c", addr: "0x1000" });
  });

  it("handles deeply nested frame (only unwraps one level)", () => {
    const input = [{ frame: { frame: { func: "deep" } } }];
    const result = normalizeFrameList(input);
    expect(result[0]).toEqual({ frame: { func: "deep" } });
  });
});

// ─── normalizeVariableList ─────────────────────────────

describe("normalizeVariableList", () => {
  it("unwraps {variable: ...} wrappers", () => {
    const input = [
      { variable: { name: "x", value: "42" } },
      { variable: { name: "y", value: "7" } },
    ];
    const result = normalizeVariableList(input);
    expect(result).toEqual([
      { name: "x", value: "42" },
      { name: "y", value: "7" },
    ]);
  });

  it("passes through bare variables", () => {
    const input = [{ name: "a", value: "1" }];
    expect(normalizeVariableList(input)).toEqual([{ name: "a", value: "1" }]);
  });

  it("filters out null entries from raw array", () => {
    const input = [{ name: "b", value: "2" }, null];
    const result = normalizeVariableList(input);
    expect(result).toEqual([{ name: "b", value: "2" }]);
  });

  it("handles non-array input", () => {
    expect(normalizeVariableList("not an array" as any)).toEqual([]);
    expect(normalizeVariableList(null as any)).toEqual([]);
    expect(normalizeVariableList({} as any)).toEqual([]);
  });

  it("handles undefined variable field (passes through)", () => {
    const input = [{ name: "x", value: "1" }];
    const result = normalizeVariableList(input);
    expect(result[0].name).toBe("x");
  });
});

// ─── isRunningStateErrorMessage ────────────────────────

describe("isRunningStateErrorMessage", () => {
  it("detects 'selected thread is running'", () => {
    expect(isRunningStateErrorMessage(new Error("Error: Selected thread is running"))).toBe(true);
  });

  it("detects 'thread is running'", () => {
    expect(isRunningStateErrorMessage("thread is running")).toBe(true);
  });

  it("detects 'running thread is required'", () => {
    expect(isRunningStateErrorMessage("Running thread is required")).toBe(true);
  });

  it("detects 'cannot execute this command while'", () => {
    expect(isRunningStateErrorMessage("Cannot execute this command while target is running")).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    expect(isRunningStateErrorMessage("some other error")).toBe(false);
    expect(isRunningStateErrorMessage(new Error("timeout"))).toBe(false);
    expect(isRunningStateErrorMessage(new Error("gdb not running"))).toBe(false);
  });

  it("handles null/undefined", () => {
    expect(isRunningStateErrorMessage(null)).toBe(false);
    expect(isRunningStateErrorMessage(undefined)).toBe(false);
  });

  it("handles numbers and objects", () => {
    expect(isRunningStateErrorMessage(0)).toBe(false);
    expect(isRunningStateErrorMessage({})).toBe(false);
  });

  it("is case insensitive", () => {
    expect(isRunningStateErrorMessage("SELECTED THREAD IS RUNNING")).toBe(true);
    expect(isRunningStateErrorMessage("CANNOT EXECUTE THIS COMMAND WHILE")).toBe(true);
  });

  it("detects message embedded in larger string", () => {
    expect(isRunningStateErrorMessage("Error: mi command failed: selected thread is running (GDB)")).toBe(true);
  });
});

// ─── isInvalidRegName ──────────────────────────────────

describe("isInvalidRegName", () => {
  it("returns true for null/undefined/empty", () => {
    expect(isInvalidRegName(null)).toBe(true);
    expect(isInvalidRegName(undefined)).toBe(true);
    expect(isInvalidRegName("")).toBe(true);
    expect(isInvalidRegName("  ")).toBe(true);
    expect(isInvalidRegName("\t")).toBe(true);
  });

  it("returns true for NaN variants", () => {
    expect(isInvalidRegName("nan")).toBe(true);
    expect(isInvalidRegName("NaN")).toBe(true);
    expect(isInvalidRegName("rnan")).toBe(true);
    expect(isInvalidRegName("RNAN")).toBe(true);
    expect(isInvalidRegName("RNaN")).toBe(true);
    expect(isInvalidRegName("Rnan")).toBe(true);
  });

  it("returns false for valid register names", () => {
    expect(isInvalidRegName("x0 (zero)")).toBe(false);
    expect(isInvalidRegName("x1 (ra)")).toBe(false);
    expect(isInvalidRegName("sp")).toBe(false);
    expect(isInvalidRegName("pc")).toBe(false);
    expect(isInvalidRegName("x31 (t6)")).toBe(false);
    expect(isInvalidRegName("mstatus")).toBe(false);
  });

  it("does not flag 'nand' or 'ransom' as NaN", () => {
    expect(isInvalidRegName("nand")).toBe(false);
    expect(isInvalidRegName("random")).toBe(false);
    expect(isInvalidRegName("nan_reg")).toBe(false);
  });
});

// ─── buildRegisterNameFallback ─────────────────────────

describe("buildRegisterNameFallback", () => {
  const defaults = defaultRiscvRegisterNames();

  it("returns defaults when input is null", () => {
    expect(buildRegisterNameFallback(null)).toEqual(defaults);
  });

  it("returns defaults when input is empty array", () => {
    expect(buildRegisterNameFallback([])).toEqual(defaults);
  });

  it("returns defaults when all names are invalid", () => {
    const allEmpty = new Array(32).fill("");
    expect(buildRegisterNameFallback(allEmpty)).toEqual(defaults);
  });

  it("returns defaults when all names are NaN", () => {
    const allNan = new Array(32).fill("nan");
    expect(buildRegisterNameFallback(allNan)).toEqual(defaults);
  });

  it("fills in missing names from fallback", () => {
    const partial = ["myReg0", "", "myReg2"];
    const result = buildRegisterNameFallback(partial);
    expect(result[0]).toBe("myReg0");
    expect(result[1]).toBe(defaults[1]);
    expect(result[2]).toBe("myReg2");
    expect(result.length).toBe(defaults.length);
  });

  it("extends short arrays to full length", () => {
    const short = ["r0", "r1"];
    const result = buildRegisterNameFallback(short);
    expect(result[0]).toBe("r0");
    expect(result[1]).toBe("r1");
    expect(result[2]).toBe(defaults[2]);
    expect(result.length).toBe(defaults.length);
  });

  it("preserves valid names that differ from defaults", () => {
    const custom = defaults.map((_, i) => `custom_x${i}`);
    const result = buildRegisterNameFallback(custom);
    expect(result).toEqual(custom);
  });

  it("replaces scattered NaN entries among valid names", () => {
    const mixed = [...defaults];
    mixed[5] = "nan";
    mixed[10] = "";
    mixed[15] = "RNAN";
    const result = buildRegisterNameFallback(mixed);
    expect(result[5]).toBe(defaults[5]);
    expect(result[10]).toBe(defaults[10]);
    expect(result[15]).toBe(defaults[15]);
    expect(result[0]).toBe(defaults[0]);
  });

  it("does not mutate input array", () => {
    const input = ["a", "", "c"];
    const copy = [...input];
    buildRegisterNameFallback(input);
    expect(input).toEqual(copy);
  });
});

// ─── isBrokenPipeErrorCode ─────────────────────────────

describe("isBrokenPipeErrorCode", () => {
  it("detects EPIPE", () => {
    expect(isBrokenPipeErrorCode({ code: "EPIPE" })).toBe(true);
  });

  it("detects ERR_STREAM_DESTROYED", () => {
    expect(isBrokenPipeErrorCode({ code: "ERR_STREAM_DESTROYED" })).toBe(true);
  });

  it("returns false for other error codes", () => {
    expect(isBrokenPipeErrorCode({ code: "ENOENT" })).toBe(false);
    expect(isBrokenPipeErrorCode({ code: "ECONNRESET" })).toBe(false);
    expect(isBrokenPipeErrorCode({ code: "ECONNREFUSED" })).toBe(false);
  });

  it("handles non-object inputs", () => {
    expect(isBrokenPipeErrorCode(null)).toBe(false);
    expect(isBrokenPipeErrorCode(undefined)).toBe(false);
    expect(isBrokenPipeErrorCode("EPIPE")).toBe(false);
    expect(isBrokenPipeErrorCode(42)).toBe(false);
    expect(isBrokenPipeErrorCode(true)).toBe(false);
  });

  it("handles object without code property", () => {
    expect(isBrokenPipeErrorCode({})).toBe(false);
    expect(isBrokenPipeErrorCode({ message: "broken" })).toBe(false);
  });
});

// ─── computeDisassemblyRange ───────────────────────────

describe("computeDisassemblyRange", () => {
  it("computes correct range for basic inputs", () => {
    const result = computeDisassemblyRange("0x1000", 0, 0, 10);
    expect(result.startAddr).toBe(0x1000);
    expect(result.endAddr).toBe(0x1000 + 10 * 2);
  });

  it("applies offset", () => {
    const result = computeDisassemblyRange("0x1000", 0x100, 0, 10);
    expect(result.startAddr).toBe(0x1100);
    expect(result.endAddr).toBe(0x1100 + 20);
  });

  it("applies negative instruction offset", () => {
    const result = computeDisassemblyRange("0x1000", 0, -5, 20);
    expect(result.startAddr).toBe(0x1000 - 10);
    expect(result.endAddr).toBe(0x1000 - 10 + 40);
  });

  it("applies positive instruction offset", () => {
    const result = computeDisassemblyRange("0x1000", 0, 10, 5);
    expect(result.startAddr).toBe(0x1000 + 20);
    expect(result.endAddr).toBe(0x1000 + 20 + 10);
  });

  it("handles decimal memory reference", () => {
    const result = computeDisassemblyRange("4096", 0, 0, 1);
    expect(result.startAddr).toBe(4096);
    expect(result.endAddr).toBe(4098);
  });

  it("handles combined offset and instruction offset", () => {
    const result = computeDisassemblyRange("0x0", 0x100, 10, 5);
    expect(result.startAddr).toBe(0x100 + 20);
    expect(result.endAddr).toBe(0x100 + 20 + 10);
  });

  it("handles zero count", () => {
    const result = computeDisassemblyRange("0x1000", 0, 0, 0);
    expect(result.startAddr).toBe(result.endAddr);
  });

  it("handles large addresses", () => {
    const result = computeDisassemblyRange("0x80000000", 0, 0, 1);
    expect(result.startAddr).toBe(0x80000000);
    expect(result.endAddr).toBe(0x80000002);
  });
});

// ─── formatMemoryReadResponse ──────────────────────────

describe("formatMemoryReadResponse", () => {
  it("formats hex data to base64", () => {
    const result = formatMemoryReadResponse("48656c6c6f", 0x1000, 5);
    expect(result.address).toBe("0x1000");
    expect(result.data).toBe(Buffer.from("Hello").toString("base64"));
    expect(result.unreadableBytes).toBe(0);
  });

  it("reports unreadable bytes when data is short", () => {
    const result = formatMemoryReadResponse("4142", 0x2000, 10);
    expect(result.address).toBe("0x2000");
    expect(result.data).toBe(Buffer.from("AB").toString("base64"));
    expect(result.unreadableBytes).toBe(8);
  });

  it("handles empty hex string", () => {
    const result = formatMemoryReadResponse("", 0x0, 4);
    expect(result.data).toBe("");
    expect(result.unreadableBytes).toBe(4);
  });

  it("handles zero requested count", () => {
    const result = formatMemoryReadResponse("ff", 0x100, 0);
    expect(result.unreadableBytes).toBe(0);
  });

  it("decodes full 256-byte read correctly", () => {
    const hex = "00".repeat(256);
    const result = formatMemoryReadResponse(hex, 0x20000000, 256);
    const decoded = Buffer.from(result.data, "base64");
    expect(decoded.length).toBe(256);
    expect(result.unreadableBytes).toBe(0);
  });

  it("handles odd-length hex (truncated last nibble)", () => {
    const result = formatMemoryReadResponse("abc", 0x0, 2);
    // Buffer.from("abc", "hex") produces 1 byte (0xAB), ignores trailing 'c'
    expect(result.unreadableBytes).toBe(1);
  });

  it("formats address without leading zeros", () => {
    const result = formatMemoryReadResponse("ff", 0x1, 1);
    expect(result.address).toBe("0x1");
  });

  it("formats large address", () => {
    const result = formatMemoryReadResponse("ff", 0xFFFFFFFF, 1);
    expect(result.address).toBe("0xffffffff");
  });
});
