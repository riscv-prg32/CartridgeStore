"use client";

import { useState } from "react";

import { cn } from "../../lib/cn";

const systemNodes = [
  {
    id: "runtime",
    label: "RUNTIME",
    eyebrow: "Execution core",
    title: "INIT / UPDATE / DRAW",
    description: "A small, explicit loop keeps execution easy to inspect while learning C and RISC-V assembly.",
    detail: "Educational runtime · C + RISC-V assembly",
    column: 1,
    row: 1,
    columnSpan: 2,
    rowSpan: 2,
    tone: "primary",
  },
  {
    id: "rv32",
    label: "RV32",
    eyebrow: "Instruction set",
    title: "RV32 execution",
    description: "The machine model stays close to the code with a readable 32-bit target.",
    detail: "RV32 · register-first execution",
    column: 3,
    row: 1,
    tone: "strong",
  },
  {
    id: "toolchain",
    label: "TOOLCHAIN",
    eyebrow: "Build path",
    title: "Compile and package",
    description: "The development workflow turns classroom code into a portable cartridge bundle.",
    detail: "C / assembly · reproducible build",
    column: 4,
    row: 1,
    tone: "quiet",
  },
  {
    id: "cartridge",
    label: ".PRG32",
    eyebrow: "Portable bundle",
    title: "Cartridge format",
    description: "A .prg32 cartridge carries metadata and target binaries needed to share a build.",
    detail: "prg32-metadata-1.0",
    column: 3,
    row: 2,
    columnSpan: 2,
    tone: "soft",
  },
  {
    id: "metadata",
    label: "ABI",
    eyebrow: "Stable contract",
    title: "Metadata ABI",
    description: "Versioned metadata keeps cartridges inspectable across firmware, tools, and the Store.",
    detail: "prg32-metadata-1.0",
    column: 1,
    row: 3,
    tone: "soft",
  },
  {
    id: "store",
    label: "STORE API",
    eyebrow: "Public service",
    title: "Discover and publish",
    description: "The Store connects catalog discovery, publishing, downloads, scores, and metrics.",
    detail: "Catalog · publish · download",
    column: 2,
    row: 3,
    columnSpan: 2,
    tone: "primary",
  },
  {
    id: "multiplayer",
    label: "MULTIPLAYER",
    eyebrow: "Real-time layer",
    title: "Multiplayer relay",
    description: "Real-time traffic stays on the same service boundary as the web and API surface.",
    detail: "WebSocket · /api/multiplayer",
    column: 4,
    row: 3,
    tone: "quiet",
  },
  {
    id: "esp32",
    label: "ESP32-C6",
    eyebrow: "Physical target",
    title: "Run on hardware",
    description: "The workflow reaches a real PRG32 board instead of stopping at the emulator.",
    detail: "Architecture token: esp32c6",
    column: 1,
    row: 4,
    tone: "strong",
  },
  {
    id: "qemu",
    label: "QEMU",
    eyebrow: "Emulated target",
    title: "Test the same cartridge",
    description: "Use a reproducible emulated path to test runtime and cartridge behavior while learning.",
    detail: "Architecture token: qemu",
    column: 2,
    row: 4,
    tone: "soft",
  },
  {
    id: "scores",
    label: "SCORES",
    eyebrow: "Compatible service",
    title: "ScoreServer bridge",
    description: "Games can publish scores through the existing compatible contract.",
    detail: "GET + POST /api/scores",
    column: 3,
    row: 4,
    tone: "quiet",
  },
  {
    id: "discovery",
    label: "DISCOVERY",
    eyebrow: "Local service",
    title: "Find the Store",
    description: "Hardware and tools can discover a nearby Store without a host-specific URL.",
    detail: "_prg32store._tcp · port 5080",
    column: 4,
    row: 4,
    tone: "strong",
  },
] as const;

const nodeToneClasses = {
  primary: "bg-[var(--color-primary)] text-white",
  strong: "bg-[var(--color-primary-strong)] text-white",
  soft: "bg-[var(--color-primary-soft)] text-[var(--color-primary-strong)]",
  quiet: "bg-[var(--color-border)] text-[var(--color-text-muted)]",
} as const;

export function ProjectSignal() {
  const [activeNode, setActiveNode] = useState("runtime");
  const activeSpec = systemNodes.find((node) => node.id === activeNode) ?? systemNodes[0]!;

  return (
    <div
      className="border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-[var(--shadow-card)] sm:p-5"
      aria-label="PRG32 project signal"
    >
      <div
        className={cn(
          "flex items-center justify-between border-b border-[var(--color-border)] pb-3",
          "font-mono text-[10px] font-semibold uppercase tracking-[0.16em]",
          "text-[var(--color-text-muted)]",
        )}
      >
        <span>PRG32 / SYSTEM MAP</span>
        <span className="inline-flex items-center gap-1.5 text-[var(--color-primary-strong)]">
          <span aria-hidden="true" className="size-1.5 rounded-full bg-[var(--color-primary)]" />
          ready
        </span>
      </div>
      <div
        className={cn(
          "homepage-system-map mt-4 grid min-h-72 grid-cols-4 gap-2.5",
          "border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-4 sm:gap-3 sm:p-6",
        )}
        role="group"
        aria-label="Interactive PRG32 system map"
      >
        {systemNodes.map((node) => (
          <button
            key={node.id}
            type="button"
            aria-label={`Inspect ${node.title}`}
            aria-pressed={activeNode === node.id}
            className={cn(
              "group relative flex min-h-12 flex-col items-start justify-end rounded-sm p-2 text-left",
              "transition duration-200 hover:z-10 hover:-translate-y-1 hover:shadow-lg",
              "focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-offset-2",
              "focus-visible:outline-[var(--color-ring)]",
              nodeToneClasses[node.tone],
              activeNode === node.id && "z-10 -translate-y-1 shadow-[0_0_0_3px_var(--color-surface),0_0_0_5px_var(--color-primary)]",
            )}
            style={{
              gridColumn: `${node.column} / span ${"columnSpan" in node ? node.columnSpan : 1}`,
              gridRow: `${node.row} / span ${"rowSpan" in node ? node.rowSpan : 1}`,
            }}
            onFocus={() => setActiveNode(node.id)}
            onMouseEnter={() => setActiveNode(node.id)}
          >
            <span className="font-mono text-[9px] font-bold uppercase tracking-[0.12em]">
              {node.label}
            </span>
            <span
              className="pointer-events-none absolute inset-0 rounded-sm opacity-0 ring-1 ring-white/70 transition group-hover:opacity-100"
            />
          </button>
        ))}
      </div>
      <div className="mt-4 min-h-28 border border-[var(--color-border)] bg-[var(--color-surface)] p-3 sm:p-4" aria-live="polite">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="technical-label text-[var(--color-primary)]">{activeSpec.eyebrow}</p>
            <p className="mt-1 text-sm font-bold tracking-tight">{activeSpec.title}</p>
          </div>
          <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--color-text-muted)]">
            hover / focus
          </span>
        </div>
        <p className="mt-2 text-xs leading-5 text-[var(--color-text-muted)]">{activeSpec.description}</p>
        <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--color-primary-strong)]">{activeSpec.detail}</p>
      </div>
      <div
        className={cn(
          "mt-4 grid grid-cols-2 gap-2 font-mono text-[10px] uppercase",
          "tracking-[0.13em] text-[var(--color-text-muted)] sm:grid-cols-3",
        )}
      >
        <span className="border border-[var(--color-border)] px-2 py-2">RV32</span>
        <span className="border border-[var(--color-border)] px-2 py-2">.PRG32</span>
        <span className="border border-[var(--color-border)] px-2 py-2">QEMU / C6</span>
      </div>
    </div>
  );
}
