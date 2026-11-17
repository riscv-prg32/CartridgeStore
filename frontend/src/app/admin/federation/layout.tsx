import type { ReactNode } from "react";

import { ProtectedRoute } from "../../../components/auth/ProtectedRoute";
import { FederationAdminGuard } from "../../../components/federation/FederationAdminGuard";
import { FederationAdminShell } from "../../../components/federation/FederationAdminShell";

export default function FederationLayout({ children }: Readonly<{ children: ReactNode }>) {
  return <ProtectedRoute><FederationAdminGuard><FederationAdminShell>{children}</FederationAdminShell></FederationAdminGuard></ProtectedRoute>;
}
