import { startRegistration } from "@simplewebauthn/browser";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { beginPasskeyRegistration, finishPasskeyRegistration, getPasskeys, reauthenticate, renamePasskey, revokePasskey } from "../../../lib/api/auth";
import { authQueryKeys } from "../../../lib/api/query-keys";
import { toRegistrationOptions } from "../../../lib/auth/webauthn-adapter";

export function usePasskeys() {
  const queryClient = useQueryClient();
  const passkeys = useQuery({ queryKey: authQueryKeys.passkeys(), queryFn: getPasskeys, retry: false });
  const enroll = useMutation({
    mutationFn: async ({ password, displayName }: { password: string; displayName: string }) => {
      await reauthenticate(password);
      const options = await beginPasskeyRegistration();
      const response = await startRegistration({ optionsJSON: toRegistrationOptions(options) });
      return finishPasskeyRegistration(response, displayName);
    },
    retry: false,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: authQueryKeys.passkeys() }),
  });
  const rename = useMutation({ mutationFn: async ({ id, displayName, password }: { id: string; displayName: string; password: string }) => { await reauthenticate(password); return renamePasskey(id, displayName); }, retry: false, onSuccess: () => void queryClient.invalidateQueries({ queryKey: authQueryKeys.passkeys() }) });
  const remove = useMutation({ mutationFn: async ({ id, password }: { id: string; password: string }) => { await reauthenticate(password); return revokePasskey(id); }, retry: false, onSuccess: () => void queryClient.invalidateQueries({ queryKey: authQueryKeys.passkeys() }) });
  return { passkeys, enroll, rename, remove };
}
