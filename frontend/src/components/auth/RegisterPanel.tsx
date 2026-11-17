"use client";

import { useSearchParams } from "next/navigation";

import { RegistrationForm } from "./registration/RegistrationForm";

export function RegisterPanel({ complete = false }: { complete?: boolean }) {
  const params = useSearchParams();
  return <RegistrationForm complete={complete} initialToken={params.get("token") ?? ""} />;
}
