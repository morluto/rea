import { matchesOwnedProcessCommand } from "./ProcessCommandIdentity.js";
import type {
  OwnedProcessGroup,
  ProcessTableEntry,
} from "./ProcessOwnership.js";

/** Compare a live launcher against the identity committed at process launch. */
export const launcherIdentityFailure = (
  launcher: Pick<ProcessTableEntry, "parentPid" | "processGroupId"> & {
    readonly command?: string;
  },
  ownership: OwnedProcessGroup,
): string | null => {
  if (launcher.processGroupId !== ownership.processGroupId)
    return "owned launcher process-group identity did not match";
  if (
    ownership.expectedParentPid !== undefined &&
    launcher.parentPid !== ownership.expectedParentPid
  )
    return "owned launcher parent identity did not match";
  if (ownership.expectedCommand !== undefined) {
    if (launcher.command === undefined)
      return "owned launcher command identity could not be verified";
    if (
      !matchesOwnedProcessCommand(launcher.command, ownership.expectedCommand)
    )
      return `owned launcher command identity did not match (observed=${launcher.command}; expected=${ownership.expectedCommand})`;
  }
  return null;
};
