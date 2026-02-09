# Mikro Design VS Code Extension

This extension provides:

- CMSIS-SVD register map view
- rv32sim process control with assert-assist parsing
- CodeLens choices for MMIO prompts during assert-assist
- GDB attach helper (runs gdb in the VS Code terminal)

## Quick start

1. Set an SVD file path:
   - Command: `Mikro: Select SVD File`
   - Or configure `mikroDesign.svdPath`
2. Start rv32sim:
   - Command: `Mikro: Start rv32sim`
3. Attach GDB:
   - Command: `Mikro: Attach GDB to rv32sim`

## Debug button

The extension auto-creates `.vscode/launch.json` with a `Mikro: rv32sim` config.
Use the Run and Debug button and select **Mikro: rv32sim** (requires C/C++ extension).

## Settings

- `mikroDesign.sdkPath`: ONiO firmware SDK root (default `/home/veba/work/gitlab/onio.firmware.c`)
- `mikroDesign.appName`: app folder under `<sdk>/app`
- `mikroDesign.configName`: config name (from `config-*.mk`)
- `mikroDesign.toolchain`: toolchain override (default from app Makefile)
- `mikroDesign.rv32simPath`: path to `rv32sim.py`
- `mikroDesign.pythonPath`: python interpreter used to run rv32sim
- `mikroDesign.gdbPath`: RISC-V GDB path
- `mikroDesign.addr2linePath`: addr2line tool used to map PC to source
- `mikroDesign.gdbPort`: GDB server port
- `mikroDesign.svdPath`: CMSIS-SVD file
- `mikroDesign.elfPath`: default ELF to load
- `mikroDesign.assertMode`: `assist`, `enforce`, or `none`
- `mikroDesign.assertFile`: assertion JSON file path
- `mikroDesign.assertShowAsm`: show disassembly around MMIO prompts
- `mikroDesign.assertVerbose`: show full field detail
- `mikroDesign.assertWrites`: prompt/assert on MMIO writes
- `mikroDesign.buildOnDebug`: build firmware before starting debug
- `mikroDesign.debugStopAtEntry`: stop at entry for debug

## Notes

- The CodeLens options are driven by rv32sim's `--assert-assist` output.
- Use `monitor load_elf <path>` inside GDB to load an ELF into rv32sim.
- Build output ELF is expected at `build/<app>/<config>/<toolchain>/<app>.elf` under the SDK.

## Puppeteer smoke test

This launches VS Code in extension-dev mode and checks that Mikro commands and the SVD view are present.

```bash
VSCODE_BIN=code npm run test:puppeteer
```

Optional env vars:

- `VSCODE_DEBUG_PORT` (default `9222`)
