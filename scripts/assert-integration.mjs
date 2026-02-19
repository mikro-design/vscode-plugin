/**
 * assert-integration.mjs — End-to-end assert pipeline integration test.
 *
 * Spawns REAL rv32sim with REAL firmware, receives REAL [ASSERT] prompts,
 * feeds responses through the REAL parser + sanitizer, sends responses
 * to rv32sim's stdin, and verifies EVERY invariant at EVERY step.
 *
 * This catches the bugs that unit tests missed:
 *  - Comma insertion in sanitized values
 *  - Field annotations leaking into stdin responses
 *  - Parser failing on real rv32sim output format
 *  - Write auto-reply with wrong value
 *  - Decision inputs containing spaces
 *
 * Usage:
 *   node scripts/assert-integration.mjs
 *
 * Env vars:
 *   MIKRO_TEST_ELF           — path to ELF binary
 *   MIKRO_TEST_RV32SIM       — path to rv32sim.py
 *   MIKRO_TEST_SVD           — path to SVD file
 *   MIKRO_ASSERT_TRACE       — set to "1" for verbose output
 */

import { spawn, spawnSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import path from "path";
import { pathToFileURL } from "url";

const workspace = process.cwd();
const settingsPath = path.join(workspace, ".vscode", "settings.json");
const trace = process.env.MIKRO_ASSERT_TRACE === "1";

// ─── Helpers ─────────────────────────────────────────

function stripJsonComments(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\/\/.*$/, ""))
    .join("\n");
}

function readSettings() {
  if (!existsSync(settingsPath)) return {};
  try {
    return JSON.parse(stripJsonComments(readFileSync(settingsPath, "utf8")));
  } catch { return {}; }
}

function findRv32simCandidate() {
  const home = process.env.HOME || "";
  const candidates = [
    path.join(home, "work", "git", "rv32sim.py", "rv32sim.py"),
    path.join(home, "work", "git", "rv32sim", "rv32sim.py"),
    path.join(home, "git", "rv32sim", "rv32sim.py"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

// ─── Import compiled modules ─────────────────────────

// AssertPromptParser has no vscode dependency — import directly
const assertPromptUrl = pathToFileURL(path.join(workspace, "out", "assertPrompt.js"));
const { AssertPromptParser } = await import(assertPromptUrl.href);

// sanitizeAssertValue is in rv32simController which imports vscode.
// Inline the pure function here (exact copy) to avoid vscode dependency.
function sanitizeAssertValue(input) {
  let firstLine = String(input ?? "")
    .replace(/\r/g, "")
    .split("\n", 1)[0]
    .trim();
  if (!firstLine) return "";
  if (firstLine.startsWith("[ASSERT]")) return "";
  return firstLine;
}

// ─── Test runner ─────────────────────────────────────

let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, message) {
  if (condition) {
    passed += 1;
    if (trace) console.log(`  ✓ ${message}`);
  } else {
    failed += 1;
    failures.push(message);
    console.error(`  ✗ ${message}`);
  }
}

function section(name) {
  console.log(`\n[${name}]`);
}

// ─── Core: spawn rv32sim and collect prompts ─────────

function spawnSim(rv32simPath, elfPath, svdPath, memRegions, extraFlags = []) {
  const args = [
    "-u", rv32simPath,
    elfPath,
    "--assert-assist",
    "--assert-writes",
    "--run",
    "--no-gdb-server",
    "--permissive",
    "--max-cycles=50000",
  ];
  if (svdPath) args.push(`--svd=${svdPath}`);
  for (const r of memRegions) args.push(`--mem-region=${r}`);
  for (const f of extraFlags) args.push(f);

  return spawn("python3", args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8" },
  });
}

/**
 * Run a single scenario: spawn rv32sim, parse prompts, send responses.
 * Returns { prompts, responses, errors, rawStdout, rawStderr }.
 */
function runScenario(rv32simPath, elfPath, svdPath, memRegions, responseStrategy, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 15000;
  const maxPrompts = opts.maxPrompts ?? 20;

  return new Promise((resolve) => {
    const sim = spawnSim(rv32simPath, elfPath, svdPath, memRegions);
    const prompts = [];
    const responses = [];
    const errors = [];
    let rawStdout = "";
    let rawStderr = "";
    let promptIndex = -1;
    let settled = false;
    let idleTimer = null;

    // Store REFERENCES to the parser's internal prompt objects.
    // The parser mutates these in-place (e.g. rawLines.push) without always
    // firing onUpdate — notably for "Read value" and "Write expect" flush lines.
    // This matches how the real Rv32SimController works (it stores a reference too).
    let livePrompt = null;

    const parser = new AssertPromptParser((prompt) => {
      if (!prompt) return;
      livePrompt = prompt;

      // Detect new prompt vs update to existing one
      const isNewPrompt =
        prompts.length === 0 ||
        prompt.addr !== prompts[prompts.length - 1].addr ||
        prompt.pc !== prompts[prompts.length - 1].pc ||
        prompt.type !== prompts[prompts.length - 1].type;

      if (isNewPrompt) {
        prompts.push(prompt);
      }
      // Updates modify the live reference directly — no need to replace
    });

    function tryRespond(rawText) {
      if (prompts.length === 0 || prompts.length - 1 <= promptIndex) return;

      // Detect readiness from raw stdout text, not rawLines copies.
      // The parser adds "Read value"/"Write expect" to rawLines but may not
      // fire onUpdate for it. Checking raw text is the reliable approach.
      const isReady =
        rawText.includes("Read value") ||
        rawText.includes("Write expect");
      if (!isReady) return;

      const currentIndex = prompts.length - 1;
      promptIndex = currentIndex;

      // Snapshot the live prompt NOW (after parser has processed the chunk)
      const prompt = livePrompt;

      // Get response from strategy
      const rawResponse = responseStrategy(prompt, currentIndex);

      // Sanitize (same as real controller does)
      const sanitized = sanitizeAssertValue(rawResponse);

      // Snapshot the prompt for later validation (deep copy the live reference)
      const snapshot = {
        ...prompt,
        decisions: prompt.decisions.map((d) => ({ ...d })),
        hints: [...prompt.hints],
        rawLines: [...prompt.rawLines],
      };
      // Replace the live reference in prompts with the snapshot
      prompts[currentIndex] = snapshot;

      responses.push({
        promptIndex: currentIndex,
        promptType: snapshot.type,
        promptAddr: snapshot.addr,
        raw: rawResponse,
        sanitized,
      });

      if (trace) {
        console.log(`    [${currentIndex}] ${prompt.type} @ 0x${prompt.addr.toString(16)} → "${sanitized}"`);
      }

      try {
        sim.stdin.write(`${sanitized || rawResponse}\n`);
      } catch (err) {
        errors.push(`stdin write failed: ${err.message}`);
      }

      if (currentIndex + 1 >= maxPrompts) {
        finish();
        return;
      }

      // After responding, set an idle timer: if no new prompt arrives within 3s,
      // rv32sim has either halted or looped without more MMIO — we're done.
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        if (!settled) finish();
      }, 3000);
    }

    function finish() {
      if (settled) return;
      settled = true;
      clearTimeout(idleTimer);
      try { sim.stdin.end(); } catch {}
      try { sim.kill("SIGTERM"); } catch {}
      setTimeout(() => {
        try { if (!sim.killed) sim.kill("SIGKILL"); } catch {}
      }, 1000);
      setTimeout(() => {
        resolve({ prompts, responses, errors, rawStdout, rawStderr });
      }, 1500);
    }

    sim.stdout.on("data", (data) => {
      const text = data.toString();
      rawStdout += text;
      parser.feed(text);
      tryRespond(text);
    });

    sim.stderr.on("data", (data) => {
      const text = data.toString();
      rawStderr += text;
      parser.feed(text);
      tryRespond(text);
    });

    sim.on("close", () => {
      if (!settled) {
        settled = true;
        resolve({ prompts, responses, errors, rawStdout, rawStderr });
      }
    });

    sim.on("error", (err) => {
      errors.push(`spawn error: ${err.message}`);
      finish();
    });

    setTimeout(() => {
      if (!settled) {
        // Only report timeout as error if we never sent ANY response.
        // Timeout after responses is normal (rv32sim looping or halted).
        if (responses.length === 0) {
          errors.push("timeout (no responses sent)");
        }
        finish();
      }
    }, timeoutMs);
  });
}

// ─── Invariant checks ────────────────────────────────

function validatePrompt(prompt, index) {
  const prefix = `prompt[${index}]`;

  // Type
  assert(
    prompt.type === "read" || prompt.type === "write",
    `${prefix} type is "read" or "write" (got "${prompt.type}")`,
  );

  // Address
  assert(
    Number.isInteger(prompt.addr) && prompt.addr >= 0,
    `${prefix} addr is non-negative integer (got ${prompt.addr})`,
  );

  // Size
  assert(
    prompt.size === 1 || prompt.size === 2 || prompt.size === 4,
    `${prefix} size is 1, 2, or 4 (got ${prompt.size})`,
  );

  // PC
  assert(
    Number.isInteger(prompt.pc) && prompt.pc >= 0,
    `${prefix} pc is non-negative integer (got ${prompt.pc})`,
  );

  // rawLines all contain [ASSERT]
  for (let i = 0; i < prompt.rawLines.length; i++) {
    assert(
      prompt.rawLines[i].includes("[ASSERT]"),
      `${prefix} rawLines[${i}] contains [ASSERT]`,
    );
  }

  // Decisions: input must be CLEAN
  for (let d = 0; d < prompt.decisions.length; d++) {
    const dec = prompt.decisions[d];
    const dp = `${prefix}.decisions[${d}]`;

    assert(
      !dec.input.includes(" "),
      `${dp}.input has no spaces (got "${dec.input}")`,
    );
    assert(
      !dec.input.includes(","),
      `${dp}.input has no commas (got "${dec.input}")`,
    );
    assert(
      !dec.input.includes("="),
      `${dp}.input has no = (got "${dec.input}")`,
    );
    assert(
      /^(0x[0-9a-fA-F]+|\d+)$/.test(dec.input),
      `${dp}.input is valid hex/dec (got "${dec.input}")`,
    );
  }

  // Write prompts should have value
  if (prompt.type === "write") {
    // Value should be present and valid hex (once ready)
    const hasValue = prompt.rawLines.some((l) => l.includes("[ASSERT] Value:"));
    if (hasValue) {
      assert(
        prompt.value !== undefined && /^0x[0-9a-fA-F]+$/.test(prompt.value),
        `${prefix} write value is valid hex (got "${prompt.value}")`,
      );
    }
  }

  // Read prompts: if reset exists, it should be valid hex
  if (prompt.type === "read" && prompt.reset) {
    assert(
      /^0x[0-9a-fA-F]+$/.test(prompt.reset),
      `${prefix} reset is valid hex (got "${prompt.reset}")`,
    );
  }
}

function validateResponse(response) {
  const prefix = `response[${response.promptIndex}]`;
  const v = response.sanitized;

  // Allow empty (default), "-" (ignore), or clean hex/dec
  if (v === "" || v === "-") {
    assert(true, `${prefix} sanitized is valid empty/ignore`);
    return;
  }

  assert(
    !v.includes(","),
    `${prefix} sanitized has no commas (got "${v}")`,
  );
  assert(
    !v.includes(" "),
    `${prefix} sanitized has no spaces (got "${v}")`,
  );
  assert(
    !v.includes("="),
    `${prefix} sanitized has no = (got "${v}")`,
  );
  assert(
    /^(0x[0-9a-fA-F]+|\d+)$/.test(v),
    `${prefix} sanitized is valid hex/dec (got "${v}")`,
  );
}

// ─── Response strategies ─────────────────────────────

function defaultStrategy(prompt) {
  if (prompt.type === "write") return prompt.value ?? "0x0";
  return prompt.reset ?? "";
}

function decisionStrategy(prompt, index) {
  if (prompt.decisions.length > 0) {
    // Alternate between first and second decision
    const decIdx = index % Math.min(prompt.decisions.length, 2);
    return prompt.decisions[decIdx].input;
  }
  return prompt.reset ?? "";
}

function fallthroughThenDecisionStrategy(prompt, index) {
  // First prompt: pick fallthrough (last decision or default) to reach deeper code paths.
  // This ensures the firmware reaches MMIO registers with field annotations (PIN=0x1 etc).
  if (index === 0 && prompt.decisions.length >= 2) {
    return prompt.decisions[prompt.decisions.length - 1].input;
  }
  if (prompt.decisions.length > 0) {
    return prompt.decisions[0].input;
  }
  return prompt.reset ?? "";
}

function ignoreStrategy() {
  return "-";
}

function mixedStrategy(prompt, index) {
  const strategies = [defaultStrategy, decisionStrategy, ignoreStrategy];
  return strategies[index % strategies.length](prompt, index);
}

function writeEchoStrategy(prompt) {
  // For writes: echo the written value. For reads: use default.
  if (prompt.type === "write") return prompt.value ?? "0x0";
  return prompt.reset ?? "";
}

// ─── Main ────────────────────────────────────────────

async function main() {
  const settings = readSettings();
  const elfPath = process.env.MIKRO_TEST_ELF || settings["mikroDesign.elfPath"];
  const svdPath = process.env.MIKRO_TEST_SVD || settings["mikroDesign.svdPath"];
  let rv32simPath = process.env.MIKRO_TEST_RV32SIM || settings["mikroDesign.rv32simPath"];
  if (!rv32simPath || !existsSync(rv32simPath)) {
    const candidate = findRv32simCandidate();
    if (candidate) rv32simPath = candidate;
  }

  if (!elfPath || !rv32simPath) {
    throw new Error(
      "Missing ELF or rv32simPath (set in settings.json or via env MIKRO_TEST_ELF/MIKRO_TEST_RV32SIM)"
    );
  }
  if (!existsSync(elfPath)) throw new Error(`ELF not found: ${elfPath}`);
  if (!existsSync(rv32simPath)) throw new Error(`rv32sim not found: ${rv32simPath}`);

  // Derive memory regions (same as adapter-integration.mjs)
  let memRegions = settings["mikroDesign.memRegions"] || [];
  if (!Array.isArray(memRegions) || memRegions.length === 0) {
    try {
      const memMapUrl = pathToFileURL(path.join(workspace, "out", "memMap.js"));
      const module = await import(memMapUrl.href);
      memRegions = module.deriveMemRegionsFromElf(elfPath);
    } catch {
      memRegions = [];
    }
  }

  console.log("assert-integration: starting");
  console.log(`  elf: ${elfPath}`);
  console.log(`  rv32sim: ${rv32simPath}`);
  console.log(`  svd: ${svdPath ?? "(none)"}`);
  console.log(`  memRegions: ${memRegions.length > 0 ? memRegions.join(", ") : "(auto)"}`);

  // ══════════════════════════════════════════════════
  // SCENARIO 1: Default responses for every prompt
  // ══════════════════════════════════════════════════
  section("Scenario 1: Default responses");
  {
    const result = await runScenario(rv32simPath, elfPath, svdPath, memRegions, defaultStrategy);
    assert(result.prompts.length >= 1, "at least 1 prompt received");
    assert(result.errors.length === 0, `no spawn/timeout errors (got ${result.errors.join(", ") || "none"})`);

    for (let i = 0; i < result.prompts.length; i++) {
      validatePrompt(result.prompts[i], i);
    }
    for (const resp of result.responses) {
      validateResponse(resp);
    }

    // First prompt should be a READ (while_one starts with MMIO reads)
    if (result.prompts.length > 0) {
      assert(result.prompts[0].type === "read", "first prompt is a read");
    }

    console.log(`  ${result.prompts.length} prompts, ${result.responses.length} responses`);
  }

  // ══════════════════════════════════════════════════
  // SCENARIO 2: Decision responses (field annotations)
  // This is the scenario that exposed the comma bug
  // ══════════════════════════════════════════════════
  section("Scenario 2: Decision responses (field annotation handling)");
  {
    // Use fallthrough-first strategy so firmware reaches EXTWAKECTRL with PIN=0x1
    const result = await runScenario(rv32simPath, elfPath, svdPath, memRegions, fallthroughThenDecisionStrategy);
    assert(result.prompts.length >= 1, "at least 1 prompt received");
    assert(result.errors.length === 0, `no errors (got ${result.errors.join(", ") || "none"})`);

    // Find prompts with decisions that have field annotations
    let hasFieldAnnotations = false;
    for (let i = 0; i < result.prompts.length; i++) {
      validatePrompt(result.prompts[i], i);
      for (const dec of result.prompts[i].decisions) {
        // Check if the RAW line has field annotations (FIELD=value)
        if (dec.raw && /\w+=0x[0-9a-fA-F]+/.test(dec.raw.split("->")[0] ?? "")) {
          hasFieldAnnotations = true;
          // THE CRITICAL CHECK: decision.input must NOT contain field annotations
          assert(
            !dec.input.includes("="),
            `decision with field annotation stripped: raw has "=" but input="${dec.input}" does not`,
          );
          assert(
            !dec.input.includes(" "),
            `decision input has no spaces despite field annotations in raw line`,
          );
        }
      }
    }
    for (const resp of result.responses) {
      validateResponse(resp);
    }

    // The while_one firmware is KNOWN to produce field annotations (PIN=0x1)
    // If this assert fires, the test firmware changed and we need a different ELF
    assert(hasFieldAnnotations, "firmware produces decisions with field annotations (PIN=0x1 etc)");

    console.log(`  ${result.prompts.length} prompts, field annotations: ${hasFieldAnnotations}`);
  }

  // ══════════════════════════════════════════════════
  // SCENARIO 3: Ignore responses
  // ══════════════════════════════════════════════════
  section("Scenario 3: Ignore responses");
  {
    const result = await runScenario(rv32simPath, elfPath, svdPath, memRegions, ignoreStrategy);
    assert(result.prompts.length >= 1, "at least 1 prompt received");
    assert(result.errors.length === 0, `no errors (got ${result.errors.join(", ") || "none"})`);

    for (let i = 0; i < result.prompts.length; i++) {
      validatePrompt(result.prompts[i], i);
    }
    for (const resp of result.responses) {
      validateResponse(resp);
      assert(resp.sanitized === "-", `ignore response is "-" (got "${resp.sanitized}")`);
    }

    console.log(`  ${result.prompts.length} prompts, all ignored`);
  }

  // ══════════════════════════════════════════════════
  // SCENARIO 4: Mixed responses (default, decision, ignore alternating)
  // ══════════════════════════════════════════════════
  section("Scenario 4: Mixed response strategies");
  {
    const result = await runScenario(rv32simPath, elfPath, svdPath, memRegions, mixedStrategy);
    assert(result.prompts.length >= 1, "at least 1 prompt received");
    assert(result.errors.length === 0, `no errors (got ${result.errors.join(", ") || "none"})`);

    for (let i = 0; i < result.prompts.length; i++) {
      validatePrompt(result.prompts[i], i);
    }
    for (const resp of result.responses) {
      validateResponse(resp);
    }

    console.log(`  ${result.prompts.length} prompts, mixed responses`);
  }

  // ══════════════════════════════════════════════════
  // SCENARIO 5: Write assert with correct echo-back
  // ══════════════════════════════════════════════════
  section("Scenario 5: Write assertions (echo value)");
  {
    const result = await runScenario(rv32simPath, elfPath, svdPath, memRegions, writeEchoStrategy);
    assert(result.prompts.length >= 1, "at least 1 prompt received");
    assert(result.errors.length === 0, `no errors (got ${result.errors.join(", ") || "none"})`);

    let writeCount = 0;
    for (let i = 0; i < result.prompts.length; i++) {
      validatePrompt(result.prompts[i], i);
      if (result.prompts[i].type === "write") writeCount++;
    }
    for (const resp of result.responses) {
      validateResponse(resp);
    }

    // Verify write prompts got the written value echoed back
    for (const resp of result.responses) {
      if (resp.promptType === "write") {
        const prompt = result.prompts[resp.promptIndex];
        if (prompt.value) {
          assert(
            resp.sanitized === prompt.value,
            `write response echoes value: expected "${prompt.value}", got "${resp.sanitized}"`,
          );
        }
      }
    }

    console.log(`  ${result.prompts.length} prompts (${writeCount} writes)`);
  }

  // ══════════════════════════════════════════════════
  // SCENARIO 6: Parser handles real rv32sim output format
  // Validate specific fields from real output
  // ══════════════════════════════════════════════════
  section("Scenario 6: Parser correctness on real output");
  {
    const result = await runScenario(rv32simPath, elfPath, svdPath, memRegions, defaultStrategy);

    for (let i = 0; i < result.prompts.length; i++) {
      const p = result.prompts[i];
      const prefix = `prompt[${i}]`;

      // Register should be parsed if SVD available
      if (svdPath && p.rawLines.some((l) => l.includes("[ASSERT] Register:"))) {
        assert(
          p.register !== undefined && p.register.length > 0,
          `${prefix} register parsed (got "${p.register}")`,
        );
      }

      // Reset should be parsed for reads
      if (p.type === "read" && p.rawLines.some((l) => l.includes("[ASSERT] Reset:"))) {
        assert(
          p.reset !== undefined && /^0x[0-9a-fA-F]+$/.test(p.reset),
          `${prefix} reset parsed (got "${p.reset}")`,
        );
      }

      // Fields should be parsed if present
      if (p.rawLines.some((l) => l.includes("[ASSERT] Fields:"))) {
        assert(
          p.fields !== undefined && p.fields.length > 0,
          `${prefix} fields parsed (got "${p.fields}")`,
        );
      }

      // Value should be parsed for writes
      if (p.type === "write" && p.rawLines.some((l) => l.includes("[ASSERT] Value:"))) {
        assert(
          p.value !== undefined && /^0x[0-9a-fA-F]+$/.test(p.value),
          `${prefix} write value parsed (got "${p.value}")`,
        );
      }

      // Decisions: target should have PC and ASM
      for (let d = 0; d < p.decisions.length; d++) {
        const dec = p.decisions[d];
        assert(
          dec.targetPc !== undefined && Number.isInteger(dec.targetPc),
          `${prefix}.decisions[${d}] has targetPc (got ${dec.targetPc})`,
        );
        assert(
          dec.targetAsm !== undefined && dec.targetAsm.length > 0,
          `${prefix}.decisions[${d}] has targetAsm (got "${dec.targetAsm}")`,
        );
      }
    }

    console.log(`  validated ${result.prompts.length} prompts for complete field parsing`);
  }

  // ══════════════════════════════════════════════════
  // SCENARIO 7: Sanitize round-trip — EVERY response
  // that goes to stdin must be accepted by rv32sim
  // ══════════════════════════════════════════════════
  section("Scenario 7: Sanitize round-trip invariants");
  {
    // Run all strategies and collect all responses
    const strategies = [
      { name: "default", fn: defaultStrategy },
      { name: "decision", fn: decisionStrategy },
      { name: "ignore", fn: ignoreStrategy },
      { name: "mixed", fn: mixedStrategy },
    ];

    let totalResponses = 0;
    for (const strat of strategies) {
      const result = await runScenario(rv32simPath, elfPath, svdPath, memRegions, strat.fn);

      for (const resp of result.responses) {
        totalResponses++;
        const v = resp.sanitized;

        // THE ABSOLUTE INVARIANT: what goes to rv32sim stdin must be one of:
        // 1. Empty string (default)
        // 2. "-" (ignore)
        // 3. Clean hex: 0x[0-9a-fA-F]+
        // 4. Clean decimal: [0-9]+
        // NOTHING ELSE. No commas. No spaces. No field annotations. No [ASSERT].
        const isValid =
          v === "" ||
          v === "-" ||
          /^0x[0-9a-fA-F]+$/.test(v) ||
          /^\d+$/.test(v);

        assert(
          isValid,
          `${strat.name}[${resp.promptIndex}] stdin value is valid: "${v}"`,
        );

        // Redundant but explicit: these are the exact bugs that were missed
        assert(!v.includes(","), `${strat.name}[${resp.promptIndex}] no commas in "${v}"`);
        assert(!v.includes("="), `${strat.name}[${resp.promptIndex}] no field annotations in "${v}"`);
        assert(
          !v.includes("[ASSERT]"),
          `${strat.name}[${resp.promptIndex}] no injection in "${v}"`,
        );
      }
    }

    assert(totalResponses > 0, `total responses validated: ${totalResponses}`);
    console.log(`  ${totalResponses} responses validated across all strategies`);
  }

  // ══════════════════════════════════════════════════
  // SCENARIO 8: Multiple sequential prompts — state machine
  // Verify parser handles transitions between prompts correctly
  // ══════════════════════════════════════════════════
  section("Scenario 8: Sequential prompt state machine");
  {
    const result = await runScenario(rv32simPath, elfPath, svdPath, memRegions, defaultStrategy, {
      maxPrompts: 10,
    });

    // Each prompt should have a unique (addr, pc, type) or different occurrence
    // At minimum, addr/pc should be valid for all
    for (let i = 0; i < result.prompts.length; i++) {
      validatePrompt(result.prompts[i], i);
    }

    // Responses should match prompts 1:1
    assert(
      result.responses.length === result.prompts.length,
      `responses (${result.responses.length}) match prompts (${result.prompts.length})`,
    );

    // Each response should be for the correct prompt index
    for (let i = 0; i < result.responses.length; i++) {
      assert(
        result.responses[i].promptIndex === i,
        `response[${i}] is for prompt[${result.responses[i].promptIndex}]`,
      );
    }

    console.log(`  ${result.prompts.length} sequential prompts handled correctly`);
  }

  // ══════════════════════════════════════════════════
  // SCENARIO 9: No SVD — parser still works without register info
  // ══════════════════════════════════════════════════
  section("Scenario 9: No SVD (register names unavailable)");
  {
    const result = await runScenario(rv32simPath, elfPath, null, memRegions, defaultStrategy);
    assert(result.prompts.length >= 1, "prompts received even without SVD");
    assert(result.errors.length === 0, `no errors (got ${result.errors.join(", ") || "none"})`);

    for (let i = 0; i < result.prompts.length; i++) {
      validatePrompt(result.prompts[i], i);
    }
    for (const resp of result.responses) {
      validateResponse(resp);
    }

    console.log(`  ${result.prompts.length} prompts without SVD`);
  }

  // ══════════════════════════════════════════════════
  // SCENARIO 10: Rapid succession — no stdin delay
  // Feed responses as fast as possible
  // ══════════════════════════════════════════════════
  section("Scenario 10: Rapid-fire responses");
  {
    // Use a strategy that responds immediately with the simplest valid value
    const quickStrategy = (prompt) => {
      if (prompt.type === "write") return prompt.value ?? "0x0";
      if (prompt.decisions.length > 0) return prompt.decisions[0].input;
      return prompt.reset ?? "0x0";
    };

    const result = await runScenario(rv32simPath, elfPath, svdPath, memRegions, quickStrategy, {
      maxPrompts: 15,
      timeoutMs: 20000,
    });

    assert(result.prompts.length >= 1, "prompts received in rapid mode");
    assert(result.errors.length === 0, `no errors in rapid mode`);

    for (let i = 0; i < result.prompts.length; i++) {
      validatePrompt(result.prompts[i], i);
    }
    for (const resp of result.responses) {
      validateResponse(resp);
    }

    console.log(`  ${result.prompts.length} prompts handled at full speed`);
  }

  // ══════════════════════════════════════════════════
  // SCENARIO 11: Injection attempts
  // Verify sanitizer blocks malicious stdin values
  // ══════════════════════════════════════════════════
  section("Scenario 11: Sanitize blocks injection");
  {
    const injectionInputs = [
      "[ASSERT] MMIO READ at 0x4000",
      "[ASSERT] anything\nmore stuff",
      "0x0\n[ASSERT] injected",
      "  [ASSERT] with leading spaces",
      "\r\n[ASSERT] crlf injection",
      "0x0,PIN=0x1",   // comma from the old bug
      "",               // empty
      "   ",            // whitespace only
      null,
      undefined,
    ];

    for (const input of injectionInputs) {
      const sanitized = sanitizeAssertValue(input);
      assert(
        !sanitized.includes("[ASSERT]"),
        `sanitize blocks injection: "${String(input).slice(0, 30)}..." → "${sanitized}"`,
      );
      // Multi-line inputs should be truncated to first line
      assert(
        !sanitized.includes("\n"),
        `sanitize strips newlines: "${String(input).slice(0, 30)}..."`,
      );
      assert(
        !sanitized.includes("\r"),
        `sanitize strips carriage returns: "${String(input).slice(0, 30)}..."`,
      );
    }

    console.log(`  ${injectionInputs.length} injection attempts blocked`);
  }

  // ══════════════════════════════════════════════════
  // SCENARIO 12: Verify every decision.input from real
  // rv32sim would be accepted back as stdin
  // ══════════════════════════════════════════════════
  section("Scenario 12: Decision → stdin round-trip");
  {
    const result = await runScenario(rv32simPath, elfPath, svdPath, memRegions, defaultStrategy);

    let decisionCount = 0;
    for (const prompt of result.prompts) {
      for (const dec of prompt.decisions) {
        decisionCount++;
        const sanitized = sanitizeAssertValue(dec.input);

        // After sanitize, the value must still be valid
        assert(
          sanitized === dec.input,
          `decision.input survives sanitize unchanged: "${dec.input}" → "${sanitized}"`,
        );

        // And it must be a valid rv32sim stdin value
        assert(
          /^(0x[0-9a-fA-F]+|\d+)$/.test(sanitized),
          `decision.input is valid stdin value: "${sanitized}"`,
        );
      }
    }

    assert(decisionCount > 0, `validated ${decisionCount} decision inputs`);
    console.log(`  ${decisionCount} decision inputs validated as clean stdin values`);
  }

  // ─── Summary ──────────────────────────────────────

  console.log("\n═════════════════════════════════════");
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failures.length) {
    console.log("Failures:");
    for (const f of failures) {
      console.log(`  ✗ ${f}`);
    }
  }
  console.log("═════════════════════════════════════\n");

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(`assert-integration failed: ${err.message || err}`);
  process.exit(1);
});
