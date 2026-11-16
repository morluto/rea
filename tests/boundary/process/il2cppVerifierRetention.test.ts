import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execute = promisify(execFile);

it.each([
  ["methods", true],
  ["methods", false],
  ["images", true],
  ["images", false],
  ["sections", true],
  ["sections", false],
  ["empty", true],
  ["empty", false],
] as const)(
  "requires overflow Evidence before reanalysis (%s, retained=%s)",
  async (collection, retained) => {
    const directory = await mkdtemp(
      join(tmpdir(), "rea-il2cpp-retention-oracle-"),
    );
    try {
      // This recording qualifies the verifier's ordering oracle, not metadata
      // decoding or transport conformance. A later analysis repairs retention.
      await writeFile(
        join(directory, "recording.mjs"),
        `
import {promisify} from 'node:util';
const path=process.env.INPUT;
const identity={sha256:'a'.repeat(64),bytes:1};
const report={artifact:{path,...identity},magic:0xfab11baf,sections:[],images:[{type_count:1}],types:[{declaring_type:-1,method_start:0,method_count:1}],methods:[{declaring_type:0,name:'AuthoredMethod'}],fields:[],properties:[],events:[],parameters:[],string_literals:[]};
if(process.env.COLLECTION!=='methods'){report.methods=[];report.types[0].method_count=0;}
if(['sections','empty'].includes(process.env.COLLECTION)){report.images=[];report.types=[];}
if(process.env.COLLECTION==='sections')report.sections=[{name:'authored-nonmethod-table',offset:64,size:4096}];
const counts={sections:report.sections.length,images:report.images.length,types:report.types.length,methods:report.methods.length,nested_types:0,fields:0,properties:0,events:0,parameters:0,string_literals:0,...Object.fromEntries(['code_gen_modules','method_addresses','method_address_states','return_types','field_types','parameter_types','generic_method_instances','generic_method_instance_states','generic_method_issues'].map(k=>[k,null]))};
let reanalyzed=false;
export class Client {
 async connect(){} async close(){} async listTools(){return {tools:[{name:'inspect_il2cpp_metadata'}]};}
 async callTool({name,arguments:input}){
  if(name==='inspect_il2cpp_metadata'&&input.detail==='complete')return {isError:true,error:{code:'resource_constraint',details:{reported_limits:{boundary:'mcp-response',evidence_id:'ev_authored_parent',response_bytes_at_least:999}}}};
  if(name==='inspect_il2cpp_metadata'){reanalyzed=true;return {structuredContent:{normalized_result:{summary:{magic:report.magic,counts},parent_evidence_id:'ev_authored_parent'}}};}
  if(!reanalyzed&&process.env.RETAINED==='false')throw Error('Failed delivery Evidence was not retained before reanalysis');
  if(input.source.evidence_id!=='ev_authored_parent')throw Error('Wrong parent Evidence');
  const rows=report[input.view.collection],offset=input.view.offset??0;
  return {structuredContent:{normalized_result:{items:rows.slice(offset,offset+(input.view.limit??16)).map((row,index)=>({...row,index:offset+index})),coverage:{next_offset:null}}}};
 }
}
export class StdioClientTransport {async close(){} }
export const execFile=Object.assign(()=>{}, {[promisify.custom]:async()=>({stdout:JSON.stringify({normalized_result:report})})});
export const toolContract=()=>({outputSchema:{parse:value=>value}});
export const requireMcpOutput=response=>{if(response.isError)throw Error('Unexpected failed tool');return response.structuredContent;};
export const requireMcpToolError=response=>response.error;
export const hashVerifierFile=async()=>identity;
`,
      );
      await writeFile(
        join(directory, "hook.mjs"),
        `
import {registerHooks} from 'node:module';import {pathToFileURL} from 'node:url';
registerHooks({resolve(specifier,context,next){
 if(context.parentURL?.endsWith('/scripts/verify-il2cpp-metadata.mjs')&&['node:child_process','@modelcontextprotocol/client','@modelcontextprotocol/client/stdio','../dist/contracts/toolContracts.js','./lib/mcp-verifier-results.mjs','./lib/verifier-file-resources.mjs'].includes(specifier))return {shortCircuit:true,url:pathToFileURL(process.env.RECORDING).href};
 return next(specifier,context);
}});
`,
      );
      const result = execute(
        process.execPath,
        [
          "--import",
          join(directory, "hook.mjs"),
          fileURLToPath(
            new URL(
              "../../../scripts/verify-il2cpp-metadata.mjs",
              import.meta.url,
            ),
          ),
          "--metadata",
          join(directory, "metadata.dat"),
        ],
        {
          timeout: 10_000,
          env: {
            ...process.env,
            RECORDING: join(directory, "recording.mjs"),
            INPUT: join(directory, "metadata.dat"),
            RETAINED: String(retained),
            COLLECTION: collection,
          },
        },
      );
      if (retained) {
        const { stdout } = await result;
        expect(stdout).toContain(
          "All asserted IL2CPP metadata CLI/MCP checks passed",
        );
        expect(
          stdout.includes(
            "empty queryable tables provide no nonempty row-content witness",
          ),
        ).toBe(collection === "empty");
      } else {
        await expect(result).rejects.toMatchObject({
          stderr: expect.stringContaining(
            "Failed delivery Evidence was not retained before reanalysis",
          ),
        });
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
