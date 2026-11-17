import crypto from "node:crypto";

import { DOMParser } from "@xmldom/xmldom";

import type { BackendConfig } from "../config/env.js";
import { fetchBoundedText, OutboundValidationError, validateOutboundUrl } from "./outbound.js";

const MAX_METADATA_BYTES = 256 * 1024;

export class ProviderValidationError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "ProviderValidationError"; }
}

function mapOutboundError(error: unknown): ProviderValidationError {
  if (error instanceof OutboundValidationError) return new ProviderValidationError(error.code, error.message);
  return new ProviderValidationError("provider_fetch_failed", "provider metadata is unavailable");
}

async function fetchMetadata(url: string, config: BackendConfig): Promise<string> {
  try { return (await fetchBoundedText(url, config, { maxBytes: MAX_METADATA_BYTES })).text; }
  catch (error) { throw mapOutboundError(error); }
}

async function validateProviderUrl(urlValue: string, config: BackendConfig, invalidCode: string, invalidMessage: string): Promise<string> {
  try {
    await validateOutboundUrl(urlValue, config);
    return new URL(urlValue).toString();
  } catch (error) {
    if (error instanceof OutboundValidationError) throw new ProviderValidationError(invalidCode === "" ? error.code : invalidCode, invalidMessage === "" ? error.message : invalidMessage);
    throw mapOutboundError(error);
  }
}

function requiredUrl(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 1024) throw new ProviderValidationError("oidc_metadata_invalid", `${label} is missing`);
  try { const parsed = new URL(value); return parsed.toString(); } catch { throw new ProviderValidationError("oidc_metadata_invalid", `${label} is invalid`); }
}

export async function validateOidcDiscovery(issuerValue: string, config: BackendConfig): Promise<Record<string, unknown>> {
  let issuer: URL;
  try { issuer = new URL(issuerValue); } catch { throw new ProviderValidationError("oidc_issuer_invalid", "OIDC issuer is invalid"); }
  const discoveryUrl = new URL(".well-known/openid-configuration", issuer.toString().endsWith("/") ? issuer.toString() : `${issuer.toString()}/`);
  const document = await fetchMetadata(discoveryUrl.toString(), config);
  let parsed: unknown;
  try { parsed = JSON.parse(document) as unknown; } catch { throw new ProviderValidationError("oidc_metadata_invalid", "OIDC discovery metadata is invalid"); }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new ProviderValidationError("oidc_metadata_invalid", "OIDC discovery metadata is invalid");
  const value = parsed as Record<string, unknown>;
  if (value.issuer !== issuer.toString()) throw new ProviderValidationError("oidc_issuer_mismatch", "OIDC discovery issuer does not match the configured issuer");
  const authorizationEndpoint = requiredUrl(value.authorization_endpoint, "authorization_endpoint");
  const tokenEndpoint = requiredUrl(value.token_endpoint, "token_endpoint");
  const jwksUri = requiredUrl(value.jwks_uri, "jwks_uri");
  await validateProviderUrl(authorizationEndpoint, config, "oidc_metadata_invalid", "authorization endpoint is invalid");
  await validateProviderUrl(tokenEndpoint, config, "oidc_metadata_invalid", "token endpoint is invalid");
  await fetchMetadata(jwksUri, config);
  return { issuer: issuer.toString(), discovery_url: discoveryUrl.toString(), authorization_endpoint: authorizationEndpoint, token_endpoint: tokenEndpoint, jwks_uri: jwksUri, code_challenge_methods_supported: Array.isArray(value.code_challenge_methods_supported) ? value.code_challenge_methods_supported.filter((item): item is string => typeof item === "string").slice(0, 8) : [] };
}

function elementText(node: { readonly textContent?: string | null }): string { return String(node.textContent ?? "").trim(); }

export function parseSamlMetadata(xml: string): Record<string, unknown> {
  if (typeof xml !== "string" || Buffer.byteLength(xml, "utf8") > MAX_METADATA_BYTES || /<!DOCTYPE|<!ENTITY/iu.test(xml)) throw new ProviderValidationError("saml_metadata_invalid", "SAML metadata is invalid");
  const document = new DOMParser({ errorHandler: () => undefined }).parseFromString(xml, "text/xml");
  const root = document.documentElement;
  if (!root || (root.localName ?? root.nodeName.split(":").pop()) !== "EntityDescriptor") throw new ProviderValidationError("saml_metadata_invalid", "SAML metadata entity descriptor is missing");
  const entityId = root.getAttribute("entityID") ?? "";
  const descriptors = Array.from(root.getElementsByTagNameNS("*", "IDPSSODescriptor"));
  if (descriptors.length !== 1 || entityId.length < 1 || entityId.length > 512) throw new ProviderValidationError("saml_metadata_ambiguous", "SAML metadata must contain one identity provider descriptor");
  const descriptor = descriptors[0];
  if (!descriptor) throw new ProviderValidationError("saml_metadata_ambiguous", "SAML metadata descriptor is missing");
  const services = Array.from(descriptor.getElementsByTagNameNS("*", "SingleSignOnService"));
  const service = services.find((item) => ["urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect", "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"].includes(item.getAttribute("Binding") ?? ""));
  const location = service?.getAttribute("Location") ?? "";
  const certificates = Array.from(descriptor.getElementsByTagNameNS("*", "X509Certificate")).map(elementText).filter(Boolean);
  if (!service || !location || certificates.length !== 1) throw new ProviderValidationError("saml_metadata_incomplete", "SAML metadata is missing a unique SSO endpoint or signing certificate");
  let parsedLocation: URL;
  try { parsedLocation = new URL(location); } catch { throw new ProviderValidationError("saml_metadata_invalid", "SAML SSO endpoint is invalid"); }
  if (parsedLocation.protocol !== "https:") throw new ProviderValidationError("saml_metadata_insecure", "SAML SSO endpoint must use HTTPS");
  const certificateValue = certificates[0] ?? "";
  const certificate = certificateValue.replace(/\s+/gu, "");
  if (!/^[A-Za-z0-9+/=]+$/u.test(certificate)) throw new ProviderValidationError("saml_certificate_invalid", "SAML signing certificate is invalid");
  const lines = certificate.match(/.{1,64}/gu)?.join("\n") ?? "";
  const certificatePem = `-----BEGIN CERTIFICATE-----\n${lines}\n-----END CERTIFICATE-----`;
  let validatedPem = certificatePem;
  try { new crypto.X509Certificate(certificatePem); } catch {
    const publicKeyPem = `-----BEGIN PUBLIC KEY-----\n${lines}\n-----END PUBLIC KEY-----`;
    try { crypto.createPublicKey(publicKeyPem); validatedPem = publicKeyPem; } catch { throw new ProviderValidationError("saml_certificate_invalid", "SAML signing certificate is invalid"); }
  }
  return { idp_entity_id: entityId, saml_entry_point: parsedLocation.toString(), saml_idp_certificate_pem: validatedPem, metadata_validated: true };
}

export async function loadSamlMetadata(urlValue: string, config: BackendConfig): Promise<Record<string, unknown>> {
  const parsed = parseSamlMetadata(await fetchMetadata(urlValue, config));
  return validateParsedSamlMetadata(parsed, config);
}

export async function validateParsedSamlMetadata(metadata: Record<string, unknown>, config: BackendConfig): Promise<Record<string, unknown>> {
  const endpoint = metadata.saml_entry_point;
  if (typeof endpoint !== "string") throw new ProviderValidationError("saml_metadata_incomplete", "SAML metadata is missing a unique SSO endpoint or signing certificate");
  try { await validateOutboundUrl(endpoint, config); }
  catch (error) { throw mapOutboundError(error); }
  return metadata;
}
