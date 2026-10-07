export interface ManagedPeFixtureMethod {
  readonly body?: Buffer;
  readonly flags?: number;
  readonly implFlags?: number;
  readonly name: string;
}

export interface ManagedPeFixtureOptions {
  readonly cliFlags?: number;
  readonly corruptMetadataSignature?: boolean;
  readonly fieldName?: string;
  readonly ilBody?: Buffer;
  readonly machine?: number;
  readonly metadataValidMaskExtra?: bigint;
  readonly methodImplFlags?: number;
  readonly methodName?: string;
  readonly methods?: readonly ManagedPeFixtureMethod[];
  readonly mvid?: Buffer;
  readonly pinvoke?: {
    readonly importName?: string;
    readonly mappingFlags?: number;
    readonly moduleName?: string;
  };
  readonly readyToRun?: boolean;
  readonly references?: readonly string[];
  readonly resourceData?: Buffer;
  readonly targetFramework?: string;
  readonly typeName?: string;
  readonly typeNamespace?: string;
}

export const alternateMvid: Buffer;
export function buildManagedPeFixture(
  options?: ManagedPeFixtureOptions,
): Buffer;
export function buildNativePeFixture(): Buffer;
