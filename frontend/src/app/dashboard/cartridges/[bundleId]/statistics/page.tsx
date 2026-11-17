import { DashboardCartridgeStatisticsWorkspace } from "../../../../../components/dashboard/DashboardCartridgeStatisticsWorkspace";

export default async function DashboardCartridgeStatisticsPage({ params }: { params: Promise<{ bundleId: string }> }) {
  const { bundleId } = await params;
  return <DashboardCartridgeStatisticsWorkspace cartridgeId={decodeURIComponent(bundleId)} />;
}
