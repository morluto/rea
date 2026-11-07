import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { withCommands } from "../command-scope.mjs";
import { UI_EXPERIMENT_MCP_PATH, withFixture } from "./fixture.mjs";

const { values } = parseArgs({
  options: {
    serial: { type: "string" },
    apk: { type: "string" },
    aapt2: { type: "string", default: "aapt2" },
    output: { type: "string" },
  },
});
for (const key of ["serial", "apk", "output"])
  if (!values[key]) throw new Error(`Missing --${key}`);
const output = resolve(values.output);
await mkdir(output, { mode: 0o700 });
const environment = Object.fromEntries(
  Object.entries(process.env).filter(([, value]) => typeof value === "string"),
);
const client = new Client({ name: "rea-ui-dispatch-guard", version: "1" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [UI_EXPERIMENT_MCP_PATH],
  env: environment,
  stderr: "pipe",
});
transport.stderr?.resume();
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
await withCommands((run, signal, settleCommands) =>
  withFixture(
    {
      apk: values.apk,
      aapt2: values.aapt2,
      output,
      serial: values.serial,
      environment,
      client,
      transport,
      run,
      signal,
      settleCommands,
    },
    async ({ call, adb, fixture }) => {
      const scope = { serial: values.serial, package: fixture.package };
      await retain("launch", await call("start_adb_app", scope));
      const select = async (id) => {
        const evidence = await call("wait_for_adb_ui", {
          ...scope,
          selector: { resource_id: `${scope.package}:id/${id}` },
        });
        await retain("selection", evidence);
        assert.equal(
          evidence.normalized_result.runner.version,
          "dispatch-guard-probe",
          "This verifier requires the explicitly built dispatch probe helper",
        );
        assert.equal(evidence.normalized_result.satisfied, true);
        assert.equal(evidence.normalized_result.total_matches, 1);
        return evidence.normalized_result;
      };
      const state = async (mutation) => {
        const result = await adb([
          "shell",
          "am",
          "broadcast",
          "--receiver-foreground",
          "--user",
          "0",
          "-a",
          `${scope.package}.MUTATE`,
          "-p",
          scope.package,
          "--es",
          "mutation",
          mutation,
        ]);
        const record = result.stdout
          .split(/\r?\n/u)
          .find((line) => line.startsWith("Broadcast completed:"));
        const match =
          /^Broadcast completed: result=0, data="([A-Za-z0-9+/=]+)"$/u.exec(
            record ?? "",
          );
        assert(match, "Fixture state readback was not acknowledged");
        const observed = JSON.parse(
          Buffer.from(match[1], "base64").toString("utf8"),
        );
        assert.equal(observed.mutation, mutation);
        await retain("fixture-state", observed);
        return observed;
      };
      for (const kind of ["key_event", "drag"]) {
        const modes = [
          ["cancelled", 11001],
          ["timeout", 11002],
          ["control", 10000],
          ...(kind === "key_event" ? [["unfocused", 11003]] : []),
        ];
        for (const [mode, timeout] of modes) {
          await state("reset");
          const selected = await select(
            kind === "drag" ? "drag_source" : "entry",
          );
          const input = {
            ...scope,
            snapshot_id: selected.snapshot.id,
            timeout_ms: timeout,
          };
          if (kind === "key_event") input.action = { kind, key_code: 131 };
          else {
            const destination = await call("find_adb_ui_elements", {
              ...scope,
              snapshot_id: selected.snapshot.id,
              selector: { resource_id: `${scope.package}:id/drag_destination` },
            });
            await retain("destination", destination);
            assert.equal(destination.normalized_result.total_matches, 1);
            input.element_id = selected.matches[0].id;
            input.action = {
              kind,
              destination_id: destination.normalized_result.matches[0].id,
            };
          }
          if (mode === "unfocused") {
            const window = selected.snapshot.windows.find(
              (window) => window.id === selected.matches[0].window_id,
            );
            assert.equal(window?.active, true);
            assert.equal(window.focused, true);
            await retain("focus-probe", {
              captured_window: window,
              masked_input_focus: false,
              real_active_state_unchanged: true,
              limitation:
                "Only the producer's input-focus read is masked; this does not reproduce native touch-exploration routing.",
            });
          }
          const reply = await client.callTool(
            { name: "perform_adb_ui_action", arguments: input },
            { signal, timeout: 60000 },
          );
          const data =
            reply.structuredContent ??
            JSON.parse(reply.content.find((part) => part.type === "text").text);
          await retain("action", { kind, mode, reply });
          const observed = await state("observe");
          const count =
            kind === "key_event" ? observed.test_keys : observed.drag_starts;
          if (mode === "control") {
            assert.notEqual(reply.isError, true);
            assert.equal(data.normalized_result.dispatch_attempted, true);
            assert.equal(data.normalized_result.action_completed, true);
            assert.equal(count, 1);
            if (kind === "drag") assert.equal(observed.drops, 1);
          } else if (
            reply.isError !== true ||
            (mode === "unfocused"
              ? data.error?.details?.reason !== "focus_changed"
              : data.error?.code !==
                (mode === "timeout" ? "provider_timeout" : "cancelled")) ||
            count !== 0 ||
            observed.drops !== 0
          ) {
            failures.push({
              kind,
              mode,
              count,
              drops: observed.drops,
              response: data,
            });
          }
        }
      }
    },
  ),
);
await writeFile(
  join(output, "receipt.json"),
  JSON.stringify({ failures, observations }, null, 2),
  { flag: "wx" },
);
assert.deepEqual(
  failures,
  [],
  "Dispatch-guard verification failed; retained observations show the refusal or input mismatch",
);
console.log(
  "Dispatch guards: cancelled/expired inputs and an input-unfocused key window sent no input; focused controls and fixture cleanup passed",
);
