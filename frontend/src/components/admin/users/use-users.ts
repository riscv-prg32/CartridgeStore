import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { adminApi } from "../../../lib/api/admin";
import { adminQueryKeys } from "../../../lib/api/query-keys";

export function useAdminUsers(search: string, page: number, selectedId: number | null) {
  const queryClient = useQueryClient();
  const users = useQuery({ queryKey: adminQueryKeys.users({ search, page }), queryFn: () => adminApi.listUsers({ page, limit: 25, ...(search ? { q: search } : {}) }), retry: false });
  const roles = useQuery({ queryKey: adminQueryKeys.roles(), queryFn: adminApi.getRoles, retry: false });
  const groups = useQuery({ queryKey: adminQueryKeys.groups(), queryFn: () => adminApi.listGroups(), retry: false });
  const selected = useQuery({ queryKey: adminQueryKeys.user(selectedId), queryFn: () => adminApi.getUser(selectedId as number), enabled: selectedId !== null, retry: false });
  const invalidateUser = () => { void queryClient.invalidateQueries({ queryKey: adminQueryKeys.user(selectedId) }); void queryClient.invalidateQueries({ queryKey: adminQueryKeys.usersRoot() }); };
  const create = useMutation({ mutationFn: (input: { username: string; email: string; password: string }) => adminApi.createUser({ ...input, password_confirm: input.password }), onSuccess: () => void queryClient.invalidateQueries({ queryKey: adminQueryKeys.usersRoot() }) });
  const update = useMutation({ mutationFn: (input: Record<string, unknown>) => adminApi.updateUser(selectedId as number, input), onSuccess: invalidateUser });
  const remove = useMutation({ mutationFn: () => adminApi.deleteUser(selectedId as number), onSuccess: invalidateUser });
  const role = useMutation({ mutationFn: (value: string) => adminApi.setUserRole(selectedId as number, value), onSuccess: invalidateUser });
  const groupsMutation = useMutation({ mutationFn: (ids: number[]) => adminApi.replaceUserGroups(selectedId as number, ids), onSuccess: invalidateUser });
  const status = useMutation({ mutationFn: (value: "active" | "suspended" | "banned") => adminApi.setUserStatus(selectedId as number, value), onSuccess: invalidateUser });
  return { users, roles, groups, selected, create, update, remove, role, groupsMutation, status };
}
