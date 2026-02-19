import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { scanAppConfig, listApps } from "../sdkBuild";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sdk-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("scanAppConfig", () => {
  it("returns empty configs for empty directory", () => {
    const appDir = path.join(tmpDir, "app1");
    fs.mkdirSync(appDir);
    const result = scanAppConfig(appDir);
    expect(result.configs).toEqual([]);
    expect(result.defaultConfig).toBeUndefined();
    expect(result.defaultToolchain).toBeUndefined();
  });

  it("finds config-*.mk files", () => {
    const appDir = path.join(tmpDir, "app2");
    fs.mkdirSync(appDir);
    fs.writeFileSync(path.join(appDir, "config-debug.mk"), "# debug config\n");
    fs.writeFileSync(path.join(appDir, "config-release.mk"), "# release config\n");
    fs.writeFileSync(path.join(appDir, "Makefile"), "# no defaults\n");

    const result = scanAppConfig(appDir);
    expect(result.configs).toEqual(["debug", "release"]);
  });

  it("reads DEFAULT_CONFIG from Makefile", () => {
    const appDir = path.join(tmpDir, "app3");
    fs.mkdirSync(appDir);
    fs.writeFileSync(
      path.join(appDir, "Makefile"),
      "DEFAULT_CONFIG = release\nDEFAULT_TOOLCHAIN = GNU\n"
    );

    const result = scanAppConfig(appDir);
    expect(result.defaultConfig).toBe("release");
    expect(result.defaultToolchain).toBe("GNU");
  });

  it("handles ?= assignment in Makefile", () => {
    const appDir = path.join(tmpDir, "app4");
    fs.mkdirSync(appDir);
    fs.writeFileSync(
      path.join(appDir, "Makefile"),
      "DEFAULT_CONFIG ?= debug\n"
    );

    const result = scanAppConfig(appDir);
    expect(result.defaultConfig).toBe("debug");
  });

  it("handles := assignment in Makefile", () => {
    const appDir = path.join(tmpDir, "app5");
    fs.mkdirSync(appDir);
    fs.writeFileSync(
      path.join(appDir, "Makefile"),
      "DEFAULT_CONFIG := prod\n"
    );

    const result = scanAppConfig(appDir);
    expect(result.defaultConfig).toBe("prod");
  });

  it("ignores non-config files", () => {
    const appDir = path.join(tmpDir, "app6");
    fs.mkdirSync(appDir);
    fs.writeFileSync(path.join(appDir, "config-debug.mk"), "");
    fs.writeFileSync(path.join(appDir, "Makefile"), "");
    fs.writeFileSync(path.join(appDir, "main.c"), "");
    fs.writeFileSync(path.join(appDir, "other.mk"), "");

    const result = scanAppConfig(appDir);
    expect(result.configs).toEqual(["debug"]);
  });

  it("returns empty for nonexistent directory", () => {
    const result = scanAppConfig(path.join(tmpDir, "nope"));
    expect(result.configs).toEqual([]);
  });

  it("sorts configs alphabetically", () => {
    const appDir = path.join(tmpDir, "app7");
    fs.mkdirSync(appDir);
    fs.writeFileSync(path.join(appDir, "config-zebra.mk"), "");
    fs.writeFileSync(path.join(appDir, "config-alpha.mk"), "");
    fs.writeFileSync(path.join(appDir, "config-middle.mk"), "");

    const result = scanAppConfig(appDir);
    expect(result.configs).toEqual(["alpha", "middle", "zebra"]);
  });
});

describe("listApps", () => {
  it("returns empty for nonexistent sdk path", () => {
    expect(listApps(path.join(tmpDir, "nosdk"))).toEqual([]);
  });

  it("returns empty when app/ directory missing", () => {
    expect(listApps(tmpDir)).toEqual([]);
  });

  it("lists directories under app/", () => {
    const appRoot = path.join(tmpDir, "app");
    fs.mkdirSync(appRoot);
    fs.mkdirSync(path.join(appRoot, "blink"));
    fs.mkdirSync(path.join(appRoot, "hello"));
    fs.writeFileSync(path.join(appRoot, "README.md"), "docs");

    const result = listApps(tmpDir);
    expect(result).toEqual(["blink", "hello"]);
  });

  it("excludes hidden directories", () => {
    const appRoot = path.join(tmpDir, "app");
    fs.mkdirSync(appRoot);
    fs.mkdirSync(path.join(appRoot, ".hidden"));
    fs.mkdirSync(path.join(appRoot, "visible"));

    const result = listApps(tmpDir);
    expect(result).toEqual(["visible"]);
  });

  it("sorts alphabetically", () => {
    const appRoot = path.join(tmpDir, "app");
    fs.mkdirSync(appRoot);
    fs.mkdirSync(path.join(appRoot, "zoo"));
    fs.mkdirSync(path.join(appRoot, "abc"));

    const result = listApps(tmpDir);
    expect(result).toEqual(["abc", "zoo"]);
  });
});
