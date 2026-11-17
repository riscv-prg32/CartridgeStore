import { requestSameOriginJson } from "./client";
import { userProfileResponseSchema, userRunResponseSchema, userRunsResponseSchema } from "./schemas";

export function getUserProfile(username: string) {
  return requestSameOriginJson(`/api/users/${encodeURIComponent(username)}`, undefined, userProfileResponseSchema);
}

export function getUserRuns(username: string, page = 1) {
  return requestSameOriginJson(`/api/users/${encodeURIComponent(username)}/runs?page=${encodeURIComponent(String(page))}`, undefined, userRunsResponseSchema);
}

export function getUserRun(username: string, runId: string) {
  return requestSameOriginJson(`/api/users/${encodeURIComponent(username)}/runs/${encodeURIComponent(runId)}`, undefined, userRunResponseSchema);
}
