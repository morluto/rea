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

const { values } = parseArgs({
  options: {
    serial: { type: "string" },
    apk: { type: "string" },
    "mirror-apk": { type: "string" },
    aapt2: { type: "string", default: "aapt2" },
    output: { type: "string" },
    capacity: { type: "boolean", default: false },
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
await withCommands(async (run, signal, settleCommands) => {
  const install = async (apk, expectedPackage, directory, work) => {
    const result = join(output, directory);
    await mkdir(result, { mode: 0o700 });
    const client = new Client({
      name: "rea-cross-app-redaction",
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
        const protectedValues = [];
        for (const [mode, text] of [
          ["explicit", "fixture-cross-app-sensitive"],
          ["password", "fixture-cross-app-password"],
          ["plain", "ordinary cross-app text"],
        ]) {
          await retain(
            "start-primary",
            await primary.call("start_adb_app", scope(primary)),
          );
          await primary.adb([
            "shell",
            "am",
            "broadcast",
            "--receiver-foreground",
            "--user",
            "0",
            "-a",
            `${FIXTURE_PACKAGE}.MUTATE`,
            "-p",
            FIXTURE_PACKAGE,
            "--es",
            "mutation",
            "reset",
          ]);
          if (mode === "password")
            await primary.adb([
              "shell",
              "am",
              "broadcast",
              "--receiver-foreground",
              "--user",
              "0",
              "-a",
              `${FIXTURE_PACKAGE}.MUTATE`,
              "-p",
              FIXTURE_PACKAGE,
              "--es",
              "mutation",
              "password",
            ]);
          const selected = await find(primary, "entry");
          assert.equal(selected.matches[0].password, mode === "password");
          const entered = await act(primary, selected, {
            kind: "set_text",
            text,
            sensitive: mode === "explicit",
          });
          assert.equal(
            entered.parameters.action.text,
            mode === "plain" ? text : "[redacted]",
          );
          if (mode !== "plain") protectedValues.push(text);
          await act(primary, await find(primary, "mirror_input"), {
            kind: "tap",
          });
          const copied = await find(mirror, "entry");
          const node = copied.matches[0];
          assert.equal(node.package_name, MIRROR_FIXTURE_PACKAGE);
          assert.equal(node.password, false);
          const inspection = await inspect(mirror);
          if (mode === "plain") {
            assert.equal(node.text, text);
            assert.equal(node.content_description, `Mirrored: ${text}`);
            assert.equal(node.text_redacted, false);
            assert.equal(node.content_description_redacted, false);
          } else {
            if (
              node.text !== null ||
              node.content_description !== null ||
              !node.text_redacted ||
              !node.content_description_redacted ||
              JSON.stringify(inspection).includes(text)
            )
              failures.push({
                mode,
                reason: "Sensitive value escaped its source package",
                observed: node,
              });
            const absent = await mirror.call("wait_for_adb_ui", {
              ...scope(mirror),
              selector: { text: { value: "unrelated absence probe" } },
              condition: "absent",
              timeout_ms: 200,
            });
            await retain("masked-query-coverage", absent);
            if (
              absent.normalized_result.coverage !== "partial" ||
              absent.normalized_result.satisfied !== false
            )
              failures.push({
                mode,
                reason: "A masked peer field was treated as fully searchable",
                observed: absent,
              });
          }
        }
        if (values.capacity) {
          // This optional saturation check requires a fresh operator-started runner.
          await mirror.call("start_adb_app", scope(mirror));
          for (const text of protectedValues)
            await act(mirror, await find(mirror, "entry"), {
              kind: "set_text",
              text,
              sensitive: true,
            });
          let remaining =
            65536 -
            protectedValues.reduce((total, value) => total + value.length, 0);
          let index = 0;
          while (remaining > 0) {
            const size = Math.min(8192, remaining);
            const text = `${index++}:`.padEnd(size, "x");
            await act(mirror, await find(mirror, "entry"), {
              kind: "set_text",
              text,
              sensitive: true,
            });
            remaining -= text.length;
          }
          const selected = await find(mirror, "entry");
          const reply = await mirror.client.callTool(
            {
              name: "perform_adb_ui_action",
              arguments: {
                ...scope(mirror),
                snapshot_id: selected.snapshot.id,
                element_id: selected.matches[0].id,
                action: {
                  kind: "set_text",
                  text: "budget-overflow",
                  sensitive: true,
                },
              },
            },
            { signal, timeout: 60000 },
          );
          await retain("capacity-refusal", reply);
          const data =
            reply.structuredContent ??
            JSON.parse(reply.content.find((part) => part.type === "text").text);
          assert.equal(reply.isError, true);
          assert.equal(data.error.code, "resource_constraint");
          // Existing values remain admitted and masked even after the refusal.
          await act(mirror, await find(mirror, "entry"), {
            kind: "set_text",
            text: protectedValues[0],
            sensitive: true,
          });
          assert.equal(
            JSON.stringify(await inspect(mirror)).includes(protectedValues[0]),
            false,
          );
        }
      },
    ),
  );
});
await writeFile(
  join(output, "receipt.json"),
  JSON.stringify(
    { failures, observations, capacity_checked: values.capacity },
    null,
    2,
  ),
  { flag: "wx" },
);
assert.deepEqual(
  failures,
  [],
  "Cross-app sensitive text escaped; retained observations describe each case",
);
console.log(
  "Cross-app redaction: explicit/password values masked across packages and CLI/MCP sessions; ordinary text preserved; both fixtures removed",
);
