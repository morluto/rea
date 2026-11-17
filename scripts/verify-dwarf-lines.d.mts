export interface ReadelfRawProgram {
  readonly offset: number;
  readonly length: number | null;
  readonly version: number | null;
}

export interface ReadelfDecodedRow {
  readonly file: string;
  readonly line: number;
  readonly address: string;
}

export const parseReadelfRawLine: (text: string) => ReadelfRawProgram[];
export const parseReadelfDecodedLine: (text: string) => ReadelfDecodedRow[];
