import type { BrowserScenario } from "../domain/browserScenario.js";
import type { BrowserScenarioAction } from "../domain/browserScenarioValues.js";
import type {
  BrowserScenarioEvent,
  BrowserStepArtifacts,
} from "../domain/browserScenarioCaptureValues.js";
import type { SanitizedBrowserUrl } from "../domain/browserObservation.js";

type SnapshotKind = BrowserScenario["capture"]["after_each_step"][number];

export interface BrowserScenarioSessionPort {
  readonly mode: "launch" | "connect";
  readonly processOwnership: "provider-owned" | "external";
  readonly product: string;
  readonly version: string;
  readonly initialUrl: string;
  currentUrl(): string;
  sanitizeUrl(value: string): SanitizedBrowserUrl;
  setStep(index: number): void;
  nextEventSequence(): number;
  lastEventSequence(): number;
  events(): {
    readonly retained: number;
    readonly dropped: number;
    readonly items: readonly BrowserScenarioEvent[];
  };
  /** Gaps in selected event families that prevent complete capture claims. */
  eventLimitations?(): readonly string[];
  perform(action: BrowserScenarioAction, signal?: AbortSignal): Promise<void>;
  capture(
    requested: ReadonlySet<SnapshotKind>,
    signal?: AbortSignal,
  ): Promise<BrowserStepArtifacts>;
  close(): Promise<"terminated-owned-process" | "disconnected-external">;
  redactError(error: unknown): string;
}

/** Acquire one scenario session whose lifecycle the caller owns. */
export type BrowserScenarioSessionOpener = (
  scenario: BrowserScenario,
  options: {
    readonly signal?: AbortSignal;
    readonly retainCleanup?: (close: () => Promise<unknown>) => void;
  },
) => Promise<BrowserScenarioSessionPort>;
