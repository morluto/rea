export interface RealHopperFixtureOracle {
  readonly mainProcedure: string;
  readonly entryProcedure: string;
  readonly branchProcedure: string;
  readonly leafProcedure: string;
  readonly entryString: string;
  readonly leafString: string;
  readonly globalName: string;
}

export interface RealHopperFixtureTarget {
  readonly path: string;
  readonly sha256: string;
}

export interface RealHopperLargeFixtureOracle {
  readonly symbolPrefix: string;
  readonly symbolCount: number;
  readonly stringPrefix: string;
  readonly stringCount: number;
}

/** Source-owned expected tokens for a fixture, grouped as nonempty string arrays. */
export type RealHopperFixtureExpectations = Readonly<
  Record<string, readonly string[]>
>;

export interface RealHopperFixtureTargets {
  readonly manifestPath: string;
  readonly primary: RealHopperFixtureTarget;
  readonly secondary: RealHopperFixtureTarget;
  readonly large: RealHopperFixtureTarget;
  readonly versionV1: RealHopperFixtureTarget;
  readonly versionV2: RealHopperFixtureTarget;
  readonly objc: RealHopperFixtureTarget;
  readonly napi: RealHopperFixtureTarget;
  readonly swift: RealHopperFixtureTarget | undefined;
  readonly oracle: RealHopperFixtureOracle;
  readonly largeOracle: RealHopperLargeFixtureOracle;
  readonly versionV1Expectations: RealHopperFixtureExpectations;
  readonly versionV2Expectations: RealHopperFixtureExpectations;
  readonly objcExpectations: RealHopperFixtureExpectations;
  readonly napiExpectations: RealHopperFixtureExpectations;
  readonly swiftExpectations: RealHopperFixtureExpectations | undefined;
  readonly compilers: Readonly<
    Record<
      string,
      {
        readonly path: string;
        readonly version: string;
        readonly arguments: readonly string[];
      }
    >
  >;
}

export function loadRealHopperFixtureTargets(
  manifestPath: string,
): Promise<RealHopperFixtureTargets>;
