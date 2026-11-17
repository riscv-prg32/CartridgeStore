/**
 * Shared input parsing and response serialization for admin routes.
 */

import type {
  FastifyReply,
  FastifyRequest
} from "fastify";

import { encodePythonJson } from "../compatibility/serialization.js";
import { AdminError } from "./errors.js";

/** JSON object accepted by an administrative request handler. */
export type JsonObject = Record<string, unknown>;

export interface UserParams {
  readonly userId: string;
}

export interface GroupParams {
  readonly groupId: string;
}

export interface TokenParams {
  readonly tokenId: string;
}

export interface CartridgeParams {
  readonly cartridgeId: string;
}

/** Serializes an admin response using the established Python-compatible JSON. */
export function json(
  reply: FastifyReply,
  body: unknown,
  status = 200
): FastifyReply {
  return reply
    .code(status)
    .header("content-type", "application/json")
    .send(Buffer.from(`${encodePythonJson(body)}\n`, "utf8"));
}

/** Requires a JSON object body or query payload. */
export function object(value: unknown): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new AdminError(
      "invalid_json_object",
      400,
      "request body must be a JSON object"
    );
  }
  return value as JsonObject;
}

/** Rejects fields that are not part of the route's public contract. */
export function assertFields(
  value: JsonObject,
  allowed: readonly string[]
): void {
  const permitted = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !permitted.has(key));
  if (unknown) {
    throw new AdminError(
      "unknown_field",
      400,
      "request contains an unknown field"
    );
  }
}

/** Parses a bounded positive integer query parameter. */
export function positiveQuery(
  value: unknown,
  field: string,
  fallback: number,
  maximum: number
): number {
  if (value === undefined || value === "") return fallback;
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new AdminError("invalid_pagination", 400, `${field} is invalid`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new AdminError("invalid_pagination", 400, `${field} is invalid`);
  }
  return parsed;
}

/** Returns the request query as an object. */
export function queryObject(request: FastifyRequest): JsonObject {
  const query = request.query;
  if (query === null || typeof query !== "object" || Array.isArray(query)) {
    throw new AdminError("invalid_query", 400, "query is invalid");
  }
  return query as JsonObject;
}

/** Parses a numeric user route parameter. */
export function userId(params: UserParams): number {
  if (!/^\d+$/.test(params.userId)) {
    throw new AdminError("invalid_identifier", 400, "user_id is invalid");
  }
  return Number(params.userId);
}

/** Parses a numeric group route parameter. */
export function groupId(params: GroupParams): number {
  if (!/^\d+$/.test(params.groupId)) {
    throw new AdminError("invalid_identifier", 400, "group_id is invalid");
  }
  return Number(params.groupId);
}

/** Parses a positive numeric token route parameter. */
export function tokenId(params: TokenParams): number {
  if (!/^[1-9]\d*$/.test(params.tokenId)) {
    throw new AdminError("invalid_identifier", 400, "token_id is invalid");
  }
  const parsed = Number(params.tokenId);
  if (!Number.isSafeInteger(parsed)) {
    throw new AdminError("invalid_identifier", 400, "token_id is invalid");
  }
  return parsed;
}

/** Parses a non-empty cartridge route parameter. */
export function cartridgeId(params: CartridgeParams): string {
  if (
    typeof params.cartridgeId !== "string" ||
    !params.cartridgeId.trim()
  ) {
    throw new AdminError("invalid_identifier", 400, "cartridge_id is invalid");
  }
  return params.cartridgeId;
}

/** Reads the required version query parameter. */
export function requiredVersion(query: JsonObject): string {
  if (typeof query.version !== "string" || !query.version.trim()) {
    throw new AdminError("version_required", 400, "version is required");
  }
  return query.version;
}

/** Reads an optional bounded string query parameter. */
export function optionalString(
  query: JsonObject,
  field: string,
  maximum = 160
): string | undefined {
  if (query[field] === undefined) return undefined;
  if (typeof query[field] !== "string" || query[field].length > maximum) {
    throw new AdminError("invalid_filter", 400, `${field} is invalid`);
  }
  return query[field].trim();
}
