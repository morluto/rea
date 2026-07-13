import type {
  FileState,
  FilesystemCheckpoint,
  ProcessScenario,
} from "../domain/processCapture.js";
import { snapshotRoots, type SnapshotResult } from "./FilesystemSnapshot.js";

/** Classify path-stable filesystem effects between two bounded states. */
export const classifyFilesystemEffects = (
  before: readonly FileState[],
  after: readonly FileState[],
): FilesystemCheckpoint["effects"] => {
  const beforeByPath = new Map(before.map((file) => [file.path, file]));
  const afterByPath = new Map(after.map((file) => [file.path, file]));
  return [...new Set([...beforeByPath.keys(), ...afterByPath.keys()])]
    .sort()
    .map((path) => {
      const beforeFile = beforeByPath.get(path) ?? null;
      const afterFile = afterByPath.get(path) ?? null;
      const status =
        beforeFile === null
          ? "created"
          : afterFile === null
            ? "deleted"
            : JSON.stringify(beforeFile) === JSON.stringify(afterFile)
              ? "unchanged"
              : "modified";
      return { path, status, before: beforeFile, after: afterFile } as const;
    });
};

/** Coordinates named lifecycle filesystem observations without overlapping scans. */
export class ProcessCheckpoints {
  readonly #captures: FilesystemCheckpoint[] = [];
  readonly #captured = new Set<string>();
  readonly #terminalCounts = new Map<string, number>();
  readonly #terminalTails = new Map<string, string>();
  readonly #timers = new Set<NodeJS.Timeout>();
  #pending: Promise<void> = Promise.resolve();

  constructor(
    private readonly scenario: ProcessScenario,
    private readonly started: number,
    before: SnapshotResult,
    private readonly signal: AbortSignal | undefined,
  ) {
    this.#captures.push({
      name: "before",
      at_ms: 0,
      files: before.files,
      effects: [],
      truncated: before.truncated,
    });
    this.#captured.add("before");
    for (const checkpoint of scenario.checkpoints) {
      if (checkpoint.trigger.type !== "time") continue;
      const timer = setTimeout(
        () => this.capture(checkpoint.name),
        checkpoint.trigger.at_ms,
      );
      this.#timers.add(timer);
    }
  }

  /** Observe normalized terminal text and fire matching literal checkpoints once. */
  observeTerminal(data: string): void {
    for (const checkpoint of this.scenario.checkpoints) {
      const trigger = checkpoint.trigger;
      if (
        trigger.type !== "terminal_literal" ||
        this.#captured.has(checkpoint.name)
      )
        continue;
      const combined = `${this.#terminalTails.get(checkpoint.name) ?? ""}${data}`;
      const count =
        (this.#terminalCounts.get(checkpoint.name) ?? 0) +
        countOccurrences(combined, trigger.value);
      this.#terminalCounts.set(checkpoint.name, count);
      this.#terminalTails.set(
        checkpoint.name,
        trigger.value.length === 1
          ? ""
          : combined.slice(-(trigger.value.length - 1)),
      );
      if (count >= trigger.occurrence) this.capture(checkpoint.name);
    }
  }

  /** Capture every checkpoint assigned to the specified lifecycle trigger. */
  trigger(type: "root_exit" | "settled"): void {
    for (const checkpoint of this.scenario.checkpoints)
      if (checkpoint.trigger.type === type) this.capture(checkpoint.name);
  }

  /** Queue one idempotent named snapshot. */
  capture(name: string): void {
    if (this.#captured.has(name)) return;
    this.#captured.add(name);
    this.#pending = this.#pending.then(async () => {
      const snapshot = await snapshotRoots(this.scenario, this.signal);
      const previous = this.#captures.at(-1)?.files ?? [];
      this.#captures.push({
        name,
        at_ms: Math.max(0, Date.now() - this.started),
        files: snapshot.files,
        effects: classifyFilesystemEffects(previous, snapshot.files),
        truncated: snapshot.truncated,
      });
    });
  }

  /** Finish pending snapshots and return them in observation order. */
  async finish(
    after: SnapshotResult,
  ): Promise<readonly FilesystemCheckpoint[]> {
    for (const timer of this.#timers) clearTimeout(timer);
    await this.#pending;
    const previous = this.#captures.at(-1)?.files ?? [];
    this.#captures.push({
      name: "after_settlement",
      at_ms: Math.max(0, Date.now() - this.started),
      files: after.files,
      effects: classifyFilesystemEffects(previous, after.files),
      truncated: after.truncated,
    });
    return this.#captures;
  }

  /** Cancel scheduled captures and await any snapshot already in progress. */
  async dispose(): Promise<void> {
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
    await this.#pending;
  }
}

const countOccurrences = (text: string, value: string): number => {
  let count = 0;
  let offset = 0;
  while (offset <= text.length - value.length) {
    const found = text.indexOf(value, offset);
    if (found < 0) break;
    count += 1;
    offset = found + value.length;
  }
  return count;
};
