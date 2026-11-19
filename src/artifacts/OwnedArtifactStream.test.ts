import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { finished } from "node:stream/promises";
import { setImmediate } from "node:timers/promises";
import { expect, it, vi } from "vitest";

import { buildGodotPck } from "../../tests/fixtures/godotPck.js";
import { renameOpenParent } from "../../tests/fixtures/renameOpenParent.js";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { buildUImage } from "../../tests/fixtures/uimage.js";
import { phaseGate } from "../../tests/support/lifecycleHarness.js";
import * as regularFile from "../filesystem/RegularFile.js";
import { BunStandaloneArtifactReader } from "./BunStandaloneArtifactReader.js";
import { DenoStandaloneArtifactReader } from "./DenoStandaloneArtifactReader.js";
import { GodotPckArtifactReader } from "./GodotPckArtifactReader.js";
import { NodeSeaArtifactReader } from "./NodeSeaArtifactReader.js";
import { UImageArtifactReader } from "./UImageArtifactReader.js";
import {
  bunModuleGraphPayload,
  elfAppendedBunPayload,
} from "./bun/BunStandalone.fixture.js";
import { denoElf } from "./deno/DenoStandalone.fixture.js";
import { nodeSeaElf } from "./nodeSea/NodeSea.fixture.js";

const godot = {
  label: "Godot",
  Reader: GodotPckArtifactReader,
  fixture: () =>
    buildGodotPck(4, [{ path: "main.gd", data: "extends Node\n" }]),
  owned: false,
};

const uimage = {
  label: "uImage",
  Reader: UImageArtifactReader,
  fixture: () => buildUImage({ payload: Buffer.from("inert payload") }),
  owned: false,
};

const standaloneReaders = [
  {
    label: "Bun",
    Reader: BunStandaloneArtifactReader,
    fixture: () =>
      elfAppendedBunPayload(
        bunModuleGraphPayload({
          modules: [
            { name: "main.js", contents: Buffer.from("inert payload") },
          ],
        }),
      ),
  },
  {
    label: "Deno",
    Reader: DenoStandaloneArtifactReader,
    fixture: () => denoElf(),
  },
] as const;

it.for([
  { ...godot, stage: "read", fail: true, order: "close" },
  {
    label: "Node SEA",
    Reader: NodeSeaArtifactReader,
    fixture: () => nodeSeaElf({ codePath: "main.js", main: "42" }),
    stage: "read",
    fail: true,
    order: "close",
    owned: false,
  },
  { ...godot, stage: "read", fail: false, order: "close" },
  { ...godot, stage: "validation", fail: true, order: "close" },
  { ...godot, stage: "validation", fail: false, order: "close" },
  ...["read", "validation"].flatMap((stage) =>
    ["close", "caller-first", "close-first"].flatMap((order) =>
      [true, false].map((fail) => ({ ...uimage, stage, fail, order })),
    ),
  ),
  ...standaloneReaders.flatMap((fixture) =>
    ["read", "validation"].flatMap((stage) =>
      [false, true].map((owned) => ({
        ...fixture,
        stage,
        fail: true,
        order: "close",
        owned,
      })),
    ),
  ),
])(
  "settles admitted $label $stage after $order (owned: $owned, I/O fault: $fail)",
  async ({ Reader, fixture, stage, fail, order, owned }) => {
    const root = await createTestTempDirectory("rea-positional-close-");
    const path = join(root, "carrier");
    await writeFile(path, fixture());
    const open = regularFile.openRegularFile;
    const borrowed = owned
      ? undefined
      : await open(path, { symlinks: "reject" });
    let descriptor = borrowed;
    const admission = owned
      ? vi
          .spyOn(regularFile, "openRegularFile")
          .mockImplementationOnce(
            async (...args) => (descriptor = await open(...args)),
          )
      : undefined;
    const reader = new Reader(path, borrowed);
    const gate = phaseGate();
    const failure = Object.assign(new Error("physical descriptor I/O failed"), {
      code: "EIO",
    });
    const caller = new AbortController();
    const callerReason = new Error("caller cancelled the member");
    const settle = async <T>(pending: Promise<T>): Promise<T> => {
      const result = await pending;
      await gate.hold();
      return result;
    };
    try {
      let entry;
      for await (const member of reader.entries()) {
        entry = member;
        break;
      }
      if (entry === undefined) throw new Error("Expected one carrier member");
      const handle = descriptor?.handle;
      if (handle === undefined)
        throw new Error("Expected an admitted descriptor");
      if (stage === "read") {
        const read = handle.read.bind(handle);
        vi.spyOn(handle, "read").mockImplementation((...args: unknown[]) =>
          settle(Reflect.apply(read, handle, args)),
        );
      }
      const output = await reader.open(entry, caller.signal);
      if (stage === "validation") {
        const stat = handle.stat.bind(handle);
        vi.spyOn(handle, "stat").mockImplementation((...args: unknown[]) =>
          settle(Reflect.apply(stat, handle, args)),
        );
      }
      const settled = finished(output, { cleanup: true }).catch(
        (cause: unknown) => cause,
      );
      let bytesDelivered = 0;
      output.on("data", (chunk: Buffer) => {
        bytesDelivered += chunk.length;
      });
      await gate.reached(settled, stage);
      let closed = false;
      if (order === "caller-first") caller.abort(callerReason);
      const closing = reader.close().then(() => {
        closed = true;
      });
      if (order === "close-first") caller.abort(callerReason);
      await setImmediate();
      const closedBeforeSettlement = closed || output.closed;
      if (fail) gate.reject(failure);
      else gate.release();
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
      if (owned) expect(handle.fd).toBe(-1);
      else expect(handle.fd).toBeGreaterThanOrEqual(0);
    } finally {
      admission?.mockRestore();
      gate.release();
      await reader.close();
      await borrowed?.handle.close();
    }
  },
);

it.for(standaloneReaders)(
  "rejects a $label selected-path replacement after member admission",
  async ({ Reader, fixture }, context) => {
    const root = await createTestTempDirectory(
      "rea-standalone-selected-close-",
    );
    const selected = join(root, "selected");
    await mkdir(selected);
    const path = join(selected, "carrier");
    const bytes = fixture();
    await writeFile(path, bytes);
    const descriptor = await regularFile.openRegularFile(path, {
      symlinks: "reject",
    });
    const reader = new Reader(path, descriptor);
    const gate = phaseGate();
    try {
      let entry;
      for await (const member of reader.entries()) {
        entry = member;
        break;
      }
      if (entry === undefined) throw new Error("Expected one carrier member");
      const { handle } = descriptor;
      const read = handle.read.bind(handle);
      vi.spyOn(handle, "read").mockImplementationOnce(async (...args) => {
        const result = await read(...args);
        await gate.hold();
        return result;
      });
      const output = await reader.open(entry);
      const settled = finished(output, { cleanup: true }).catch(
        (cause: unknown) => cause,
      );
      output.resume();
      await gate.reached(settled, "standalone member read");
      const renamed = await renameOpenParent(selected, join(root, "original"));
      if (renamed.kind === "blocked") context.skip();
      await mkdir(selected);
      await writeFile(path, bytes);
      gate.release();
      await expect(settled).resolves.toMatchObject({
        reason: "integrity",
        integrityCheck: "container-identity",
      });
    } finally {
      gate.release();
      await reader.close();
      await descriptor.handle.close();
    }
  },
);
