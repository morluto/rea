import { registerHooks } from "node:module";
const model = `
const identity={sha256:'a'.repeat(64),bytes:1};
export function result(operation,input) {
 const path=input.path;const target={path,...identity};
 if(operation==='identify_flutter_build') return {target,flutter_detected:true,coverage:'complete',abis:[{abi:'x86_64',libapp:{present:true,elf_header_valid:true,snapshot_hash_sources:2,snapshot_hash:'hash',sha256:'b'.repeat(64),bytes:100},libflutter:{present:true,build_id:'12345678',build_id_candidates:['12345678']}}]};
 const abi=input.abi ?? (process.env.REA_FLUTTER_PROBE === 'wrong' ? 'ghost' : 'x86_64');
 return {target,abi,coverage:'complete',libapp:{coverage:'complete',sha256:'b'.repeat(64),bytes:100,snapshot_hash_sources:2,snapshot_hash:'hash',sections:['_kDartVmSnapshotData','_kDartVmSnapshotInstructions','_kDartIsolateSnapshotData','_kDartIsolateSnapshotInstructions'].map(name=>({name,offset:0,size:64,magic_valid:true,kind:3,header_length:48}))},string_pool:{coverage:'complete',package_uri_count_at_least:1,dart_uri_count_at_least:1}};
}
export function envelope(op,input){const resultValue=result(op,input);return {normalized_result:resultValue,subject:{local_path:input.path,digest:{sha256:identity.sha256}},limitations:[]};}
`;
const modelUrl = "data:text/javascript," + encodeURIComponent(model);
const mocks = {
  "node:child_process": `import {promisify} from 'node:util';import {envelope} from ${JSON.stringify(modelUrl)};export const execFile=Object.assign(()=>{}, {[promisify.custom]:async (_cmd,args)=>{const op=args[1].replaceAll('-','_');const index=args.indexOf('--abi');const input={path:args[2],...(index<0?{}:{abi:args[index+1]})};return {stdout:JSON.stringify(envelope(op,input)),stderr:''};}});`,
  "@modelcontextprotocol/client": `import {envelope} from ${JSON.stringify(modelUrl)};export class Client {async connect(){} async close(){} async callTool({name,arguments:input}){return {structuredContent:envelope(name,input)}}}`,
  "@modelcontextprotocol/client/stdio": `export class StdioClientTransport {async close(){}}`,
  "../dist/contracts/toolContracts.js": `export const toolContract=()=>({outputSchema:{parse:value=>value}});`,
  "../dist/artifacts/ArtifactResourceScope.js": `export class ArtifactResourceScope {async close(){}}`,
  "./lib/mcp-verifier-results.mjs": `export const requireMcpOutput=response=>response.structuredContent;`,
  "./lib/verifier-file-resources.mjs": `export const hashVerifierFile=async()=>({sha256:'a'.repeat(64),bytes:1});`,
};
registerHooks({
  resolve(specifier, context, next) {
    if (
      context.parentURL?.endsWith("/scripts/verify-flutter.mjs") &&
      Object.hasOwn(mocks, specifier)
    )
      return {
        shortCircuit: true,
        url: "data:text/javascript," + encodeURIComponent(mocks[specifier]),
      };
    return next(specifier, context);
  },
});
