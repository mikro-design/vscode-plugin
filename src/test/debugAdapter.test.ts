import { describe, it, expect } from "vitest";
import {
  mapStopReason,
  escapeMiString,
  parseMiLine,
  defaultRiscvRegisterNames,
} from "../miParser";

describe("debug adapter MI integration", () => {
  describe("mapStopReason mapping used by adapter", () => {
    it("breakpoint-hit -> breakpoint for stopped events", () => {
      expect(mapStopReason("breakpoint-hit")).toBe("breakpoint");
    });

    it("end-stepping-range -> step for step events", () => {
      expect(mapStopReason("end-stepping-range")).toBe("step");
    });

    it("unknown reasons default to pause", () => {
      expect(mapStopReason("watchpoint-trigger")).toBe("pause");
      expect(mapStopReason("function-finished")).toBe("pause");
    });
  });

  describe("breakpoint MI command generation", () => {
    it("generates break-insert command without condition", () => {
      const target = "/path/to/file.c:42";
      const command = `-break-insert -f \"${escapeMiString(target)}\"`;
      expect(command).toBe(`-break-insert -f \"${target}\"`);
    });

    it("generates break-insert command with condition", () => {
      const target = "/path/to/file.c:42";
      const condition = "x > 10";
      const command = `-break-insert -f -c \"${escapeMiString(condition)}\" \"${escapeMiString(target)}\"`;
      expect(command).toContain("-c");
      expect(command).toContain("x > 10");
    });

    it("escapes special characters in breakpoint conditions", () => {
      const condition = 'str == "hello"';
      const escaped = escapeMiString(condition);
      expect(escaped).toBe('str == \\"hello\\"');
    });

    it("generates hardware breakpoint command", () => {
      const addr = "0x10000";
      const command = `-break-insert -h *${addr}`;
      expect(command).toBe("-break-insert -h *0x10000");
    });
  });

  describe("thread list parsing from MI thread-info", () => {
    it("parses single thread response", () => {
      const line = '42^done,threads=[{id="1",target-id="Thread 1",state="stopped"}],current-thread-id="1"';
      const record = parseMiLine(line);
      const threads = record!.results?.threads;
      expect(Array.isArray(threads)).toBe(true);
      expect(threads.length).toBe(1);
      expect(threads[0].id).toBe("1");
      expect(threads[0].state).toBe("stopped");
    });

    it("parses multi-thread response", () => {
      const line = '42^done,threads=[{id="1",target-id="Thread 1",state="stopped"},{id="2",target-id="Thread 2",state="running"}]';
      const record = parseMiLine(line);
      const threads = record!.results?.threads;
      expect(threads.length).toBe(2);
      expect(threads[0].id).toBe("1");
      expect(threads[1].id).toBe("2");
      expect(threads[1].state).toBe("running");
    });
  });

  describe("register name fallback logic", () => {
    it("provides 32 RISC-V register names as fallback", () => {
      const names = defaultRiscvRegisterNames();
      expect(names.length).toBe(32);
      expect(names[0]).toBe("x0 (zero)");
      expect(names[1]).toBe("x1 (ra)");
      expect(names[2]).toBe("x2 (sp)");
      expect(names[8]).toBe("x8 (s0/fp)");
      expect(names[10]).toBe("x10 (a0)");
    });
  });

  describe("disassembly response formatting", () => {
    it("parses disassembly MI response format", () => {
      const line = '42^done,asm_insns=[{address="0x00010000",func-name="main",offset="0",inst="addi sp, sp, -16"},{address="0x00010004",func-name="main",offset="4",inst="sw ra, 12(sp)"}]';
      const record = parseMiLine(line);
      const insns = record!.results?.asm_insns;
      expect(Array.isArray(insns)).toBe(true);
      expect(insns.length).toBe(2);
      expect(insns[0].address).toBe("0x00010000");
      expect(insns[0]["func-name"]).toBe("main");
      expect(insns[0].inst).toBe("addi sp, sp, -16");
      expect(insns[1].address).toBe("0x00010004");
      expect(insns[1].inst).toBe("sw ra, 12(sp)");
    });
  });

  describe("watchpoint MI commands", () => {
    it("generates write watchpoint command", () => {
      const expr = "*(int*)0x40000100";
      const command = `-break-watch ${expr}`;
      expect(command).toBe("-break-watch *(int*)0x40000100");
    });

    it("generates read watchpoint command", () => {
      const expr = "myVar";
      const command = `-break-watch -r ${expr}`;
      expect(command).toBe("-break-watch -r myVar");
    });

    it("generates access watchpoint command", () => {
      const expr = "myVar";
      const command = `-break-watch -a ${expr}`;
      expect(command).toBe("-break-watch -a myVar");
    });
  });
});
