import { EXIT, ManagementError } from "./core.mjs";

/**
 * Build the management health command from compose and output utilities.
 * Health probes remain read-only and preserve the existing retry behavior.
 */
export function createHealthCommand({
  runCompose,
  parseJsonLines,
  composeServices,
  servicesSummary,
  requireDocker,
  success
}) {
  async function execJson(ctx, service, endpoint) {
    const script =
      "const u=process.argv[1].replace('127.0.0.1',require('node:os').hostname()); " +
      "fetch(u).then(async r=>{let b=await r.text(); let p; " +
      "try{p=JSON.parse(b)}catch{p={body:b.slice(0,256)}}; " +
      "process.stdout.write(JSON.stringify({status:r.status,ok:r.ok,body:p})); " +
      "process.exit(r.ok?0:1)}).catch(()=>process.exit(1))";
    try {
      const result = await runCompose(
        ctx,
        ["exec", "-T", service, "node", "-e", script, endpoint],
        {
          scheduler: service === "backup-scheduler",
          timeoutMs: Math.min(ctx.globals.timeout * 1000, 5000)
        }
      );
      return (
        parseJsonLines(result.stdout)[0] ?? {
          status: 0,
          ok: false,
          body: { error: "invalid_health_output" }
        }
      );
    } catch (error) {
      const details =
        error instanceof ManagementError && error.details
          ? error.details
          : undefined;
      return {
        status: 0,
        ok: false,
        body: {
          error: "service_unavailable",
          detail:
            error instanceof ManagementError
              ? error.message
              : "health probe failed",
          stderr:
            typeof details?.stderr === "string"
              ? details.stderr.trim().split(/\r?\n/u).slice(-2).join("\n")
              : undefined,
          args: Array.isArray(details?.args) ? details.args : undefined
        }
      };
    }
  }

  async function healthSnapshot(ctx) {
    const rows = await composeServices(ctx, { scheduler: true });
    const services = servicesSummary(rows, ctx);
    const applicationServices = services.filter(
      (item) => item.service !== "backup-scheduler"
    );
    if (!applicationServices.every((item) => item.running)) {
      return success(
        {
          ok: false,
          command: "health",
          profile: ctx.profileName,
          checks: {
            containers_running: false,
            containers_healthy: false,
            backend_http_health: false,
            backend_readiness: false,
            frontend_http_health: false
          },
          services
        },
        EXIT.UNHEALTHY
      );
    }
    const backendPort = ctx.profileName === "candidate" ? "5090" : "5080";
    const backend = await execJson(
      ctx,
      "fastify",
      `http://127.0.0.1:${backendPort}/health`
    );
    const readiness = await execJson(
      ctx,
      "fastify",
      `http://127.0.0.1:${backendPort}/ready`
    );
    const frontend = await execJson(
      ctx,
      "next",
      "http://127.0.0.1:3000/health"
    );
    const checks = {
      containers_running: applicationServices.every((item) => item.running),
      containers_healthy: applicationServices.every(
        (item) => item.health === "healthy"
      ),
      backend_http_health: backend.ok === true,
      backend_readiness: readiness.ok === true,
      frontend_http_health: frontend.ok === true
    };
    const schedulerService = services.find(
      (item) => item.service === "backup-scheduler"
    );
    if (ctx.profile.scheduler && schedulerService?.present) {
      checks.scheduler_container = schedulerService.running;
    }
    const ok = Object.values(checks).every(Boolean);
    return success(
      { ok, command: "health", profile: ctx.profileName, checks, backend, readiness, frontend },
      ok ? EXIT.OK : EXIT.UNHEALTHY
    );
  }

  return async function health(ctx) {
    await requireDocker(ctx);
    const deadline = Date.now() + Math.min(ctx.globals.timeout * 1000, 60000);
    let last;
    do {
      last = await healthSnapshot(ctx);
      if (last.exitCode === EXIT.OK || Date.now() >= deadline) return last;
      if (last.value?.checks?.containers_running === false) return last;
      await new Promise((resolve) => setTimeout(resolve, 500));
    } while (Date.now() < deadline);
    return last;
  };
}
