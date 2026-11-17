"use client";

import { useQuery } from "@tanstack/react-query";
import { BookOpen, ChevronRight, Filter, Search, SlidersHorizontal } from "lucide-react";
import Link from "next/link";
import { FormEvent, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { getCatalog } from "../../lib/api/catalog";
import { catalogQueryKeys } from "../../lib/api/query-keys";
import type { Game } from "../../lib/api/contracts";
import { ActiveFilter, FilterBar, FilterGroup } from "../ui/filter";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "../ui/dialog";
import { SearchInput } from "../ui/search-input";
import { SelectField, SelectItem } from "../ui/select";
import { CatalogEmpty, CatalogError, CatalogLoading } from "./CatalogState";
import { GameCard } from "./GameCard";

type SortMode = "title" | "updated";

function parsePage(value: string | null): number {
  const page = Number(value);
  return Number.isSafeInteger(page) && page > 0 ? page : 1;
}

function setUrl(router: ReturnType<typeof useRouter>, pathname: string, values: Record<string, string | undefined>) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value) query.set(key, value);
  const suffix = query.toString();
  router.push(`${pathname}${suffix ? `?${suffix}` : ""}`);
}

function compareGames(left: Game, right: Game, mode: SortMode): number {
  if (mode === "updated") return String(right.updated_at ?? "").localeCompare(String(left.updated_at ?? "")) || left.title.localeCompare(right.title);
  return left.title.localeCompare(right.title);
}

function ArchitectureOptions({ architectures, value, onChange, name }: { architectures: string[]; value: string; onChange: (value: string) => void; name: string }) {
  return <FilterGroup label="Architecture" className="border-t border-[var(--color-border)] pt-4"><label className="flex cursor-pointer items-center gap-2 text-sm"><input type="radio" name={name} value="" checked={!value} onChange={() => onChange("")} />All architectures</label>{architectures.map((item) => <label key={item} className="flex cursor-pointer items-center gap-2 text-sm"><input type="radio" name={name} value={item} checked={value === item} onChange={() => onChange(item)} />{item}</label>)}{architectures.length === 0 && <p className="text-xs text-[var(--color-text-muted)]">Available targets will appear with catalog results.</p>}</FilterGroup>;
}

function TechnicalPreview() {
  return <div className="relative min-h-52 overflow-hidden rounded-lg border border-[var(--color-border)] bg-[#171222] p-4" aria-label="PRG32 technical preview"><div className="absolute inset-0 opacity-40" style={{ backgroundImage: "linear-gradient(rgba(162,123,255,.18) 1px, transparent 1px), linear-gradient(90deg, rgba(162,123,255,.18) 1px, transparent 1px)", backgroundSize: "24px 24px" }} /><div className="relative flex h-full min-h-44 flex-col justify-between"><div className="flex items-center justify-between text-[10px] font-semibold uppercase tracking-[0.18em] text-violet-200"><span>PRG32 / STORE</span><span className="inline-flex items-center gap-1"><span className="size-1.5 rounded-full bg-emerald-400" />ready</span></div><div className="mx-auto grid w-[min(100%,20rem)] grid-cols-[1fr_4.5rem] gap-3 rounded-md border border-violet-300/30 bg-black/30 p-3"><div className="grid min-h-24 place-items-center rounded border border-violet-300/30 bg-violet-950/40"><div className="grid grid-cols-8 gap-1 opacity-80">{Array.from({ length: 32 }, (_, index) => <span key={index} className={`size-1.5 rounded-[1px] ${index % 5 === 0 ? "bg-violet-200" : index % 3 === 0 ? "bg-violet-400" : "bg-violet-800"}`} />)}</div></div><div className="flex flex-col justify-between text-right font-mono text-[9px] text-violet-200"><span>CARTRIDGE</span><strong className="text-xl text-white">.prg32</strong><span>QEMU / C6</span></div></div><div className="flex items-end justify-between font-mono text-[10px] text-violet-300"><span>PLAY / CODE / LEARN</span><span>01—24</span></div></div></div>;
}

function CatalogSearchForm({ queryText, onClear, onSubmit }: { queryText: string; onClear: () => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
  const [value, setValue] = useState(queryText);
  return <form className="flex flex-col gap-2" onSubmit={onSubmit} role="search"><label className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]" htmlFor="catalog-search">Search cartridges</label><div className="flex gap-2"><SearchInput id="catalog-search" name="q" value={value} onChange={(event) => setValue(event.target.value)} onClear={() => { setValue(""); onClear(); }} placeholder="Title, author, tag, or ID" className="flex-1" /><Button type="submit" size="icon" aria-label="Search"><Search aria-hidden="true" className="size-4" /></Button></div>{queryText && <p className="text-xs text-[var(--color-text-muted)]">Searching for <span className="font-semibold text-[var(--color-text)]">{queryText}</span></p>}</form>;
}

function StorefrontHero({ queryText, resultCount, architectureCount, isLoading, onClearSearch, onSubmit }: { queryText: string; resultCount: number | undefined; architectureCount: number; isLoading: boolean; onClearSearch: () => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
  return <section className="border-b border-[var(--color-border)]"><div className="page-gutter py-7 sm:py-9 lg:py-10"><div className="grid gap-6 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-5 sm:p-7 lg:grid-cols-[minmax(0,1.05fr)_minmax(22rem,.95fr)] lg:items-center lg:p-8"><div><p className="technical-label text-[var(--color-primary)]">PRG32 / Explore</p><h1 className="mt-3 max-w-2xl text-3xl font-bold tracking-tight sm:text-4xl lg:text-[2.75rem]">Browse the cartridge shelf.</h1><p className="mt-3 max-w-xl text-sm leading-6 text-[var(--color-text-muted)] sm:text-base">Search the complete published catalog, inspect technical details, and download the exact binary for your hardware or QEMU target.</p><div className="mt-5 flex flex-wrap gap-2"><Button asChild variant="secondary"><Link href="/docs/getting-started"><BookOpen aria-hidden="true" className="size-4" />Documentation</Link></Button></div><div className="mt-6 grid max-w-xl grid-cols-3 gap-2 border-t border-[var(--color-border)] pt-4"><div><p className="text-lg font-bold tabular-nums">{resultCount ?? "—"}</p><p className="text-[11px] uppercase tracking-wide text-[var(--color-text-muted)]">Published</p></div><div><p className="text-lg font-bold tabular-nums">{architectureCount || "—"}</p><p className="text-[11px] uppercase tracking-wide text-[var(--color-text-muted)]">Targets loaded</p></div><div><p className="text-lg font-bold tabular-nums">{isLoading ? "…" : "Live"}</p><p className="text-[11px] uppercase tracking-wide text-[var(--color-text-muted)]">Store API</p></div></div></div><div className="grid gap-4"><TechnicalPreview /><CatalogSearchForm key={queryText} queryText={queryText} onClear={onClearSearch} onSubmit={onSubmit} /></div></div></div></section>;
}

export function CatalogBrowser() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const queryText = searchParams.get("q") ?? "";
  const architecture = searchParams.get("architecture") ?? "";
  const sort = searchParams.get("sort") === "updated" ? "updated" : "title";
  const page = parsePage(searchParams.get("page"));
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
  const [draftArchitecture, setDraftArchitecture] = useState(architecture);

  const query = useQuery({ queryKey: catalogQueryKeys.list({ query: queryText, page, perPage: 100 }), queryFn: () => getCatalog({ q: queryText, page, perPage: 100 }), staleTime: 30_000 });
  const architectures = useMemo(() => Array.from(new Set((query.data?.games ?? []).flatMap((game) => game.architectures))).sort(), [query.data?.games]);
  const latestGames = useMemo(() => [...(query.data?.games ?? [])].sort((left, right) => compareGames(left, right, "updated")).slice(0, 4), [query.data?.games]);
  const visibleGames = useMemo(() => {
    const filtered = architecture ? query.data?.games.filter((game) => game.architectures.includes(architecture)) ?? [] : query.data?.games ?? [];
    return [...filtered].sort((left, right) => compareGames(left, right, sort));
  }, [architecture, query.data?.games, sort]);

  function values(nextArchitecture = architecture, nextQuery = queryText, nextSort = sort, nextPage?: number) {
    return { q: nextQuery || undefined, architecture: nextArchitecture || undefined, sort: nextSort === "title" ? undefined : nextSort, page: nextPage ? String(nextPage) : undefined };
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const nextQuery = String(form.get("q") ?? "").trim();
    setUrl(router, pathname, values(architecture, nextQuery));
  }

  function clearFilters() {
    setDraftArchitecture("");
    setUrl(router, pathname, {});
  }

  function selectArchitecture(next: string) {
    setUrl(router, pathname, values(next));
  }

  function openMobileFilters() {
    setDraftArchitecture(architecture);
    setMobileFiltersOpen(true);
  }

  function applyMobileFilters() {
    selectArchitecture(draftArchitecture);
    setMobileFiltersOpen(false);
  }

  const isFiltered = Boolean(queryText || architecture);
  const activeFilterCount = Number(Boolean(architecture));

  return <>
    <StorefrontHero queryText={queryText} resultCount={query.data?.pagination.total} architectureCount={architectures.length} isLoading={query.isPending} onClearSearch={() => setUrl(router, pathname, values(architecture, ""))} onSubmit={submit} />
    {query.isSuccess && latestGames.length > 0 && <section className="page-gutter border-b border-[var(--color-border)] py-7 sm:py-8" aria-labelledby="recently-updated-heading"><div className="mb-4 flex items-end justify-between gap-4"><div><p className="technical-label text-[var(--color-primary)]">From the catalog</p><h2 id="recently-updated-heading" className="mt-1 text-xl font-bold">Recently updated</h2></div><Link className="inline-flex items-center gap-1 text-sm font-semibold text-[var(--color-primary-strong)] hover:underline" href="#catalog">See all<ChevronRight aria-hidden="true" className="size-4" /></Link></div><div className="card-grid">{latestGames.map((game) => <GameCard key={`recent-${game.id}`} game={game} />)}</div></section>}
    <main id="catalog" className="page-gutter scroll-mt-6 py-7 sm:py-9">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-4 border-b border-[var(--color-border)] pb-4"><div><p className="technical-label text-[var(--color-primary)]">Browse / Catalog</p><h2 className="mt-1 text-2xl font-bold">All cartridges</h2><p className="mt-1 text-sm text-[var(--color-text-muted)]" aria-live="polite">{query.data ? `${query.data.pagination.total} cartridge${query.data.pagination.total === 1 ? "" : "s"} found` : "Loading the catalog"}</p></div><div className="flex items-center gap-2 lg:hidden"><Dialog open={mobileFiltersOpen} onOpenChange={setMobileFiltersOpen}><DialogTrigger asChild><Button type="button" variant="secondary" onClick={openMobileFilters}><SlidersHorizontal aria-hidden="true" className="size-4" />Filters{activeFilterCount > 0 && <span className="grid size-5 place-items-center rounded-full bg-[var(--color-primary)] text-[10px] text-white">{activeFilterCount}</span>}</Button></DialogTrigger><DialogContent aria-describedby="mobile-filter-description"><DialogHeader><DialogTitle>Filter cartridges</DialogTitle><DialogDescription id="mobile-filter-description">Choose an available architecture, then apply the filter to the loaded catalog results.</DialogDescription></DialogHeader><ArchitectureOptions name="mobile-architecture-filter" architectures={architectures} value={draftArchitecture} onChange={setDraftArchitecture} /><div className="mt-6 flex gap-2 border-t border-[var(--color-border)] pt-4"><Button type="button" variant="ghost" onClick={() => setDraftArchitecture("")}>Clear</Button><Button type="button" className="ml-auto" onClick={applyMobileFilters}>Apply filters</Button></div></DialogContent></Dialog><SelectField label="Sort" name="mobile-sort" value={sort} onValueChange={(value) => setUrl(router, pathname, values(architecture, queryText, value as SortMode))}><SelectItem value="title">Title</SelectItem><SelectItem value="updated">Recently updated</SelectItem></SelectField></div></div>
      <div className="grid gap-6 lg:grid-cols-[14rem_minmax(0,1fr)] lg:items-start"><aside className="hidden lg:sticky lg:top-6 lg:block lg:border-r lg:border-[var(--color-border)] lg:pr-6"><div className="space-y-4"><div className="flex items-center gap-2"><Filter aria-hidden="true" className="size-4 text-[var(--color-primary)]" /><h3 className="font-bold">Filters</h3></div><ArchitectureOptions name="desktop-architecture-filter" architectures={architectures} value={architecture} onChange={selectArchitecture} />{isFiltered && <Button type="button" variant="ghost" size="sm" className="justify-start px-0" onClick={clearFilters}>Clear filters</Button>}<p className="border-t border-[var(--color-border)] pt-4 text-xs leading-5 text-[var(--color-text-muted)]">Architecture filtering applies to the currently loaded catalog page.</p></div></aside><section className="min-w-0"><div className="mb-4 flex min-h-10 flex-wrap items-center justify-between gap-3 border-b border-[var(--color-border)] pb-3"><FilterBar className="min-w-0 flex-1" hasFilters={isFiltered} onClear={clearFilters}>{queryText && <ActiveFilter label={`Search: ${queryText}`} onRemove={() => setUrl(router, pathname, values(architecture, ""))} />}{architecture && <ActiveFilter label={architecture} onRemove={() => selectArchitecture("")} />}</FilterBar><div className="hidden items-center gap-2 lg:flex"><SelectField label="Sort" name="desktop-sort" value={sort} onValueChange={(value) => setUrl(router, pathname, values(architecture, queryText, value as SortMode))}><SelectItem value="title">Title</SelectItem><SelectItem value="updated">Recently updated</SelectItem></SelectField></div></div>{query.isPending && <CatalogLoading />}{query.isError && <CatalogError onRetry={() => void query.refetch()} />}{query.isSuccess && visibleGames.length === 0 && <CatalogEmpty filtered={isFiltered} />}{query.isSuccess && visibleGames.length > 0 && <div className="card-grid">{visibleGames.map((game) => <GameCard key={game.id} game={game} />)}</div>}{query.isSuccess && query.data.pagination.total > query.data.games.length && <p className="mt-6 text-center text-sm text-[var(--color-text-muted)]">Showing up to 100 results per page. Refine your search to find a specific cartridge.</p>}{query.isSuccess && query.data.pagination.pages > 1 && <nav className="mt-8 flex items-center justify-center gap-4" aria-label="Catalog pages"><Button type="button" variant="secondary" disabled={!query.data.pagination.has_prev} onClick={() => setUrl(router, pathname, values(architecture, queryText, sort, page - 1))}>Previous</Button><span className="text-sm text-[var(--color-text-muted)]">Page {query.data.pagination.page} of {query.data.pagination.pages}</span><Button type="button" variant="secondary" disabled={!query.data.pagination.has_next} onClick={() => setUrl(router, pathname, values(architecture, queryText, sort, page + 1))}>Next</Button></nav>}</section></div>
    </main>
  </>;
}
