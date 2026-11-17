"use client";

import { Check, Code2, Download, Gamepad2, Search, Settings2 } from "lucide-react";
import { useState } from "react";

import { ActiveFilter, FilterBar, FilterGroup } from "../ui/filter";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardContent, CardHeader, MetadataRow } from "../ui/card";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "../ui/dropdown-menu";
import { Field, Textarea } from "../ui/input";
import { SearchInput } from "../ui/search-input";
import { SelectField, SelectItem } from "../ui/select";

export function UIShowcase() {
  const [select, setSelect] = useState("published");
  const [search, setSearch] = useState("");
  const [filterVisible, setFilterVisible] = useState(true);

  return (
    <main className="page-gutter py-8 sm:py-12">
      <div className="space-y-8">
        <header className="space-y-2 border-b border-[var(--color-border)] pb-6">
          <p className="technical-label text-[var(--color-primary)]">Development only · UI.0.1</p>
          <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">Component foundation</h1>
          <p className="max-w-2xl text-[var(--color-text-muted)]">A local inspection surface for the shared PRG32 controls. It has no API dependency and is unavailable in production builds.</p>
        </header>

        <section aria-labelledby="showcase-actions" className="space-y-3">
          <h2 id="showcase-actions" className="text-lg font-bold">Actions and status</h2>
          <div className="flex flex-wrap items-center gap-2">
            <Button><Download aria-hidden="true" className="size-4" />Primary action</Button>
            <Button variant="secondary">Secondary</Button>
            <Button variant="outline">Outline</Button>
            <Button variant="ghost">Ghost</Button>
            <Button variant="danger">Destructive</Button>
            <Button variant="icon" size="icon" aria-label="Settings"><Settings2 aria-hidden="true" className="size-4" /></Button>
            <Badge variant="success">Published</Badge><Badge variant="warning">Pending review</Badge><Badge variant="version">v1.2.0</Badge><Badge variant="architecture">esp32c6</Badge>
          </div>
        </section>

        <section aria-labelledby="showcase-form" className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <Card>
            <CardHeader><h2 id="showcase-form" className="font-bold">Inputs and search</h2></CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <Field label="Cartridge title" name="showcase-title" placeholder="Enter a title" help="Use a concise published title." />
              <SearchInput aria-label="Showcase search" placeholder="Search component examples" value={search} onChange={(event) => setSearch(event.target.value)} onClear={() => setSearch("")} />
              <Textarea aria-label="Description" placeholder="Optional description" className="sm:col-span-2" />
            </CardContent>
          </Card>
          <Card>
            <CardHeader><h2 className="font-bold">Select and menu</h2></CardHeader>
            <CardContent className="space-y-4">
              <SelectField label="Publication status" value={select} onValueChange={setSelect}>
                <SelectItem value="draft">Draft</SelectItem><SelectItem value="pending">Pending review</SelectItem><SelectItem value="published">Published</SelectItem><SelectItem value="rejected" disabled>Rejected (disabled)</SelectItem>
              </SelectField>
              <DropdownMenu>
                <DropdownMenuTrigger asChild><Button variant="secondary" className="w-full justify-between"><span className="inline-flex items-center gap-2"><Gamepad2 aria-hidden="true" className="size-4" />Open menu</span><Code2 aria-hidden="true" className="size-4" /></Button></DropdownMenuTrigger>
                <DropdownMenuContent align="start"><DropdownMenuLabel>Example actions</DropdownMenuLabel><DropdownMenuItem><Check aria-hidden="true" className="mr-2 size-4" />Mark ready</DropdownMenuItem><DropdownMenuItem><Search aria-hidden="true" className="mr-2 size-4" />Inspect</DropdownMenuItem><DropdownMenuSeparator /><DropdownMenuItem className="text-rose-700">Remove draft</DropdownMenuItem></DropdownMenuContent>
              </DropdownMenu>
            </CardContent>
          </Card>
        </section>

        <section aria-labelledby="showcase-filters" className="space-y-3">
          <h2 id="showcase-filters" className="text-lg font-bold">Filter foundation</h2>
          <FilterBar hasFilters={filterVisible} onClear={() => setFilterVisible(false)}>
            <FilterGroup label="Architecture"><label className="flex items-center gap-2 text-sm"><input type="checkbox" defaultChecked />esp32c6</label><label className="flex items-center gap-2 text-sm"><input type="checkbox" />qemu</label></FilterGroup>
            {filterVisible && <ActiveFilter label="Published" onRemove={() => setFilterVisible(false)} />}
          </FilterBar>
        </section>

        <section aria-labelledby="showcase-card" className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]">
          <article className="group flex min-w-0 overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
            <div className="grid min-h-40 w-40 shrink-0 place-items-center bg-[var(--color-primary-soft)] text-[var(--color-primary)]"><Gamepad2 aria-hidden="true" className="size-12" /></div>
            <div className="min-w-0 p-4"><div className="flex flex-wrap items-center gap-2"><h2 id="showcase-card" className="font-bold">Example cartridge</h2><Badge variant="game">Game</Badge><Badge variant="success">Verified</Badge></div><p className="mt-2 text-sm text-[var(--color-text-muted)]">Compact card geometry for the catalog grid. Artwork remains separate from metadata.</p><div className="mt-4 flex flex-wrap gap-2"><Badge variant="architecture">esp32c6</Badge><Badge variant="architecture">qemu</Badge></div></div>
          </article>
          <Card><CardHeader><h2 className="font-bold">Metadata rows</h2></CardHeader><CardContent><dl><MetadataRow label="Version" value="1.2.0" /><MetadataRow label="Target" value="esp32c6" /><MetadataRow label="Status" value="Published" /></dl></CardContent></Card>
        </section>
      </div>
    </main>
  );
}
