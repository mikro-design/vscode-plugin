export type MiRecord = {
  token?: number;
  type: string;
  class?: string;
  results?: any;
  output?: string;
};

export function mapStopReason(reason: string): string {
  switch (reason) {
    case "breakpoint-hit":
      return "breakpoint";
    case "end-stepping-range":
      return "step";
    case "signal-received":
      return "signal";
    case "exited-normally":
      return "exited";
    default:
      return "pause";
  }
}

export function escapeMiString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function parseNumber(value: string): number {
  if (value.startsWith("0x") || value.startsWith("0X")) {
    return Number.parseInt(value, 16);
  }
  return Number.parseInt(value, 10) || 0;
}

export function parseMiLine(line: string): MiRecord | null {
  if (!line) {
    return null;
  }
  const streamTypes = ["~", "&", "@"];
  if (streamTypes.includes(line[0])) {
    return { type: line[0], output: parseMiCString(line.slice(1)) };
  }
  let i = 0;
  let tokenStr = "";
  while (i < line.length && /[0-9]/.test(line[i])) {
    tokenStr += line[i];
    i += 1;
  }
  const token = tokenStr ? Number.parseInt(tokenStr, 10) : undefined;
  const type = line[i];
  if (!type || !["^", "*", "="].includes(type)) {
    return null;
  }
  const rest = line.slice(i + 1);
  const commaIndex = rest.indexOf(",");
  const cls = commaIndex === -1 ? rest : rest.slice(0, commaIndex);
  const resultsText = commaIndex === -1 ? "" : rest.slice(commaIndex + 1);
  const results = resultsText ? parseMiResults(resultsText).results : {};
  return { token, type, class: cls, results };
}

export function parseMiResults(text: string): { results: any; index: number } {
  const results: any = {};
  let index = 0;
  while (index < text.length) {
    const parsed = parseMiResult(text, index);
    results[parsed.key] = parsed.value;
    index = parsed.index;
    if (text[index] === ",") {
      index += 1;
      continue;
    }
    break;
  }
  return { results, index };
}

export function parseMiResult(text: string, start: number): { key: string; value: any; index: number } {
  let index = start;
  let key = "";
  while (index < text.length && text[index] !== "=") {
    key += text[index];
    index += 1;
  }
  index += 1; // skip '='
  const parsed = parseMiValue(text, index);
  return { key: key.trim(), value: parsed.value, index: parsed.index };
}

export function parseMiValue(text: string, start: number): { value: any; index: number } {
  let index = start;
  const ch = text[index];
  if (ch === '"') {
    const { value, index: nextIndex } = parseMiCStringWithIndex(text, index);
    return { value, index: nextIndex };
  }
  if (ch === "{") {
    index += 1;
    const parsed = parseMiResults(text.slice(index));
    index += parsed.index;
    if (text[index] === "}") {
      index += 1;
    }
    return { value: parsed.results, index };
  }
  if (ch === "[") {
    index += 1;
    const items: any[] = [];
    while (index < text.length && text[index] !== "]") {
      if (text[index] === ",") {
        index += 1;
        continue;
      }
      const item = parseMiListItem(text, index);
      items.push(item.value);
      index = item.index;
      if (text[index] === ",") {
        index += 1;
      }
    }
    if (text[index] === "]") {
      index += 1;
    }
    return { value: items, index };
  }
  let raw = "";
  while (index < text.length && !",]".includes(text[index])) {
    raw += text[index];
    index += 1;
  }
  return { value: raw, index };
}

export function parseMiListItem(text: string, start: number): { value: any; index: number } {
  // If the item starts with { or ", parse as a direct value (tuple or string)
  const first = text[start];
  if (first === "{" || first === '"') {
    return parseMiValue(text, start);
  }
  let cursor = start;
  let inString = false;
  while (cursor < text.length) {
    const ch = text[cursor];
    if (ch === '"' && text[cursor - 1] !== "\\") {
      inString = !inString;
    }
    if (!inString && ch === "=") {
      const key = text.slice(start, cursor).trim();
      const parsed = parseMiValue(text, cursor + 1);
      const obj: any = {};
      obj[key] = parsed.value;
      return { value: obj, index: parsed.index };
    }
    if (!inString && (ch === "," || ch === "]")) {
      break;
    }
    cursor += 1;
  }
  const parsed = parseMiValue(text, start);
  return { value: parsed.value, index: parsed.index };
}

export function parseMiCString(text: string): string {
  const parsed = parseMiCStringWithIndex(text, 0);
  return parsed.value;
}

export function parseMiCStringWithIndex(text: string, start: number): { value: string; index: number } {
  let index = start;
  if (text[index] === '"') {
    index += 1;
  }
  let value = "";
  while (index < text.length) {
    const ch = text[index];
    if (ch === "\\" && index + 1 < text.length) {
      const next = text[index + 1];
      if (next === "n") {
        value += "\n";
      } else if (next === "t") {
        value += "\t";
      } else {
        value += next;
      }
      index += 2;
      continue;
    }
    if (ch === '"') {
      index += 1;
      break;
    }
    value += ch;
    index += 1;
  }
  return { value, index };
}

export function defaultRiscvRegisterNames(): string[] {
  return [
    "x0 (zero)",
    "x1 (ra)",
    "x2 (sp)",
    "x3 (gp)",
    "x4 (tp)",
    "x5 (t0)",
    "x6 (t1)",
    "x7 (t2)",
    "x8 (s0/fp)",
    "x9 (s1)",
    "x10 (a0)",
    "x11 (a1)",
    "x12 (a2)",
    "x13 (a3)",
    "x14 (a4)",
    "x15 (a5)",
    "x16 (a6)",
    "x17 (a7)",
    "x18 (s2)",
    "x19 (s3)",
    "x20 (s4)",
    "x21 (s5)",
    "x22 (s6)",
    "x23 (s7)",
    "x24 (s8)",
    "x25 (s9)",
    "x26 (s10)",
    "x27 (s11)",
    "x28 (t3)",
    "x29 (t4)",
    "x30 (t5)",
    "x31 (t6)",
  ];
}

export function parseUnixAddress(address: string): string | null {
  if (!address) {
    return null;
  }
  if (address.startsWith("unix://")) {
    return address.slice("unix://".length);
  }
  if (address.startsWith("unix:")) {
    return address.slice("unix:".length);
  }
  return null;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

export function buildShellCommand(args: string[]): string {
  return args.map(shellEscape).join(" ");
}
