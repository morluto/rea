import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

/** Observe compiled tail transfers without asserting that jumps are calls. */
export async function verifyGhidraTailBoundaries({
  call,
  evidence,
  target,
  env,
}) {
  const directory = await mkdtemp(join(tmpdir(), "rea-ghidra-tail-"));
  const binary = join(directory, "tail-flow");
  const source = fileURLToPath(
    new URL("../../tests/conformance/ghidra/tail-flow.c", import.meta.url),
  );
  try {
    await promisify(execFile)(
      process.env.REA_CC ?? "cc",
      ["-O1", source, "-o", binary],
      {
        env,
        timeout: 30000,
      },
    );
    await call("close_binary");
    await call("open_binary", { path: binary, provider_id: "ghidra" });
    const names = await call("list_names");
    const entry = (suffix) => {
      const matches = names.filter(
        (item) => item.value === suffix || item.value === `_${suffix}`,
      );
      assert.equal(
        matches.length,
        1,
        `Expected one imported symbol for ${suffix}`,
      );
      return matches[0].address;
    };
    const direct = await evidence("analyze_function", {
      procedure: entry("rea_tail_direct"),
      detail: "complete",
    });
    const leaf = entry("rea_tail_leaf");
    if (
      !direct.normalized_result.callees.some(({ address }) => address === leaf)
    ) {
      assert.equal(direct.relationship_coverage.status, "partial");
      assert.ok(
        direct.relationship_coverage.limited_directions.includes("callees"),
      );
      assert.match(
        direct.relationship_coverage.limitations.join("\n"),
        /unconditional jump\(s\) outside this function/u,
      );
    }
    const indirect = await evidence("analyze_function", {
      procedure: entry("rea_tail_indirect"),
      detail: "complete",
    });
    assert.equal(indirect.relationship_coverage.status, "partial");
    assert.ok(
      indirect.relationship_coverage.limited_directions.includes("callees"),
    );
    assert.match(
      indirect.relationship_coverage.limitations.join("\n"),
      /targetless computed jump\(s\)/u,
    );
    assert.deepEqual(indirect.normalized_result.unresolved_calls, []);
    const outgoing = await evidence("procedure_references", {
      procedure: entry("rea_tail_indirect"),
      direction: "outgoing",
    });
    assert.match(
      outgoing.limitations.join("\n"),
      /targetless computed jump\(s\)/u,
    );
    const local = await evidence("analyze_function", {
      procedure: entry("rea_tail_internal"),
      detail: "complete",
    });
    assert.equal(local.relationship_coverage.status, "complete");
    await call("close_binary");
    await call("open_binary", { path: target.path, provider_id: "ghidra" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
