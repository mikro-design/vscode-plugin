export interface AssertDecision {
  input: string;
  target: string;
  targetPc?: number;
  targetAsm?: string;
  note?: string;
  raw: string;
}

export interface AssertPrompt {
  type: "read" | "write";
  addr: number;
  size: number;
  pc: number;
  hints: string[];
  decisions: AssertDecision[];
  rawLines: string[];
  register?: string;
  reset?: string;
  fields?: string;
  value?: string;
  peripheral?: string;
}

export type AssertPromptListener = (prompt: AssertPrompt | null) => void;

export class AssertPromptParser {
  private buffer = "";
  private current: AssertPrompt | null = null;
  private inDecision = false;

  constructor(private readonly onUpdate: AssertPromptListener) {}

  feed(chunk: string): void {
    const normalized = chunk.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    this.buffer += normalized;
    let idx = this.buffer.indexOf("\n");
    while (idx >= 0) {
      const line = this.buffer.slice(0, idx).replace(/\r$/, "");
      this.buffer = this.buffer.slice(idx + 1);
      this.handleLine(line);
      idx = this.buffer.indexOf("\n");
    }
    if (this.buffer.includes("[ASSERT] Read value") || this.buffer.includes("[ASSERT] Write expect")) {
      this.handleLine(this.buffer);
      this.buffer = "";
    }
  }

  private handleLine(line: string): void {
    if (!line) {
      return;
    }
    const readMatch = line.match(/\[ASSERT\] MMIO READ at (0x[0-9a-fA-F]+) size=(\d+) PC=(0x[0-9a-fA-F]+)/);
    const writeMatch = line.match(/\[ASSERT\] MMIO WRITE at (0x[0-9a-fA-F]+) size=(\d+) PC=(0x[0-9a-fA-F]+)/);
    if (readMatch || writeMatch) {
      const match = readMatch ?? writeMatch!;
      const type = readMatch ? "read" : "write";
      const addr = Number.parseInt(match[1], 16);
      const size = Number.parseInt(match[2], 10);
      const pc = Number.parseInt(match[3], 16);
      this.current = {
        type,
        addr,
        size,
        pc,
        hints: [],
        decisions: [],
        rawLines: [line],
      };
      this.inDecision = false;
      this.onUpdate(this.current);
      return;
    }

    if (!this.current) {
      return;
    }

    this.current.rawLines.push(line);

    const hintMatch = line.match(/\[ASSERT\] Hint:\s*(.*)/);
    if (hintMatch) {
      this.current.hints.push(hintMatch[1].trim());
      this.onUpdate(this.current);
      return;
    }

    const registerMatch = line.match(/\[ASSERT\] Register:\s*(.*)/);
    if (registerMatch) {
      this.current.register = registerMatch[1].trim();
      this.onUpdate(this.current);
      return;
    }

    const resetMatch = line.match(/\[ASSERT\] Reset:\s*(0x[0-9a-fA-F]+)/);
    if (resetMatch) {
      this.current.reset = resetMatch[1];
      this.onUpdate(this.current);
      return;
    }

    const fieldsMatch = line.match(/\[ASSERT\] Fields:\s*(.*)/);
    if (fieldsMatch) {
      this.current.fields = fieldsMatch[1].trim();
      this.onUpdate(this.current);
      return;
    }

    const valueMatch = line.match(/\[ASSERT\] Value:\s*(0x[0-9a-fA-F]+)/);
    if (valueMatch) {
      this.current.value = valueMatch[1];
      this.onUpdate(this.current);
      return;
    }

    const peripheralMatch = line.match(/\[ASSERT\] Peripheral:\s*(.*)/);
    if (peripheralMatch) {
      this.current.peripheral = peripheralMatch[1].trim();
      this.onUpdate(this.current);
      return;
    }

    if (line.includes("[ASSERT] Decision")) {
      this.inDecision = true;
      this.onUpdate(this.current);
      return;
    }

    if (this.inDecision && line.includes("->")) {
      const parsed = this.parseDecision(line);
      if (parsed) {
        this.current.decisions.push(parsed);
        this.onUpdate(this.current);
        return;
      }
    }

    if (this.inDecision && !line.includes("->") && line.startsWith("[ASSERT]")) {
      this.inDecision = false;
    }
  }

  private parseDecision(line: string): AssertDecision | null {
    const clean = line.replace(/^\[ASSERT\]\s*/, "").trim();
    const arrowIndex = clean.indexOf("->");
    if (arrowIndex <= 0) {
      return null;
    }
    const left = clean.slice(0, arrowIndex).trim();
    let right = clean.slice(arrowIndex + 2).trim();
    let note: string | undefined;
    const noteStart = right.lastIndexOf("(");
    if (noteStart >= 0 && right.endsWith(")")) {
      note = right.slice(noteStart + 1, -1).trim();
      right = right.slice(0, noteStart).trim();
    }
    let targetPc: number | undefined;
    let targetAsm: string | undefined;
    const pcMatch = right.match(/^(0x[0-9a-fA-F]+)/);
    if (pcMatch) {
      targetPc = Number.parseInt(pcMatch[1], 16);
      const asmIndex = right.indexOf(":");
      if (asmIndex >= 0) {
        targetAsm = right.slice(asmIndex + 1).trim();
      }
    }
    return {
      input: left,
      target: right,
      targetPc,
      targetAsm,
      note,
      raw: line,
    };
  }

  clear(): void {
    this.current = null;
    this.inDecision = false;
  }
}
