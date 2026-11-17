import type Database from "better-sqlite3";

import type { SetupServiceOptions } from "./service-contracts.js";

/** Computes the infrastructure readiness projection for setup routes. */
export function readSetupInfrastructure(
  options: SetupServiceOptions,
): Record<string, unknown> {
  if (!options.database) {
    return {
      ready: false,
      fastify: true,
      canonical_sqlite: false,
      storage: false,
      writer_lease: false,
      secret_registry: false,
      bootstrap_authorization: Boolean(options.config.authBootstrapToken),
      mdns_infrastructure_allowed: false,
    };
  }

  const database = options.database;
  const metadata = database
    .prepare(
      "SELECT name FROM sqlite_master " +
        "WHERE type = 'table' AND name = 'storage_metadata'",
    )
    .get();
  const storage = metadata
    ? (
        database
          .prepare(
            "SELECT state FROM storage_metadata WHERE singleton_id = 1",
          )
          .get() as { state?: string } | undefined
      )?.state === "ready"
    : true;
  const secretRegistry = options.config.secretEncryptionEnabled
    ? Boolean(options.config.secretKeyRegistryPath)
    : true;
  const writer = Boolean(
    options.config.authWriteEnabled && options.auth.isWriteEnabled(),
  );

  return {
    ready:
      storage &&
      secretRegistry &&
      writer &&
      Boolean(options.config.authSessionSecret) &&
      Boolean(options.config.authBootstrapToken),
    fastify: true,
    canonical_sqlite: storage,
    storage,
    writer_lease: writer,
    secret_registry: secretRegistry,
    bootstrap_authorization: Boolean(options.config.authBootstrapToken),
    mdns_infrastructure_allowed: options.config.mdnsEnabled,
  };
}

/** Reads the persisted application mDNS preference without exposing errors. */
export function readApplicationMdnsPreference(
  database: Database.Database,
): boolean {
  try {
    const row = database
      .prepare(
        "SELECT value_json FROM application_settings " +
          "WHERE setting_key = 'discovery.mdns_enabled'",
      )
      .get() as { value_json?: string } | undefined;
    return row?.value_json === "true";
  } catch {
    return false;
  }
}
