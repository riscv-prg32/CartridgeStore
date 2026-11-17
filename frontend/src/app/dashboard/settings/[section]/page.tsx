import { notFound } from "next/navigation";

import { DashboardSettingsWorkspace } from "../../../../components/dashboard/DashboardWorkspace";
import {
  isSettingsSection,
  type SettingsSectionId,
} from "../../../../components/admin/settings/settings-sections";

type DashboardSettingsSectionPageProps = {
  params: Promise<{ section: string }>;
};

/** Renders one isolated settings section under its canonical dashboard route. */
export default async function DashboardSettingsSectionPage({
  params,
}: DashboardSettingsSectionPageProps) {
  const { section } = await params;
  if (!isSettingsSection(section)) notFound();

  return <DashboardSettingsWorkspace section={section as SettingsSectionId} />;
}
