"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { loginWithPassword } from "../../../lib/api/auth";
import { authQueryKeys } from "../../../lib/api/query-keys";
import { removeSensitiveQueryData } from "../../../lib/auth/query-cache";

export function useLocalLogin(returnTo: string) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const login = useMutation({
    mutationFn: () => loginWithPassword(username.trim(), password),
    retry: false,
    onSuccess: async () => {
      setPassword("");
      removeSensitiveQueryData(queryClient);
      await queryClient.invalidateQueries({ queryKey: authQueryKeys.currentUser() });
      router.replace(returnTo);
    },
  });

  return { username, setUsername, password, setPassword, login };
}
