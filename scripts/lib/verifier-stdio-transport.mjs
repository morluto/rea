import { ChildProcess } from "node:child_process";

import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

import { ProviderProcessSupervisor } from "../../dist/process/ProviderProcess.js";
import { closeVerifierResources } from "./verifier-cleanup.mjs";

const noChildHandle = () =>
  new Error(
    "The MCP SDK stdio transport exposes no child handle, so its completion cannot be proven",
  );

/**
 * SDK stdio transport that can prove its child finished.
 *
 * The SDK's `close()` can return right after sending its final SIGKILL, before
 * the child is reaped, and its `pid` is cleared by then. `close()` itself keeps
 * that contract and must not reject: the SDK calls it without awaiting after a
 * failed handshake. Callers that release resources the child can use await
 * `closeAndVerifyChild()` instead.
 */
export class VerifierStdioClientTransport extends StdioClientTransport {
  #supervisor;
  #handleMissing = false;
  #outputClosed = false;

  async start() {
    const started = super.start();
    // The SDK assigns its child synchronously and exposes only that PID.
    const child = Reflect.get(this, "_process");
    // A failed spawn rejects here, having acquired nothing to prove finished.
    await started;
    if (!(child instanceof ChildProcess)) {
      this.#handleMissing = true;
      throw noChildHandle();
    }
    // An unread stderr would hold the child's pipe open past its exit.
    this.stderr?.resume();
    child.once("close", () => {
      this.#outputClosed = true;
    });
    this.#supervisor = new ProviderProcessSupervisor(
      { process: child, ownsProcessLifetime: true },
      {
        captureStdout: false,
        maxDiagnosticBytes: { stdout: 0, stderr: 0 },
      },
    );
  }

  /**
   * Close through the SDK, then stop any surviving child and prove it finished.
   * A rejection keeps the child owned; calling this again retries from its state.
   */
  closeAndVerifyChild() {
    return closeVerifierResources([
      () => this.close(),
      () => this.#verifyChildFinished(),
    ]);
  }

  async #verifyChildFinished() {
    if (this.#handleMissing) throw noChildHandle();
    const supervisor = this.#supervisor;
    if (supervisor === undefined) return;
    const stopped = await supervisor.stop();
    const child = `MCP stdio child ${String(supervisor.launch.process.pid)}`;
    if (stopped.status === "incomplete")
      throw new Error(
        `${child} completion could not be proven: ${stopped.reason}`,
      );
    // Exit proves only this process. Its pipes stay open while anything that
    // inherited them runs, including a reparented process no lineage walk finds.
    if (!this.#outputClosed)
      throw new Error(
        `${child} exited, but its stdio pipes are still open, so a process that inherited them may still be running`,
      );
  }
}
