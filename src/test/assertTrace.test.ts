import { describe, it, expect, beforeEach } from "vitest";
import { AssertTraceStore } from "../assertTrace";
import type { AssertPrompt } from "../assertPrompt";

function makePrompt(overrides: Partial<AssertPrompt> = {}): AssertPrompt {
  return {
    type: "read",
    addr: 0x40000100,
    size: 4,
    pc: 0x1000,
    hints: [],
    decisions: [],
    rawLines: [],
    ...overrides,
  };
}

describe("AssertTraceStore", () => {
  let store: AssertTraceStore;

  beforeEach(() => {
    store = new AssertTraceStore(100);
  });

  it("starts empty", () => {
    expect(store.getEntries()).toEqual([]);
  });

  it("upsertPrompt creates a new entry", () => {
    const prompt = makePrompt();
    store.upsertPrompt(prompt, null, null);
    const entries = store.getEntries();
    expect(entries.length).toBe(1);
    expect(entries[0].type).toBe("read");
    expect(entries[0].addr).toBe(0x40000100);
    expect(entries[0].pc).toBe(0x1000);
    expect(entries[0].size).toBe(4);
  });

  it("upsertPrompt updates existing unresponded entry with same key", () => {
    const prompt = makePrompt();
    store.upsertPrompt(prompt, null, null);
    expect(store.getEntries().length).toBe(1);

    const updated = makePrompt({ register: "GPIOA_ODR" });
    store.upsertPrompt(updated, null, { action: "default", reason: "test" });
    expect(store.getEntries().length).toBe(1);
    expect(store.getEntries()[0].register).toBe("GPIOA_ODR");
    expect(store.getEntries()[0].recommendation?.action).toBe("default");
  });

  it("creates new entry after markResponse on previous", () => {
    const prompt = makePrompt();
    store.upsertPrompt(prompt, null, null);
    store.markResponse(prompt, "0x0");
    expect(store.getEntries()[0].response).toBe("0x0");

    // Same key prompt again should create new entry since previous is responded
    store.upsertPrompt(prompt, null, null);
    expect(store.getEntries().length).toBe(2);
  });

  it("markResponse with null prompt does nothing", () => {
    store.upsertPrompt(makePrompt(), null, null);
    store.markResponse(null, "0x0");
    expect(store.getEntries()[0].response).toBeUndefined();
  });

  it("markResponse for unknown prompt does nothing", () => {
    store.upsertPrompt(makePrompt(), null, null);
    const other = makePrompt({ addr: 0x99999999 });
    store.markResponse(other, "0x0");
    expect(store.getEntries()[0].response).toBeUndefined();
  });

  it("clear removes all entries", () => {
    store.upsertPrompt(makePrompt(), null, null);
    store.upsertPrompt(makePrompt({ addr: 0x200 }), null, null);
    expect(store.getEntries().length).toBe(2);
    store.clear();
    expect(store.getEntries()).toEqual([]);
  });

  it("trims entries beyond maxEntries", () => {
    const smallStore = new AssertTraceStore(3);
    for (let i = 0; i < 5; i++) {
      const prompt = makePrompt({ addr: i, pc: i });
      smallStore.upsertPrompt(prompt, null, null);
      // Mark response so next upsert creates a new entry
      smallStore.markResponse(prompt, "0x0");
    }
    expect(smallStore.getEntries().length).toBe(3);
  });

  it("newest entries are first (unshift)", () => {
    store.upsertPrompt(makePrompt({ addr: 1, pc: 1 }), null, null);
    store.markResponse(makePrompt({ addr: 1, pc: 1 }), "0x0");
    store.upsertPrompt(makePrompt({ addr: 2, pc: 2 }), null, null);
    const entries = store.getEntries();
    expect(entries[0].addr).toBe(2);
    expect(entries[1].addr).toBe(1);
  });

  it("stores location when provided", () => {
    store.upsertPrompt(makePrompt(), { path: "/src/main.c", line: 42 }, null);
    expect(store.getEntries()[0].location).toEqual({ path: "/src/main.c", line: 42 });
  });

  it("stores registers when provided", () => {
    const regs = [
      { name: "x0", value: "0x0" },
      { name: "x1", value: "0x1" },
    ];
    store.upsertPrompt(makePrompt(), null, null, regs);
    expect(store.getEntries()[0].registers).toEqual(regs);
  });

  it("stores write prompts", () => {
    const prompt = makePrompt({ type: "write", value: "0x00000041" });
    store.upsertPrompt(prompt, null, null);
    expect(store.getEntries()[0].type).toBe("write");
    expect(store.getEntries()[0].value).toBe("0x00000041");
  });

  it("fires onDidChange event", () => {
    let fired = 0;
    store.onDidChange(() => {
      fired++;
    });
    store.upsertPrompt(makePrompt(), null, null);
    expect(fired).toBe(1);
    store.markResponse(makePrompt(), "0x0");
    expect(fired).toBe(2);
    store.clear();
    expect(fired).toBe(3);
  });

  // B2.1 — Exact max entries boundary
  it("trims at exact maxEntries boundary", () => {
    const small = new AssertTraceStore(3);
    for (let i = 0; i < 3; i++) {
      const p = makePrompt({ addr: i, pc: i });
      small.upsertPrompt(p, null, null);
      small.markResponse(p, "0x0");
    }
    expect(small.getEntries().length).toBe(3);

    // Insert 4th — oldest should be dropped
    const extra = makePrompt({ addr: 99, pc: 99 });
    small.upsertPrompt(extra, null, null);
    expect(small.getEntries().length).toBe(3);
    // Newest is first
    expect(small.getEntries()[0].addr).toBe(99);
  });

  // B2.2 — maxEntries=1
  it("maxEntries=1 keeps only newest", () => {
    const tiny = new AssertTraceStore(1);
    const p1 = makePrompt({ addr: 1, pc: 1 });
    tiny.upsertPrompt(p1, null, null);
    tiny.markResponse(p1, "0x0");

    const p2 = makePrompt({ addr: 2, pc: 2 });
    tiny.upsertPrompt(p2, null, null);
    expect(tiny.getEntries().length).toBe(1);
    expect(tiny.getEntries()[0].addr).toBe(2);
  });

  // B2.3 — maxEntries=0
  it("maxEntries=0 trims immediately", () => {
    const zero = new AssertTraceStore(0);
    zero.upsertPrompt(makePrompt(), null, null);
    expect(zero.getEntries().length).toBe(0);
  });

  // B2.4 — Entry mutation (getEntries returns internal array)
  it("getEntries returns internal array (mutations are visible)", () => {
    store.upsertPrompt(makePrompt({ hints: ["original"] }), null, null);
    const entries = store.getEntries();
    entries[0].hints.push("mutated");
    // Store hints were copied at upsert, but getEntries() returns internal array
    // so mutations on the returned entries DO affect the store
    expect(store.getEntries()[0].hints).toContain("mutated");
  });
});
