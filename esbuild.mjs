import * as esbuild from "esbuild";

const production = process.argv.includes("--production");

/** @type {esbuild.BuildOptions} */
const options = {
  entryPoints: [
    "src/extension.ts",
    "src/rv32simDebugAdapter.ts",
    "src/gdbUnixBridge.ts",
    "src/assertPrompt.ts",
    "src/memMap.ts",
  ],
  bundle: true,
  outdir: "out",
  external: ["vscode"],
  format: "cjs",
  platform: "node",
  target: "ES2020",
  sourcemap: !production,
  minify: production,
};

await esbuild.build(options);
