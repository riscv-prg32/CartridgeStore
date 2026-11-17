"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { updateProfile } from "../../../lib/api/auth";
import { authQueryKeys } from "../../../lib/api/query-keys";
import type { Principal } from "../../../lib/api/contracts";

/** Manages the editable profile fields for the authenticated account. */
export function useProfile(user: Principal) {
  const queryClient = useQueryClient();
  const [displayName, setDisplayName] = useState(user.name);

  const save = useMutation({
    mutationFn: () => updateProfile(displayName.trim()),
    retry: false,
    onSuccess: (result) => {
      queryClient.setQueryData(authQueryKeys.currentUser(), result);
      setDisplayName(result.user.name);
    },
  });

  return {
    displayName,
    setDisplayName,
    save,
  };
}
