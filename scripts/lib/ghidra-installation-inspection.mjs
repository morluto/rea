import { inspectGhidraInstallation } from "../../dist/ghidra/GhidraInstallation.js";
import { withVerifierResourceOwner } from "./verifier-file-resources.mjs";

/** Complete one prerequisite inspection and release its exact retained owners. */
export function inspectVerifierGhidraInstallation(options, host) {
  return withVerifierResourceOwner((resourceOwner) =>
    inspectGhidraInstallation({ ...options, resourceOwner }, host),
  );
}

/** Inspect the verifier's selected installation with its optional Java home. */
export function inspectVerifierGhidraFromEnvironment(
  environment,
  installDir = environment.GHIDRA_INSTALL_DIR,
) {
  return inspectVerifierGhidraInstallation({
    environment,
    installDir,
    ...(environment.JAVA_HOME === undefined
      ? {}
      : { javaHome: environment.JAVA_HOME }),
  });
}

/** Require a caller-selected, available installation before fixture setup. */
export async function requireVerifierGhidraInstallation(environment) {
  const installDir = environment.GHIDRA_INSTALL_DIR;
  if (installDir === undefined)
    throw new Error("Missing prerequisite: caller-supplied GHIDRA_INSTALL_DIR");
  const installation = await inspectVerifierGhidraFromEnvironment(
    environment,
    installDir,
  );
  if (installation.status !== "available")
    throw new Error(
      `Ghidra prerequisite unavailable: ${JSON.stringify(installation)}`,
    );
  return installation;
}
