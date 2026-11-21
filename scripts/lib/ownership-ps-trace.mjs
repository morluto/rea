import {
  LINUX_SYSTEM_PS_LOCATIONS,
  PROCESS_INVENTORY_PS_ARGUMENTS,
} from "../../dist/process/systemPs.js";

/** The fixed Linux `ps` locations REA selects for ownership inventory. */
export const ownershipPsExecutables = new Set(LINUX_SYSTEM_PS_LOCATIONS);

/**
 * Whether an strace `execve` line is REA's process-ownership `ps` inventory
 * run from one of `executables`. REA spawns the selected path, so it is also
 * argv[0]; the arguments come from the process owner, not a copy.
 */
export const isOwnershipPsExecution = (
  line,
  executables = ownershipPsExecutables,
) => {
  const match = /^execve\("([^"]+)", (\[[^\]]*\])/u.exec(line);
  if (match === null || !executables.has(match[1])) return false;
  const argv = [match[1], ...PROCESS_INVENTORY_PS_ARGUMENTS];
  return (
    match[2] === `[${argv.map((value) => JSON.stringify(value)).join(", ")}]`
  );
};
