import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { z } from "zod";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";

type Delivery = "complete" | "summary";
type Observation = {
  evidence_id: string;
  parent_evidence_id?: string;
  limitations: string[];
  kind?: string;
  view?: { kind: string; facet?: string; offset?: number; limit?: number };
  coverage?:
    | string
    | {
        examined: number;
        total: number;
        next_offset: number | null;
        exhausted: boolean;
      };
  unknowns?: string[];
};
type Fixture = {
  summary: {
    artifact: string;
    delivery: Delivery;
    provider_search_path_sha256: string;
    calls: unknown[];
    packet_selection?: string;
    signal_selection?: string;
  };
  answer: {
    capture: { coverage: string; capture_start: null };
    http_request_uris_first2: string[];
    delivery_observations: Observation[];
    facts?: {
      kind: string;
      matching_packets?: number;
      rows?: readonly { frame: number }[];
      bytes?: readonly number[];
    };
  };
};
const reportSchema = z.object({
  facts_match: z.boolean(),
  settings_match: z.boolean(),
  fact_differences: z.array(z.string()),
  preserved_run_specific_values: z.array(z.object({ value: z.unknown() })),
});

// Synthetic measurement directories exercise the comparator CLI, not providers.
const observation = (kind: string): Observation => ({
  evidence_id: `ev_${kind}`,
  parent_evidence_id: "ev_parent",
  limitations: ["saved bytes only"],
  kind,
  view:
    kind === "summary"
      ? { kind }
      : { kind, facet: "http-uris", offset: 0, limit: 2 },
  coverage: { examined: 2, total: 3, next_offset: 2, exhausted: false },
  unknowns: ["unrecorded traffic"],
});
const fixture = (delivery: Delivery, artifact: string): Fixture => ({
  summary: {
    artifact,
    delivery,
    provider_search_path_sha256: "a".repeat(64),
    calls: [],
  },
  answer: {
    capture: { coverage: "complete", capture_start: null },
    http_request_uris_first2: [
      "http://example.test/one",
      "http://example.test/two",
    ],
    delivery_observations:
      delivery === "summary"
        ? [observation("summary"), observation("pcap")]
        : [
            {
              evidence_id: "ev_complete",
              limitations: ["saved bytes only"],
              coverage: "complete",
            },
          ],
  },
});
const comparator = fileURLToPath(
  new URL("../support/analysis-efficiency/compare.mjs", import.meta.url),
);
async function compare(left: Fixture, right: Fixture) {
  const root = await createTestTempDirectory("rea-compare-test-");
  const leftPath = join(root, "left");
  const rightPath = join(root, "right");
  for (const [directory, value] of [
    [leftPath, left],
    [rightPath, right],
  ] as const) {
    mkdirSync(directory);
    for (const name of ["summary", "answer"] as const)
      writeFileSync(
        join(directory, `${name}.json`),
        JSON.stringify(value[name]),
      );
  }
  const result = spawnSync(
    process.execPath,
    [comparator, "--left", leftPath, "--right", rightPath],
    { encoding: "utf8" },
  );
  assert.ifError(result.error);
  assert.equal(result.stderr, "");
  return {
    status: result.status,
    report: reportSchema.parse(JSON.parse(result.stdout)),
  };
}

async function assertEquivalent(left: Fixture, right: Fixture) {
  const { status, report } = await compare(left, right);
  assert.equal(status, 0);
  assert.equal(report.facts_match, true);
  assert.deepEqual(
    report.preserved_run_specific_values.map((row) => row.value),
    [left.answer.delivery_observations, right.answer.delivery_observations],
  );
}

async function assertDifference(left: Fixture, right: Fixture, field: string) {
  const { status, report } = await compare(left, right);
  assert.equal(status, 1);
  assert.equal(report.settings_match, true);
  assert.equal(report.facts_match, false);
  assert.deepEqual(report.fact_differences, [field]);
}

const recordingPlans = [
  {
    artifact: "wireshark-pgsql-jdbc.pcap",
    siblings: ["wireshark-dns.cap", "wireshark-dhcp.pcap"],
    selection: "packet_selection",
    facts: { kind: "packet", matching_packets: 1337, rows: [{ frame: 9 }] },
    changedFacts: {
      kind: "packet",
      matching_packets: 1338,
      rows: [{ frame: 9 }],
    },
    focusedCoverage: "up-to-input-packet-limit",
  },
  {
    artifact: "sigrok-uart-max3232e.sr",
    siblings: ["sigrok-i2c-nunchuk.sr"],
    selection: "signal_selection",
    facts: { kind: "signal", bytes: [72, 101] },
    changedFacts: { kind: "signal", bytes: [73, 101] },
    focusedCoverage: "selected annotation lines",
  },
] as const;

for (const {
  artifact,
  siblings,
  selection,
  facts,
  changedFacts,
  focusedCoverage,
} of recordingPlans) {
  const measurementPair = (name: string) => {
    const left = fixture("complete", name);
    left.summary[selection] = "baseline";
    left.answer.facts = facts;
    const right = structuredClone(left);
    right.summary[selection] = "focused";
    right.answer.delivery_observations[0]!.evidence_id = "ev_focused";
    right.answer.delivery_observations[0]!.coverage = focusedCoverage;
    return { left, right };
  };
  test.each([artifact, ...siblings])(
    "%s: preserves receipt scopes across plans with equivalent facts",
    async (name) => {
      const { left, right } = measurementPair(name);
      await assertEquivalent(left, right);
    },
  );
  test(`${artifact}: detects fact changes across plans and receipt changes within one plan`, async () => {
    const { left, right } = measurementPair(artifact);
    right.answer.facts = changedFacts;
    await assertDifference(left, right, "facts");

    right.answer.facts = facts;
    right.summary[selection] = "baseline";
    await assertDifference(left, right, "delivery_observations");
  });
}

const httpArtifact = "wireshark-http.cap";
test.each([httpArtifact, "wireshark-http_redirects.pcapng"])(
  "%s: repeated deliveries ignore only receipt IDs",
  async (artifact) => {
    for (const delivery of ["complete", "summary"] as const) {
      const left = fixture(delivery, artifact);
      const right = structuredClone(left);
      for (const receipt of right.answer.delivery_observations) {
        receipt.evidence_id += "_second";
        if (receipt.parent_evidence_id !== undefined)
          receipt.parent_evidence_id += "_second";
      }
      await assertEquivalent(left, right);
    }
  },
);

test("repeated HTTP deliveries reject stable observation changes", async () => {
  for (const delivery of ["complete", "summary"] as const) {
    const left = fixture(delivery, httpArtifact);
    const mutations: ((values: Observation[]) => void)[] = [
      (values) => values[0]!.limitations.push("new limitation"),
      (values) => {
        values[0]!.coverage = "partial";
      },
      (values) => {
        delete values[0]!.coverage;
      },
    ];
    if (delivery === "summary")
      mutations.push(
        (values) => {
          values[1]!.view!.offset = 1;
        },
        (values) => {
          const coverage = values[1]!.coverage;
          assert.ok(typeof coverage === "object" && coverage !== null);
          coverage.next_offset = null;
        },
        (values) => values[1]!.unknowns!.push("extra unknown"),
        (values) => values.reverse(),
      );
    for (const mutate of mutations) {
      const right = structuredClone(left);
      mutate(right.answer.delivery_observations);
      await assertDifference(left, right, "delivery_observations");
    }
  }
});

test("different HTTP delivery modes preserve their different receipt scopes", async () => {
  const left = fixture("complete", httpArtifact);
  const right = fixture("summary", httpArtifact);
  await assertEquivalent(left, right);
  right.answer.capture.coverage = "partial";
  await assertDifference(left, right, "capture");
});
