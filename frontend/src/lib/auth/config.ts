/** Authentication is owned by the canonical Fastify API. */
export const authIntegrationEnabled =
  process.env.NEXT_PUBLIC_AUTH_INTEGRATION_ENABLED !== "false";
