/** Derived peripheral facts retained when cancellation arrives after they were built. */
export interface HardwareReconstructionPartialObservation {
  readonly kind: "hardware-peripheral-reconstruction";
  readonly procedure: string;
  readonly subjectSha256: string | null;
  readonly providerId: string | null;
  readonly evidenceId: string | null;
  readonly evidenceLinks: readonly string[];
  readonly blocks: readonly {
    readonly blockBase: string;
    readonly controller: string | null;
    readonly addresses: readonly string[];
  }[];
}
