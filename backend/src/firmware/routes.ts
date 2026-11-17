import type { FastifyInstance } from "fastify";

import { encodePythonJson } from "../compatibility/serialization.js";
import { FIRMWARE_MANIFEST_NAME, FirmwareError } from "./contracts.js";
import type { FirmwareService } from "./service.js";

function errorStatus(error: FirmwareError): number {
  return error.code === "not_found" ? 404 : error.code === "upstream_error" ? 502 : 422;
}

export function registerFirmwareRoutes(app: FastifyInstance, firmware: FirmwareService): void {
  app.get("/api/firmware/releases", async (_request, reply) => {
    try {
      return { format: "prg32-firmware-release-1.0", repository: firmware.repository, releases: await firmware.summaries() };
    } catch (error) {
      const message = error instanceof Error ? error.message : "firmware releases are unavailable";
      return reply.code(502).type("application/json").send(Buffer.from(`${encodePythonJson({ error: message, releases: [] })}\n`, "utf8"));
    }
  });

  app.get<{ Params: { tag: string } }>(`/api/firmware/releases/:tag/${FIRMWARE_MANIFEST_NAME}`, async (request, reply) => {
    try { return await firmware.manifest(request.params.tag); }
    catch (error) {
      if (!(error instanceof FirmwareError)) throw error;
      return reply.code(errorStatus(error)).type("application/json").send({ error: error.message, code: error.code });
    }
  });

  app.get<{ Params: { tag: string; name: string } }>("/api/firmware/releases/:tag/:name", async (request, reply) => {
    try {
      const part = await firmware.part(request.params.tag, request.params.name);
      return reply.header("content-type", "application/octet-stream").header("cache-control", "public, max-age=86400").header("x-content-sha256", part.sha256).send(part.bytes);
    } catch (error) {
      if (!(error instanceof FirmwareError)) throw error;
      return reply.code(errorStatus(error)).type("application/json").send({ error: error.message, code: error.code });
    }
  });
}
