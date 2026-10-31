import { chmod, readFile, writeFile, rename } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import { expect, onTestFinished, test, vi } from "vitest";
import { AdbProvider } from "../../../../src/adb/AdbProvider.js";
import * as adbConfiguration from "../../../../src/adb/AdbConfiguration.js";
import {
  AdbUiRunner,
  parseAdbUiReply,
} from "../../../../src/adb/AdbUiRunner.js";
import { spawnOwnedProviderProcess } from "../../../../src/process/ProviderProcess.js";
import { cleanupOwnedProcessGroup } from "../../../../src/process/ProcessOwnership.js";
import { adbUiInputSchemas } from "../../../../src/domain/adb/adbUiAnalysis.js";
import { AnalysisOutputError } from "../../../../src/domain/analysisErrorCore.js";
import { projectAnalysisError } from "../../../../src/domain/analysisErrorProjection.js";
import { parseEvidence } from "../../../../src/domain/evidence.js";
import { AdbDeviceAnalysisService } from "../../../../src/application/adb/AdbDeviceAnalysisService.js";
import { toolContract } from "../../../../src/contracts/toolContracts.js";
import { createApplicationMcpHarness } from "../../../fixtures/applicationMcpHarness.js";
import { registerAdbUiExperiment } from "../../../fixtures/adbUiExperiment.js";
import { parseMcpToolError } from "../../../fixtures/mcpToolError.js";
import { createDeferred } from "../../../fixtures/binarySession.js";
import {
  createTestWorkspace,
  removeTestWorkspace,
} from "../../../support/workspace/workspaceFixture.js";

const it = test.skipIf(process.platform === "win32");
const instance = "00000000-0000-4000-8000-000000000001";
const snapshotId = "00000000-0000-4000-8000-000000000002";
const otherSnapshotId = "00000000-0000-4000-8000-000000000003";
const scope = { serial: "emulator-5554", package: "com.example.app" };
const actionInput = {
  ...scope,
  snapshot_id: snapshotId,
  element_id: "0",
  action: { kind: "tap" },
} as const;
const runner = {
  package_name: "dev.rea.uiautomator",
  instance_id: instance,
  version: "0.2.0",
  ui_automator_version: "2.4.0",
  sdk_int: 36,
};
const bounds = { left: 0, top: 0, right: 100, bottom: 50 };
const node = {
  id: "0",
  parent_id: null,
  window_id: 1,
  package_name: scope.package,
  class_name: "android.widget.Button",
  resource_id: "com.example.app:id/go",
  text: "Hello 世界",
  content_description: null,
  bounds,
  visible_bounds: bounds,
  enabled: true,
  clickable: true,
  long_clickable: true,
  editable: false,
  scrollable: false,
  focused: false,
  selected: false,
  checked: false,
  checkable: false,
  password: false,
  text_redacted: false,
  content_description_redacted: false,
  visible: true,
  click_target_id: "0",
};
const header = {
  id: snapshotId,
  captured_at_ms: 1,
  package_name: scope.package,
  display_id: 0,
  window_id_filter: null,
  foreground_package: scope.package,
  windows: [{ id: 1, display_id: 0, active: true, focused: true, bounds }],
  examined_nodes: 1,
  retained_nodes: 1,
  coverage: "complete",
  limitations: [],
};

const adbFixtureSource = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const root = __dirname;
const args = process.argv.slice(2);
if(args[0] === 'version') {
  console.log('Android Debug Bridge version 1.0.41\\nVersion 34.0.5-ui-fixture\\nInstalled as ' + __filename);
  process.exit(0);
}
if(JSON.stringify(args) === JSON.stringify(['-s','emulator-5554','shell','am','force-stop','com.example.app'])) {
  fs.appendFileSync(path.join(root,'calls'),JSON.stringify({operation:'stop_adb_app',arguments:args})+'\\n');
  if(fs.existsSync(path.join(root,'active'))) throw new Error('Non-UI dispatch raced an unsettled UI request');
  const mode=JSON.parse(fs.readFileSync(path.join(root,'mode.json'),'utf8'));
  if(mode.hold_stop) {
    fs.writeFileSync(path.join(root,'stop-entered'),'held');
    while(!fs.existsSync(path.join(root,'release-stop'))) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);
  }
  if(mode.stop_failure) { console.error('device offline'); process.exit(1); }
  process.exit(0);
}
const stream = args[2] === 'shell' && args[3] === '-T';
if(stream) {
  if(args[0]!=='-s' || JSON.stringify(args.slice(3))!==JSON.stringify(['-T','run-as','dev.rea.uiautomator','--user','0','/system/bin/toybox','nc','-U','-w','5','-W','10','files/rea-ui-${instance}.sock'])) throw new Error('unmodeled private input command');
} else if(args[0] !== '-s' || args[2] !== 'shell' || args[3] !== 'am' || args[4] !== 'broadcast' || args[5] !== '--receiver-foreground' || args[6] !== '--user' || args[7] !== '0' || args[8] !== '-a' || args[10] !== '-p' || args[12] !== '--es' || args[13] !== 'request' || args.length !== 15) throw new Error('unmodeled adb command');
const request = JSON.parse(Buffer.from(stream ? fs.readFileSync(0,'utf8').trim() : args[14], 'base64').toString('utf8'));
if(request.protocol!==2 || (!stream && request.input!==undefined)) throw new Error('UI input must use the private protocol');
if(stream) fs.writeFileSync(path.join(root,'received-input.json'),JSON.stringify(request.input));
const mode = JSON.parse(fs.readFileSync(path.join(root, 'mode.json'), 'utf8'));
fs.appendFileSync(path.join(root, 'calls'), JSON.stringify({operation:request.operation,target_operation:request.target_operation,request_id:request.request_id,cancel_request_id:request.cancel_request_id,arguments:args})+'\\n');
const runner = ${JSON.stringify(runner)};
const node = ${JSON.stringify(node)};
const snapshot = ${JSON.stringify(header)};
const frame = (id,result,error=null) => ({protocol:2,request_id:id,instance_id:runner.instance_id,ok:error===null,result,error});
const reply = result => {
  const encoded='REA_UI_V2:' + Buffer.from(JSON.stringify(frame(request.request_id,result))).toString('base64');
  console.log(stream ? encoded : 'Broadcast completed: result=0, data="'+encoded+'"');
};
const jobFile = id => path.join(root, 'job-' + id + '.json');
if (request.operation === 'ping') {
  if(mode.kind === 'unavailable') console.log('Broadcast completed: result=0');
  else {
    reply({runner,socket_path:'files/rea-ui-${instance}.sock'});
    if(mode.kind === 'vanish-after-ping') fs.renameSync(__filename,path.join(root,'saved-adb'));
  }
} else if (request.operation === 'prepare') {
  const file=mode.kind==='delayed' ? path.join(root,'delayed-'+request.request_id) : jobFile(request.request_id);
  fs.writeFileSync(file,JSON.stringify({state:'prepared'}));
  if(mode.kind==='wrong-id') request.request_id='00000000-0000-4000-8000-000000000099';
  if(mode.kind==='delayed') console.log('Broadcast completed: result=0, data="REA_UI_V2:not-json"');
  else reply({state:'prepared'});
} else if (request.operation === 'cancel') {
  if(mode.cancel_offline) { console.error('device offline'); process.exit(1); }
  if(mode.cancel_capacity) {
    const encoded='REA_UI_V2:' + Buffer.from(JSON.stringify(frame(request.request_id,null,{kind:'capacity',reason:'Response exceeds the Binder transport budget'}))).toString('base64');
    console.log('Broadcast completed: result=0, data="'+encoded+'"');
    process.exit(0);
  }
  fs.rmSync(path.join(root, 'active'), {force:true});
  const file=jobFile(request.cancel_request_id);
  let response=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):null;
  if(response?.state==='running' || response?.state==='prepared') response=frame(request.cancel_request_id,null,{kind:'cancelled',reason:'UI request cancelled'});
  if(response!==null) fs.writeFileSync(file,JSON.stringify(response));
  reply({state:response===null?'missing':'settled',response});
} else if (request.operation === 'forget') {
  if(mode.hold_forget) {
    fs.writeFileSync(path.join(root,'forget-entered'),request.target_request_id);
    while(!fs.existsSync(path.join(root,'release-forget'))) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);
  }
  if(mode.forget_offline) { console.error('device offline'); process.exit(1); }
  if(mode.forget_offline_once && !fs.existsSync(path.join(root,'forget-ack-lost'))) {
    fs.writeFileSync(path.join(root,'forget-ack-lost'),'forgotten');
    fs.rmSync(jobFile(request.target_request_id),{force:true});
    console.error('device offline after forgetting request');
    process.exit(1);
  }
  fs.rmSync(jobFile(request.target_request_id),{force:true}); reply({state:'forgotten'});
} else if (request.operation === 'status') {
  if(mode.status_offline) { console.error('device offline'); process.exit(1); }
  const file=jobFile(request.target_request_id);
  const response=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):null;
  if(mode.status_capacity) console.log('Broadcast completed: result=1, data="REA_UI_V2:' + Buffer.from(JSON.stringify(frame(request.request_id,null,{kind:'capacity',reason:'Response exceeds the Binder transport budget'}))).toString('base64')+'"');
  else if(response?.state==='running') setInterval(()=>{},1000);
  else reply({state:response===null?'missing':'settled',response});
} else {
   if(!stream || !fs.existsSync(jobFile(request.request_id))) throw new Error('Input was not prepared');
    if(mode.body_refusal) {
       const kind=mode.body_refusal==='capacity'?'capacity':'busy';
       const reason=kind==='capacity'?'Unacknowledged UI request capacity exhausted':'Another UI request is active';
       const response=frame(request.request_id,null,{kind,reason});
       if(mode.body_refusal_identity==='request') response.request_id='00000000-0000-4000-8000-000000000099';
       if(mode.body_refusal_identity==='runner') response.instance_id='00000000-0000-4000-8000-000000000099';
       const encoded='REA_UI_V2:' + (mode.body_refusal_identity==='malformed'?'not-json':Buffer.from(JSON.stringify(response)).toString('base64'));
     console.log(encoded);
     process.exit(0);
   }
   snapshot.package_name = request.input.package;
   snapshot.display_id = request.input.display_id;
    snapshot.window_id_filter = request.input.window_id ?? null;
    snapshot.id = request.input.snapshot_id ?? snapshot.id;
   node.window_id = request.input.window_id ?? node.window_id;
   snapshot.windows = snapshot.windows.map(window => ({...window, id:node.window_id, display_id:snapshot.display_id}));
    if(mode.kind === 'wrong-package') snapshot.package_name = 'com.other.app';
    if(mode.snapshot_override) Object.assign(snapshot,mode.snapshot_override);
  let result;
  if(request.operation === 'inspect_adb_ui') result={runner,snapshot:{...snapshot,nodes:[node]}};
   else if(request.operation === 'find_adb_ui_elements') result={runner,snapshot,matches:[node].slice(request.input.offset,request.input.offset+request.input.limit),related_nodes:[],total_matches:1,offset:request.input.offset,next_offset:null,coverage:'complete',freshness:request.input.snapshot_id?'retained_snapshot':'captured'};
  else if(request.operation === 'perform_adb_ui_action') {
    node.password = Boolean(mode.password); node.text_redacted = node.password; if(node.password) node.text=null;
      result={runner,before:snapshot,selected_element:request.input.action.kind==='key_event'?null:node,dispatch_attempted:true,action_completed:true,action_error:null,text_verified:request.input.action.kind==='set_text'?true:null,can_scroll_more:null,after:mode.after_snapshot ? {...snapshot,nodes:[node],...mode.after_snapshot} : null,observation_failure:null};
   } else if(request.operation !== 'wait_for_adb_ui' || mode.kind !== 'hang') throw new Error('unmodeled UI operation');
    if(result && mode.runner_override) result.runner={...runner,...mode.runner_override};
    if(result && mode.observation_override) Object.assign(result,mode.observation_override);
   if(mode.completion_capacity) fs.writeFileSync(jobFile(request.request_id),JSON.stringify(frame(request.request_id,null,{kind:typeof mode.completion_capacity==='string'?mode.completion_capacity:'capacity',reason:mode.capacity_reason??'Response exceeds the Binder transport budget'})));
    else if(mode.unsupported_reason) fs.writeFileSync(jobFile(request.request_id),JSON.stringify(frame(request.request_id,null,{kind:mode.unsupported_kind??'unsupported',reason:mode.unsupported_reason})));
  else if(mode.action_refusal) fs.writeFileSync(jobFile(request.request_id),JSON.stringify(frame(request.request_id,null,{kind:'stale_element',reason:'Selected element is no longer current'})));
  else if(mode.kind==='hang') {
    fs.writeFileSync(path.join(root,'active'),request.request_id);
    fs.writeFileSync(jobFile(request.request_id),JSON.stringify({state:'running'}));
  } else fs.writeFileSync(jobFile(request.request_id),JSON.stringify(frame(request.request_id,result)));
  if(mode.kind === 'wrong-id') request.request_id = '00000000-0000-4000-8000-000000000099';
  if(mode.kind==='malformed') console.log('REA_UI_V2:not-json');
  else reply({state:'accepted'});
}
`;

async function fixture(
  mode: Record<string, unknown> = {},
  onLateUiEvidence?: (evidence: unknown) => void,
) {
  const workspace = await createTestWorkspace("rea-ui-transport-");
  const config = workspace.path("mode.json");
  await writeFile(config, JSON.stringify(mode));
  const binary = await workspace.write("adb", adbFixtureSource);
  await chmod(binary, 0o755);
  const environment = {
    ...process.env,
    ...workspace.environment,
    REA_ADB_PATH: binary,
  };
  const provider = new AdbProvider({
    environment,
    ...(onLateUiEvidence === undefined ? {} : { onLateUiEvidence }),
  });
  const service = new AdbDeviceAnalysisService(provider);
  onTestFinished(async () => {
    await writeFile(workspace.path("release-stop"), "release");
    await writeFile(workspace.path("release-forget"), "release");
    await writeFile(config, "{}");
    await provider.close();
    await removeTestWorkspace(workspace.root);
  });
  return {
    workspace,
    binary,
    environment,
    provider,
    service,
    setMode: (next: Record<string, unknown>) =>
      writeFile(config, JSON.stringify(next)),
  };
}

it.each(
  ["busy", "capacity"].flatMap((kind) =>
    [false, true].map((cancelOffline) => ({ kind, cancelOffline })),
  ),
)(
  "preserves a pre-admission $kind refusal and admits the next action after cleanup (cleanup offline: $cancelOffline)",
  async ({ kind, cancelOffline }) => {
    const { provider, workspace, setMode } = await fixture({
      body_refusal: kind,
      cancel_offline: cancelOffline,
    });
    const harness = await createApplicationMcpHarness({
      serverOptions: { adbDeviceAnalysis: provider },
      configureServer: (server, session) =>
        registerAdbUiExperiment(server, provider, session),
    });
    onTestFinished(async () => {
      await setMode({});
      await harness.close();
    });
    const refused = await harness.client.callTool({
      name: "perform_adb_ui_action",
      arguments: actionInput,
    });
    const error = parseMcpToolError(refused).error;
    expect(error.code).toBe(
      cancelOffline ? "cleanup_incomplete" : "resource_constraint",
    );
    expect(JSON.stringify(error)).toContain(
      kind === "busy"
        ? "Another UI request is active"
        : "Unacknowledged UI request capacity exhausted",
    );
    expect(JSON.stringify(error)).not.toMatch(
      /may have completed|action_outcome|replay_safe/u,
    );
    await setMode({});
    const next = await harness.client.callTool({
      name: "perform_adb_ui_action",
      arguments: actionInput,
    });
    expect(next.isError, JSON.stringify(next)).not.toBe(true);
    await provider.close();
    const calls = (await readFile(workspace.path("calls"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).operation);
    expect(
      calls.filter((name) => name === "perform_adb_ui_action"),
    ).toHaveLength(2);
    expect(calls).not.toContain("inspect_adb_ui");
  },
);

it.each([
  ...["busy", "capacity"].flatMap((kind) =>
    [false, true].map((cancel) => ({ kind, cancel, identity: "matching" })),
  ),
  ...["request", "runner", "malformed"].map((identity) => ({
    kind: "busy",
    cancel: false,
    identity,
  })),
])(
  "retains a $identity $kind admission reply across denied host cleanup (cancel: $cancel)",
  async ({ kind, cancel, identity }) => {
    const { binary, environment, workspace, setMode } = await fixture({
      body_refusal: kind,
      body_refusal_identity: identity,
    });
    const controller = new AbortController();
    const reason = new Error("cancel during admission command cleanup");
    let denied = true;
    let cleanupAttempts = 0;
    const transport = new AdbUiRunner(environment, async (input) => {
      const acquired = await spawnOwnedProviderProcess(input);
      if (input.arguments[3] !== "-T") return acquired;
      return {
        ...acquired,
        cleanup: async () => {
          cleanupAttempts++;
          if (denied) {
            if (cancel) controller.abort(reason);
            return { cleaned: false, reason: "controlled host cleanup denial" };
          }
          return (
            acquired.cleanup?.() ?? cleanupOwnedProcessGroup(acquired.ownership)
          );
        },
      };
    });
    onTestFinished(async () => {
      denied = false;
      await transport.close();
    });
    const request = {
      operation: "perform_adb_ui_action" as const,
      input: adbUiInputSchemas.perform_adb_ui_action.parse(actionInput),
    };
    const client = {
      binary_path: binary,
      path_source: "environment" as const,
      version: "34.0.5-ui-fixture",
      installed_path: binary,
    };
    const provider = {
      id: "adb",
      name: "ADB fixture",
      version: client.version,
    };
    const result = await transport.execute(
      request,
      binary,
      client,
      provider,
      controller.signal,
    );
    if (result.ok) throw new Error("Expected denied host cleanup");
    expect(cleanupAttempts).toBeGreaterThan(1);
    expect(result.error.cleanupIncomplete).toBe(true);
    expect(transport.pendingResources).not.toEqual([]);
    const projected = projectAnalysisError(result.error);
    expect(projected.code).toBe("cleanup_incomplete");
    if (identity === "matching") {
      expect(projected).toMatchObject({
        details: {
          diagnostics: { primary_error: { code: "resource_constraint" } },
        },
      });
      expect(JSON.stringify(projected)).toContain(
        kind === "busy"
          ? "Another UI request is active"
          : "Unacknowledged UI request capacity exhausted",
      );
      expect(JSON.stringify(projected)).not.toMatch(
        /may have completed|action_outcome|replay_safe/u,
      );
      if (cancel) {
        expect(JSON.stringify(projected)).toContain("cancelled");
        expect(
          result.error.cleanupPrimary?.secondaryFailures.find(
            (failure) => failure._tag === "AnalysisCancelledError",
          )?.cause,
        ).toBe(reason);
      }
    } else expect(projected.message).toContain("may have completed");
    denied = false;
    await setMode({});
    expect(await transport.reconcile(request.operation)).toBeUndefined();
    expect(result.error.cleanupIncomplete).toBe(false);
    expect(transport.pendingResources).toEqual([]);
    if (identity === "matching") {
      const next = await transport.execute(request, binary, client, provider);
      if (!next.ok) throw next.error;
      expect(await readFile(workspace.path("calls"), "utf8")).not.toContain(
        '"inspect_adb_ui"',
      );
    }
  },
);

const completionRecoveryCases = [
  { name: "status", mode: {}, cleanupIncomplete: false },
  { name: "cleanup", mode: { status_offline: true }, cleanupIncomplete: false },
  {
    name: "later cleanup",
    mode: { status_offline: true, cancel_offline: true },
    cleanupIncomplete: true,
  },
  {
    name: "lost forget acknowledgement",
    mode: { status_offline: true, forget_offline_once: true },
    cleanupIncomplete: true,
  },
];

it.each(completionRecoveryCases)(
  "guards a capacity-only action completion recovered through $name until a matching fresh inspection",
  async ({ mode, cleanupIncomplete }) => {
    const { provider, workspace, setMode } = await fixture({
      ...mode,
      completion_capacity: "capacity",
    });
    const harness = await createApplicationMcpHarness({
      serverOptions: { adbDeviceAnalysis: provider },
      configureServer: (server, session) =>
        registerAdbUiExperiment(server, provider, session),
    });
    onTestFinished(async () => {
      await setMode({});
      await harness.close();
    });
    const first = await harness.client.callTool({
      name: "perform_adb_ui_action",
      arguments: actionInput,
    });
    const error = parseMcpToolError(first).error;
    expect(error.code).toBe(
      cleanupIncomplete ? "cleanup_incomplete" : "unreadable_output",
    );
    expect(error.message).toContain("may have completed");
    await setMode({});
    const replay = await harness.client.callTool({
      name: "perform_adb_ui_action",
      arguments: actionInput,
    });
    expect(parseMcpToolError(replay).error).toMatchObject({
      code: "unreadable_output",
      details: {
        diagnostics: {
          current_request_dispatched: false,
          prior_action_outcome: "unknown",
        },
      },
    });
    const actionCalls = async () =>
      (await readFile(workspace.path("calls"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .filter(({ operation }) => operation === "perform_adb_ui_action");
    expect(await actionCalls()).toHaveLength(1);
    const inspection = await harness.client.callTool({
      name: "inspect_adb_ui",
      arguments: scope,
    });
    expect(inspection.isError, JSON.stringify(inspection)).not.toBe(true);
    const next = await harness.client.callTool({
      name: "perform_adb_ui_action",
      arguments: actionInput,
    });
    expect(next.isError, JSON.stringify(next)).not.toBe(true);
    expect(await actionCalls()).toHaveLength(2);
  },
);

it.each(completionRecoveryCases)(
  "keeps a sensitive-store capacity refusal definitive through $name recovery",
  async ({ name, mode, cleanupIncomplete }) => {
    const reason =
      "Runner sensitive-text retention budget exhausted; existing redactions are retained";
    const { provider, workspace, setMode } = await fixture({
      ...mode,
      completion_capacity: "sensitive_capacity",
      capacity_reason: reason,
    });
    const harness = await createApplicationMcpHarness({
      serverOptions: { adbDeviceAnalysis: provider },
      configureServer: (server, session) =>
        registerAdbUiExperiment(server, provider, session),
    });
    onTestFinished(async () => {
      await setMode({});
      await harness.close();
    });
    const first = await harness.client.callTool({
      name: "perform_adb_ui_action",
      arguments: {
        ...actionInput,
        action: { kind: "set_text", text: "capacity probe", sensitive: true },
      },
    });
    const error = parseMcpToolError(first).error;
    expect(error.code).toBe(
      cleanupIncomplete ? "cleanup_incomplete" : "resource_constraint",
    );
    if (name !== "later cleanup") {
      expect(error.message).toContain(reason);
      expect(error.message).not.toContain("may have completed");
      if (!cleanupIncomplete)
        expect(error.remediation.action).toContain(
          "restart the operator-owned UI runner",
        );
    }
    await setMode({});
    const fresh = await harness.client.callTool({
      name: "find_adb_ui_elements",
      arguments: { ...scope, selector: {} },
    });
    expect(fresh.isError, JSON.stringify(fresh)).not.toBe(true);
    const next = await harness.client.callTool({
      name: "perform_adb_ui_action",
      arguments: actionInput,
    });
    expect(next.isError, JSON.stringify(next)).not.toBe(true);
    const calls = (await readFile(workspace.path("calls"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).operation);
    expect(
      calls.filter((operation) => operation === "perform_adb_ui_action"),
    ).toHaveLength(2);
    expect(calls).not.toContain("inspect_adb_ui");
  },
);

/** Hold the producing discovery boundary; all released probes still run the real child. */
function holdClientDiscovery() {
  const entered = createDeferred<void>();
  const resumed = createDeferred<void>();
  const inspect = adbConfiguration.inspectAdbClient;
  let held = false;
  const discovery = vi
    .spyOn(adbConfiguration, "inspectAdbClient")
    .mockImplementation(async (...args) => {
      if (!held) {
        held = true;
        entered.resolve();
        await resumed.promise;
      }
      return inspect(...args);
    });
  onTestFinished(() => {
    resumed.resolve();
    discovery.mockRestore();
  });
  return {
    entered: entered.promise,
    release: () => resumed.resolve(),
    discovery,
  };
}

it("projects a real subprocess reply through the named UI contract and preserves Unicode", async () => {
  const { service } = await fixture();
  const outcome = await service.execute("find_adb_ui_elements", {
    ...scope,
    selector: { text: { value: "Hello 世界" } },
  });
  if (!outcome.ok) throw outcome.error;
  const evidence = toolContract("find_adb_ui_elements").outputSchema.parse(
    outcome.value,
  );
  expect(evidence.authority).toBe("controlled-replay");
  expect(evidence.normalized_result.matches[0]?.text).toBe("Hello 世界");
  expect(evidence.normalized_result.runner.instance_id).toBe(instance);
  expect(evidence.parameters).toMatchObject({
    selector: { text: { value: "Hello 世界", match: "exact" } },
  });
});

it.each(["unavailable", "malformed", "wrong-id", "wrong-package"])(
  "refuses %s producer state without presenting it as UI evidence",
  async (kind) => {
    const { service } = await fixture({ kind });
    const result = await service.execute("inspect_adb_ui", scope);
    if (result.ok) throw new Error("Expected a boundary refusal");
    expect(result.error._tag).toBe(
      kind === "unavailable"
        ? "AnalysisCapabilityUnavailableError"
        : "AnalysisProtocolError",
    );
  },
);

it.each([
  { field: "package_name", value: "dev.other.uiautomator" },
  { field: "instance_id", value: "00000000-0000-4000-8000-000000000099" },
  { field: "version", value: "0.3.0" },
  { field: "ui_automator_version", value: "2.5.0" },
  { field: "sdk_int", value: 35 },
])(
  "refuses an observation whose runner $field differs from ping through MCP",
  async ({ field, value }) => {
    const { provider } = await fixture({ runner_override: { [field]: value } });
    const harness = await createApplicationMcpHarness({
      serverOptions: { adbDeviceAnalysis: provider },
    });
    const response = await harness.client.callTool({
      name: "inspect_adb_ui",
      arguments: scope,
    });
    const error = parseMcpToolError(response).error;
    expect(error.code).toBe("unreadable_output");
    expect(error.details?.partial_observation).toBeUndefined();
  },
);

it.each([
  { field: "package_name", value: "com.other.app" },
  { field: "display_id", value: 0 },
  { field: "window_id_filter", value: null },
])(
  "refuses an action after-snapshot with mismatched $field through MCP",
  async ({ field, value }) => {
    const { provider } = await fixture({ after_snapshot: { [field]: value } });
    const harness = await createApplicationMcpHarness({
      serverOptions: { adbDeviceAnalysis: provider },
      configureServer: (server, session) =>
        registerAdbUiExperiment(server, provider, session),
    });
    const response = await harness.client.callTool({
      name: "perform_adb_ui_action",
      arguments: { ...actionInput, display_id: 1, window_id: 7 },
    });
    const error = parseMcpToolError(response).error;
    expect(error.code).toBe("unreadable_output");
    expect(error.details?.partial_observation).toBeUndefined();
  },
);

it.each(["tap", "key_event"] as const)(
  "retains matching runner and before/after scope identities for %s through MCP",
  async (kind) => {
    const { provider } = await fixture({
      after_snapshot: { id: otherSnapshotId },
    });
    const harness = await createApplicationMcpHarness({
      serverOptions: { adbDeviceAnalysis: provider },
      configureServer: (server, session) =>
        registerAdbUiExperiment(server, provider, session),
    });
    const response = await harness.client.callTool({
      name: "perform_adb_ui_action",
      arguments: {
        ...scope,
        snapshot_id: snapshotId,
        display_id: kind === "key_event" ? 0 : 1,
        window_id: 7,
        ...(kind === "key_event"
          ? { action: { kind, key_code: 4 } }
          : { element_id: "0", action: { kind } }),
      },
    });
    expect(response.isError, JSON.stringify(response)).not.toBe(true);
    const snapshotScope = {
      package_name: scope.package,
      display_id: kind === "key_event" ? 0 : 1,
      window_id_filter: 7,
    };
    expect(
      parseEvidence(response.structuredContent).normalized_result,
    ).toMatchObject({
      runner,
      before: { ...snapshotScope, id: snapshotId },
      after: { ...snapshotScope, id: otherSnapshotId },
      selected_element: kind === "key_event" ? null : { id: "0" },
    });
  },
);

it.each([
  {
    name: "retained snapshot ID",
    operation: "find_adb_ui_elements",
    input: { ...scope, selector: {}, snapshot_id: snapshotId },
    mode: { snapshot_override: { id: otherSnapshotId } },
  },
  {
    name: "retained snapshot freshness",
    operation: "find_adb_ui_elements",
    input: { ...scope, selector: {}, snapshot_id: snapshotId },
    mode: { observation_override: { freshness: "captured" } },
  },
  {
    name: "fresh capture selection",
    operation: "find_adb_ui_elements",
    input: { ...scope, selector: {} },
    mode: { observation_override: { freshness: "retained_snapshot" } },
  },
  {
    name: "retained page offset",
    operation: "find_adb_ui_elements",
    input: { ...scope, selector: {}, snapshot_id: snapshotId, offset: 1 },
    mode: { observation_override: { offset: 0 } },
  },
  {
    name: "action before snapshot ID",
    operation: "perform_adb_ui_action",
    input: actionInput,
    mode: { snapshot_override: { id: otherSnapshotId } },
  },
  {
    name: "selected element ID",
    operation: "perform_adb_ui_action",
    input: actionInput,
    mode: {
      observation_override: { selected_element: { ...node, id: "other" } },
    },
  },
  {
    name: "missing selected element",
    operation: "perform_adb_ui_action",
    input: actionInput,
    mode: { observation_override: { selected_element: null } },
  },
  {
    name: "key event with an element selection",
    operation: "perform_adb_ui_action",
    input: {
      ...scope,
      snapshot_id: snapshotId,
      action: { kind: "key_event", key_code: 4 },
    },
    mode: { observation_override: { selected_element: node } },
  },
])(
  "rejects mismatched $name through MCP",
  async ({ operation, input, mode }) => {
    const { provider } = await fixture(mode);
    const harness = await createApplicationMcpHarness({
      serverOptions: { adbDeviceAnalysis: provider },
      configureServer: (server, session) =>
        registerAdbUiExperiment(server, provider, session),
    });
    const response = await harness.client.callTool({
      name: operation,
      arguments: input,
    });
    const error = parseMcpToolError(response).error;
    expect(error.code).toBe("unreadable_output");
    expect(error.details?.partial_observation).toBeUndefined();
  },
);

it("binds retained find pages to the selected snapshot without claiming fresh capture", async () => {
  const { provider } = await fixture();
  const harness = await createApplicationMcpHarness({
    serverOptions: { adbDeviceAnalysis: provider },
  });
  const response = await harness.client.callTool({
    name: "find_adb_ui_elements",
    arguments: {
      ...scope,
      selector: {},
      snapshot_id: otherSnapshotId,
      offset: 1,
    },
  });
  expect(response.isError, JSON.stringify(response)).not.toBe(true);
  expect(
    parseEvidence(response.structuredContent).normalized_result,
  ).toMatchObject({
    snapshot: { id: otherSnapshotId },
    offset: 1,
    freshness: "retained_snapshot",
    matches: [],
  });
});

it("redacts explicit sensitive inputs and producer-marked password controls without changing ordinary text", async () => {
  const { service, setMode } = await fixture();
  for (const [sensitive, password, expected] of [
    [false, false, "token=caller-value"],
    [true, false, "[redacted]"],
    [false, true, "[redacted]"],
  ] as const) {
    await setMode({ password });
    const result = await service.execute("perform_adb_ui_action", {
      ...scope,
      snapshot_id: snapshotId,
      element_id: "0",
      action: { kind: "set_text", text: "token=caller-value", sensitive },
    });
    if (!result.ok) throw result.error;
    expect(result.value.parameters).toMatchObject({
      action: { text: expected, sensitive },
    });
  }
});

it("cancels only the owned remote request after host command settlement", async () => {
  const { service, workspace } = await fixture({ kind: "hang" });
  const controller = new AbortController();
  const pending = service.execute(
    "wait_for_adb_ui",
    { ...scope, selector: {}, timeout_ms: 30000 },
    { signal: controller.signal },
  );
  // The fake adb is a real child process; its first write can land after the
  // default poll budget when the runner is saturated.
  await expect
    .poll(() => readFile(workspace.path("active"), "utf8"), {
      timeout: 15_000,
      interval: 50,
    })
    .toMatch(/^[a-f0-9-]{36}$/u);
  const activeId = await readFile(workspace.path("active"), "utf8");
  controller.abort();
  const result = await pending;
  if (result.ok) throw new Error("Expected cancellation");
  expect(result.error._tag).toBe("AnalysisCancelledError");
  const calls = (await readFile(workspace.path("calls"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(calls.filter((call) => call.operation === "cancel")).toEqual([
    expect.objectContaining({ cancel_request_id: activeId }),
  ]);
  await expect(readFile(workspace.path("active"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it.each(["prepare", "input"])(
  "reconciles cancellation before %s process creation and admits the next UI call",
  async (phase) => {
    const { workspace, binary, environment } = await fixture();
    const controller = new AbortController();
    const transport = new AdbUiRunner(environment, async (input) => {
      const wire =
        input.arguments[3] === "am"
          ? JSON.parse(
              Buffer.from(input.arguments.at(-1)!, "base64").toString("utf8"),
            )
          : null;
      if (
        !controller.signal.aborted &&
        (phase === "prepare"
          ? wire?.operation === "prepare" &&
            wire.target_operation === "inspect_adb_ui"
          : input.arguments[3] === "-T")
      )
        controller.abort();
      return spawnOwnedProviderProcess(input);
    });
    onTestFinished(() => transport.close());
    const request = {
      operation: "inspect_adb_ui" as const,
      input: adbUiInputSchemas.inspect_adb_ui.parse(scope),
    };
    const client = {
      binary_path: binary,
      path_source: "environment" as const,
      version: "34.0.5-ui-fixture",
      installed_path: binary,
    };
    const provider = {
      id: "adb",
      name: "Android Debug Bridge",
      version: client.version,
    };
    const cancelled = await transport.execute(
      request,
      binary,
      client,
      provider,
      controller.signal,
    );
    if (cancelled.ok)
      throw new Error("Expected cancellation before process creation");
    expect(cancelled.error._tag).toBe("AnalysisCancelledError");
    expect(cancelled.error.cleanupIncomplete).toBe(false);
    expect(transport.pendingResources).toEqual([]);
    expect(
      (await readFile(workspace.path("calls"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).operation),
    ).toEqual(
      phase === "prepare" ? ["ping"] : ["ping", "prepare", "cancel", "forget"],
    );
    const next = await transport.execute(request, binary, client, provider);
    if (!next.ok) throw next.error;
    expect(next.value.result).toMatchObject({ snapshot: { id: snapshotId } });
  },
);

it("releases a proven spawn refusal and admits a later UI call", async () => {
  const { workspace, binary, service, setMode } = await fixture({
    kind: "vanish-after-ping",
  });
  const result = await service.execute("inspect_adb_ui", scope);
  await rename(workspace.path("saved-adb"), binary);
  await setMode({});
  if (result.ok) throw new Error("Expected spawn refusal");
  expect(result.error.cleanupIncomplete).toBe(false);
  expect(
    (await readFile(workspace.path("calls"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).operation),
  ).toEqual(["ping"]);
  const next = await service.execute("inspect_adb_ui", scope);
  if (!next.ok) throw next.error;
  expect(next.value.normalized_result).toMatchObject({
    snapshot: { id: snapshotId },
  });
});

it("retains failed remote cleanup for a later close retry", async () => {
  const { service, provider, workspace, setMode } = await fixture({
    kind: "hang",
    cancel_offline: true,
  });
  const controller = new AbortController();
  const pending = service.execute(
    "wait_for_adb_ui",
    { ...scope, selector: {} },
    { signal: controller.signal },
  );
  // The fake adb is a real child process; its first write can land after the
  // default poll budget when the runner is saturated.
  await expect
    .poll(() => readFile(workspace.path("active"), "utf8"), {
      timeout: 15_000,
      interval: 50,
    })
    .toMatch(/^[a-f0-9-]{36}$/u);
  controller.abort();
  const result = await pending;
  if (result.ok) throw new Error("Expected retained cleanup failure");
  expect(result.error.cleanupResources.length).toBeGreaterThan(0);
  await setMode({});
  await provider.close();
  expect(result.error.cleanupIncomplete).toBe(false);
  await expect(readFile(workspace.path("active"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it.each([
  { kind: "valid", mode: { after_snapshot: {} } },
  { kind: "wrong-package", mode: { kind: "wrong-package" } },
  { kind: "wrong-runner", mode: { runner_override: { version: "0.3.0" } } },
  { kind: "wrong-after", mode: { after_snapshot: { display_id: 1 } } },
  {
    kind: "wrong-snapshot",
    mode: { snapshot_override: { id: otherSnapshotId } },
  },
  {
    kind: "wrong-element",
    mode: {
      observation_override: { selected_element: { ...node, id: "other" } },
    },
  },
])(
  "classifies the $kind action report before cancellation during final acknowledgement",
  async ({ kind, mode }) => {
    const { binary, environment } = await fixture(mode);
    const controller = new AbortController();
    const reason = new Error("cancelled during UI acknowledgement");
    const transport = new AdbUiRunner(environment, async (input) => {
      const control =
        input.arguments[3] === "am"
          ? JSON.parse(
              Buffer.from(input.arguments.at(-1)!, "base64").toString("utf8"),
            )
          : null;
      if (control?.operation === "forget" && !controller.signal.aborted)
        controller.abort(reason);
      return spawnOwnedProviderProcess(input);
    });
    onTestFinished(() => transport.close());
    const request = {
      operation: "perform_adb_ui_action" as const,
      input: adbUiInputSchemas.perform_adb_ui_action.parse({
        ...scope,
        snapshot_id: snapshotId,
        element_id: "0",
        action: { kind: "tap" },
      }),
    };
    const client = {
      binary_path: binary,
      path_source: "environment" as const,
      version: "34.0.5-ui-fixture",
      installed_path: binary,
    };
    const result = await transport.execute(
      request,
      binary,
      client,
      { id: "adb", name: "ADB fixture", version: client.version },
      controller.signal,
    );
    if (result.ok)
      throw new Error("Cancelled finalization must not report success");
    expect(controller.signal.aborted).toBe(true);
    expect(result.error.cleanupIncomplete).toBe(false);
    expect(transport.pendingResources).toEqual([]);
    if (kind === "valid") {
      expect(result.error._tag).toBe("AnalysisCancelledError");
      expect(result.error.cause).toBe(reason);
      expect(result.error.partialObservation).toMatchObject({
        evidence_id: expect.any(String),
        provider: { id: "adb", version: client.version },
        operation: request.operation,
        authority: "controlled-replay",
        normalized_result: {
          serial: scope.serial,
          dispatch_attempted: true,
          action_completed: true,
        },
      });
    } else {
      expect(result.error._tag).toBe("AnalysisProtocolError");
      expect(result.error.partialObservation).toBeUndefined();
    }
  },
);

it("preserves a completed observation when acknowledgement fails and resolves cleanup on retry", async () => {
  const { service, provider, setMode } = await fixture({
    forget_offline: true,
  });
  const result = await service.execute("inspect_adb_ui", scope);
  if (result.ok) throw new Error("Expected acknowledgement cleanup failure");
  // A recovered observation is a complete, recordable Evidence record, so the
  // session exports it instead of an unreferenced fact bundle.
  expect(parseEvidence(result.error.partialObservation)).toMatchObject({
    evidence_id: expect.any(String),
    provider: { id: "adb", version: "34.0.5-ui-fixture" },
    operation: "inspect_adb_ui",
    authority: "controlled-replay",
    confidence: "observed",
    limitations: expect.any(Array),
    normalized_result: {
      serial: scope.serial,
      snapshot: {
        id: snapshotId,
        nodes: [expect.objectContaining({ text: "Hello 世界" })],
      },
    },
  });
  expect(result.error.cleanupIncomplete).toBe(true);
  await setMode({});
  await provider.close();
  expect(result.error.cleanupIncomplete).toBe(false);
});

/** The runner's refusal must remain usable in the public error projection. */
const recoveredRefusal = {
  code: "unreadable_output",
  message: "Selected element is no longer current",
  details: {
    operation: "perform_adb_ui_action",
    reason: "stale_element",
    diagnostics: { runner_failure: "stale_element" },
  },
};

/** Run an action whose status reply never reached the host. */
const runLostStatusAction = async (
  state: Awaited<ReturnType<typeof fixture>>,
) => {
  const result = await state.service.execute(
    "perform_adb_ui_action",
    actionInput,
  );
  if (result.ok) throw new Error("Expected the offline status failure");
  return result;
};

it("reserves ADB admission before UI client discovery on the same MCP connection", async () => {
  const { provider, workspace } = await fixture();
  const held = holdClientDiscovery();
  const stopEntered = createDeferred<void>();
  const harness = await createApplicationMcpHarness({
    serverOptions: {
      adbDeviceAnalysis: {
        inspectAvailability: (signal) => provider.inspectAvailability(signal),
        close: () => provider.close(),
        execute: (request, options) => {
          const pending = provider.execute(request, options);
          if (request.operation === "stop_adb_app") stopEntered.resolve();
          return pending;
        },
      },
    },
  });
  onTestFinished(() => harness.close());
  const ui = harness.client.callTool({
    name: "inspect_adb_ui",
    arguments: scope,
  });
  await held.entered;
  const stop = harness.client.callTool({
    name: "stop_adb_app",
    arguments: scope,
  });
  try {
    await stopEntered.promise;
    // Drain the accepted call's promise continuations, not a guessed child-process
    // delay. The controlled first discovery cannot progress until released.
    await setImmediate();
    expect(held.discovery).toHaveBeenCalledTimes(1);
  } finally {
    held.release();
    await Promise.all([ui, stop]);
  }
  expect((await ui).isError).not.toBe(true);
  expect((await stop).isError).not.toBe(true);
  const operations = (await readFile(workspace.path("calls"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line).operation);
  expect(operations.slice(-2)).toEqual(["forget", "stop_adb_app"]);
});

it("cancels queued turns without releasing successors or close ahead of discovery", async () => {
  const { provider, service, workspace } = await fixture();
  const held = holdClientDiscovery();
  const ui = service.execute("inspect_adb_ui", scope);
  await held.entered;
  const controller = new AbortController();
  const reason = new AnalysisOutputError(
    "inspect_adb_ui",
    "opaque abort reason",
  );
  const abandoned = service.execute("inspect_adb_ui", scope, {
    signal: controller.signal,
  });
  const retained = service.execute(
    "find_adb_ui_elements",
    { ...scope, selector: {}, timeout_ms: 7_311 },
    { signal: new AbortController().signal },
  );
  const stop = service.execute("stop_adb_app", scope);
  controller.abort(reason);
  let closed = false;
  const closing = provider.close().then(() => {
    closed = true;
  });
  try {
    const cancelled = await abandoned;
    if (cancelled.ok) throw new Error("Expected queued cancellation");
    expect(cancelled.error._tag).toBe("AnalysisCancelledError");
    expect(cancelled.error.cause).toBe(reason);
    await setImmediate();
    expect(held.discovery).toHaveBeenCalledTimes(1);
    expect(closed).toBe(false);
    const refused = await service.execute("inspect_adb_ui", scope);
    if (refused.ok) throw new Error("Close must seal new admission");
    expect(refused.error._tag).toBe("AnalysisCancelledError");
  } finally {
    held.release();
    await Promise.all([ui, retained, stop, closing]);
  }
  const observed = await ui;
  if (!observed.ok) throw observed.error;
  const selected = await retained;
  if (!selected.ok) throw selected.error;
  expect(selected.value.parameters.timeout_ms).toBe(7_311);
  expect(
    JSON.parse(await readFile(workspace.path("received-input.json"), "utf8")),
  ).toMatchObject({ timeout_ms: 7_311 });
  const stopped = await stop;
  if (!stopped.ok) throw stopped.error;
  expect(closed).toBe(true);
  const operations = (await readFile(workspace.path("calls"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line).operation);
  expect(
    operations.filter((operation) => operation === "inspect_adb_ui"),
  ).toHaveLength(1);
  expect(operations.slice(-2)).toEqual(["forget", "stop_adb_app"]);
});

it("keeps UI discovery behind an earlier non-UI mutation even when that mutation fails", async () => {
  const { service, workspace } = await fixture({
    hold_stop: true,
    stop_failure: true,
  });
  const discovery = vi.spyOn(adbConfiguration, "inspectAdbClient");
  onTestFinished(() => discovery.mockRestore());
  const stop = service.execute("stop_adb_app", scope);
  await expect
    .poll(() => readFile(workspace.path("stop-entered"), "utf8"), {
      timeout: 15_000,
    })
    .toBe("held");
  const ui = service.execute("inspect_adb_ui", scope);
  try {
    await setImmediate();
    expect(discovery).toHaveBeenCalledTimes(1);
  } finally {
    await writeFile(workspace.path("release-stop"), "release");
    await Promise.all([stop, ui]);
  }
  const failed = await stop;
  if (failed.ok) throw new Error("Expected the ordinary ADB transport failure");
  expect(failed.error.cleanupIncomplete).toBe(false);
  const observed = await ui;
  if (!observed.ok) throw observed.error;
  expect(observed.value.authority).toBe("controlled-replay");
  const operations = (await readFile(workspace.path("calls"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line).operation);
  expect(operations[0]).toBe("stop_adb_app");
  expect(operations.at(-1)).toBe("forget");
});

it("holds admission and shutdown through cancellation during final UI acknowledgement", async () => {
  const { service, provider, workspace } = await fixture({ hold_forget: true });
  const controller = new AbortController();
  const reason = new Error("cancel while final acknowledgement is held");
  const ui = service.execute("perform_adb_ui_action", actionInput, {
    signal: controller.signal,
  });
  await expect
    .poll(() => readFile(workspace.path("forget-entered"), "utf8"), {
      timeout: 15_000,
    })
    .toMatch(/^[a-f0-9-]{36}$/u);
  const stop = service.execute("stop_adb_app", scope);
  let closed = false;
  const closing = provider.close().then(() => {
    closed = true;
  });
  try {
    controller.abort(reason);
    // The second forget is independent cleanup after the cancelled first child.
    // Holding that child proves the caller and close still own finalization.
    await expect
      .poll(
        async () =>
          (await readFile(workspace.path("calls"), "utf8"))
            .trim()
            .split("\n")
            .filter((line) => JSON.parse(line).operation === "forget").length,
        { timeout: 15_000 },
      )
      .toBe(2);
    expect(closed).toBe(false);
    expect(await readFile(workspace.path("calls"), "utf8")).not.toContain(
      '"operation":"stop_adb_app"',
    );
  } finally {
    await writeFile(workspace.path("release-forget"), "release");
    await Promise.all([ui, stop, closing]);
  }
  const cancelled = await ui;
  if (cancelled.ok) throw new Error("Expected finalization cancellation");
  expect(cancelled.error._tag).toBe("AnalysisCancelledError");
  expect(cancelled.error.cause).toBe(reason);
  expect(cancelled.error.cleanupIncomplete).toBe(false);
  expect(parseEvidence(cancelled.error.partialObservation)).toMatchObject({
    operation: "perform_adb_ui_action",
    authority: "controlled-replay",
    normalized_result: { dispatch_attempted: true, action_completed: true },
  });
  const stopped = await stop;
  if (!stopped.ok) throw stopped.error;
  expect(closed).toBe(true);
  const operations = (await readFile(workspace.path("calls"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line).operation);
  expect(operations.slice(-2)).toEqual(["forget", "stop_adb_app"]);
});

it("reconciles retained UI work before a non-UI call queued during discovery on the same MCP connection", async () => {
  const { provider, workspace, setMode } = await fixture({
    kind: "hang",
    status_offline: true,
    cancel_offline: true,
  });
  const harness = await createApplicationMcpHarness({
    serverOptions: { adbDeviceAnalysis: provider },
    configureServer: (server, session) =>
      registerAdbUiExperiment(server, provider, session),
  });
  onTestFinished(async () => {
    await setMode({});
    await harness.close();
  });
  const held = holdClientDiscovery();
  const ui = harness.client.callTool({
    name: "perform_adb_ui_action",
    arguments: actionInput,
  });
  await held.entered;
  const stop = harness.client.callTool({
    name: "stop_adb_app",
    arguments: scope,
  });
  held.release();
  const interrupted = await ui;
  const blocked = await stop;
  expect(parseMcpToolError(interrupted).error.code).toBe("cleanup_incomplete");
  const activeId = await readFile(workspace.path("active"), "utf8");
  expect(parseMcpToolError(blocked).error).toMatchObject({
    code: "cleanup_incomplete",
    details: { operation: "stop_adb_app" },
  });
  const retained = await provider.execute({
    operation: "stop_adb_app",
    input: scope,
  });
  if (retained.ok) throw new Error("Expected retained admission cleanup");
  expect(retained.error.cleanupIncomplete).toBe(true);
  expect(await readFile(workspace.path("active"), "utf8")).toBe(activeId);
  expect(await readFile(workspace.path("calls"), "utf8")).not.toContain(
    '"operation":"stop_adb_app"',
  );

  await setMode({});
  const stopped = await harness.client.callTool({
    name: "stop_adb_app",
    arguments: scope,
  });
  expect(stopped.isError).not.toBe(true);
  expect(retained.error.cleanupIncomplete).toBe(false);
  await expect(readFile(workspace.path("active"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  await expect(
    readFile(workspace.path(`job-${activeId}.json`)),
  ).rejects.toMatchObject({ code: "ENOENT" });
  const calls = (await readFile(workspace.path("calls"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(calls.at(-1).operation).toBe("stop_adb_app");
  expect(calls.at(-2)).toMatchObject({ operation: "forget" });
});

it("cancels a non-UI admission wait without cancelling the active UI caller", async () => {
  const { service, provider, workspace } = await fixture({ kind: "hang" });
  const uiController = new AbortController();
  const ui = service.execute(
    "wait_for_adb_ui",
    { ...scope, selector: {}, timeout_ms: 30000 },
    { signal: uiController.signal },
  );
  try {
    await expect
      .poll(() => readFile(workspace.path("active"), "utf8"), {
        timeout: 15_000,
      })
      .toMatch(/^[a-f0-9-]{36}$/u);
    const controller = new AbortController();
    const reason = new Error("cancel only the non-UI caller");
    // This direct provider call enters the admission wait synchronously, while
    // the existing public UI call still owns its running request.
    const stop = provider.execute(
      { operation: "stop_adb_app", input: scope },
      { signal: controller.signal },
    );
    controller.abort(reason);
    const result = await stop;
    if (result.ok) throw new Error("Expected cancelled non-UI admission");
    expect(result.error._tag).toBe("AnalysisCancelledError");
    expect(result.error.cause).toBe(reason);
    expect(await readFile(workspace.path("active"), "utf8")).toMatch(
      /^[a-f0-9-]{36}$/u,
    );
    expect(await readFile(workspace.path("calls"), "utf8")).not.toContain(
      '"operation":"stop_adb_app"',
    );
  } finally {
    uiController.abort();
    await ui;
  }
});

it.each([
  {
    operation: "inspect_adb_ui",
    input: { ...scope, display_id: 1 },
    reason: "Secondary display inspection requires Android 11",
    kind: "unsupported",
  },
  {
    operation: "perform_adb_ui_action",
    input: {
      ...scope,
      display_id: 1,
      snapshot_id: snapshotId,
      action: { kind: "key_event", key_code: 4 },
    },
    reason: "UI Automator key events target the default display",
    kind: "unsupported",
  },
  {
    operation: "perform_adb_ui_action",
    input: {
      ...scope,
      display_id: 0,
      snapshot_id: snapshotId,
      action: { kind: "key_event", key_code: 2147483647 },
    },
    reason: "Key code 2147483647 is unsupported by this Android version",
    kind: "unsupported_key_code",
  },
])(
  "classifies a definitive unsupported $operation reply through MCP",
  async ({ operation, input, reason, kind }) => {
    const { provider } = await fixture({
      unsupported_reason: reason,
      unsupported_kind: kind,
    });
    const harness = await createApplicationMcpHarness({
      serverOptions: { adbDeviceAnalysis: provider },
      configureServer: (server, session) => {
        if (operation === "perform_adb_ui_action")
          registerAdbUiExperiment(server, provider, session);
      },
    });
    onTestFinished(harness.close);
    const reply = await harness.client.callTool({
      name: operation,
      arguments: input,
    });
    const { error } = parseMcpToolError(reply);
    expect(error).toMatchObject({
      code: "capability_unavailable",
      category: "unsupported_provider",
      retryable: false,
      details: {
        provider_id: "adb",
        operation,
        reason,
        diagnostics: {
          selected_scope: { ...scope, display_id: input.display_id },
        },
      },
    });
    expect(error.remediation.action).not.toContain(
      "Inspect or find the current UI again",
    );
    if (kind === "unsupported_key_code") {
      expect(error.remediation.action).toContain("key_code");
      expect(error.remediation.action).toContain("Android version");
      expect(error.details).toMatchObject({
        diagnostics: { requested_key_code: 2147483647 },
      });
    }
  },
);

it.each([
  ["a completed action", {}, expect.anything],
  ["a refused action", { action_refusal: true }, expect.anything],
])(
  "attaches %s recovered by a later cleanup retry to the returned error",
  async (label, mode, _evidence) => {
    const state = await fixture({
      ...mode,
      status_offline: true,
      cancel_offline: true,
    });
    const result = await runLostStatusAction(state);
    // The action was submitted; the host lost the report before the runner
    // answered, so the retry owns the outcome the caller already received.
    expect(result.error.partialObservation).toBeUndefined();
    expect(result.error.cleanupIncomplete).toBe(true);
    await state.setMode({});
    await state.provider.close();
    expect(result.error.cleanupIncomplete).toBe(false);
    if (label === "a refused action") {
      expect(projectAnalysisError(result.error)).toMatchObject({
        details: {
          cleanup_history: { recovered_refusal: recoveredRefusal },
        },
      });
    } else
      expect(parseEvidence(result.error.partialObservation)).toMatchObject({
        evidence_id: expect.any(String),
        operation: "perform_adb_ui_action",
        authority: "controlled-replay",
        normalized_result: {
          serial: scope.serial,
          dispatch_attempted: true,
          action_completed: true,
        },
      });
  },
);

it("records a terminal observation recovered after the original response", async () => {
  const recorded: unknown[] = [];
  const state = await fixture(
    { status_offline: true, cancel_offline: true },
    (evidence) => recorded.push(evidence),
  );
  const result = await runLostStatusAction(state);
  expect(result.error.partialObservation).toBeUndefined();
  expect(recorded).toEqual([]);

  await state.setMode({});
  await state.provider.close();

  expect(recorded).toHaveLength(1);
  expect(parseEvidence(recorded[0])).toMatchObject({
    operation: "perform_adb_ui_action",
    authority: "controlled-replay",
    normalized_result: {
      serial: scope.serial,
      dispatch_attempted: true,
      action_completed: true,
    },
  });
});

it.each([
  {
    name: "runner",
    mode: { runner_override: { package_name: "dev.other.uiautomator" } },
  },
  { name: "after-snapshot", mode: { after_snapshot: { window_id_filter: 7 } } },
  {
    name: "snapshot selection",
    mode: { snapshot_override: { id: otherSnapshotId } },
  },
  {
    name: "element selection",
    mode: {
      observation_override: { selected_element: { ...node, id: "other" } },
    },
  },
])(
  "rejects mismatched $name evidence recovered by a later cleanup and guards replay",
  async ({ mode }) => {
    const recorded: unknown[] = [];
    const state = await fixture(
      { ...mode, status_offline: true, cancel_offline: true },
      (evidence) => recorded.push(evidence),
    );
    const first = await runLostStatusAction(state);
    expect(first.error.partialObservation).toBeUndefined();
    expect(first.error.cleanupIncomplete).toBe(true);
    await state.setMode({});
    const replay = await state.service.execute(
      "perform_adb_ui_action",
      actionInput,
    );
    if (replay.ok)
      throw new Error("Unverified action outcome must prevent replay");
    expect(projectAnalysisError(replay.error)).toMatchObject({
      code: "unreadable_output",
      details: {
        diagnostics: {
          prior_action_outcome: "unknown",
          current_request_dispatched: false,
        },
      },
    });
    expect(recorded).toEqual([]);
    expect(first.error.partialObservation).toBeUndefined();
    expect(replay.error.partialObservation).toBeUndefined();
    const calls = (await readFile(state.workspace.path("calls"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).operation);
    expect(
      calls.filter((operation) => operation === "perform_adb_ui_action"),
    ).toHaveLength(1);
  },
);

it("returns a recovered action before admitting a new UI action", async () => {
  const state = await fixture({ status_offline: true, cancel_offline: true });
  onTestFinished(async () => {
    await state.setMode({});
    await state.provider.close();
  });
  const first = await runLostStatusAction(state);
  expect(first.error.cleanupIncomplete).toBe(true);

  await state.setMode({});
  const second = await state.service.execute(
    "perform_adb_ui_action",
    actionInput,
  );
  if (second.ok)
    throw new Error("Expected recovered-outcome admission refusal");
  if (!(second.error instanceof AnalysisOutputError))
    throw new Error("Expected typed recovered-outcome refusal");
  expect(second.error.userMessage).toContain("may have completed");
  expect(second.error.remediationAction).toContain("recovered action Evidence");
  expect(second.error.diagnostics).toMatchObject({
    prior_request_id: expect.any(String),
    prior_action_outcome: "observed",
    current_request_dispatched: false,
  });
  expect(parseEvidence(second.error.partialObservation)).toMatchObject({
    operation: "perform_adb_ui_action",
    authority: "controlled-replay",
    normalized_result: {
      serial: scope.serial,
      dispatch_attempted: true,
      action_completed: true,
    },
  });
  const calls = (await readFile(state.workspace.path("calls"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(
    calls.filter((call) => call.operation === "perform_adb_ui_action"),
  ).toHaveLength(1);
});

it("retains a recovered action when the forget acknowledgement is lost", async () => {
  const state = await fixture({
    status_offline: true,
    forget_offline_once: true,
  });
  onTestFinished(async () => {
    await state.setMode({});
    await state.provider.close();
  });
  const first = await runLostStatusAction(state);
  expect(first.error.cleanupIncomplete).toBe(true);

  await state.setMode({});
  const retry = await state.service.execute(
    "perform_adb_ui_action",
    actionInput,
  );
  if (retry.ok) throw new Error("Expected recovered-outcome refusal");
  expect(retry.error.userMessage).toContain(
    "previous UI action may have completed",
  );
  expect(retry.error.diagnostics).toMatchObject({
    prior_action_outcome: "observed",
    current_request_dispatched: false,
  });
  expect(parseEvidence(retry.error.partialObservation)).toMatchObject({
    normalized_result: { dispatch_attempted: true, action_completed: true },
  });
  const calls = (await readFile(state.workspace.path("calls"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(
    calls.filter((call) => call.operation === "perform_adb_ui_action"),
  ).toHaveLength(1);
});

it("keeps recovered action warnings when cancellation follows successful reconciliation", async () => {
  let abortDuringRecovery: (() => void) | undefined;
  const state = await fixture(
    { status_offline: true, cancel_offline: true },
    () => abortDuringRecovery?.(),
  );
  onTestFinished(async () => {
    abortDuringRecovery = undefined;
    await state.setMode({});
    await state.provider.close();
  });
  const first = await runLostStatusAction(state);
  expect(first.error.cleanupIncomplete).toBe(true);

  await state.setMode({});
  const controller = new AbortController();
  const reason = new Error("cancel after retained UI completion");
  abortDuringRecovery = () => controller.abort(reason);
  const cancelled = await state.service.execute("inspect_adb_ui", scope, {
    signal: controller.signal,
  });
  if (cancelled.ok) throw new Error("Expected reconciliation cancellation");
  expect(cancelled.error._tag).toBe("AnalysisCancelledError");
  expect(cancelled.error.cause).toBe(reason);

  abortDuringRecovery = undefined;
  const retry = await state.service.execute(
    "perform_adb_ui_action",
    actionInput,
  );
  if (retry.ok) throw new Error("Expected recovered-outcome refusal");
  expect(retry.error.userMessage).toContain(
    "previous UI action may have completed",
  );
  const calls = (await readFile(state.workspace.path("calls"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(
    calls.filter((call) => call.operation === "perform_adb_ui_action"),
  ).toHaveLength(1);
});

it("reports cancellation when the UI action input process never launches", async () => {
  const { binary, environment, workspace } = await fixture();
  const controller = new AbortController();
  const reason = new Error("cancelled before private input launch");
  const transport = new AdbUiRunner(environment, async (input) => {
    if (input.stdin === "pipe") controller.abort(reason);
    return spawnOwnedProviderProcess(input);
  });
  onTestFinished(() => transport.close());
  const client = {
    binary_path: binary,
    path_source: "environment" as const,
    version: "34.0.5-ui-fixture",
    installed_path: binary,
  };
  const result = await transport.execute(
    {
      operation: "perform_adb_ui_action",
      input: adbUiInputSchemas.perform_adb_ui_action.parse(actionInput),
    },
    binary,
    client,
    { id: "adb", name: "ADB fixture", version: client.version },
    controller.signal,
  );
  if (result.ok) throw new Error("Expected cancellation before input launch");
  expect(result.error._tag).toBe("AnalysisCancelledError");
  expect(JSON.stringify(projectAnalysisError(result.error))).not.toContain(
    "may have completed",
  );
  expect(result.error.cleanupIncomplete).toBe(false);
  const calls = (await readFile(workspace.path("calls"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(calls.some((call) => call.operation === "perform_adb_ui_action")).toBe(
    false,
  );
  expect(calls.map((call) => call.operation)).toContain("cancel");
});

it("retains the runner request until late Evidence persistence succeeds", async () => {
  let attempts = 0;
  const state = await fixture(
    { status_offline: true, cancel_offline: true },
    () => {
      attempts += 1;
      if (attempts === 1) throw new Error("session record unavailable");
    },
  );
  const result = await runLostStatusAction(state);
  expect(result.error.cleanupIncomplete).toBe(true);
  await state.setMode({});

  await expect(state.provider.close()).rejects.toMatchObject({
    cleanupIncomplete: true,
  });
  expect(attempts).toBe(1);

  await expect(state.provider.close()).resolves.toBeUndefined();
  expect(attempts).toBe(2);
});

it("releases a request whose completion the runner could not transport", async () => {
  const { service, provider, workspace } = await fixture({
    status_offline: true,
    cancel_capacity: true,
  });
  const result = await service.execute("perform_adb_ui_action", actionInput);
  if (result.ok) throw new Error("Expected the offline status failure");
  // The runner settled the request but could not carry its completion. The
  // request must still be released, or its runner slot stays occupied.
  expect(result.error.cleanupIncomplete).toBe(false);
  const calls = (await readFile(workspace.path("calls"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(calls.map((call) => call.operation)).toContain("forget");
  expect(calls.filter((call) => call.operation === "forget")).toHaveLength(1);
  await provider.close();
});

it("requires a fresh UI observation before replaying an untransported action", async () => {
  const state = await fixture({ status_offline: true, cancel_capacity: true });
  onTestFinished(async () => {
    await state.setMode({});
    await state.provider.close();
  });
  const first = await state.service.execute(
    "perform_adb_ui_action",
    actionInput,
  );
  if (first.ok) throw new Error("Expected the lost status failure");
  expect(first.error.userMessage).toContain("may have completed");
  expect(first.error.diagnostics).toMatchObject({
    action_outcome: "unknown",
    replay_safe: false,
  });

  await state.setMode({});
  const otherTargetInspection = await state.service.execute("inspect_adb_ui", {
    ...scope,
    serial: "emulator-5556",
  });
  expect(otherTargetInspection.ok).toBe(true);
  const retry = await state.service.execute(
    "perform_adb_ui_action",
    actionInput,
  );
  if (retry.ok) throw new Error("Expected unresolved outcome refusal");
  if (!(retry.error instanceof AnalysisOutputError))
    throw new Error("Expected typed unresolved outcome refusal");
  expect(retry.error.userMessage).toContain("may have completed");
  expect(retry.error.remediationAction).toContain("inspect_adb_ui");
  expect(retry.error.diagnostics).toMatchObject({
    prior_action_outcome: "unknown",
    current_request_dispatched: false,
  });
  const afterRefusal = (await readFile(state.workspace.path("calls"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(
    afterRefusal.filter((call) => call.operation === "perform_adb_ui_action"),
  ).toHaveLength(1);

  const inspection = await state.service.execute("inspect_adb_ui", scope);
  expect(inspection.ok).toBe(true);
  const next = await state.service.execute(
    "perform_adb_ui_action",
    actionInput,
  );
  expect(next.ok).toBe(true);
  const afterInspection = (
    await readFile(state.workspace.path("calls"), "utf8")
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(
    afterInspection.filter(
      (call) => call.operation === "perform_adb_ui_action",
    ),
  ).toHaveLength(2);
});

it("clears the retained unknown outcome after a matching fresh inspection", async () => {
  const state = await fixture({ status_offline: true, cancel_capacity: true });
  onTestFinished(async () => {
    await state.setMode({});
    await state.provider.close();
  });
  const first = await state.service.execute(
    "perform_adb_ui_action",
    actionInput,
  );
  if (first.ok) throw new Error("Expected the lost status failure");
  expect(first.error.userMessage).toContain("may have completed");

  await state.setMode({});
  const inspection = await state.service.execute("inspect_adb_ui", scope);
  expect(inspection.ok).toBe(true);

  const next = await state.service.execute(
    "perform_adb_ui_action",
    actionInput,
  );
  expect(next.ok).toBe(true);
  const calls = (await readFile(state.workspace.path("calls"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(
    calls.filter((call) => call.operation === "perform_adb_ui_action"),
  ).toHaveLength(2);
});

it("retains a refusal recovered while cleaning up the interrupted request", async () => {
  const state = await fixture({
    action_refusal: true,
    status_offline: true,
  });
  const result = await runLostStatusAction(state);
  // Cleanup reached the runner and recovered its definitive refusal; that answer
  // belongs to the caller next to the transport failure that hid it.
  expect(result.error.partialObservation).toBeUndefined();
  expect(result.error.cleanupIncomplete).toBe(false);
  // The refusal is stated in the projected error the CLI and MCP return.
  expect(projectAnalysisError(result.error)).toMatchObject({
    details: { diagnostics: { recovered_refusal: recoveredRefusal } },
  });
  // The recovered request was released, so the next cleanup settles without work.
  await state.provider.close();
  expect(result.error.cleanupIncomplete).toBe(false);
});

it("keeps an unobserved submission owned until delayed delivery can be reconciled", async () => {
  const { service, provider, workspace, setMode } = await fixture({
    kind: "delayed",
  });
  const result = await service.execute("inspect_adb_ui", scope);
  if (result.ok) throw new Error("Expected uncertain delivery");
  expect(result.error.cleanupIncomplete).toBe(true);
  const calls = (await readFile(workspace.path("calls"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(calls.some((call) => call.operation === "forget")).toBe(false);
  const request = calls.find((call) => call.operation === "prepare");
  await rename(
    workspace.path(`delayed-${request.request_id}`),
    workspace.path(`job-${request.request_id}.json`),
  );
  await setMode({});
  await provider.close();
  expect(result.error.cleanupIncomplete).toBe(false);
});

it("settles a result-transport capacity refusal while preserving recovered facts", async () => {
  const { service } = await fixture({ status_capacity: true });
  const result = await service.execute("inspect_adb_ui", scope);
  if (result.ok) throw new Error("Expected transport capacity refusal");
  expect(result.error._tag).toBe("AnalysisResourceConstraintError");
  expect(result.error.cleanupIncomplete).toBe(false);
  expect(result.error.partialObservation).toMatchObject({
    evidence_id: expect.any(String),
    operation: "inspect_adb_ui",
    authority: "controlled-replay",
    normalized_result: { serial: scope.serial, snapshot: { id: snapshotId } },
  });
});

test("rejects malformed, duplicate and oversized terminal records before accepting UI data", () => {
  for (const value of [
    "",
    'Broadcast completed: result=0, data="REA_UI_V2:%%%%"',
    "Broadcast completed: result=0\nBroadcast completed: result=0",
    `Broadcast completed: result=0, data="REA_UI_V2:${"A".repeat(360000)}"`,
  ]) {
    expect(parseAdbUiReply(value).ok).toBe(false);
  }
});

it.each([
  [
    "win32",
    "adb",
    "C:\\platform-tools\\adb.EXE",
    "C:\\platform-tools\\adb.exe",
  ],
  ["win32", "C:\\tools\\adb.exe", "C:\\tools\\adb.exe", "C:\\tools\\adb.exe"],
  ["win32", "adb", "adb", "C:\\elsewhere\\adb.exe"],
  ["linux", "adb", "adb", "C:\\platform-tools\\adb.exe"],
] as const)(
  "launches %s UI traffic with the resolved executable for %s",
  async (platform, selected, expected, existing) => {
    const { environment } = await fixture();
    const launched: string[] = [];
    const transport = new AdbUiRunner(
      { ...environment, PATH: "C:\\platform-tools", PATHEXT: ".EXE" },
      async (input) => {
        launched.push(input.command);
        throw new Error("owned launch refused after observation");
      },
      platform,
      (path) => path.toLowerCase() === existing.toLowerCase(),
    );
    onTestFinished(() => transport.close());
    const result = await transport.execute(
      {
        operation: "inspect_adb_ui" as const,
        input: adbUiInputSchemas.inspect_adb_ui.parse(scope),
      },
      selected,
      {
        binary_path: selected,
        path_source: "path" as const,
        version: "34.0.5-ui-fixture",
        installed_path: null,
      },
      { id: "adb", name: "Android Debug Bridge", version: "34.0.5-ui-fixture" },
    );
    if (result.ok) throw new Error("Expected the observed launch refusal");
    expect(launched).toEqual([expected]);
    expect(transport.pendingResources).toEqual([]);
  },
);

it("delivers sensitive UI text through stdin without exposing the request in adb argv", async () => {
  const { service, workspace } = await fixture();
  const secret = "stdin-only 世界 'quoted' %s value";
  const result = await service.execute("perform_adb_ui_action", {
    ...scope,
    snapshot_id: snapshotId,
    element_id: "0",
    action: { kind: "set_text", text: secret, sensitive: true },
  });
  if (!result.ok) throw result.error;
  expect(result.value.parameters).toMatchObject({
    action: { text: "[redacted]" },
  });
  expect(
    JSON.parse(await readFile(workspace.path("received-input.json"), "utf8")),
  ).toMatchObject({ action: { text: secret } });
  const calls = (await readFile(workspace.path("calls"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const arguments_ = JSON.stringify(calls.map((call) => call.arguments));
  expect(arguments_).not.toContain(secret);
  expect(arguments_).not.toContain(Buffer.from(secret).toString("base64"));
  for (const call of calls.filter((call) => call.arguments[3] === "am")) {
    const metadata = JSON.parse(
      Buffer.from(call.arguments.at(-1), "base64").toString("utf8"),
    );
    expect(metadata).not.toHaveProperty("input");
  }
});
