import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { adminApi } from "../../../lib/api/admin";
import { adminQueryKeys } from "../../../lib/api/query-keys";

export function useCatalogModeration(selectedId: string | null, selectedVersion: string | undefined) {
  const queryClient = useQueryClient();
  const cartridges = useQuery({ queryKey: adminQueryKeys.catalog({ moderation: true }), queryFn: () => adminApi.listModerationInventory({ page: 1, limit: 100 }), retry: false });
  const detail = useQuery({ queryKey: adminQueryKeys.cartridge(selectedId, selectedVersion), queryFn: () => adminApi.getModerationCartridge(selectedId as string, selectedVersion), enabled: selectedId !== null, retry: false });
  const invalidate = () => { void queryClient.invalidateQueries({ queryKey: adminQueryKeys.catalogRoot() }); void queryClient.invalidateQueries({ queryKey: adminQueryKeys.cartridge(selectedId, selectedVersion) }); };
  const update = useMutation({ mutationFn: (input: { id: string; version: string; metadata: Record<string, unknown> }) => adminApi.updateCartridge(input.id, input.version, input.metadata), onSuccess: invalidate });
  const moderate = useMutation({ mutationFn: (input: { id: string; version: string; action: "hidden" | "unpublished" | "restored"; reason: string }) => adminApi.moderateCartridge(input.id, input.version, input.action, input.reason), onSuccess: invalidate });
  const remove = useMutation({ mutationFn: (input: { id: string; version: string; architecture: string }) => adminApi.deleteCartridge(input.id, input.version, input.architecture), onSuccess: invalidate });
  return { cartridges, detail, update, moderate, remove };
}
