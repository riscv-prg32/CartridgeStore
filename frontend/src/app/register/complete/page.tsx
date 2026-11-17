import { Suspense } from "react";

import { RegisterPanel } from "../../../components/auth/RegisterPanel";

export default function CompleteRegistrationPage() {
  return <Suspense fallback={<main className="p-12" aria-busy="true">Loading registration…</main>}><RegisterPanel complete /></Suspense>;
}
