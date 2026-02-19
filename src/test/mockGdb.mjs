#!/usr/bin/env node
// Mock GDB process for debugSession.test.ts.
// Relays MI commands from stdin to a MockGdbServer over TCP.
// Env: MOCK_GDB_PORT — TCP port of the MockGdbServer.

import { createConnection } from "node:net";
import { createInterface } from "node:readline";

const port = parseInt(process.env.MOCK_GDB_PORT || "0", 10);
if (!port) {
  process.stderr.write("MOCK_GDB_PORT env not set\n");
  process.exit(1);
}

// Emit GDB MI greeting immediately (before socket connects).
process.stdout.write('=thread-group-added,id="i1"\n(gdb)\n');

const socket = createConnection(port, "127.0.0.1");
let connected = false;
const pendingLines = [];

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  // Handle -gdb-exit (with optional token prefix)
  if (/^\d*-gdb-exit$/.test(trimmed)) {
    socket.end();
    process.exit(0);
  }
  if (connected) {
    socket.write(trimmed + "\n");
  } else {
    pendingLines.push(trimmed);
  }
});

rl.on("close", () => {
  socket.end();
  setTimeout(() => process.exit(0), 100);
});

socket.on("connect", () => {
  connected = true;
  for (const line of pendingLines) {
    socket.write(line + "\n");
  }
  pendingLines.length = 0;
});

let buffer = "";
socket.on("data", (chunk) => {
  buffer += chunk.toString();
  let idx;
  while ((idx = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    process.stdout.write(line + "\n");
  }
});

socket.on("error", () => process.exit(1));
socket.on("close", () => process.exit(0));
