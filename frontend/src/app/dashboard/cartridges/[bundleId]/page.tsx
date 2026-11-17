import { DashboardCartridgeDetailWorkspace } from "../../../../components/dashboard/DashboardCartridgeDetailWorkspace";

export default async function DashboardCartridgePage({
  params,
}: {
  params: Promise<{ bundleId: string }>;
}) {
  const { bundleId } = await params;
  return <DashboardCartridgeDetailWorkspace cartridgeId={bundleId} />;
}
