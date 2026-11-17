import { ProviderDetails } from "../../../../../components/federation/FederationWorkspace";

export default async function FederationProviderPage({ params }: { params: Promise<{ providerId: string }> }) {
  const { providerId } = await params;
  return <ProviderDetails providerId={providerId} />;
}
