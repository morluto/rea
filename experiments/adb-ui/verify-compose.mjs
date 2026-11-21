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
const env = Object.fromEntries(
  Object.entries(process.env).filter(([, value]) => typeof value === "string"),
);
const client = new Client({
  name: "rea-compose-ui-verification",
  version: "1",
});
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [UI_EXPERIMENT_MCP_PATH],
  env,
  stderr: "pipe",
});
transport.stderr?.resume();
const observations = [];
let keyboardDismissed = false;
await withCommands((run, signal, settleCommands) =>
  withFixture(
    {
      apk: values.apk,
      aapt2: values.aapt2,
      output,
      serial: values.serial,
      environment: env,
      client,
      transport,
      run,
      signal,
      settleCommands,
    },
    async ({ call, fixture }) => {
      const scope = { serial: values.serial, package: fixture.package };
      const observe = async (name, input) => {
        const evidence = await call(name, input);
        observations.push(evidence);
        await writeFile(
          join(output, `observation-${observations.length}.json`),
          JSON.stringify(evidence, null, 2),
          { flag: "wx" },
        );
        return evidence.normalized_result;
      };
      const find = (selector) =>
        observe("find_adb_ui_elements", { ...scope, selector });
      const wait = async (value) => {
        const result = await observe("wait_for_adb_ui", {
          ...scope,
          selector: { text: { value } },
        });
        assert.equal(result.satisfied, true, JSON.stringify(result));
      };
      const action = async (selected, node, kind) => {
        const result = await observe("perform_adb_ui_action", {
          ...scope,
          snapshot_id: selected.snapshot.id,
          ...(node === undefined ? {} : { element_id: node }),
          action: kind,
        });
        assert.equal(result.action_completed, true, JSON.stringify(result));
        return result;
      };
      await call("start_adb_app", scope);
      await wait("Compose ready");
      const signIn = await find({ text: { value: "Compose sign in" } });
      assert.equal(signIn.total_matches, 1);
      assert(signIn.matches[0].click_target_id);
      await action(signIn, signIn.matches[0].click_target_id, { kind: "tap" });
      await wait("Compose tapped");
      const duplicates = await find({ text: { value: "Duplicate" } });
      assert.equal(duplicates.total_matches, 2);
      const second = duplicates.matches.find((node) =>
        duplicates.related_nodes.some(
          (parent) =>
            parent.id === node.click_target_id &&
            parent.resource_id?.endsWith("duplicate_two"),
        ),
      );
      assert(second);
      await action(duplicates, second.click_target_id, { kind: "tap" });
      await wait("Compose duplicate 2");
      let entry = await find({
        resource_id: `${fixture.package}:id/entry`,
        editable: true,
      });
      assert.equal(entry.total_matches, 1);
      await action(entry, entry.matches[0].id, { kind: "tap" });
      entry = await find({
        resource_id: `${fixture.package}:id/entry`,
        editable: true,
      });
      await action(entry, entry.matches[0].id, {
        kind: "set_text",
        text: "Compose 世界 🚀",
      });
      await wait("Compose 世界 🚀");
      await call("capture_adb_screen", {
        serial: values.serial,
        output_directory: join(output, "after-text"),
      });
      const inputMethod = await observe("read_adb_setting", {
        serial: values.serial,
        namespace: "secure",
        key: "default_input_method",
      });
      // The setting is a flattened Android component. Keep its source Evidence
      // and derive the package only from that explicit producer value.
      const component = /^([^/]+)\/[^/]+$/u.exec(inputMethod.value ?? "");
      assert(component, "No configured input-method component was observed");
      const keyboardScope = { serial: values.serial, package: component[1] };
      const keyboard = await observe("wait_for_adb_ui", {
        ...keyboardScope,
        selector: { visible: true },
        condition: "present",
        timeout_ms: 2000,
      });
      if (keyboard.satisfied) {
        const app = await find({});
        await action(app, undefined, { kind: "key_event", key_code: 4 });
        const dismissed = await observe("wait_for_adb_ui", {
          ...keyboardScope,
          selector: { visible: true },
          condition: "absent",
        });
        assert.equal(dismissed.satisfied, true);
        keyboardDismissed = true;
      }
      const disabled = await find({
        resource_id: `${fixture.package}:id/disabled`,
      });
      assert.equal(disabled.matches[0].enabled, false);
      const initial = (await observe("inspect_adb_ui", scope)).snapshot;
      const scroll = initial.nodes.find(
        (node) => node.resource_id === `${fixture.package}:id/scroll`,
      );
      const rows = (nodes) =>
        nodes
          .filter(
            (node) => node.visible && /^Compose row /u.test(node.text ?? ""),
          )
          .map((node) => node.text);
      const firstVisible = rows(initial.nodes)[0];
      assert(firstVisible);
      await action({ snapshot: initial }, scroll.id, {
        kind: "scroll",
        direction: "down",
        percent: 0.75,
      });
      const moved = await observe("wait_for_adb_ui", {
        ...scope,
        selector: { text: { value: firstVisible }, visible: true },
        condition: "absent",
      });
      assert.equal(moved.satisfied, true);
      assert.equal(moved.snapshot.foreground_package, fixture.package);
      const after = (await observe("inspect_adb_ui", scope)).snapshot;
      await call("capture_adb_screen", {
        serial: values.serial,
        output_directory: join(output, "after-scroll"),
      });
      assert.equal(after.foreground_package, fixture.package);
      assert.equal(rows(after.nodes).includes(firstVisible), false);
      assert.notDeepEqual(rows(initial.nodes), rows(after.nodes));
    },
  ),
);
await writeFile(
  join(output, "receipt.json"),
  JSON.stringify(
    {
      framework: "Compose",
      discovery: true,
      duplicates: true,
      tap_observed: true,
      unicode_observed: true,
      scroll_observed: true,
      keyboard_dismissal_observed: keyboardDismissed,
      observations,
    },
    null,
    2,
  ),
);
console.log(
  "Compose UI: text/button discovery, duplicate labels, Unicode entry, disabled state, scrolling and fixture cleanup passed",
);
