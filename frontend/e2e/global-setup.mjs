import crypto from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import zlib from "node:zlib";

import { startEdge } from "./edge.mjs";

const repo = path.resolve(import.meta.dirname, "../..");
const frontend = path.join(repo, "frontend");
const backend = path.join(repo, "backend");
const requireBackend = createRequire(path.join(backend, "package.json"));
const Database = requireBackend("better-sqlite3");
const { SignedXml } = requireBackend("xml-crypto");
const jose = await import(pathToFileURL(path.join(backend, "node_modules/jose/dist/webapi/index.js")).href);

const STORE_HOST = "store.m52g14.test";
const API_HOST = "api.m52g14.test";
const EVIL_HOST = "evil.m52g14.test";
const PASSWORD = "browser-fixture-password-2026";
const BOOTSTRAP_TOKEN = "m52g14-disposable-bootstrap-token-do-not-reuse";

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function startSmtpCapture(capturePath) {
  const server = net.createServer((socket) => {
    let buffer = "";
    let dataMode = false;
    socket.write("220 disposable-prg32-smtp ESMTP\r\n");
    socket.on("error", () => undefined);
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (dataMode) {
      const end = buffer.indexOf("\r\n.\r\n");
      if (end < 0) return;
        const raw = buffer.slice(0, end);
        fs.appendFileSync(capturePath, `${JSON.stringify({ raw })}\n`, { mode: 0o600 });
        buffer = buffer.slice(end + 5);
        dataMode = false;
        socket.write("250 2.0.0 accepted\r\n");
      }
      while (!dataMode) {
        const end = buffer.indexOf("\r\n");
        if (end < 0) return;
        const line = buffer.slice(0, end).trim().toUpperCase();
        buffer = buffer.slice(end + 2);
        if (line.startsWith("EHLO") || line.startsWith("HELO")) socket.write("250 OK\r\n");
        else if (line.startsWith("DATA")) { dataMode = true; socket.write("354 End data with <CR><LF>.<CR><LF>\r\n"); return; }
        else if (line.startsWith("QUIT")) { socket.write("221 2.0.0 bye\r\n"); socket.end(); return; }
        else socket.write("250 2.0.0 ok\r\n");
      }
    });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "0.0.0.0", resolve); });
  return { server, port: server.address().port };
}

async function waitFor(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "unavailable";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok || response.status === 401 || response.status === 404) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timed out waiting for ${url}: ${lastError}`);
}

async function waitForEdge(port, host, pathname, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "unavailable";
  while (Date.now() < deadline) {
    try {
      const status = await new Promise((resolve, reject) => {
        const request = https.get({
          hostname: "127.0.0.1",
          port,
          path: pathname,
          headers: { host },
          rejectUnauthorized: false
        }, (response) => {
          response.resume();
          response.once("end", () => resolve(response.statusCode ?? 0));
        });
        request.once("error", reject);
      });
      if (status >= 200 && status < 300) return;
      lastError = `HTTP ${status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timed out waiting for https://${host}:${port}${pathname}: ${lastError}`);
}

function startProcess(command, args, cwd, env, logPath) {
  const output = fs.openSync(logPath, "a", 0o600);
  const child = spawn(command, args, {
    cwd,
    env,
    detached: true,
    stdio: ["ignore", output, output]
  });
  child.once("error", (error) => fs.appendFileSync(logPath, `${error.stack ?? error}\n`));
  child.once("close", () => { try { fs.closeSync(output); } catch { /* child already closed */ } });
  return child;
}

function stopProcess(pid) {
  if (!pid) return;
  try { process.kill(-pid, "SIGTERM"); } catch { try { process.kill(pid, "SIGTERM"); } catch { return; } }
}

function writeCertificate(tempRoot) {
  const cert = path.join(tempRoot, "edge-cert.pem");
  const key = path.join(tempRoot, "edge-key.pem");
  execFileSync("mkcert", ["-cert-file", cert, "-key-file", key, STORE_HOST, API_HOST, EVIL_HOST, "host.docker.internal", "localhost", "127.0.0.1"], { stdio: "ignore" });
  const caRoot = execFileSync("mkcert", ["-CAROOT"], { encoding: "utf8" }).trim();
  return { cert: fs.readFileSync(cert), key: fs.readFileSync(key), ca: fs.readFileSync(path.join(caRoot, "rootCA.pem")) };
}

function signXml(xml, privateKey, xpath, location) {
  const signature = new SignedXml({
    privateKey,
    canonicalizationAlgorithm: "http://www.w3.org/2001/10/xml-exc-c14n#",
    signatureAlgorithm: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"
  });
  signature.addReference({
    xpath,
    transforms: ["http://www.w3.org/2000/09/xmldsig#enveloped-signature", "http://www.w3.org/2001/10/xml-exc-c14n#"],
    digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256"
  });
  signature.computeSignature(xml, { location: { reference: location, action: "append" } });
  return signature.getSignedXml();
}

function signedSamlResponse(requestId, acsUrl, issuer, privateKey, subject, audience) {
  const persistent = "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent";
  const now = new Date();
  const issueInstant = now.toISOString();
  const notOnOrAfter = new Date(now.getTime() + 5 * 60_000).toISOString();
  const responseId = `_${crypto.randomBytes(24).toString("base64url")}`;
  const assertionId = `_${crypto.randomBytes(24).toString("base64url")}`;
  const bare = `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${responseId}" Version="2.0" IssueInstant="${issueInstant}" Destination="${acsUrl}" InResponseTo="${requestId}"><saml:Issuer>${issuer}</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status><saml:Assertion ID="${assertionId}" Version="2.0" IssueInstant="${issueInstant}"><saml:Issuer>${issuer}</saml:Issuer><saml:Subject><saml:NameID Format="${persistent}">browser-saml-subject</saml:NameID><saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData InResponseTo="${requestId}" Recipient="${acsUrl}" NotOnOrAfter="${notOnOrAfter}"/></saml:SubjectConfirmation></saml:Subject><saml:Conditions NotBefore="${issueInstant}" NotOnOrAfter="${notOnOrAfter}"><saml:AudienceRestriction><saml:Audience>${audience}</saml:Audience></saml:AudienceRestriction></saml:Conditions><saml:AuthnStatement AuthnInstant="${issueInstant}" SessionIndex="_session"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement></saml:Assertion></samlp:Response>`;
  const assertionSigned = signXml(bare, privateKey, "//*[local-name(.)='Assertion']", "//*[local-name(.)='Assertion']");
  return signXml(assertionSigned, privateKey, "//*[local-name(.)='Response']", "//*[local-name(.)='Response']");
}

async function startOidcProvider({ tlsOptions } = {}) {
  let signing = await jose.generateKeyPair("RS256");
  let publicJwk = await jose.exportJWK(signing.publicKey);
  const pending = new Map();
  const provider = { server: null, issuer: "", subject: "browser-oidc-subject" };
  const handler = async (request, response) => {
    const url = new URL(request.url ?? "/", provider.issuer);
    const send = (status, body) => {
      const encoded = JSON.stringify(body);
      response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(encoded) });
      response.end(encoded);
    };
    if (url.pathname === "/.well-known/openid-configuration") {
      send(200, { issuer: provider.issuer, authorization_endpoint: `${provider.issuer}authorize`, token_endpoint: `${provider.issuer}token`, jwks_uri: `${provider.issuer}jwks`, id_token_signing_alg_values_supported: ["RS256"] });
      return;
    }
    if (url.pathname === "/jwks") {
      send(200, { keys: [{ ...publicJwk, kid: "browser-key", alg: "RS256", use: "sig" }] });
      return;
    }
    if (url.pathname === "/authorize") {
      const redirectUri = url.searchParams.get("redirect_uri");
      const clientId = url.searchParams.get("client_id");
      const state = url.searchParams.get("state");
      const challenge = url.searchParams.get("code_challenge");
      const nonce = url.searchParams.get("nonce");
      if (!redirectUri || !clientId || !state || !challenge || !nonce) { send(400, { error: "invalid_request" }); return; }
      const code = crypto.randomBytes(24).toString("base64url");
      pending.set(code, { redirectUri, clientId, challenge, nonce });
      const callback = new URL(redirectUri);
      callback.searchParams.set("code", code);
      callback.searchParams.set("state", state);
      response.writeHead(302, { location: callback.toString() });
      response.end();
      return;
    }
    if (url.pathname === "/token" && request.method === "POST") {
      const chunks = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
      const record = pending.get(form.get("code"));
      const verifier = form.get("code_verifier") ?? "";
      const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
      if (!record || record.clientId !== form.get("client_id") || record.redirectUri !== form.get("redirect_uri") || record.challenge !== challenge) { send(400, { error: "invalid_grant" }); return; }
      pending.delete(form.get("code"));
      const idToken = await new jose.SignJWT({ sub: provider.subject, email: "browser-oidc@example.test", preferred_username: "browser-oidc", name: "Browser OIDC", nonce: record.nonce })
        .setProtectedHeader({ alg: "RS256", kid: "browser-key" }).setIssuer(provider.issuer).setAudience(record.clientId).setIssuedAt().setExpirationTime("5m").sign(signing.privateKey);
      send(200, { access_token: "synthetic-access-token", token_type: "Bearer", expires_in: 300, id_token: idToken });
      return;
    }
    send(404, { error: "not_found" });
  };
  const server = tlsOptions ? https.createServer(tlsOptions, handler) : http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "0.0.0.0", resolve));
  const address = server.address();
  provider.server = server;
  provider.issuer = `${tlsOptions ? "https" : "http"}://127.0.0.1:${address.port}/`;
  return provider;
}

async function startSamlProvider({ acsUrl, audience, tlsOptions } = {}) {
  const keys = crypto.generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { format: "pem", type: "pkcs8" }, publicKeyEncoding: { format: "pem", type: "spki" } });
  const provider = { server: null, issuer: "", privateKey: keys.privateKey, publicKey: keys.publicKey };
  const handler = (request, response) => {
    const url = new URL(request.url ?? "/", provider.issuer);
    if (url.pathname !== "/sso") { response.writeHead(404); response.end(); return; }
    const encoded = url.searchParams.get("SAMLRequest");
    const relayState = url.searchParams.get("RelayState");
    if (!encoded || !relayState) { response.writeHead(400); response.end("invalid request"); return; }
    const requestXml = zlib.inflateRawSync(Buffer.from(encoded, "base64")).toString("utf8");
    const requestId = requestXml.match(/\bID="([^"]+)"/)?.[1];
    if (!requestId) { response.writeHead(400); response.end("invalid request"); return; }
    const signed = signedSamlResponse(requestId, acsUrl, provider.issuer, provider.privateKey, "browser-saml-subject", audience);
    const samlResponse = Buffer.from(signed, "utf8").toString("base64");
    const html = `<!doctype html><form id="sso" method="post" action="${acsUrl}"><input name="SAMLResponse" value="${samlResponse}"><input name="RelayState" value="${relayState}"></form><script>document.getElementById('sso').submit()</script>`;
    response.writeHead(200, { "content-type": "text/html", "content-length": Buffer.byteLength(html) });
    response.end(html);
  };
  const server = tlsOptions ? https.createServer(tlsOptions, handler) : http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "0.0.0.0", resolve));
  const address = server.address();
  provider.server = server;
  provider.issuer = `${tlsOptions ? "https" : "http"}://127.0.0.1:${address.port}/saml`;
  provider.entryPoint = `${tlsOptions ? "https" : "http"}://127.0.0.1:${address.port}/sso`;
  return provider;
}

async function seedCanonical(root, storeOrigin, apiOrigin, oidc, saml, federationOrigin = storeOrigin) {
  const databaseModule = await import(pathToFileURL(path.join(backend, "dist/storage-v2/database.js")).href);
  const objectsModule = await import(pathToFileURL(path.join(backend, "dist/storage-v2/objects.js")).href);
  const migrationModule = await import(pathToFileURL(path.join(backend, "dist/db/federation-migrations.js")).href);
  const authModule = await import(pathToFileURL(path.join(backend, "dist/auth/service.js")).href);
  const providerModule = await import(pathToFileURL(path.join(backend, "dist/federation/provider.js")).href);
  const identityModule = await import(pathToFileURL(path.join(backend, "dist/federation/identity.js")).href);
  const provisioningModule = await import(pathToFileURL(path.join(backend, "dist/federation/provisioning.js")).href);
  const prg32Module = await import(pathToFileURL(path.join(backend, "dist/submission/prg32.js")).href);
  const storage = databaseModule.initializeDisposableStorage(root);
  const timestamp = "2026-10-14T00:00:00.000Z";
  storage.sqlite.prepare("INSERT INTO users(id, username, email, password_hash, role, external_id, external_provider, created_at) VALUES (1, 'federated-browser', 'federated-browser@example.test', NULL, 'user', 'browser-oidc-subject', 'legacy-browser-oidc', ?)").run(timestamp);
  storage.sqlite.prepare("INSERT INTO users(id, username, email, password_hash, role, external_id, external_provider, created_at) VALUES (3, 'federated-saml-browser', 'federated-saml@example.test', NULL, 'user', 'browser-saml-subject', 'legacy-browser-saml', ?)").run(timestamp);
  storage.sqlite.prepare("INSERT INTO users(id, username, email, password_hash, role, created_at) VALUES (2, 'browser-admin', 'browser-admin@example.test', ?, 'admin', ?)").run(authModule.generateWerkzeugScryptHash(PASSWORD), timestamp);
  storage.sqlite.prepare("INSERT OR IGNORE INTO groups(name) VALUES ('editors')").run();
  const editorsGroup = storage.sqlite.prepare("SELECT id FROM groups WHERE name = 'editors'").get();
  if (editorsGroup?.id) storage.sqlite.prepare("INSERT OR IGNORE INTO user_groups(user_id, group_id) VALUES (2, ?)").run(editorsGroup.id);
  const objectStore = new objectsModule.ObjectStore(storage.sqlite, storage.paths);
  const legacy = Buffer.alloc(84);
  legacy.write("PRG2", 0, "ascii");
  legacy.writeUInt16LE(1, 4);
  legacy.writeUInt16LE(72, 8);
  legacy.writeUInt32LE(12, 16);
  Buffer.from("130000001300000013000000", "hex").copy(legacy, 72);
  const iconBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR42mNk+M/wHwAF/gL+KcY5WQAAAABJRU5ErkJggg==", "base64");
  const cartridge = Buffer.from(prg32Module.buildSubmissionCartridge(legacy, {
    abi: "prg32-metadata-1.0",
    id: "browser-fixture",
    title: "Browser Fixture",
    version: "1.0.0",
    authors: [{ name: "Synthetic" }],
    tags: ["e2e", "fixture"],
    runtime: { architecture: "qemu" },
    assets: { icon: "embedded" }
  }, iconBytes, "qemu", iconBytes, {
    abi: "prg32-colophon-1.0",
    title: "Browser Fixture",
    version: "1.0.0",
    developer: { name: "Synthetic" },
    authors: [{ name: "Synthetic" }],
    controls: []
  }));
  const artifact = objectStore.store("artifact", cartridge, "application/vnd.prg32.cartridge", { objectId: "obj_1111111111111111" });
  const icon = objectStore.store("media", iconBytes, "image/png", { objectId: "obj_2222222222222222" });
  const screenshot = objectStore.store("media", iconBytes, "image/png", { objectId: "obj_3333333333333333" });
  storage.sqlite.prepare("INSERT INTO cartridges(cartridge_id, created_at, updated_at, publisher_user_id, state) VALUES (?, ?, ?, 1, 'active')").run("browser-fixture", timestamp, timestamp);
  storage.sqlite.prepare("INSERT INTO releases(release_id, cartridge_id, version, revision, state, title, summary, authors_json, tags_json, metadata_json, colophon_json, created_at, published_at, published_order, created_by_user_id) VALUES (?, ?, '1.0.0', 1, 'published', ?, ?, ?, ?, ?, ?, ?, ?, 1, 1)").run("release-browser-fixture", "browser-fixture", "Browser Fixture", "Two-origin fixture", JSON.stringify([{ name: "Synthetic" }]), JSON.stringify(["e2e", "fixture"]), JSON.stringify({ genre: "verification" }), JSON.stringify({ abi: "prg32-colophon-1.0", title: "Browser Fixture", version: "1.0.0", developer: { name: "Synthetic" }, authors: [{ name: "Synthetic" }], controls: [] }), timestamp, timestamp);
  storage.sqlite.prepare("INSERT INTO artifacts(artifact_id, release_id, architecture, object_id, compatibility_json, state, created_at) VALUES ('artifact-browser-fixture', 'release-browser-fixture', 'qemu', ?, ?, 'published', ?)").run(artifact.objectId, JSON.stringify({ legacyPublicVariant: { architecture: "qemu", size: artifact.sizeBytes, sha256: artifact.sha256, has_screenshot: true, has_signature: false } }), timestamp);
  storage.sqlite.prepare("INSERT INTO media(media_id, release_id, architecture, kind, object_id, created_at) VALUES ('media-browser-icon', 'release-browser-fixture', 'qemu', 'icon', ?, ?), ('media-browser-screenshot', 'release-browser-fixture', 'qemu', 'screenshot', ?, ?)").run(icon.objectId, timestamp, screenshot.objectId, timestamp);
  const epoch = Math.floor(Date.parse(timestamp) / 1000);
  storage.sqlite.prepare("INSERT INTO scores(game, player, score, created_at, submitted_by) VALUES ('browser-fixture', 'Synthetic Player', 1234, ?, 'browser-e2e')").run(epoch);
  storage.sqlite.prepare("INSERT INTO runs(run_id, board_id, target, display_backend, firmware_version, firmware_git_sha, game_name, sample_period_frames, started_at, finished_at, dropped_samples, submitted_by, user_id) VALUES ('browser-run-1', 'qemu-e2e', 'qemu', 'synthetic', '0.1.0', 'browser-e2e', 'Browser Fixture', 1, ?, ?, 0, 'browser-e2e', 2)").run(epoch, epoch + 4);
  storage.sqlite.prepare("INSERT INTO samples(run_id, frame, timestamp_ms, update_us, draw_us, present_us, frame_us, heap_free, heap_min_free, input_mask, fps_x100, upload_queue_depth, deadline_missed) VALUES ('browser-run-1', 1, 1000, 100, 200, 20, 320, 100000, 90000, 0, 6000, 0, 0), ('browser-run-1', 2, 1016, 110, 210, 20, 340, 100000, 90000, 0, 6000, 0, 0)").run();
  storage.sqlite.prepare("INSERT INTO download_events(cartridge_id, release_id, artifact_id, version, architecture, user_id, ip_hash, user_agent, downloaded_at, delivery_outcome) VALUES ('browser-fixture', 'release-browser-fixture', 'artifact-browser-fixture', '1.0.0', 'qemu', 2, NULL, 'browser-e2e', ?, 'completed')").run(timestamp);
  storage.close();

  const database = new Database(path.join(root, "store.sqlite"));
  migrationModule.applyFederationMigrations(database);
  const providers = new providerModule.FederationProviderService(database);
  const identities = new identityModule.FederationIdentityService(database, providers);
  const federationDocument = {
    version: 1,
    providers: [
      { providerId: "browser-oidc", protocol: "oidc", displayName: "Disposable OIDC", issuer: oidc.issuer, clientId: "browser-client", clientAuthMethod: "none", redirectUri: `${federationOrigin}/api/auth/oidc/browser-oidc/callback`, scopes: ["openid", "email", "profile"], legacyProviderIds: ["legacy-browser-oidc"] },
      { providerId: "browser-saml", protocol: "saml", displayName: "Disposable SAML", issuer: saml.issuer, idpEntityId: saml.issuer, spEntityId: `${federationOrigin}/sp`, acsUrl: `${federationOrigin}/api/auth/saml/browser-saml/acs`, samlEntryPoint: saml.entryPoint, samlNameIdFormat: "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent", samlIdpCertificatePem: saml.publicKey, samlWantAssertionsSigned: true, samlWantAuthnResponseSigned: true, legacyProviderIds: ["legacy-browser-saml"] }
    ]
  };
  provisioningModule.provisionFederation({ database, providers, identities, document: federationDocument, authorization: provisioningModule.FEDERATION_PROVISIONING_AUTHORIZATION, mode: "apply", writerRoot: root, allowHttp: true });
  providers.setEnabled("browser-oidc", true);
  providers.setEnabled("browser-saml", true);
  database.close();
}

async function operationalGlobalSetup({ freshSetup = false } = {}) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "prg32-m535-operational-browser-"));
  const root = path.join(tempRoot, "canonical");
  const keyRegistry = path.join(tempRoot, "key-registry.json");
  const backendPort = await freePort();
  const nextPort = await freePort();
  const edgePort = await freePort();
  const storeOrigin = `https://${STORE_HOST}:${edgePort}`;
  const apiOrigin = `https://${API_HOST}:${edgePort}`;
  const certificate = writeCertificate(tempRoot);
  const providerTls = { cert: certificate.cert, key: certificate.key };
  const oidc = await startOidcProvider({ tlsOptions: providerTls });
  const saml = await startSamlProvider({ acsUrl: `${apiOrigin}/api/auth/saml/browser-saml/acs`, audience: `${apiOrigin}/sp`, tlsOptions: providerTls });
  const smtpCapturePath = path.join(tempRoot, "smtp-messages.jsonl");
  fs.writeFileSync(smtpCapturePath, "", { mode: 0o600 });
  const smtp = await startSmtpCapture(smtpCapturePath);
  const providerCaPath = path.join(tempRoot, "provider-ca.pem");
  fs.writeFileSync(providerCaPath, certificate.ca, { mode: 0o600 });
  const composeFile = path.join(repo, "deploy/disposable/operational-compose.yaml");
  const composeProject = `prg32-m535-operational-${process.pid}`;
  const composeLog = path.join(tempRoot, "compose.log");
  const composeEnvironment = {
    ...process.env,
    PRG32_M534_DATA_DIR: root,
    PRG32_M534_KEY_REGISTRY: keyRegistry,
    PRG32_M534_FASTIFY_PORT: String(backendPort),
    PRG32_M534_NEXT_PORT: String(nextPort),
    PRG32_M534_STORE_ORIGIN: storeOrigin,
    PRG32_M534_API_ORIGIN: apiOrigin,
    PRG32_M534_CORS_ORIGIN: storeOrigin,
    PRG32_M534_WEBAUTHN_ENABLED: "true",
    PRG32_M534_WEBAUTHN_RP_ID: STORE_HOST,
    PRG32_M534_WEBAUTHN_ORIGINS: storeOrigin,
    PRG32_M534_SMTP_HOST: "host.docker.internal",
    PRG32_M534_SMTP_PORT: String(smtp.port),
    PRG32_M534_PROVIDER_CA: providerCaPath
  };
  if (freshSetup) {
    const databaseModule = await import(pathToFileURL(path.join(backend, "dist/storage-v2/database.js")).href);
    databaseModule.initializeDisposableStorage(root).close();
  }
  const compose = (args) => {
    const output = fs.openSync(composeLog, "a", 0o600);
    try {
      execFileSync("docker", ["compose", "-p", composeProject, "-f", composeFile, ...args], {
        cwd: repo,
        env: composeEnvironment,
        stdio: ["ignore", output, output]
      });
    } finally {
      fs.closeSync(output);
    }
  };
  let edge;
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    if (edge) await new Promise((resolve) => edge.close(resolve));
    for (const provider of [oidc, saml]) {
      if (provider.server?.listening) await new Promise((resolve) => provider.server.close(resolve));
    }
    if (smtp.server.listening) await new Promise((resolve) => smtp.server.close(resolve));
    try { compose(["down", "--volumes", "--remove-orphans"]); } catch { /* preserve the failure evidence for the report */ }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  };

  try {
    // The providers are host processes, while the application is containerized.
    // host.docker.internal is also mapped by Playwright to the local host.
    oidc.issuer = oidc.issuer.replace("127.0.0.1", "host.docker.internal");
    saml.issuer = saml.issuer.replace("127.0.0.1", "host.docker.internal");
    saml.entryPoint = saml.entryPoint.replace("127.0.0.1", "host.docker.internal");
    if (!freshSetup) await seedCanonical(root, storeOrigin, apiOrigin, oidc, saml, apiOrigin);
    execFileSync(process.execPath, [path.join(backend, "dist/secrets/keygen.js"), "--output", keyRegistry, "--id", "m535-disposable-key-1"], { stdio: "ignore" });
    // Build from the current source while retaining verified dependency
    // layers. A forced APT refresh makes a disposable browser fixture
    // depend on transient package-signature availability rather than on the
    // application under test.
    if (freshSetup || process.env.PRG32_M535_OPERATIONAL_E2E === "1") compose(["build", "fastify", "next"]);
    compose(["up", "-d"]);
    await waitFor(`http://127.0.0.1:${backendPort}/health`, 60_000);
    await waitFor(`http://127.0.0.1:${nextPort}/health`, 60_000);
    edge = await startEdge({ cert: certificate.cert, key: certificate.key, port: edgePort, targets: { store: { port: nextPort }, api: { port: backendPort } } });
    await waitForEdge(edgePort, STORE_HOST, "/");
    await waitForEdge(edgePort, STORE_HOST, "/login");
    await waitForEdge(edgePort, STORE_HOST, "/api/games");
    await waitForEdge(edgePort, STORE_HOST, "/api/auth/providers");
    await waitForEdge(edgePort, API_HOST, "/health");
    const runtimePath = path.join(tempRoot, "runtime.json");
    fs.writeFileSync(runtimePath, JSON.stringify({ tempRoot, root, edgePort, backendPort, nextPort, composeProject, composeFile, repo, operationalMode: true, freshSetup }), { mode: 0o600 });
    process.env.PRG32_M52G14_STORE_ORIGIN = storeOrigin;
    process.env.PRG32_M52G14_API_ORIGIN = apiOrigin;
    process.env.PRG32_M52G14_EVIL_ORIGIN = `https://${EVIL_HOST}:${edgePort}`;
    process.env.PRG32_M52G14_SMTP_PORT = String(smtp.port);
    process.env.PRG32_M52G14_SMTP_HOST = "host.docker.internal";
    process.env.PRG32_M52G14_SMTP_CAPTURE_PATH = smtpCapturePath;
    process.env.PRG32_M537_SAML_CERT = saml.publicKey;
    process.env.PRG32_M52G14_RUNTIME = runtimePath;
    return cleanup;
  } catch (error) {
    if (fs.existsSync(composeLog)) console.error(fs.readFileSync(composeLog, "utf8").slice(-6000));
    try {
      const diagnostics = execFileSync("docker", ["compose", "-p", composeProject, "-f", composeFile, "ps", "-a"], { cwd: repo, env: composeEnvironment, encoding: "utf8" });
      console.error(diagnostics);
      const serviceLogs = execFileSync("docker", ["compose", "-p", composeProject, "-f", composeFile, "logs", "--no-color", "fastify"], { cwd: repo, env: composeEnvironment, encoding: "utf8" });
      console.error(serviceLogs.slice(-8000));
    } catch { /* diagnostics are best effort and must not mask the setup failure */ }
    await cleanup();
    throw error;
  }
}

export default async function globalSetup() {
  if (process.env.PRG32_M537_SETUP_E2E === "1") return operationalGlobalSetup({ freshSetup: true });
  if (process.env.PRG32_M535_OPERATIONAL_E2E === "1") return operationalGlobalSetup();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "prg32-m52g14-browser-"));
  const root = path.join(tempRoot, "canonical");
  const backendPort = await freePort();
  const nextPort = await freePort();
  const edgePort = await freePort();
  const oidc = await startOidcProvider();
  const storeOrigin = `https://${STORE_HOST}:${edgePort}`;
  const apiOrigin = `https://${API_HOST}:${edgePort}`;
  const saml = await startSamlProvider({ acsUrl: `${apiOrigin}/api/auth/saml/browser-saml/acs`, audience: `${apiOrigin}/sp` });
  const smtpCapturePath = path.join(tempRoot, "smtp-messages.jsonl");
  fs.writeFileSync(smtpCapturePath, "", { mode: 0o600 });
  const smtp = await startSmtpCapture(smtpCapturePath);
  const certificate = writeCertificate(tempRoot);
  let backendProcess;
  let nextProcess;
  let edge;
  let cleaned = false;
  const nextDistDir = `.next-m52g14-${process.pid}-${nextPort}`;

  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    if (edge) await new Promise((resolve) => edge.close(resolve));
    for (const provider of [oidc, saml]) {
      if (provider.server?.listening) await new Promise((resolve) => provider.server.close(resolve));
    }
    if (smtp.server.listening) await new Promise((resolve) => smtp.server.close(resolve));
    stopProcess(nextProcess?.pid);
    stopProcess(backendProcess?.pid);
    await new Promise((resolve) => setTimeout(resolve, 500));
    fs.rmSync(path.join(frontend, nextDistDir), { recursive: true, force: true });
    fs.rmSync(tempRoot, { recursive: true, force: true });
  };

  try {
    await seedCanonical(root, storeOrigin, apiOrigin, oidc, saml, apiOrigin);
    const commonEnv = {
      ...process.env,
      NODE_ENV: "development",
      PRG32_BACKEND_HOST: "127.0.0.1",
      PRG32_BACKEND_PORT: String(backendPort),
      PRG32_BACKEND_DB: path.join(root, "store.sqlite"),
      PRG32_BACKEND_STORE_DATA: root,
      PRG32_BACKEND_CATALOG_READ_MODE: "canonical-disposable",
      PRG32_BACKEND_CANONICAL_STORAGE_ROOT: root,
      PRG32_BACKEND_CANONICAL_READ_AUTHORIZATION: "M5.2G1-DISPOSABLE-CANONICAL-READ",
      PRG32_BACKEND_CANONICAL_WORKFLOW_MODE: "disposable",
      PRG32_BACKEND_CANONICAL_WRITE_AUTHORIZATION: "M5.2G2-DISPOSABLE-CANONICAL-WRITE",
      PRG32_BACKEND_CANDIDATE_MODE: "two-service-disposable",
      PRG32_BACKEND_CANDIDATE_AUTHORIZATION: "M5.2G9-DISPOSABLE-TWO-SERVICE-CANDIDATE",
      PRG32_BACKEND_AUTH_WRITE_ENABLED: "true",
      PRG32_BACKEND_AUTH_WRITE_MODE: "test",
      PRG32_BACKEND_AUTH_WRITE_DB: path.join(root, "store.sqlite"),
      PRG32_BACKEND_AUTH_DISPOSABLE_ROOT: root,
      PRG32_BACKEND_EMAIL_TRANSPORT: "memory",
      // The disposable providers and SMTP capture run on the host. This is
      // an explicit test-only exception; production keeps the allowlist
      // operator-configured and exact-match only.
      PRG32_BACKEND_SETUP_NETWORK_TEST_ALLOWLIST: "host.docker.internal,127.0.0.1,localhost",
      PRG32_M52G14_SMTP_PORT: String(smtp.port),
      PRG32_BACKEND_SUBMISSION_WRITE_ENABLED: "true",
      PRG32_BACKEND_SUBMISSION_WRITE_MODE: "test",
      PRG32_BACKEND_SUBMISSION_DISPOSABLE_ROOT: root,
      PRG32_BACKEND_SESSION_SECRET: "m52g14-browser-session-secret-is-disposable-only",
      PRG32_BACKEND_BOOTSTRAP_TOKEN: BOOTSTRAP_TOKEN,
      PRG32_BACKEND_SESSION_SECURE: "true",
      PRG32_BACKEND_SESSION_SAMESITE: "lax",
      PRG32_BACKEND_SESSION_COOKIE_DOMAIN: ".m52g14.test",
      // The browser suite intentionally reuses one disposable backend across
      // independent journeys. Keep the synthetic client from exhausting the
      // production-shaped limiter before a later login ceremony.
      PRG32_BACKEND_AUTH_RATE_LIMIT_MAX: "200",
      PRG32_BACKEND_AUTH_RATE_LIMIT_WINDOW_SECONDS: "60",
      PRG32_BACKEND_FEDERATION_PUBLIC_ORIGIN: apiOrigin,
      PRG32_BACKEND_OIDC_PUBLIC_ORIGIN: apiOrigin,
      PRG32_BACKEND_FRONTEND_PUBLIC_ORIGIN: storeOrigin,
      PRG32_BACKEND_CORS_ORIGINS: storeOrigin,
      PRG32_BACKEND_WEBAUTHN_ENABLED: "true",
      PRG32_BACKEND_WEBAUTHN_RP_ID: STORE_HOST,
      PRG32_BACKEND_WEBAUTHN_RP_NAME: "PRG32 Disposable Store",
      PRG32_BACKEND_WEBAUTHN_ORIGINS: storeOrigin,
      PRG32_BACKEND_MDNS_ENABLED: "false",
      PRG32_MP_MAX_PEERS: "2",
      PRG32_BACKEND_LOG_LEVEL: "error"
    };
    backendProcess = startProcess(process.execPath, ["dist/server.js"], backend, commonEnv, path.join(tempRoot, "backend.log"));
    await waitFor(`http://127.0.0.1:${backendPort}/health`);
    nextProcess = startProcess("pnpm", ["exec", "next", "dev", "--webpack", "-p", String(nextPort)], frontend, {
      ...process.env,
      NODE_ENV: "development",
      NEXT_PUBLIC_PRG32_API_ORIGIN: `http://127.0.0.1:${backendPort}`,
      NEXT_PUBLIC_AUTH_INTEGRATION_ENABLED: "true",
      PRG32_NEXT_DIST_DIR: nextDistDir,
      PRG32_STORE_DOMAIN: STORE_HOST,
      NEXT_TELEMETRY_DISABLED: "1"
    }, path.join(tempRoot, "next.log"));
    await waitFor(`http://127.0.0.1:${nextPort}/`);
    edge = await startEdge({ cert: certificate.cert, key: certificate.key, port: edgePort, targets: { store: { port: nextPort }, api: { port: backendPort } } });
    await waitForEdge(edgePort, STORE_HOST, "/");
    await waitForEdge(edgePort, STORE_HOST, "/login");
    await waitForEdge(edgePort, STORE_HOST, "/api/games");
    await waitForEdge(edgePort, STORE_HOST, "/api/auth/providers");
    await waitForEdge(edgePort, API_HOST, "/health");
    const runtimePath = path.join(tempRoot, "runtime.json");
    fs.writeFileSync(runtimePath, JSON.stringify({ tempRoot, root, edgePort, backendPort, nextPort, backendPid: backendProcess.pid, nextPid: nextProcess.pid }), { mode: 0o600 });
    process.env.PRG32_M52G14_STORE_ORIGIN = storeOrigin;
    process.env.PRG32_M52G14_API_ORIGIN = apiOrigin;
    process.env.PRG32_M52G14_EVIL_ORIGIN = `https://${EVIL_HOST}:${edgePort}`;
    process.env.PRG32_M52G14_SMTP_PORT = String(smtp.port);
    process.env.PRG32_M52G14_SMTP_CAPTURE_PATH = smtpCapturePath;
    process.env.PRG32_M52G14_RUNTIME = runtimePath;
    return cleanup;
  } catch (error) {
    await cleanup();
    throw error;
  }
}
