import { AsyncLocalStorage } from "node:async_hooks";
import type {
  AnalysisSettingValues,
  AnalysisSettingsSnapshot,
} from "./analysisSettings.js";

const snapshots = new AsyncLocalStorage<AnalysisSettingsSnapshot>();

/**
 * Bind the snapshot accepted for one operation. Providers and filesystem
 * helpers read it at the point they enforce a limit. A later update does not
 * change work already inside this call.
 */
export const runWithAnalysisOperationSnapshot = <Value>(
  snapshot: AnalysisSettingsSnapshot,
  operation: () => Value,
): Value => snapshots.run(snapshot, operation);

/** The snapshot for the operation on this async stack, when one was accepted. */
export const currentAnalysisOperationSnapshot = ():
  | AnalysisSettingsSnapshot
  | undefined => snapshots.getStore();

/** Accepted override for one setting, when this operation has a snapshot. */
export const currentAnalysisSettingOverride = <
  Setting extends keyof AnalysisSettingValues,
>(
  setting: Setting,
): AnalysisSettingValues[Setting] | undefined =>
  currentAnalysisOperationSnapshot()?.overrides[setting];
