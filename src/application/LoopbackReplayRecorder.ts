import type { IncomingMessage, Server } from "node:http";
import type {
  ProcessScenario,
  ProtocolEvent,
} from "../domain/processCapture.js";
import {
  ReplayMachineRuntime,
  type ReplayMachineDecision,
  type ReplayTransitionRecord,
} from "../domain/replayMachineRuntime.js";

/** Bounded protocol and replay-machine observations for one process run. */
export class ReplayRecorder {
  readonly events: ProtocolEvent[] = [];
  readonly started = Date.now();
  readonly machine: ReplayMachineRuntime | undefined;
  #machineQueue: Promise<void> = Promise.resolve();
  #machineAdmissionOpen = true;
  truncated = false;

  constructor(readonly scenario: ProcessScenario) {
    this.machine =
      scenario.replay.machine === null
        ? undefined
        : new ReplayMachineRuntime(scenario.replay.machine);
  }

  get transitions(): readonly ReplayTransitionRecord[] {
    return this.machine?.timeline ?? [];
  }

  atMs(): number {
    return (
      Math.floor(
        (Date.now() - this.started) /
          this.scenario.normalization.time_bucket_ms,
      ) * this.scenario.normalization.time_bucket_ms
    );
  }

  rawAtMs(): number {
    return Date.now() - this.started;
  }

  enqueueMachine<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.#machineAdmissionOpen)
      return Promise.reject(new Error("replay machine is closing"));
    const result = this.#machineQueue.then(operation);
    this.#machineQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  stopMachineAdmission(): void {
    this.#machineAdmissionOpen = false;
  }

  async drainMachine(): Promise<void> {
    await this.#machineQueue;
  }

  record(event: Omit<ProtocolEvent, "sequence">): void {
    if (this.events.length < this.scenario.limits.protocol_events)
      this.events.push({ sequence: this.events.length, ...event });
    else this.truncated = true;
  }
}

export const requestHeaders = (
  request: IncomingMessage,
): Readonly<Record<string, string>> =>
  Object.fromEntries(
    Object.entries(request.headers).flatMap(([name, value]) =>
      value === undefined
        ? []
        : [[name, Array.isArray(value) ? value.join(", ") : value]],
    ),
  );

export const readReplayRequestBody = async (
  request: IncomingMessage,
  limit: number,
): Promise<string | undefined> => {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += value.byteLength;
    if (bytes > limit) return undefined;
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
};

export const recordMachineEvent = (
  recorder: ReplayRecorder,
  event: Omit<ProtocolEvent, "sequence" | "outcome">,
  decision: ReplayMachineDecision,
): void =>
  recorder.record({
    ...event,
    data: recorder.machine?.redact(event.data) ?? event.data,
    outcome: decision.outcome,
  });

export const waitForReplayDelay = (durationMs: number): Promise<void> =>
  new Promise((resolveDelay) => setTimeout(resolveDelay, durationMs));

export const listenOnLoopback = async (server: Server): Promise<number> => {
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("loopback replay did not acquire a TCP port");
  return address.port;
};

export const closeReplayServer = (server: Server): Promise<void> =>
  new Promise((resolveClose, rejectClose) => {
    server.close((error) =>
      error === undefined ? resolveClose() : rejectClose(error),
    );
  });
