import path from "node:path";

import { EXIT, fail } from "./core.mjs";

/** Build the deployment command with the shared management runtime. */
export function createDeployCommand({
  root,
  configCheck,
  value,
  requireDocker,
  profileRequiresExplicitMutation,
  withManagementLock,
  runCompose,
  health,
  success
}) {
  return async function deploy(ctx, values) {
    if (values.apply && ctx.globals.dryRun) {
      fail(
        "deploy_mode_conflict",
        "--apply and --dry-run are mutually exclusive",
        EXIT.USAGE
      );
    }
    if (!values.apply && !ctx.globals.dryRun) {
      fail(
        "deploy_mode_required",
        "deploy requires --dry-run or --apply",
        EXIT.USAGE
      );
    }
    if (ctx.profileName === "operational") {
      fail(
        "operational_deploy_blocked",
        "operational deployment is not authorized in M5.5.4",
        EXIT.BLOCKED
      );
    }
    if (values.apply) profileRequiresExplicitMutation(ctx);
    const checked = await configCheck(ctx, { allowMissingData: true });
    const plan = {
      command: "deploy",
      profile: ctx.profileName,
      project: ctx.project,
      compose_file: path.relative(root, ctx.composeFile),
      services: ctx.profile.services,
      preserves: [
        "canonical data",
        "immutable objects",
        "backup destination",
        "secret files",
        "unrelated containers"
      ],
      public_routing_changed: false
    };
    if (ctx.globals.dryRun) {
      return success(
        {
          ok: checked.exitCode === EXIT.OK,
          status:
            checked.exitCode === EXIT.OK
              ? "DRY_RUN_READY"
              : "DRY_RUN_BLOCKED",
          ...plan,
          configuration: checked.value
        },
        checked.exitCode
      );
    }
    if (
      value(ctx, "PRG32_MANAGE_DEPLOY_AUTHORIZATION") !==
      "I_UNDERSTAND_DISPOSABLE_DEPLOYMENT"
    ) {
      fail(
        "deploy_authorization_required",
        "deploy apply requires " +
          "PRG32_MANAGE_DEPLOY_AUTHORIZATION=" +
          "I_UNDERSTAND_DISPOSABLE_DEPLOYMENT",
        EXIT.AUTH
      );
    }
    await requireDocker(ctx);
    return withManagementLock(ctx, "deploy", async () => {
      await runCompose(ctx, ["up", "-d"], { scheduler: false });
      const checkedHealth = await health(ctx);
      return success(
        {
          ...plan,
          status:
            checkedHealth.exitCode === EXIT.OK
              ? "APPLIED"
              : "APPLIED_UNHEALTHY",
          health: checkedHealth.value
        },
        checkedHealth.exitCode
      );
    });
  };
}
