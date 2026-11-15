import type { CommandRejection } from "../../domain/commandObservation.js";
import type { EvidenceProvider } from "../../domain/evidence.js";
import type {
  ObjdumpSelection,
  RizinInput,
} from "../../domain/reverseEngineering.js";

/** Provider-neutral command profile consumed by the shared application workflow. */
export interface ReverseEngineeringProviderCommand {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly identity: EvidenceProvider;
  /** What the provider cannot attest about the arguments it built. */
  readonly limitations?: readonly string[];
  /**
   * A provider refusal of the command that a completed process reported only
   * in its diagnostics, with the limitation that explains it, or undefined.
   */
  readonly rejection?: (stderr: string) => CommandRejection | undefined;
  readonly environmentOverrides?: Readonly<NodeJS.ProcessEnv>;
}

/** Provider-specific command construction stays outside the application layer. */
export interface ReverseEngineeringCommandPort {
  objdump(input: ObjdumpSelection): ReverseEngineeringProviderCommand;
  rizin(input: RizinInput): ReverseEngineeringProviderCommand;
}
