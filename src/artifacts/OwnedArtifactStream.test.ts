import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { finished } from "node:stream/promises";
import { setImmediate } from "node:timers/promises";
import { expect, it, vi } from "vitest";

import { buildGodotPck } from "../../tests/fixtures/godotPck.js";
import { awaitAcknowledgement } from "../../tests/fixtures/lifecycleAcknowledgement.js";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { buildUImage } from "../../tests/fixtures/uimage.js";
import { openRegularFile } from "../filesystem/RegularFile.js";
import { GodotPckArtifactReader } from "./GodotPckArtifactReader.js";
import { NodeSeaArtifactReader } from "./NodeSeaArtifactReader.js";
import { UImageArtifactReader } from "./UImageArtifactReader.js";
import { nodeSeaElf } from "./nodeSea/NodeSea.fixture.js";

const godot = {
  label: "Godot",
  Reader: GodotPckArtifactReader,
  fixture: () =>
    buildGodotPck(4, [{ path: "main.gd", data: "extends Node\n" }]),
};

const uimage = {
  label: "uImage",
  Reader: UImageArtifactReader,
  fixture: () => buildUImage({ payload: Buffer.from("inert payload") }),
};

it.for([
  { ...godot, stage: "read", fail: true, order: "close" },
  {
    label: "Node SEA",
    Reader: NodeSeaArtifactReader,
    fixture: () => nodeSeaElf({ codePath: "main.js", main: "42" }),
    stage: "read",
    fail: true,
    order: "close",
  },
  { ...godot, stage: "read", fail: false, order: "close" },
  { ...godot, stage: "validation", fail: true, order: "close" },
  { ...godot, stage: "validation", fail: false, order: "close" },
  ...["read", "validation"].flatMap((stage) =>
    ["close", "caller-first", "close-first"].flatMap((order) =>
      [true, false].map((fail) => ({ ...uimage, stage, fail, order })),
    ),
  ),
])(
  "settles admitted $label $stage after $order (I/O fault: $fail)",
  async ({ Reader, fixture, stage, fail, order }) => {
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
    const caller = new AbortController();
    const callerReason = new Error("caller cancelled the member");
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
      const output = await reader.open(entry, caller.signal);
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
      if (order === "caller-first") caller.abort(callerReason);
      const closing = reader.close().then(() => {
        closed = true;
      });
      if (order === "close-first") caller.abort(callerReason);
      await setImmediate();
      const closedBeforeSettlement = closed || output.closed;
      release();
      const result = await settled;
      await closing;
      if (fail) expect(result).toBe(failure);
      else if (order === "caller-first")
        expect(result).toMatchObject({
          reason: "cancelled",
          cause: callerReason,
        });
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
