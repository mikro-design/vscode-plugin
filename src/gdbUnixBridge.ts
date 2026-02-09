import * as net from "net";

const socketPath = process.argv[2];
if (!socketPath) {
  process.stderr.write("Missing unix socket path.\n");
  process.exit(1);
}

const socket = net.createConnection({ path: socketPath });
socket.on("error", (err: Error) => {
  process.stderr.write(`Bridge error: ${String(err)}\n`);
  process.exit(1);
});

process.stdin.resume();
process.stdin.pipe(socket);
socket.pipe(process.stdout);

process.stdin.on("end", () => socket.end());
socket.on("end", () => process.exit(0));
