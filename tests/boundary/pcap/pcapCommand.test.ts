import { setTimeout as delay } from "node:timers/promises";
import { expect, it, onTestFinished, vi } from "vitest";
import { runPcapCommand } from "../../../src/pcap/PcapCommand.js";
import * as ownership from "../../../src/process/ProcessOwnershipObservation.js";

it("does not spend the tool execution deadline preparing native ownership", async () => {
  const original = ownership.prepareProcessOwnershipInspection;
  let entered!: () => void;
  let release!: () => void;
  const preparing = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let first = true;
  const prepare = vi
    .spyOn(ownership, "prepareProcessOwnershipInspection")
    .mockImplementation(async (signal) => {
      await original(signal);
      if (first) {
        first = false;
        entered();
        await gate;
      }
    });
  onTestFinished(() => {
    prepare.mockRestore();
    release();
  });
  const pending = runPcapCommand({
    operation: "inspect_pcap_client",
    command: process.execPath,
    arguments: ["--version"],
    limits: { timeoutMs: 1000, maxOutputBytes: 1024 },
    environment: {},
    signal: undefined,
    retain: (owner) => {
      onTestFinished(async () => {
        expect((await owner.stop()).status).not.toBe("incomplete");
      });
    },
  }).then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  await preparing;
  await delay(1100);
  release();
  const result = await pending;
  if (!result.ok) throw result.error;
  expect(result.value.stdout.trim()).toBe(process.version);
});
