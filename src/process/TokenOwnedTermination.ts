import { err, ok, type Result } from "../domain/result.js";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

import { processIdentityHasExited } from "./ProcessLifecycle.js";
import type {
  OwnedProcessGroup,
  ProcessOwnershipFact,
  ProcessOwnershipHost,
} from "./ProcessOwnership.js";
import {
  readNativeProcessIdentityMap,
  readProcessOwnershipFacts,
  systemProcessOwnershipHost,
} from "./ProcessOwnershipObservation.js";
import { readRunTokenCarriers } from "./ProcessRunTokenObservations.js";

const EXIT_POLL_INTERVAL_MS = 100;

/** Operating-system seams for a graceful stop; replaceable in tests. */
export interface TokenOwnedTerminationHost {
  readonly ownership: ProcessOwnershipHost;
  readonly signalProcess: (pid: number, signal: NodeJS.Signals) => void;
}

const systemTerminationHost: TokenOwnedTerminationHost = {
  ownership: systemProcessOwnershipHost,
  signalProcess: (pid, signal) => {
    process.kill(pid, signal);
  },
};

/** Live processes whose run token was read between two matching identity reads. */
const tokenOwnedFacts = async (
  runId: string,
  host: ProcessOwnershipHost,
): Promise<readonly ProcessOwnershipFact[]> =>
  (
    await readProcessOwnershipFacts(
      await readRunTokenCarriers(host, runId),
      host,
    )
  ).filter(
    (fact) =>
      fact.state === "same-generation" &&
      fact.token.state === "readable" &&
      fact.token.runId === runId &&
      !processIdentityHasExited(fact.identityAfter),
  );

/** The group this read observed, or undefined when membership is unknown; an older table row never grants group authority. */
const processGroupOf = ({ identityAfter }: ProcessOwnershipFact) =>
  identityAfter.state === "readable" &&
  identityAfter.relation?.state === "observed"
    ? identityAfter.relation.processGroupId
    : undefined;

const identityOf = ({ identityAfter }: ProcessOwnershipFact) =>
  identityAfter.state === "readable" ? identityAfter.identity : undefined;

/** Poll until every signalled process has exited or been replaced, or the deadline passes. */
const awaitExit = async (
  signalled: readonly ProcessOwnershipFact[],
  deadline: number,
  host: ProcessOwnershipHost,
): Promise<void> => {
  let pending = signalled;
  while (pending.length > 0) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) return;
    await delay(Math.min(EXIT_POLL_INTERVAL_MS, remaining));
    const current = await readNativeProcessIdentityMap(
      pending.map(({ process }) => process),
      host,
    );
    pending = pending.filter((fact) => {
      const now = current.get(fact.process.pid);
      return (
        !processIdentityHasExited(now) &&
        !(now?.state === "readable" && now.identity !== identityOf(fact))
      );
    });
  }
};

const send = (deliver: () => void): boolean => {
  try {
    deliver();
    return true;
  } catch {
    // Exit or a failed delivery does not establish that SIGTERM was sent.
    return false;
  }
};

export class TokenOwnedTerminationFailure extends Error {
  readonly _tag = "TokenOwnedTerminationFailure";
  constructor(
    cause: unknown,
    readonly launchGroupSignalled: boolean,
  ) {
    super("Token-owned process termination inspection failed", { cause });
    this.name = this._tag;
  }
}

/**
 * Ask an owned run to exit before it is killed: send one SIGTERM to its
 * launch process group, while a member proven to carry the run token keeps
 * that group id from being reused, and one to every other process proven to
 * carry the token, then wait up to `graceMs` for them to exit. Anything still
 * running is left to the caller's verified cleanup. Return the delivered
 * launch-group flag; failed inspection retains its exact cause and any group
 * signal already delivered. When the group was not signalled, the caller
 * still owns asking its launcher to exit.
 */
export const terminateTokenOwnedProcesses = async (
  ownership: Pick<OwnedProcessGroup, "runId" | "processGroupId">,
  graceMs: number,
  host: TokenOwnedTerminationHost = systemTerminationHost,
): Promise<
  Result<
    { readonly launchGroupSignalled: boolean },
    TokenOwnedTerminationFailure
  >
> => {
  const deadline = performance.now() + graceMs;
  let launchGroupSignalled = false;
  try {
    const owned = await tokenOwnedFacts(ownership.runId, host.ownership);
    const inGroup = (fact: ProcessOwnershipFact) =>
      processGroupOf(fact) === ownership.processGroupId;
    launchGroupSignalled =
      owned.some(inGroup) &&
      send(() => {
        host.ownership.signalGroup(ownership.processGroupId, "SIGTERM");
      });
    const signalled = launchGroupSignalled ? owned.filter(inGroup) : [];
    for (const fact of owned)
      if (
        !inGroup(fact) &&
        send(() => {
          host.signalProcess(fact.process.pid, "SIGTERM");
        })
      )
        signalled.push(fact);
    await awaitExit(signalled, deadline, host.ownership);
    return ok({ launchGroupSignalled });
  } catch (cause: unknown) {
    return err(new TokenOwnedTerminationFailure(cause, launchGroupSignalled));
  }
};
