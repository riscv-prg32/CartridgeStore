"use client";

import { startAuthentication } from "@simplewebauthn/browser";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { beginPasskeyLogin, finishPasskeyLogin } from "../../../lib/api/auth";
import { authQueryKeys } from "../../../lib/api/query-keys";
import { removeSensitiveQueryData } from "../../../lib/auth/query-cache";
import { toAuthenticationOptions } from "../../../lib/auth/webauthn-adapter";

function passkeyErrorMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === "NotAllowedError") return "Passkey sign-in was cancelled.";
  if (error instanceof TypeError) return "Passkey sign-in is unavailable.";
  return "Passkey sign-in could not be completed. Use password sign-in or try again.";
}

export function usePasskeyLogin(returnTo: string) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const mountedRef = useRef(false);
  const operationRef = useRef(0);
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const [passkeyError, setPasskeyError] = useState("");

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      operationRef.current += 1;
    };
  }, []);

  async function signInWithPasskey(username = "") {
    if (passkeyBusy) return;
    const operation = operationRef.current + 1;
    operationRef.current = operation;
    setPasskeyBusy(true);
    setPasskeyError("");
    try {
      const options = await beginPasskeyLogin(username);
      const response = await startAuthentication({ optionsJSON: toAuthenticationOptions(options) });
      await finishPasskeyLogin(response);
      if (!mountedRef.current || operationRef.current !== operation) return;
      removeSensitiveQueryData(queryClient);
      await queryClient.invalidateQueries({ queryKey: authQueryKeys.currentUser() });
      if (mountedRef.current && operationRef.current === operation) router.replace(returnTo);
    } catch (error) {
      if (mountedRef.current && operationRef.current === operation) setPasskeyError(passkeyErrorMessage(error));
    } finally {
      if (mountedRef.current && operationRef.current === operation) setPasskeyBusy(false);
    }
  }

  return { passkeyBusy, passkeyError, signInWithPasskey };
}
