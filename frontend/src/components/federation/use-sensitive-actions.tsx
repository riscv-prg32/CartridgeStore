import { useMutation } from "@tanstack/react-query";
import { useRef, useState } from "react";

import { federationAdminApi } from "../../lib/api/federation-admin";
import { ReauthenticationDialog } from "./ReauthenticationDialog";

/**
 * Keeps the re-authentication ceremony in one feature-owned hook. Callers
 * still decide which mutation to run; this hook owns only the pending action
 * and dialog lifecycle.
 */
export function useSensitiveActions() {
  const [open, setOpen] = useState(false);
  const pending = useRef<(() => void) | null>(null);
  const clearPending = useRef<(() => void) | null>(null);
  const reauth = useMutation({ mutationFn: federationAdminApi.reauthenticate });

  const request = (action: () => void, clear?: () => void) => {
    pending.current = action;
    clearPending.current = clear ?? null;
    setOpen(true);
  };

  const submit = (password: string) => {
    void reauth.mutateAsync(password).then(() => {
      const action = pending.current;
      pending.current = null;
      clearPending.current = null;
      setOpen(false);
      action?.();
    }).catch(() => undefined);
  };

  const cancel = () => {
    clearPending.current?.();
    pending.current = null;
    clearPending.current = null;
    reauth.reset();
    setOpen(false);
  };

  return {
    request,
    dialog: <ReauthenticationDialog open={open} busy={reauth.isPending} error={reauth.error} onCancel={cancel} onSubmit={submit} />
  };
}
