import type { ProcessCaptureCleanupReport } from "../../domain/process/processCapture.js";

/**
 * Progress port accepted by process capture.
 * Structurally matches the shared application `ProgressReporter`.
 */
export interface ProcessCaptureProgress {
  report(update: {
    readonly phase: string;
    readonly completed: number;
    readonly total: null;
    readonly message: string;
    readonly terminal?: boolean;
  }): Promise<void>;
}

/** Observed collection counts. These are not a percentage of an unknown total. */
export interface ProcessCaptureProgressCounts {
  readonly frames: number;
  readonly samples: number;
  readonly interactions: number;
}

export type ProcessCaptureProgressPhase =
  | "prepare"
  | "running"
  | "settling"
  | "cleanup";

export type ProcessCaptureProgressDisposition =
  | "exited"
  | "timeout"
  | "idle_timeout"
  | "cancelled"
  | "failed";

export interface ProcessCaptureProgressReport {
  readonly phase: ProcessCaptureProgressPhase;
  readonly counts: ProcessCaptureProgressCounts;
  readonly terminal?: boolean;
  readonly disposition?: ProcessCaptureProgressDisposition;
  readonly cleanup?: ProcessCaptureCleanupReport;
}

const formatProgressMessage = (
  elapsedMs: number,
  counts: ProcessCaptureProgressCounts,
  disposition: ProcessCaptureProgressDisposition | undefined,
  cleanup: ProcessCaptureCleanupReport | undefined,
): string => {
  const status = `elapsed_ms=${String(elapsedMs)} frames=${String(counts.frames)} samples=${String(counts.samples)} interactions=${String(counts.interactions)}`;
  const dispositionText =
    disposition === undefined ? "" : ` disposition=${disposition}`;
  const cleanupText =
    cleanup === undefined
      ? ""
      : ` owned_process_group=${cleanup.owned_process_group.state} terminal_renderer=${cleanup.terminal_renderer.state} temporary_root=${cleanup.temporary_root.state}`;
  return `${status}${dispositionText}${cleanupText}`;
};

/** Serialize observed capture status through one rate-limited reporter. */
export const createProcessCaptureProgressTracker = (
  progress: ProcessCaptureProgress | undefined,
  now: () => number = Date.now,
) => {
  const started = now();
  let completed = 0;
  let live = true;
  let pending = Promise.resolve();
  return {
    closeLive(): void {
      live = false;
    },
    report(update: ProcessCaptureProgressReport): Promise<void> {
      if (progress === undefined) return Promise.resolve();
      if (update.terminal !== true && !live) return Promise.resolve();
      const units =
        update.counts.frames +
        update.counts.samples +
        update.counts.interactions;
      if (units > completed) completed = units;
      const payload = {
        phase: update.phase,
        completed,
        total: null as null,
        message: formatProgressMessage(
          Math.max(0, now() - started),
          update.counts,
          update.disposition,
          update.cleanup,
        ),
        ...(update.terminal === true ? { terminal: true as const } : {}),
      };
      const send = () => progress.report(payload);
      const scheduled = pending.then(send, send);
      pending = scheduled.then(
        () => undefined,
        () => undefined,
      );
      return scheduled.then(
        () => undefined,
        () => undefined,
      );
    },
  };
};

export type ProcessCaptureProgressTracker = ReturnType<
  typeof createProcessCaptureProgressTracker
>;
