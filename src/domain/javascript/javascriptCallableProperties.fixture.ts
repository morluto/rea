export const callableScalarPropertyCases = [
  ...[
    "const label=function named(){};",
    "const label=(a,b)=>0;",
    "function label(a=0){}",
    "class label{}",
  ].flatMap((setup) =>
    ["label.name", "label.length", "label.name.length"].map(
      (value) =>
        `${setup}Object.assign=(t,key)=>{t[key]=1};Object.assign({},${value});`,
    ),
  ),
  "const label=function named(){};const alias=label;Object.assign=(t,key)=>{t[key]=1};Object.assign({},alias.name);",
  "const label=function named(){};const {name:display}=label;Object.assign=(t,key)=>{t[key]=1};Object.assign({},display);",
  "const label=function named(){};const display=label.name;Object.defineProperty(label,'name',{value:module});Object.assign=(t,key)=>{t[key]=1};Object.assign({},display);",
  "const label=function named(){};Object.assign=(t,key)=>{t[key]=1};Object.assign({},label.name);Object.defineProperty(label,'name',{value:module});",
  "class Base{static name=module}class label extends Base{}Object.assign=(t,key)=>{t[key]=1};Object.assign({},label.name);",
  ...[
    "class label{static unrelated=1}",
    "class label{static unrelated(){return module}}",
    "class label{static get unrelated(){return module}}",
  ].flatMap((setup) =>
    ["label.name", "label.length"].map(
      (value) =>
        `${setup}Object.assign=(t,key)=>{t[key]=1};Object.assign({},${value});`,
    ),
  ),
];

// Replaced bind targets have no complete argument-capture contract. Retain
// that existing uncertainty rather than infer a native bind from its spelling.
export const opaqueBoundCallablePropertyCase =
  "const label=function named(){};Object.assign=(t,key)=>{t[key]=1};const assign=Object.assign.bind(null,{},label.name);Object.defineProperty(label,'name',{value:module});assign();";

export const callableReferencePropertyCases = [
  ...["name", "length"].map(
    (key) =>
      `const label=function named(){};Object.defineProperty(label,'${key}',{value:module});Object.assign=(t,v)=>{v.require=replacement};Object.assign({},label.${key});`,
  ),
  "const label=function named(){};const alias=label;Object.defineProperty(alias,'name',{value:module});Object.assign=(t,v)=>{v.require=replacement};Object.assign({},label.name);",
  "const label=function named(){};Object.defineProperty(label,'name',{get:()=>module});Object.assign=(t,v)=>{v.require=replacement};Object.assign({},label.name);",
  "class label{static name=module}Object.assign=(t,v)=>{v.require=replacement};Object.assign({},label.name);",
  "class label{static length=module}Object.assign=(t,v)=>{v.require=replacement};Object.assign({},label.length);",
  "class label{static get name(){return module}}Object.assign=(t,v)=>{v.require=replacement};Object.assign({},label.name);",
  "class label{static name(){return module}}Object.assign=(t,get)=>{get().require=replacement};Object.assign({},label.name);",
  "const key='name';class label{static [key]=module}Object.assign=(t,v)=>{v.require=replacement};Object.assign({},label.name);",
  "class label{static{Object.defineProperty(this,'name',{value:module})}}Object.assign=(t,v)=>{v.require=replacement};Object.assign({},label.name);",
  "const label=function named(){};label.owner=module;Object.assign=(t,v)=>{v.require=replacement};Object.assign({},label.owner);",
  "const label=function named(){};label.prototype.owner=module;Object.assign=(t,v)=>{v.require=replacement};Object.assign({},label.prototype.owner);",
];

export const callableCapturedPropertyCases = [
  "const label=()=>module;const display=label.name;patch(label);Object.assign=(t,key)=>{t[key]=1};Object.assign({},display);",
  "const label=()=>module;const {name:display}=label;patch(label);Object.assign=(t,key)=>{t[key]=1};Object.assign({},display);",
  "const label=()=>module;const display=label.name;eval('Object.defineProperty(label,\"name\",{value:label()})');Object.assign=(t,key)=>{t[key]=1};Object.assign({},display);",
  "const label=()=>module;patch(label.name);Object.assign=(t,key)=>{t[key]=1};Object.assign({},label.name);",
  "const label=()=>module;Object.defineProperty(label,'unrelated',{value:1});Object.assign=(t,key)=>{t[key]=1};Object.assign({},label.name);",
  "const label=()=>module;Object.assign=(t,key)=>{t[key]=1};Object.assign({},label.name);patch(label);",
  "const label=()=>module;const box={label};const display=box.label.name;patch(box.label);Object.assign=(t,key)=>{t[key]=1};Object.assign({},display);",
  "const label=()=>module;const box={label};patch(box.unrelated);Object.assign=(t,key)=>{t[key]=1};Object.assign({},box.label.name);",
  "const label=()=>module;const display=label.name;patch(label);const O=Object;O.assign=(t,key)=>{t[key]=1};O.assign({},display);",
];

export const callableEscapedPropertyCases = [
  ...["name", "length"].map(
    (key) =>
      `const label=()=>module;patch(label,'${key}');Object.assign=(t,v)=>{v.require=replacement};Object.assign({},label.${key});`,
  ),
  "const label=()=>module;const alias=label;patch(alias);Object.assign=(t,v)=>{v.require=replacement};Object.assign({},label.name);",
  "const label=()=>module;const box={label};patch(box.label);Object.assign=(t,v)=>{v.require=replacement};Object.assign({},box.label.name);",
  "const label=()=>module;patch(label);const {name:display}=label;Object.assign=(t,v)=>{v.require=replacement};Object.assign({},display);",
  "const label=()=>module;eval('Object.defineProperty(label,\"name\",{value:label()})');Object.assign=(t,v)=>{v.require=replacement};Object.assign({},label.name);",
  "const label=()=>module;const alias=label;eval('Object.defineProperty(alias,\"name\",{value:alias()})');Object.assign=(t,v)=>{v.require=replacement};Object.assign({},label.name);",
  "const label=function named(){};patch(label);Object.assign=(t,v)=>{v.require=replacement};Object.assign({},label.name);",
  "const label=()=>module;Object.assign=(t,v)=>{v.require=replacement};Object.assign({},label.name);patch(label);Object.assign({},label.name);",
  "const label=()=>module;const box={label};patch(box);Object.assign=(t,v)=>{v.require=replacement};Object.assign({},box.label.name);",
];

export const aliasedMutatorCalleeCases = [
  "const O=Object;O.assign=(t,key)=>{t[key]=1};O.assign({},1);",
  "const O=Object;O.assign=(t,key)=>{t[key]=1};const assign=O.assign;assign({},1);",
  "const O=Object;O.assign=(t,key)=>{t[key]=1};O.assign.call(null,{},1);",
  "const O=Object;O.assign=(t,key)=>{t[key]=1};O.assign.apply(null,[{},1]);",
  "const R=Reflect;R.set=(t,key)=>{t[key]=1};R.set({},1);",
];

export const aliasedMutatorExposureCases = [
  "const O=Object;O.assign=(t,v)=>{v().require=replacement};O.assign({},()=>module);",
  "const O=Object;O.assign=(t,v)=>{v().require=replacement};const assign=O.assign;assign({},()=>module);",
  "const O=Object;O.assign=(t,v)=>{v().require=replacement};O.assign.call(null,{},()=>module);",
  "const O=Object;O.assign=(t,v)=>{v().require=replacement};O.assign.apply(null,[{},()=>module]);",
  "const O=Object;O.assign=Reflect.set.bind(null,module,'require');O.assign(replacement);",
];

export const callablePrimitivePrefixCases = [
  ...[
    "const label=function named(){};",
    "const label=()=>module;",
    "function label(){return module}",
    "class label{}",
  ].map(
    (setup) =>
      `${setup}patch(label.name);Object.assign=(t,key)=>{t[key]=1};Object.assign({},label.name.length);`,
  ),
  "const label=()=>module;const alias=label;patch(alias.name);Object.assign=(t,key)=>{t[key]=1};Object.assign({},alias.name.length);",
  "const label=()=>module;const {name:display}=label;patch(display);Object.assign=(t,key)=>{t[key]=1};Object.assign({},label.name.length);",
  "const label=()=>module;const box={label};patch(box.label.name);Object.assign=(t,key)=>{t[key]=1};Object.assign({},box.label.name.length);",
  "const label=()=>module;const box=[label];patch(box[0].name);Object.assign=(t,key)=>{t[key]=1};Object.assign({},box[0].name.length);",
  "const label=()=>module;patch(label['name']);Object.assign=(t,key)=>{t[key]=1};Object.assign({},label['name']['length']);",
  "const label=()=>module;patch(label.name);Object.assign=(t,key)=>{t[key]=1};Object.assign({},label.name?.length);",
  "const label=()=>module;patch(label.name);Object.defineProperty(label,'other',{value:1});Object.assign=(t,key)=>{t[key]=1};Object.assign({},label.name.length);",
];

// A saved property followed by another selection needs separate capture/use
// clocks. Preserve the existing uncertainty until that projection is proven.
export const callableSavedPrefixUncertainty =
  "const label=()=>module;const display=label.name;patch(label);Object.assign=(t,key)=>{t[key]=1};Object.assign({},display.length);";

export const callableChangedPrefixCases = [
  "const label=()=>module;patch(label);Object.assign=(t,v)=>{v.require=replacement};Object.assign({},label.name.length);",
  "const label=()=>module;const alias=label;patch(alias);Object.assign=(t,v)=>{v.require=replacement};Object.assign({},label.name.length);",
  "const label=()=>module;const box={label};patch(box);Object.assign=(t,v)=>{v.require=replacement};Object.assign({},box.label.name.length);",
  "const label=()=>module;Object.defineProperty(label,'name',{value:{length:module}});patch(label.name);Object.assign=(t,v)=>{v.require=replacement};Object.assign({},label.name.length);",
  "const label=()=>module;Object.defineProperty(label,'name',{get:()=>({length:module})});patch(label.name);Object.assign=(t,v)=>{v.require=replacement};Object.assign({},label.name.length);",
  "const label=()=>module;eval('Object.defineProperty(label,\"name\",{value:{length:label()}})');Object.assign=(t,v)=>{v.require=replacement};Object.assign({},label.name.length);",
  "const label=()=>module;let display=label.name;eval('display={length:module}');Object.assign=(t,v)=>{v.require=replacement};Object.assign({},display.length);",
  "const label=()=>module;patch(label.name);Object.assign=(t,v)=>{v.require=replacement};Object.assign({},label.name.length);patch(label);Object.assign({},label.name.length);",
  "const label=()=>module;Object.defineProperty(label,'name',{value:()=>module});patch(label.name,'length');Object.assign=(t,v)=>{v.require=replacement};Object.assign({},label.name.length);",
];
