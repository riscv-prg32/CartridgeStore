import net from "node:net";
import tls from "node:tls";

import type { BackendConfig } from "../config/env.js";
import { DEFAULT_EMAIL_TEMPLATE_SETTINGS, renderCartridgeApprovedEmail, renderSmtpTestEmail, type CartridgeApprovedEmailData, type EmailTemplateSettings } from "./templates.js";

export interface EmailMessage {
  readonly to: string;
  readonly from: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  readonly createdAt: string;
}

export interface EmailConnectionOptions {
  readonly lookup?: net.LookupFunction;
}

export interface EmailTransport {
  send(message: EmailMessage, connection?: EmailConnectionOptions): Promise<void>;
  testConnection?(connection?: EmailConnectionOptions): Promise<void>;
  close?(): void;
}

export class EmailDeliveryError extends Error {
  readonly code = "email_delivery_unavailable";
  constructor(message = "email delivery is unavailable") { super(message); this.name = "EmailDeliveryError"; }
}

export class MemoryEmailTransport implements EmailTransport {
  readonly messages: EmailMessage[] = [];
  send(message: EmailMessage): Promise<void> { this.messages.push(message); return Promise.resolve(); }
  clear(): void { this.messages.length = 0; }
}

class DisabledEmailTransport implements EmailTransport {
  send(message: EmailMessage): Promise<void> { void message; return Promise.reject(new EmailDeliveryError()); }
}

/** Small dependency-free SMTP client for plain/TLS SMTP with AUTH PLAIN. */
export interface SmtpRuntimeConfig {
  readonly host: string;
  readonly port: number;
  readonly username?: string;
  readonly password?: string;
  /** Open an implicit TLS connection before speaking SMTP (typically port 465). */
  readonly secure: boolean;
  readonly encryption: "none" | "starttls" | "implicit_tls";
  readonly connectionTimeoutMs: number;
  readonly deliveryTimeoutMs: number;
  /** Optional explicitly configured trust anchor for disposable/private SMTP endpoints. */
  readonly ca?: string | Buffer;
}

export class SmtpEmailTransport implements EmailTransport {
  constructor(private readonly options: SmtpRuntimeConfig) {}

  async testConnection(connection?: EmailConnectionOptions): Promise<void> {
    let socket: net.Socket | tls.TLSSocket | undefined;
    try {
      socket = await openSocket({ ...this.options, ...(connection?.lookup === undefined ? {} : { lookup: connection.lookup }) });
      let client = new SmtpClient(socket, this.options.deliveryTimeoutMs);
      await client.expect(220);
      await client.command("EHLO prg32-cartridge-store", 250);
      if (!this.options.secure && this.options.encryption === "starttls") {
        await client.command("STARTTLS", 220);
        socket = await upgradeStartTls(socket, this.options.host, this.options.connectionTimeoutMs, this.options.ca, connection?.lookup);
        client = new SmtpClient(socket, this.options.deliveryTimeoutMs);
        await client.command("EHLO prg32-cartridge-store", 250);
      }
      await client.command("QUIT", 221, 250);
    } catch (error) {
      throw new EmailDeliveryError(error instanceof Error ? error.message : "SMTP connection failed");
    } finally { socket?.destroy(); }
  }

  async send(message: EmailMessage, connection?: EmailConnectionOptions): Promise<void> {
    let socket: net.Socket | tls.TLSSocket | undefined;
    try {
      socket = await openSocket({ ...this.options, ...(connection?.lookup === undefined ? {} : { lookup: connection.lookup }) });
      let client = new SmtpClient(socket, this.options.deliveryTimeoutMs);
      await client.expect(220);
      await client.command("EHLO prg32-cartridge-store", 250);
      if (!this.options.secure && this.options.encryption === "starttls") {
        await client.command("STARTTLS", 220);
        socket = await upgradeStartTls(socket, this.options.host, this.options.connectionTimeoutMs, this.options.ca, connection?.lookup);
        client = new SmtpClient(socket, this.options.deliveryTimeoutMs);
        await client.command("EHLO prg32-cartridge-store", 250);
      }
      if (this.options.username && this.options.password) {
        await client.command(`AUTH PLAIN ${Buffer.from(`\0${this.options.username}\0${this.options.password}`).toString("base64")}`, 235);
      }
      await client.command(`MAIL FROM:<${message.from}>`, 250);
      await client.command(`RCPT TO:<${message.to}>`, 250, 251);
      await client.command("DATA", 354);
      await client.data(formatMessage(message));
      await client.command("QUIT", 221, 250);
    } catch (error) {
      throw new EmailDeliveryError(error instanceof Error ? error.message : "SMTP delivery failed");
    } finally { socket?.destroy(); }
  }
}

export class EmailService {
  private templates: EmailTemplateSettings = DEFAULT_EMAIL_TEMPLATE_SETTINGS;

  constructor(private transport: EmailTransport, private from: string, private publicOrigin: string | undefined) {}

  configure(options: { readonly transport: "disabled" | "memory" | "smtp"; readonly from: string; readonly publicOrigin?: string; readonly smtp?: SmtpRuntimeConfig; readonly templates?: EmailTemplateSettings }): void {
    this.transport.close?.();
    this.from = options.from;
    this.publicOrigin = options.publicOrigin;
    this.templates = options.templates ?? DEFAULT_EMAIL_TEMPLATE_SETTINGS;
    this.transport = options.transport === "memory"
      ? new MemoryEmailTransport()
      : options.transport === "smtp" && options.smtp
        ? new SmtpEmailTransport(options.smtp)
        : new DisabledEmailTransport();
  }

  async testConnection(lookup?: net.LookupFunction): Promise<void> {
    if (!this.transport.testConnection) throw new EmailDeliveryError("SMTP transport is not configured");
    await this.transport.testConnection(lookup === undefined ? undefined : { lookup });
  }

  async sendTest(to: string, lookup?: net.LookupFunction, storeName = "PRG32 Cartridge Store"): Promise<void> {
    const template = renderSmtpTestEmail(storeName, this.managedLogoUrl(), this.templates);
    await this.transport.send({ to, from: this.from, subject: template.subject, text: template.text, html: template.html, createdAt: new Date().toISOString() }, lookup === undefined ? undefined : { lookup });
  }

  async sendRegistration(email: string, token: string): Promise<void> {
    await this.sendLink(email, "Verify your PRG32 Cartridge Store account", "/register/complete", token, "verify your email address");
  }

  async sendPasswordReset(email: string, token: string): Promise<void> {
    await this.sendLink(email, "Reset your PRG32 Cartridge Store password", "/password-reset", token, "reset your password");
  }

  async sendPasswordChanged(email: string): Promise<void> {
    const text = "Your PRG32 Cartridge Store password was changed. If this was not you, contact an administrator.";
    await this.transport.send({ to: email, from: this.from, subject: "Your PRG32 password was changed", text, html: `<p>${escapeHtml(text)}</p>`, createdAt: new Date().toISOString() });
  }

  async sendCartridgeApproved(email: string, data: CartridgeApprovedEmailData): Promise<void> {
    const logoUrl = data.logoUrl ?? this.managedLogoUrl();
    const template = logoUrl === undefined
      ? renderCartridgeApprovedEmail(data, this.templates)
      : renderCartridgeApprovedEmail({ ...data, logoUrl }, this.templates);
    await this.transport.send({
      to: email,
      from: this.from,
      subject: template.subject,
      text: template.text,
      html: template.html,
      createdAt: new Date().toISOString(),
    });
  }

  testMessages(): readonly EmailMessage[] { return this.transport instanceof MemoryEmailTransport ? this.transport.messages : []; }
  close(): void { this.transport.close?.(); }

  private managedLogoUrl(): string | undefined {
    if (this.publicOrigin === undefined) return undefined;
    try {
      return new URL("/api/assets/logo", this.publicOrigin).toString();
    } catch {
      return undefined;
    }
  }

  private async sendLink(email: string, subject: string, pathname: string, token: string, action: string): Promise<void> {
    if (!this.publicOrigin) throw new EmailDeliveryError("email public origin is not configured");
    const url = new URL(pathname, this.publicOrigin);
    url.searchParams.set("token", token);
    const text = `Use this one-time link to ${action}: ${url.toString()}\n\nThe link expires and can only be used once.`;
    await this.transport.send({ to: email, from: this.from, subject, text, html: `<p>Use this one-time link to ${escapeHtml(action)}:</p><p><a href="${escapeHtml(url.toString())}">${escapeHtml(url.toString())}</a></p><p>The link expires and can only be used once.</p>`, createdAt: new Date().toISOString() });
  }
}

export function createEmailService(config: BackendConfig): EmailService {
  const transport = config.emailTransport === "memory"
    ? new MemoryEmailTransport()
    : config.emailTransport === "smtp"
      ? new SmtpEmailTransport({ host: config.emailSmtpHost as string, port: config.emailSmtpPort, secure: config.emailSmtpPort === 465, encryption: config.emailSmtpPort === 465 ? "implicit_tls" : "starttls", connectionTimeoutMs: 10000, deliveryTimeoutMs: 10000, ...(config.emailSmtpUser ? { username: config.emailSmtpUser } : {}), ...(config.emailSmtpPassword ? { password: config.emailSmtpPassword } : {}) })
      : new DisabledEmailTransport();
  return new EmailService(transport, config.emailFrom, config.emailPublicOrigin);
}

function escapeHtml(value: string): string { return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;"); }

function formatMessage(message: EmailMessage): string {
  return [`From: ${message.from}`, `To: ${message.to}`, `Subject: ${message.subject}`, "MIME-Version: 1.0", "Content-Type: multipart/alternative; boundary=prg32-boundary", "", "--prg32-boundary", "Content-Type: text/plain; charset=utf-8", "", message.text, "", "--prg32-boundary", "Content-Type: text/html; charset=utf-8", "", message.html, "", "--prg32-boundary--", "."].join("\r\n");
}

function openSocket(options: { host: string; port: number; secure?: boolean; encryption?: SmtpRuntimeConfig["encryption"]; connectionTimeoutMs?: number; ca?: string | Buffer; lookup?: net.LookupFunction }): Promise<net.Socket | tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const implicitTls = options.secure === true || options.encryption === "implicit_tls" || (options.encryption === undefined && options.port === 465);
    const socket = implicitTls ? tls.connect({ host: options.host, port: options.port, ...(tlsServername(options.host) === undefined ? {} : { servername: tlsServername(options.host) }), ...(options.lookup === undefined ? {} : { lookup: options.lookup }), ...(options.ca === undefined ? {} : { ca: options.ca }) }) : net.connect({ host: options.host, port: options.port, ...(options.lookup === undefined ? {} : { lookup: options.lookup }) });
    socket.setTimeout(options.connectionTimeoutMs ?? 10000, () => socket.destroy(new Error("SMTP connection timed out")));
    socket.once("error", reject);
    socket.once("connect", () => resolve(socket));
    if (implicitTls) socket.once("secureConnect", () => resolve(socket));
  });
}

function upgradeStartTls(socket: net.Socket | tls.TLSSocket, host: string, timeoutMs: number, ca?: string | Buffer, lookup?: net.LookupFunction): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const secure = tls.connect({ socket, ...(tlsServername(host) === undefined ? {} : { servername: tlsServername(host) }), rejectUnauthorized: true, ...(lookup === undefined ? {} : { lookup }), ...(ca === undefined ? {} : { ca }) });
    secure.setTimeout(timeoutMs, () => secure.destroy(new Error("SMTP TLS negotiation timed out")));
    // A timed-out TLS socket can emit an error after the promise has already
    // been rejected. Keep a listener attached for the socket lifetime so the
    // expected delivery failure cannot become an unhandled process error.
    secure.on("error", reject);
    secure.once("secureConnect", () => resolve(secure));
  });
}

function tlsServername(host: string): string | undefined {
  return net.isIP(host) === 0 ? host : undefined;
}

class SmtpClient {
  private buffer = "";
  constructor(private readonly socket: net.Socket | tls.TLSSocket, private readonly timeoutMs = 10000) { socket.setEncoding("utf8"); socket.on("data", (chunk) => { this.buffer += chunk; }); }
  async expect(...codes: number[]): Promise<void> { const code = await this.response(); if (!codes.includes(code)) throw new Error(`SMTP server rejected command (${code})`); }
  async command(command: string, ...codes: number[]): Promise<void> { this.socket.write(`${command}\r\n`); await this.expect(...codes); }
  async data(value: string): Promise<void> { this.socket.write(`${value}\r\n`); await this.expect(250); }
  private async response(): Promise<number> {
    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      const first = this.buffer.match(/^(\d{3})([- ])[^\r\n]*\r?\n/);
      if (first) {
        const code = Number(first[1]);
        this.buffer = this.buffer.slice(first[0].length);
        if (first[2] === " ") return code;
        const continuation = new RegExp(`^${code} [^\\r\\n]*\\r?\\n`);
        const final = this.buffer.match(continuation);
        if (final) { this.buffer = this.buffer.slice(final[0].length); return code; }
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("SMTP response timed out");
  }
}
