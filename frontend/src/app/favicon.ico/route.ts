import { resolvePublicApiUrl } from "../../lib/api/origin";

export const dynamic = "force-dynamic";

export async function GET() {
  // Let the browser request the managed asset directly. The Next container
  // cannot always resolve the public API hostname from inside the network,
  // while the browser can resolve it through the configured edge.
  const managedAsset = new URL(String(resolvePublicApiUrl("/api/assets/favicon")));
  managedAsset.searchParams.set("v", Date.now().toString());
  return new Response(null, {
    status: 307,
    headers: {
      "cache-control": "no-store",
    location: managedAsset.toString(),
    },
  });
}
