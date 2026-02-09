import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";

function commandExists(cmd: string): boolean {
  if (path.isAbsolute(cmd)) {
    return fs.existsSync(cmd);
  }
  const pathVar = process.env.PATH ?? "";
  for (const part of pathVar.split(path.delimiter)) {
    if (!part) {
      continue;
    }
    const candidate = path.join(part, cmd);
    if (fs.existsSync(candidate)) {
      return true;
    }
  }
  return false;
}

function pickReadelf(toolchainBin?: string): string | null {
  if (toolchainBin) {
    const candidate = path.join(toolchainBin, "riscv32-unknown-elf-readelf");
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  if (commandExists("riscv32-unknown-elf-readelf")) {
    return "riscv32-unknown-elf-readelf";
  }
  if (commandExists("readelf")) {
    return "readelf";
  }
  return null;
}

export function deriveMemRegionsFromElf(elfPath: string, toolchainBin?: string): string[] {
  if (!elfPath || !fs.existsSync(elfPath)) {
    return [];
  }
  const readelf = pickReadelf(toolchainBin);
  if (!readelf) {
    return [];
  }
  const result = spawnSync(readelf, ["-l", elfPath], { encoding: "utf8" });
  if (result.status !== 0) {
    return [];
  }
  if (result.error && !result.stdout) {
    return [];
  }
  const stdout = result.stdout ? result.stdout.toString() : "";
  const regions: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("LOAD")) {
      continue;
    }
    const parts = trimmed.split(/\s+/);
    if (parts.length < 6) {
      continue;
    }
    const vaddr = parseInt(parts[2], 0);
    const memsz = parseInt(parts[5], 0);
    if (!Number.isFinite(vaddr) || !Number.isFinite(memsz) || memsz <= 0) {
      continue;
    }
    const flagTokens = parts.slice(6, parts.length - 1);
    const flags = flagTokens.length ? flagTokens.join("") : parts[6] ?? "";
    if (!flags.includes("W")) {
      continue;
    }
    if (flags.includes("E")) {
      continue;
    }
    regions.push(`0x${vaddr.toString(16)}:0x${memsz.toString(16)}`);
  }
  return regions;
}
