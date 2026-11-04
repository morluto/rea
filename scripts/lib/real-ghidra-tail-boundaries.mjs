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
    const leafDossier = await evidence("analyze_function", {
      procedure: leaf,
      detail: "complete",
    });
    const incomingJump = leafDossier.normalized_result.incoming_references.find(
      ({ source_procedure, kind }) =>
        source_procedure?.address === entry("rea_tail_direct") && kind.jump === true,
    );
    if (process.platform === "darwin" && process.arch === "arm64") {
      assert.ok(incomingJump, "Fixture must expose the incoming tail jump");
    }
    if (incomingJump && !leafDossier.normalized_result.callers.some(
      ({ address }) => address === entry("rea_tail_direct"),
    )) {
      assert.equal(leafDossier.relationship_coverage.status, "partial");
      assert.ok(leafDossier.relationship_coverage.limited_directions.includes("callers"));
      assert.match(leafDossier.relationship_coverage.limitations.join("\n"), /incoming jump\(s\)/u);
      const callers = await evidence("procedure_callers", { procedure: leaf });
      assert.equal(callers.relationship_coverage.status, "partial");
      assert.ok(callers.relationship_coverage.limited_directions.includes("callers"));
      assert.match(callers.relationship_coverage.limitations.join("\n"), /incoming jump\(s\)/u);
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
    // A conditional branch can transfer out of a function without being a
    // Ghidra call reference. This fixed assembly is currently qualified only
    // for Darwin ARM64; the C fixture above remains the cross-platform check.
    if (process.platform === "darwin" && process.arch === "arm64") {
      const conditionalSource = fileURLToPath(
        new URL(
          "../../tests/conformance/ghidra/tail-conditional-arm64-darwin.S",
          import.meta.url,
        ),
      );
      const conditionalBinary = join(directory, "conditional-tail");
      const switchSource = fileURLToPath(
        new URL(
          "../../tests/conformance/ghidra/relative-switch.S",
          import.meta.url,
        ),
      );
      await promisify(execFile)(
        process.env.REA_CC ?? "cc",
        [conditionalSource, switchSource, "-o", conditionalBinary],
        { env, timeout: 30000 },
      );
      await call("open_binary", {
        path: conditionalBinary,
        provider_id: "ghidra",
      });
      const conditionalNames = await call("list_names");
      const main = conditionalNames.find(({ value }) => value === "_main");
      const conditionalLeaf = conditionalNames.find(
        ({ value }) => value === "_rea_conditional_tail_leaf",
      );
      assert.ok(main, "Missing conditional-tail entry");
      assert.ok(conditionalLeaf, "Missing conditional-tail target");
      const conditional = await evidence("analyze_function", {
        procedure: main.address,
        detail: "complete",
      });
      assert.ok(
        conditional.normalized_result.assembly.some((line) =>
          /\bb\.eq\b/u.test(line),
        ),
        "Conditional fixture must contain the decoded branch",
      );
      assert.ok(
        conditional.normalized_result.procedure.body.ranges.every(
          ({ start, end }) =>
            BigInt(conditionalLeaf.address) < BigInt(start) ||
            BigInt(conditionalLeaf.address) > BigInt(end),
        ),
        "Conditional destination must be outside the entry function body",
      );
      if (
        !conditional.normalized_result.callees.some(
          ({ address }) => address === conditionalLeaf.address,
        )
      ) {
        assert.equal(conditional.relationship_coverage.status, "partial");
        assert.ok(
          conditional.relationship_coverage.limited_directions.includes(
            "callees",
          ),
        );
        assert.match(
          conditional.relationship_coverage.limitations.join("\n"),
          /conditional jump\(s\) outside this function/u,
        );
      }
      for (const symbol of ["_rea_computed_partial", "_rea_computed_known"]) {
        const selected = conditionalNames.find(({ value }) => value === symbol);
        assert.ok(selected, `Missing ${symbol}`);
        const computed = await evidence("analyze_function", {
          procedure: selected.address,
          detail: "complete",
        });
        assert.ok(
          computed.normalized_result.outgoing_references.some(
            ({ kind }) => kind.computed === true && kind.jump === true,
          ),
          `${symbol} must retain an observed computed jump destination`,
        );
        assert.equal(computed.relationship_coverage.status, "partial");
        assert.ok(
          computed.relationship_coverage.limited_directions.includes("callees"),
        );
        assert.match(
          computed.relationship_coverage.limitations.join("\n"),
          /computed jump\(s\) with known destinations/u,
        );
      }
      const switchEntry = conditionalNames.find(
        ({ value }) => value === "_rea_relative_switch",
      );
      assert.ok(switchEntry, "Missing internal jump-table control");
      const switchControl = await evidence("analyze_function", {
        procedure: switchEntry.address,
        detail: "complete",
      });
      assert.ok(
        switchControl.normalized_result.assembly.some((line) =>
          /\bbr\s/u.test(line),
        ),
        "Jump-table control must contain a computed jump",
      );
      assert.equal(switchControl.relationship_coverage.status, "partial");
      assert.ok(
        switchControl.relationship_coverage.limited_directions.includes(
          "callees",
        ),
      );
      await call("close_binary");
    }
    await call("open_binary", { path: target.path, provider_id: "ghidra" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
