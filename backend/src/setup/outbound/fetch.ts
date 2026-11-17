import http from "node:http";
import https from "node:https";

import type { BackendConfig } from "../../config/env.js";
import {
  type OutboundTargetOptions,
  OutboundValidationError,
  type ValidatedOutboundTarget,
} from "./types.js";
import { validateOutboundUrl } from "./target.js";

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_BYTES = 256 * 1024;

interface BoundedResponse {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: Buffer;
}

function requestOnce(
  url: URL,
  target: ValidatedOutboundTarget,
  timeoutMs: number,
  maxBytes: number,
): Promise<BoundedResponse> {
  const client = url.protocol === "https:" ? https : http;
  return new Promise<BoundedResponse>((resolve, reject) => {
    let settled = false;
    const fail = (error: Error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    };
    const request = client.request(
      {
        hostname: url.hostname,
        port: target.port,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers: {
          accept: "application/json, application/xml, text/xml",
          host: url.host,
        },
        lookup: target.lookup,
        ...(url.protocol === "https:"
          ? { rejectUnauthorized: true, servername: url.hostname }
          : {}),
      },
      (response) => {
        const chunks: Buffer[] = [];
        let total = 0;
        response.on("data", (chunk: Buffer | string) => {
          const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          total += value.byteLength;
          if (total > maxBytes) {
            response.destroy();
            fail(
              new OutboundValidationError(
                "provider_metadata_too_large",
                "provider metadata is too large",
              ),
            );
            return;
          }
          chunks.push(value);
        });
        response.on("end", () => {
          if (settled) return;
          settled = true;
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks, total),
          });
        });
        response.on("error", (error) => fail(error));
      },
    );
    request.setTimeout(timeoutMs, () =>
      request.destroy(new Error("outbound request timed out")),
    );
    request.on("error", (error) => fail(error));
    request.end();
  }).catch((error) => {
    if (error instanceof OutboundValidationError) throw error;
    throw new OutboundValidationError(
      "provider_fetch_failed",
      "provider metadata is unavailable",
    );
  });
}

/** Fetches bounded provider metadata while revalidating every redirect. */
export async function fetchBoundedText(
  urlValue: string,
  config: BackendConfig,
  options: Pick<OutboundTargetOptions, "allowedProtocols" | "lookup"> & {
    readonly maxBytes?: number;
    readonly timeoutMs?: number;
    readonly maxRedirects?: number;
  } = {},
): Promise<{ readonly url: string; readonly text: string }> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRedirects = options.maxRedirects ?? 2;
  let current: URL;
  try {
    current = new URL(urlValue);
  } catch {
    throw new OutboundValidationError(
      "provider_url_invalid",
      "outbound URL is invalid",
    );
  }
  for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
    const target = await validateOutboundUrl(current.toString(), config, {
      ...(options.allowedProtocols === undefined
        ? {}
        : { allowedProtocols: options.allowedProtocols }),
      ...(options.lookup === undefined ? {} : { lookup: options.lookup }),
    });
    const response = await requestOnce(current, target, timeoutMs, maxBytes);
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.location;
      if (!location || redirect === maxRedirects) {
        throw new OutboundValidationError(
          "provider_redirect_invalid",
          "provider metadata redirect chain is invalid",
        );
      }
      try {
        current = new URL(location, current);
      } catch {
        throw new OutboundValidationError(
          "provider_redirect_invalid",
          "provider metadata redirect is invalid",
        );
      }
      continue;
    }
    if (response.status < 200 || response.status >= 300) {
      throw new OutboundValidationError(
        "provider_fetch_failed",
        "provider metadata is unavailable",
      );
    }
    return { url: current.toString(), text: response.body.toString("utf8") };
  }
  throw new OutboundValidationError(
    "provider_redirect_invalid",
    "provider metadata redirect chain is invalid",
  );
}
