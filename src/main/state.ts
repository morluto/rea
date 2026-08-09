import type { AppConfig } from "../config.js";
import type { EvidenceFilePolicy } from "../domain/evidenceBundle.js";

export interface RuntimeState {
  currentConfig: AppConfig;
  evidencePolicy: EvidenceFilePolicy & { roots: string[] };
  snapshotPolicy: EvidenceFilePolicy & { roots: string[] };
  investigationRoots: string[];
}

export const createRuntimeState = (config: AppConfig): RuntimeState => ({
  currentConfig: config,
  evidencePolicy: {
    ...config.evidenceFilePolicy,
    roots: [...config.evidenceFilePolicy.roots],
  },
  snapshotPolicy: {
    ...config.analysisSnapshotFilePolicy,
    roots: [...config.analysisSnapshotFilePolicy.roots],
  },
  investigationRoots: [...config.investigationInputRoots],
});
