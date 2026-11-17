import { Suspense } from "react";

import { LoginPanel } from "../../components/auth/LoginPanel";

function LoginFallback() {
  return <main className="mx-auto flex min-h-screen max-w-2xl items-center justify-center px-6 py-12" aria-busy="true">Loading sign-in…</main>;
}

export default function LoginPage() {
  return <Suspense fallback={<LoginFallback />}><LoginPanel /></Suspense>;
}
