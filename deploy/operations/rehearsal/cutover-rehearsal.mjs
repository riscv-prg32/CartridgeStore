#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const disposableRoot = fs.mkdtempSync(path.join(os.tmpdir(), "prg32-m5416-rehearsal-"));
const state = {
  routeOwner: "legacy",
  legacyWriter: true,
  candidateWriter: false,
  legacyWrites: 0,
  candidateWrites: 0,
  states: []
};

function bodyJson(response) {
  return new Promise((resolve, reject) => {
    let body = "";
    response.setEncoding("utf8");
    response.on("data", (chunk) => { body += chunk; });
    response.on("end", () => {
      try { resolve(body ? JSON.parse(body) : undefined); } catch (error) { reject(error); }
    });
    response.on("error", reject);
  });
}

function backendServer(name, healthy) {
  const server = http.createServer((request, response) => {
    const token = request.headers.authorization === "Bearer rehearsal-token";
    const send = (status, payload, headers = {}) => {
      const data = Buffer.from(JSON.stringify(payload));
      response.writeHead(status, { "content-type": "application/json", "content-length": data.length, ...headers });
      response.end(data);
    };
    if (request.url === "/health") return send(healthy() ? 200 : 503, { ok: healthy(), service: name, status: healthy() ? "healthy" : "unhealthy" });
    if (request.url === "/ready") return send(healthy() ? 200 : 503, { ok: healthy(), status: healthy() ? "ready" : "not_ready" });
    if (request.url === "/") return send(200, { ok: true, service: name });
    if (request.url === "/api/games") return send(200, { games: [{ id: "fixture", title: "Fixture cartridge", service: name }] });
    if (request.url === "/api/games/fixture/download") return send(200, { cartridge_id: "fixture", bytes: "synthetic-cartridge", service: name }, { "content-disposition": "attachment; filename=fixture.prg32" });
    if (request.url === "/auth/me") return token ? send(200, { authenticated: true, user: { id: "rehearsal-user" } }) : send(401, { error: "authentication_required" });
    if (request.url === "/api/admin/users") return token ? send(200, { users: [{ id: "rehearsal-user", role: "admin" }] }) : send(401, { error: "authentication_required" });
    if (request.url === "/api/multiplayer") return send(200, { protocol: "prg32-multiplayer-1.0", service: name, rooms: {} });
    if (request.method === "POST" && request.url === "/api/_rehearsal/write") {
      let data = "";
      request.on("data", (chunk) => { data += chunk; });
      request.on("end", () => {
        if (name !== "candidate") return send(409, { error: "legacy_writer_not_authorized" });
        state.candidateWrites += 1;
        send(201, { ok: true, canonical_writes: state.candidateWrites, payload: data || null });
      });
      return;
    }
    send(404, { error: "not_found" });
  });
  server.on("upgrade", (request, socket) => {
    if (request.url !== "/api/multiplayer") { socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n"); return; }
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nX-PRG32-Service: " + name + "\r\n\r\n");
    setTimeout(() => socket.end(), 10);
  });
  return server;
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function proxyServer(legacyPort, candidatePort) {
  const targetPort = () => state.routeOwner === "legacy" ? legacyPort : candidatePort;
  const proxy = http.createServer((request, response) => {
    const upstream = http.request({ hostname: "127.0.0.1", port: targetPort(), method: request.method, path: request.url, headers: { ...request.headers, host: "127.0.0.1" } }, (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });
    upstream.on("error", () => { if (!response.headersSent) response.writeHead(502); response.end(); });
    request.pipe(upstream);
  });
  proxy.on("upgrade", (request, clientSocket, head) => {
    const upstreamSocket = net.connect(targetPort(), "127.0.0.1", () => {
      const headers = Object.entries(request.headers).map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") : value}`).join("\r\n");
      upstreamSocket.write(`GET ${request.url} HTTP/1.1\r\n${headers}\r\n\r\n`);
      if (head.length) upstreamSocket.write(head);
      clientSocket.pipe(upstreamSocket).pipe(clientSocket);
    });
    upstreamSocket.on("error", () => clientSocket.destroy());
  });
  return proxy;
}

function request(port, options = {}, payload) {
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: "127.0.0.1", port, method: "GET", ...options }, async (response) => {
      try { resolve({ status: response.statusCode, headers: response.headers, body: await bodyJson(response) }); } catch (error) { reject(error); }
    });
    request.on("error", reject);
    if (payload !== undefined) request.write(payload);
    request.end();
  });
}

function websocketUpgrade(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    let data = "";
    const finish = () => {
      socket.destroy();
      resolve(data.split("\r\n")[0]);
    };
    socket.on("connect", () => socket.write("GET /api/multiplayer HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n"));
    socket.on("data", (chunk) => { data += chunk.toString(); if (data.includes("\r\n\r\n")) finish(); });
    socket.on("error", reject);
    setTimeout(() => reject(new Error("websocket upgrade timed out")), 1000).unref();
  });
}

function setWriter(owner) {
  const nextLegacy = owner === "legacy";
  const nextCandidate = owner === "candidate";
  if (nextLegacy && state.candidateWriter || nextCandidate && state.legacyWriter) throw new Error("simultaneous writers rejected");
  state.legacyWriter = nextLegacy;
  state.candidateWriter = nextCandidate;
}

function snapshot(label, extra = {}) {
  state.states.push({ label, route_owner: state.routeOwner, writer_owner: state.legacyWriter ? "legacy" : state.candidateWriter ? "candidate" : "none", canonical_writes: state.candidateWrites, ...extra });
}

async function run() {
  fs.writeFileSync(path.join(disposableRoot, "legacy-snapshot.marker"), "unchanged\n");
  let candidateHealthy = false;
  const legacy = backendServer("legacy", () => true);
  const candidate = backendServer("candidate", () => candidateHealthy);
  const legacyPort = await listen(legacy);
  const candidatePort = await listen(candidate);
  const proxy = proxyServer(legacyPort, candidatePort);
  const proxyPort = await listen(proxy);
  try {
    const failedCandidateHealth = await request(proxyPort, { path: "/health" });
    assert.equal(failedCandidateHealth.status, 200);
    state.routeOwner = "candidate";
    const candidateProbe = await request(proxyPort, { path: "/health" });
    assert.equal(candidateProbe.status, 503);
    state.routeOwner = "legacy";
    snapshot("candidate_health_failure_aborted_switch", { candidate_health_status: candidateProbe.status });

    candidateHealthy = true;
    assert.equal((await request(proxyPort, { path: "/api/games" })).status, 200);
    state.routeOwner = "candidate";
    setWriter("none");
    setWriter("candidate");
    assert.equal((await request(proxyPort, { path: "/ready" })).status, 200);
    assert.equal((await request(proxyPort, { path: "/api/games/fixture/download" })).status, 200);
    assert.equal((await request(proxyPort, { path: "/auth/me" })).status, 401);
    assert.equal((await request(proxyPort, { path: "/auth/me", headers: { authorization: "Bearer rehearsal-token" } })).status, 200);
    assert.equal((await request(proxyPort, { path: "/api/admin/users" })).status, 401);
    assert.equal((await request(proxyPort, { path: "/api/admin/users", headers: { authorization: "Bearer rehearsal-token" } })).status, 200);
    assert.equal((await request(proxyPort, { path: "/api/multiplayer" })).status, 200);
    assert.equal(await websocketUpgrade(proxyPort), "HTTP/1.1 101 Switching Protocols");
    snapshot("healthy_candidate_single_writer", { websocket_upgrade: "101 Switching Protocols" });

    setWriter("none");
    state.routeOwner = "legacy";
    setWriter("legacy");
    assert.equal((await request(proxyPort, { path: "/health" })).status, 200);
    snapshot("pre_write_rollback_relinquished_candidate", { rollback: "allowed_before_canonical_write" });

    state.routeOwner = "candidate";
    setWriter("none");
    setWriter("candidate");
    const writeResponse = await request(proxyPort, { method: "POST", path: "/api/_rehearsal/write", headers: { "content-type": "application/json", "content-length": 14 } }, '{"write":true}');
    assert.equal(writeResponse.status, 201);
    let blindRollbackBlocked = false;
    try {
      if (state.candidateWrites > 0) throw new Error("post-write rollback requires reconciliation");
      state.routeOwner = "legacy";
    } catch { blindRollbackBlocked = true; }
    assert.equal(blindRollbackBlocked, true);
    assert.equal(state.routeOwner, "candidate");
    const forwardFix = await request(proxyPort, { path: "/ready" });
    assert.equal(forwardFix.status, 200);
    snapshot("post_write_forward_fix", { blind_rollback_blocked: blindRollbackBlocked, forward_fix_preserved_writes: state.candidateWrites === 1 });

    let simultaneousWritersRejected = false;
    try { setWriter("legacy"); } catch { simultaneousWritersRejected = true; }
    assert.equal(simultaneousWritersRejected, true);
    assert.equal(fs.readFileSync(path.join(disposableRoot, "legacy-snapshot.marker"), "utf8"), "unchanged\n");
    return {
      rehearsal: "m5.4.16-disposable-cutover",
      disposable_root: true,
      states: state.states,
      endpoint_acceptance: { catalog: true, binary_download: true, auth_anonymous_401: true, auth_authenticated_200: true, admin_anonymous_401: true, admin_authenticated_200: true, health: true, readiness: true, multiplayer_http: true, multiplayer_upgrade: true },
      writer_ownership: { final_owner: "candidate", simultaneous_writers_rejected: simultaneousWritersRejected, canonical_writes: state.candidateWrites },
      rollback: { pre_write_rollback_allowed: true, blind_post_write_rollback_blocked: true, forward_fix_preserved_writes: state.candidateWrites === 1 },
      legacy_snapshot_unchanged: true,
      public_routing_changed: false
    };
  } finally {
    await close(proxy);
    await close(candidate);
    await close(legacy);
    fs.rmSync(disposableRoot, { recursive: true, force: true });
  }
}

try { process.stdout.write(`${JSON.stringify(await run())}\n`); } catch (error) {
  process.stderr.write(`${JSON.stringify({ error: error instanceof Error ? error.message : "rehearsal_failed" })}\n`);
  process.exitCode = 1;
}
