---
title: Platform reference
description: A map of the PRG32 runtime, hardware, tooling and compatibility references.
---

# PRG32 platform reference

This page is the map for the PRG32 platform material. The most useful guides
are reproduced in this documentation hub; specialist firmware notes remain in
the [PRG32 repository](https://github.com/riscv-prg32/PRG32/tree/main/docs)
and are linked directly so that the source and its revision are clear.

## Start here

- [Getting started](./getting-started) — install the toolchain and prepare a target.
- [Tooling](./tooling) — use the unified `python3 -m prg32` commands.
- [QEMU](./qemu) — build and run without a physical board.
- [Cartridge format](./cartridges) — understand portable images and Store-ready metadata.
- [Cartridge Store integration](./cartridge-store) — discovery, downloads and publishing.
- [ABI reference](./abi) — compatibility, imports and platform services.

## Hardware and firmware

The upstream repository is the authoritative source for material that is not
duplicated here:

- [Hardware setup](https://github.com/riscv-prg32/PRG32/blob/main/docs/hardware/hardware.md)
- [Memory architecture](https://github.com/riscv-prg32/PRG32/blob/main/docs/hardware/memory.md)
- [External controllers](https://github.com/riscv-prg32/PRG32/blob/main/docs/hardware/external_controllers.md)
- [Framework manual](https://github.com/riscv-prg32/PRG32/blob/main/docs/software/framework_manual.md)
- [Publishing and flashing firmware](https://github.com/riscv-prg32/PRG32/blob/main/docs/usage/publishing_and_flashing_firmware.md)

## Store and compatibility

Use the local Store documentation for the service boundary and API contracts:

- [Store overview](/docs/store)
- [Cartridge format](/docs/store/cartridge-format)
- [Metadata and compatibility](/docs/store/metadata)
- [Publishing workflow](/docs/store/publishing)
- [Store API](/docs/store/store-api)
- [Scores](/docs/store/scores)
- [Metrics](/docs/store/metrics)
- [Multiplayer](/docs/store/multiplayer)

The upstream references remain useful for protocol details and migration notes:

- [Web API reference](https://github.com/riscv-prg32/PRG32/blob/main/docs/software/api.md)
- [Colophon ABI](https://github.com/riscv-prg32/PRG32/blob/main/docs/software/colophon_abi.md)
- [Profiles](https://github.com/riscv-prg32/PRG32/blob/main/docs/usage/profiles.md)
- [Troubleshooting](https://github.com/riscv-prg32/PRG32/blob/main/docs/usage/troubleshooting.md)

## Measurement and tools

- [Performance test guide](https://github.com/riscv-prg32/PRG32/blob/main/docs/performance_test.md)
- [Metrics API](https://github.com/riscv-prg32/PRG32/blob/main/docs/measurement/metrics_api.md)
- [Performance cartridge ABI](https://github.com/riscv-prg32/PRG32/blob/main/docs/measurement/performance_cartridge_abi.md)
- [Scientific measurement tutorial](https://github.com/riscv-prg32/PRG32/blob/main/docs/measurement/scientific_measurement_tutorial.md)
- [Asset guidelines](https://github.com/riscv-prg32/PRG32/blob/main/docs/tools/assets.md)
- [Audio tools](https://github.com/riscv-prg32/PRG32/blob/main/docs/tools/audio.md)

## Source of truth

If a copied guide and the implementation disagree, prefer the current code,
the generated CLI `--help` output and the upstream PRG32 repository for
firmware-facing behavior. Changes to shared ABI names, architecture IDs or
Store routes must be checked against both repositories before publication.
