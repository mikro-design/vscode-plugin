import * as vscode from "vscode";
import { parseSvd, SvdDevice, SvdEnumValue, SvdField, SvdPeripheral, SvdRegister } from "./svd";
import * as fs from "fs";
import * as path from "path";
import { getWorkspaceRoot } from "./utils";

interface RegisterValue {
  value: bigint;
  sizeBits: number;
  readAt: number;
  error?: string;
}

function formatHex(value: bigint, sizeBits: number): string {
  const width = Math.max(1, Math.ceil(sizeBits / 4));
  let text = value.toString(16);
  if (text.length < width) {
    text = text.padStart(width, "0");
  }
  return `0x${text}`;
}

function bytesToBigIntLE(bytes: Uint8Array): bigint {
  let value = 0n;
  for (let i = 0; i < bytes.length; i += 1) {
    value |= BigInt(bytes[i]) << (8n * BigInt(i));
  }
  return value;
}

function fieldWidthBits(field: SvdField): number {
  return Math.max(1, field.msb - field.lsb + 1);
}

function extractFieldValue(regValue: bigint, field: SvdField): bigint {
  const width = fieldWidthBits(field);
  const mask = (1n << BigInt(width)) - 1n;
  return (regValue >> BigInt(field.lsb)) & mask;
}

function matchEnum(field: SvdField, value: bigint): SvdEnumValue | undefined {
  for (const entry of field.enums) {
    if (BigInt(entry.value) === value) {
      return entry;
    }
  }
  return undefined;
}

function appendSvdDebugLog(message: string): void {
  if (process.env.MIKRO_DEBUG_EXTENSIONS !== "1") {
    return;
  }
  const root = getWorkspaceRoot() ?? process.cwd();
  const logPath = path.join(root, ".mikro-debug.log");
  try {
    fs.appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`);
  } catch {
    // ignore
  }
}

function nodeId(node: TreeNode): string | undefined {
  switch (node.kind) {
    case "device":
      return node.device?.name ? `device:${node.device.name}` : "device:unknown";
    case "peripheral": {
      const name = node.peripheral?.name ?? "unknown";
      const base = node.peripheral?.baseAddress ?? 0;
      return `peripheral:${name}:${base.toString(16)}`;
    }
    case "register": {
      const reg = node.register;
      if (!reg) {
        return undefined;
      }
      return `register:${reg.path}:${reg.address.toString(16)}`;
    }
    case "field": {
      const field = node.field;
      const reg = node.register;
      if (!field) {
        return undefined;
      }
      const regId = reg ? reg.path : "unknown";
      return `field:${regId}:${field.name}:${field.lsb}:${field.msb}`;
    }
    default:
      return undefined;
  }
}

interface TreeNode {
  kind: "device" | "peripheral" | "register" | "field";
  device?: SvdDevice;
  peripheral?: SvdPeripheral;
  register?: SvdRegister;
  field?: SvdField;
}

export class SvdTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private device: SvdDevice | undefined;
  private rootNode: TreeNode | undefined;
  private activeAddress: number | null = null;
  private memoryReader: ((address: number, size: number) => Promise<Uint8Array>) | null = null;
  private registerValues = new Map<number, RegisterValue>();
  private pendingReads = new Set<number>();
  private visibleRegisters = new Map<number, SvdRegister>();
  private sessionToken = 0;
  private activeSessionId: string | null = null;
  private loggedChildren = new Set<string>();

  constructor(private readonly output: vscode.OutputChannel) {}

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  clear(): void {
    this.device = undefined;
    this.rootNode = undefined;
    this.pendingReads.clear();
    this.registerValues.clear();
    this.visibleRegisters.clear();
    this.refresh();
  }

  findRegisterByAddress(address: number): SvdRegister | undefined {
    if (!this.device) {
      return undefined;
    }
    for (const peripheral of this.device.peripherals) {
      for (const register of peripheral.registers) {
        const sizeBytes = Math.max(1, Math.ceil(register.sizeBits / 8));
        if (address >= register.address && address < register.address + sizeBytes) {
          return register;
        }
      }
    }
    return undefined;
  }

  setActiveAddress(addr: number | null): void {
    this.activeAddress = addr;
    this.refresh();
  }

  setDebugSession(session: vscode.DebugSession | null): void {
    const nextSession = session && session.type === "mikroDesign" ? session : null;
    const nextId = nextSession?.id ?? null;
    if (nextId === this.activeSessionId) {
      return;
    }
    this.activeSessionId = nextId;
    this.sessionToken += 1;
    this.pendingReads.clear();
    this.registerValues.clear();
    if (nextSession) {
      this.memoryReader = async (address: number, size: number) => {
        const response = await nextSession.customRequest("readMemory", {
          memoryReference: `0x${address.toString(16)}`,
          offset: 0,
          count: size,
        });
        const data = typeof response?.data === "string" ? response.data : "";
        const buffer = Buffer.from(data, "base64");
        const bytes = Uint8Array.from(buffer);
        if (bytes.length === size) {
          return bytes;
        }
        if (bytes.length > size) {
          return bytes.slice(0, size);
        }
        const padded = new Uint8Array(size);
        padded.set(bytes);
        return padded;
      };
    } else {
      this.memoryReader = null;
    }
    this.refresh();
    this.refreshValues(true);
  }

  refreshValues(force = false): void {
    // Limit refresh to prevent excessive memory usage
    const MAX_CONCURRENT_READS = 50;
    const registers = Array.from(this.visibleRegisters.values()).slice(0, MAX_CONCURRENT_READS);
    for (const reg of registers) {
      this.requestRegisterRead(reg, force);
    }
  }

  loadFromFile(path: string): void {
    try {
      const content = fs.readFileSync(path, "utf8");
      this.device = parseSvd(content);
      this.rootNode = this.device ? { kind: "device", device: this.device } : undefined;
      this.output.appendLine(`[SVD] Loaded ${path}`);
      appendSvdDebugLog(
        `[SVD] Loaded ${path} device=${this.device.name} peripherals=${this.device.peripherals.length}`
      );
      if (this.device.peripherals.length) {
        const names = this.device.peripherals.map((p) => p.name).join(", ");
        appendSvdDebugLog(`[SVD] Peripherals: ${names}`);
      }
      this.registerValues.clear();
      this.pendingReads.clear();
      this.visibleRegisters.clear();
    } catch (err) {
      this.output.appendLine(`[SVD] Failed to load ${path}: ${String(err)}`);
      appendSvdDebugLog(`[SVD] Failed to load ${path}: ${String(err)}`);
      this.device = undefined;
      this.rootNode = undefined;
      this.registerValues.clear();
      this.pendingReads.clear();
      this.visibleRegisters.clear();
    }
    this.refresh();
  }

  getRootNode(): TreeNode | undefined {
    return this.rootNode;
  }

  private requestRegisterRead(reg: SvdRegister, force: boolean): void {
    const reader = this.memoryReader;
    if (!reader) {
      return;
    }
    const existing = this.registerValues.get(reg.address);
    const now = Date.now();
    if (!force && existing && now - existing.readAt < 250) {
      return;
    }
    if (this.pendingReads.has(reg.address)) {
      return;
    }
    const sizeBytes = Math.max(1, Math.ceil(reg.sizeBits / 8));
    const token = this.sessionToken;
    this.pendingReads.add(reg.address);
    void reader(reg.address, sizeBytes)
      .then((bytes) => {
        if (token !== this.sessionToken) {
          return;
        }
        const value = bytesToBigIntLE(bytes);
        this.registerValues.set(reg.address, {
          value,
          sizeBits: reg.sizeBits,
          readAt: Date.now(),
        });
      })
      .catch((err) => {
        if (token !== this.sessionToken) {
          return;
        }
        this.registerValues.set(reg.address, {
          value: 0n,
          sizeBits: reg.sizeBits,
          readAt: Date.now(),
          error: String(err),
        });
      })
      .finally(() => {
        this.pendingReads.delete(reg.address);
        this.refresh();
      });
  }

  private touchRegister(reg: SvdRegister): void {
    // Limit visible registers to prevent unbounded growth
    const MAX_VISIBLE_REGISTERS = 200;
    if (this.visibleRegisters.size >= MAX_VISIBLE_REGISTERS && !this.visibleRegisters.has(reg.address)) {
      // Remove oldest entries (FIFO)
      const firstKey = this.visibleRegisters.keys().next().value;
      if (firstKey !== undefined) {
        this.visibleRegisters.delete(firstKey);
      }
    }
    this.visibleRegisters.set(reg.address, reg);
    this.requestRegisterRead(reg, false);
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    switch (node.kind) {
      case "device": {
        const expandDevice = process.env.MIKRO_DEBUG_EXTENSIONS === "1";
        const item = new vscode.TreeItem(
          node.device?.name ?? "Device",
          expandDevice ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed
        );
        item.id = nodeId(node);
        item.contextValue = "device";
        return item;
      }
      case "peripheral": {
        const periph = node.peripheral!;
        const item = new vscode.TreeItem(
          periph.name,
          vscode.TreeItemCollapsibleState.Collapsed
        );
        item.id = nodeId(node);
        item.description = `0x${periph.baseAddress.toString(16)}`;
        if (periph.description) {
          item.tooltip = periph.description;
        }
        item.contextValue = "peripheral";
        return item;
      }
      case "register": {
        const reg = node.register!;
        this.touchRegister(reg);
        const expandRegisters = process.env.MIKRO_DEBUG_EXTENSIONS === "1";
        const collapsibleState = reg.fields.length
          ? (expandRegisters ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed)
          : vscode.TreeItemCollapsibleState.None;
        const item = new vscode.TreeItem(reg.name, collapsibleState);
        item.id = nodeId(node);
        const addressText = `0x${reg.address.toString(16)}`;
        const accessText = reg.access ? ` ${reg.access}` : "";
        const active = this.activeAddress !== null && this.activeAddress >= reg.address &&
          this.activeAddress < reg.address + Math.max(1, Math.ceil(reg.sizeBits / 8));
        const valueInfo = this.registerValues.get(reg.address);
        const hasReader = !!this.memoryReader;
        const liveValue = valueInfo && !valueInfo.error ? valueInfo.value : undefined;
        const fallbackValue = reg.resetValue !== undefined ? BigInt(reg.resetValue) : undefined;
        const displayValue = liveValue ?? fallbackValue;
        const valueText = liveValue !== undefined ? formatHex(liveValue, reg.sizeBits) : undefined;
        const resetText = reg.resetValue !== undefined ? formatHex(BigInt(reg.resetValue), reg.sizeBits) : undefined;
        let description = `${addressText}${accessText}`;
        if (hasReader) {
          if (displayValue !== undefined) {
            description += ` = ${formatHex(displayValue, reg.sizeBits)}`;
          } else if (valueInfo) {
            description += valueInfo.error ? " = ??" : ` = ${valueText}`;
          } else {
            description += " = --";
          }
        }
        if (resetText) {
          description += ` (reset ${resetText})`;
        }
        if (active) {
          description += " active";
        }
        item.description = description;
        const tooltipLines = [reg.path];
        if (reg.description) {
          tooltipLines.push(reg.description);
        }
        tooltipLines.push(`Address: ${addressText}`);
        if (reg.access) {
          tooltipLines.push(`Access: ${reg.access}`);
        }
        if (hasReader) {
          if (liveValue !== undefined) {
            tooltipLines.push(`Value: ${valueText}`);
          } else if (valueInfo?.error) {
            tooltipLines.push(`Value: ${valueInfo.error}`);
          }
          if (liveValue === undefined && fallbackValue !== undefined) {
            tooltipLines.push(`Display: ${formatHex(fallbackValue, reg.sizeBits)} (reset)`);
          }
        }
        if (resetText) {
          tooltipLines.push(`Reset: ${resetText}`);
        }
        item.tooltip = tooltipLines.join("\n");
        item.contextValue = "register";
        return item;
      }
      case "field": {
        const field = node.field!;
        const reg = node.register;
        if (reg) {
          this.touchRegister(reg);
        }
        const item = new vscode.TreeItem(field.name, vscode.TreeItemCollapsibleState.None);
        item.id = nodeId(node);
        const range = field.msb === field.lsb ? `[${field.lsb}]` : `[${field.msb}:${field.lsb}]`;
        const valueInfo = reg ? this.registerValues.get(reg.address) : undefined;
        const liveValue = valueInfo && !valueInfo.error ? valueInfo.value : undefined;
        const fallbackValue = reg?.resetValue !== undefined ? BigInt(reg.resetValue) : undefined;
        const displayValue = liveValue ?? fallbackValue;
        const width = fieldWidthBits(field);
        let description = range;
        let valueLine: string | null = null;
        const tooltipLines: string[] = [];
        if (field.description) {
          tooltipLines.push(field.description);
        }
        tooltipLines.push(`Bits: ${range}`);
        if (displayValue !== undefined) {
          const fieldValue = extractFieldValue(displayValue, field);
          const fieldText = formatHex(fieldValue, width);
          const enumMatch = matchEnum(field, fieldValue);
          description += ` = ${fieldText}`;
          if (enumMatch) {
            description += ` (${enumMatch.name})`;
          }
          valueLine = `Value: ${fieldText}`;
          if (enumMatch) {
            valueLine += ` (${enumMatch.name})`;
          }
          tooltipLines.push(valueLine);
          if (enumMatch?.description) {
            tooltipLines.push(enumMatch.description);
          }
          if (liveValue === undefined && fallbackValue !== undefined) {
            tooltipLines.push(`Display: ${formatHex(fieldValue, width)} (reset)`);
          }
        } else if (this.memoryReader) {
          description += " = --";
        }
        if (reg?.resetValue !== undefined) {
          const resetField = extractFieldValue(BigInt(reg.resetValue), field);
          tooltipLines.push(`Reset: ${formatHex(resetField, width)}`);
        }
        item.description = description;
        if (tooltipLines.length) {
          item.tooltip = tooltipLines.join("\n");
        }
        item.contextValue = "field";
        return item;
      }
      default:
        return new vscode.TreeItem("Unknown", vscode.TreeItemCollapsibleState.None);
    }
  }

  getChildren(node?: TreeNode): TreeNode[] {
    if (!this.device) {
      return [];
    }
    if (!node) {
      this.logChildren("root", this.device.peripherals.length);
      return this.rootNode ? [this.rootNode] : [{ kind: "device", device: this.device }];
    }
    if (node.kind === "device") {
      this.logChildren(`device:${node.device?.name ?? this.device.name}`, this.device.peripherals.length);
      return this.device.peripherals.map((peripheral) => ({ kind: "peripheral", peripheral }));
    }
    if (node.kind === "peripheral") {
      this.logChildren(
        `peripheral:${node.peripheral?.name ?? "unknown"}`,
        node.peripheral?.registers.length ?? 0
      );
      return node.peripheral!.registers.map((register) => ({ kind: "register", register }));
    }
    if (node.kind === "register") {
      this.logChildren(
        `register:${node.register?.name ?? "unknown"}`,
        node.register?.fields.length ?? 0
      );
      return node.register!.fields.map((field) => ({ kind: "field", field, register: node.register }));
    }
    return [];
  }

  getParent(node: TreeNode): TreeNode | undefined {
    if (!this.device) {
      return undefined;
    }
    if (node.kind === "peripheral" && node.peripheral) {
      return this.rootNode ?? { kind: "device", device: this.device };
    }
    if (node.kind === "register" && node.register) {
      const periphName = node.register.peripheral;
      if (periphName) {
        const periph = this.device.peripherals.find((p) => p.name === periphName);
        if (periph) {
          return { kind: "peripheral", peripheral: periph };
        }
      }
      for (const periph of this.device.peripherals) {
        if (periph.registers.some((reg) => reg.name === node.register?.name)) {
          return { kind: "peripheral", peripheral: periph };
        }
      }
      return undefined;
  }
    if (node.kind === "field" && node.register) {
      return { kind: "register", register: node.register };
    }
    return undefined;
  }

  private logChildren(key: string, count: number): void {
    if (process.env.MIKRO_DEBUG_EXTENSIONS !== "1") {
      return;
    }
    if (this.loggedChildren.has(key)) {
      return;
    }
    this.loggedChildren.add(key);
    appendSvdDebugLog(`[SVD] getChildren ${key} -> ${count}`);
  }
}
