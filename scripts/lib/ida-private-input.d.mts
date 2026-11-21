export function privateIdaInput(
  metadata: {
    readonly input_path: string;
    readonly idb_path: string | null;
  },
  target: string,
  targetIsDatabase: boolean,
): string;
