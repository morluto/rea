import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { toolContract } from "../../dist/contracts/toolContracts.js";
import { withCommands } from "../command-scope.mjs";
import {
  REA_CLI_PATH,
  UI_EXPERIMENT_MCP_PATH,
  withFixture,
} from "./fixture.mjs";

const { values } = parseArgs({
  options: {
    serial: { type: "string" },
    apk: { type: "string" },
    aapt2: { type: "string", default: "aapt2" },
    output: { type: "string" },
  },
});
for (const name of ["serial", "apk", "output"])
  if (!values[name]) throw new Error(`Missing --${name}`);
const serial = values.serial;
const output = resolve(values.output);
await mkdir(output, { mode: 0o700 });
const env = Object.fromEntries(
  Object.entries(process.env).filter(([, value]) => typeof value === "string"),
);
const client = new Client({ name: "adb-ui-scope-probe", version: "1" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [UI_EXPERIMENT_MCP_PATH],
  env,
  stderr: "pipe",
});
transport.stderr?.resume();
const receipts = [];
const receipt = await withCommands((run, signal, settleCommands) =>
  withFixture(
    {
      apk: values.apk,
      aapt2: values.aapt2,
      output,
      serial,
      environment: env,
      client,
      transport,
      run,
      signal,
      settleCommands,
    },
    async ({ call, installation, fixture }) => {
      const packageName = fixture.package;
      const scope = { serial, package: packageName };
      const observed = async (name, input) => {
        const started = performance.now();
        const evidence = await call(name, input);
        receipts.push({ elapsed_ms: performance.now() - started, evidence });
        await writeFile(
          join(output, `observation-${receipts.length}.json`),
          JSON.stringify(evidence, null, 2),
          { flag: "wx" },
        );
        assert.equal(evidence.authority, "controlled-replay");
        return evidence;
      };
      const find = async (selector, options = {}) =>
        (
          await observed("find_adb_ui_elements", {
            ...scope,
            selector,
            ...options,
          })
        ).normalized_result;
      const byId = (name) => find({ resource_id: `${packageName}:id/${name}` });
      const act = async (selection, elementId, action) => {
        const evidence = await observed("perform_adb_ui_action", {
          ...scope,
          snapshot_id: selection.snapshot.id,
          ...(elementId === undefined ? {} : { element_id: elementId }),
          action,
        });
        assert.equal(
          evidence.normalized_result.action_completed,
          true,
          JSON.stringify(evidence),
        );
        return evidence;
      };
      const status = async (text) => {
        const evidence = await observed("wait_for_adb_ui", {
          ...scope,
          selector: { text: { value: text, match: "exact" } },
          condition: "present",
        });
        assert.equal(
          evidence.normalized_result.satisfied,
          true,
          JSON.stringify(evidence),
        );
      };
      const refused = async (input, kind) => {
        const reply = await client.callTool(
          { name: "perform_adb_ui_action", arguments: input },
          { signal, timeout: 60000 },
        );
        assert.equal(reply.isError, true);
        assert.match(JSON.stringify(reply), new RegExp(kind, "u"));
        await writeFile(
          join(output, `refusal-${kind}.json`),
          JSON.stringify(reply, null, 2),
          { flag: "wx" },
        );
      };
      await call("start_adb_app", { serial, package: packageName });
      await status("Sign in");
      const cliUi = await run(process.execPath, [
        REA_CLI_PATH,
        "inspect-adb-ui",
        JSON.stringify(scope),
        "--json",
      ]);
      const cliEvidence = toolContract("inspect_adb_ui").outputSchema.parse(
        JSON.parse(cliUi.stdout),
      );
      const retained = await find(
        {},
        { snapshot_id: cliEvidence.normalized_result.snapshot.id, limit: 500 },
      );
      assert.equal(retained.freshness, "retained_snapshot");
      assert.deepEqual(
        retained.matches,
        cliEvidence.normalized_result.snapshot.nodes,
      );
      const signIn = await find({
        text: { value: "Sign in", match: "exact" },
        clickable: true,
      });
      assert.equal(signIn.total_matches, 1);
      await act(signIn, signIn.matches[0].id, { kind: "tap" });
      await status("Tapped 1");

      const duplicates = await find(
        { text: { value: "Duplicate", match: "exact" } },
        { limit: 1 },
      );
      assert.equal(duplicates.total_matches, 2);
      const second = await find(
        { text: { value: "Duplicate", match: "exact" } },
        {
          snapshot_id: duplicates.snapshot.id,
          offset: duplicates.next_offset,
          limit: 1,
        },
      );
      assert.notEqual(second.matches[0].id, duplicates.matches[0].id);
      await act(second, second.matches[0].id, { kind: "tap" });
      await status("Duplicate 1");

      const disabled = await byId("disabled");
      await refused(
        {
          ...scope,
          snapshot_id: disabled.snapshot.id,
          element_id: disabled.matches[0].id,
          action: { kind: "tap" },
        },
        "unusable_element",
      );
      const stale = await byId("entry");
      await byId("status");
      await refused(
        {
          ...scope,
          snapshot_id: stale.snapshot.id,
          element_id: stale.matches[0].id,
          action: { kind: "tap" },
        },
        "stale_snapshot",
      );

      let entry = await byId("entry");
      const unicode = "REA Grüße 世界 🚀";
      const text = await act(entry, entry.matches[0].id, {
        kind: "set_text",
        text: unicode,
      });
      assert.equal(text.normalized_result.text_verified, true);
      assert.equal((await find({ text: { value: unicode } })).total_matches, 1);
      entry = await byId("entry");
      const secret = "rea-explicit-sensitive-value";
      const sensitive = await act(entry, entry.matches[0].id, {
        kind: "set_text",
        text: secret,
        sensitive: true,
      });
      assert.equal(sensitive.parameters.action.text, "[redacted]");
      assert.equal(JSON.stringify(sensitive).includes(secret), false);
      const hidden = await byId("entry");
      assert.equal(hidden.matches[0].text_redacted, true);
      assert.equal(hidden.matches[0].text, null);
      const hiddenAbsent = await observed("wait_for_adb_ui", {
        ...scope,
        selector: { text: { value: "unobserved text" } },
        condition: "absent",
        timeout_ms: 200,
      });
      assert.equal(hiddenAbsent.normalized_result.coverage, "partial");
      assert.equal(hiddenAbsent.normalized_result.satisfied, false);
      const clear = await byId("entry");
      await act(clear, clear.matches[0].id, { kind: "set_text", text: "" });

      const parent = await find({ text: { value: "Continue" } });
      assert.equal(parent.total_matches, 1);
      assert(parent.matches[0].click_target_id);
      await act(parent, parent.matches[0].click_target_id, { kind: "tap" });
      await status("Continued");
      let button = await byId("sign_in");
      await act(button, button.matches[0].id, { kind: "long_press" });
      await status("Long pressed");
      button = await byId("sign_in");
      await act(button, button.matches[0].id, { kind: "double_tap" });
      await status("Tapped 3");

      const snapshot = (await observed("inspect_adb_ui", scope))
        .normalized_result.snapshot;
      const source = snapshot.nodes.find(
        (node) => node.resource_id === `${packageName}:id/drag_source`,
      );
      const destination = snapshot.nodes.find(
        (node) => node.resource_id === `${packageName}:id/drag_destination`,
      );
      await act({ snapshot }, source.id, {
        kind: "drag",
        destination_id: destination.id,
      });
      await status("Dropped");
      const initialScroll = (await observed("inspect_adb_ui", scope))
        .normalized_result.snapshot;
      const scroll = initialScroll.nodes.find(
        (node) => node.resource_id === `${packageName}:id/scroll`,
      );
      const scrolled = await act({ snapshot: initialScroll }, scroll.id, {
        kind: "scroll",
        direction: "down",
        percent: 0.75,
      });
      const rows = (nodes) =>
        nodes
          .filter((node) => node.visible && /^Row \d+$/u.test(node.text ?? ""))
          .map((node) => node.text);
      assert.notDeepEqual(
        rows(initialScroll.nodes),
        rows(scrolled.normalized_result.after.nodes),
      );
      const swiping = await byId("scroll");
      await act(swiping, swiping.matches[0].id, {
        kind: "swipe",
        direction: "up",
        percent: 0.5,
      });
      const key = await find({});
      await act(key, undefined, { kind: "key_event", key_code: 61 });
      const absent = await observed("wait_for_adb_ui", {
        ...scope,
        selector: { resource_id: `${packageName}:id/absent` },
        condition: "absent",
      });
      assert.equal(absent.normalized_result.satisfied, true);
      const timeout = await observed("wait_for_adb_ui", {
        ...scope,
        selector: { resource_id: `${packageName}:id/absent` },
        timeout_ms: 200,
      });
      assert.equal(timeout.normalized_result.timed_out, true);
      const limited = await observed("wait_for_adb_ui", {
        ...scope,
        selector: { resource_id: `${packageName}:id/absent` },
        condition: "absent",
        max_nodes: 1,
        timeout_ms: 200,
      });
      assert.equal(limited.normalized_result.snapshot.coverage, "partial");
      assert.equal(limited.normalized_result.satisfied, false);
      const cancellation = new AbortController();
      const waiting = client.callTool(
        {
          name: "wait_for_adb_ui",
          arguments: {
            ...scope,
            selector: { resource_id: `${packageName}:id/absent` },
            timeout_ms: 30000,
          },
        },
        { signal: cancellation.signal, timeout: 45000 },
      );
      const rejected = assert.rejects(waiting);
      const timer = setTimeout(() => cancellation.abort(), 300);
      try {
        await rejected;
      } finally {
        clearTimeout(timer);
      }
      await byId("status"); // Proves the prior request settled before later work.
      const screen = await call("capture_adb_screen", {
        serial,
        output_directory: join(output, "screen"),
      });
      return {
        scope:
          "public UI observation CLI/MCP and unshipped action verification",
        serial,
        package: packageName,
        fixture,
        installation,
        cli_mcp_snapshot_parity: true,
        tap_observed: true,
        text_observed: true,
        scroll_observed: true,
        all_eight_primitives_completed: true,
        duplicates_preserved: true,
        disabled_and_stale_refused: true,
        sensitive_text_redacted: true,
        cancellation_settled: true,
        screenshot_evidence: screen,
        tokens: "unmeasured",
        process_family_peak: "unmeasured",
        receipts,
      };
    },
  ),
);
await writeFile(join(output, "receipt.json"), JSON.stringify(receipt, null, 2));
console.log(
  "UI Automator: text/button discovery, eight primitives, Unicode, redaction, stale/disabled refusals, CLI/MCP parity, cancellation and cleanup passed",
);
