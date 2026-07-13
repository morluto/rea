import { createRequire } from "node:module";

import type { RenderedTerminalFrame } from "../domain/processCapture.js";

const require = createRequire(import.meta.url);
// SAFETY: both pinned xterm packages publish CommonJS at runtime and matching declarations.
const HeadlessPackage =
  require("@xterm/headless") as typeof import("@xterm/headless");
// SAFETY: the addon package is pinned with the compatible headless xterm release.
const SerializePackage =
  require("@xterm/addon-serialize") as typeof import("@xterm/addon-serialize");

interface TerminalRendererOptions {
  readonly columns: number;
  readonly rows: number;
  readonly scrollback: number;
  readonly maxFrames: number;
  readonly maxBytes: number;
  readonly normalize: (value: string) => string;
}

/** Owns one headless terminal and serializes writes into deterministic frames. */
export class TerminalRenderer {
  readonly #terminal: InstanceType<typeof HeadlessPackage.Terminal>;
  readonly #serializeAddon = new SerializePackage.SerializeAddon();
  readonly #frames: RenderedTerminalFrame[] = [];
  #pending: Promise<void> = Promise.resolve();
  #capturedBytes = 0;
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
    return this.#frames;
  }

  /** Whether a rendered observation exceeded its independent capture budget. */
  truncated(): boolean {
    return this.#truncated;
  }

  /** Release addon and terminal resources after all writes settle. */
  async dispose(): Promise<void> {
    await this.#pending;
    this.#serializeAddon.dispose();
    this.#terminal.dispose();
  }

  #capture(atMs: number): void {
    const buffer = this.#terminal.buffer.active;
    const lines: string[] = [];
    for (let row = 0; row < this.#terminal.rows; row += 1) {
      const line = buffer.getLine(buffer.viewportY + row);
      lines.push(
        this.options.normalize(
          (line?.translateToString(false, 0, this.#terminal.cols) ?? "").padEnd(
            this.#terminal.cols,
            " ",
          ),
        ),
      );
    }
    const serializedState = this.options.normalize(
      this.#serializeAddon.serialize(),
    );
    const bytes =
      Buffer.byteLength(serializedState) +
      lines.reduce((total, line) => total + Buffer.byteLength(line), 0);
    if (
      this.#frames.length >= this.options.maxFrames ||
      this.#capturedBytes + bytes > this.options.maxBytes
    ) {
      this.#truncated = true;
      return;
    }
    this.#capturedBytes += bytes;
    this.#frames.push({
      sequence: this.#frames.length,
      at_ms: atMs,
      columns: this.#terminal.cols,
      rows: this.#terminal.rows,
      cursor_x: buffer.cursorX,
      cursor_y: buffer.cursorY,
      active_buffer: buffer.type,
      lines,
      serialized_state: serializedState,
    });
  }
}
