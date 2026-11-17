import { ReviewWorkspace } from "../../components/workflow/ReviewWorkspace";
import { ContextualNavigation } from "../../components/layout/ContextualNavigation";

export default function ReviewPage() {
  return <main className="relative isolate overflow-hidden"><div className="pointer-events-none absolute inset-0 opacity-40" style={{ backgroundImage: "linear-gradient(color-mix(in srgb, var(--color-border) 62%, transparent) 1px, transparent 1px), linear-gradient(90deg, color-mix(in srgb, var(--color-border) 62%, transparent) 1px, transparent 1px)", backgroundSize: "2.5rem 2.5rem", maskImage: "linear-gradient(90deg, black, transparent 88%)" }} /><div className="page-gutter relative grid gap-8 py-8 lg:grid-cols-[15rem_minmax(0,1fr)] lg:py-10"><ContextualNavigation context="review" /><div className="min-w-0"><ReviewWorkspace /></div></div></main>;
}
