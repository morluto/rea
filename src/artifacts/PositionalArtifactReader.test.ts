import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { finished } from "node:stream/promises";
import { setImmediate } from "node:timers/promises";
import { expect, it, vi } from "vitest";

import { buildGodotPck } from "../../tests/fixtures/godotPck.js";
import { awaitAcknowledgement } from "../../tests/fixtures/lifecycleAcknowledgement.js";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { openRegularFile } from "../filesystem/RegularFile.js";
import { GodotPckArtifactReader } from "./GodotPckArtifactReader.js";
import { NodeSeaArtifactReader } from "./NodeSeaArtifactReader.js";
import { nodeSeaElf } from "./nodeSea/NodeSea.fixture.js";

const godot = {
  label: "Godot",
  Reader: GodotPckArtifactReader,
  fixture: () =>
    buildGodotPck(4, [{ path: "main.gd", data: "extends Node\n" }]),
};

it.for([
  { ...godot, stage: "read", fail: true },
  {
    label: "Node SEA",
    Reader: NodeSeaArtifactReader,
    fixture: () => nodeSeaElf({ codePath: "main.js", main: "42" }),
    stage: "read",
    fail: true,
  },
  { ...godot, stage: "read", fail: false },
  { ...godot, stage: "validation", fail: true },
  { ...godot, stage: "validation", fail: false },
])(
  "settles admitted $label $stage during close (I/O fault: $fail)",
  async ({ Reader, fixture, stage, fail }) => {
    const root = await createTestTempDirectory("rea-positional-close-");
    const path = join(root, "carrier");
    await writeFile(path, fixture());
    const descriptor = await openRegularFile(path, { symlinks: "reject" });
    const reader = new Reader(path, descriptor);
    let acknowledge = () => {};
    let release = () => {};
    const started = new Promise<void>((resolve) => {
      acknowledge = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const failure = Object.assign(new Error("physical descriptor I/O failed"), {
      code: "EIO",
    });
    const settle = async <T>(pending: Promise<T>): Promise<T> => {
      const result = await pending;
      acknowledge();
      await gate;
      if (fail) throw failure;
      return result;
    };
    try {
      let entry;
      for await (const member of reader.entries()) {
        entry = member;
        break;
      }
      if (entry === undefined) throw new Error("Expected one carrier member");
      if (stage === "read") {
        const read = descriptor.handle.read.bind(descriptor.handle);
        vi.spyOn(descriptor.handle, "read").mockImplementation(
          (...args: unknown[]) =>
            settle(Reflect.apply(read, descriptor.handle, args)),
        );
      }
      const output = await reader.open(entry);
      if (stage === "validation") {
        const stat = descriptor.handle.stat.bind(descriptor.handle);
        vi.spyOn(descriptor.handle, "stat").mockImplementation(
          (...args: unknown[]) =>
            settle(Reflect.apply(stat, descriptor.handle, args)),
        );
      }
      const settled = finished(output, { cleanup: true }).catch(
        (cause: unknown) => cause,
      );
      let bytesDelivered = 0;
      output.on("data", (chunk: Buffer) => {
        bytesDelivered += chunk.length;
      });
      await awaitAcknowledgement(started, settled, stage);
      let closed = false;
      const closing = reader.close().then(() => {
        closed = true;
      });
      await setImmediate();
      const closedBeforeSettlement = closed || output.closed;
      release();
      const result = await settled;
      await closing;
      if (fail) expect(result).toBe(failure);
      else expect(result).toMatchObject({ reason: "unavailable" });
      expect(closedBeforeSettlement).toBe(false);
      expect(bytesDelivered).toBe(stage === "read" ? 0 : entry.declaredSize);
      expect(descriptor.handle.fd).toBeGreaterThanOrEqual(0);
    } finally {
      release();
      await reader.close();
      await descriptor.handle.close();
    }
  },
);
