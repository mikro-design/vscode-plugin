import { describe, it, expect } from "vitest";
import {
  createGdbServer,
  type GdbServerType,
  type GdbServerConfig,
} from "../gdbServer";

// rv32sim server requires a controller — we pass a minimal stub
function stubController(): any {
  return {
    currentPrompt: null,
    isRunning: false,
    onPromptChanged: () => ({ dispose: () => {} }),
    onAssertResponse: () => ({ dispose: () => {} }),
  };
}

describe("createGdbServer", () => {
  it("creates rv32sim server", () => {
    const server = createGdbServer("rv32sim", {}, stubController(), "localhost:3333");
    expect(server.type).toBe("rv32sim");
  });

  it("creates openocd server", () => {
    const server = createGdbServer("openocd", {});
    expect(server.type).toBe("openocd");
  });

  it("creates jlink server", () => {
    const server = createGdbServer("jlink", {});
    expect(server.type).toBe("jlink");
  });

  it("creates pyocd server", () => {
    const server = createGdbServer("pyocd", {});
    expect(server.type).toBe("pyocd");
  });

  it("creates external server", () => {
    const server = createGdbServer("external", {});
    expect(server.type).toBe("external");
  });
});

describe("rv32sim server", () => {
  it("returns empty post-connect commands", () => {
    const server = createGdbServer("rv32sim", {}, stubController(), "localhost:4444");
    expect(server.getPostConnectCommands()).toEqual([]);
  });

  it("uses monitor load_elf for load command", () => {
    const server = createGdbServer("rv32sim", {}, stubController(), "localhost:4444");
    expect(server.getLoadCommand("/path/to/app.elf")).toBe("monitor load_elf /path/to/app.elf");
  });

  it("start returns provided address and no process", async () => {
    const server = createGdbServer("rv32sim", {}, stubController(), "host:9999");
    const result = await server.start();
    expect(result.serverAddress).toBe("host:9999");
    expect(result.process).toBeNull();
    expect(result.capabilities.supportsHardwareBreakpoints).toBe(false);
    expect(result.capabilities.supportsLiveMemoryRead).toBe(false);
  });
});

describe("openocd server", () => {
  it("returns 'monitor reset halt' for post-connect", () => {
    const server = createGdbServer("openocd", {});
    expect(server.getPostConnectCommands()).toEqual(["monitor reset halt"]);
  });

  it("returns 'load' for load command", () => {
    const server = createGdbServer("openocd", {});
    expect(server.getLoadCommand("/app.elf")).toBe("load");
  });
});

describe("jlink server", () => {
  it("returns 'monitor reset' and 'monitor halt' for post-connect", () => {
    const server = createGdbServer("jlink", {});
    expect(server.getPostConnectCommands()).toEqual(["monitor reset", "monitor halt"]);
  });

  it("returns 'load' for load command", () => {
    const server = createGdbServer("jlink", {});
    expect(server.getLoadCommand("/app.elf")).toBe("load");
  });
});

describe("pyocd server", () => {
  it("returns 'monitor reset halt' for post-connect", () => {
    const server = createGdbServer("pyocd", {});
    expect(server.getPostConnectCommands()).toEqual(["monitor reset halt"]);
  });
});

describe("external server", () => {
  it("returns empty post-connect commands", () => {
    const server = createGdbServer("external", {});
    expect(server.getPostConnectCommands()).toEqual([]);
  });

  it("returns 'load' for load command", () => {
    const server = createGdbServer("external", {});
    expect(server.getLoadCommand("/any.elf")).toBe("load");
  });

  it("start returns default port and no hw breakpoints by default", async () => {
    const server = createGdbServer("external", {});
    const result = await server.start();
    expect(result.serverAddress).toBe("localhost:3333");
    expect(result.process).toBeNull();
    expect(result.capabilities.supportsHardwareBreakpoints).toBe(false);
    expect(result.capabilities.hwBreakpointLimit).toBe(0);
  });

  it("enables hw breakpoints when limit is set", async () => {
    const server = createGdbServer("external", { hwBreakpointLimit: 4 });
    const result = await server.start();
    expect(result.capabilities.supportsHardwareBreakpoints).toBe(true);
    expect(result.capabilities.hwBreakpointLimit).toBe(4);
  });

  it("uses custom port", async () => {
    const server = createGdbServer("external", { port: 5555 });
    const result = await server.start();
    expect(result.serverAddress).toBe("localhost:5555");
  });
});
