import { ChildProcess, spawn } from "child_process";
import * as net from "net";
import { Rv32SimController } from "./rv32simController";

export type GdbServerType = "rv32sim" | "openocd" | "jlink" | "pyocd" | "external";

export interface GdbServerCapabilities {
  supportsHardwareBreakpoints: boolean;
  supportsWatchpoints: boolean;
  supportsMultiThread: boolean;
  hwBreakpointLimit: number;
  supportsLiveMemoryRead: boolean;
}

export interface GdbServerStartResult {
  serverAddress: string;
  process: ChildProcess | null;
  capabilities: GdbServerCapabilities;
}

export interface IGdbServer {
  readonly type: GdbServerType;
  start(): Promise<GdbServerStartResult>;
  stop(): Promise<void>;
  getPostConnectCommands(): string[];
  getLoadCommand(elfPath: string): string;
}

export interface GdbServerConfig {
  serverPath?: string;
  serverArgs?: string[];
  configFiles?: string[];
  device?: string;
  interface?: "swd" | "jtag";
  port?: number;
  hwBreakpointLimit?: number;
}

const DEFAULT_CAPABILITIES: GdbServerCapabilities = {
  supportsHardwareBreakpoints: false,
  supportsWatchpoints: false,
  supportsMultiThread: false,
  hwBreakpointLimit: 0,
  supportsLiveMemoryRead: false,
};

class Rv32SimGdbServer implements IGdbServer {
  readonly type: GdbServerType = "rv32sim";

  constructor(
    private readonly controller: Rv32SimController,
    private readonly address: string
  ) {}

  async start(): Promise<GdbServerStartResult> {
    return {
      serverAddress: this.address,
      process: null,
      capabilities: { ...DEFAULT_CAPABILITIES },
    };
  }

  async stop(): Promise<void> {
    // Controller lifecycle managed elsewhere
  }

  getPostConnectCommands(): string[] {
    return [];
  }

  getLoadCommand(elfPath: string): string {
    return `monitor load_elf ${elfPath}`;
  }
}

class OpenOcdGdbServer implements IGdbServer {
  readonly type: GdbServerType = "openocd";
  private process: ChildProcess | null = null;

  constructor(private readonly config: GdbServerConfig) {}

  async start(): Promise<GdbServerStartResult> {
    const port = this.config.port ?? 3333;
    const args: string[] = [];
    for (const file of this.config.configFiles ?? []) {
      args.push("-f", file);
    }
    args.push(...(this.config.serverArgs ?? []));
    const serverPath = this.config.serverPath ?? "openocd";
    this.process = spawn(serverPath, args, { stdio: ["pipe", "pipe", "pipe"] });

    try {
      await waitForPort(port, 10000);
    } catch (err) {
      await this.stop();
      throw err;
    }

    return {
      serverAddress: `localhost:${port}`,
      process: this.process,
      capabilities: {
        supportsHardwareBreakpoints: true,
        supportsWatchpoints: true,
        supportsMultiThread: true,
        hwBreakpointLimit: this.config.hwBreakpointLimit ?? 0,
        supportsLiveMemoryRead: true,
      },
    };
  }

  async stop(): Promise<void> {
    if (this.process) {
      this.process.kill("SIGTERM");
      this.process = null;
    }
  }

  getPostConnectCommands(): string[] {
    return ["monitor reset halt"];
  }

  getLoadCommand(_elfPath: string): string {
    return "load";
  }
}

class JLinkGdbServer implements IGdbServer {
  readonly type: GdbServerType = "jlink";
  private process: ChildProcess | null = null;

  constructor(private readonly config: GdbServerConfig) {}

  async start(): Promise<GdbServerStartResult> {
    const port = this.config.port ?? 2331;
    const serverPath = this.config.serverPath ?? "JLinkGDBServerCLExe";
    const args: string[] = [];
    if (this.config.device) {
      args.push("-device", this.config.device);
    }
    if (this.config.interface) {
      args.push("-if", this.config.interface.toUpperCase());
    }
    args.push("-port", String(port));
    args.push(...(this.config.serverArgs ?? []));
    this.process = spawn(serverPath, args, { stdio: ["pipe", "pipe", "pipe"] });

    try {
      await waitForPort(port, 15000);
    } catch (err) {
      await this.stop();
      throw err;
    }

    return {
      serverAddress: `localhost:${port}`,
      process: this.process,
      capabilities: {
        supportsHardwareBreakpoints: true,
        supportsWatchpoints: true,
        supportsMultiThread: true,
        hwBreakpointLimit: this.config.hwBreakpointLimit ?? 0,
        supportsLiveMemoryRead: true,
      },
    };
  }

  async stop(): Promise<void> {
    if (this.process) {
      this.process.kill("SIGTERM");
      this.process = null;
    }
  }

  getPostConnectCommands(): string[] {
    return ["monitor reset", "monitor halt"];
  }

  getLoadCommand(_elfPath: string): string {
    return "load";
  }
}

class PyOcdGdbServer implements IGdbServer {
  readonly type: GdbServerType = "pyocd";
  private process: ChildProcess | null = null;

  constructor(private readonly config: GdbServerConfig) {}

  async start(): Promise<GdbServerStartResult> {
    const port = this.config.port ?? 3333;
    const serverPath = this.config.serverPath ?? "pyocd";
    const args: string[] = ["gdbserver"];
    if (this.config.device) {
      args.push("-t", this.config.device);
    }
    args.push("-p", String(port));
    args.push(...(this.config.serverArgs ?? []));
    this.process = spawn(serverPath, args, { stdio: ["pipe", "pipe", "pipe"] });

    try {
      await waitForPort(port, 10000);
    } catch (err) {
      await this.stop();
      throw err;
    }

    return {
      serverAddress: `localhost:${port}`,
      process: this.process,
      capabilities: {
        supportsHardwareBreakpoints: true,
        supportsWatchpoints: true,
        supportsMultiThread: true,
        hwBreakpointLimit: this.config.hwBreakpointLimit ?? 0,
        supportsLiveMemoryRead: true,
      },
    };
  }

  async stop(): Promise<void> {
    if (this.process) {
      this.process.kill("SIGTERM");
      this.process = null;
    }
  }

  getPostConnectCommands(): string[] {
    return ["monitor reset halt"];
  }

  getLoadCommand(_elfPath: string): string {
    return "load";
  }
}

class ExternalGdbServer implements IGdbServer {
  readonly type: GdbServerType = "external";

  constructor(private readonly config: GdbServerConfig) {}

  async start(): Promise<GdbServerStartResult> {
    const port = this.config.port ?? 3333;
    return {
      serverAddress: `localhost:${port}`,
      process: null,
      capabilities: {
        supportsHardwareBreakpoints: this.config.hwBreakpointLimit !== undefined && this.config.hwBreakpointLimit > 0,
        supportsWatchpoints: false,
        supportsMultiThread: false,
        hwBreakpointLimit: this.config.hwBreakpointLimit ?? 0,
        supportsLiveMemoryRead: false,
      },
    };
  }

  async stop(): Promise<void> {
    // No process to manage
  }

  getPostConnectCommands(): string[] {
    return [];
  }

  getLoadCommand(_elfPath: string): string {
    return "load";
  }
}

export function createGdbServer(
  type: GdbServerType,
  config: GdbServerConfig,
  controller?: Rv32SimController,
  address?: string
): IGdbServer {
  switch (type) {
    case "rv32sim":
      return new Rv32SimGdbServer(controller!, address ?? `localhost:${config.port ?? 3333}`);
    case "openocd":
      return new OpenOcdGdbServer(config);
    case "jlink":
      return new JLinkGdbServer(config);
    case "pyocd":
      return new PyOcdGdbServer(config);
    case "external":
      return new ExternalGdbServer(config);
  }
}

function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    let resolved = false;
    const tryConnect = () => {
      if (resolved) {
        return;
      }
      const socket = new net.Socket();
      socket.setTimeout(500);
      socket.once("connect", () => {
        if (!resolved) {
          resolved = true;
          socket.destroy();
          resolve();
        }
      });
      socket.once("timeout", () => {
        socket.destroy();
        if (!resolved) {
          retry();
        }
      });
      socket.once("error", () => {
        socket.destroy();
        if (!resolved) {
          retry();
        }
      });
      socket.connect(port, "127.0.0.1");
    };
    const retry = () => {
      if (resolved) {
        return;
      }
      if (Date.now() >= deadline) {
        if (!resolved) {
          resolved = true;
          reject(new Error(`Port ${port} did not open within ${timeoutMs}ms`));
        }
        return;
      }
      setTimeout(tryConnect, 250);
    };
    tryConnect();
  });
}
