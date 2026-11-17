import { CreatorWorkspace } from "../../components/workflow/creator/CreatorWorkspace";
import { ContextualNavigation } from "../../components/layout/ContextualNavigation";

export default function WorkspacePage() {
  return <main className="page-gutter grid gap-6 py-8 lg:grid-cols-[240px_minmax(0,1fr)] lg:py-10"><ContextualNavigation context="creator" /><div className="min-w-0"><CreatorWorkspace /></div></main>;
}
