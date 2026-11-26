import { createPackageVerifierCommands } from "./lib/verify-package-commands.mjs";
import { withVerifierCleanup } from "./lib/verifier-cleanup.mjs";
import { join, resolve } from "node:path";
import { valid } from "semver";
import {
  installCanaryPackage,
  verifyInstalledCanaryPackage,
} from "./lib/release-package-canary.mjs";
import { completeVerifierRun, createVerifierRun } from "./lib/verifier-run.mjs";
import { VerifierFixture } from "./lib/verifier-fixture.mjs";

const [tarball, version, ...extra] = process.argv.slice(2);
if (
  tarball === undefined ||
  typeof version !== "string" ||
  valid(version) !== version ||
  extra.length
)
  throw new Error(
    "Usage: node scripts/verify-release-artifact.mjs <qualified-tarball> <version>",
  );
const source = resolve(tarball);
const verifierRun = createVerifierRun();
// npm and the package's children write beneath the root, as under the former mkdtemp.
const fixture = await VerifierFixture.open({
  prefix: "rea-release-rehearsal-",
  private: false,
});
const workspace = fixture.path;
const environment = {
  ...process.env,
  npm_config_cache: join(workspace, "npm-cache"),
};
const commands = await createPackageVerifierCommands({
  // The package command owner releases the fixture after its commands close.
  workspace: { path: workspace, close: () => fixture.release() },
});
let result;
await withVerifierCleanup(async () => {
  const packageRoot = await installCanaryPackage(
    source,
    workspace,
    environment,
    commands,
  );
  result = await verifyInstalledCanaryPackage(packageRoot, version, workspace, {
    environment: environment,
    commands,
  });
}, [() => commands.close()]);
process.stdout.write(
  `${JSON.stringify({ verifier_run: await completeVerifierRun(verifierRun), package: "rea-agents", version, source, ...result })}\n`,
);
