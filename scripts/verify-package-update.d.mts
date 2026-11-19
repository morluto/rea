import type { PackageVerifierCommands } from "./lib/verify-package-commands.mjs";

export function verifyPackageUpdate(options: {
  readonly prefix: string;
  readonly packageRoot: string;
  readonly tarball: string;
  readonly workspace: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly commands: Pick<PackageVerifierCommands, "exec">;
}): Promise<{
  readonly installed_version: string;
  readonly exact_release: true;
  readonly maintenance_read_only: true;
}>;
