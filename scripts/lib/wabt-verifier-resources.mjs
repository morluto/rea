import { readdir, rm } from "node:fs/promises";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { ProviderProcessSupervisor } from "../../dist/process/ProviderProcess.js";
import {
  assertVerifierCleanupComplete,
  completeVerifierRun,
} from "./verifier-run.mjs";

/** Keep the SDK's exact child after its close method forgets that handle. */
export class WabtVerifierTransport extends StdioClientTransport {
  #supervisor;
  #closed = false;
  #closeEvent;
  #started = false;

  async start() {
    this.#started = true;
    const starting = super.start();
    // The pinned SDK assigns its child synchronously, before awaiting spawn.
    // Capture now, including a failed spawn or handshake, before SDK cleanup.
    const child = this._process;
    if (child !== undefined) {
      this.#closeEvent = new Promise((resolve) => {
        child.once("close", () => {
          this.#closed = true;
          resolve();
        });
      });
      this.#supervisor = new ProviderProcessSupervisor(
        { process: child, ownsProcessLifetime: true },
        { captureStdout: false, maxDiagnosticBytes: 64 * 1024 },
      );
    }
    // Drain the SDK's separate stderr PassThrough as well as the child's pipe.
    this.stderr?.resume();
    await starting;
    if (this.#supervisor === undefined)
      throw new Error("WABT verifier could not retain the SDK child handle");
  }

  async closeAndVerifyChild() {
    const failures = [];
    try {
      await super.close();
    } catch (cause) {
      failures.push(cause);
    }
    if (this.#supervisor !== undefined) {
      const stopped = await this.#supervisor.stop();
      if (stopped.status === "incomplete")
        failures.push(new Error(stopped.reason));
      if (!this.#closed) {
        let timer;
        try {
          await Promise.race([
            this.#closeEvent,
            new Promise((resolve) => {
              timer = setTimeout(resolve, 1_000);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      }
      if (!this.#closed) {
        this.#supervisor.unref();
        failures.push(new Error("WABT MCP child output has not closed"));
      }
    } else if (this.#started) {
      failures.push(new Error("WABT MCP child completion is unknown"));
    }
    if (failures.length !== 0)
      throw new AggregateError(failures, "WABT MCP transport cleanup failed");
  }
}

/** A retry always returns to the same owners and the same retained roots. */
export class WabtVerifierCleanupFailure extends Error {
  constructor(cause, cleanupOwner) {
    const retainedRoots = cleanupOwner.cleanupResources;
    super(
      `WABT verifier cleanup incomplete; retained ${retainedRoots.join(", ")}`,
      { cause },
    );
    this.name = "WabtVerifierCleanupFailure";
    Object.defineProperty(this, "cleanupOwner", { value: cleanupOwner });
    this.retainedRoots = retainedRoots;
  }
}

/** Directories depend on MCP completion; their individual deletion is retryable. */
export class WabtVerifierResources {
  #client;
  #transport;
  verifier;
  #clientClosed = false;
  #transportClosed = false;
  #inputReleased = false;
  #tempReleased = false;
  #childTempRoot;
  #closing;

  constructor(root, childTempRoot, run) {
    this.root = root;
    this.childTempRoot = childTempRoot;
    this.run = run;
  }

  get cleanupResources() {
    return [
      ...(this.#inputReleased ? [] : [this.root.path]),
      ...(this.#tempReleased ? [] : [this.childTempRoot]),
    ];
  }

  get childTempRoot() {
    return this.#childTempRoot;
  }

  set childTempRoot(path) {
    this.#childTempRoot = path;
    this.#tempReleased = path === undefined;
  }

  set client(client) {
    this.#client = client;
  }

  set transport(transport) {
    this.#transport = transport;
  }

  close() {
    this.#closing ??= this.#close().finally(() => {
      this.#closing = undefined;
    });
    return this.#closing;
  }

  async #close() {
    if (this.#inputReleased && this.#tempReleased) return;
    const failures = [];
    if (!this.#clientClosed) {
      try {
        await this.#client?.close();
        this.#clientClosed = true;
      } catch (cause) {
        failures.push(cause);
      }
    }
    if (!this.#transportClosed) {
      try {
        await this.#transport?.closeAndVerifyChild();
        this.#transportClosed = true;
      } catch (cause) {
        failures.push(cause);
      }
    }
    // Attempt both independent MCP owners, but do not release their roots when
    // either failed, even if the other owner happened to stop the child.
    if (failures.length === 0) {
      try {
        this.verifier = await completeVerifierRun(this.run);
        if (process.platform !== "win32")
          assertVerifierCleanupComplete(this.verifier.process_lineage);
        if (!this.#tempReleased) {
          const entries = await readdir(this.childTempRoot);
          if (entries.some((name) => name.startsWith("rea-wabt-")))
            throw new Error("Provider workspace leaked");
        }
      } catch (cause) {
        failures.push(cause);
      }
    }
    if (failures.length === 0) {
      // Independent filesystem owners: preserve both errors and retry only the
      // directory whose release failed after MCP completion was established.
      if (!this.#inputReleased) {
        try {
          await this.root.close();
          this.#inputReleased = true;
        } catch (cause) {
          failures.push(cause);
        }
      }
      if (!this.#tempReleased) {
        try {
          await rm(this.childTempRoot, { recursive: true, force: true });
          this.#tempReleased = true;
        } catch (cause) {
          failures.push(cause);
        }
      }
    }
    if (failures.length !== 0)
      throw new WabtVerifierCleanupFailure(
        new AggregateError(failures, "WABT verifier resource cleanup failed"),
        this,
      );
  }
}
