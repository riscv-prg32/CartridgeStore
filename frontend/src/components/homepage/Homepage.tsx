import { ArrowRight, BookOpen, ExternalLink, Gamepad2, GraduationCap, Wrench } from "lucide-react";
import Link from "next/link";

import { Button } from "../ui/button";
import { ProjectSignal } from "./ProjectSignal";

function ProjectIntroduction() {
  return (
    <section className="homepage-introduction page-gutter py-8 sm:py-10" aria-labelledby="what-is-prg32">
      <div className="homepage-introduction-card grid gap-8 p-6 sm:p-8 lg:grid-cols-[minmax(14rem,.7fr)_minmax(0,1.3fr)] lg:gap-16 lg:p-10">
        <div>
          <p className="technical-label text-[var(--color-primary)]">01 / The project</p>
          <h2 id="what-is-prg32" className="mt-3 max-w-sm text-2xl font-bold tracking-tight sm:text-3xl">A classroom runtime with a real machine behind it.</h2>
        </div>
        <div className="grid gap-6 sm:grid-cols-[minmax(0,1fr)_minmax(13rem,.65fr)] sm:items-start">
          <p className="max-w-2xl text-base leading-7 text-[var(--color-text-muted)]">PRG32 is an open-source educational runtime for learning RISC-V assembly and C through a compact retro-gaming environment. Programs follow a simple init, update, and draw loop, then run as cartridges on the platform.</p>
          <div className="border-l-2 border-[var(--color-primary)] pl-4 text-sm leading-6">
            <p className="font-semibold">Learn by making something you can run.</p>
            <Link className="mt-3 inline-flex items-center gap-1.5 font-semibold text-[var(--color-primary-strong)] hover:underline" href="/docs/getting-started">Read the getting started guide <ArrowRight aria-hidden="true" className="size-4" /></Link>
          </div>
        </div>
      </div>
    </section>
  );
}

function CapabilitiesSection() {
  const capabilities = [
    { icon: Gamepad2, index: "02", title: "Play cartridges", text: "Browse published .prg32 bundles, inspect their metadata, and choose the exact target binary.", href: "/explore", label: "Explore the Store" },
    { icon: Wrench, index: "03", title: "Build and package", text: "Follow the project workflow from a first program to a Store-ready cartridge bundle.", href: "/docs/cartridge-format", label: "Understand the format" },
    { icon: GraduationCap, index: "04", title: "Learn the system", text: "Use the firmware guides, ABI references, and examples to connect code, hardware, and execution.", href: "/docs", label: "Open documentation" },
  ] as const;

  return (
    <section className="homepage-capabilities page-gutter pb-5 pt-8 sm:pb-8 sm:pt-10" aria-labelledby="capabilities-heading">
      <div className="mb-7">
        <div><p className="technical-label text-[var(--color-primary)]">What you can do</p><h2 id="capabilities-heading" className="mt-2 text-2xl font-bold tracking-tight sm:text-3xl">One ecosystem, several ways in.</h2></div>
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        {capabilities.map(({ icon: Icon, index, title, text, href, label }) => <article key={title} className="homepage-capability-card flex min-h-64 flex-col p-5 sm:p-6">
          <div className="flex items-center justify-between"><Icon aria-hidden="true" className="size-5 text-[var(--color-primary)]" /><span className="technical-label text-[var(--color-text-muted)]">{index}</span></div>
          <h3 className="mt-10 text-lg font-bold">{title}</h3><p className="mt-2 max-w-sm text-sm leading-6 text-[var(--color-text-muted)]">{text}</p>
          <Link className="mt-auto inline-flex items-center gap-1.5 pt-6 text-sm font-semibold text-[var(--color-primary-strong)] hover:underline" href={href}>{label}<ArrowRight aria-hidden="true" className="size-4" /></Link>
        </article>)}
      </div>
    </section>
  );
}

function CartridgeEcosystem() {
  return (
    <section className="homepage-loop page-gutter pb-5 pt-5 sm:pb-8 sm:pt-8" aria-labelledby="cartridge-loop-heading">
      <div className="homepage-loop-panel grid gap-8 rounded-2xl p-6 sm:p-8 lg:grid-cols-[.8fr_1.2fr] lg:gap-16 lg:p-10">
        <div><p className="technical-label text-violet-200">05 / Cartridge loop</p><h2 id="cartridge-loop-heading" className="mt-3 max-w-md text-2xl font-bold tracking-tight text-white sm:text-3xl">From source code to a cartridge you can share.</h2><p className="mt-4 max-w-md text-sm leading-6 text-violet-100/75">The same project connects classroom code, a portable bundle format, and two supported execution paths.</p></div>
        <ol className="homepage-loop-steps overflow-hidden rounded-xl">
          {[{ title: "Write", text: "Learn the runtime loop and public ABI with C or RISC-V assembly." }, { title: "Package", text: "Describe the cartridge and its target-specific binaries with stable metadata." }, { title: "Run", text: "Use ESP32-C6 hardware or the QEMU path to execute the result." }].map((step, index) => <li key={step.title} className="grid gap-3 border-b border-white/15 px-4 py-5 last:border-b-0 sm:grid-cols-[3rem_8rem_minmax(0,1fr)] sm:items-baseline"><span className="technical-label text-violet-200">0{index + 1}</span><strong className="text-lg text-white">{step.title}</strong><span className="text-sm leading-6 text-violet-100/75">{step.text}</span></li>)}
        </ol>
      </div>
    </section>
  );
}

export function Homepage() {
  return <main className="homepage-shell">
    <section className="homepage-hero">
      <div className="page-gutter py-10 sm:py-14 lg:py-20"><div className="relative z-10 grid items-center gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(20rem,.78fr)] lg:gap-16">
        <div className="max-w-3xl"><p className="technical-label text-[var(--color-primary)]">PRG32 / Open educational runtime</p><h1 className="mt-4 max-w-3xl text-4xl font-bold tracking-[-0.04em] sm:text-5xl lg:text-7xl">Build cartridges.<br /><span className="text-[var(--color-primary-strong)]">Learn the machine.</span></h1><p className="mt-6 max-w-2xl text-base leading-7 text-[var(--color-text-muted)] sm:text-lg">An open-source retro-gaming environment for learning RISC-V assembly and C, with a Store for discovering and sharing portable PRG32 cartridges.</p><div className="mt-7 flex flex-wrap gap-2"><Button asChild><Link href="/explore"><Gamepad2 aria-hidden="true" className="size-4" />Explore cartridges<ArrowRight aria-hidden="true" className="size-4" /></Link></Button><Button asChild variant="secondary"><Link href="/docs/getting-started"><BookOpen aria-hidden="true" className="size-4" />Start with the project</Link></Button></div><div className="mt-10 grid max-w-xl grid-cols-3 gap-3 border-t border-[var(--color-border)] pt-4 font-mono text-[10px] font-semibold uppercase tracking-[0.13em] text-[var(--color-text-muted)] sm:gap-6"><span>Open source</span><span>Cartridge format</span><span>ESP32-C6 / QEMU</span></div></div>
        <ProjectSignal />
      </div></div>
    </section>
    <ProjectIntroduction />
    <CapabilitiesSection />
    <CartridgeEcosystem />
    <section className="page-gutter pb-14 pt-5 sm:pb-20 sm:pt-8" aria-labelledby="participate-heading"><div className="homepage-cta-panel grid items-end gap-6 rounded-2xl p-6 sm:p-8 lg:grid-cols-[minmax(0,1fr)_auto]"><div><p className="technical-label text-violet-200">06 / Participate</p><h2 id="participate-heading" className="mt-2 text-2xl font-bold tracking-tight text-white sm:text-3xl">Ready to find your next cartridge?</h2><p className="mt-3 max-w-xl text-sm leading-6 text-violet-100/75">Explore the public catalog, then use the project documentation when you are ready to build and share your own.</p></div><div className="flex flex-wrap gap-2"><Button asChild variant="primary" className="homepage-cta-button-primary"><Link href="/explore">Open Explore</Link></Button><Button asChild variant="outline" className="homepage-cta-button-secondary"><Link href="/docs">Browse docs<ExternalLink aria-hidden="true" className="size-4" /></Link></Button></div></div></section>
  </main>;
}
