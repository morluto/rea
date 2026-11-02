const read = "require('fs').readFileSync('result');";

export const mutatorEvaluationBoundaryCases = [
  ...[
    "typeof table[change(module)]",
    "typeof table?.[change(module)]",
    "void table[change(module)]",
    "!table[change(module)]",
    "table[change(module)]===0",
    "`${typeof table[change(module)]}`",
    "typeof table[table[change(module)]]",
  ].map((value) => ({
    source: `const table={};function change(v){v.require=replacement;return 'x'}Object.assign=(t,key)=>{t[key]=1};Object.assign({},${value});${read}`,
    kept: false,
  })),
  ...[
    "typeof value++",
    "typeof ++value",
    "typeof (value+=1)",
    "typeof (value*=2)",
  ].map((value) => ({
    source: `const owner=module;let value={owner,valueOf(){this.owner.require=replacement;return 1}};Object.assign=(t,key)=>{t[key]=1};Object.assign({},${value});${read}`,
    kept: false,
  })),
  ...[
    "typeof table['x']",
    "typeof table?.['x']",
    "typeof value++",
    "typeof (value+=1)",
  ].map((value) => ({
    source: `const table={x:1};let value=1;Object.assign=(t,key)=>{t[key]=1};Object.assign({},${value});${read}`,
    kept: true,
  })),
  ...[
    ["{owner:{}}", "box.owner=module", "box.owner"],
    ["[{}]", "box[0]=module", "box[0]"],
    ["{nested:{owner:{}}}", "box.nested.owner=module", "box.nested.owner"],
  ].map(([initial, mutation, value]) => ({
    source: `const box=${initial};eval('${mutation}');Object.assign=(t,v)=>{v.require=replacement};Object.assign({},${value});${read}`,
    kept: false,
  })),
  {
    source: `const box={owner:{}};const saved=box.owner;eval('box.owner=module');Object.assign=(t,v)=>{v.require=replacement};Object.assign({},saved);${read}`,
    kept: true,
  },
  ...["{hook:0}", "{__proto__:null,hook:0}"].map((initial) => ({
    source: `function custom(){};let target=${initial};eval('target={set hook(v){this.fs.readFileSync=custom}}');const fs=require('fs'),receiver={fs};Reflect.set(target,'hook',1,receiver);${read}`,
    kept: false,
  })),
  {
    source: `function custom(){};const target={hook:0};eval('Object.defineProperty(target,"hook",{set(v){this.fs.readFileSync=custom}})');const fs=require('fs'),receiver={fs};Reflect.set(target,'hook',1,receiver);${read}`,
    kept: false,
  },
  ...["{hook:0}", "{__proto__:null,hook:0}"].map((initial) => ({
    source: `const target=${initial};const fs=require('fs'),receiver={fs};Reflect.set(target,'hook',1,receiver);${read}`,
    kept: true,
  })),
  ...["Object", "Reflect"].flatMap((owner) => [
    {
      source: `const descriptor={value:Reflect.set.bind(null,{})};const define=${owner}.defineProperty.bind(null,Reflect,'set',descriptor);descriptor.value=Reflect.set.bind(null,module);define();Reflect.set('require',replacement);${read}`,
      kept: false,
    },
    {
      source: `let descriptor={value:Reflect.set.bind(null,{})};const define=${owner}.defineProperty.bind(null,Reflect,'set',descriptor);descriptor={value:Reflect.set.bind(null,module)};define();Reflect.set('require',replacement);${read}`,
      kept: true,
    },
    {
      source: `const descriptor={value:Reflect.set.bind(null,{})};const define=${owner}.defineProperty.bind(null,Reflect,'set',descriptor);define();descriptor.value=Reflect.set.bind(null,module);Reflect.set('require',replacement);${read}`,
      kept: true,
    },
  ]),
  {
    source: `const definitions={set:{value:Reflect.set.bind(null,{})}};const define=Object.defineProperties.bind(null,Reflect,definitions);definitions.set.value=Reflect.set.bind(null,module);define();Reflect.set('require',replacement);${read}`,
    kept: false,
  },
  {
    source: `const methods={set:Reflect.set.bind(null,{})};const assign=Object.assign.bind(null,Reflect,methods);methods.set=Reflect.set.bind(null,module);assign();Reflect.set('require',replacement);${read}`,
    kept: false,
  },
];

export const opaqueMutatorCases = [
  ...[
    "let r={};const saved=r;eval('r=module');Reflect.set(module,'require',replacement,saved);",
    "let r={};Reflect.set(module,'require',replacement,r);eval('r=module');",
    "const r={};eval('void 0');Reflect.set(module,'require',replacement,r);",
    "let r={};const set=Reflect.set.bind(null,module,'require',replacement,r);eval('r=module');set();",
    "let key='x';const saved=key;eval('key=\"require\"');Reflect.set(module,saved,replacement);",
    "let key='x';Reflect.set(module,key,replacement);eval('key=\"require\"');",
    "const key='x';eval('void 0');Reflect.set(module,key,replacement);",
    "let key='x';const set=Reflect.set.bind(null,module,key,replacement);eval('key=\"require\"');set();",
  ].map((body) => ({ source: body + read, kept: true })),
  ...[
    ...[
      "{}",
      "[]",
      "()=>0",
      "class{}",
      "/x/",
      "new (class{})()",
      "Object.create(null)",
    ].map(
      (initial) =>
        `let r=${initial};eval('r=module');Reflect.set(module,'require',replacement,r);`,
    ),
    "let r={};eval('r=module');const alias=r;Reflect.set(module,'require',replacement,alias);",
    "let C=function(){};eval('C=function(){return module}');Reflect.set(module,'require',replacement,new C());",
    "let key='x';eval('key=\"require\"');Reflect.set(module,key,replacement);",
    "let key='x';eval('key=\"require\"');Object.defineProperty(module,key,{value:replacement});",
    "let key='x';eval('key=\"require\"');Reflect.defineProperty(module,key,{value:replacement});",
    "let key='x';eval('key=\"require\"');Reflect.set.call(null,module,key,replacement);",
    "let key='x';eval('key=\"require\"');Reflect.set.apply(null,[module,key,replacement]);",
    "let key='x';eval('key=\"require\"');const set=Reflect.set.bind(null,module,key,replacement);set();",
  ].map((body) => ({ source: body + read, kept: false })),
  ...["1", "'text'", "void 0", "{}", "{x:1}"].map((value) => ({
    source: `async function run(){Object.assign=(t,v)=>{if(v!=null)v.require=replacement};Object.assign({},await (${value}));${read}}run();`,
    kept: true,
  })),
  ...[
    "module",
    "Promise.resolve(module)",
    "{then(resolve){resolve(module)}}",
  ].map((value) => ({
    source: `async function run(){Object.assign=(t,v)=>{v.require=replacement};Object.assign({},await (${value}));${read}}run();`,
    kept: false,
  })),
  ...["1", "module"].map((value) => ({
    source: `function* run(){Object.assign=(t,v)=>{v.require=replacement};Object.assign({},yield ${value});${read}}const iterator=run();iterator.next();iterator.next(module);`,
    kept: false,
  })),
];

export const scalarAndThenableCases = [
  ...[
    "module===module",
    "module!==module",
    "typeof module",
    "void module",
    "!module",
    "`${typeof module}`",
    "`${module===module}`",
    "(module===module)+1",
    "!(module===module)",
    "typeof (()=>module)",
  ].map((value) => ({
    source: `Object.assign=(t,key)=>{t[key]=1};Object.assign({},${value});${read}`,
    kept: true,
  })),
  ...[
    "void (module.require=replacement)",
    "typeof (module.require=replacement)",
    "!(module.require=replacement)",
    "(module.require=replacement)===replacement",
    "`${typeof (module.require=replacement)}`",
  ].map((value) => ({
    source: `Object.assign=(t,key)=>{t[key]=1};Object.assign({},${value});${read}`,
    kept: false,
  })),
  ...["+value", "value+1", "`${value}`", "(value+1)===2"].map((value) => ({
    source: `const value={owner:module,valueOf(){this.owner.require=replacement;return 1},toString(){this.owner.require=replacement;return '1'}};Object.assign=(t,key)=>{t[key]=1};Object.assign({},${value});${read}`,
    kept: false,
  })),
  ...[
    "typeof change(module)",
    "!change(module)",
    "change(module)===0",
    "typeof ({[change(module)](){}})",
    "typeof ({[change(module)]:1})",
  ].map((value) => ({
    source: `function change(value){value.require=replacement;return 0}Object.assign=(t,key)=>{t[key]=1};Object.assign({},${value});${read}`,
    kept: false,
  })),
  ...["typeof change(module)", "change(module)===0"].map((value) => ({
    source: `function change(value){value.require=replacement;return 0}Reflect.set(module,'require',replacement,${value});${read}`,
    kept: false,
  })),
  {
    source: `const holder={owner:module};function tag(){holder.owner.require=replacement;return 1}Object.assign=(t,key)=>{t[key]=1};Object.assign({},typeof tag\`text\`);${read}`,
    kept: false,
  },
  ...(
    [
      ["Object", "{}", false],
      ["Object", "{x:1}", false],
      ["Object", "[]", false],
      ["Array", "[]", false],
      ["Array", "{}", true],
      ["Object", "1", true],
      ["Object", "'text'", true],
      ["Object", "void 0", true],
      ["Object", "{then:null}", true],
      ["Object", "{then:0}", true],
      ["Object", "{then:false}", true],
    ] as const
  ).map(([owner, value, kept]) => ({
    source: `${owner}.prototype.then=function(resolve){delete ${owner}.prototype.then;resolve(module)};async function run(){Object.assign=(t,v)=>{if(v!=null)v.require=replacement};Object.assign({},await (${value}));${read}}run();`,
    kept,
  })),
  ...[
    "const value={};Object.prototype.then=function(resolve){delete Object.prototype.then;resolve(module)};",
    "const value=[];const proto=Array.prototype;proto.then=function(resolve){delete proto.then;resolve(module)};",
    "const value={};Object.setPrototypeOf(value,{then(resolve){resolve(module)}});",
    "const value={};value.then=resolve=>resolve(module);",
    "const value={__proto__:{then(resolve){resolve(module)}}};",
    "const value={};Object.defineProperty(Object.prototype,'then',{configurable:true,value:function(resolve){delete Object.prototype.then;resolve(module)}});",
    "const value=[];Object.setPrototypeOf(Array.prototype,{then(resolve){Object.setPrototypeOf(Array.prototype,Object.prototype);resolve(module)}});",
    "const value={then:null};value.then=resolve=>resolve(module);",
    "const value={then:null};delete value.then;Object.prototype.then=function(resolve){delete Object.prototype.then;resolve(module)};",
    "const value={then:()=>0};Object.defineProperty(value,'then',{get(){module.require=replacement;return null}});",
  ].map((setup) => ({
    source: `${setup}async function run(){Object.assign=(t,v)=>{v.require=replacement};Object.assign({},await value);${read}}run();`,
    kept: false,
  })),
  {
    source: `const saved=1;Object.prototype.then=function(resolve){delete Object.prototype.then;resolve(module)};async function run(){Object.assign=(t,v)=>{if(v!=null)v.require=replacement};Object.assign({},await saved);${read}}run();`,
    kept: true,
  },
];
