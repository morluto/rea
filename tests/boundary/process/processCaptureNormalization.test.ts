import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { z } from "zod";

import { captureProcessScenario } from "../../../src/process/capture/ProcessHarness.js";
import { createProcessCaptureEvidence } from "../../../src/application/process/ProcessEvidence.js";
import {
  digestProcessCommitment,
  parseProcessCapture,
  parseProcessScenario,
} from "../../../src/domain/process/processCapture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { itWithCaptureCapability } from "./processCaptureCapability.js";

const processFixture = fileURLToPath(
  new URL("../../fixtures/processIdentity.mjs", import.meta.url),
);
const identitySchema = z.object({
  pid: z.number().int().positive(),
  parent_pid: z.number().int().positive(),
  process_group_id: z.number().int().positive(),
  session_id: z.number().int().positive(),
});

const itWithLinuxCaptureCapability =
  process.platform === "linux" ? itWithCaptureCapability : it.skip;

itWithCaptureCapability(
  "preserves numeric reports and original normalized PTY text in Evidence",
  async () => {
    const root = await createTestTempDirectory("rea-process-numeric-report-");
    const report = JSON.stringify({
      pid: 32,
      size: 108,
      height: 480,
      width: 640,
      score: 20,
    });
    const original = `${report}\nlisten:8080\n`;
    const scenario = parseProcessScenario({
      executable: process.execPath,
      working_directory: root,
      arguments: ["-e", `process.stdout.write(${JSON.stringify(original)})`],
      settle_ms: 100,
    });
    const result = await captureProcessScenario(scenario);
    if (!result.ok) throw result.error;
    const capture = parseProcessCapture(
      createProcessCaptureEvidence(scenario, result.value).normalized_result,
    );
    expect(capture.frames.map(({ data }) => data).join("")).toContain(report);
    expect(capture.frames.map(({ data }) => data).join("")).toContain(
      "listen:<port>",
    );
    expect(
      capture.frames.map(({ data, raw_data }) => raw_data ?? data).join(""),
    ).toBe(original.replaceAll("\n", "\r\n"));
    expect(
      capture.rendered_frames.some(({ serialized_state }) =>
        serialized_state.includes(report),
      ),
    ).toBe(true);
    expect(capture.manifest.comparison_contract).toMatchObject({
      port_normalization_version: "contextual-endpoints-v1",
    });
    expect(capture.exit).toMatchObject({ code: 0, reason: "exited" });
    expect(capture.cleanup).toMatchObject({
      owned_process_group: "verified",
      temporary_root: "removed",
    });
  },
);

itWithLinuxCaptureCapability.each([false, true])(
  "honors pids=%s in owned Linux capture samples and committed Evidence",
  async (pids) => {
    const root = await createTestTempDirectory("rea-process-identifiers-");
    const identityPath = join(root, "identity.json");
    const scenario = parseProcessScenario({
      executable: process.execPath,
      arguments: [processFixture, identityPath],
      working_directory: root,
      normalization: { pids, ports: false, paths: false },
      timeout_ms: 10_000,
      idle_timeout_ms: 10_000,
    });
    const result = await captureProcessScenario(scenario);
    if (!result.ok) throw result.error;
    const capture = result.value;
    const identity = identitySchema.parse(
      JSON.parse(await readFile(identityPath, "utf8")),
    );
    expect(identity.process_group_id).toBe(identity.pid);
    expect(identity.session_id).toBe(identity.pid);
    expect(identity.parent_pid).not.toBe(identity.pid);
    const fixtureSamples = capture.process_samples.filter(({ command }) =>
      command.includes(processFixture),
    );
    expect(fixtureSamples.length).toBeGreaterThan(0);
    for (const sample of fixtureSamples)
      expect(sample).toMatchObject(
        pids
          ? { pid: 1, parent_pid: 2, process_group_id: 1, session_id: 1 }
          : identity,
      );
    const output = capture.frames.map(({ data }) => data).join("");
    if (pids) expect(output).toContain('"pid":<pid>');
    else expect(output).toContain(JSON.stringify(identity));

    const evidence = createProcessCaptureEvidence(scenario, capture);
    const serializedCapture = parseProcessCapture(evidence.normalized_result);
    expect(evidence.parameters).toMatchObject({ normalization: { pids } });
    expect(serializedCapture.process_samples).toEqual(capture.process_samples);
    expect(serializedCapture.normalization.pids).toBe(pids);
    expect(serializedCapture.manifest.scenario).toMatchObject({
      normalization: { pids },
    });
    expect(serializedCapture.manifest.comparison_contract).toMatchObject({
      normalization: { pids },
    });
    expect(serializedCapture.manifest.normalization_sha256).toBe(
      digestProcessCommitment(scenario.normalization),
    );
    expect(capture.exit).toMatchObject({ code: 0, reason: "exited" });
    expect([null, 0]).toContain(capture.exit.signal);
    expect(capture.settlement).toMatchObject({
      state: "quiesced",
      cleanup_outcome: "not_required",
    });
    expect(capture.cleanup).toMatchObject({
      owned_process_group: "verified",
      temporary_root: "removed",
    });
  },
  20_000,
);
