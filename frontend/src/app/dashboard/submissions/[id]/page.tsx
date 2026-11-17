import { DashboardSubmissionDetailWorkspace } from "../../../../components/dashboard/DashboardWorkspace";

export default async function DashboardSubmissionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <DashboardSubmissionDetailWorkspace submissionId={Number(id)} />;
}
