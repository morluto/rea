import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execute = promisify(execFile);

it.each(["complete", "drop CLI", "drop MCP"])(
  "requires each native UI adapter's own action (%s)",
  async (mode) => {
    const directory = await mkdtemp(join(tmpdir(), "rea-ui-action-oracle-"));
    try {
      // Authored AX recordings qualify adapter action assertions, not macOS
      // permissions, native capture, Swift compilation or process ownership.
      await writeFile(
        join(directory, "recording.mjs"),
        `
import {EventEmitter} from 'node:events';import {writeFile} from 'node:fs/promises';import {promisify} from 'node:util';
let count=0;
const nodes=()=>[{role:'AXButton',path:[0],title:count===0?'Increment REA fixture':'REA fixture incremented '+count}];
const captured=()=>({steps:[{outcome:'completed'},{outcome:'completed',after:{nodes:nodes()}}]});
export const execFile=Object.assign(()=>{}, {[promisify.custom]:async (file,args)=>{
 if(args?.includes('capture-native-ui-scenario')){if(process.env.MODE!=='drop CLI')count++;return {stdout:JSON.stringify({normalized_result:captured()})};}
 return {stdout:'{"v":"slash/producer"}\\n{"v":1.0}\\n'};
}});
export const spawn=(_command,args)=>{const child=new EventEmitter();child.exitCode=null;child.signalCode=null;globalThis.reaOpenChild=child;child.kill=()=>{child.exitCode=0;child.emit('exit',0);return true;};void writeFile(args[args.indexOf('--stdout')+1],JSON.stringify({pid:424242,window_id:7})+'\\n');return child;};
export const parseBinaryTarget=async path=>({ok:true,value:{path,sha256:'a'.repeat(64)}});
export const observeProcessStartIdentity=async()=>({state:'readable',identity:'authored-process-identity'});
export const observeNativeUi=async(target,operation)=>{
 if(target.sha256==='0'.repeat(64))return {ok:false,error:{issues:[{message:'target-mismatch: authored changed digest'}]}};
 if(operation==='capture_native_ui_scenario'){count++;return {ok:true,value:captured()};}
 return {ok:true,value:{initial:{nodes:nodes()}}};
};
export const withArtifactMcp=async(_path,run)=>run({});
export const artifactMcpResult=async(_client,name)=>{if(name==='observe_native_ui')return {initial:{nodes:nodes()}};if(process.env.MODE!=='drop MCP')count++;return captured();};
`,
      );
      await writeFile(
        join(directory, "hook.mjs"),
        `
import {registerHooks} from 'node:module';import {pathToFileURL} from 'node:url';
Object.defineProperty(process,'platform',{value:'darwin'});process.kill=()=>{const open=globalThis.reaOpenChild;if(open?.exitCode===null){open.exitCode=0;queueMicrotask(()=>open.emit('exit',0,null));}return true;};
registerHooks({resolve(specifier,context,next){if(context.parentURL?.endsWith('/scripts/verify-native-ui.mjs')&&['node:child_process','../dist/application/BinaryTargetResolver.js','../dist/native/NativeUiObservation.js','./lib/artifact-e2e.mjs','../dist/process/ProcessOwnershipObservation.js'].includes(specifier))return {shortCircuit:true,url:pathToFileURL(process.env.RECORDING).href};return next(specifier,context);}});
`,
      );
      const result = execute(
        process.execPath,
        [
          "--import",
          join(directory, "hook.mjs"),
          fileURLToPath(
            new URL("../../../scripts/verify-native-ui.mjs", import.meta.url),
          ),
        ],
        {
          timeout: 10_000,
          env: {
            ...process.env,
            TMPDIR: directory,
            TMP: directory,
            TEMP: directory,
            RECORDING: join(directory, "recording.mjs"),
            MODE: mode,
          },
        },
      );
      if (mode === "complete") {
        expect(JSON.parse((await result).stdout)).toMatchObject({
          ok: true,
          positive_e2e: true,
          scenario: "selected-AX-button-action-and-CLI-MCP-parity-observed",
        });
      } else {
        await expect(result).rejects.toMatchObject({
          stderr: expect.stringContaining(
            mode === "drop CLI"
              ? "Native UI CLI did not preserve the selected scenario"
              : "MCP did not observe the selected fixture's AX action",
          ),
        });
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
