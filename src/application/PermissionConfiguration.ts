import type { AppConfig } from "../config.js";
import { ConfigurationError } from "../domain/errors.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  createPermissionAuthority,
  type PermissionAuthority,
} from "./PermissionAuthority.js";
import { readProjectPermissionStore } from "./ProjectPermissionStore.js";

/** Load the same administrator and optional project policy for CLI and MCP. */
export const loadConfiguredPermissionAuthority = async (
  config: AppConfig,
): Promise<Result<PermissionAuthority, ConfigurationError>> => {
  const authority = await createPermissionAuthority(
    config.permissionCeilings,
    config.administratorPermissionGrants,
  );
  if (!authority.ok)
    return err(
      new ConfigurationError("Permission policy could not be loaded", {
        cause: authority.error,
      }),
    );
  if (
    config.permissionProjectRoot === undefined ||
    config.permissionProjectStore === undefined
  )
    return ok(authority.value);
  const project = await readProjectPermissionStore(
    config.permissionProjectStore,
    config.permissionProjectRoot,
  );
  if (!project.ok)
    return err(
      new ConfigurationError("Project permission policy could not be loaded", {
        cause: project.error,
      }),
    );
  const replaced = await authority.value.replaceProjectGrants(
    project.value?.grants ?? [],
  );
  return replaced.ok
    ? ok(authority.value)
    : err(
        new ConfigurationError(
          "Project permission policy could not be applied",
          {
            cause: replaced.error,
          },
        ),
      );
};
