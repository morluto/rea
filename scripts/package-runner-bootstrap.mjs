import { spawn } from "node:child_process";

const BOOTSTRAP_MARKER = "REA_PACKAGE_RUNNER_BOOTSTRAPPED";

/**
 * Plan a current-release setup bootstrap when bare npx selected a package.
 * Explicit `npm exec --package=<name>@<version>` rollbacks bypass it.
 */
export function packageRunnerSetupPlan(input) {
  if (input.args[0] !== "setup") return undefined;
  if (input.environment[BOOTSTRAP_MARKER] === "1") return undefined;
  if (input.environment.npm_lifecycle_event !== "npx") return undefined;

  const requestedPackage = input.environment.npm_config_package;
  if (
    requestedPackage !== undefined &&
    isExactPackageVersion(requestedPackage, input.packageName)
  )
    return undefined;

  return {
    command: "npm",
    args: [
      "exec",
      "--yes",
      "--prefer-online",
      `--package=${input.packageName}@latest`,
      "--",
      "rea",
      ...input.args,
    ],
  };
}

/** Execute a planned package-runner bootstrap and return its exit status. */
export async function runPackageRunnerSetupBootstrap(input) {
  const plan = packageRunnerSetupPlan(input);
  if (plan === undefined) return undefined;

  return await new Promise((resolveExitCode) => {
    const child = spawn(plan.command, plan.args, {
      stdio: "inherit",
      env: { ...input.environment, [BOOTSTRAP_MARKER]: "1" },
    });
    child.once("error", () => resolveExitCode(1));
    child.once("exit", (code) => resolveExitCode(code ?? 1));
  });
}

function isExactPackageVersion(packageSpecifier, packageName) {
  const version = packageSpecifier.slice(`${packageName}@`.length);
  return (
    packageSpecifier.startsWith(`${packageName}@`) &&
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(version)
  );
}
