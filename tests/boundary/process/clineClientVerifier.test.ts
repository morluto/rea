import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it.each(["success", "wrong-server", "cleanup-failure"] as const)(
  "owns Cline verifier orchestration through %s",
  async (mode) => {
    const state = await createTestTempDirectory("rea-cline-verifier-");
    const fixture = join(state, "owners.mjs");
    const hook = join(state, "hook.mjs");
    await writeFile(
      fixture,
      `import assert from 'node:assert/strict';
import {appendFile, mkdir, stat, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
const event = async (value) => appendFile(process.env.STATE+'/events',value+'\\n');
export async function createVerifierCommands(){
 const owners=[];
 return {
  adopt(owner){owners.push(owner);},
  async exec(command,args,options={}){
   const env=options.env;
   assert(env,'commands must receive isolated environment');
   assert.equal((await stat(env.HOME)).isDirectory(),true,'HOME must exist before any command');
   assert.equal(env.USERPROFILE,env.HOME);
   for(const key of ['CLINE_MCP_SETTINGS_PATH','CLINE_DATA_DIR','CLINE_DIR']) assert.equal(env[key],undefined,key+' must be absent');
   if(args.includes('--version')){await event('version');return {stdout:'recorded Cline 1',stderr:''};}
   if(args.includes('setup')){
    assert(args.includes('cline'));assert.equal(options.cwd,env.HOME);
    const path=join(env.HOME,'.cline','data','settings');await mkdir(path,{recursive:true});
    await writeFile(join(path,'cline_mcp_settings.json'),JSON.stringify({mcpServers:{rea:{command:'recorded-server',args:['mcp'],env:{RECORDED:'yes'}}}}));
    await event('setup');return {stdout:'{}',stderr:''};
   }
   assert.deepEqual(args,['--data-dir',join(env.HOME,'.cline','data'),'config','mcp']);
   await event('client-list');return {stdout:'rea [stdio]',stderr:''};
  },
  async close(){await event('commands-close-start');for(const owner of owners)await owner.close();await event('commands-close-done');}
 };
}
export async function createOwnedMcpStdioTransport(options){
 assert.equal(options.command,'recorded-server');assert.deepEqual(options.arguments,['mcp']);
 assert.equal(options.hostEnvironment.RECORDED,'yes');
 let closing;
 return {
  async start(){await event('transport-start');},
  async send(message){
   if(message.method==='notifications/initialized'){await event('initialized');return;}
   if(message.method==='initialize'||message.method==='tools/list'){
    await event(message.method+'-request');
    setTimeout(async()=>{
     await event(message.method+'-reply');
     this.onmessage?.({jsonrpc:'2.0',id:message.id,result:message.method==='initialize'?{protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:process.env.MODE==='wrong-server'?'other':'rea',version:'1'}}:{tools:[{name:'recorded_tool',inputSchema:{type:'object'}}]}});
    },15);
   }
  },
  close(){return closing??= (async()=>{
   await event('transport-close-start');await new Promise(resolve=>setTimeout(resolve,15));
   if(process.env.MODE==='cleanup-failure'){await event('transport-close-failed');throw Error('recorded transport cleanup failure');}
   await event('transport-close-done');this.onclose?.();
  })();}
 };
}
export function createVerifierRun(){return {run_id:'recorded-run'};}
export async function completeVerifierRun(run){await event('lineage');return {...run,process_lineage:{status:'recorded',descendants:[]}};}
export function execFile(){throw Error('unowned child_process execution is forbidden in this orchestration fixture');}
export function spawn(){throw Error('unowned child_process execution is forbidden in this orchestration fixture');}
`,
    );
    await writeFile(
      hook,
      `import {registerHooks} from 'node:module';import{pathToFileURL}from'node:url';
registerHooks({resolve(specifier,context,next){
 if(context.parentURL?.endsWith('/scripts/verify-cline-client.mjs')&&['./lib/verify-commands.mjs','./lib/owned-mcp-stdio.mjs','./lib/verifier-run.mjs','node:child_process'].includes(specifier))return{url:pathToFileURL(process.env.STATE+'/owners.mjs').href,shortCircuit:true};
 return next(specifier,context);
}});
`,
    );
    const script = fileURLToPath(
      new URL("../../../scripts/verify-cline-client.mjs", import.meta.url),
    );
    const result = spawnSync(process.execPath, ["--import", hook, script], {
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        STATE: state,
        MODE: mode,
        REA_VERIFY_CLINE_COMMAND: "recorded-cline",
        CLINE_MCP_SETTINGS_PATH: join(state, "outside-settings.json"),
        CLINE_DATA_DIR: join(state, "outside-data"),
        CLINE_DIR: join(state, "outside-root"),
        TMPDIR: state,
        TMP: state,
        TEMP: state,
      },
    });
    const events = await readFile(join(state, "events"), "utf8").catch(
      () => "",
    );
    expect(result.error).toBeUndefined();
    expect(events, result.stderr + result.stdout).toContain(
      "version\nsetup\nclient-list\n",
    );
    expect(events).toContain("initialize-reply\n");
    expect(events).toContain("tools/list-reply\n");
    expect(events).toContain("commands-close-start\n");
    expect(events.indexOf("tools/list-reply\n")).toBeLessThan(
      events.indexOf("transport-close-start\n"),
    );
    if (mode === "cleanup-failure") {
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("recorded transport cleanup failure");
      expect(events).toContain("transport-close-failed\n");
      expect(events).not.toContain("lineage\n");
      expect(result.stdout).not.toContain('"status": "verified"');
    } else {
      expect(events).toContain("transport-close-done\n");
      expect(events).toContain("commands-close-done\n");
      if (mode === "wrong-server") {
        expect(result.status).not.toBe(0);
        expect(result.stderr).toMatch(/initialize|identify|server|rea/u);
        expect(result.stdout).not.toContain('"status": "verified"');
      } else {
        expect(result.status, result.stderr).toBe(0);
        const report = JSON.parse(result.stdout) as {
          status: string;
          tool_count: number;
        };
        expect(report.status).toBe("verified");
        expect(report.tool_count).toBe(1);
        expect(events.indexOf("transport-close-done\n")).toBeLessThan(
          events.indexOf("lineage\n"),
        );
        expect(events.indexOf("commands-close-done\n")).toBeLessThan(
          events.indexOf("lineage\n"),
        );
      }
    }
  },
);
