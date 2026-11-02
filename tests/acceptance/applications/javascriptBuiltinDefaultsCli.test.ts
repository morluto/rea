import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { expect, it } from "vitest";

import { parseEvidence } from "../../../src/domain/evidence.js";
import { javascriptApplicationAnalysisResultSchema } from "../../../src/domain/javascript/javascriptApplicationAnalysis.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";

const execute = promisify(execFile);

const opaqueMutatorSources = {
  "opaque-receiver.cjs": `let receiver={};eval('receiver=module');
    Reflect.set(module,'require',replacement,receiver);
    require('fs').readFileSync('wrong-opaque-receiver');`,
  "opaque-key.cjs": `let key='x';eval('key="require"');
    Reflect.set(module,key,replacement);
    require('fs').readFileSync('wrong-opaque-key');`,
  "opaque-saved-receiver.cjs": `let receiver={};const saved=receiver;eval('receiver=module');
    Reflect.set(module,'require',replacement,saved);
    require('fs').readFileSync('opaque-saved-receiver.json');`,
  "opaque-saved-key.cjs": `let key='x';const saved=key;eval('key="require"');
    Reflect.set(module,saved,replacement);
    require('fs').readFileSync('opaque-saved-key.json');`,
  "await-module.cjs": `async function run(){
    Object.assign=(t,v)=>{v.require=replacement};Object.assign({},await module);
    require('fs').readFileSync('wrong-awaited-module');}run();`,
  "yield-module.cjs": `function* run(){
    Object.assign=(t,v)=>{v.require=replacement};Object.assign({},yield 1);
    require('fs').readFileSync('wrong-resumed-module');}
    const iterator=run();iterator.next();iterator.next(module);`,
  "await-primitive.cjs": `async function run(){
    Object.assign=(t,v)=>{v.require=replacement};Object.assign({},await 1);
    require('fs').readFileSync('suspended-primitive.json');}run();`,
  "scalar-argument.cjs": `Object.assign=(t,key)=>{t[key]=1};
    Object.assign({},module===module);Object.assign({},typeof module);
    require('fs').readFileSync('scalar-argument.json');`,
  "scalar-evaluation.cjs": `function change(value){value.require=replacement;return 0}
    Object.assign=(t,key)=>{t[key]=1};Object.assign({},typeof change(module));
    require('fs').readFileSync('wrong-scalar-evaluation');`,
  "inherited-then.cjs": `Object.prototype.then=function(resolve){
    delete Object.prototype.then;resolve(module)};
    async function run(){Object.assign=(t,v)=>{v.require=replacement};
    Object.assign({},await {});require('fs').readFileSync('wrong-inherited-then');}run();`,
  "own-then.cjs": `Object.prototype.then=function(resolve){
    delete Object.prototype.then;resolve(module)};
    async function run(){Object.assign=(t,v)=>{v.require=replacement};
    Object.assign({},await {then:null});require('fs').readFileSync('own-then.json');}run();`,
};

const writeReceiverReviewSources = async (root: string): Promise<void> => {
  const sources = [
    "const table={};function change(v){v.require=replacement;return 'x'}Object.assign=(t,key)=>{t[key]=1};Object.assign({},typeof table[table[change(module)]]);require('fs').readFileSync('wrong-computed-key');",
    "const box={owner:{}};eval('box.owner=module');Object.assign=(t,v)=>{v.require=replacement};Object.assign({},box.owner);require('fs').readFileSync('wrong-opaque-object-property');",
    "function custom(){};let target={hook:0};eval('target={set hook(v){this.fs.readFileSync=custom}}');const fs=require('fs'),receiver={fs};Reflect.set(target,'hook',1,receiver);fs.readFileSync('wrong-opaque-target-descriptor');",
    "const descriptor={value:Reflect.set.bind(null,{})};const define=Object.defineProperty.bind(null,Reflect,'set',descriptor);descriptor.value=Reflect.set.bind(null,module);define();Reflect.set('require',replacement);require('fs').readFileSync('wrong-bound-descriptor-field');",
    "const owner=module;let value={owner,valueOf(){this.owner.require=replacement;return 1}};Object.assign=(t,key)=>{t[key]=1};Object.assign({},typeof value++);require('fs').readFileSync('wrong-update-coercion');",
    "import * as ns from 'node:path';import fs from 'node:fs';const receiver={};Reflect.set(ns,'saved',fs,receiver);receiver.saved.readFileSync=custom;fs.readFileSync('wrong-namespace-stored-value');",
    "let fs=require('fs');const define=Object.defineProperty.bind(null,fs,'readFileSync');fs={};define({value:custom});require('fs').readFileSync('wrong-bound-descriptor-target');",
    "function patch(){Reflect.set=(target,key,value)=>target[key]=value;}patch();const fs=require('fs');Reflect.set(fs,'readFileSync',custom,{});fs.readFileSync('wrong-helper-intrinsic-write');",
    "function Box(){this.owner=module;return 1;}Object.assign=(t,v)=>{v.owner.require=replacement};Object.assign({},new Box());require('fs').readFileSync('wrong-primitive-constructor-return');",
    "const getter={get:()=>({})};getter.get=()=>module;const box={};box.owner=getter.get();Object.assign=(t,v)=>{v.require=replacement};Object.assign({},box.owner);require('fs').readFileSync('wrong-replaced-getter');",
    "class Box{owner=module}Object.assign=(t,v)=>{v.owner.require=replacement};Object.assign({},new Box());require('fs').readFileSync('wrong-constructor-module-field');",
    "const get=Object.prototype.valueOf.bind(module);Object.assign=(t,f)=>{f().require=replacement};Object.assign({},get);require('fs').readFileSync('wrong-bound-this');",
    "const fs=require('fs');Reflect.set=(Reflect.set(fs,'readFileSync',custom,{}),other);fs.readFileSync('nested-write-kept.json');",
    "Reflect.set(module,'require',replacement,(0,{}));require('fs').readFileSync('fresh-sequence-receiver.json');",
    "const fs=require('fs');Reflect.set(fs,'reviewHook',1,{fs});fs.readFileSync('late-prototype-kept.json');Object.defineProperty(Object.prototype,'reviewHook',{set(v){this.fs.readFileSync=custom}});",
    "function get(){return module}Object.assign=(t,v)=>{v.require=replacement};Object.assign({},get());require('fs').readFileSync('wrong-returned-module');",
    "const holder={child:{}},box={},cfg={receiver:{}};box.owner=holder.child;const set=Reflect.set.bind(null,holder,'child',{},cfg.receiver);cfg.receiver=holder;set();holder.child.owner=module;Object.assign=custom;Object.assign({},box.owner);require('fs').readFileSync('wrong-captured-receiver');",
    "const holder={child:{}},box={};Object.defineProperty(holder,'child',{value:{},configurable:false});box.owner=holder.child;Reflect.defineProperty(holder,'child',{value:{},configurable:true});holder.child.owner=module;Object.assign=custom;Object.assign({},box.owner);require('fs').readFileSync('wrong-rejected-definition');",
    "const holder={child:{}},box={};box.owner=holder.child;Reflect.set(holder,'child',{},{});holder.child.owner=module;Object.assign=custom;Object.assign({},box.owner);require('fs').readFileSync('wrong-possible-replacement');",
    "const holder={child:{}},box={};box.owner=holder.child;Object.freeze(holder);holder.child={};holder.child.owner=module;Object.assign=custom;Object.assign({},box.owner);require('fs').readFileSync('wrong-frozen-replacement');",
    "const bound=Reflect.set.bind(null,module);Reflect.set(Reflect,'set',bound,(0,Reflect));Reflect.set('require',replacement);require('fs').readFileSync('wrong-sequence-bound');",
    "Reflect.set(module,'require',replacement,1+2);require('fs').readFileSync('receiver-expression.json');",
    "const fs=require('fs');const remove=Reflect.deleteProperty.bind(null,fs,'readFileSync');remove();fs.readFileSync('wrong-bound-delete');",
    "const holder={child:{}},box={};box.owner=holder.child;Reflect.defineProperty(holder,'child',{value:{}});holder.child.owner=module;Object.assign=custom;Object.assign({},box.owner);require('fs').readFileSync('native-replacement-define.json');",
    "const holder={child:{}},box={};box.owner=holder.child;Reflect.set(holder,'child',{});holder.child.owner=module;Object.assign=custom;Object.assign({},box.owner);require('fs').readFileSync('native-replacement-set.json');",
    "let holder={child:{}};const box={};const set=Reflect.set.bind(null,holder,'child',{});holder={child:{}};box.owner=holder.child;set();holder.child.owner=module;Object.assign=custom;Object.assign({},box.owner);require('fs').readFileSync('wrong-captured-native-target');",
    "const holder={inner:{child:{}}},box={};const set=Reflect.set.bind(null,holder.inner,'child',{});holder.inner={child:{}};box.owner=holder.inner.child;set();holder.inner.child.owner=module;Object.assign=custom;Object.assign({},box.owner);require('fs').readFileSync('wrong-captured-member-target');",
    "const holder={inner:{child:{}}},box={};const set=Reflect.set.bind(null,holder.inner,'child',{});box.owner=holder.inner.child;set();holder.inner.child.owner=module;Object.assign=custom;Object.assign({},box.owner);require('fs').readFileSync('native-member-kept.json');",
    "const bound=Reflect.set.bind(null,module);Reflect.set(Reflect,'set',bound,flag?Reflect:Reflect);Reflect.set('require',replacement);require('fs').readFileSync('wrong-conditional-receiver');",
    "import fs from 'node:fs';Reflect.set(fs,'readFileSync',custom);fs.readFileSync('wrong-default-set');",
    "const holder={child:{}}; const box={}; box.owner=holder.child; outer:{if(flag)break outer;holder.child={};} holder.child.owner=module; Object.assign=custom;Object.assign({},box.owner);require('fs').readFileSync('wrong-labeled-allocation');",
    "const holder={child:{}}; const box={}; box.owner=holder.child; do{if(flag)continue;holder.child={};}while(false);holder.child.owner=module;Object.assign=custom;Object.assign({},box.owner);require('fs').readFileSync('wrong-loop-allocation');",
    "const box={};function install(){Object.defineProperty(box,'owner',{writable:true});}install();Object.assign=custom;Object.assign({},box.owner);require('fs').readFileSync('deferred-descriptor.json');Object.prototype.value=module;",
    "const box={};(()=>Reflect.defineProperty(box,'owner',{writable:true}))();Object.assign=custom;Object.assign({},box.owner);require('fs').readFileSync('immediate-descriptor.json');Object.prototype.value=module;",
    "const box={};function install(){Object.defineProperty(box,'owner',{writable:true});}Object.prototype.value=module;install();Object.assign=custom;Object.assign({},box.owner);require('fs').readFileSync('wrong-inherited-descriptor');",
    "const box={}; box.owner=1; Object.assign=custom; Object.assign({},box.owner); require('fs').readFileSync('harmless-written.json');",
    "const box={}; Object.defineProperties(box,{owner:{value:1}}); Object.assign=custom; Object.assign({},box.owner); require('fs').readFileSync('harmless-descriptor.json');",
    "Object.defineProperty(Reflect,'set',{value:Reflect.set.bind(null,module)}); Reflect.set('require',replacement); require('fs').readFileSync('wrong-descriptor-bound');",
    "Object.assign(Reflect,{set:Reflect.set.bind(null,module)}); Reflect.set('require',replacement); require('fs').readFileSync('wrong-copied-bound');",
    "Object.assign(Reflect,{other:Reflect.set.bind(null,module)}); Reflect.set({},'require',replacement); require('fs').readFileSync('copied-unrelated.json');",
    "const fs=require('fs'); Reflect.set(module,'require',replacement,{fs}); fs.readFileSync('wrapper-descriptor-before.json'); module.require=other;",
    "Reflect.set=Reflect.set.bind(null,module); Reflect.set('require',replacement); require('fs').readFileSync('wrong-assigned-bound-set');",
    "Object.assign=Object.assign.bind(null,module); Object.assign({require:replacement}); require('fs').readFileSync('wrong-assigned-bound-assign');",
    "Reflect.set=Reflect.set.bind(null,{}); Reflect.set('require',replacement); require('fs').readFileSync('bound-separate.json');",
    "Object.create.call=()=>module; const r=Object.create.call(null,null); Reflect.set(r,'require',custom); require('fs').readFileSync('wrong-create');",
    "const fs=require('fs'); const r={fs,set hook(v){this.fs.readFileSync=custom;}}; Reflect.set(r,'hook',1); fs.readFileSync('wrong-setter');",
    "import fs = require('fs'); fs={}; fs={}; fs.readFileSync('wrong-entry');",
    "const fs=require('fs'); Reflect.set(fs,'readFileSync',custom,{}); fs.readFileSync('receiver-data.json');",
    "Reflect.set(module,'require',custom,-1); require('fs').readFileSync('receiver-primitive.json');",
    "let fs; fs=require('fs'),fs.readFileSync('sequence-one.json'),fs={},fs=require('fs'),fs.readFileSync('sequence-two.json');",
    "const fs=require('fs'); fs.globSync('*'); fs.readFileSync('glob-kept.json');",
    "let fs=require('fs'); {{fs.readFileSync('nested-timeline.json');}} fs={};",
    "const fs=require('fs'); const target={__proto__:{set hook(v){this.fs.readFileSync=custom;}}}; Reflect.set(target,'hook',1,{fs}); fs.readFileSync('wrong-inherited-setter');",
    "const {promises:fsp}=require('fs'); delete require('fs').promises; const handle=fsp.open('saved-promises'); handle.close();",
    "Object.assign=(target,source)=>{target.require=source.require;}; Object.assign(module,{require:replacement}); require('fs').readFileSync('wrong-opaque-mutator');",
    "const {promises:fsp}=require('fs'); patch(require('fs/promises')); const h=fsp.open('wrong-escaped-object'); h.close();",
    "const fs=require('fs'); Reflect.set(Object.create(null),'hook',1,{fs}); fs.readFileSync('null-prototype-kept.json');",
    "const fs=require('fs'); delete fs.statSync; Object.defineProperty(Object.prototype,'statSync',{set(){this.readFileSync=custom;}}); Reflect.set(fs,'statSync',custom); fs.readFileSync('wrong-removed-descriptor');",
    "let fs=require('fs'); fs.readFileSync('outer-before-nested.json'); {fs={};}",
    "const {id}=module; Object.assign=custom; Object.assign({},id); require('fs').readFileSync('projected-scalar.json');",
    "Reflect.set=custom; Reflect.set({},'x',1); require('fs').readFileSync('opaque-unrelated.json');",
    "const r=Object.create(null); Object.create=custom; Reflect.set(module,'require',replacement,r); require('fs').readFileSync('allocated-before.json');",
    "const fs=require('fs'); Reflect.set(fs,'readFileSync',custom,{}); fs.readFileSync('reflect-before.json'); Reflect.set=other;",
    "const proc=require('process'); Reflect.set(proc,'env',{},{}); const mode=proc.env.SEPARATE_MODE;",
    "let fs={}; outer:{if(flag)break outer; fs=require('fs');} fs.readFileSync('wrong-skipped-write');",
    "function run(){const r=Object.create(null); Reflect.set(r,'require',replacement); require('fs').readFileSync('wrong-deferred-loader');} Object.create=()=>module; run();",
    "function run(){const fs=require('fs'); Reflect.set(fs,'readFileSync',custom,{}); fs.readFileSync('wrong-deferred-set');} Reflect.set=(target,key,value)=>{target[key]=value}; run();",
    "Reflect.set(module); require('fs').readFileSync('omitted-key.json');",
    "Reflect.set(module,'require',replacement,require('node:path')); require('fs').readFileSync('namespace-receiver.json');",
    "Reflect.set(module,'require',replacement,new (class {})()); require('fs').readFileSync('constructed-receiver.json');",
    "Reflect.set(module,'require',replacement,new (class {constructor(){return module;}})()); require('fs').readFileSync('wrong-constructor-return');",
    "Object.assign=custom; const box={safe:{id:1},owner:module}; Object.assign({},box.safe); Object.assign({},box.owner); require('fs').readFileSync('wrong-cached-projection');",
  ];
  for (const [index, source] of sources.entries())
    await writeFile(join(root, `receiver-review-${index}.ts`), source);
  for (const [name, source] of Object.entries({
    "commonjs-callback.cjs": `Object.assign=(t,get)=>{get().require=replacement};
     Object.assign({},()=>module);require('fs').readFileSync('wrong-callback');`,
    "callable-scalar.cjs": `const label=function named(){};
     Object.assign=(t,key)=>{t[key]=1};Object.assign({},label.name);
     require('fs').readFileSync('callable-name.json');`,
    "callable-property-reference.cjs": `const label=function named(){};
     Object.defineProperty(label,'name',{value:module});
     Object.assign=(t,v)=>{v.require=replacement};Object.assign({},label.name);
     require('fs').readFileSync('wrong-callable-name');`,
    "callable-escaped-property.cjs": `const label=()=>module;patch(label);
     Object.assign=(t,v)=>{v.require=replacement};Object.assign({},label.name);
     require('fs').readFileSync('wrong-escaped-callable');`,
    "callable-captured-property.cjs": `const label=()=>module;const display=label.name;patch(label);
     Object.assign=(t,key)=>{t[key]=1};Object.assign({},display);
     require('fs').readFileSync('callable-captured.json');`,
    "aliased-mutator.cjs": `const O=Object;O.assign=(t,key)=>{t[key]=1};O.assign({},1);
     require('fs').readFileSync('aliased-mutator.json');`,
    "callable-primitive-prefix.cjs": `const label=function named(){};patch(label.name);
     Object.assign=(t,key)=>{t[key]=1};Object.assign({},label.name.length);
     require('fs').readFileSync('callable-prefix.json');`,
    "callable-changed-prefix.cjs": `const label=()=>module;patch(label);
     Object.assign=(t,v)=>{v.require=replacement};Object.assign({},label.name.length);
     require('fs').readFileSync('wrong-callable-prefix');`,
  }))
    await writeFile(join(root, name), source);
  await writeFile(
    join(root, "commonjs-bound-callback.cjs"),
    `Object.assign=(t,get)=>{get().require=replacement};
     const assign=Object.assign.bind(null,{},()=>module);
     assign();require('fs').readFileSync('wrong-bound-callback');`,
  );
  await writeFile(
    join(root, "commonjs-primitive-union.cjs"),
    `const receiver=flag?null:1;
     Reflect.set(module,'require',replacement,receiver);
     require('fs').readFileSync('commonjs-primitive-union.json');`,
  );
  await writeFile(
    join(root, "namespace-primitive-receiver.mjs"),
    `import * as ns from 'node:path';import fs from 'node:fs';
     const receiver=null;Reflect.set(ns,'saved',fs,receiver);
     fs.readFileSync('primitive-receiver-binding.json');`,
  );
  await writeFile(
    join(root, "namespace-stored-value.mjs"),
    `import * as ns from 'node:path';import fs from 'node:fs';
     const receiver={};Reflect.set(ns,'saved',fs,receiver);
     receiver.saved.readFileSync=custom;
     fs.readFileSync('wrong-namespace-stored-value');`,
  );
  await writeFile(
    join(root, "namespace-receiver.mjs"),
    `import * as fs from 'node:fs';
     Reflect.set(fs,'readFileSync',custom);fs.readFileSync('namespace-set.json');
     const set=Reflect.set.bind(null,fs);set('readFileSync',custom);
     fs.readFileSync('namespace-bound-set.json');
     Reflect.defineProperty(fs,'readFileSync',{value:custom});
     fs.readFileSync('namespace-descriptor.json');`,
  );
};

const writeBuiltinIdentitySources = async (root: string): Promise<void> => {
  await writeFile(
    join(root, "app.cjs"),
    `
    throw new Error('parse only');
    const a = require('node:fs'); const b = require('fs');
    b.readFileSync('before.json'); const stream = b.createReadStream('before.json'); stream.destroy();
    patch(a); b.readFileSync('wrong-after.json');
    const proc = require('node:process'); proc.env = {}; proc.argv = []; const mode = proc.env.MODE; const arg = proc.argv[2];
  `,
  );
  await writeFile(
    join(root, "sibling.mjs"),
    `import fs from 'node:fs'; fs.writeFileSync = custom; fs.readFileSync('sibling.json'); fs.readFileSync = custom;`,
  );
  await writeFile(
    join(root, "captures.cjs"),
    `const fs = require('node:fs');
     const saved = require('fs').readFileSync;
     const { readFileSync: savedDestructured } = fs;
     fs.readFileSync('before-write.json'); fs.readFileSync = custom;
     const { readFileSync: late } = require('fs');
     const lateMember = require('fs').readFileSync;
     saved('saved.json'); savedDestructured('saved-destructured.json');
     late('wrong-late.json'); lateMember('wrong-member.json');`,
  );
  await writeFile(
    join(root, "direct.cjs"),
    `require('node:fs').readFileSync('direct.json');
     const fs = require('fs'); fs.readFileSync('later.json');
     require('fs/promises').open('before');
     fs.promises.open = custom; require('node:fs/promises').open('wrong');`,
  );
  await writeFile(
    join(root, "loader.cjs"),
    `require = () => ({ readFileSync() {} });
     const fs = require('node:fs'); fs.readFileSync('wrong-loader.json');
     require('node:fs').readFileSync('wrong-direct-loader.json');`,
  );
  await writeFile(
    join(root, "imports.cts"),
    `import fs = require('node:fs'); const other = require('fs');
     const read = other.readFileSync; observe(read); read('escaped.json');
     fs.readFileSync = custom; other.readFileSync('wrong-import-equals.json');`,
  );
  await writeFile(
    join(root, "late-loader.cjs"),
    `const fs=require('fs'); fs.readFileSync('loader-before.json');
     require=replacement; fs.readFileSync('loader-after.json');
     require('fs').readFileSync('wrong-late-loader.json');`,
  );
  await writeFile(
    join(root, "replacement.cts"),
    `import fs = require('fs'); const other=require('fs'); fs={}; fs.readFileSync=custom; other.readFileSync('replacement-kept.json');`,
  );
  await writeFile(
    join(root, "dynamic.cjs"),
    `const fs=require('fs'); fs.hook=custom; fs[key](); fs.readFileSync('wrong-dynamic.json');`,
  );
  await writeFile(
    join(root, "wrapped.cjs"),
    `const fs=require('fs'); let assigned; const saved=(0, fs.readFileSync); fs.readFileSync=custom; const late=(assigned=fs.readFileSync); saved('wrapped-kept.json'); late('wrong-wrapped.json');`,
  );
  await writeFile(
    join(root, "global-process.cjs"),
    `process.env={MODE:'local'}; const proc=require('process'); const mode=proc.env.MODE;`,
  );
  await writeFile(
    join(root, "ordered-receivers.cjs"),
    `let fs=require('fs'); fs.statSync('probe'); fs.readdirSync('probe');
     fs.readFileSync('ordered-kept.json'); fs={};
     globalThis.process.cwd(); const proc=require('process'); const mode=proc.env.REVIEW_MODE;`,
  );
  await writeFile(
    join(root, "nested-write.cjs"),
    `const fs=require('fs'); fs.readFileSync('nested-kept.json');
     if(flag) { fs.readFileSync=custom; } fs.readFileSync('wrong-nested.json');`,
  );
  await writeFile(
    join(root, "reflect-receiver.cjs"),
    `Reflect.set(module, 'require', replacement, {});
     const fs=require('fs'); fs.readFileSync('reflect-receiver-kept.json');`,
  );
  await writeFile(
    join(root, "reflect-module.cjs"),
    `Reflect.set({}, 'require', replacement, module);
     const fs=require('fs'); fs.readFileSync('wrong-reflect-module.json');`,
  );
  await writeFile(
    join(root, "reflect-independent.cjs"),
    `const registry=Object.create(null); Reflect.set(registry, key, replacement);
     Reflect.set(module, 0, replacement);
     const fs=require('fs'); Reflect.set(fs, 'require', replacement);
     require('fs').readFileSync('reflect-independent-kept.json');`,
  );
  await writeFile(
    join(root, "repeated-reads.cjs"),
    `let fs;
     fs=require('fs'); fs.readFileSync('timeline-first.json'); fs={};
     fs=require('fs'); fs.readFileSync('timeline-second.json');
     fs.readFileSync=custom; fs.readFileSync('wrong-timeline.json');`,
  );
};

it("preserves earlier and sibling effects without inventing replaced cached-module or process effects", async () => {
  const root = await createTestTempDirectory("rea-builtin-identity-");
  await writeBuiltinIdentitySources(root);
  await writeReceiverReviewSources(root);
  const { stdout } = await execute(
    process.execPath,
    ["scripts/rea.mjs", "analyze-javascript-application", root, "--json"],
    { cwd: process.cwd(), maxBuffer: 16 * 1024 * 1024 },
  );
  const evidence = parseEvidence(JSON.parse(stdout));
  const result = javascriptApplicationAnalysisResultSchema.parse(
    evidence.normalized_result,
  );
  expect(
    result.semantic_graph.nodes
      .filter(({ kind }) => kind === "config-source")
      .map(({ properties }) => properties.key)
      .sort(),
  ).toEqual([
    "REVIEW_MODE",
    "SEPARATE_MODE",
    "aliased-mutator.json",
    "allocated-before.json",
    "before-write.json",
    "before.json",
    "bound-separate.json",
    "callable-captured.json",
    "callable-name.json",
    "callable-prefix.json",
    "commonjs-primitive-union.json",
    "constructed-receiver.json",
    "copied-unrelated.json",
    "deferred-descriptor.json",
    "direct.json",
    "escaped.json",
    "fresh-sequence-receiver.json",
    "glob-kept.json",
    "harmless-descriptor.json",
    "harmless-written.json",
    "immediate-descriptor.json",
    "late-prototype-kept.json",
    "later.json",
    "loader-after.json",
    "loader-before.json",
    "namespace-bound-set.json",
    "namespace-descriptor.json",
    "namespace-receiver.json",
    "namespace-set.json",
    "native-member-kept.json",
    "native-replacement-define.json",
    "native-replacement-set.json",
    "nested-kept.json",
    "nested-timeline.json",
    "nested-write-kept.json",
    "null-prototype-kept.json",
    "omitted-key.json",
    "opaque-unrelated.json",
    "ordered-kept.json",
    "outer-before-nested.json",
    "primitive-receiver-binding.json",
    "projected-scalar.json",
    "receiver-data.json",
    "receiver-expression.json",
    "receiver-primitive.json",
    "reflect-before.json",
    "reflect-independent-kept.json",
    "reflect-receiver-kept.json",
    "replacement-kept.json",
    "saved-destructured.json",
    "saved.json",
    "sequence-one.json",
    "sequence-two.json",
    "sibling.json",
    "timeline-first.json",
    "timeline-second.json",
    "wrapped-kept.json",
    "wrapper-descriptor-before.json",
  ]);
  expect(
    result.semantic_graph.nodes.filter(({ kind }) => kind === "resource"),
  ).toHaveLength(3);
  expect(
    result.semantic_graph.relations.filter(
      ({ relation }) => relation === "releases",
    ),
  ).toHaveLength(2);
  // This combined regression corpus includes the complete retained analysis.
  const { client, call } = await connectLocalToolsMcp(
    { REA_MCP_MAX_RESPONSE_BYTES: String(16 * 1024 * 1024) },
    undefined,
    { maxBufferSize: 16 * 1024 * 1024 },
  );
  const response = await call("analyze_javascript_application", {
    input_path: root,
    format: "auto",
  });
  expect(response.isError, JSON.stringify(response)).not.toBe(true);
  expect(response.structuredContent).toEqual(evidence);
  await client.ping();
}, 60000);

it("preserves opaque-write and suspension boundaries through CLI and MCP", async () => {
  const root = await createTestTempDirectory("rea-builtin-opaque-");
  for (const [name, source] of Object.entries(opaqueMutatorSources))
    await writeFile(join(root, name), source);
  const { stdout } = await execute(
    process.execPath,
    ["scripts/rea.mjs", "analyze-javascript-application", root, "--json"],
    { cwd: process.cwd(), maxBuffer: 16 * 1024 * 1024 },
  );
  const evidence = parseEvidence(JSON.parse(stdout));
  const result = javascriptApplicationAnalysisResultSchema.parse(
    evidence.normalized_result,
  );
  expect(
    result.semantic_graph.nodes
      .filter(({ kind }) => kind === "config-source")
      .map(({ properties }) => properties.key)
      .sort(),
  ).toEqual([
    "opaque-saved-key.json",
    "opaque-saved-receiver.json",
    "own-then.json",
    "scalar-argument.json",
    "suspended-primitive.json",
  ]);
  const { client, call } = await connectLocalToolsMcp();
  const response = await call("analyze_javascript_application", {
    input_path: root,
    format: "auto",
  });
  expect(response.isError, JSON.stringify(response)).not.toBe(true);
  expect(response.structuredContent).toEqual(evidence);
  await client.ping();
}, 60000);

it("excludes monkey-patched CommonJS effects from CLI and MCP evidence", async () => {
  const root = await createTestTempDirectory("rea-builtin-mutated-");
  await writeFile(
    join(root, "deferred-setter.cjs"),
    `const cp=require('child_process'); const fs=require('fs');
    function run(){Reflect.set(fs,'statSync',1,{cp}); cp.spawn('wrong');}
    Object.defineProperty(fs,'statSync',{set(v){this.cp.spawn=custom;}}); run();`,
  );
  await writeFile(
    join(root, "stored-loader.cjs"),
    `Object.assign=(target,value)=>{value.require=replacement};
    const box={}; const saved=box; box.owner=module;
    Object.assign({},saved.owner); require('fs').readFileSync('wrong');`,
  );
  for (const [index, mutation] of [
    "Object.assign(module, {[key]: replacement});",
    "Object.assign(module, {...replacement});",
    "Reflect.set(module, 'require', replacement);",
    "let owner=module; owner.require=replacement; owner={};",
  ].entries()) {
    await writeFile(
      join(root, `loader-${index}.cjs`),
      `${mutation} require('fs').readFileSync('wrong-loader.json');`,
    );
  }
  await writeFile(
    join(root, "deleted-parent.cjs"),
    `const fs=require('fs'); delete fs.promises; require('fs').promises.open('wrong');
     require('tls').createConnection(443);`,
  );
  await writeFile(
    join(root, "app.cjs"),
    `
    throw new Error("parse only");
    const fs = require("node:fs"); fs.readFileSync = custom; fs.createReadStream = custom;
    const cp = require("node:child_process"); cp.spawn = custom;
    const timers = require("node:timers"); patch(timers);
    const http = require("node:http"); delete http.get;
    fs.readFileSync("config.json"); const stream = fs.createReadStream("config.json"); stream.destroy();
    const child = cp.spawn("tool", []); child.kill();
    const timer = timers.setTimeout(callback, 1); clearTimeout(timer);
    http.get("http://example.test");
  `,
  );
  const { stdout } = await execute(
    process.execPath,
    ["scripts/rea.mjs", "analyze-javascript-application", root, "--json"],
    { cwd: process.cwd(), maxBuffer: 16 * 1024 * 1024 },
  );
  const evidence = parseEvidence(JSON.parse(stdout));
  const result = javascriptApplicationAnalysisResultSchema.parse(
    evidence.normalized_result,
  );
  expect(
    result.semantic_graph.nodes.filter(({ kind }) =>
      [
        "config-source",
        "resource",
        "child-process",
        "timer",
        "request",
      ].includes(kind),
    ),
  ).toEqual([]);
  expect(
    result.semantic_graph.relations.filter(({ relation }) =>
      ["releases", "forwards-signal", "cancels-timer"].includes(relation),
    ),
  ).toEqual([]);
  const { client, call } = await connectLocalToolsMcp();
  const response = await call("analyze_javascript_application", {
    input_path: root,
    format: "auto",
  });
  expect(response.isError, JSON.stringify(response)).not.toBe(true);
  expect(response.structuredContent).toEqual(evidence);
  await client.ping();
}, 60000);

it("retains CommonJS builtin effects and handle links through CLI and MCP", async () => {
  const root = await createTestTempDirectory("rea-builtin-commonjs-");
  await writeFile(
    join(root, "app.cjs"),
    `
    throw new Error("This source must only be parsed, never executed");
    const fs = require("node:fs");
    const {spawn: launch} = require("node:child_process");
    const cp = require("node:child_process");
    function syncRun() { return cp.spawnSync("tool", []); }
    const timers = require("timers");
    const {get} = require("http");
    const proc = require("node:process");
    const text = fs.readFileSync("config.json", "utf8");
    const stream = fs.createReadStream("config.json"); stream.destroy();
    const child = launch("tool", []); child.kill("SIGTERM");
    const timer = timers.setTimeout(callback, 10); timers.clearTimeout(timer);
    get("http://example.test");
    const mode = proc.env.MODE;
    const absent = require("node:fs").default; absent.readFileSync("wrong-default");
    const external = require("./fs.js"); external.readFileSync("wrong-external");
    function shadowed(require) { const fs = require("node:fs"); fs.readFileSync("wrong"); }
  `,
  );
  const { stdout } = await execute(
    process.execPath,
    ["scripts/rea.mjs", "analyze-javascript-application", root, "--json"],
    { cwd: process.cwd(), maxBuffer: 16 * 1024 * 1024 },
  );
  const evidence = parseEvidence(JSON.parse(stdout));
  const result = javascriptApplicationAnalysisResultSchema.parse(
    evidence.normalized_result,
  );
  const nodes = result.semantic_graph.nodes;
  expect(
    nodes.filter(({ kind }) =>
      [
        "config-source",
        "resource",
        "child-process",
        "timer",
        "request",
      ].includes(kind),
    ),
  ).toHaveLength(6);
  expect(nodes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "config-source",
        properties: expect.objectContaining({ key: "config.json" }),
      }),
      expect.objectContaining({
        kind: "config-source",
        properties: expect.objectContaining({ key: "MODE" }),
      }),
      ...["createReadStream", "spawn", "setTimeout", "get"].map((method) =>
        expect.objectContaining({
          properties: expect.objectContaining({ method }),
        }),
      ),
    ]),
  );
  const relations = result.semantic_graph.relations;
  for (const relation of ["releases", "forwards-signal", "cancels-timer"])
    expect(relations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ relation, resolution: "resolved" }),
      ]),
    );
  const { client, call } = await connectLocalToolsMcp();
  const response = await call("analyze_javascript_application", {
    input_path: root,
    format: "auto",
  });
  expect(response.isError, JSON.stringify(response)).not.toBe(true);
  expect(response.structuredContent).toEqual(evidence);
  await client.ping();
}, 60000);

it.each([
  "import fs from 'node:fs';",
  "import {default as fs} from 'node:fs';",
])(
  "retains filesystem effects in the public CLI with %s",
  async (declaration) => {
    const root = await createTestTempDirectory("rea-builtin-default-cli-");
    await writeFile(
      join(root, "app.js"),
      `${declaration} const text=fs.readFileSync('config.json','utf8'); const stream=fs.createReadStream('config.json'); stream.destroy();`,
    );
    const { stdout } = await execute(
      process.execPath,
      ["scripts/rea.mjs", "analyze-javascript-application", root, "--json"],
      { cwd: process.cwd(), maxBuffer: 16 * 1024 * 1024 },
    );
    const result = javascriptApplicationAnalysisResultSchema.parse(
      parseEvidence(JSON.parse(stdout)).normalized_result,
    );
    expect(result.semantic_graph.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "config-source",
          properties: expect.objectContaining({ key: "config.json" }),
        }),
        expect.objectContaining({
          kind: "resource",
          properties: expect.objectContaining({ method: "createReadStream" }),
        }),
      ]),
    );
    expect(result.semantic_graph.relations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          relation: "releases",
          resolution: "resolved",
        }),
      ]),
    );
  },
  20_000,
);

it("keeps only direct logical defaults and actual argv elements in the public CLI graph", async () => {
  const root = await createTestTempDirectory("rea-builtin-default-cli-");
  const manyDefaults = Array.from(
    { length: 400 },
    (_, index) =>
      `const value${index} = process.env.KEY_${index} ?? "fallback-${index}";`,
  ).join("\n");
  await writeFile(
    join(root, "app.js"),
    [
      `const chained = process.env.CHAINED ?? "fallback" ?? "unreachable";
const wrapped = ((process.env.WRAPPED)) ?? "wrapped";
const argument = process.argv[2];
const argumentLength = process.argv.length;
const namedArgument = process.argv["02"];
const negativeArgument = process.argv["-1"];
const method = process.argv.map;
const lastArrayIndex = process.argv[4294967294];
const outOfRangeArgument = process.argv[4294967295];
const dynamicArgument = process.argv[process.env.ARGV_INDEX];
function shadowed(process) { return process.argv[3]; }`,
      manyDefaults,
    ].join("\n"),
  );
  const { stdout } = await execute(
    process.execPath,
    ["scripts/rea.mjs", "analyze-javascript-application", root, "--json"],
    { cwd: process.cwd(), maxBuffer: 16 * 1024 * 1024 },
  );
  const result = javascriptApplicationAnalysisResultSchema.parse(
    parseEvidence(JSON.parse(stdout)).normalized_result,
  );
  const configSources = result.semantic_graph.nodes.filter(
    ({ kind }) => kind === "config-source",
  );
  const defaults = configSources.filter(
    ({ properties }) => properties.source_kind === "default",
  );
  expect(defaults).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        properties: expect.objectContaining({
          key: "CHAINED",
          value: "fallback",
        }),
      }),
      expect.objectContaining({
        properties: expect.objectContaining({
          key: "WRAPPED",
          value: "wrapped",
        }),
      }),
    ]),
  );
  expect(
    defaults.filter(({ properties }) => properties.key === "CHAINED"),
  ).toHaveLength(1);
  expect(defaults).toHaveLength(402);
  const defaultsByKey = new Map(
    defaults.map(({ properties }) => [properties.key, properties.value]),
  );
  for (let index = 0; index < 400; index += 1)
    expect(defaultsByKey.get(`KEY_${index}`)).toBe(`fallback-${index}`);
  const argvSources = configSources.filter(
    ({ properties }) => properties.source_kind === "argv",
  );
  expect(argvSources).toHaveLength(3);
  expect(argvSources).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        properties: expect.objectContaining({ key: "2" }),
      }),
      expect.objectContaining({
        properties: expect.objectContaining({ key: "4294967294" }),
      }),
      expect.objectContaining({
        properties: expect.objectContaining({ key: null }),
      }),
    ]),
  );
  expect(
    result.semantic_graph.relations
      .filter(({ relation }) => relation === "reads-argv")
      .map(({ resolution }) => resolution),
  ).toEqual(expect.arrayContaining(["resolved", "candidate"]));
  expect(
    result.semantic_graph.relations.filter(
      ({ relation, source_node_id, target_node_id }) => {
        if (relation !== "overrides") return false;
        const source = result.semantic_graph.nodes.find(
          ({ node_id }) => node_id === source_node_id,
        );
        const target = result.semantic_graph.nodes.find(
          ({ node_id }) => node_id === target_node_id,
        );
        return (
          source?.properties.key === "CHAINED" &&
          target?.properties.key === "CHAINED"
        );
      },
    ),
  ).toHaveLength(1);
}, 20_000);
