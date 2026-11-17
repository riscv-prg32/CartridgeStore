import { CliError, mapHttpStatus } from "./errors.js";
import { requireServer, requireToken, type GlobalOptions } from "./config.js";

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export interface RequestOptions {
  readonly method?: "GET" | "POST" | "PATCH" | "DELETE";
  readonly body?: BodyInit;
  readonly contentType?: string;
  readonly auth?: boolean;
}

export class StoreClient {
  readonly baseUrl: string;
  constructor(private readonly options: GlobalOptions) { this.baseUrl = requireServer(options); }

  async request<T>(route: string, requestOptions: RequestOptions = {}): Promise<T> {
    const url = new URL(route, `${this.baseUrl}/`);
    const headers = new Headers({ accept: "application/json" });
    if (requestOptions.contentType) headers.set("content-type", requestOptions.contentType);
    if (requestOptions.auth !== false) headers.set("authorization", `Bearer ${requireToken(this.options)}`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    let response: Response;
    try {
      response = await fetch(url, { method: requestOptions.method ?? "GET", headers, ...(requestOptions.body === undefined ? {} : { body: requestOptions.body }), redirect: "manual", signal: controller.signal });
    } catch (error) {
      clearTimeout(timer);
      if (error instanceof DOMException && error.name === "AbortError") throw new CliError("timeout", "request timed out", 6);
      throw new CliError("network", "request could not reach the server", 6);
    }
    clearTimeout(timer);
    if (response.status >= 300 && response.status < 400) throw new CliError("redirect_rejected", "server returned an unsafe redirect", 6);
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > MAX_RESPONSE_BYTES) throw new CliError("response_too_large", "server response exceeds the CLI limit", 1);
    let bytes: Uint8Array;
    try { bytes = new Uint8Array(await response.arrayBuffer()); } catch { throw new CliError("response_invalid", "server response could not be read", 1); }
    if (bytes.byteLength > MAX_RESPONSE_BYTES) throw new CliError("response_too_large", "server response exceeds the CLI limit", 1);
    let parsed: unknown;
    try { parsed = bytes.byteLength === 0 ? {} : JSON.parse(new TextDecoder().decode(bytes)) as unknown; }
    catch { throw new CliError("response_invalid", "server returned invalid JSON", 1); }
    if (!response.ok) {
      const record = parsed !== null && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
      const code = typeof record.code === "string" ? record.code : typeof record.error === "object" && record.error !== null && typeof (record.error as Record<string, unknown>).code === "string" ? (record.error as Record<string, unknown>).code as string : "http_error";
      const message = typeof record.error === "string" ? record.error : "server rejected the request";
      throw new CliError(code, message, mapHttpStatus(response.status));
    }
    return parsed as T;
  }

  async upload<T>(route: string, file: Uint8Array, fileName: string): Promise<T> {
    const form = new FormData();
    form.append("bundle", new Blob([Buffer.from(file)], { type: "application/zip" }), fileName);
    return this.request<T>(route, { method: "POST", body: form });
  }
}
