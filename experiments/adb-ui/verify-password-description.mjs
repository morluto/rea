import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

import { toolContract } from "../../dist/contracts/toolContracts.js";
import { withCommands } from "../command-scope.mjs";
import {
  FIXTURE_PACKAGE,
  MIRROR_FIXTURE_PACKAGE,
  REA_CLI_PATH,
  UI_EXPERIMENT_MCP_PATH,
  withFixture,
} from "./fixture.mjs";

/**
 * Verify that a password-marked node keeps both of its textual fields out of
 * the observation, even when the application stores the entered value in the
 * content description and REA never typed it.
 */
const { values } = parseArgs({
  options: {
    serial: { type: "string" },
    apk: { type: "string" },
    "mirror-apk": { type: "string" },
    aapt2: { type: "string", default: "aapt2" },
    output: { type: "string" },
  },
});
for (const key of ["serial", "apk", "mirror-apk", "output"])
  if (!values[key]) throw new Error(`Missing --${key}`);
const output = resolve(values.output);
await mkdir(output, { mode: 0o700 });
const environment = Object.fromEntries(
  Object.entries(process.env).filter(([, value]) => typeof value === "string"),
);
const observations = [];
const failures = [];
const retain = async (kind, value) => {
  observations.push({ kind, value });
  await writeFile(
    join(output, `observation-${observations.length}.json`),
    JSON.stringify({ kind, value }, null, 2),
    { flag: "wx" },
  );
};
const secret = "device-password-description-value";
await withCommands(async (run, signal, settleCommands) => {
  const install = async (apk, expectedPackage, directory, work) => {
    const result = join(output, directory);
    await mkdir(result, { mode: 0o700 });
    const client = new Client({
      name: "rea-password-description",
      version: "1",
    });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [UI_EXPERIMENT_MCP_PATH],
      env: environment,
      stderr: "pipe",
    });
    transport.stderr?.resume();
    return withFixture(
      {
        apk,
        expectedPackage,
        aapt2: values.aapt2,
        output: result,
        serial: values.serial,
        environment,
        client,
        transport,
        run,
        signal,
        settleCommands,
      },
      (fixture) => work({ ...fixture, client }),
    );
  };
  await install(values.apk, FIXTURE_PACKAGE, "primary", async (primary) =>
    install(
      values["mirror-apk"],
      MIRROR_FIXTURE_PACKAGE,
      "mirror",
      async (mirror) => {
        const scope = (fixture) => ({
          serial: values.serial,
          package: fixture.fixture.package,
        });
        const find = async (fixture, id) => {
          const evidence = await fixture.call("wait_for_adb_ui", {
            ...scope(fixture),
            selector: { resource_id: `${fixture.fixture.package}:id/${id}` },
          });
          await retain("selection", evidence);
          assert.equal(evidence.normalized_result.satisfied, true);
          assert.equal(evidence.normalized_result.total_matches, 1);
          return evidence.normalized_result;
        };
        const act = async (fixture, selected, action) => {
          const evidence = await fixture.call("perform_adb_ui_action", {
            ...scope(fixture),
            snapshot_id: selected.snapshot.id,
            element_id: selected.matches[0].id,
            action,
          });
          await retain("action", evidence);
          assert.equal(evidence.normalized_result.action_completed, true);
          return evidence;
        };
        const inspect = async (fixture) => {
          const result = await run(
            process.execPath,
            [
              REA_CLI_PATH,
              "inspect-adb-ui",
              JSON.stringify(scope(fixture)),
              "--json",
            ],
            { environment },
          );
          const evidence = toolContract("inspect_adb_ui").outputSchema.parse(
            JSON.parse(result.stdout),
          );
          await retain("independent-cli-inspection", evidence);
          return evidence;
        };
        const mutate = async (fixture, mutation) => {
          await fixture.adb([
            "shell",
            "am",
            "broadcast",
            "--receiver-foreground",
            "--user",
            "0",
            "-a",
            `${fixture.fixture.package}.MUTATE`,
            "-p",
            fixture.fixture.package,
            "--es",
            "mutation",
            mutation,
          ]);
        };

        // The primary types an ordinary value and copies it into the mirror
        // application, which keeps the value in its content description.
        await primary.call("start_adb_app", scope(primary));
        await act(primary, await find(primary, "entry"), {
          kind: "set_text",
          text: secret,
          sensitive: false,
        });
        await act(primary, await find(primary, "mirror_input"), {
          kind: "tap",
        });
        const copied = await find(mirror, "entry");
        assert.equal(
          copied.matches[0].content_description,
          `Mirrored: ${secret}`,
        );
        await retain("copied-node", copied.matches[0]);

        // The mirror field becomes a password field while it still holds the
        // value in its description.
        await mutate(mirror, "password");
        const selected = await find(mirror, "entry");
        const node = selected.matches[0];
        await retain("password-node", node);
        if (node.password !== true)
          failures.push({ reason: "The mirror field is not a password field" });
        if (
          node.text !== null ||
          node.content_description !== null ||
          node.text_redacted !== true ||
          node.content_description_redacted !== true
        )
          failures.push({
            reason: "A password node kept a textual field",
            observed: node,
          });
        const inspection = await inspect(mirror);
        if (JSON.stringify(inspection).includes(secret))
          failures.push({
            reason: "The password value escaped into the observation",
            observed: node,
          });
        // The redacted description cannot be searched, so the query coverage
        // cannot be complete.
        const probe = await mirror.call("wait_for_adb_ui", {
          ...scope(mirror),
          selector: {
            content_description: {
              value: `Mirrored: ${secret}`,
              match: "exact",
            },
          },
          condition: "absent",
          timeout_ms: 200,
        });
        await retain("redacted-description-coverage", probe);
        if (probe.normalized_result.coverage !== "partial")
          failures.push({
            reason: "A redacted description was treated as fully searchable",
            observed: probe,
          });
      },
    ),
  );
});
await writeFile(
  join(output, "receipt.json"),
  JSON.stringify({ failures, observations }, null, 2),
  { flag: "wx" },
);
assert.deepEqual(
  failures,
  [],
  "A password-marked node kept a textual field or the value escaped",
);
console.log(
  "Password description: both textual fields stay redacted, the value never reaches the observation, and the search reports partial coverage",
);
