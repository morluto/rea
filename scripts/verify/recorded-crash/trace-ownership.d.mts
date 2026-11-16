export interface OwnershipTraceExecution {
  readonly pid: number;
  readonly path: string;
  readonly line: string;
  readonly succeeded: boolean;
  readonly ownershipInventory: boolean;
}
/** Match only the exact ownership inventory invocation for this executable. */
export function isOwnershipInventoryExecution(
  executable: string,
  line: string,
): boolean;
/** Parsed topology and execution facts for one complete strace observation. */
export function collectOwnershipTraceFacts(options: {
  readonly traces: readonly { readonly pid: number; readonly text: string }[];
  readonly nodeExecutable: string;
  readonly psExecutables: ReadonlySet<string>;
}): {
  readonly ownershipThreads: ReadonlySet<number>;
  readonly psProcesses: ReadonlySet<number>;
  readonly executions: readonly OwnershipTraceExecution[];
};
