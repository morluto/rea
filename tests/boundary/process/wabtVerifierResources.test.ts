import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { processTest } from "../../support/process/processFixture.js";

const scenarios = [
  "client-close",
  "transport-close",
  "both-close",
  "client-constructor",
  "transport-constructor",
  "temp-constructor",
  "temp-constructor-root-close",
  "spawn-failure",
  "late-exit",
  "root-close",
  "temp-remove",
  "residue",
  "real-server",
] as const;

const fixtureModules = (privateRoot: string, actualSdk: string) => {
  const clientSource = `
  export class Client {
    constructor() { if (state.mode === 'client-constructor') throw new Error('authored client constructor'); }
    async connect(transport) {
      this.transport = transport;
      await transport.start();
      if (state.mode === 'residue') await state.fs.mkdir(state.path.join(state.childTemp, 'rea-wabt-retained'));
      throw state.primary;
    }
    async close() {
      state.events.push('client-close');
      if (!state.retry && ['client-close','both-close'].includes(state.mode)) throw state.clientFailure;
      await this.transport?.close();
    }
  }
  const state = globalThis.wabtOwnerProbe;
`;
  const transportSource = `
  import { StdioClientTransport as Actual } from ${JSON.stringify(actualSdk)};
  const state = globalThis.wabtOwnerProbe;
  export class StdioClientTransport extends Actual {
    constructor(params) {
      if (state.mode === 'transport-constructor') throw new Error('authored transport constructor');
      super({ ...params, command: state.mode === 'spawn-failure' ? state.path.join(state.workspace,'missing-executable') : params.command,
        args: state.mode === 'real-server' ? params.args : [state.child] });
      state.childTemp = params.env.TEMP;
    }
    async start() {
      const starting = super.start();
      const child = this._process;
      state.childProcess = child;
      child?.once('close', () => state.events.push('child-close'));
      if (child && state.mode === 'late-exit') {
        const actualKill = child.kill.bind(child);
        let pending = false;
        child.kill = (signal) => {
          if (signal === 'SIGKILL' && !pending) {
            pending = true;
            state.events.push('kill-request');
            setTimeout(() => actualKill('SIGKILL'),400);
          }
          return true;
        };
      }
      return starting;
    }
    async close() {
      state.events.push('transport-close');
      if (!state.retry && ['transport-close','both-close'].includes(state.mode)) throw state.transportFailure;
      return super.close();
    }
  }
`;
  const rootSource = `
  import { PrivateRuntimeRoot as Actual } from ${JSON.stringify(`${privateRoot}?actual`)};
  const state = globalThis.wabtOwnerProbe;
  export const PrivateRuntimeRoot = { async create(options) {
    const root = await Actual.create(options);
    state.input = root.path;
    const actualClose = root.close.bind(root);
    state.releaseInput = actualClose;
    root.close = async () => {
      state.events.push('root-close');
      const child = state.childProcess;
      if (child && child.exitCode === null && child.signalCode === null) state.releasedWhileLive = true;
          if (!state.retry && ['root-close','temp-constructor-root-close'].includes(state.mode)) throw new Error('authored input root close');
      await actualClose();
    };
    return root;
  }};
`;
  return { clientSource, transportSource, rootSource };
};

processTest.for(scenarios)(
  "WABT verifier keeps dependent roots through %s",
  async (scenario, { processes }) => {
    const workspace = await createTestTempDirectory("rea-wabt-owner-test-");
    const temporary = join(workspace, "temporary");
    await mkdir(temporary);
    const report = join(workspace, "report.json");
    const loader = join(workspace, "probe.mjs");
    const privateRoot = pathToFileURL(
      resolve("dist/process/PrivateRuntimeRoot.js"),
    ).href;
    const entry = pathToFileURL(
      resolve("scripts/verify-wasm-artifact.mjs"),
    ).href;
    const actualSdk = pathToFileURL(
      resolve("node_modules/@modelcontextprotocol/client/dist/stdio.mjs"),
    ).href;
    const child = join(workspace, "child.mjs");
    await writeFile(
      child,
      "process.stdin.resume(); setInterval(() => {}, 1000);\n",
    );
    const { clientSource, transportSource, rootSource } = fixtureModules(
      privateRoot,
      actualSdk,
    );
    await writeFile(
      loader,
      `import assert from 'node:assert/strict';
       import { registerHooks, syncBuiltinESMExports } from 'node:module';
       import childProcess from 'node:child_process';
       import fs from 'node:fs/promises';
       import * as path from 'node:path';
       import { inspect, promisify } from 'node:util';
       const state = globalThis.wabtOwnerProbe = {mode:${JSON.stringify(scenario)},workspace:${JSON.stringify(workspace)},child:${JSON.stringify(child)},fs,path,events:[],retry:false,releasedWhileLive:false,
         primary:new Error('authored handshake refusal'),clientFailure:new Error('authored client close'),transportFailure:new Error('authored transport close')};
       const execute = (...args) => args.at(-1)(null,'1.0.42\\n','');
       execute[promisify.custom] = async () => ({stdout:'1.0.42\\n',stderr:''});
       childProcess.execFile=execute;
       const actualMkdtemp=fs.mkdtemp;
       fs.mkdtemp=async (prefix,...args) => {
         if(String(prefix).includes('rea-wabt-child-temp-') && state.mode.startsWith('temp-constructor')) throw state.primary;
         return actualMkdtemp(prefix,...args);
       };
       const actualRm=fs.rm;
       fs.rm=async (target,options) => {
         if(target===state.childTemp){
           state.events.push('temp-remove');
           if(!state.retry && state.mode==='temp-remove') throw new Error('authored provider temp removal');
         }
         return actualRm(target,options);
       };
       syncBuiltinESMExports();
       registerHooks({resolve(specifier,context,next){
         if(specifier==='@modelcontextprotocol/client' && state.mode!=='real-server') return {url:'wabt-probe:client',shortCircuit:true};
         if(specifier==='@modelcontextprotocol/client/stdio') return {url:'wabt-probe:transport',shortCircuit:true};
         return next(specifier,context);
       },load(url,context,next){
         const source = url==='wabt-probe:client' ? ${JSON.stringify(clientSource)} :
           url==='wabt-probe:transport' ? ${JSON.stringify(transportSource)} :
           url===${JSON.stringify(privateRoot)} ? ${JSON.stringify(rootSource)} : undefined;
         return source===undefined ? next(url,context) : {format:'module',source,shortCircuit:true};
       }});
       let failure;
       try {
         try {await import(${JSON.stringify(entry)});} catch(cause){failure=cause;}
         const failures=failure instanceof AggregateError ? failure.errors : [failure];
         const cleanup=failures.find(error=>error?.name==='WabtVerifierCleanupFailure');
         const remaining=await fs.readdir(process.env.TEMP);
         const retained=['client-close','transport-close','both-close','root-close','temp-remove','residue','temp-constructor-root-close'].includes(state.mode);
         assert.ok(failure,'the authored primary or fixture work must fail');
         assert.equal(state.releasedWhileLive,false,'input released while the exact SDK child was live');
         if(!['client-constructor','transport-constructor','spawn-failure','real-server'].includes(state.mode))
           assert.equal(failures[0],state.primary,'preserve exact primary object');
         if(retained){
           assert.ok(cleanup,'cleanup error must retain the same composite owner');
           assert.ok(!inspect(failure,{depth:8}).includes('authored-ambient-sentinel'),'retry capability must not dump the inherited child environment');
           if(['client-close','transport-close','both-close','residue'].includes(state.mode)){
             assert.ok(remaining.some(x=>x.startsWith('rea-wabt-verifier-')),'input root retained');
             assert.ok(remaining.some(x=>x.startsWith('rea-wabt-child-temp-')),'provider temp root retained');
             assert.ok(!state.events.includes('root-close'));
             assert.ok(!state.events.includes('temp-remove'));
           }
           if(['client-close','both-close'].includes(state.mode)) assert.ok(cleanup.cause.errors.includes(state.clientFailure),'client failure identity');
           if(['transport-close','both-close'].includes(state.mode)) assert.ok(cleanup.cause.errors.some(e=>e===state.transportFailure||e?.errors?.includes(state.transportFailure)),'transport failure identity');
           const retainedRoots=[
             ...(state.mode==='temp-remove'?[]:[state.input]),
             ...(state.mode==='root-close'||state.childTemp===undefined?[]:[state.childTemp]),
           ];
           assert.deepEqual(cleanup.retainedRoots,retainedRoots,'report only roots still owned');
           for(const root of retainedRoots) assert.ok(cleanup.message.includes(root));
           state.retry=true;
           if(state.mode==='residue') await actualRm(path.join(state.childTemp,'rea-wabt-retained'),{recursive:true,force:true});
           await cleanup.cleanupOwner.close();
           const after=state.events.length;
           await cleanup.cleanupOwner.close();
           assert.equal(state.events.length,after,'completed close is idempotent');
           assert.deepEqual(await fs.readdir(process.env.TEMP),[],'retry releases retained roots');
         } else assert.deepEqual(remaining,[],'completed owners release both roots');
         if(state.mode==='late-exit'){
           assert.ok(state.events.indexOf('kill-request')>=0);
           assert.ok(state.events.indexOf('root-close')>state.events.indexOf('child-close'),'wait for physical SDK child close');
         }
         if(state.mode==='root-close') assert.equal(state.events.filter(x=>x==='temp-remove').length,1,'do not remove released temp twice');
         if(state.mode==='temp-remove') assert.equal(state.events.filter(x=>x==='root-close').length,1,'do not close released input twice');
         await fs.writeFile(${JSON.stringify(report)},JSON.stringify({scenario:state.mode,events:state.events,retained,retried:retained,passed:true}));
       } finally {
         state.retry=true;
         const child=state.childProcess;
         if(child && child.exitCode===null && child.signalCode===null){
           // This is the exact retained ChildProcess, never a PID lookup.
           const closed=new Promise(resolve=>child.once('close',resolve));
           child.kill('SIGKILL');
           await closed;
         }
         // All fake/real SDK users are now settled before fixture deletion.
         if(state.releaseInput) await state.releaseInput();
         if(state.childTemp) await actualRm(state.childTemp,{recursive:true,force:true});
       }
      `,
    );
    const result = await processes.run(process.execPath, [loader], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        TEMP: temporary,
        TMP: temporary,
        TMPDIR: temporary,
        REA_WABT_BIN_DIRECTORY: workspace,
        REA_WABT_OWNER_TEST_SENTINEL: "authored-ambient-sentinel",
      },
      timeoutMs: 25_000,
    });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.signal, result.stderr).toBeNull();
    expect(JSON.parse(await readFile(report, "utf8"))).toMatchObject({
      scenario,
      passed: true,
    });
  },
);
