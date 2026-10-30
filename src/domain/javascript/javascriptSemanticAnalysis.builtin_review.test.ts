import { expect, it } from "vitest";
import * as t from "@babel/types";
import {
  analyzeJavaScriptSemantics,
  indexJavaScriptBindingsWithReceiversSteps,
} from "./javascriptSemanticAnalysis.js";
import { parseJavaScriptSource } from "./javascriptSourceParser.js";
import { completeSemanticSteps } from "./javascriptSemanticTraversal.js";
import { namespaceReceiverCases } from "./javascriptNamespaceReceiver.fixture.js";
import {
  opaqueMutatorCases,
  scalarAndThenableCases,
  mutatorEvaluationBoundaryCases,
} from "./javascriptOpaqueMutators.fixture.js";
import {
  callableScalarPropertyCases,
  callableReferencePropertyCases,
  opaqueBoundCallablePropertyCase,
  callableCapturedPropertyCases,
  callableEscapedPropertyCases,
  aliasedMutatorCalleeCases,
  aliasedMutatorExposureCases,
  callablePrimitivePrefixCases,
  callableChangedPrefixCases,
  callableSavedPrefixUncertainty,
} from "./javascriptCallableProperties.fixture.js";
import {
  commonJsCallbackExposureCases,
  commonJsPrimitiveReceiverCases,
  commonJsUncertainReceiverCases,
} from "./javascriptCommonJsExposure.fixture.js";

const referenceChanged = (source: string, writesOnly = false): boolean => {
  const parsed = parseJavaScriptSource(source);
  if (parsed === null) throw new Error("Expected parsed receiver fixture");
  const index = completeSemanticSteps(
    indexJavaScriptBindingsWithReceiversSteps(parsed.program),
  );
  completeSemanticSteps(index.indexMemberMutationFactsSteps());
  const last = parsed.program.body.at(-1);
  if (!t.isExpressionStatement(last) || !t.isCallExpression(last.expression))
    throw new Error("Expected consumer call");
  const reference = last.expression.arguments[0];
  if (!t.isMemberExpression(reference))
    throw new Error("Expected selected data slot");
  if (writesOnly)
    return index
      .effectsForReferenceAt(last.expression, reference)
      .effects.some(
        ({ kind, timing }) => kind === "member-write" && timing !== "after",
      );
  return index.referenceMayHaveChangedAt(last.expression, reference);
};
const ordinaryTargetChanged = (write: string): boolean =>
  referenceChanged(
    `const holder={fs:require('fs')};${write}consume(holder.fs);`,
  );

it.each([
  "import fs from 'node:fs';",
  "import * as ns from 'node:fs';const fs=ns.default;",
  "const fs=require('node:fs');",
])("retains mutable export descriptor writes: %s", (load) => {
  expect(
    analyzeJavaScriptSemantics(
      `${load}Reflect.defineProperty(fs,'readFileSync',{value:custom});fs.readFileSync('wrong');`,
    ).configurationOperations,
  ).toEqual([]);
});

it("keeps the descriptor of a captured setter target after rebinding", () => {
  expect(
    analyzeJavaScriptSemantics(
      `const fs=require('fs');let holder={set hook(v){this.fs.readFileSync=custom;}};const set=Reflect.set.bind(null,holder,'hook',1);holder={hook:0};set({fs});fs.readFileSync('wrong');`,
    ).configurationOperations,
  ).toEqual([]);
});

it.each([
  "Reflect.defineProperty(fs,'readFileSync',{value:custom});",
  "Reflect.defineProperty.call(null,fs,'readFileSync',{value:custom});",
  "Reflect.defineProperty.apply(null,[fs,'readFileSync',{value:custom}]);",
  "const define=Reflect.defineProperty.bind(null,fs,'readFileSync');define({value:custom});",
  "const alias=fs;Reflect.defineProperty(alias,'readFileSync',{value:custom});",
  "Reflect.defineProperty((0,fs),'readFileSync',{value:custom});",
  "try{Object.defineProperty(fs,'readFileSync',{value:custom});}catch{}",
  "try{Object.defineProperties(fs,{readFileSync:{value:custom}});}catch{}",
])(
  "preserves namespace exports after rejected descriptor definitions: %s",
  (write) => {
    expect(
      analyzeJavaScriptSemantics(
        `import * as fs from 'node:fs';${write}fs.readFileSync('kept');`,
      ).configurationOperations.map(({ key }) => key),
    ).toEqual(["kept"]);
  },
);

it.each([
  "const receiver={};Reflect.set(holder,'fs',{},receiver);",
  "Reflect.set.call(null,holder,'fs',{},{});",
  "Reflect.set.apply(null,[holder,'fs',{},{}]);",
  "const set=Reflect.set.bind(null,holder,'fs',{});set({});",
  "const alias=holder;Reflect.set(alias,'fs',{},{});",
  "Reflect.set((0,holder),'fs',{},{});",
  "holder.other=1;Reflect.set(holder,'fs',{},{});",
])("preserves ordinary data targets with separate receivers: %s", (write) => {
  expect(ordinaryTargetChanged(write)).toBe(false);
});

it.each([
  "Reflect.set(holder,'fs',{},holder);",
  "const receiver=holder;Reflect.set(holder,'fs',{},receiver);",
  "Reflect.set(holder,'fs',{},flag?holder:{});",
  "patch(holder);Reflect.set(holder,'fs',{},{});",
])(
  "retains ordinary data writes through possible target receivers: %s",
  (write) => {
    expect(ordinaryTargetChanged(write)).toBe(true);
  },
);

it.each([
  "Reflect.set(Reflect,'set',bound,flag?Reflect:Reflect);",
  "Reflect.set(Reflect,'set',bound,flag?Reflect:{});",
  "Reflect.set(Reflect,'set',bound,flag?{}:Reflect);",
  "Reflect.set(Reflect,'set',bound,flag?globalThis.Reflect:Reflect);",
  "const receiver=flag?Reflect:Reflect;Reflect.set(Reflect,'set',bound,receiver);",
  "Reflect.set.call(null,Reflect,'set',bound,flag?Reflect:Reflect);",
  "Reflect.set.apply(null,[Reflect,'set',bound,flag?Reflect:Reflect]);",
  "const set=Reflect.set.bind(null,Reflect,'set',bound);set(flag?Reflect:Reflect);",
  "Reflect.set(Reflect,'set',bound,choose());",
])(
  "retains assigned intrinsic values for possible receiver identities: %s",
  (write) => {
    expect(
      analyzeJavaScriptSemantics(
        `const bound=Reflect.set.bind(null,module);${write}Reflect.set('require',replacement);require('fs').readFileSync('wrong');`,
      ).configurationOperations,
    ).toEqual([]);
  },
);

it.each(["flag?{}:{}", "flag?Object:Function", "flag?1:2"])(
  "keeps proven separate conditional intrinsic receivers separate: %s",
  (receiver) => {
    expect(
      analyzeJavaScriptSemantics(
        `const bound=Reflect.set.bind(null,module);Reflect.set(Reflect,'set',bound,${receiver});Reflect.set('require',replacement);require('fs').readFileSync('kept');`,
      ).configurationOperations.map(({ key }) => key),
    ).toEqual(["kept"]);
  },
);

it.each([
  "box.owner=1;",
  "box.owner={nested:1};",
  "const value={nested:1}; box.owner=value;",
  "const alias=box; alias.owner=1;",
  "box.child={owner:1};",
  "box.owner=box;",
  "box.owner ||= 1;",
  "Reflect.set(box,'owner',1);",
  "Reflect.set.call(null,box,'owner',1);",
  "Object.assign(box,{owner:1});",
  "Object.assign(box,{owner:{nested:1}});",
  "Object.defineProperty(box,'owner',{value:1});",
  "Reflect.defineProperty(box,'owner',{value:1});",
  "Object.defineProperties(box,{owner:{value:1}});",
  "Object.defineProperty(box,'owner',{writable:true});",
  "Object.prototype.value=module; Object.defineProperty(box,'owner',{value:1});",
])("keeps module-free values written to local properties: %s", (write) => {
  expect(
    analyzeJavaScriptSemantics(`const box={}; ${write}
      Object.assign=custom; Object.assign({},box.owner,box.child);
      require('fs').readFileSync('kept');`).configurationOperations.map(
      ({ key }) => key,
    ),
  ).toEqual(["kept"]);
});

it.each([
  "const value={owner:module}; box.owner=value;",
  "const value={}; box.owner=value; value.owner=module;",
  "const holder={child:{}}; box.owner=holder.child; holder.child.owner=module;",
  "const holder={child:{}}; const saved=holder.child; box.owner=saved; holder.child.owner=module;",
  "const holder={child:{}}; Object.assign(box,{owner:holder.child}); holder.child.owner=module;",
  "const holder={child:{}}; Object.defineProperty(box,'owner',{value:holder.child}); holder.child.owner=module;",
  "const holder={child:{}}; const saved=holder.child; box.owner=saved; holder.child={}; saved.owner=module;",
  "const holder={child:{}}; const saved=holder.child; box.owner=saved; holder.child={}; holder.child=saved; holder.child.owner=module;",
  "const holder={child:{}}; box.owner=holder.child; if (unknown) holder.child={}; holder.child.owner=module;",
  "Object.prototype.value=module; Object.defineProperty(box,'owner',{writable:true});",
  "Object.prototype.value=module; Reflect.defineProperty(box,'owner',{writable:true});",
  "Object.prototype.value=module; Object.defineProperties(box,{owner:{writable:true}});",
  "const prototype=Object.prototype; prototype.value=module; Object.defineProperty(box,'owner',{writable:true});",
  "function install(){Object.defineProperty(box,'owner',{writable:true});} Object.prototype.value=module; install();",
  "box.child={owner:module};",
  "box.owner=box; box.child=module;",
  "box.owner ||= module;",
  "Object.assign(box,{owner:1},{owner:module});",
  "Object.defineProperties(box,{owner:{value:1},owner:{value:module}});",
  "Object.defineProperties(box,{owner:{value:1},[key]:{value:module}});",
  "Object.defineProperty(box,'owner',{get(){return module;}});",
  "Object.assign(box,{get owner(){return module;}});",
  "function getOwner(){return module;} box.owner=getOwner();",
  "box.owner=()=>module;",
  "box.owner=unknown;",
])(
  "retains module-bearing values through local property writes: %s",
  (write) => {
    expect(
      analyzeJavaScriptSemantics(`const box={}; ${write}
      Object.assign=custom; Object.assign({},box.owner,box.child);
      require('fs').readFileSync('wrong');`).configurationOperations,
    ).toEqual([]);
  },
);

it.each([
  "Object.defineProperty(fs,'statSync',{set(v){this.cp.spawn=custom;}});",
  "Reflect.defineProperty(fs,'statSync',{set(v){this.cp.spawn=custom;}});",
  "Object.defineProperties(fs,{statSync:{set(v){this.cp.spawn=custom;}}});",
  "const alias=fs; Object.defineProperty(alias,'statSync',{set(v){this.cp.spawn=custom;}});",
  "configure(fs);",
])("revisits deferred Reflect descriptor proof: %s", (install) => {
  const ir = analyzeJavaScriptSemantics(`const cp=require('child_process');
    const fs=require('fs');
    function run(){Reflect.set(fs,'statSync',1,{cp}); cp.spawn('wrong');}
    ${install} run();`);
  expect(ir.childProcessSpawns).toEqual([]);
});

it.each([
  "Reflect.set.call(null,fs,'statSync',1,{cp});",
  "Reflect.set.apply(null,[fs,'statSync',1,{cp}]);",
  "const set=Reflect.set; set(fs,'statSync',1,{cp});",
])("retains deferred descriptor effects through %s", (invoke) => {
  expect(
    analyzeJavaScriptSemantics(`const cp=require('child_process');
    const fs=require('fs'); const run=()=>{${invoke} cp.spawn('wrong');};
    Object.defineProperty(fs,'statSync',{set(v){this.cp.spawn=custom;}});
    run();`).childProcessSpawns,
  ).toEqual([]);
});

it.each([
  "Reflect.set(fs,'statSync',1,{cp}); cp.spawn('kept'); Object.defineProperty(fs,'statSync',{set(v){this.cp.spawn=custom;}});",
  "function run(){Reflect.set(fs,'statSync',1,{cp}); cp.spawn('kept');} Object.defineProperty(fs,'unrelated',{set(v){this.cp.spawn=custom;}}); run();",
  "function run(){Reflect.set(fs,'statSync',1,{cp}); cp.spawn('kept');} run();",
])("preserves independently proven Reflect data writes: %s", (body) => {
  expect(
    analyzeJavaScriptSemantics(`const cp=require('child_process');
    const fs=require('fs'); ${body}`).childProcessSpawns.map(
      ({ method }) => method,
    ),
  ).toEqual(["spawn"]);
});

it.each([
  "box.owner=module;",
  "const alias=box; alias.owner=module;",
  "box['owner']=module;",
  "box[key]=module;",
  "Reflect.set(box,'owner',module);",
  "Object.defineProperty(box,'owner',{value:module});",
  "Object.defineProperties(box,{owner:{value:module}});",
  "Object.assign(box,{owner:module});",
])("retains wrapper exposure through written local properties: %s", (write) => {
  expect(
    analyzeJavaScriptSemantics(`const box={}; ${write}
    Object.assign=(target,value)=>{value.require=replacement};
    Object.assign({},box.owner); require('fs').readFileSync('wrong');
  `).configurationOperations,
  ).toEqual([]);
});

it.each([
  "const box={}; const saved=box; box.owner=module; Object.assign({},saved.owner);",
  "const box={}; function run(){Object.assign({},box.owner);} box.owner=module; run();",
  "const box={child:{}}; box.child.owner=module; Object.assign({},box.child);",
  "const box={}; Object.assign({},box.owner); box.owner=module; Object.assign({},box.owner);",
])("retains shared local object exposure at its use: %s", (body) => {
  expect(
    analyzeJavaScriptSemantics(`Object.assign=(target,value)=>{(value.owner ?? value).require=replacement};
    ${body} require('fs').readFileSync('wrong');`).configurationOperations,
  ).toEqual([]);
});

it.each([
  "const box={owner:{}}; box.other=module; Object.assign({},box.owner); require('fs').readFileSync('kept');",
  "const box={owner:{}}; Object.assign({},box.owner); require('fs').readFileSync('kept'); box.owner=module;",
  "const box={owner:{}}; const saved=box.owner; box.owner=module; Object.assign({},saved); require('fs').readFileSync('kept');",
  "const holder={child:{}}; const box={}; box.owner=holder.child; holder.child=module; Object.assign({},box.owner); require('fs').readFileSync('kept');",
  "const holder={child:{}}; const box={}; box.owner=holder.child; holder.child={}; holder.child.owner=module; Object.assign({},box.owner); require('fs').readFileSync('kept');",
  "const holder={child:{}}; const box={}; box.owner=holder.child; const alias=holder; alias.child={}; holder.child.owner=module; Object.assign({},box.owner); require('fs').readFileSync('kept');",
  "const holder={child:{}}; const box={}; box.owner=holder.child; holder.child={}; const replacement=holder.child; replacement.owner=module; Object.assign({},box.owner); require('fs').readFileSync('kept');",
  "const holder={child:{}}; const box={}; box.owner=holder.child; Object.defineProperty(holder,'child',{value:{}}); holder.child.owner=module; Object.assign({},box.owner); require('fs').readFileSync('kept');",
  "const box={}; Object.defineProperty(box,'owner',{writable:true}); Object.prototype.value=module; Object.assign({},box.owner); require('fs').readFileSync('kept');",
  "const holder={child:{}}; const box={}; box.owner=holder.child; Object.assign({},box.owner); require('fs').readFileSync('kept'); holder.child.owner=module;",
])("keeps written local exposure scoped to the read: %s", (body) => {
  expect(
    analyzeJavaScriptSemantics(`Object.assign=(target,value)=>{value.require=replacement};
    ${body}`).configurationOperations.map(({ key }) => key),
  ).toEqual(["kept"]);
});

it.each([
  "Object.defineProperty(box,'owner',{writable:true});",
  "Reflect.defineProperty(box,'owner',{writable:true});",
  "Object.defineProperties(box,{owner:{writable:true}});",
])(
  "keeps descriptor lookup ordered before later prototype writes: %s",
  (write) => {
    expect(
      analyzeJavaScriptSemantics(`const box={}; ${write}
    Object.assign=custom; Object.assign({},box.owner);
    require('fs').readFileSync('kept'); Object.prototype.value=module;
  `).configurationOperations.map(({ key }) => key),
    ).toEqual(["kept"]);
  },
);

it.each([
  "outer:{if(flag)break outer; holder.child={};}",
  "outer:{{if(flag)break outer;} holder.child={};}",
  "outer:{try{if(flag)break outer;}finally{} holder.child={};}",
  "do{if(flag)break; holder.child={};}while(false);",
  "do{if(flag)continue; holder.child={};}while(false);",
  "for(;flag;){holder.child={}; break;}",
  "flag && (holder.child={});",
  "flag ? holder.child={} : undefined;",
])(
  "retains saved-object exposure across skipped replacements: %s",
  (replace) => {
    expect(
      analyzeJavaScriptSemantics(`const holder={child:{}}; const box={};
    box.owner=holder.child; ${replace} holder.child.owner=module;
    Object.assign=(target,value)=>{value.owner.require=replacement};
    Object.assign({},box.owner); require('fs').readFileSync('wrong');
  `).configurationOperations,
    ).toEqual([]);
  },
);

it.each([
  "function install(){Object.defineProperty(box,'owner',{writable:true});} install();",
  "const install=()=>Reflect.defineProperty(box,'owner',{writable:true}); install();",
  "(()=>Object.defineProperties(box,{owner:{writable:true}}))();",
])("bounds inherited descriptor lookup by its consumer: %s", (install) => {
  const consume =
    "Object.assign=custom; Object.assign({},box.owner); require('fs').readFileSync('kept');";
  const prototype = "Object.prototype.value=module;";
  expect(
    analyzeJavaScriptSemantics(
      `const box={}; ${install} ${consume} ${prototype}`,
    ).configurationOperations.map(({ key }) => key),
  ).toEqual(["kept"]);
  expect(
    analyzeJavaScriptSemantics(
      `const box={}; ${prototype} ${install} ${consume}`,
    ).configurationOperations,
  ).toEqual([]);
});

it("rechecks inherited descriptor lookup at each consuming call", () => {
  expect(
    analyzeJavaScriptSemantics(`const box={};
    function install(){Object.defineProperty(box,'owner',{writable:true,configurable:true});}
    install(); Object.assign=custom; Object.assign({},box.owner);
    require('fs').readFileSync('kept'); Object.prototype.value=module;
    install(); Object.assign({},box.owner); require('fs').readFileSync('wrong');
  `).configurationOperations.map(({ key }) => key),
  ).toEqual(["kept"]);
});

const intrinsicReplacementForms = [
  "Object.defineProperty(Reflect,'set',{value:bound});",
  "Reflect.defineProperty(Reflect,'set',{value:bound});",
  "Object.defineProperties(Reflect,{set:{value:bound}});",
  "Object.assign(Reflect,{set:bound});",
  "Reflect.set(Reflect,'set',bound);",
  "Reflect.set(Reflect,'set',bound,(0,Reflect));",
  "let receiver; Reflect.set(Reflect,'set',bound,receiver=Reflect);",
  "const receiver=(0,Reflect); Reflect.set(Reflect,'set',bound,receiver);",
  "Reflect.set.call(null,Reflect,'set',bound,(0,globalThis.Reflect));",
  "Reflect.set.apply(null,[Reflect,'set',bound,(0,Reflect)]);",
  "const set=Reflect.set.bind(null,Reflect,'set',bound); set((0,Reflect));",
  "Object.defineProperty.call(null,Reflect,'set',{value:bound});",
  "Object.assign.apply(null,[Reflect,{set:bound}]);",
  "const descriptor={value:bound}; Object.defineProperty(Reflect,'set',descriptor);",
  "const properties={set:bound}; Object.assign(Reflect,properties);",
];

it.each(intrinsicReplacementForms)(
  "follows native intrinsic replacement values: %s",
  (replace) => {
    for (const receiver of ["module", "{}"])
      expect(
        analyzeJavaScriptSemantics(`const bound=Reflect.set.bind(null,${receiver});
          ${replace} Reflect.set('require',replacement);
          require('fs').readFileSync('kept');`).configurationOperations.map(
          ({ key }) => key,
        ),
      ).toEqual(receiver === "module" ? [] : ["kept"]);
  },
);

it.each([
  "Object.assign(Reflect,{other:bound});",
  "Object.defineProperties(Reflect,{other:{value:bound}});",
  "Object.defineProperty(Reflect,'other',{value:bound});",
  "Reflect.set(Reflect,'set',bound,{});",
])("keeps native intrinsic replacement slots distinct: %s", (replace) => {
  expect(
    analyzeJavaScriptSemantics(`const bound=Reflect.set.bind(null,module);
      ${replace} Reflect.set({},'require',replacement);
      require('fs').readFileSync('kept');`).configurationOperations.map(
      ({ key }) => key,
    ),
  ).toEqual(["kept"]);
});

it.each(intrinsicReplacementForms)(
  "keeps reads before native intrinsic replacement: %s",
  (replace) => {
    expect(
      analyzeJavaScriptSemantics(`const bound=Reflect.set.bind(null,module);
        Reflect.set({},'require',replacement); require('fs').readFileSync('kept');
        ${replace}`).configurationOperations.map(({ key }) => key),
    ).toEqual(["kept"]);
  },
);

it.each([
  "Reflect.set(module);",
  "Reflect.set.call(null,module);",
  "Reflect.set.apply(null,[module]);",
  "const set=Reflect.set.bind(null,module); set();",
  "Reflect.set(module,'require',replacement,require('node:path'));",
  "const path=require('node:path'); Reflect.set(module,'require',replacement,path);",
  "Reflect.set(module,'require',replacement,require('node:util'));",
  "Reflect.set(module,'require',replacement,new (class {})());",
  "class Receiver{} Reflect.set(module,'require',replacement,new Receiver());",
  "function Receiver(){} Reflect.set(module,'require',replacement,new Receiver());",
  "const Receiver=function(){}; Reflect.set(module,'require',replacement,new Receiver());",
  "Reflect.set(module,'require',replacement,new (class {constructor(){return 1;}})());",
  "Reflect.set(module,'require',replacement,new (function(){return this;})());",
])(
  "keeps the wrapper loader for distinct receivers or omitted keys: %s",
  (setup) => {
    expect(
      analyzeJavaScriptSemantics(
        `${setup} require('fs').readFileSync('kept');`,
      ).configurationOperations.map(({ key }) => key),
    ).toEqual(["kept"]);
  },
);

it.each([
  "Reflect.set(module,key,replacement);",
  "Reflect.set(...args);",
  "Reflect.set(module,'require',replacement,require('external'));",
  "Reflect.set(module,'require',replacement,require('node:path').owner);",
  "Reflect.set(module,'require',replacement,new (class {constructor(){return module;}})());",
  "Reflect.set(module,'require',replacement,new (function(){return module;})());",
  "Reflect.set(module,'require',replacement,new (class extends Base {})());",
  "Reflect.set(module,'require',replacement,new (class {constructor(){if(flag)return module;}})());",
  "let Receiver=class {}; Receiver=custom; Reflect.set(module,'require',replacement,new Receiver());",
  "Object.assign=custom; const box={safe:{id:1},owner:module}; Object.assign({},box.safe); Object.assign({},box.owner);",
  "Object.assign=custom; const box={safe:{id:1},owner:module}; Object.assign({},box.safe); Object.assign({},box);",
  "Object.assign=custom; let payload={id:1}; Object.assign({},payload); payload={owner:module}; Object.assign({},payload);",
])(
  "retains uncertainty after cached projections or unknown construction: %s",
  (setup) => {
    expect(
      analyzeJavaScriptSemantics(
        `${setup} require('fs').readFileSync('wrong');`,
      ).configurationOperations,
    ).toEqual([]);
  },
);

it.each([
  "let fs={}; outer:{ if(flag) break outer; fs=require('fs'); } fs.readFileSync('wrong');",
  "let fs={}; outer:{{ if(flag) break outer; fs=require('fs'); }} fs.readFileSync('wrong');",
  "let fs={}; outer:{ inner:{if(flag) break outer;} fs=require('fs');} fs.readFileSync('wrong');",
  "function run(){const r=Object.create(null); Reflect.set(r,'require',replacement); require('fs').readFileSync('wrong');} Object.create=()=>module; run();",
  "const run=()=>{const r=Object.create(null); Reflect.set(r,'require',replacement); require('fs').readFileSync('wrong');}; Object.create=()=>module; run();",
  "class C{value=(()=>{const r=Object.create(null); Reflect.set(r,'require',replacement); require('fs').readFileSync('wrong');})();} Object.create=()=>module; new C();",
  "while(flag){const r=Object.create(null); Reflect.set(r,'require',replacement); require('fs').readFileSync('wrong'); Object.create=()=>module;}",
  "function run(){const fs=require('fs'); Reflect.set(fs,'readFileSync',custom,{}); fs.readFileSync('wrong');} Reflect.set=(target,key,value)=>{target[key]=value}; run();",
])(
  "does not order skipped or repeated/deferred writes as definite: %s",
  (source) => {
    expect(analyzeJavaScriptSemantics(source).configurationOperations).toEqual(
      [],
    );
  },
);

it.each([
  "let fs=require('fs'); fs.readFileSync('kept'); outer:{if(flag)break outer; fs={};}",
  "function run(){const r=Object.create(null); Reflect.set(r,'require',replacement); require('fs').readFileSync('kept');} run();",
])(
  "keeps independently proven reads across control-flow barriers: %s",
  (source) => {
    expect(
      analyzeJavaScriptSemantics(source).configurationOperations.map(
        ({ key }) => key,
      ),
    ).toEqual(["kept"]);
  },
);

it.each([
  "const {id}=module; Object.assign=custom; Object.assign({},id);",
  "const {filename:name}=module; const alias=name; Object.assign=custom; Object.assign({},alias);",
  "const {id}=module; Reflect.set=custom; Reflect.set({},'x',id);",
  "Reflect.set=custom; Reflect.set({},'x',1);",
  "Reflect.set=custom; Reflect.set.call(null,{},'x',1);",
  "Reflect.set=custom; Reflect.set.apply(null,[{},'x',1]);",
  "const set=Reflect.set.bind(null,{},'x'); Reflect.set=custom; set(1);",
  "const r=Object.create(null); Object.create=custom; Reflect.set(module,'require',replacement,r);",
])(
  "keeps module-free opaque arguments and prior allocations separate: %s",
  (setup) => {
    expect(
      analyzeJavaScriptSemantics(
        `${setup} require('fs').readFileSync('kept');`,
      ).configurationOperations.map(({ key }) => key),
    ).toEqual(["kept"]);
  },
);

it.each([
  "module.id=module; const {id}=module; Object.assign=custom; Object.assign({},id);",
  "Object.assign=custom; const box={id:'text',owner:module}; const {id,owner}=box; Object.assign({},owner,id);",
  "Object.assign=custom; const {owner}={owner:module}; Object.assign({},owner);",
  "Object.assign=custom; const [owner]=[module]; Object.assign({},owner);",
  "Object.assign=custom; const {box:{owner}}={box:{owner:module}}; Object.assign({},owner);",
  "Reflect.set=custom; Reflect.set(module,'require',replacement);",
  "Reflect.set=custom; Reflect.set({},'x',{owner:module});",
  "Reflect.set=custom; const set=Reflect.set.bind(null,module); set('require',replacement);",
  "Object.create=custom; const r=Object.create(null); Reflect.set(module,'require',replacement,r);",
])(
  "retains wrapper exposure through projected and opaque arguments: %s",
  (setup) => {
    expect(
      analyzeJavaScriptSemantics(
        `${setup} require('fs').readFileSync('wrong');`,
      ).configurationOperations,
    ).toEqual([]);
  },
);

it.each([
  "const fs=require('fs'); Reflect.set(fs,'readFileSync',custom,{}); fs.readFileSync('kept'); Reflect.set=other;",
  "const fs=require('fs'); Reflect.set(fs,'readFileSync',custom,{}); Reflect.set=other; fs.readFileSync('kept');",
])("orders the Reflect intrinsic proof at invocation: %s", (source) => {
  expect(
    analyzeJavaScriptSemantics(source).configurationOperations.map(
      ({ key }) => key,
    ),
  ).toEqual(["kept"]);
});

it.each([
  "const proc=require('process'); Reflect.set(proc,'env',{},{}); const mode=proc.env.MODE;",
  "const proc=require('node:process'); Reflect.set(proc,'argv',[],{}); const mode=proc.env.MODE;",
])("honors explicit receivers for native process data slots: %s", (source) => {
  expect(
    analyzeJavaScriptSemantics(source).configurationOperations.map(
      ({ key }) => key,
    ),
  ).toEqual(["MODE"]);
});

it.each([
  "Reflect.set(proc,'env',{});",
  "Object.defineProperty(proc,'env',{set(value){this.proc.env={};}}); Reflect.set(proc,'env',{}, {proc});",
])("retains changed process descriptor effects: %s", (setup) => {
  expect(
    analyzeJavaScriptSemantics(
      `const proc=require('process'); ${setup} const mode=proc.env.MODE;`,
    ).configurationOperations,
  ).toEqual([]);
});

it.each([
  "const {promises:fsp}=require('fs'); patch(require('fs/promises'));",
  "const fsp=require('fs').promises; patch(require('fs/promises'));",
  "const {promises:fsp}=require('fs'); patch(require('fs'));",
  "const {promises:fsp}=require('fs'); patch(fsp);",
])("keeps escapes of saved objects effective: %s", (setup) => {
  expect(
    analyzeJavaScriptSemantics(`${setup} const h=fsp.open('wrong'); h.close();`)
      .resourceOperations,
  ).toEqual([]);
});

it.each([
  "Reflect.set(Object.create(null),'hook',1,{fs});",
  "const target=Object.create(null); Reflect.set(target,'hook',1,{fs});",
  "const target={__proto__:null}; Reflect.set(target,'hook',1,{fs});",
  "const target=Object.create(null); const alias=target; Reflect.set(alias,'hook',1,{fs});",
  "Object.defineProperty(Object.prototype,'statSync',{set(){this.readFileSync=custom;}}); Reflect.set(fs,'statSync',custom);",
  "fs.statSync('probe'); Reflect.set(fs,'readFileSync',custom,{});",
  "const target=Object.create(null); Reflect.set(target,'hook',1,{fs}); Reflect.set(target,'hook',2,{fs});",
])("preserves reads when the selected setter cannot run: %s", (setup) => {
  expect(
    analyzeJavaScriptSemantics(
      `const fs=require('fs'); ${setup} fs.readFileSync('kept');`,
    ).configurationOperations.map(({ key }) => key),
  ).toEqual(["kept"]);
});

it.each([
  "delete fs.statSync; Object.defineProperty(Object.prototype,'statSync',{set(){this.readFileSync=custom;}}); Reflect.set(fs,'statSync',custom);",
  "delete require('fs').statSync; Object.defineProperty(Object.prototype,'statSync',{set(){this.readFileSync=custom;}}); Reflect.set(fs,'statSync',custom);",
  "const target=Object.create(null,{hook:{set(){this.fs.readFileSync=custom;}}}); Reflect.set(target,'hook',1,{fs});",
  "const target=Object.create(null); Object.defineProperty(target,'hook',{set(){this.fs.readFileSync=custom;}}); Reflect.set(target,'hook',1,{fs});",
  "Object.create=()=>({set hook(v){this.fs.readFileSync=custom;}}); Reflect.set(Object.create(null),'hook',1,{fs});",
  "const target=Object.create(null); const alias=target; Object.defineProperty(alias,'hook',{set(){this.fs.readFileSync=custom;}}); Reflect.set(target,'hook',1,{fs});",
])("rechecks descriptors before excluding setter effects: %s", (setup) => {
  expect(
    analyzeJavaScriptSemantics(
      `const fs=require('fs'); ${setup} fs.readFileSync('wrong');`,
    ).configurationOperations,
  ).toEqual([]);
});

it.each([
  "let fs=require('fs'); fs.readFileSync('kept'); {fs={};}",
  "let fs=require('fs'); fs.readFileSync('kept'); {{{fs={};}}}",
  "let fs=require('fs'); {fs.readFileSync('kept'); {fs={};}}",
  "let fs; {fs=require('fs');} fs.readFileSync('kept');",
  "let fs={}; {fs=require('fs');} fs.readFileSync('kept');",
  "let fs=require('fs'); fs.readFileSync('kept'); if(flag){fs={};}",
])("retains reads before later nested initializers: %s", (source) => {
  expect(
    analyzeJavaScriptSemantics(source).configurationOperations.map(
      ({ key }) => key,
    ),
  ).toEqual(["kept"]);
});

it.each([
  "let fs=require('fs'); if(flag){fs={};} fs.readFileSync('wrong');",
  "let fs; if(flag){fs=require('fs');} fs.readFileSync('wrong');",
  "let fs=require('fs'); function later(){fs={};} fs.readFileSync('wrong');",
])(
  "keeps conditional and deferred initializer projection conservative: %s",
  (source) => {
    expect(analyzeJavaScriptSemantics(source).configurationOperations).toEqual(
      [],
    );
  },
);

it.each([
  "Object.assign=(target,source)=>{target.require=source.require;}; Object.assign(module,{require:replacement});",
  "Object.defineProperty=(target,key,descriptor)=>{target[key]=descriptor.value;}; Object.defineProperty(module,'require',{value:replacement});",
  "Object.defineProperties=(target,descriptors)=>{target.require=descriptors.require.value;}; Object.defineProperties(module,{require:{value:replacement}});",
  "Object.assign=(target,source)=>{target.require=source.require;}; Object.assign.call(null,module,{require:replacement});",
  "Object.assign=(target,source)=>{target.require=source.require;}; Object.assign.apply(null,[module,{require:replacement}]);",
  "const owner=module; Object.assign=custom; Object.assign(owner,{require:replacement});",
  "Object.assign=custom; const args=[module,{require:replacement}]; Object.assign.apply(null,args);",
  "Object.assign=custom; const patch=Object.assign.bind(null,module); patch({require:replacement});",
])(
  "retains delegate invalidation through opaque Object mutators: %s",
  (mutation) => {
    expect(
      analyzeJavaScriptSemantics(
        `${mutation} require('fs').readFileSync('wrong');`,
      ).configurationOperations,
    ).toEqual([]);
  },
);

it.each([
  "Object.assign(module, { [key]: replacement });",
  "Object.assign(module, { ...replacement });",
  "Object.assign(module, { require() {} });",
  "Object.defineProperties(module, { [key]: { value: replacement } });",
  "Reflect.set(module, 'require', replacement);",
  "Reflect.set(module, key, replacement);",
  "Reflect.set({}, 'require', replacement, module);",
  "const receiver=module; Reflect.set({}, 'require', replacement, receiver);",
  "Reflect.set(module, 'require', replacement, receiver);",
  "Reflect.set(module, 'require', replacement, ...receivers);",
  "Reflect.apply(Reflect.set, null, [{}, 'require', replacement, module]);",
  "const set=Reflect.set.bind(null, {}, 'require', replacement); set(module);",
  "Object.defineProperty(module, 'require', {value: replacement}, {});",
  "let owner=module; owner.require=replacement; owner={};",
  "Object.create=()=>module; const registry=Object.create(null); Reflect.set(registry, key, replacement);",
  "function Object(){}; Object.create=()=>module; Reflect.set(Object.create(null), key, replacement);",
  "const receiver=require('./local'); Reflect.set(receiver, 'require', replacement);",
  "let receiver=require('fs'); receiver=module; Reflect.set(receiver, 'require', replacement);",
  "Object.create.call=()=>module; const registry=Object.create.call(null,null); Reflect.set(registry,'require',replacement);",
  "Object.create.apply=()=>module; const registry=Object.create.apply(null,[null]); Reflect.set(registry,'require',replacement);",
  "Object.create.bind=()=>()=>module; const make=Object.create.bind(null,null); Reflect.set(make(),'require',replacement);",
])("invalidates the wrapper loader at its write: %s", (write) => {
  const ir = analyzeJavaScriptSemantics(`${write}
    const fs=require('fs'); fs.readFileSync('wrong');`);
  expect(ir.configurationOperations).toEqual([]);
});

it.each([
  "Object.assign(module, { unrelated: replacement });",
  "Object.defineProperties(module, { unrelated: { value: replacement } });",
  "Reflect.set(module, 'unrelated', replacement);",
  "const registry=Object.create(null); Reflect.set(registry, key, replacement);",
  "const registry=Object.create(module); Reflect.set(registry, 'require', replacement);",
  "const fs=require('node:fs'); Reflect.set(fs, 'require', replacement);",
  "const fs=require('fs'); const receiver=fs; Reflect.set(module, 'require', replacement, receiver);",
  "let receiver=module; receiver=require('fs'); Reflect.set(receiver, 'require', replacement);",
  "Reflect.set(module, 0, replacement);",
  "Reflect.set(module, -0, replacement);",
  "Reflect.set(module, true, replacement);",
  "Reflect.set(module, null, replacement);",
  "Reflect.set(module, undefined, replacement);",
  "Reflect.set(module, void 0, replacement);",
  "Reflect.set(module, 1n, replacement);",
  "const key=0; Reflect.set(module, key, replacement);",
  "Reflect.set(module, 'require', replacement, {});",
  "const receiver={}; Reflect.set(module, 'require', replacement, receiver);",
  "Reflect.set(module, 'require', replacement, null);",
  "Reflect.set(module, 'require', replacement, undefined);",
  "Reflect.set(module, 'require', replacement, -1);",
  "Reflect.set(module, 'require', replacement, +value);",
  "Reflect.set(module, 'require', replacement, !value);",
  "Reflect.set(module, 'require', replacement, ~value);",
  "Reflect.set(module, 'require', replacement, typeof value);",
  "Reflect.apply(Reflect.set, null, [module, 'require', replacement, {}]);",
  "const set=Reflect.set.bind(null, module, 'require', replacement); set({});",
  "let owner=module; owner={}; owner.require=replacement;",
])("preserves the wrapper loader across unrelated writes: %s", (write) => {
  const ir = analyzeJavaScriptSemantics(`${write}
    require('fs').readFileSync('kept');`);
  expect(ir.configurationOperations.map(({ key }) => key)).toEqual(["kept"]);
});

it.each(["globalThis", "global", "self", "window"])(
  "recognizes an unchanged qualified process receiver: %s",
  (global) => {
    const ir = analyzeJavaScriptSemantics(`${global}.process.cwd();
      const proc=require('process'); const mode=proc.env.MODE;`);
    expect(ir.configurationOperations.map(({ key }) => key)).toEqual(["MODE"]);
  },
);

it.each([
  "let fs=require('fs'); fs.readFileSync('kept'); fs={};",
  "let read=require('fs').readFileSync; read('kept'); read=custom;",
  "let proc=require('process'); const mode=proc.env.kept; proc={};",
  "const fs=require('fs'); fs.readFileSync('kept'); if(flag) { fs.readFileSync=custom; }",
  "const fs=require('fs'); if(flag) { fs.readFileSync('kept'); } fs.readFileSync=custom;",
  "const fs=require('fs'); { fs.readFileSync('kept'); } if(flag) { fs.readFileSync=custom; }",
])("retains a builtin read before a later effect: %s", (source) => {
  const ir = analyzeJavaScriptSemantics(source);
  expect(ir.configurationOperations.map(({ key }) => key)).toEqual(["kept"]);
});

it.each([
  "const fs=require('fs'); if(flag) { fs.readFileSync=custom; } fs.readFileSync('wrong');",
  "const fs=require('fs'); function later() { fs.readFileSync('wrong'); } fs.readFileSync=custom;",
  "const fs=require('fs'); for(;;) { fs.readFileSync('wrong'); fs.readFileSync=custom; }",
  "const fs=require('fs'); class C { value=fs.readFileSync('wrong'); } fs.readFileSync=custom;",
])("keeps conditional and delayed writes conservative: %s", (source) => {
  expect(analyzeJavaScriptSemantics(source).configurationOperations).toEqual(
    [],
  );
});

it.each([
  "statSync",
  "readdirSync",
  "mkdirSync",
  "accessSync",
  "lstatSync",
  "realpathSync",
])("does not escape the namespace through native fs.%s", (method) => {
  const ir =
    analyzeJavaScriptSemantics(`const fs=require('fs'); fs.${method}('probe');
      fs.readFileSync('kept');`);
  expect(ir.configurationOperations.map(({ key }) => key)).toEqual(["kept"]);
});

it.each(["stat", "readdir", "mkdir"])(
  "does not escape the namespace through native promises.%s",
  (method) => {
    const ir =
      analyzeJavaScriptSemantics(`const fs=require('fs/promises'); fs.${method}('probe');
      fs.open('kept');`);
    expect(ir.resourceOperations.map(({ method }) => method)).toEqual(["open"]);
  },
);

// Public filesystem functions outside the original synchronous subset.
// Constructors and private exports are deliberately not receiver guarantees.
it.each([
  "exists",
  "glob",
  "globSync",
  "mkdtempDisposableSync",
  "openAsBlob",
  "watch",
  "watchFile",
  "unwatchFile",
  "createReadStream",
  "createWriteStream",
])("retains native fs reads after public fs.%s calls", (method) => {
  for (const specifier of ["fs", "node:fs"]) {
    const ir = analyzeJavaScriptSemantics(`const fs=require('${specifier}');
      fs.${method}('probe'); fs.readFileSync('kept');`);
    expect(ir.configurationOperations.map(({ key }) => key)).toContain("kept");
    const replaced =
      analyzeJavaScriptSemantics(`const fs=require('${specifier}');
      fs.${method}=custom; fs.${method}('probe'); fs.readFileSync('wrong');`);
    expect(replaced.configurationOperations).toEqual([]);
  }
});

it.each(["glob", "mkdtempDisposable", "lchmod", "watch"])(
  "retains native promises reads after public promises.%s calls",
  (method) => {
    for (const imported of [
      "const fs=require('node:fs/promises');",
      "const fs=require('fs').promises;",
      "import * as fs from 'node:fs/promises';",
    ]) {
      const ir = analyzeJavaScriptSemantics(
        `${imported} fs.${method}('probe'); fs.open('kept');`,
      );
      expect(ir.resourceOperations.map(({ method }) => method)).toContain(
        "open",
      );
    }
  },
);

it.each([";", ","])(
  "orders repeated writes and reads with %s separators",
  (separator) => {
    const keys = Array.from({ length: 64 }, (_, i) => `kept-${i}`);
    const operations = keys.map(
      (key) => `fs=require('fs'),fs.readFileSync('${key}'),fs={}`,
    );
    const ir = analyzeJavaScriptSemantics(
      `let fs; ${operations.join(separator)};`,
    );
    expect(ir.configurationOperations.map(({ key }) => key)).toEqual(keys);
  },
);

it.each([
  "let fs=require('fs'); fs=(fs.readFileSync('kept'),{}),fs.readFileSync('wrong');",
  "let fs; fs=require('fs'),fs={},fs.readFileSync('wrong');",
  "let fs=require('fs'); {fs={}; fs.readFileSync('wrong');}",
  "let fs=require('fs'); function later(){fs.readFileSync('wrong');} fs={};",
])("retains assignment completion and activation boundaries: %s", (source) => {
  expect(
    analyzeJavaScriptSemantics(source).configurationOperations.map(
      ({ key }) => key,
    ),
  ).toEqual(source.includes("'kept'") ? ["kept"] : []);
});

it("keeps a replaced native receiver uncertain", () => {
  const ir = analyzeJavaScriptSemantics(`const fs=require('fs');
    fs.statSync=custom; fs.statSync('probe'); fs.readFileSync('wrong');`);
  expect(ir.configurationOperations).toEqual([]);
});

it.each([
  "Reflect.set(fs, 'readFileSync', custom);",
  "Reflect.set(fs, key, custom);",
  "Reflect.set = custom; Reflect.set(fs, 'require', replacement);",
  "Object.defineProperty(fs, 'require', {set(value) {fs.readFileSync=custom;}}); Reflect.set(fs, 'require', replacement);",
  "Reflect.set.call=()=>{fs.readFileSync=custom}; Reflect.set.call(null, fs, 'require', replacement);",
  "Reflect.set.apply=()=>{fs.readFileSync=custom}; Reflect.set.apply(null, [fs, 'require', replacement]);",
  "const target={fs,set hook(value){this.fs.readFileSync=custom;}}; Reflect.set(target, 'hook', 1);",
  "const target={fs,set hook(value){this.fs.readFileSync=custom;}}; Reflect.set(target, key, 1);",
  "const target={set hook(value){this.fs.readFileSync=custom;}}; Reflect.set(target, 'hook', 1, {fs});",
])("keeps builtin mutations through Reflect.set conservative: %s", (write) => {
  expect(
    analyzeJavaScriptSemantics(
      `const fs=require('fs'); ${write} require('fs').readFileSync('wrong');`,
    ).configurationOperations,
  ).toEqual([]);
});

it.each(["process", "proc"])(
  "retains scalar process reads passed to calls: %s",
  (receiver) => {
    const ir = analyzeJavaScriptSemantics(`const proc=require('process');
    const port=Number(${receiver}.env.PORT); consume(${receiver}.argv[2]);`);
    expect(ir.configurationOperations.map(({ key }) => key)).toEqual([
      "PORT",
      "2",
    ]);
  },
);

it("tracks process writes through self-reassigned global aliases", () => {
  const ir =
    analyzeJavaScriptSemantics(`let host=globalThis; host=host.globalThis;
    host.process.env={}; const proc=require('process'); const value=proc.env.MODE;`);
  expect(ir.configurationOperations).toEqual([]);
});

it("retains each builtin read across repeated assignments and later writes", () => {
  const keys = Array.from({ length: 32 }, (_, index) => `kept-${index}`);
  const ir = analyzeJavaScriptSemantics(`let fs;
    ${keys.map((key) => `fs=require('fs'); fs.readFileSync('${key}'); fs={};`).join("\n")}
    fs=require('fs'); fs.readFileSync=custom; fs.readFileSync('wrong');`);
  expect(ir.configurationOperations.map(({ key }) => key)).toEqual(keys);
});

it.each([
  "import fs = require('fs'); fs={}; fs={}; fs.readFileSync('wrong');",
  "import fs = require('fs'); fs={},fs={}; fs.readFileSync('wrong');",
])("drops entry origins after definite replacement: %s", (source) => {
  expect(analyzeJavaScriptSemantics(source).configurationOperations).toEqual(
    [],
  );
});

it.each([
  "const fs=require('fs'); Reflect.set(fs,'readFileSync',custom,{}); fs.readFileSync('kept');",
  "const fs=require('fs'); const receiver={}; Reflect.set(fs,'readFileSync',custom,receiver); fs.readFileSync('kept');",
  "let fs=require('fs'); { fs.readFileSync('kept'); } fs={};",
  "let fs=require('fs'); { { fs.readFileSync('kept'); } } fs={};",
  "let fs=require('fs'); if(flag) { fs.readFileSync('kept'); } fs={};",
  "let fs; fs=require('fs'),fs.readFileSync('kept'); fs={};",
])(
  "retains ordered reads across receiver and statement boundaries: %s",
  (source) => {
    expect(
      analyzeJavaScriptSemantics(source).configurationOperations.map(
        ({ key }) => key,
      ),
    ).toEqual(["kept"]);
  },
);

it.each(["key", "'__proto__'"])(
  "retains uncertainty when a required argv object escapes through %s",
  (key) => {
    const ir = analyzeJavaScriptSemantics(`const proc=require('node:process');
      function run() { patch(proc.argv[${key}]); return proc.argv[3]; }`);
    expect(ir.configurationOperations.map(({ key }) => key)).not.toContain("3");
  },
);

it("retains a nested builtin read before receiver reassignment", () => {
  const ir = analyzeJavaScriptSemantics(`let fs=require('fs');
    fs.promises.open('kept'); fs={};`);
  expect(ir.resourceOperations.map(({ method }) => method)).toEqual(["open"]);
});

it("checks the parent promises slot for fresh require chains", () => {
  const ir =
    analyzeJavaScriptSemantics(`const fs=require('fs'); delete fs.promises;
    require('fs').promises.open('wrong');`);
  expect(ir.resourceOperations).toEqual([]);
});

it.each([
  "const target={__proto__:{set hook(v){this.fs.readFileSync=custom;}}}; Reflect.set(target,'hook',1,{fs});",
  "const target={fs,__proto__:{set hook(v){this.fs.readFileSync=custom;}}}; Reflect.set(target,'hook',1);",
  "const proto={set hook(v){this.fs.readFileSync=custom;}}; const target=Object.create(proto); Reflect.set(target,'hook',1,{fs});",
  "const target=getTarget(); Reflect.set(target,'hook',1,{fs});",
  "const target=require('./custom'); Reflect.set(target,'hook',1,{fs});",
  "const target={hook:0}; const alias=target; Object.defineProperty(alias,'hook',{set(v){this.fs.readFileSync=custom;}}); Reflect.set(target,'hook',1,{fs});",
  "const target={hook:0,set [key](v){this.fs.readFileSync=custom;}}; Reflect.set(target,'hook',1,{fs});",
  "const target={__proto__:{set __proto__(v){this.fs.readFileSync=custom;}}}; Reflect.set(target,'__proto__',1,{fs});",
])("preserves inherited or unknown Reflect setter effects: %s", (setup) => {
  expect(
    analyzeJavaScriptSemantics(
      `const fs=require('fs'); ${setup} fs.readFileSync('wrong');`,
    ).configurationOperations,
  ).toEqual([]);
});

it.each([
  "const target={hook:0,__proto__:{set hook(v){this.fs.readFileSync=custom;}}}; Reflect.set(target,'hook',1,{fs});",
  "Reflect.set({hook:0},'hook',1,{fs});",
  "const owner=module; Reflect.set(owner,'require',custom,fs);",
  "const target={hook:0,...props}; Reflect.set(target,'hook',1,{fs});",
])(
  "keeps a proven own data property separate from inherited setters: %s",
  (setup) => {
    expect(
      analyzeJavaScriptSemantics(
        `const fs=require('fs'); ${setup} fs.readFileSync('kept');`,
      ).configurationOperations.map(({ key }) => key),
    ).toEqual(["kept"]);
  },
);

it.each([
  "const {promises:fsp}=require('fs'); delete require('fs').promises;",
  "const fs=require('fs'); const {promises:fsp}=fs; delete fs.promises;",
  "const fs=require('fs'); let {promises:fsp}=fs; delete fs.promises;",
  "const {promises:fsp}=require('node:fs'); require('fs').promises={};",
])(
  "retains destructured objects after replacing their parent slot: %s",
  (setup) => {
    const ir = analyzeJavaScriptSemantics(
      `${setup} const h=fsp.open('kept'); h.close();`,
    );
    expect(ir.resourceOperations.map(({ method }) => method)).toEqual([
      "open",
      "close",
    ]);
  },
);

it.each([
  "delete require('fs').promises; const {promises:fsp}=require('fs');",
  "const {promises:fsp}=require('fs'); fsp.open=custom;",
  "const {promises:fsp}=require('fs'); require('fs/promises').open=custom;",
])(
  "keeps capture-before-write distinct from changed child methods: %s",
  (setup) => {
    expect(
      analyzeJavaScriptSemantics(`${setup} fsp.open('wrong');`)
        .resourceOperations,
    ).toEqual([]);
  },
);

it.each([
  "const tls=require('tls'); const net=require('net');",
  "const tls=require('node:tls'); const net=require('node:net');",
  "import * as tls from 'node:tls'; import * as net from 'node:net';",
])("distinguishes TLS and net acquisition methods: %s", (imports) => {
  const ir = analyzeJavaScriptSemantics(`${imports}
    tls.connect(443); tls.createConnection(443);
    net.connect(80); net.createConnection(80);`);
  expect(ir.resourceOperations.map(({ method }) => method)).toEqual([
    "connect",
    "connect",
    "createConnection",
  ]);
});

it.each(["spawnSync", "execSync", "execFileSync"])(
  "retains asynchronous child effects alongside native %s",
  (method) => {
    const ir = analyzeJavaScriptSemantics(`const cp=require('child_process');
      function asyncRun() { return cp.spawn('tool'); }
      function syncRun() { return cp.${method}('tool'); }`);
    expect(ir.childProcessSpawns.map(({ method }) => method)).toEqual([
      "spawn",
    ]);
  },
);

it.each([
  "module.require=other;",
  "delete module.require;",
  "Object.defineProperty(module,'require',{set(value){}});",
  "module={};",
])("keeps wrapper descriptor timing before later writes: %s", (later) => {
  const ir = analyzeJavaScriptSemantics(`const fs=require('fs');
    Reflect.set(module,'require',replacement,{fs});
    fs.readFileSync('kept'); ${later}`);
  expect(ir.configurationOperations.map(({ key }) => key)).toEqual(["kept"]);
});

it.each([
  "const fs=require('fs'); Object.defineProperty(module,'require',{set(value){this.fs.readFileSync=custom;}}); Reflect.set(module,'require',replacement,{fs}); fs.readFileSync('wrong');",
  "const fs=require('fs'); function run(){Reflect.set(module,'require',replacement,{fs}); fs.readFileSync('wrong');} Object.defineProperty(module,'require',{set(value){this.fs.readFileSync=custom;}}); run();",
])("keeps uncertain wrapper descriptor timing conservative: %s", (source) => {
  expect(analyzeJavaScriptSemantics(source).configurationOperations).toEqual(
    [],
  );
});

it.each([
  "Reflect.set=Reflect.set.bind(null,module); Reflect.set('require',replacement);",
  "Object.assign=Object.assign.bind(null,module); Object.assign({require:replacement});",
  "const set=Reflect.set; Reflect.set=set.bind(null,module); Reflect.set('require',replacement);",
  "Reflect.set=Reflect.set.bind(null,module); Reflect.set.call(null,'require',replacement);",
  "Reflect.set=Reflect.set.bind(null,module); Reflect.set.apply(null,['require',replacement]);",
  "const reflect=Reflect; reflect.set=Reflect.set.bind(null,module); Reflect.set('require',replacement);",
  "Reflect.set=Reflect.set.bind(null,module); const set=Reflect.set; set('require',replacement);",
  "globalThis.Reflect.set=Reflect.set.bind(null,module); Reflect.set('require',replacement);",
  "const set=Reflect.set; globalThis.Reflect={set:set.bind(null,module)}; Reflect.set('require',replacement);",
  "Reflect[key]=Reflect.set.bind(null,module); Reflect.set('require',replacement);",
  "Reflect.set=Reflect.set.bind(null,module); Reflect.apply(Reflect.set,null,['require',replacement]);",
  "Reflect.set=flag ? Reflect.set.bind(null,module) : other; Reflect.set('require',replacement);",
  "Reflect.set=flag && Reflect.set.bind(null,module); Reflect.set('require',replacement);",
  "Reflect.set=(0,Reflect.set.bind(null,module)); Reflect.set('require',replacement);",
  "Reflect.set=holder=Reflect.set.bind(null,module); Reflect.set('require',replacement);",
])(
  "follows assigned intrinsic values carrying the wrapper module: %s",
  (setup) => {
    expect(
      analyzeJavaScriptSemantics(
        `${setup} require('fs').readFileSync('wrong');`,
      ).configurationOperations,
    ).toEqual([]);
  },
);

it.each([
  "Reflect.set=Reflect.set.bind(null,{}); Reflect.set('require',replacement); require('fs').readFileSync('kept');",
  "Reflect.other=Reflect.set.bind(null,module); Reflect.set({},'require',replacement); require('fs').readFileSync('kept');",
  "const set=Reflect.set; Reflect.set=Reflect.set.bind(null,module); set({},'require',replacement); require('fs').readFileSync('kept');",
  "Reflect.set({},'require',replacement); require('fs').readFileSync('kept'); Reflect.set=Reflect.set.bind(null,module);",
  "Reflect.set=(Reflect.set.bind(null,module),custom); Reflect.set({},'require',replacement); require('fs').readFileSync('kept');",
  "Reflect.set=Reflect.set.bind(null,{}); function run(){Reflect.set('require',replacement); require('fs').readFileSync('kept');} run();",
])(
  "keeps unrelated or later assigned intrinsic values separate: %s",
  (source) => {
    expect(
      analyzeJavaScriptSemantics(source).configurationOperations.map(
        ({ key }) => key,
      ),
    ).toEqual(["kept"]);
  },
);

it.each([
  "Reflect.set(fs,'readFileSync',custom);",
  "Reflect.set(fs,'readFileSync',custom,{});",
  "Reflect.set.call(null,fs,'readFileSync',custom);",
  "Reflect.set.apply(null,[fs,'readFileSync',custom]);",
  "const set=Reflect.set.bind(null,fs); set('readFileSync',custom);",
  "const alias=fs; Reflect.set(alias,'readFileSync',custom);",
  "Reflect.set((0,fs),'readFileSync',custom);",
  "Reflect.set(fs,'readFileSync',custom,{fs});",
  "Reflect.set(fs,key,custom);",
])(
  "preserves native module namespace exports after a failed set: %s",
  (write) => {
    const ir = analyzeJavaScriptSemantics(
      `import * as fs from 'node:fs'; ${write} fs.readFileSync('kept');`,
    );
    expect(ir.configurationOperations.map(({ key }) => key)).toEqual(["kept"]);
  },
);

it.each([
  "import fs from 'node:fs'; Reflect.set(fs,'readFileSync',custom);",
  "import {default as fs} from 'node:fs'; Reflect.set(fs,'readFileSync',custom);",
  "const fs=require('node:fs'); Reflect.set(fs,'readFileSync',custom);",
  "import * as ns from 'node:fs'; const fs=ns.default; Reflect.set(fs,'readFileSync',custom);",
  "import * as fs from 'node:fs'; Reflect.set=custom; Reflect.set(fs,'readFileSync',custom);",
])(
  "keeps mutable exports and replaced set functions conservative: %s",
  (source) => {
    expect(
      analyzeJavaScriptSemantics(`${source} fs.readFileSync('wrong');`)
        .configurationOperations,
    ).toEqual([]);
  },
);

it.each(["1+2", "2*3", "1n+2n", "2>1", "1===2", "`value-${1+2}`", "(0,1+2)"])(
  "keeps primitive expression receivers separate from the wrapper: %s",
  (receiver) => {
    expect(
      analyzeJavaScriptSemantics(
        `Reflect.set(module,'require',replacement,${receiver}); require('fs').readFileSync('kept');`,
      ).configurationOperations.map(({ key }) => key),
    ).toEqual(["kept"]);
  },
);

it.each([
  'const value=1+2; Reflect.set(module,"require",replacement,value);',
  'let value; Reflect.set(module,"require",replacement,value=1+2);',

  'Reflect.set.apply(null,[module,"require",replacement,1+2]);',
])(
  "retains primitive receiver results through bindings and invocation forms: %s",
  (setup) => {
    expect(
      analyzeJavaScriptSemantics(
        `${setup} require('fs').readFileSync('kept');`,
      ).configurationOperations.map(({ key }) => key),
    ).toEqual(["kept"]);
  },
);

it.each([
  'Reflect.set(module,"require",replacement,(module.require=replacement,1+2));',
  'Reflect.set(module,"require",replacement,1+(module.require=replacement,2));',
  'Reflect.set(module,"require",replacement,(0,module));',
  'let receiver; Reflect.set(module,"require",replacement,receiver=module);',
  'Reflect.set(module,"require",replacement,flag?3:module);',
])(
  "does not discard receiver evaluation effects or possible wrapper identity: %s",
  (setup) => {
    expect(
      analyzeJavaScriptSemantics(
        `${setup} require('fs').readFileSync('wrong');`,
      ).configurationOperations,
    ).toEqual([]);
  },
);

it.each([
  "Function.prototype.bind=custom; const set=Reflect.set.bind(null,fs); set('readFileSync',custom);",
  "Reflect.set.bind=custom; const set=Reflect.set.bind(null,fs); set('readFileSync',custom);",
  "const set=Reflect.set.bind(null,fs); set('readFileSync',custom);",
])(
  "keeps opaque binding and mutable bound targets conservative: %s",
  (setup) => {
    expect(
      analyzeJavaScriptSemantics(
        `const fs=require('fs');${setup}fs.readFileSync('wrong');`,
      ).configurationOperations,
    ).toEqual([]);
  },
);

it.each([
  "remove();",
  "remove.call(null);",
  "remove.apply(null,[]);",
  "const again=remove.bind(null);again();",
])("retains captured inputs of generic intrinsic calls: %s", (invoke) => {
  expect(
    analyzeJavaScriptSemantics(
      `const fs=require('fs');const remove=Reflect.deleteProperty.bind(null,fs,'readFileSync');${invoke}fs.readFileSync('wrong');`,
    ).configurationOperations,
  ).toEqual([]);
});

it("keeps reads before a generic bound intrinsic is called", () => {
  expect(
    analyzeJavaScriptSemantics(
      `const fs=require('fs');const remove=Reflect.deleteProperty.bind(null,fs,'readFileSync');fs.readFileSync('kept');remove();fs.readFileSync('wrong');`,
    ).configurationOperations.map(({ key }) => key),
  ).toEqual(["kept"]);
});

it("does not invoke an intrinsic merely by binding its target", () => {
  expect(
    analyzeJavaScriptSemantics(
      `const fs=require('fs');const set=Reflect.set.bind(null,fs,'readFileSync',custom);fs.readFileSync('kept');set();fs.readFileSync('wrong');`,
    ).configurationOperations.map(({ key }) => key),
  ).toEqual(["kept"]);
});

it.each([
  "import * as fs from 'node:fs'; Reflect.set(fs,'readFileSync',custom,fs); fs.readFileSync('kept');",
  "import * as fs from 'node:fs'; const alias=fs; Reflect.set(fs,'readFileSync',custom,alias); fs.readFileSync('kept');",
])("preserves namespace-valued explicit receivers: %s", (source) => {
  expect(
    analyzeJavaScriptSemantics(source).configurationOperations.map(
      ({ key }) => key,
    ),
  ).toEqual(["kept"]);
});

it("retains writes to a distinct mutable receiver of a namespace target", () => {
  expect(
    analyzeJavaScriptSemantics(
      `import * as ns from 'node:fs';const fs=ns.default;Reflect.set(ns,'readFileSync',custom,fs);fs.readFileSync('wrong');`,
    ).configurationOperations,
  ).toEqual([]);
});

it.each([
  "const value={owner:module,valueOf(){this.owner.require=replacement;return 1;}};Reflect.set(module,'require',replacement,value+1);",
  "const value={owner:module,toString(){this.owner.require=replacement;return '1';}};Reflect.set(module,'require',replacement,`${value}`);",
])(
  "preserves implicit coercion effects of primitive-valued receivers: %s",
  (source) => {
    expect(
      analyzeJavaScriptSemantics(
        `${source}require('fs').readFileSync('wrong');`,
      ).configurationOperations,
    ).toEqual([]);
  },
);

it.each(["+value", "~value", "(value+1,1+2)"])(
  "retains module-bearing coercion operands: %s",
  (receiver) => {
    expect(
      analyzeJavaScriptSemantics(
        `const value={owner:module,valueOf(){this.owner.require=replacement;return 1;}};Reflect.set(module,'require',replacement,${receiver});require('fs').readFileSync('wrong');`,
      ).configurationOperations,
    ).toEqual([]);
  },
);

it.each([
  "Reflect.defineProperty(holder,'child',{value:{}});",
  "Reflect.defineProperty.call(null,holder,'child',{value:{}});",
  "Reflect.defineProperty.apply(null,[holder,'child',{value:{}}]);",
  "const define=Reflect.defineProperty.bind(null,holder,'child');define({value:{}});",
  "const define=Reflect.defineProperty;define(holder,'child',{value:{}});",
  "const alias=holder;Reflect.defineProperty(alias,'child',{value:{}});",
  "Reflect.set(holder,'child',{});",
  "Reflect.set.call(null,holder,'child',{});",
  "Reflect.set.apply(null,[holder,'child',{}]);",
  "const set=Reflect.set.bind(null,holder,'child');set({});",
  "const set=Reflect.set;set(holder,'child',{});",
  "const alias=holder;Reflect.set(alias,'child',{});",
  "Reflect.set(holder,'child',{},holder);",
  "const receiver=holder;Reflect.set(holder,'child',{},receiver);",
  "Reflect.set(holder,'child',{},(0,holder));",
  "Reflect.set((0,holder),'child',{});",
  "holder.other={};Reflect.set(holder,'child',{});",
  "holder.child={};Reflect.set(holder,'child',{});",
  "Reflect.set(holder,'child',{});Reflect.defineProperty(holder,'child',{value:{}});",
  "Reflect.defineProperty(holder,'child',{value:{}});Reflect.set(holder,'child',{});",
  "Object.defineProperty(holder,'child',{value:{},configurable:false});Reflect.defineProperty(holder,'child',{value:{}});",
])("preserves a completed native allocation replacement: %s", (write) => {
  expect(
    analyzeJavaScriptSemantics(
      `const holder={child:{}},box={};box.owner=holder.child;${write}holder.child.owner=module;Object.assign=(t,v)=>{if(v.owner)v.owner.require=replacement};Object.assign({},box.owner);require('fs').readFileSync('kept');`,
    ).configurationOperations.map(({ key }) => key),
  ).toEqual(["kept"]);
});

it.each([
  "Reflect.set(holder,'child',{},{});",
  "Reflect.set.call(null,holder,'child',{},{});",
  "Reflect.set.apply(null,[holder,'child',{},{}]);",
  "const set=Reflect.set.bind(null,holder,'child',{});set({});",
  "Object.defineProperty(holder,'child',{writable:false});holder.child={};",
  "Object.freeze(holder);holder.child={};",
  "Object.defineProperty(holder,'child',{writable:false});Reflect.set(holder,'child',{});",
  "Object.defineProperty(holder,'child',{writable:false,configurable:false});Reflect.defineProperty(holder,'child',{value:{}});",
  "Object.freeze(holder);Reflect.set(holder,'child',{},holder);",
  "Object.freeze(holder);Reflect.defineProperty(holder,'child',{value:{}});",
  "delete holder.child;Object.defineProperty(holder,'child',{value:{}});box.owner=holder.child;Reflect.set(holder,'child',{});",
  "Object.prototype.writable=false;Object.defineProperty(holder,'child',{value:{}});box.owner=holder.child;Reflect.set(holder,'child',{});",
])(
  "does not use possible or failed writes as completed allocation replacements: %s",
  (write) => {
    expect(
      analyzeJavaScriptSemantics(
        `const holder={child:{}},box={};box.owner=holder.child;${write}holder.child.owner=module;Object.assign=(t,v)=>{if(v.owner)v.owner.require=replacement};Object.assign({},box.owner);require('fs').readFileSync('wrong');`,
      ).configurationOperations,
    ).toEqual([]);
  },
);

it.each([
  "const other={}; const alias=flag?holder:other;alias.child={};",
  "let alias=holder;if(flag)alias={};alias.child={};",
  "const other={}; const alias=flag?holder:other;Object.defineProperty(alias,'child',{value:{}});",
])(
  "does not promote a possible write target to definite allocation identity: %s",
  (write) => {
    expect(
      analyzeJavaScriptSemantics(
        `const holder={child:{}},box={};box.owner=holder.child;${write}holder.child.owner=module;Object.assign=custom;Object.assign({},box.owner);require('fs').readFileSync('wrong');`,
      ).configurationOperations,
    ).toEqual([]);
  },
);

it.each([
  "const set=Reflect.set.bind(null,holder,'child',{});holder={child:{}};box.owner=holder.child;set();",
  "const define=Reflect.defineProperty.bind(null,holder,'child',{value:{}});holder={child:{}};box.owner=holder.child;define();",
  "const define=Object.defineProperty.bind(null,holder,'child',{value:{}});holder={child:{}};box.owner=holder.child;define();",
])(
  "retains the target captured before a binding is reassigned: %s",
  (setup) => {
    expect(
      analyzeJavaScriptSemantics(
        `let holder={child:{}};const box={};${setup}holder.child.owner=module;Object.assign=(t,v)=>{if(v.owner)v.owner.require=replacement};Object.assign({},box.owner);require('fs').readFileSync('wrong');`,
      ).configurationOperations,
    ).toEqual([]);
  },
);

it.each(
  [
    "Reflect.set.bind(null,holder.inner,'child',{})",
    "Reflect.defineProperty.bind(null,holder.inner,'child',{value:{}})",
    "Object.defineProperty.bind(null,holder.inner,'child',{value:{}})",
  ].flatMap((capture) =>
    [false, true].map((retarget) => ({ capture, retarget })),
  ),
)(
  "preserves captured member target identity: $capture, $retarget",
  ({ capture, retarget }) => {
    const reassign = retarget ? "holder.inner={child:{}};" : "";
    expect(
      analyzeJavaScriptSemantics(
        `const holder={inner:{child:{}}},box={};const replace=${capture};${reassign}box.owner=holder.inner.child;replace();holder.inner.child.owner=module;Object.assign=custom;Object.assign({},box.owner);require('fs').readFileSync('kept');`,
      ).configurationOperations.map(({ key }) => key),
    ).toEqual(retarget ? [] : ["kept"]);
  },
);

it.each([
  "Reflect.set=(Reflect.set(fs,'readFileSync',custom,{}),other);",
  "Object.assign(Reflect,{set:(Reflect.set(fs,'readFileSync',custom,{}),other)});",
  "Reflect.defineProperty(Reflect,'set',{value:(Reflect.set(fs,'readFileSync',custom,{}),other)});",
])(
  "evaluates nested inputs before the enclosing intrinsic replacement: %s",
  (write) => {
    expect(
      analyzeJavaScriptSemantics(
        `const fs=require('fs');${write}fs.readFileSync('kept');`,
      ).configurationOperations.map((x) => x.key),
    ).toEqual(["kept"]);
  },
);
it.each([
  "Reflect.set=other;Reflect.set(fs,'readFileSync',custom,{});",
  "Reflect.set=(Reflect.set(fs,'readFileSync',custom),other);",
])("retains earlier or direct native writes: %s", (write) => {
  expect(
    analyzeJavaScriptSemantics(
      `const fs=require('fs');${write}fs.readFileSync('wrong');`,
    ).configurationOperations,
  ).toEqual([]);
});
it.each([
  "(0,{})",
  "(receiver={})",
  "(0,[])",
  "(0,function(){})",
  "(0,new Empty())",
])("normalizes the returned fresh receiver: %s", (receiver) => {
  expect(
    analyzeJavaScriptSemantics(
      `function Empty(){}let receiver;Reflect.set(module,'require',replacement,${receiver});require('fs').readFileSync('kept');`,
    ).configurationOperations.map((x) => x.key),
  ).toEqual(["kept"]);
});
it.each([
  "(module.require=replacement,{})",
  "(0,module)",
  "(receiver=module)",
  "(0,new Existing())",
])("retains prefix effects and non-fresh receivers: %s", (receiver) => {
  expect(
    analyzeJavaScriptSemantics(
      `function Existing(){return module}let receiver;Reflect.set(module,'require',replacement,${receiver});require('fs').readFileSync('wrong');`,
    ).configurationOperations,
  ).toEqual([]);
});
it.each([
  { setup: "function get(){return module}", value: "get()" },
  { setup: "const get=()=>module;", value: "get()" },
  { setup: "const obj={get(){return module}};", value: "obj.get()" },
  { setup: "function Get(){return module}", value: "new Get()" },
  { setup: "class Get{constructor(){return module}}", value: "new Get()" },
  { setup: "const get=flag?()=>module:()=>({});", value: "get()" },
  { setup: "", value: "unknown()" },
])(
  "retains module-bearing or unresolved callable results: $value / $setup",
  ({ setup, value }) => {
    expect(
      analyzeJavaScriptSemantics(
        `${setup}Object.assign=(t,v)=>{v.require=replacement};Object.assign({},${value});require('fs').readFileSync('wrong');`,
      ).configurationOperations,
    ).toEqual([]);
  },
);
it.each([
  "function get(){return {}}",
  "const get=()=>({});",
  "function get(){return 1}",
])("preserves proven module-free callable results: %s", (setup) => {
  expect(
    analyzeJavaScriptSemantics(
      `${setup}Object.assign=(t,v)=>{v.require=replacement};Object.assign({},get());require('fs').readFileSync('kept');`,
    ).configurationOperations.map((x) => x.key),
  ).toEqual(["kept"]);
});
it.each(["configurable:true", "enumerable:false", "enumerable:true"])(
  "does not assume a failed incompatible definition replaced a saved child: %s",
  (flags) => {
    const enumerable = flags === "enumerable:true" ? ",enumerable:false" : "";
    expect(
      analyzeJavaScriptSemantics(
        `const holder={child:{}},box={};Object.defineProperty(holder,'child',{value:{},configurable:false${enumerable}});box.owner=holder.child;Reflect.defineProperty(holder,'child',{value:{},${flags}});holder.child.owner=module;Object.assign=(t,v)=>{if(v.owner)v.owner.require=replacement};Object.assign({},box.owner);require('fs').readFileSync('wrong');`,
      ).configurationOperations,
    ).toEqual([]);
  },
);
it.each([
  "configurable:true",
  "enumerable:false",
  "enumerable:true",
  "configurable:false",
  "writable:true,configurable:true,enumerable:true",
])(
  "accepts compatible definitions of an untouched literal slot: %s",
  (flags) => {
    expect(
      analyzeJavaScriptSemantics(
        `const holder={child:{}},box={};box.owner=holder.child;Reflect.defineProperty(holder,'child',{value:{},${flags}});holder.child.owner=module;Object.assign=(t,v)=>{if(v.owner)v.owner.require=replacement};Object.assign({},box.owner);require('fs').readFileSync('kept');`,
      ).configurationOperations.map((x) => x.key),
    ).toEqual(["kept"]);
  },
);
it.each([
  {
    capture: "cfg.receiver",
    setup: "const cfg={receiver:{}};",
    reassign: "cfg.receiver=holder;",
    same: false,
  },
  {
    capture: "receiver",
    setup: "let receiver={};",
    reassign: "receiver=holder;",
    same: false,
  },
  {
    capture: "cfg.receiver",
    setup: "const cfg={receiver:holder};",
    reassign: "cfg.receiver={};",
    same: true,
  },
  {
    capture: "receiver",
    setup: "let receiver=holder;",
    reassign: "receiver={};",
    same: true,
  },
])(
  "uses the captured receiver allocation: $capture / $same",
  ({ capture, setup, reassign, same }) => {
    expect(
      analyzeJavaScriptSemantics(
        `const holder={child:{}},box={};box.owner=holder.child;${setup}const set=Reflect.set.bind(null,holder,'child',{},${capture});${reassign}set();holder.child.owner=module;Object.assign=(t,v)=>{if(v.owner)v.owner.require=replacement};Object.assign({},box.owner);require('fs').readFileSync('kept');`,
      ).configurationOperations.map((x) => x.key),
    ).toEqual(same ? ["kept"] : []);
  },
);
it.each([
  {
    before: "",
    after:
      "Object.defineProperty(Object.prototype,'reviewHook',{set(v){this.fs.readFileSync=custom}});",
    kept: true,
  },
  {
    before:
      "Object.defineProperty(Object.prototype,'reviewHook',{set(v){this.fs.readFileSync=custom}});",
    after: "",
    kept: false,
  },
  {
    before:
      "function patch(){Object.defineProperty(Object.prototype,'reviewHook',{set(v){this.fs.readFileSync=custom}})}patch();",
    after: "",
    kept: false,
  },
])(
  "orders inherited setter effects at each set site: $kept / $before",
  ({ before, after, kept }) => {
    expect(
      analyzeJavaScriptSemantics(
        `const fs=require('fs');${before}Reflect.set(fs,'reviewHook',1,{fs});fs.readFileSync('kept');${after}`,
      ).configurationOperations.map((x) => x.key),
    ).toEqual(kept ? ["kept"] : []);
  },
);

it.each([
  "Reflect.set=custom;const set=Reflect.set.bind(null,{},'x');set(1);",
  "const nativeSet=Reflect.set;function custom(){}custom.bind=()=>nativeSet.bind(null,module,'require',replacement,module);Reflect.set=custom;const set=Reflect.set.bind(null,{},'x');set(1);",
])(
  "does not prove an overwritten callable bind result module-free: %s",
  (setup) => {
    expect(
      analyzeJavaScriptSemantics(`${setup}require('fs').readFileSync('wrong');`)
        .configurationOperations,
    ).toEqual([]);
  },
);

it("keeps distinct nearest bodies while reusing nested read ancestries", () => {
  const depth = 64;
  const source =
    "const fs=require('fs');" +
    Array.from(
      { length: depth },
      (_, i) =>
        `{const local${i}=require('fs');fs.readFileSync('outer-${i}');local${i}.readFileSync('inner-${i}');`,
    ).join("") +
    "}".repeat(depth);
  expect(
    analyzeJavaScriptSemantics(source)
      .configurationOperations.map((x) => x.key)
      .sort(),
  ).toEqual(
    Array.from({ length: depth }, (_, i) => [`outer-${i}`, `inner-${i}`])
      .flat()
      .sort(),
  );
});

it.each(
  [
    {
      setup: "const getter={get:()=>({})};getter.get=()=>module;",
      value: "getter.get()",
    },
    {
      setup:
        "const getter={get:()=>({})};const alias=getter;alias.get=()=>module;",
      value: "getter.get()",
    },
    {
      setup:
        "const getter={get:()=>({})};Object.defineProperty(getter,'get',{value:()=>module});",
      value: "getter.get()",
    },
    {
      setup:
        "const getter={get:()=>({})};Object.defineProperty(getter,'get',{get(){return ()=>module}});",
      value: "getter.get()",
    },
    {
      setup: "const getter={get:()=>({})};patch(getter);",
      value: "getter.get()",
    },
    { setup: "const get=flag?()=>({}):unknown;", value: "get()" },
    {
      setup: "const getter=[()=>({})];getter[0]=()=>module;",
      value: "getter[0]()",
    },
    {
      setup: "const getter={...unknown,get:()=>({})};",
      value: "getter[choice]()",
    },
    { setup: "class Box{owner=module}", value: "new Box()" },
  ].flatMap((entry) => [false, true].map((written) => ({ ...entry, written }))),
)(
  "does not use partial callable references as a complete result proof: $value / $written / $setup",
  ({ setup, value, written }) => {
    const input = written
      ? `const box={};box.owner=${value};Object.assign({},box.owner);`
      : `Object.assign({},${value});`;
    expect(
      analyzeJavaScriptSemantics(
        `${setup}Object.assign=(t,v)=>{(v.owner??v).require=replacement};${input}require('fs').readFileSync('wrong');`,
      ).configurationOperations,
    ).toEqual([]);
  },
);

it.each(
  [
    { setup: "function get(){return {}}", value: "get()" },
    { setup: "const getter={get:()=>({})};", value: "getter.get()" },
    { setup: "const getter={get(){return {}}};", value: "getter.get()" },
    {
      setup: "const getter={get:()=>({})};const alias=getter;",
      value: "alias.get()",
    },
    { setup: "const getter=[()=>({})];", value: "getter[0]()" },
    { setup: "const get=flag?()=>({}):()=>({});", value: "get()" },
  ].flatMap((entry) => [false, true].map((written) => ({ ...entry, written }))),
)(
  "requires complete local call targets for module-free results: $value / $written",
  ({ setup, value, written }) => {
    const input = written
      ? `const box={};box.owner=${value};Object.assign({},box.owner);`
      : `Object.assign({},${value});`;
    expect(
      analyzeJavaScriptSemantics(
        `${setup}Object.assign=(t,v)=>{v.require=replacement};${input}require('fs').readFileSync('kept');`,
      ).configurationOperations.map((x) => x.key),
    ).toEqual(value === "get()" ? ["kept"] : []);
  },
);
it.each([true, false])(
  "retains a bound intrinsic this receiver containing module: %s",
  (moduleReceiver) => {
    expect(
      analyzeJavaScriptSemantics(
        `const get=Object.prototype.valueOf.bind(${moduleReceiver ? "module" : "{}"});Object.assign=(t,f)=>{f().require=replacement};Object.assign({},get);require('fs').readFileSync('kept');`,
      ).configurationOperations.map((x) => x.key),
    ).toEqual(moduleReceiver ? [] : ["kept"]);
  },
);

it.each(
  [
    {
      save: "Object.defineProperty.bind(null,target,'readFileSync')",
      call: "define({value:custom})",
    },
    {
      save: "Reflect.defineProperty.bind(null,target,'readFileSync')",
      call: "define({value:custom})",
    },
    {
      save: "Object.defineProperties.bind(null,target)",
      call: "define({readFileSync:{value:custom}})",
    },
    {
      save: "Object.assign.bind(null,target)",
      call: "define({readFileSync:custom})",
    },
  ].flatMap((entry) =>
    [false, true].flatMap((capturedBuiltin) =>
      [false, true].map((member) => ({ ...entry, capturedBuiltin, member })),
    ),
  ),
)(
  "writes the captured descriptor/assign target: $save / $capturedBuiltin / $member",
  ({ save, call, capturedBuiltin, member }) => {
    if (member && !capturedBuiltin) {
      // Check the mutation owner directly: storing a namespace in a member is
      // independently an escape and cannot serve as a positive effect oracle.
      expect(
        referenceChanged(
          `const untouched={readFileSync:known};const holder={target:{}};const define=${save.replaceAll("target", "holder.target")};holder.target=untouched;${call};consume(untouched.readFileSync);`,
          true,
        ),
      ).toBe(false);
      return;
    }
    const original = capturedBuiltin ? "require('fs')" : "{}";
    const later = capturedBuiltin ? "{}" : "require('fs')";
    const target = member ? "holder.target" : "target";
    const setup = member
      ? `const holder={target:${original}};`
      : `let target=${original};`;
    expect(
      analyzeJavaScriptSemantics(
        `${setup}const define=${save.replaceAll("target", target)};${target}=${later};require('fs').readFileSync('before');${call};require('fs').readFileSync('after');`,
      ).configurationOperations.map(({ key }) => key),
    ).toEqual(capturedBuiltin ? ["before"] : ["before", "after"]);
  },
);

it.each([
  "function patch(){Reflect.set=(target,key,value)=>target[key]=value;}patch();",
  "const patch=()=>{Reflect.set=(target,key,value)=>target[key]=value;};patch();",
  "(()=>{Reflect.set=(target,key,value)=>target[key]=value;})();",
  "function patch(){Object.assign(Reflect,{set:(target,key,value)=>target[key]=value});}patch();",
  "function patch(){Object.defineProperty(Reflect,'set',{value:(target,key,value)=>target[key]=value});}patch();",
  "function outer(){function patch(){Reflect.set=(target,key,value)=>target[key]=value;}patch();}outer();",
])("retains intrinsic replacements made in another activation: %s", (setup) => {
  expect(
    analyzeJavaScriptSemantics(
      `${setup}const fs=require('fs');Reflect.set(fs,'readFileSync',custom,{});fs.readFileSync('wrong');`,
    ).configurationOperations,
  ).toEqual([]);
});

it("keeps unrelated intrinsic helper writes separate", () => {
  expect(
    analyzeJavaScriptSemantics(
      "function patch(){Reflect.deleteProperty=custom;}patch();const fs=require('fs');Reflect.set(fs,'readFileSync',custom,{});fs.readFileSync('kept');",
    ).configurationOperations.map(({ key }) => key),
  ).toEqual(["kept"]);
});

it.each([
  "function Box(){this.owner=module;return 1;}",
  "function Box(){this.owner=module;return undefined;}",
  "function Box(){this.owner=module;return null;}",
  "function Box(){this.owner=module;if(flag)return {};}",
  "class Box{constructor(){this.owner=module;return 1;}}",
])(
  "retains constructed instance contents independently of return expressions: %s",
  (setup) => {
    expect(
      analyzeJavaScriptSemantics(
        `${setup}Object.assign=(t,v)=>{v.owner.require=replacement};Object.assign({},new Box());require('fs').readFileSync('wrong');`,
      ).configurationOperations,
    ).toEqual([]);
  },
);

it.each([
  "Reflect.set(ns,'saved',fs,receiver);",
  "Reflect.set.call(null,ns,'saved',fs,receiver);",
  "Reflect.set.apply(null,[ns,'saved',fs,receiver]);",
  "const set=Reflect.set.bind(null,ns,'saved',fs);set(receiver);",
  "const set=Reflect.set.bind(null,ns,'saved',fs,receiver);set();",
  "const alias=receiver;Reflect.set(ns,'saved',fs,alias);",
])("retains values stored through namespace receivers: %s", (write) => {
  expect(
    analyzeJavaScriptSemantics(
      `import * as ns from 'node:path';import fs from 'node:fs';const receiver={};${write}receiver.saved.readFileSync=custom;fs.readFileSync('wrong');`,
    ).configurationOperations,
  ).toEqual([]);
});

it.each(["ns", "null", "1", "false", "'value'", "void 0"])(
  "does not expose the value through a rejected namespace receiver: %s",
  (receiver) => {
    expect(
      analyzeJavaScriptSemantics(
        `import * as ns from 'node:path';import fs from 'node:fs';Reflect.set(ns,'saved',fs,${receiver});fs.readFileSync('kept');`,
      ).configurationOperations.map(({ key }) => key),
    ).toEqual(["kept"]);
  },
);

it.each([
  "import path from 'node:path';import fs from 'node:fs';Reflect.set(fs,'readFileSync',replacement,path);fs.readFileSync('kept');",
  "import * as fs from 'node:fs';Reflect.set(fs,'require',replacement);fs.readFileSync('kept');",
])(
  "preserves imported native reads through separate receivers and unrelated slots: %s",
  (source) => {
    expect(
      analyzeJavaScriptSemantics(source).configurationOperations.map(
        ({ key }) => key,
      ),
    ).toEqual(["kept"]);
  },
);

it.each([true, false])(
  "uses the captured namespace write value after rebinding: %s",
  (capturedBuiltin) => {
    expect(
      analyzeJavaScriptSemantics(
        `import * as ns from 'node:path';import fs from 'node:fs';let value=${capturedBuiltin ? "fs" : "{}"};const receiver={};const set=Reflect.set.bind(null,ns,'saved',value);value=${capturedBuiltin ? "{}" : "fs"};set(receiver);receiver.saved.readFileSync=custom;fs.readFileSync('kept');`,
      ).configurationOperations.map(({ key }) => key),
    ).toEqual(capturedBuiltin ? [] : ["kept"]);
  },
);

it("settles copied references without multiplying unrelated descriptor work", () => {
  const countWork = (depth: number): number => {
    const source =
      "import fs from 'node:fs';const copy0={child:fs};" +
      Array.from(
        { length: depth },
        (_, index) => `const {...copy${index + 1}}=copy${index};`,
      ).join("") +
      "Reflect.set({x:0},'x',1);".repeat(depth) +
      `copy${depth}.child.readFileSync=custom;fs.readFileSync('wrong');`;
    const parsed = parseJavaScriptSource(source);
    if (parsed === null) throw new Error("Expected parsed copied references");
    const index = completeSemanticSteps(
      indexJavaScriptBindingsWithReceiversSteps(parsed.program),
    );
    let work = 0;
    for (const _ of index.indexMemberMutationFactsSteps()) work++;
    const last = parsed.program.body.at(-1);
    if (!t.isExpressionStatement(last) || !t.isCallExpression(last.expression))
      throw new Error("Expected final native method call");
    expect(
      index.referenceMayHaveChangedAt(last.expression, last.expression.callee),
    ).toBe(true);
    return work;
  };
  // Count cooperative work, not elapsed time; both runs must propagate the
  // final shared method write. Four times the input permits five times the work.
  expect(countWork(256)).toBeLessThanOrEqual(5 * countWork(64));
});

it("rechecks descriptors after their own effects activate copied references", () => {
  const copies = Array.from(
    { length: 16 },
    (_, index) => `const {...copy${index + 1}}=copy${index};`,
  ).join("");
  expect(
    referenceChanged(
      `const fs=require('fs');const other={read:known};const copy0={fs};${copies}
       Reflect.set({x:0},'x',copy16,{});
       Reflect.set(fs,'statSync',custom,{other});consume(other.read);`,
    ),
  ).toBe(true);
});

it.each(namespaceReceiverCases)(
  "resolves namespace receiver values at their original read: $body",
  ({ body, kept }) => {
    expect(
      analyzeJavaScriptSemantics(
        `import * as ns from 'node:path';import fs from 'node:fs';${body}fs.readFileSync('kept');`,
      ).configurationOperations.map(({ key }) => key),
    ).toEqual(kept ? ["kept"] : []);
  },
);

it.each([...commonJsCallbackExposureCases, ...commonJsUncertainReceiverCases])(
  "retains CommonJS module exposure through callback or receiver values: %s",
  (body) => {
    expect(
      analyzeJavaScriptSemantics(`${body}require('fs').readFileSync('wrong');`)
        .configurationOperations,
    ).toEqual([]);
  },
);

it.each(commonJsPrimitiveReceiverCases)(
  "keeps CommonJS reads after rejected or separate union receivers: %s",
  (body) => {
    expect(
      analyzeJavaScriptSemantics(
        `${body}require('fs').readFileSync('kept');`,
      ).configurationOperations.map(({ key }) => key),
    ).toEqual(["kept"]);
  },
);

it.each(callableScalarPropertyCases)(
  "preserves scalar properties selected from callable values: %s",
  (body) => {
    expect(
      analyzeJavaScriptSemantics(
        `${body}require('fs').readFileSync('kept');`,
      ).configurationOperations.map(({ key }) => key),
    ).toEqual(["kept"]);
  },
);

it.each(callableReferencePropertyCases)(
  "retains module exposure through overridden callable properties: %s",
  (body) => {
    expect(
      analyzeJavaScriptSemantics(`${body}require('fs').readFileSync('wrong');`)
        .configurationOperations,
    ).toEqual([]);
  },
);

it("retains uncertainty for a bound replacement without argument-capture proof", () => {
  expect(
    analyzeJavaScriptSemantics(
      `${opaqueBoundCallablePropertyCase}require('fs').readFileSync('unproven');`,
    ).configurationOperations,
  ).toEqual([]);
});

it.each([...callableCapturedPropertyCases, ...aliasedMutatorCalleeCases])(
  "preserves captured scalars and separate mutator implementations: %s",
  (body) => {
    expect(
      analyzeJavaScriptSemantics(
        `${body}require('fs').readFileSync('kept');`,
      ).configurationOperations.map(({ key }) => key),
    ).toEqual(["kept"]);
  },
);

it.each([...callableEscapedPropertyCases, ...aliasedMutatorExposureCases])(
  "retains escaped callable metadata and mutator callback exposure: %s",
  (body) => {
    expect(
      analyzeJavaScriptSemantics(`${body}require('fs').readFileSync('wrong');`)
        .configurationOperations,
    ).toEqual([]);
  },
);

it.each(callablePrimitivePrefixCases)(
  "preserves reads after only a primitive callable prefix escapes: %s",
  (body) => {
    expect(
      analyzeJavaScriptSemantics(
        `${body}require('fs').readFileSync('kept');`,
      ).configurationOperations.map(({ key }) => key),
    ).toEqual(["kept"]);
  },
);

it.each(callableChangedPrefixCases)(
  "retains changes to the callable or an overridden prefix: %s",
  (body) => {
    expect(
      analyzeJavaScriptSemantics(`${body}require('fs').readFileSync('wrong');`)
        .configurationOperations,
    ).toEqual([]);
  },
);

it("retains uncertainty for a saved callable property selected again after escape", () => {
  expect(
    analyzeJavaScriptSemantics(
      `${callableSavedPrefixUncertainty}require('fs').readFileSync('unproven');`,
    ).configurationOperations,
  ).toEqual([]);
});

it.each([
  ...opaqueMutatorCases,
  ...scalarAndThenableCases,
  ...mutatorEvaluationBoundaryCases,
])(
  "retains read/capture identity across opaque and suspended inputs: $source",
  ({ source, kept }) => {
    expect(
      analyzeJavaScriptSemantics(source).configurationOperations.map(
        ({ key }) => key,
      ),
    ).toEqual(kept ? ["result"] : []);
  },
);

it("preserves metadata reads before a later opaque-effect sequence", () => {
  const source = `const label=()=>0;Object.assign=(t,v)=>{v.require=replacement};${"Object.assign({},label.name);".repeat(
    64,
  )}require('fs').readFileSync('kept');${"eval('void 0');".repeat(64)}`;
  expect(
    analyzeJavaScriptSemantics(source).configurationOperations.map(
      ({ key }) => key,
    ),
  ).toEqual(["kept"]);
});
