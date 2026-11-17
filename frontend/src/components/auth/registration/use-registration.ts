"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { completeRegistration, requestRegistration } from "../../../lib/api/auth";
import { ApiRequestError } from "../../../lib/api/client";
import { authQueryKeys } from "../../../lib/api/query-keys";
import { removeSensitiveQueryData } from "../../../lib/auth/query-cache";

export function registrationErrorMessage(error: unknown): string {
  if (error instanceof ApiRequestError) {
    if (error.status === 409) return "An account already exists for that email.";
    if (error.status === 400) return "Check the submitted registration details.";
    if (error.status === 403) return "Your session expired. Refresh and try again.";
  }
  return "Registration could not be completed. Try again later.";
}

export function useRegistration(complete: boolean, initialToken: string) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [token, setToken] = useState(initialToken);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const registration = useMutation({
    mutationFn: () => requestRegistration(username.trim(), email.trim(), password, confirmation),
    retry: false,
  });
  const completion = useMutation({
    mutationFn: () => completeRegistration(token.trim(), password, confirmation),
    retry: false,
    onSuccess: (result) => {
      setPassword("");
      setConfirmation("");
      removeSensitiveQueryData(queryClient);
      queryClient.setQueryData(authQueryKeys.currentUser(), result);
      router.replace("/dashboard/account");
    },
  });

  return {
    email,
    setEmail,
    username,
    setUsername,
    token,
    setToken,
    password,
    setPassword,
    confirmation,
    setConfirmation,
    registration,
    completion,
    submit: () => (complete ? completion.mutate() : registration.mutate()),
  };
}
