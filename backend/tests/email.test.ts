import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { execFileSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import { SmtpEmailTransport, type EmailMessage } from "../src/email/service.js";

const servers: Array<net.Server | tls.Server> = [];
const roots: string[] = [];
const message: EmailMessage = { to: "user@example.test", from: "store@example.test", subject: "Fixture", text: "fixture", html: "<p>fixture</p>", createdAt: "2026-10-14T00:00:00.000Z" };

function certificate(): { key: Buffer; cert: Buffer; ca: Buffer } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "prg32-smtp-cert-"));
  roots.push(root);
  const cert = path.join(root, "cert.pem");
  const key = path.join(root, "key.pem");
  execFileSync("mkcert", ["-cert-file", cert, "-key-file", key, "127.0.0.1", "localhost"], { stdio: "ignore" });
  const caPath = execFileSync("mkcert", ["-CAROOT"], { encoding: "utf8" }).trim();
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert), ca: fs.readFileSync(path.join(caPath, "rootCA.pem")) };
}

async function listen(server: net.Server | tls.Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve()); });
  return (server.address() as net.AddressInfo).port;
}

function smtpHandler(socket: net.Socket | tls.TLSSocket, startTls: boolean, authenticated: { value: boolean }, upgrade?: () => void, greet = true): void {
  let input = "";
  let dataMode = false;
  socket.setEncoding("utf8");
  if (greet) socket.write("220 disposable-prg32-smtp ESMTP\r\n");
  socket.on("error", () => undefined);
  socket.on("data", (chunk) => {
    input += chunk;
    if (dataMode) {
      const end = input.indexOf("\r\n.\r\n");
      if (end < 0) return;
      input = input.slice(end + 5);
      dataMode = false;
      socket.write("250 2.0.0 accepted\r\n");
    }
    while (!dataMode) {
      const end = input.indexOf("\r\n");
      if (end < 0) return;
      const line = input.slice(0, end);
      input = input.slice(end + 2);
      const command = line.toUpperCase();
      if (command.startsWith("EHLO") || command.startsWith("HELO")) socket.write(startTls ? "250-disposable\r\n250 STARTTLS\r\n" : "250 disposable\r\n");
      else if (command === "STARTTLS") { socket.write("220 2.0.0 ready\r\n"); upgrade?.(); return; }
      else if (command.startsWith("AUTH PLAIN")) { authenticated.value = true; socket.write("235 2.7.0 authenticated\r\n"); }
      else if (command.startsWith("DATA")) { dataMode = true; socket.write("354 end with dot\r\n"); return; }
      else if (command.startsWith("QUIT")) { socket.write("221 bye\r\n"); socket.end(); return; }
      else socket.write("250 ok\r\n");
    }
  });
}

async function plainServer(startTls = false): Promise<{ port: number; authenticated: { value: boolean }; ca?: Buffer }> {
  const authenticated = { value: false };
  const credentials = startTls ? certificate() : undefined;
  const server = net.createServer((socket) => smtpHandler(socket, startTls, authenticated, startTls ? () => {
    const secure = new tls.TLSSocket(socket, { isServer: true, key: credentials?.key, cert: credentials?.cert });
    secure.once("secure", () => smtpHandler(secure, false, authenticated, undefined, false));
  } : undefined));
  return { port: await listen(server), authenticated, ...(credentials ? { ca: credentials.ca } : {}) };
}

async function implicitTlsServer(): Promise<{ port: number; ca: Buffer }> {
  const credentials = certificate();
  const server = tls.createServer({ key: credentials.key, cert: credentials.cert }, (socket) => smtpHandler(socket, false, { value: false }));
  return { port: await listen(server), ca: credentials.ca };
}

function transport(port: number, encryption: "none" | "starttls" | "implicit_tls", extra: Partial<{ username: string; password: string; ca: Buffer; secure: boolean }> = {}): SmtpEmailTransport {
  return new SmtpEmailTransport({ host: "127.0.0.1", port, encryption, secure: extra.secure ?? encryption === "implicit_tls", connectionTimeoutMs: 1000, deliveryTimeoutMs: 1000, ...extra });
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("SMTP transport compatibility matrix", () => {
  it("supports plain SMTP and AUTH PLAIN without exposing credentials", async () => {
    const plain = await plainServer();
    await transport(plain.port, "none", { username: "fixture-user", password: "fixture-password" }).send(message);
    expect(plain.authenticated.value).toBe(true);
  });

  it("supports STARTTLS and implicit TLS with certificate verification", async () => {
    const startTls = await plainServer(true);
    await expect(transport(startTls.port, "starttls", { ca: startTls.ca }).testConnection()).resolves.toBeUndefined();
    const implicit = await implicitTlsServer();
    await expect(transport(implicit.port, "implicit_tls", { ca: implicit.ca }).testConnection()).resolves.toBeUndefined();
  });

  it("supports the explicit secure flag for implicit TLS", async () => {
    const implicit = await implicitTlsServer();
    await expect(transport(implicit.port, "none", { secure: true, ca: implicit.ca }).testConnection()).resolves.toBeUndefined();
  });

  it("fails closed for refusal, timeout, and a server that does not offer STARTTLS", async () => {
    await expect(transport(9, "none").testConnection()).rejects.toMatchObject({ code: "email_delivery_unavailable" });
    const silent = net.createServer(() => undefined);
    const port = await listen(silent);
    await expect(transport(port, "none").testConnection()).rejects.toMatchObject({ code: "email_delivery_unavailable" });
    const noTls = await plainServer(false);
    await expect(transport(noTls.port, "starttls").testConnection()).rejects.toMatchObject({ code: "email_delivery_unavailable" });
  });
});
