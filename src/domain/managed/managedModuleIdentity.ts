import type {
  NamedManagedModule,
  UnresolvedManagedModuleName,
} from "./managedArtifact.js";

export type ManagedModuleRow = NamedManagedModule | UnresolvedManagedModuleName;

export interface ManagedModuleEvidenceFacts {
  readonly module?: NamedManagedModule | null;
  readonly metadata?: {
    readonly unresolved_module_name?: UnresolvedManagedModuleName;
    readonly status: string;
    readonly table_row_counts: Readonly<Record<string, number>>;
  };
}

/** Select the sole admitted Module row shape, independent of its name. */
export const managedModuleRow = (
  result: ManagedModuleEvidenceFacts,
): ManagedModuleRow | null =>
  result.module ?? result.metadata?.unresolved_module_name ?? null;
