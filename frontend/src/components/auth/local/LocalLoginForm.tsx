"use client";

import { type FormEvent } from "react";

import { authErrorMessage } from "../../../lib/api/auth";
import { Button } from "../../ui/button";
import { Field } from "../../ui/input";
import { StatusMessage } from "../../ui/status";
import { useLocalLogin } from "./use-local-login";

type LocalLoginFormProps = {
  returnTo: string;
  onUsernameChange?: (username: string) => void;
};

export function LocalLoginForm({ returnTo, onUsernameChange }: LocalLoginFormProps) {
  const { username, setUsername, password, setPassword, login } = useLocalLogin(returnTo);

  function updateUsername(value: string) {
    setUsername(value);
    onUsernameChange?.(value);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!username.trim() || !password || login.isPending) return;
    login.mutate();
  }

  return (
    <form className="mt-8 max-w-md space-y-5" onSubmit={submit}>
      <Field label="Username or email" id="username" name="username" autoComplete="username" required value={username} onChange={(event) => updateUsername(event.target.value)} />
      <Field label="Password" id="password" name="password" type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} />
      {login.error && <StatusMessage tone="danger" className="border-0 bg-transparent px-0 py-0">{authErrorMessage(login.error, "login")}</StatusMessage>}
      <Button className="w-full" type="submit" disabled={login.isPending}>
        {login.isPending ? "Signing in…" : "Sign in"}
      </Button>
    </form>
  );
}
