/** One dependency crossing a settled source ownership boundary. */
export interface ModuleBoundaryViolation {
  readonly file: string;
  readonly line: number;
  readonly specifier: string;
  readonly target: string;
  readonly boundary:
    | "artifact-acquisition"
    | "process-capture"
    | "pure-layer"
    | "application-composition"
    | "provider-construction"
    | "provider-generated-catalog";
}

/** Check resolved source ownership, including type imports and reexports. */
export function inspectModuleBoundaries(
  file: string,
  source: string,
  root: string,
): readonly ModuleBoundaryViolation[];

/** One own-source import, resolved to its repository path. */
export interface ResolvedModuleImport {
  readonly file: string;
  readonly line: number;
  readonly specifier: string;
  readonly typeOnly: boolean;
  readonly target: string;
}

/** Each own-source import of a file, resolved to its repository path. */
export function resolveModuleImports(
  file: string,
  source: string,
  root: string,
): readonly ResolvedModuleImport[];

/** Check already resolved imports, as returned by resolveModuleImports. */
export function inspectResolvedModuleBoundaries(
  imports: readonly ResolvedModuleImport[],
): readonly ModuleBoundaryViolation[];
