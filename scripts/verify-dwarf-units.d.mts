export interface DumpedDwarfUnit {
  readonly version: number | null;
  readonly name: string | null;
  readonly comp_dir: string | null;
  readonly producer: string | null;
  readonly dwo_name: string | null;
}

export const parseDumperUnits: (text: string) => DumpedDwarfUnit[];
