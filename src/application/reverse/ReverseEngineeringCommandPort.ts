import type { EvidenceProvider } from "../../domain/evidence.js";
import type { Result } from "../../domain/result.js";
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
   * Explain a provider refusal of the command that a completed process
   * reported only in its diagnostics, or return undefined.
   */
  readonly rejection?: (stderr: string) => string | undefined;
  readonly environmentOverrides?: Readonly<NodeJS.ProcessEnv>;
}

/**
 * A configured bare command the host search did not find, so nothing is
 * launched: handing Windows the bare name would also search the current
 * directory.
 */
export interface ReverseEngineeringCommandUnavailable {
  readonly identity: EvidenceProvider;
  /** The command as configured. */
  readonly command: string;
  readonly reason:
    | { readonly kind: "not_found" }
    | { readonly kind: "invalid_pathext"; readonly extension: string };
}

export type ReverseEngineeringCommandSelection = Result<
  ReverseEngineeringProviderCommand,
  ReverseEngineeringCommandUnavailable
>;

/** Provider-specific command construction stays outside the application layer. */
export interface ReverseEngineeringCommandPort {
  objdump(input: ObjdumpSelection): ReverseEngineeringCommandSelection;
  rizin(input: RizinInput): ReverseEngineeringCommandSelection;
}
