import {
  RegularFileCleanupFailure,
  regularFileCancellation,
} from "../filesystem/OwnedRegularFile.js";
import { DarwinProcessOwnershipInspectionError } from "./DarwinProcessRunTokenReader.js";
import { OwnedCommandFailure } from "./OwnedCommand.js";
import {
  ProcessOwnershipInspectionCancelled,
  ProcessOwnershipIdentityBatchFailure,
} from "./ProcessInspectionCancellation.js";

export type ProcessInspectionCleanupFailure =
  | DarwinProcessOwnershipInspectionError
  | RegularFileCleanupFailure;

/** Collect only the exact owners explicitly transferred by inspection preparation. */
export const processInspectionCleanupFailures = (
  cause: unknown,
): readonly ProcessInspectionCleanupFailure[] => {
  const failures: ProcessInspectionCleanupFailure[] = [];
  const visited = new Set<unknown>();
  const owners = new Set<unknown>();
  const visit = (failure: unknown): void => {
    if (visited.has(failure)) return;
    visited.add(failure);
    if (failure instanceof OwnedCommandFailure) {
      visit(failure.preparationFailure);
      return;
    }
    if (failure instanceof ProcessOwnershipIdentityBatchFailure) {
      for (const entry of failure.failures) visit(entry.cause);
      for (const entry of failure.physicalFailures) visit(entry.cause);
      return;
    }
    if (failure instanceof RegularFileCleanupFailure) {
      if (!owners.has(failure.owner)) {
        owners.add(failure.owner);
        failures.push(failure);
      }
      return;
    }
    if (!(failure instanceof DarwinProcessOwnershipInspectionError)) return;
    const owner = failure.cleanupOwner;
    if (owner === undefined) {
      if (failure.cleanupFailure !== undefined) failures.push(failure);
    } else if (!owners.has(owner)) {
      owners.add(owner);
      failures.push(failure);
    }
  };
  visit(cause);
  return failures;
};

/** Only recorded owner cancellation facts; caller reasons and Error.cause stay opaque. */
export const processInspectionCancellations = (
  cause: unknown,
): readonly { readonly reason: unknown }[] => {
  const facts: { readonly reason: unknown }[] = [];
  const visited = new Set<unknown>();
  const add = (fact: { readonly reason: unknown } | undefined): void => {
    if (
      fact !== undefined &&
      !facts.some((existing) => Object.is(existing.reason, fact.reason))
    )
      facts.push(fact);
  };
  const visit = (failure: unknown): void => {
    if (visited.has(failure)) return;
    visited.add(failure);
    if (failure instanceof OwnedCommandFailure) {
      add(failure.cancellation);
      visit(failure.preparationFailure);
    } else if (failure instanceof ProcessOwnershipIdentityBatchFailure) {
      for (const entry of failure.cancellations) visit(entry.cancellation);
      for (const entry of failure.physicalFailures) visit(entry.cause);
    } else if (failure instanceof DarwinProcessOwnershipInspectionError)
      add(failure.cancellation);
    else if (failure instanceof RegularFileCleanupFailure)
      add(regularFileCancellation(failure));
    else add(ProcessOwnershipInspectionCancelled.from(failure));
  };
  visit(cause);
  return facts;
};
