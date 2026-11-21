import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { PROPOSED_ADB_UI_ACTION_CONTRACT } from "../../dist/contracts/adb/adbUiToolContracts.js";
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
const client = new Client({ name: "rea-ui-node-validation", version: "1" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [UI_EXPERIMENT_MCP_PATH],
  env,
  stderr: "pipe",
});
transport.stderr?.resume();
const observations = [];
const failures = [];
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
    async ({ call, adb, fixture }) => {
      const scope = { serial: values.serial, package: fixture.package };
      const retain = async (kind, value) => {
        observations.push({ kind, value });
        await writeFile(
          join(output, `observation-${observations.length}.json`),
          JSON.stringify({ kind, value }, null, 2),
          { flag: "wx" },
        );
      };
      const find = async (id, selector = {}) => {
        const evidence = await call("find_adb_ui_elements", {
          ...scope,
          selector: { resource_id: `${scope.package}:id/${id}`, ...selector },
        });
        await retain("selection", evidence);
        assert.equal(evidence.normalized_result.total_matches, 1);
        return evidence.normalized_result;
      };
      const mutate = async (mutation) => {
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
        await retain("fixture-mutation", result);
        const record = result.stdout
          .split(/\r?\n/u)
          .find((line) => line.startsWith("Broadcast completed:"));
        const match =
          /^Broadcast completed: result=0, data="([A-Za-z0-9+/=]+)"$/u.exec(
            record ?? "",
          );
        assert(
          match,
          "Fixture mutation was not acknowledged with state readback",
        );
        const state = JSON.parse(
          Buffer.from(match[1], "base64").toString("utf8"),
        );
        assert.equal(state.mutation, mutation);
        if (mutation === "disable") assert.equal(state.enabled, false);
        if (mutation === "move") assert.equal(state.translation_x, 60);
        if (mutation === "detach") assert.equal(state.attached, false);
        if (mutation === "password") assert.equal(state.password, true);
        if (mutation === "text") assert.equal(state.input_text, "null");
        if (["checked", "selected", "focused"].includes(mutation))
          assert.equal(state[mutation], true);
        if (mutation === "checkable") assert.equal(state.checkable, false);
        await retain("fixture-state", state);
        return state;
      };
      const invoke = async (selection, action) => {
        const reply = await client.callTool(
          {
            name: "perform_adb_ui_action",
            arguments: {
              ...scope,
              snapshot_id: selection.snapshot.id,
              element_id: selection.matches[0].id,
              action,
            },
          },
          { signal, timeout: 60000 },
        );
        await retain("action", reply);
        const data =
          reply.structuredContent ??
          JSON.parse(reply.content.find((part) => part.type === "text").text);
        return { reply, data };
      };
      await retain("launch", await call("start_adb_app", scope));
      const ready = await call("wait_for_adb_ui", {
        ...scope,
        selector: { text: { value: "Sign in" } },
      });
      await retain("ready", ready);
      assert.equal(ready.normalized_result.satisfied, true);
      for (const mutation of [
        "disable",
        "move",
        "detach",
        "password",
        "text",
      ]) {
        await mutate("reset");
        const selected = await find(
          mutation === "password" || mutation === "text" ? "entry" : "sign_in",
        );
        if (mutation === "password" || mutation === "text") {
          assert.equal(selected.matches[0].password, false);
          assert.equal(selected.matches[0].text, null);
        }
        await mutate(mutation);
        const result = await invoke(
          selected,
          mutation === "password" || mutation === "text"
            ? { kind: "set_text", text: "fixture-transition-sentinel" }
            : { kind: "tap" },
        );
        if (
          result.reply.isError !== true ||
          result.data.error?.details?.diagnostics?.runner_failure !==
            "stale_element"
        )
          failures.push({
            mutation,
            reason: "Retained stale node was not refused",
            response: result.data,
          });
      }
      for (const state of ["checked", "selected", "focused", "checkable"]) {
        await mutate("reset");
        const selected = await find(
          "toggle",
          state === "checkable" ? {} : { [state]: false },
        );
        assert.equal(selected.matches[0][state], state === "checkable");
        await mutate(state);
        const result = await invoke(selected, { kind: "tap" });
        const after = await mutate("observe");
        if (
          result.reply.isError !== true ||
          result.data.error?.details?.diagnostics?.runner_failure !==
            "stale_element" ||
          after.toggle_clicks !== 0 ||
          after[state] !== (state !== "checkable")
        )
          failures.push({
            mutation: state,
            reason: "Changed control state was dispatched or not refused",
            response: result.data,
            after,
          });
      }
      // A fresh selection of the checked control still permits an explicit tap.
      await mutate("reset");
      await mutate("checked");
      const checked = await find("toggle", { checked: true });
      const toggled = await invoke(checked, { kind: "tap" });
      assert.notEqual(toggled.reply.isError, true);
      const toggleEvidence = PROPOSED_ADB_UI_ACTION_CONTRACT.outputSchema.parse(
        toggled.data,
      );
      assert.equal(toggleEvidence.normalized_result.action_completed, true);
      assert.equal(
        toggleEvidence.normalized_result.selected_element.checked,
        true,
      );
      const toggledState = await mutate("observe");
      assert.equal(toggledState.checked, false);
      assert.equal(toggledState.toggle_clicks, 1);

      // Initial selection freshness remains mandatory for a multi-click action.
      await mutate("reset");
      const staleDouble = await find("toggle", { checked: false });
      await mutate("checked");
      const staleDoubleResult = await invoke(staleDouble, {
        kind: "double_tap",
      });
      assert.equal(staleDoubleResult.reply.isError, true);
      assert.equal(
        staleDoubleResult.data.error.details.diagnostics.runner_failure,
        "stale_element",
      );
      assert.equal((await mutate("observe")).toggle_clicks, 0);

      for (const change of ["none", "relabel_on_click", "input_focus"]) {
        await mutate("reset");
        if (change === "relabel_on_click") await mutate(change);
        if (change === "input_focus") await mutate("focused");
        const selected = await find(
          change === "input_focus" ? "entry" : "toggle",
        );
        if (change === "input_focus")
          assert.equal(selected.matches[0].focused, false);
        const result = await invoke(selected, { kind: "double_tap" });
        assert.notEqual(result.reply.isError, true);
        const facts = PROPOSED_ADB_UI_ACTION_CONTRACT.outputSchema.parse(
          result.data,
        ).normalized_result;
        const after = await mutate("observe");
        const delivered =
          change === "input_focus"
            ? after.input_touch_ups === 2 && after.input_focused === true
            : after.toggle_clicks === 2 && after.checked === false;
        if (
          !facts.action_completed ||
          facts.action_error !== null ||
          !delivered
        )
          failures.push({
            mutation: `double_tap:${change}`,
            reason: "First-click state change prevented the second click",
            response: result.data,
            after,
          });
        assert.deepEqual(facts.selected_element, selected.matches[0]);
        if (change === "relabel_on_click" && delivered)
          assert.equal(after.toggle_text, "Toggled 2");
      }
      // Dismiss the input keyboard before selecting lower controls.
      await call("perform_adb_ui_action", {
        ...scope,
        snapshot_id: (await find("entry")).snapshot.id,
        action: { kind: "key_event", key_code: 4 },
      });
      for (const change of [
        "disable_on_click",
        "move_on_click",
        "detach_on_click",
        "leave_on_click",
      ]) {
        await mutate("reset");
        await mutate(change);
        const selected = await find("toggle");
        const result = await invoke(selected, { kind: "double_tap" });
        assert.notEqual(result.reply.isError, true);
        const facts = PROPOSED_ADB_UI_ACTION_CONTRACT.outputSchema.parse(
          result.data,
        ).normalized_result;
        const after = await mutate("observe");
        assert.equal(facts.dispatch_attempted, true);
        assert.equal(facts.action_completed, false);
        assert.notEqual(facts.action_error, null);
        assert.equal(facts.before.id, selected.snapshot.id);
        assert.deepEqual(facts.selected_element, selected.matches[0]);
        assert.equal(after.toggle_clicks, 1);
        assert.equal(after.checked, true);
        if (change === "disable_on_click") {
          assert.equal(after.toggle_enabled, false);
          assert.match(facts.action_error.reason, /enabled/u);
        }
        if (change === "move_on_click") {
          assert.equal(after.toggle_translation_x, 60);
          assert.match(facts.action_error.reason, /bounds/u);
        }
        if (change === "detach_on_click") {
          assert.equal(after.toggle_attached, false);
          assert.equal(facts.action_error.kind, "uiautomator_error");
        }
        if (change === "leave_on_click") {
          // Window departure can invalidate the retained node before the focus
          // guard observes it. Both refusals must retain the first-click facts.
          if (facts.action_error.kind === "uiautomator_error")
            assert.equal(facts.action_error.reason, "StaleObjectException");
          else assert.equal(facts.action_error.kind, "focus_changed");
          assert(
            facts.after,
            "App departure must retain its after-state capture",
          );
          assert.equal(facts.after.foreground_package, null);
          assert(
            facts.after.windows.every(
              (window) => !window.active && !window.focused,
            ),
            "No selected window should remain active or focused after app departure",
          );
          await retain("relaunch", await call("start_adb_app", scope));
        }
      }
      await mutate("reset");
      await mutate("password");
      const password = await find("entry");
      assert.equal(password.matches[0].password, true);
      const sentinel = "fixture-password-sentinel";
      const passwordAction = await invoke(password, {
        kind: "set_text",
        text: sentinel,
      });
      assert.notEqual(passwordAction.reply.isError, true);
      const passwordEvidence =
        PROPOSED_ADB_UI_ACTION_CONTRACT.outputSchema.parse(passwordAction.data);
      assert.equal(passwordEvidence.normalized_result.action_completed, true);
      assert.equal(passwordEvidence.parameters.action.text, "[redacted]");
      assert.equal(
        JSON.stringify(passwordAction.reply).includes(sentinel),
        false,
      );
      await mutate("reset");
      const plain = await find("entry");
      const plainAction = await invoke(plain, {
        kind: "set_text",
        text: "ordinary caller text",
      });
      assert.notEqual(plainAction.reply.isError, true);
      const plainEvidence = PROPOSED_ADB_UI_ACTION_CONTRACT.outputSchema.parse(
        plainAction.data,
      );
      assert.equal(
        plainEvidence.parameters.action.text,
        "ordinary caller text",
      );
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
  "Stale node validation failed; retained observations describe each case",
);
console.log(
  "Node validation: stale selections refused; double taps tolerate first-click state changes and retain partial outcomes on target loss; password text redacted and ordinary text preserved; fixture cleanup passed",
);
