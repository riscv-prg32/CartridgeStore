import { adminRequest, adminQuery } from "./transport";
import type { AdminAuditEventResponse, AdminAuditResponse } from "./types";

/** Lists recent administrative audit events. */
export function listAdminAudit(limit = 100): Promise<AdminAuditResponse> {
  return adminRequest(`/api/admin/audit${adminQuery({ limit })}`);
}

/** Reads one administrative audit event by stable identifier. */
export function getAdminAuditEvent(eventId: string): Promise<AdminAuditEventResponse> {
  return adminRequest(`/api/admin/audit/${encodeURIComponent(eventId)}`);
}
