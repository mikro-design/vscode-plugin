import { XMLParser } from "fast-xml-parser";

export interface SvdEnumValue {
  name: string;
  value: number;
  description?: string;
}

export interface SvdField {
  name: string;
  lsb: number;
  msb: number;
  description?: string;
  enums: SvdEnumValue[];
}

export interface SvdRegister {
  name: string;
  path: string;
  address: number;
  sizeBits: number;
  access?: string;
  description?: string;
  resetValue?: number;
  fields: SvdField[];
  peripheral: string;
}

export interface SvdPeripheral {
  name: string;
  baseAddress: number;
  description?: string;
  registers: SvdRegister[];
}

export interface SvdDevice {
  name: string;
  peripherals: SvdPeripheral[];
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined || value === null) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function parseIntMaybe(value: unknown, fallback?: number): number | undefined {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value === "number") {
    return value;
  }
  const text = String(value).trim();
  if (!text) {
    return fallback;
  }
  const parsed = Number.parseInt(text, 0);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function expandDimIndices(text: unknown, count: number): string[] {
  if (!text) {
    return Array.from({ length: count }, (_, i) => String(i));
  }
  const tokens = String(text)
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  const items: string[] = [];
  for (const token of tokens) {
    if (token.includes("-")) {
      const [startRaw, endRaw] = token.split("-", 2);
      const start = startRaw.trim();
      const end = endRaw.trim();
      if (/^\d+$/.test(start) && /^\d+$/.test(end)) {
        const startVal = Number.parseInt(start, 10);
        const endVal = Number.parseInt(end, 10);
        for (let idx = startVal; idx <= endVal; idx += 1) {
          items.push(String(idx));
        }
      } else if (/^[a-zA-Z]$/.test(start) && /^[a-zA-Z]$/.test(end)) {
        const startCode = start.charCodeAt(0);
        const endCode = end.charCodeAt(0);
        for (let code = startCode; code <= endCode; code += 1) {
          items.push(String.fromCharCode(code));
        }
      } else {
        items.push(token);
      }
    } else {
      items.push(token);
    }
  }
  if (items.length < count) {
    for (let i = items.length; i < count; i += 1) {
      items.push(String(i));
    }
  }
  return items.slice(0, count);
}

function formatDimName(name: string, index: string): string {
  if (name.includes("%s")) {
    return name.replace(/%s/g, index);
  }
  if (name.includes("%d")) {
    return name.replace(/%d/g, index);
  }
  return `${name}${index}`;
}

function parseBitRange(field: any): { lsb: number; msb: number } | undefined {
  const bitOffset = parseIntMaybe(field.bitOffset);
  const bitWidth = parseIntMaybe(field.bitWidth);
  if (bitOffset !== undefined && bitWidth !== undefined) {
    return { lsb: bitOffset, msb: bitOffset + bitWidth - 1 };
  }
  const lsb = parseIntMaybe(field.lsb);
  const msb = parseIntMaybe(field.msb);
  if (lsb !== undefined && msb !== undefined) {
    return { lsb, msb };
  }
  const bitRange = field.bitRange ? String(field.bitRange) : "";
  const match = bitRange.match(/\[(\d+)\s*:\s*(\d+)\]/);
  if (match) {
    const high = Number.parseInt(match[1], 10);
    const low = Number.parseInt(match[2], 10);
    return { lsb: low, msb: high };
  }
  return undefined;
}

function parseFields(fieldsNode: any): SvdField[] {
  const fields = asArray(fieldsNode?.field);
  return fields
    .map((field) => {
      const range = parseBitRange(field);
      if (!range) {
        return undefined;
      }
      const enumsRaw = asArray(field.enumeratedValues?.enumeratedValue);
      const enums: SvdEnumValue[] = enumsRaw
        .map((entry) => {
          const value = parseIntMaybe(entry.value);
          if (value === undefined) {
            return null;
          }
          const name = String(entry.name ?? "");
          if (!name) {
            return null;
          }
          const out: SvdEnumValue = { name, value };
          if (entry.description) {
            out.description = String(entry.description);
          }
          return out;
        })
        .filter((entry): entry is SvdEnumValue => entry !== null);

      return {
        name: String(field.name ?? ""),
        lsb: range.lsb,
        msb: range.msb,
        description: field.description ? String(field.description) : undefined,
        enums,
      } as SvdField;
    })
    .filter((field): field is SvdField => !!field && field.name.length > 0);
}

function parseRegister(
  regNode: any,
  baseAddress: number,
  prefix: string[],
  defaults: { sizeBits: number; access?: string; resetValue?: number },
  peripheralName: string
): SvdRegister[] {
  const nameRaw = String(regNode.name ?? "REG");
  const dim = parseIntMaybe(regNode.dim, 1) ?? 1;
  const dimIncrement = parseIntMaybe(regNode.dimIncrement, 0) ?? 0;
  const dimIndex = expandDimIndices(regNode.dimIndex, dim);
  const sizeBits = parseIntMaybe(regNode.size, defaults.sizeBits) ?? defaults.sizeBits;
  const access = regNode.access ? String(regNode.access) : defaults.access;
  const resetValue = parseIntMaybe(regNode.resetValue, defaults.resetValue);
  const addressOffset = parseIntMaybe(regNode.addressOffset, 0) ?? 0;
  const description = regNode.description ? String(regNode.description) : undefined;
  const fields = parseFields(regNode.fields);

  const registers: SvdRegister[] = [];
  for (let i = 0; i < dim; i += 1) {
    const indexLabel = dimIndex[i] ?? String(i);
    const name = dim > 1 ? formatDimName(nameRaw, indexLabel) : nameRaw;
    const offset = addressOffset + i * dimIncrement;
    const path = [...prefix, name].join(".");
    registers.push({
      name,
      path,
      address: baseAddress + offset,
      sizeBits,
      access,
      description,
      resetValue,
      fields,
      peripheral: peripheralName,
    });
  }
  return registers;
}

function parseRegisters(
  regsNode: any,
  baseAddress: number,
  prefix: string[],
  defaults: { sizeBits: number; access?: string; resetValue?: number },
  peripheralName: string
): SvdRegister[] {
  const registers: SvdRegister[] = [];
  for (const reg of asArray(regsNode?.register)) {
    registers.push(...parseRegister(reg, baseAddress, prefix, defaults, peripheralName));
  }
  for (const cluster of asArray(regsNode?.cluster)) {
    const clusterNameRaw = String(cluster.name ?? "CLUSTER");
    const clusterDim = parseIntMaybe(cluster.dim, 1) ?? 1;
    const clusterInc = parseIntMaybe(cluster.dimIncrement, 0) ?? 0;
    const clusterIdx = expandDimIndices(cluster.dimIndex, clusterDim);
    const clusterOffset = parseIntMaybe(cluster.addressOffset, 0) ?? 0;
    for (let i = 0; i < clusterDim; i += 1) {
      const idxLabel = clusterIdx[i] ?? String(i);
      const clusterName = clusterDim > 1 ? formatDimName(clusterNameRaw, idxLabel) : clusterNameRaw;
      const clusterBase = baseAddress + clusterOffset + i * clusterInc;
      registers.push(
        ...parseRegisters(
          cluster,
          clusterBase,
          [...prefix, clusterName],
          defaults,
          peripheralName
        )
      );
    }
  }
  return registers;
}

export function parseSvd(xmlText: string): SvdDevice {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "",
    parseTagValue: false,
    trimValues: true,
  });
  const root = parser.parse(xmlText);
  const deviceNode = root.device ?? root;
  const deviceName = deviceNode.name ? String(deviceNode.name) : "Device";
  const peripheralsNode = deviceNode.peripherals ?? {};
  const peripherals = asArray(peripheralsNode.peripheral)
    .map((periph) => {
      const name = String(periph.name ?? "PERIPH");
      const baseAddress = parseIntMaybe(periph.baseAddress, 0) ?? 0;
      const description = periph.description ? String(periph.description) : undefined;
      const defaults = {
        sizeBits: parseIntMaybe(periph.size, 32) ?? 32,
        access: periph.access ? String(periph.access) : undefined,
        resetValue: parseIntMaybe(periph.resetValue),
      };
      const registers = parseRegisters(periph.registers ?? {}, baseAddress, [name], defaults, name);
      return {
        name,
        baseAddress,
        description,
        registers,
      } as SvdPeripheral;
    })
    .filter((periph) => periph.registers.length > 0 || periph.name.length > 0);

  return {
    name: deviceName,
    peripherals,
  };
}
