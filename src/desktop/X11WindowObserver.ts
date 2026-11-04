import {
  X11_WINDOW_PROPERTY_NAMES,
  parseX11ClientList,
  parseX11WindowProperties,
  type X11WindowProperties,
} from "../domain/desktop/x11Windows.js";
import {
  execFileOutput,
  execFileOutputFailure,
} from "../process/ExecFileOutput.js";

const XPROP_TIMEOUT_MS = 5_000;
const XPROP_MAX_BUFFER = 1024 * 1024;

/** One managed top-level window seen in a sample. */
export interface ObservedWindow extends X11WindowProperties {
  readonly id: string;
}

/** `xprop` could not be started at all. */
export class XpropUnavailableError extends Error {
  constructor(readonly command: string) {
    super(`${command} could not be started`);
    this.name = "XpropUnavailableError";
  }
}

/**
 * Lists the window manager's client windows with `xprop`. A window's class,
 * pid and type are read once; titles are re-read only for windows the caller
 * marks as interesting, since every read starts a process.
 */
export class X11WindowObserver {
  readonly #command: string;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #known = new Map<string, X11WindowProperties>();

  constructor(command: string, environment: NodeJS.ProcessEnv) {
    this.#command = command;
    this.#environment = environment;
  }

  async #xprop(
    arguments_: readonly string[],
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    try {
      const { stdout } = await execFileOutput(this.#command, arguments_, {
        env: this.#environment,
        timeout: XPROP_TIMEOUT_MS,
        maxBuffer: XPROP_MAX_BUFFER,
        ...(signal === undefined ? {} : { signal }),
      });
      return stdout;
    } catch (cause: unknown) {
      signal?.throwIfAborted();
      if (execFileOutputFailure(cause)?.code === "ENOENT")
        throw new XpropUnavailableError(this.#command);
      // A window can close between listing and reading it.
      return undefined;
    }
  }

  /** The current client list, or undefined when the display cannot be read. */
  async sample(
    refresh: (window: ObservedWindow) => boolean,
    signal?: AbortSignal,
  ): Promise<readonly ObservedWindow[] | undefined> {
    const root = await this.#xprop(
      ["-root", "-notype", "_NET_CLIENT_LIST"],
      signal,
    );
    if (root === undefined) return undefined;
    const windows: ObservedWindow[] = [];
    for (const id of parseX11ClientList(root)) {
      const cached = this.#known.get(id);
      if (cached !== undefined && !refresh({ id, ...cached })) {
        windows.push({ id, ...cached });
        continue;
      }
      const output = await this.#xprop(
        ["-id", id, "-notype", ...X11_WINDOW_PROPERTY_NAMES],
        signal,
      );
      if (output === undefined) continue;
      const properties = parseX11WindowProperties(output);
      this.#known.set(id, properties);
      windows.push({ id, ...properties });
    }
    return windows;
  }
}
