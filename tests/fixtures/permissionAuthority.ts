import {
  createPermissionAuthority,
  type PermissionAuthority,
} from "../../src/application/PermissionAuthority.js";
import type {
  PermissionCapability,
  PermissionCeiling,
  PermissionGrant,
} from "../../src/domain/permissionPolicy.js";

/** Build a canonical root-scoped authority with selected administrator grants. */
export const permissionAuthorityForRoot = async (
  root: string,
  capabilities: readonly PermissionCapability[],
  grantedCapabilities: readonly PermissionCapability[],
): Promise<PermissionAuthority> => {
  const ceilings = capabilities.map((capability) => scope(capability, root));
  const grants = ceilings
    .filter(({ capability }) => grantedCapabilities.includes(capability))
    .map(administratorGrant);
  const authority = await createPermissionAuthority(ceilings, grants);
  if (!authority.ok) throw authority.error;
  return authority.value;
};

const scope = (
  capability: PermissionCapability,
  root: string,
): PermissionCeiling => ({
  capability,
  roots: [root],
  executables: [],
  environment_names: [],
  network: "none",
  mount: false,
});

const administratorGrant = (ceiling: PermissionCeiling): PermissionGrant => ({
  ...ceiling,
  grant_id: `administrator:${ceiling.capability}`,
  lifetime: "administrator",
  operation_identity: null,
  expires_at: null,
});
