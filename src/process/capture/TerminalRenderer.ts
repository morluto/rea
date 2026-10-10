import { createRequire } from "node:module";
import type { TerminalRetention } from "../../domain/process/processCaptureCoverage.js";

import type {
  RecordProcessCaptureEvent,
  RenderedTerminalFrame,
} from "../../domain/process/processCapture.js";

const require = createRequire(import.meta.url);
// SAFETY: both pinned xterm packages publish CommonJS at runtime and matching declarations.
const HeadlessPackage =
  require("@xterm/headless") as typeof import("@xterm/headless");
// SAFETY: the addon package is pinned with the compatible headless xterm release.
const SerializePackage =
  require("@xterm/addon-serialize") as typeof import("@xterm/addon-serialize");

const TRAILING_SPACES = / +$/u;

interface TerminalRendererOptions {
  readonly columns: number;
  readonly rows: number;
  readonly scrollback: number;
  readonly maxBytes: number;
  readonly normalize: (value: string) => string;
  readonly recordEvent?: RecordProcessCaptureEvent;
}

/**
 * Owns one headless terminal and serializes writes into deterministic frames.
 * Reconstructs bounded terminal states while raw PTY chunks remain authoritative.
 *
 * Rendered frames answer what an operator saw after control-sequence handling;
 * raw frames preserve byte/chunk differences that can render identically.
 * Comparisons retain both because neither representation subsumes the other.
 */
export class TerminalRenderer {
  readonly #terminal: InstanceType<typeof HeadlessPackage.Terminal>;
  readonly #serializeAddon = new SerializePackage.SerializeAddon();
  readonly #frames: RenderedTerminalFrame[] = [];
  #pending: Promise<void> = Promise.resolve();
  #capturedBytes = 0;
  #observedBytes = 0;
  #observedFrames = 0;
  #truncated = false;

  constructor(private readonly options: TerminalRendererOptions) {
    this.#terminal = new HeadlessPackage.Terminal({
      allowProposedApi: true,
      cols: options.columns,
      rows: options.rows,
      scrollback: options.scrollback,
    });
    this.#terminal.loadAddon(this.#serializeAddon);
  }

  /** Queue one PTY chunk and capture state only after xterm has parsed it. */
  write(data: string, atMs: number): void {
    this.#pending = this.#pending.then(
      () =>
        new Promise<void>((resolveWrite) => {
          this.#terminal.write(data, () => {
            this.#capture(atMs);
            resolveWrite();
          });
        }),
    );
  }

  /** Queue a terminal resize after every preceding write. */
  resize(columns: number, rows: number, atMs: number): void {
    this.#pending = this.#pending.then(() => {
      this.#terminal.resize(columns, rows);
      this.#capture(atMs);
    });
  }

  /** Await all queued parsing and return immutable rendered observations. */
  async frames(): Promise<readonly RenderedTerminalFrame[]> {
    await this.#pending;
    return structuredClone(this.#frames);
  }

  /** Whether a rendered observation exceeded its independent capture budget. */
  truncated(): boolean {
    return this.#truncated;
  }

  /** Budget accounting after awaiting queued writes with frames(). */
  retention(): TerminalRetention {
    return {
      budget_bytes: this.options.maxBytes,
      observed_bytes: this.#observedBytes,
      retained_bytes: this.#capturedBytes,
      observed_frames: this.#observedFrames,
      retained_frames: this.#frames.length,
    };
  }

  /** Release addon and terminal resources after all writes settle. */
  async dispose(): Promise<void> {
    try {
      await this.#pending;
    } finally {
      try {
        this.#serializeAddon.dispose();
      } finally {
        this.#terminal.dispose();
      }
    }
  }

  #capture(atMs: number): void {
    const buffer = this.#terminal.buffer.active;
    const lines: string[] = [];
    for (let row = 0; row < this.#terminal.rows; row += 1) {
      const line = buffer.getLine(buffer.viewportY + row);
      // Trailing blank cells carry no information beyond `columns`; dropping
      // them keeps sparse screens from costing a full row per blank line.
      lines.push(
        this.options
          .normalize(
            (
              line?.translateToString(false, 0, this.#terminal.cols) ?? ""
            ).padEnd(this.#terminal.cols, " "),
          )
          .replace(TRAILING_SPACES, ""),
      );
    }
    const serializedState = this.options.normalize(
      this.#serializeAddon.serialize(),
    );
    const bytes =
      Buffer.byteLength(serializedState) +
      lines.reduce((total, line) => total + Buffer.byteLength(line), 0);
    this.#observedBytes += bytes;
    this.#observedFrames += 1;
    if (this.#capturedBytes + bytes > this.options.maxBytes) {
      this.#truncated = true;
      return;
    }
    this.#capturedBytes += bytes;
    const sequence = this.#frames.length;
    this.#frames.push({
      sequence,
      at_ms: atMs,
      columns: this.#terminal.cols,
      rows: this.#terminal.rows,
      cursor_x: buffer.cursorX,
      cursor_y: buffer.cursorY,
      active_buffer: buffer.type,
      lines,
      serialized_state: serializedState,
    });
    this.options.recordEvent?.("rendered_frames", sequence);
  }
}
