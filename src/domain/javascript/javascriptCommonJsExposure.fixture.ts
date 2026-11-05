export const commonJsCallbackExposureCases = [
  "Object.assign=(t,get)=>{get().require=replacement};Object.assign({},()=>module);",
  "Object.assign=(t,get)=>{get().require=replacement};Object.assign({},function(){return module});",
  "function get(){return module}Object.assign=(t,get)=>{get().require=replacement};Object.assign({},get);",
  "const holder={get:()=>module};Object.assign=(t,get)=>{get().require=replacement};Object.assign({},holder.get);",
  "const holder=[()=>module];Object.assign=(t,get)=>{get().require=replacement};Object.assign({},holder[0]);",
  "Object.assign=(t,box)=>{box.get().require=replacement};Object.assign({},{get:()=>module});",
  "Object.assign=(t,get)=>{get().require=replacement};Object.assign.call(null,{},()=>module);",
  "Object.assign=(t,get)=>{get().require=replacement};Object.assign.apply(null,[{},()=>module]);",
  "Object.assign=(t,get)=>{get().require=replacement};const assign=Object.assign.bind(null,{},()=>module);assign();",
  "Object.defineProperty=(t,key,get)=>{get().require=replacement};Object.defineProperty({},'x',()=>module);",
  "Object.defineProperties=(t,get)=>{get().require=replacement};Object.defineProperties({},()=>module);",
  "Reflect.set=(t,key,get)=>{get().require=replacement};Reflect.set({},'x',()=>module);",
  "Object.assign=(t,Box)=>{new Box().owner.require=replacement};Object.assign({},class {owner=module});",
  "Object.assign=(t,Box)=>{Box.owner.require=replacement};Object.assign({},class {static owner=module});",
  "Object.assign=(t,get)=>get();Object.assign({},()=>{module.require=replacement});",
  "const get=()=>module;Object.assign=get;Object.assign({},1);Object.assign=(t,fn)=>{fn().require=replacement};Object.assign({},get);",
];

export const commonJsPrimitiveReceiverCases = [
  ...[
    "flag?null:1",
    "flag?'':false",
    "flag?0:2",
    "flag?null:(other?1:2)",
    "flag?undefined:null",
    "flag?1n:2n",
    "flag?void 0:-0",
    "flag?1/0:0/0",
  ].flatMap((value) => [
    `const receiver=${value};Reflect.set(module,'require',replacement,receiver);`,
    `const initial=${value};const receiver=initial;Reflect.set(module,'require',replacement,receiver);`,
    `let receiver=${value};const set=Reflect.set.bind(null,module,'require',replacement,receiver);receiver=module;set();`,
  ]),
  "const {receiver}={receiver:flag?null:1};Reflect.set(module,'require',replacement,receiver);",
  "const holder={receiver:flag?null:1};Reflect.set(module,'require',replacement,holder.receiver);",
  "const [receiver]=[flag?null:1];Reflect.set(module,'require',replacement,receiver);",
  "const receiver=flag?{}:{};Reflect.set(module,'require',replacement,receiver);",
];

export const commonJsUncertainReceiverCases = [
  "const receiver=flag?null:module;Reflect.set(module,'require',replacement,receiver);",
  "let receiver=flag?null:1;receiver=module;Reflect.set(module,'require',replacement,receiver);",
  "let receiver=module;const set=Reflect.set.bind(null,module,'require',replacement,receiver);receiver=flag?null:1;set();",
  "let receiver=flag?null:1;eval('receiver=module');Reflect.set(module,'require',replacement,receiver);",
  "let receiver=flag?null:1;function patch(){receiver=module}patch();Reflect.set(module,'require',replacement,receiver);",
  "const holder={receiver:flag?null:1};holder.receiver=module;Reflect.set(module,'require',replacement,holder.receiver);",
];
