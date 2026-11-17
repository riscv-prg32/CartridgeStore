import { Suspense } from "react";

import { RegisterPanel } from "../../components/auth/RegisterPanel";

export default function RegisterPage() {
  return <Suspense fallback={<main className="p-12" aria-busy="true">Loading registration…</main>}><RegisterPanel /></Suspense>;
}
