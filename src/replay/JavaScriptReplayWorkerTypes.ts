/** One source module admitted to the disposable replay worker. */
export interface WorkerModule {
  readonly alias: string;
  readonly format: "esm" | "commonjs-factory";
  readonly dependencies: Readonly<Record<string, string>>;
  readonly source: string;
}

/** One independently loaded side of a replay comparison. */
export interface WorkerSide {
  readonly modules: readonly WorkerModule[];
  readonly entryAlias: string;
  readonly entryExport: string;
}

/** Parsed parent-to-worker runtime-hop request. */
export interface WorkerRequest {
  readonly schemaVersion: 1;
  readonly left: WorkerSide;
  readonly right?: WorkerSide;
  readonly cases: readonly {
    readonly caseId: string;
    readonly arguments: readonly unknown[];
    readonly inputSha256: string;
  }[];
  readonly determinism: {
    readonly clockIso: string;
    readonly randomSeed: number;
  };
  readonly limits: {
    readonly resultDepth: number;
    readonly resultNodes: number;
    readonly exceptionBytes: number;
  };
}

/** Worker-side observation before the parent authenticates its commitments. */
export interface WorkerOutcome {
  readonly case_id: string;
  readonly outcome: "return" | "exception" | "serialization_error" | "denied";
  readonly value?: unknown;
  readonly exception?: {
    readonly name: string;
    readonly message: string;
    readonly stack: string | null;
  };
  readonly input_sha256: string;
  readonly output_sha256: null;
  readonly truncated: false;
}
