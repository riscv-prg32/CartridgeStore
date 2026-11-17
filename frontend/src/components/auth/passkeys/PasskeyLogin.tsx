"use client";

import { Button } from "../../ui/button";
import { StatusMessage } from "../../ui/status";
import { usePasskeyLogin } from "./use-passkey-login";

type PasskeyLoginProps = {
  returnTo: string;
  username?: string;
};

export function PasskeyLogin({ returnTo, username = "" }: PasskeyLoginProps) {
  const { passkeyBusy, passkeyError, signInWithPasskey } = usePasskeyLogin(returnTo);

  return (
    <>
      <div className="mt-4 grid gap-2">
        <Button type="button" variant="secondary" disabled={passkeyBusy} onClick={() => void signInWithPasskey(username)}>{passkeyBusy ? "Waiting for passkey…" : "Sign in with a passkey"}</Button>
        <Button type="button" variant="secondary" disabled={passkeyBusy} onClick={() => void signInWithPasskey("")}>Use a discoverable passkey</Button>
      </div>
      {passkeyError && <StatusMessage tone="danger" className="mt-3 border-0 bg-transparent px-0 py-0">{passkeyError}</StatusMessage>}
    </>
  );
}
