import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { adminApi } from "../../../lib/api/admin";
import { adminQueryKeys } from "../../../lib/api/query-keys";

export function useAdminGroups() {
  const queryClient = useQueryClient();
  const groups = useQuery({ queryKey: adminQueryKeys.groups(), queryFn: () => adminApi.listGroups(), retry: false });
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: adminQueryKeys.groups() });
  const create = useMutation({ mutationFn: (name: string) => adminApi.createGroup(name), onSuccess: invalidate });
  const rename = useMutation({ mutationFn: ({ id, name }: { id: number; name: string }) => adminApi.renameGroup(id, name), onSuccess: invalidate });
  const remove = useMutation({ mutationFn: (id: number) => adminApi.deleteGroup(id), onSuccess: invalidate });
  return { groups, create, rename, remove };
}
