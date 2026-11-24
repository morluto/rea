export type RiscvWord =
  | number
  | "frame"
  | { readonly frame: readonly number[] };
export type RiscvAbiParameter = readonly [
  name: string,
  type: string,
  storage: string,
  words?: Readonly<Record<string, RiscvWord>>,
  literal?: string,
];
export const RISCV_ILP32_ABI: Readonly<
  Record<
    string,
    {
      readonly return: readonly [string, string];
      readonly parameters: readonly RiscvAbiParameter[];
      readonly variadic?: Readonly<Record<string, RiscvWord>>;
    }
  >
>;
export const RISCV_ILP32_CALLBACK: {
  readonly words: Readonly<Record<string, number>>;
  readonly literals: readonly string[];
};
export interface RiscvCallSite {
  readonly target: string | undefined;
  readonly words: Readonly<
    Record<string, { word?: number; stack?: number } | undefined>
  >;
  /** Caller memory at the call, by offset from the caller's incoming `sp`. */
  readonly memory: ReadonlyMap<number, { word?: number; stack?: number }>;
}
/** An `auipc`+`jalr` call; the target comes from the pair's immediates. */
export interface RiscvFarCall {
  readonly auipc: string;
  readonly jalr: string;
  readonly target: string;
}
export function riscvStorageLocations(storage: string): readonly string[];
export function assertRiscvIlp32TableConsistent(): void;
export function parseRiscvCallSites(listing: string): readonly RiscvCallSite[];
export function parseRiscvFarCalls(listing: string): readonly RiscvFarCall[];
/** Runs a host command; the verifier passes its supervised owner. */
export type RiscvCommandRunner = (
  command: string,
  args: readonly string[],
  options: object,
) => Promise<{ stdout: string; stderr: string }>;
export function inspectRiscvCallSites(
  path: string,
  run?: RiscvCommandRunner,
): Promise<{
  command: string;
  version: string | undefined;
  calls: readonly RiscvCallSite[];
}>;
export function inspectRiscvFarCalls(
  path: string,
  run?: RiscvCommandRunner,
): Promise<{
  command: string;
  version: string | undefined;
  calls: readonly RiscvFarCall[];
}>;
export function assertRiscvTerminalCall(observation: {
  readonly call: RiscvFarCall;
  readonly callee: { readonly name: string; readonly address: string };
  readonly instruction: {
    readonly address: string;
    readonly status: string;
    readonly flow: {
      readonly kind: string;
      readonly computed: boolean;
      readonly conditional: boolean;
      readonly classification_evidence?: readonly {
        readonly source: string;
        readonly value: string;
      }[];
    };
    readonly references: readonly {
      readonly target_address: string;
      readonly call: boolean;
    }[];
  };
  readonly dossier: {
    readonly pseudocode: string;
    readonly callees: readonly { readonly address: string }[];
    readonly basic_blocks: readonly {
      readonly start: string;
      readonly end: string;
      readonly successors: readonly string[];
    }[];
    readonly limitations: readonly string[];
  };
}): void;
export function assertRiscvIlp32CallSites(
  calls: readonly RiscvCallSite[],
): void;
export function assertRiscvIlp32Storage(
  boundaries: Record<string, unknown>,
  options?: { readonly stripped?: boolean },
): void;
export function assertRiscvIlp32Caller(
  pseudocode: string,
  addresses: Readonly<Record<string, string>>,
  options?: { readonly stripped?: boolean },
): void;
