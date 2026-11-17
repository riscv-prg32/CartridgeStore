import http from "node:http";
import https from "node:https";
import net from "node:net";

function targetForHost(host, targets) {
  const name = host.split(":", 1)[0].toLowerCase();
  if (name === "store.m52g14.test") return targets.store;
  if (name === "api.m52g14.test") return targets.api;
  return null;
}

function proxyRequest(request, response, target) {
  const headers = { ...request.headers, host: `127.0.0.1:${target.port}` };
  delete headers.connection;
  delete headers["keep-alive"];
  delete headers["transfer-encoding"];
  const upstream = http.request({
    host: "127.0.0.1",
    port: target.port,
    method: request.method,
    path: request.url,
    headers
  }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
    upstreamResponse.pipe(response);
  });
  upstream.on("error", () => {
    if (!response.headersSent) response.writeHead(502, { "content-type": "text/plain" });
    response.end("disposable edge upstream unavailable");
  });
  request.pipe(upstream);
}

function proxyUpgrade(request, socket, head, target) {
  const upstream = net.connect(target.port, "127.0.0.1", () => {
    const headers = Object.entries(request.headers)
      .filter(([name]) => name !== "host")
      .map(([name, value]) => `${name}: ${Array.isArray(value) ? value.join(", ") : value}`)
      .join("\r\n");
    upstream.write(`${request.method} ${request.url} HTTP/${request.httpVersion}\r\nhost: 127.0.0.1:${target.port}\r\n${headers}\r\n\r\n`);
    if (head.length > 0) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
}

export async function startEdge({ cert, key, port, targets }) {
  const server = https.createServer({ cert, key });
  server.on("request", (request, response) => {
    const target = targetForHost(request.headers.host ?? "", targets);
    if (!target) {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<!doctype html><title>disposable edge</title>");
      return;
    }
    proxyRequest(request, response, target);
  });
  server.on("upgrade", (request, socket, head) => {
    const target = targetForHost(request.headers.host ?? "", targets);
    if (!target) {
      socket.destroy();
      return;
    }
    proxyUpgrade(request, socket, head, target);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return server;
}
