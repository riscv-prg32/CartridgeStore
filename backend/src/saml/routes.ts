import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { encodePythonJson } from "../compatibility/serialization.js";
import { parseCookies, serializeSessionCookie } from "../auth/session.js";
import { browserReturnLocation } from "../auth/browser-redirect.js";
import type { BackendConfig } from "../config/env.js";
import { clearSamlCorrelationCookie, SAML_CORRELATION_COOKIE, serializeSamlCorrelationCookie } from "./correlation.js";
import { SamlError, type SamlService } from "./service.js";

const SESSION_COOKIE = "prg32_ts_session";

interface ProviderParams { readonly providerId: string }

interface SamlRouteOptions {
  readonly config: BackendConfig;
  readonly saml: SamlService;
  readonly sessionLifetimeSeconds: () => number;
}

function json(reply: FastifyReply, body: unknown, status = 200): FastifyReply {
  return reply.code(status).header("content-type", "application/json").send(Buffer.from(encodePythonJson(body) + "\n", "utf8"));
}

function requestIp(request: FastifyRequest): string { return request.ip || "unknown"; }

function operationFailure(reply: FastifyReply, request: FastifyRequest, error: unknown, config: BackendConfig): FastifyReply {
  reply.header("set-cookie", clearSamlCorrelationCookie(config));
  if (error instanceof SamlError) {
    request.log.warn({ code: error.code, requestId: request.id }, "SAML request rejected");
    return json(reply, { ok: false, error: error.message, code: error.code, ...(error.details ?? {}) }, error.statusCode);
  }
  request.log.warn({ code: "saml_internal_error", requestId: request.id }, "SAML request rejected");
  return json(reply, { ok: false, error: "SAML authentication is unavailable", code: "saml_unavailable" }, 503);
}

function setCookies(reply: FastifyReply, values: readonly string[]): void { reply.header("set-cookie", values); }

function returnTo(request: FastifyRequest): string | null {
  const parsed = new URL(request.url, "http://saml.invalid");
  for (const key of parsed.searchParams.keys()) if (key !== "return_to") throw new SamlError("saml_unknown_parameter", 400, "SAML request contains an unknown parameter");
  return parsed.searchParams.get("return_to");
}

function formValue(request: FastifyRequest, key: string, maxBytes: number, required: boolean): string | null {
  if (!(request.body instanceof URLSearchParams)) throw new SamlError("saml_form_invalid", 400, "SAML form is invalid");
  const values = request.body.getAll(key);
  if (values.length > 1 || (required && values.length !== 1)) throw new SamlError("saml_form_invalid", 400, "SAML form is invalid");
  const value = values[0] ?? null;
  if (value !== null && Buffer.byteLength(value, "utf8") > maxBytes) throw new SamlError("saml_response_too_large", 413, "SAML response is too large");
  return value;
}

export function registerSamlRoutes(app: FastifyInstance, options: SamlRouteOptions): void {
  const login = async (request: FastifyRequest, reply: FastifyReply, providerId: string): Promise<FastifyReply> => {
    try {
      const result = await options.saml.start(providerId, returnTo(request), { requestId: request.id, ip: requestIp(request) });
      reply.header("cache-control", "no-store");
      setCookies(reply, [serializeSamlCorrelationCookie(options.config, result.correlationCookie)]);
      return reply.redirect(result.location);
    } catch (error) { return operationFailure(reply, request, error, options.config); }
  };

  const acs = async (request: FastifyRequest, reply: FastifyReply, providerId: string): Promise<FastifyReply> => {
    try {
      const samlResponse = formValue(request, "SAMLResponse", options.config.samlMaxResponseBytes, true);
      const relayState = formValue(request, "RelayState", options.config.samlMaxRelayStateBytes, true);
      const cookies = parseCookies(request.headers.cookie);
      const result = await options.saml.complete(providerId, samlResponse as string, relayState, cookies.get(SAML_CORRELATION_COOKIE), cookies.get(SESSION_COOKIE), { requestId: request.id, ip: requestIp(request) });
      const sessionCookie = serializeSessionCookie({ name: SESSION_COOKIE, secure: options.config.authCookieSecure, sameSite: options.config.authCookieSameSite, domain: options.config.authCookieDomain, maxAgeSeconds: options.sessionLifetimeSeconds() }, result.sessionCookie);
      setCookies(reply, [sessionCookie, clearSamlCorrelationCookie(options.config)]);
      reply.header("cache-control", "no-store");
      return reply.redirect(browserReturnLocation(options.config, result.returnPath));
    } catch (error) { return operationFailure(reply, request, error, options.config); }
  };

  const metadata = async (request: FastifyRequest, reply: FastifyReply, providerId: string): Promise<FastifyReply> => {
    try {
      const document = await options.saml.metadata(providerId);
      return reply.code(200).header("content-type", "application/samlmetadata+xml").header("cache-control", "no-store").send(document);
    } catch (error) { return operationFailure(reply, request, error, options.config); }
  };

  app.get<{ Params: ProviderParams }>("/api/auth/saml/:providerId/login", async (request, reply) => login(request, reply, request.params.providerId));
  app.post<{ Params: ProviderParams }>("/api/auth/saml/:providerId/acs", async (request, reply) => acs(request, reply, request.params.providerId));
  app.get<{ Params: ProviderParams }>("/api/auth/saml/:providerId/metadata", async (request, reply) => metadata(request, reply, request.params.providerId));
}
