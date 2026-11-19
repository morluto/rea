import { scheduler } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import {
  ArtifactReaderFailure,
  yieldArtifactRead,
} from "../../../src/resources/index.js";
import { openIl2cppImageCooperative } from "../../../src/il2cpp/Il2cppBinaryImage.js";
import { elfFrameAllowanceFixture } from "../../fixtures/binaryDiagnostics/elfFrameAllowance.js";

it("cancels a many-frame compressed ELF section-name table", async () => {
  const reason = new Error("stop il2cpp frames");
  const controller = new AbortController();
  const yieldImpl = scheduler.yield.bind(scheduler);
  let yields = 0;
  const spy = vi.spyOn(scheduler, "yield").mockImplementation(async () => {
    yields += 1;
    await yieldImpl();
    if (yields === 1) controller.abort(reason);
  });
  try {
    await openIl2cppImageCooperative(elfFrameAllowanceFixture(), () =>
      yieldArtifactRead(controller.signal),
    );
    throw new Error("compressed section names must be cancellable");
  } catch (cause) {
    expect(cause).toBeInstanceOf(ArtifactReaderFailure);
    expect(cause).toMatchObject({ reason: "cancelled", cause: reason });
  } finally {
    spy.mockRestore();
  }
});
