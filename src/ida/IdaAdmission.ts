import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";

import {
  privateRuntimeRootCapability,
  type PrivateRuntimeRootCapability,
} from "../process/PrivateRuntimeRoot.js";
import type { IdaConfiguration } from "./IdaConfiguration.js";
import { resolveIdaWorkspaceParent } from "./IdaWorkspace.js";

/** The repair for a workspaceRoot REA cannot create entries in. */
export const IDA_WORKSPACE_ROOT_REMEDIATION =
  "Set workspaceRoot to an existing directory REA can create entries in, or omit it to use the system temporary directory; see docs/providers/ida-provider.md.";

/** Why IDA's local prerequisites refuse a parsed registration. */
export type IdaAdmissionRefusal =
  | {
      readonly kind: "private_workspace_unavailable";
      readonly privacy: Extract<
        PrivateRuntimeRootCapability,
        { readonly available: false }
      >;
    }
  | { readonly kind: "workspace_unusable"; readonly reason: string };

/**
 * IDA's admission of a parsed registration: the one decision doctor and the
 * provider's readiness both project, so they cannot disagree. Attach mode
 * needs nothing local. Headless mode needs private workspace authority and a
 * workspace parent REA can create entries in. Nothing is created and IDA is
 * not launched.
 */
export type IdaAdmission =
  | {
      readonly admitted: true;
      /** The private workspace headless mode will allocate under. */
      readonly workspace?: {
        readonly root: string | undefined;
        readonly proof: string;
      };
    }
  | {
      readonly admitted: false;
      readonly workspaceRoot: string | undefined;
      readonly refusal: IdaAdmissionRefusal;
    };

export const admitIdaConfiguration = async (
  configuration: IdaConfiguration,
): Promise<IdaAdmission> => {
  if (configuration.mode !== "headless") return { admitted: true };
  const root = configuration.workspaceRoot;
  const privacy = privateRuntimeRootCapability();
  if (!privacy.available)
    return {
      admitted: false,
      workspaceRoot: root,
      refusal: { kind: "private_workspace_unavailable", privacy },
    };
  const unusable = await workspaceParentUnusable(root);
  return unusable === undefined
    ? { admitted: true, workspace: { root, proof: privacy.proof } }
    : {
        admitted: false,
        workspaceRoot: root,
        refusal: { kind: "workspace_unusable", reason: unusable },
      };
};

/** Resolve the workspace parent as allocation will, without creating entries. */
const workspaceParentUnusable = async (
  root: string | undefined,
): Promise<string | undefined> => {
  try {
    const parent = await resolveIdaWorkspaceParent(root);
    if (!(await stat(parent)).isDirectory())
      return `IDA workspaceRoot ${root ?? "the system temporary directory"} is not a directory.`;
    await access(parent, constants.W_OK | constants.X_OK);
    return undefined;
  } catch (cause: unknown) {
    return `IDA workspaceRoot ${root ?? "the system temporary directory"} is not a usable directory: ${cause instanceof Error ? cause.message : String(cause)}`;
  }
};
