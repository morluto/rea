const primitiveInputs = [
  "null",
  "0",
  "false",
  "''",
  "1+2",
  "void 0",
  "undefined",
  "1n",
  "-0",
  "1/0",
  "0/0",
  "flag?null:1",
];

export const namespaceReceiverCases = [
  ...primitiveInputs.flatMap((value) =>
    [
      `const receiver=${value};Reflect.set(ns,'saved',fs,receiver);`,
      `const initial=${value};const receiver=initial;Reflect.set(ns,'saved',fs,receiver);`,
      `const receiver=${value};const set=Reflect.set.bind(null,ns,'saved',fs,receiver);set();`,
    ].map((body) => ({ body, kept: true })),
  ),
  ...[
    "const {receiver}={receiver:null};Reflect.set(ns,'saved',fs,receiver);",
    "const [receiver]=[null];Reflect.set(ns,'saved',fs,receiver);",
    "const holder={receiver:null};Reflect.set(ns,'saved',fs,holder.receiver);",
    "const holder=[null];Reflect.set(ns,'saved',fs,holder[0]);",
    "let receiver=null;const set=Reflect.set.bind(null,ns,'saved',fs,receiver);receiver={};set();",
    "let receiver={};receiver=null;Reflect.set(ns,'saved',fs,receiver);",
    "let initial=null;const receiver=initial;initial={};Reflect.set(ns,'saved',fs,receiver);",
    "const holder={receiver:null};const set=Reflect.set.bind(null,ns,'saved',fs,holder.receiver);holder.receiver={};set();",
    "let receiver={};Reflect.set(ns,(receiver=null,'saved'),fs,receiver);",
  ].map((body) => ({ body, kept: true })),
  ...[
    "let receiver={};const saved=receiver;const set=Reflect.set.bind(null,ns,'saved',fs,receiver);receiver=null;set();saved.saved.readFileSync=custom;",
    "let receiver=null;receiver={};Reflect.set(ns,'saved',fs,receiver);receiver.saved.readFileSync=custom;",
    "let initial={};const receiver=initial;initial=null;Reflect.set(ns,'saved',fs,receiver);receiver.saved.readFileSync=custom;",
    "const holder={receiver:{}};const saved=holder.receiver;const set=Reflect.set.bind(null,ns,'saved',fs,holder.receiver);holder.receiver=null;set();saved.saved.readFileSync=custom;",
    "let receiver=null;Reflect.set(ns,(receiver={},'saved'),fs,receiver);receiver.saved.readFileSync=custom;",
    "let receiver=null;eval('receiver={}');Reflect.set(ns,'saved',fs,receiver);receiver.saved.readFileSync=custom;",
    "let receiver=null;function patch(){receiver={};}patch();Reflect.set(ns,'saved',fs,receiver);receiver.saved.readFileSync=custom;",
    "const receiver=flag?null:{};Reflect.set(ns,'saved',fs,receiver);if(receiver)receiver.saved.readFileSync=custom;",
    "const holder={receiver:null};holder.receiver={};const set=Reflect.set.bind(null,ns,'saved',fs,holder.receiver);set();holder.receiver.saved.readFileSync=custom;",
    "const holder={receiver:null};const alias=holder;alias.receiver={};Reflect.set(ns,'saved',fs,holder.receiver);holder.receiver.saved.readFileSync=custom;",
    "const holder={receiver:null};const actual={};Object.defineProperty(holder,'receiver',{get:()=>actual});Reflect.set(ns,'saved',fs,holder.receiver);actual.saved.readFileSync=custom;",
    "const holder={receiver:null};function patch(value){value.receiver={};}patch(holder);Reflect.set(ns,'saved',fs,holder.receiver);holder.receiver.saved.readFileSync=custom;",
  ].map((body) => ({ body, kept: false })),
];
