"use client";

import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Cpu, Download, ExternalLink, Usb, WifiOff } from "lucide-react";
import { useMemo, useState } from "react";

import { getFirmwareReleases, type FirmwareRelease } from "../../lib/api/firmware";
import { Button } from "../ui/button";
import { Card, CardContent, CardHeader } from "../ui/card";
import { flashFirmware, serialAvailable } from "./firmware/flash";

function FirmwareReleaseSelectors({ releases, release, profileName, busy, onReleaseChange, onProfileChange }: Readonly<{
  releases: readonly FirmwareRelease[];
  release: FirmwareRelease;
  profileName: string;
  busy: boolean;
  onReleaseChange: (tag: string) => void;
  onProfileChange: (name: string) => void;
}>) {
  const profile = release.profiles.find((item) => item.name === profileName) ?? release.profiles[0];
  return <>
    <label className="block text-sm font-semibold">Release
      <select className="mt-2 block min-h-11 w-full rounded-md border border-[var(--color-input)] bg-[var(--color-surface)] px-3 text-sm" value={release.tag} onChange={(event) => onReleaseChange(event.target.value)} disabled={busy}>
        {releases.map((item) => <option key={item.tag} value={item.tag}>{item.tag}{item.prerelease ? " (pre-release)" : ""}{item.published ? ` · ${item.published}` : ""}</option>)}
      </select>
    </label>
    <label className="block text-sm font-semibold">Pin profile
      <select className="mt-2 block min-h-11 w-full rounded-md border border-[var(--color-input)] bg-[var(--color-surface)] px-3 text-sm" value={profile?.name ?? ""} onChange={(event) => onProfileChange(event.target.value)} disabled={busy}>
        {release.profiles.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}
      </select>
    </label>
    {profile?.description && <p className="rounded-lg bg-[var(--color-surface-muted)] p-3 text-sm text-[var(--color-text-muted)]">{profile.description}</p>}
    {profile?.warning && <p className="flex gap-2 rounded-lg border border-[var(--color-warning)] bg-[var(--color-warning-soft)] p-3 text-sm"><AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />{profile.warning}</p>}
  </>;
}

function FirmwareHelpCard({ usbReady }: Readonly<{ usbReady: boolean }>) {
  return <Card>
    <CardHeader><h2 className="font-bold">Before you start</h2></CardHeader>
    <CardContent className="space-y-4 text-sm text-[var(--color-text-muted)]">
      <div className="flex gap-3"><Cpu className="mt-0.5 size-5 shrink-0 text-[var(--color-primary)]" /><p>Connect the board with its USB connector, not UART.</p></div>
      <div className="flex gap-3">{usbReady ? <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-[var(--color-success)]" /> : <WifiOff className="mt-0.5 size-5 shrink-0 text-[var(--color-warning)]" />}<p>{usbReady ? "This browser can use Web Serial." : "Use Chrome or Edge over HTTPS (or localhost) to enable Web Serial."}</p></div>
      <p>The normal update preserves Store data. Full erase is optional and destructive.</p>
      <a className="inline-flex items-center gap-2 font-semibold text-[var(--color-primary-strong)] hover:underline" href="https://github.com/riscv-prg32/PRG32/releases" target="_blank" rel="noreferrer">View firmware releases <ExternalLink aria-hidden="true" className="size-4" /></a>
      <a className="inline-flex items-center gap-2 font-semibold text-[var(--color-primary-strong)] hover:underline" href="https://github.com/riscv-prg32/PRG32/blob/main/docs/usage/firmware_releases.md" target="_blank" rel="noreferrer">Read the release contract <Download aria-hidden="true" className="size-4" /></a>
    </CardContent>
  </Card>;
}

export function FirmwareWorkspace() {
  const query = useQuery({ queryKey: ["firmware", "releases"], queryFn: getFirmwareReleases, staleTime: 60_000 });
  const releases = useMemo(() => query.data?.releases ?? [], [query.data?.releases]);
  const [selectedTag, setSelectedTag] = useState("");
  const [selectedProfileName, setSelectedProfileName] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [eraseAll, setEraseAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const usbReady = serialAvailable();
  const release = useMemo(() => releases.find((item) => item.tag === (selectedTag || releases[0]?.tag)), [releases, selectedTag]);
  const profile = release?.profiles.find((item) => item.name === (selectedProfileName || release.profiles[0]?.name));

  async function handleFlash() {
    if (!release || !profile || !confirmed || !usbReady) return;
    if (profile.warning && !window.confirm(`${profile.warning}\n\nWrite ${profile.name} anyway?`)) return;
    if (eraseAll && !window.confirm("Erase the whole flash? Wi-Fi settings, cartridges and scores will be deleted.")) return;
    setBusy(true); setError(""); setStatus("Choose the PRG32 board in the browser dialog."); setProgress(0);
    try {
      await flashFirmware({ release, profileName: profile.name, eraseAll, setStatus, setProgress });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught)); setStatus("");
    } finally {
      setBusy(false); setConfirmed(false); setEraseAll(false);
    }
  }

  if (query.isPending) return <main className="page-gutter py-10"><Card><CardContent className="py-12 text-center text-sm text-[var(--color-text-muted)]">Loading firmware releases…</CardContent></Card></main>;
  return <main className="page-gutter py-7 sm:py-10">
    <div className="max-w-4xl"><p className="technical-label text-[var(--color-primary)]">Hardware tools</p><h1 className="mt-2 text-3xl font-bold tracking-tight sm:text-4xl">Update PRG32 firmware over USB</h1><p className="mt-3 max-w-3xl text-sm leading-6 text-[var(--color-text-muted)]">Write an official PRG32 firmware release directly to an ESP32-C6 board from Chrome or Edge. The Store validates the release manifest and every binary before anything is written.</p></div>
    <div className="mt-7 grid gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <Card>
        <CardHeader><div className="flex items-center gap-3"><span className="grid size-10 place-items-center rounded-lg bg-[var(--color-primary-soft)] text-[var(--color-primary)]"><Usb aria-hidden="true" className="size-5" /></span><div><h2 className="font-bold">Firmware release</h2><p className="mt-1 text-xs text-[var(--color-text-muted)]">Repository: {query.data?.repository ?? "riscv-prg32/PRG32"}</p></div></div></CardHeader>
        <CardContent className="space-y-5">
          {query.isError && <p className="rounded-lg border border-[var(--color-danger)] bg-[var(--color-danger-soft)] p-3 text-sm" role="alert">Firmware releases could not be loaded.</p>}
          {releases.length === 0 && !query.isError && <p className="text-sm text-[var(--color-text-muted)]">No compatible firmware releases are available.</p>}
          {release && profile && <>
            <FirmwareReleaseSelectors releases={releases} release={release} profileName={profile.name} busy={busy} onReleaseChange={(tag) => { setSelectedTag(tag); setSelectedProfileName(""); setConfirmed(false); }} onProfileChange={(name) => { setSelectedProfileName(name); setConfirmed(false); }} />
            <label className="flex gap-3 text-sm"><input className="mt-1 size-4 accent-[var(--color-primary)]" type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} disabled={busy} /> <span>I confirm that this pin profile matches the wiring of my PRG32 board.</span></label>
            <details className="rounded-lg border border-[var(--color-border)] p-3 text-sm"><summary className="cursor-pointer font-semibold">Advanced: full erase</summary><label className="mt-3 flex gap-3 text-[var(--color-text-muted)]"><input className="mt-1 size-4 accent-[var(--color-danger)]" type="checkbox" checked={eraseAll} onChange={(event) => setEraseAll(event.target.checked)} disabled={busy} /> <span>Erase Wi-Fi settings, cartridges and scores before writing.</span></label></details>
            {progress !== null && <progress className="h-2 w-full accent-[var(--color-primary)]" max="100" value={progress} aria-label="Firmware writing progress" />}
            {status && <p className="text-sm text-[var(--color-text-muted)]" role="status" aria-live="polite">{status}</p>}
            {error && <p className="rounded-lg border border-[var(--color-danger)] bg-[var(--color-danger-soft)] p-3 text-sm" role="alert">{error}</p>}
            <Button className="w-full" onClick={() => void handleFlash()} disabled={busy || !usbReady || !confirmed}>{busy ? "Writing firmware…" : "Connect and write the firmware"}</Button>
          </>}
        </CardContent>
      </Card>
      <FirmwareHelpCard usbReady={usbReady} />
    </div>
  </main>;
}
