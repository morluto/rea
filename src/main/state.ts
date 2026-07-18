import type { AppConfig } from "../config.js";
import type { ProcessExecutionPolicy } from "../domain/processCapture.js";
import type { EvidenceFilePolicy } from "../domain/evidenceBundle.js";
import type { JavaScriptReplayPolicy } from "../application/JavaScriptReplayPlanning.js";
import type { ManagedRuntimePolicy } from "../application/ManagedRuntimeCorrelationService.js";

export interface RuntimeState {
  currentConfig: AppConfig;
  processPolicy: ProcessExecutionPolicy & {
    executableRoots: string[];
    workingRoots: string[];
    allowedEnvironment: string[];
  };
  evidencePolicy: EvidenceFilePolicy & { roots: string[] };
  snapshotPolicy: EvidenceFilePolicy & { roots: string[] };
  investigationRoots: string[];
  javascriptReplayPolicy: JavaScriptReplayPolicy & { roots: string[] };
  managedRuntimePolicy: ManagedRuntimePolicy & { roots: string[] };
}

export const createRuntimeState = (config: AppConfig): RuntimeState => ({
  currentConfig: config,
  processPolicy: {
    ...config.processExecutionPolicy,
    executableRoots: [...config.processExecutionPolicy.executableRoots],
    workingRoots: [...config.processExecutionPolicy.workingRoots],
    allowedEnvironment: [...config.processExecutionPolicy.allowedEnvironment],
  },
  evidencePolicy: {
    ...config.evidenceFilePolicy,
    roots: [...config.evidenceFilePolicy.roots],
  },
  snapshotPolicy: {
    ...config.analysisSnapshotFilePolicy,
    roots: [...config.analysisSnapshotFilePolicy.roots],
  },
  investigationRoots: [...config.investigationInputRoots],
  javascriptReplayPolicy: {
    ...config.javascriptReplayPolicy,
    roots: [...config.javascriptReplayPolicy.roots],
  },
  managedRuntimePolicy: {
    ...config.managedRuntimePolicy,
    roots: [...config.managedRuntimePolicy.roots],
  },
});
