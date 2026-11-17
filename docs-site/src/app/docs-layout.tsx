import { DocsLayout } from "fumadocs-ui/layouts/docs";
import type { ReactNode } from "react";

import { baseOptions } from "./layout.config";
import { source } from "../lib/source";
import { getLayoutTabs } from "fumadocs-ui/layouts/shared";

const areaTabs = getLayoutTabs(source.pageTree).map(({ $folder: _folder, ...tab }) => tab);

export default function DocumentationLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <DocsLayout tree={source.pageTree} tabs={areaTabs} {...baseOptions()}>
      {children}
    </DocsLayout>
  );
}
