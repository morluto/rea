import type { EvidenceProvider } from "../../domain/evidence.js";
import type {
  ObjdumpSelection,
  RizinInput,
} from "../../domain/reverseEngineering.js";

/** A provider's reading of the version banner its selected executable printed. */
export interface ProviderToolIdentification {
  readonly identity: EvidenceProvider;
  readonly limitations: readonly string[];
}

/** Arguments that print a version banner, and the provider's reading of it. */
export interface ProviderVersionProbe {
  readonly arguments: readonly string[];
  /**
   * Reads the banner: the first stdout line, trimmed and bounded by the
   * service. Undefined means the banner identifies no tool.
   */
  readonly identify: (banner: string) => ProviderToolIdentification | undefined;
  /** The limitation recorded when no banner identified the tool, whose identity is then assumed. */
  readonly assumedIdentity: string;
}

/** Provider-neutral command profile consumed by the shared application workflow. */
export interface ReverseEngineeringProviderCommand {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly identity: EvidenceProvider;
  readonly environmentOverrides?: Readonly<NodeJS.ProcessEnv>;
  /** Identifies the selected executable once per digest; never refuses it. */
  readonly versionProbe?: ProviderVersionProbe;
}

/** Provider-specific command construction stays outside the application layer. */
export interface ReverseEngineeringCommandPort {
  objdump(input: ObjdumpSelection): ReverseEngineeringProviderCommand;
  rizin(input: RizinInput): ReverseEngineeringProviderCommand;
}
