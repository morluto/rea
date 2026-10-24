import { expect, it } from "vitest";
import { createWebPageInspection } from "../../../tests/support/browser/webPageInspection.js";
import { analyzeWebBundleFixture } from "../../../tests/support/browser/analyzeWebBundleFixture.js";
import { analyzeJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";

const cases = [
  [
    "array current target base waits",
    '(async()=>{[(await 0,{})[0]]=(function*(){new Socket("wss://example.test/reference-base");yield 0})()})();const Socket=globalThis.WebSocket;',
    ["wss://example.test/reference-base"],
  ],
  [
    "array default waits only after iterator value",
    '(async()=>{[({})[0]=await 0]=(function*(){new Socket("wss://example.test/reference-default");yield undefined})()})();const Socket=globalThis.WebSocket;',
    [],
  ],
  [
    "array outer caller waits for reference continuation",
    'export {};try{await(async()=>{[({})[await 0]]=(function*(){new Socket("wss://example.test/reference-awaited");yield 0})()})()}catch{}const Socket=globalThis.WebSocket;',
    [],
  ],
  [
    "array current reference follows prior completed slot",
    '(async()=>{let first;[first,({})[await 0]]=(function*(){yield 0;new Socket("wss://example.test/reference-second");yield 0})()})();const Socket=globalThis.WebSocket;',
    ["wss://example.test/reference-second"],
  ],
  [
    "array current reference cannot borrow next target wait",
    '(async()=>{let first;[first,({})[await 0]]=(function*(){new Socket("wss://example.test/reference-later");yield 0;yield 0})()})();const Socket=globalThis.WebSocket;',
    [],
  ],
  [
    "array reference nested base failure prevents first step",
    'const Socket=globalThis.WebSocket;(async()=>{[((await 0,null).x)[0]]=(function*(){new Socket("wss://example.test/reference-throw");yield 0})()})();',
    [],
  ],
  [
    "apply completed data prefix retains eager getter",
    '(()=>{}).apply(null,{length:2,0:0,get 1(){new Socket("wss://example.test/apply-data-prefix")}});const Socket=globalThis.WebSocket;',
    [],
  ],
  [
    "apply completed getter prefix retains eager getter",
    '(()=>{}).apply(null,{length:2,get 0(){return 0},get 1(){new Socket("wss://example.test/apply-getter-prefix")}});const Socket=globalThis.WebSocket;',
    [],
  ],
  [
    "apply empty getter prefix retains eager getter",
    '(()=>{}).apply(null,{length:2,get 0(){},get 1(){new Socket("wss://example.test/apply-empty-prefix")}});const Socket=globalThis.WebSocket;',
    [],
  ],
  [
    "apply setter-only prefix is own undefined",
    '(()=>{}).apply(null,{length:2,set 0(value){},get 1(){new Socket("wss://example.test/apply-setter-prefix")}});const Socket=globalThis.WebSocket;',
    [],
  ],
  [
    "apply throwing length prevents indexed getter until direct read",
    'let args;try{(()=>{}).apply(null,args={get length(){throw 0},get 0(){new Socket("wss://example.test/apply-length-fail")}})}catch{}const Socket=globalThis.WebSocket;args[0];',
    ["wss://example.test/apply-length-fail"],
  ],
  [
    "awaited facts initialized twin keeps endpoint",
    'export {};const Socket=globalThis.WebSocket;function expose(value){}const pending=(async()=>{await 0;Object.keys({});new Socket("wss://example.test/stale-wait-ready")})();expose(Object);try{await pending.then(()=>{})}catch{}',
    ["wss://example.test/stale-wait-ready"],
  ],
  [
    "array target reference waits before first iterator read",
    '(async()=>{[({})[await 0]]=(function*(){new Socket("wss://example.test/reference");yield 0})()})();const Socket=globalThis.WebSocket;',
    ["wss://example.test/reference"],
  ],
  [
    "failed earlier apply index leaves later direct getter independent",
    'let args;try{(()=>{}).apply(null,args={length:2,get 0(){throw 0},get 1(){new Socket("wss://example.test/later-getter")}})}catch{}const Socket=globalThis.WebSocket;args[1];',
    ["wss://example.test/later-getter"],
  ],
  [
    "ambient receiver indexing does not cache unfinished awaited facts",
    'export {};function expose(value){}const pending=(async()=>{await 0;Object.keys({});new Socket("wss://example.test/stale-wait")})();expose(Object);try{await pending.then(()=>{})}catch{}const Socket=globalThis.WebSocket;',
    [],
  ],
  [
    "apply index getter before initialization",
    '(()=>{}).apply(null,{length:1,get 0(){new Socket("wss://example.test/apply-index")}});const Socket=globalThis.WebSocket;',
    [],
  ],
  [
    "apply arguments wait before implicit length read",
    '(async()=>{(()=>{}).apply(null,{get length(){new Socket("wss://example.test/apply-args-wait");return 0}},await 0)})();const Socket=globalThis.WebSocket;',
    ["wss://example.test/apply-args-wait"],
  ],
  [
    "apply index getter after initialization",
    'const Socket=globalThis.WebSocket;(()=>{}).apply(null,{length:1,get 0(){new Socket("wss://example.test/apply-index-ready")}});',
    ["wss://example.test/apply-index-ready"],
  ],
  [
    "changed apply defers array-like read",
    'const fn=()=>{};fn.apply=(unused,list)=>queueMicrotask(()=>list.length);fn.apply(null,{get length(){new Socket("wss://example.test/apply-replaced");return 0}});const Socket=globalThis.WebSocket;',
    ["wss://example.test/apply-replaced"],
  ],
  [
    "rest key fails after waiting before copy",
    '(async()=>{({...null[(await 0,null.x)]}={get entry(){new Socket("wss://example.test/rest-key-throws")}})})();const Socket=globalThis.WebSocket;',
    [],
  ],
  [
    "rest target reference reads nested base",
    '(async()=>{({...((await 0,null).x.y)}={get entry(){new Socket("wss://example.test/rest-nested-throws")}})})();const Socket=globalThis.WebSocket;',
    [],
  ],

  [
    "apply length getter before initialization",
    '(()=>{}).apply(null,{get length(){new Socket("wss://example.test/apply-length");return 0}});const Socket=globalThis.WebSocket;',
    [],
  ],
  [
    "apply length getter after initialization",
    'const Socket=globalThis.WebSocket;(()=>{}).apply(null,{get length(){new Socket("wss://example.test/apply-length-initialized");return 0}});',
    ["wss://example.test/apply-length-initialized"],
  ],
  [
    "rest reference waits before getter and failed put",
    '(async()=>{({...((await 0,null).x)}={get entry(){new Socket("wss://example.test/rest-reference")}})})();const Socket=globalThis.WebSocket;',
    ["wss://example.test/rest-reference"],
  ],
  [
    "rest reference null base without wait",
    '({...((null).x)}={get entry(){new Socket("wss://example.test/rest-early")}});const Socket=globalThis.WebSocket;',
    [],
  ],
  [
    "rest reference base throws before wait",
    '(async()=>{({...((null.x,await 0,{}).x)}={get entry(){new Socket("wss://example.test/rest-base-throws")}})})();const Socket=globalThis.WebSocket;',
    [],
  ],
  [
    "rest reference computed key waits",
    '(async()=>{({...null[await 0]}={get entry(){new Socket("wss://example.test/rest-key-waits")}})})();const Socket=globalThis.WebSocket;',
    ["wss://example.test/rest-key-waits"],
  ],

  [
    "escaped function can reenter before a visible call",
    'function replace(root){root.WebSocket=class{}};function run(i){const Socket=globalThis.WebSocket;replace(globalThis);if(i)new Socket("wss://example.test/repeated-capture")}function unknown(fn){fn(false)}unknown(run);run(true);',
    [],
  ],
  [
    "escaped alias can reenter before a visible call",
    'function replace(root){root.WebSocket=class{}};function run(i){const Socket=globalThis.WebSocket;replace(globalThis);if(i)new Socket("wss://example.test/repeated-capture")}const alias=run;function unknown(fn){fn(false)}unknown(alias);run(true);',
    [],
  ],
  [
    "opaque callback can reenter before a visible call",
    'function replace(root){root.WebSocket=class{}};function run(i){const Socket=globalThis.WebSocket;replace(globalThis);if(i)new Socket("wss://example.test/repeated-capture")}unknown(run);run(true);',
    [],
  ],

  [
    "for second iteration captures replacement",
    'function replace(root){root.WebSocket=class{}};for(let i=0;i<2;i++){const Socket=globalThis.WebSocket;replace(globalThis);if(i===1)new Socket("wss://example.test/repeated-capture");}',
    [],
  ],
  [
    "while second iteration captures replacement",
    'function replace(root){root.WebSocket=class{}};let i=0;while(i<2){const Socket=globalThis.WebSocket;replace(globalThis);if(i===1)new Socket("wss://example.test/repeated-capture");i++;}',
    [],
  ],
  [
    "do second iteration captures replacement",
    'function replace(root){root.WebSocket=class{}};let i=0;do{const Socket=globalThis.WebSocket;replace(globalThis);if(i===1)new Socket("wss://example.test/repeated-capture");i++;}while(i<2);',
    [],
  ],
  [
    "for-of second iteration captures replacement",
    'function replace(root){root.WebSocket=class{}};for(const i of [0,1]){const Socket=globalThis.WebSocket;replace(globalThis);if(i===1)new Socket("wss://example.test/repeated-capture");}',
    [],
  ],
  [
    "for-in second iteration captures replacement",
    'function replace(root){root.WebSocket=class{}};for(const key in {a:0,b:1}){const i=key==="a"?0:1;const Socket=globalThis.WebSocket;replace(globalThis);if(i===1)new Socket("wss://example.test/repeated-capture");}',
    [],
  ],
  [
    "nested second iteration captures replacement",
    'function replace(root){root.WebSocket=class{}};for(let outer=0;outer<1;outer++)for(let i=0;i<2;i++){const Socket=globalThis.WebSocket;replace(globalThis);if(i===1)new Socket("wss://example.test/repeated-capture");}',
    [],
  ],
  [
    "destructured repeated capture",
    'function replace(root){root.WebSocket=class{}};for(let i=0;i<2;i++){const {WebSocket:Socket}=globalThis;replace(globalThis);if(i===1)new Socket("wss://example.test/repeated-capture");}',
    [],
  ],
  [
    "function-local repeated capture",
    'function replace(root){root.WebSocket=class{}};function run(){for(let i=0;i<2;i++){const Socket=globalThis.WebSocket;replace(globalThis);if(i===1)new Socket("wss://example.test/repeated-capture");}}run();',
    [],
  ],
  [
    "single caller in loop repeats capture",
    'function replace(root){root.WebSocket=class{}};function run(i){const Socket=globalThis.WebSocket;replace(globalThis);if(i===1)new Socket("wss://example.test/repeated-capture");}for(let i=0;i<2;i++)run(i);',
    [],
  ],
  [
    "two direct callers repeat capture",
    'function replace(root){root.WebSocket=class{}};function run(i){const Socket=globalThis.WebSocket;replace(globalThis);if(i===1)new Socket("wss://example.test/repeated-capture");}run(0);run(1);',
    [],
  ],
  [
    "two arrow callers repeat capture",
    'function replace(root){root.WebSocket=class{}};const run=i=>{const Socket=globalThis.WebSocket;replace(globalThis);if(i===1)new Socket("wss://example.test/repeated-capture");};run(0);run(1);',
    [],
  ],
  [
    "nested caller in loop repeats capture",
    'function replace(root){root.WebSocket=class{}};function run(i){const Socket=globalThis.WebSocket;replace(globalThis);if(i===1)new Socket("wss://example.test/repeated-capture");}function outer(i){run(i)}for(let i=0;i<2;i++)outer(i);',
    [],
  ],
  [
    "nested two callers repeat capture",
    'function replace(root){root.WebSocket=class{}};function run(i){const Socket=globalThis.WebSocket;replace(globalThis);if(i===1)new Socket("wss://example.test/repeated-capture");}function outer(i){run(i)}outer(0);outer(1);',
    [],
  ],
  [
    "recursive caller repeats capture",
    'function replace(root){root.WebSocket=class{}};function run(i){const Socket=globalThis.WebSocket;replace(globalThis);if(i===1)new Socket("wss://example.test/repeated-capture");if(i===0)run(1)}run(0);',
    [],
  ],
  [
    "unknown stored object callers cannot prove single capture",
    'function replace(root){root.WebSocket=class{}};const client={run(i){const Socket=globalThis.WebSocket;replace(globalThis);if(i===1)new Socket("wss://example.test/repeated-capture");}};client.run(0);client.run(1);',
    [],
  ],
  [
    "unknown class callers cannot prove single capture",
    'function replace(root){root.WebSocket=class{}};class Client{run(i){const Socket=globalThis.WebSocket;replace(globalThis);if(i===1)new Socket("wss://example.test/repeated-capture");}}const client=new Client();client.run(0);client.run(1);',
    [],
  ],
  [
    "capture before entire for survives",
    'function replace(root){root.WebSocket=class{}};const Socket=globalThis.WebSocket;for(let i=0;i<2;i++){replace(globalThis);new Socket("wss://example.test/repeated-capture")}',
    ["wss://example.test/repeated-capture"],
  ],
  [
    "capture before entire while survives",
    'function replace(root){root.WebSocket=class{}};const Socket=globalThis.WebSocket;let i=0;while(i++<2){replace(globalThis);new Socket("wss://example.test/repeated-capture")}',
    ["wss://example.test/repeated-capture"],
  ],
  [
    "capture before entire do survives",
    'function replace(root){root.WebSocket=class{}};const Socket=globalThis.WebSocket;do{replace(globalThis);new Socket("wss://example.test/repeated-capture")}while(false);',
    ["wss://example.test/repeated-capture"],
  ],
  [
    "capture before entire for-of survives",
    'function replace(root){root.WebSocket=class{}};const Socket=globalThis.WebSocket;for(const i of [0,1]){replace(globalThis);new Socket("wss://example.test/repeated-capture")}',
    ["wss://example.test/repeated-capture"],
  ],
  [
    "single direct object method capture survives",
    'function replace(root){root.WebSocket=class{}};({run(){const Socket=globalThis.WebSocket;replace(globalThis);new Socket("wss://example.test/repeated-capture")}}).run();',
    ["wss://example.test/repeated-capture"],
  ],
  [
    "single direct class method capture survives",
    'function replace(root){root.WebSocket=class{}};new(class{run(){const Socket=globalThis.WebSocket;replace(globalThis);new Socket("wss://example.test/repeated-capture")}})().run();',
    ["wss://example.test/repeated-capture"],
  ],
  [
    "outer capture survives repeated function",
    'function replace(root){root.WebSocket=class{}};const Socket=globalThis.WebSocket;function run(){replace(globalThis);new Socket("wss://example.test/repeated-capture")}run();run();',
    ["wss://example.test/repeated-capture"],
  ],
  [
    "unproven deferred caller cannot prove single capture",
    'function replace(root){root.WebSocket=class{}};function run(){const Socket=globalThis.WebSocket;replace(globalThis);new Socket("wss://example.test/repeated-capture")}',
    [],
  ],

  [
    "saved constructor in function",
    'function replace(root){root.WebSocket=class{}};function connect(){const Socket=globalThis.WebSocket;replace(globalThis);new Socket("wss://example.test/function-capture")}connect();',
    ["wss://example.test/function-capture"],
  ],
  [
    "saved constructor in arrow",
    'function replace(root){root.WebSocket=class{}};(()=>{const Socket=globalThis.WebSocket;replace(globalThis);new Socket("wss://example.test/function-capture")})();',
    ["wss://example.test/function-capture"],
  ],
  [
    "saved destructured constructor in function",
    'function replace(root){root.WebSocket=class{}};function connect(){const {WebSocket:Socket}=globalThis;replace(globalThis);new Socket("wss://example.test/function-capture")}connect();',
    ["wss://example.test/function-capture"],
  ],
  [
    "saved constructor in object method has unproven caller cardinality",
    'function replace(root){root.WebSocket=class{}};const client={connect(){const Socket=globalThis.WebSocket;replace(globalThis);new Socket("wss://example.test/function-capture")}};client.connect();',
    [],
  ],
  [
    "saved constructor in class method has unproven caller cardinality",
    'function replace(root){root.WebSocket=class{}};class Client{connect(){const Socket=globalThis.WebSocket;replace(globalThis);new Socket("wss://example.test/function-capture")}}new Client().connect();',
    [],
  ],
  [
    "saved constructor through nested block",
    'function replace(root){root.WebSocket=class{}};function connect(){const Socket=globalThis.WebSocket;{replace(globalThis);new Socket("wss://example.test/function-capture")}}connect();',
    ["wss://example.test/function-capture"],
  ],
  [
    "late saved constructor in function",
    'function replace(root){root.WebSocket=class{}};function connect(){replace(globalThis);const Socket=globalThis.WebSocket;new Socket("wss://example.test/function-capture")}connect();',
    [],
  ],
  [
    "function namespace alias is not a capture",
    'function replace(root){root.WebSocket=class{}};function connect(){const root=globalThis;replace(globalThis);new root.WebSocket("wss://example.test/function-capture")}connect();',
    [],
  ],
  [
    "same function earlier declarator",
    'function replace(root){root.WebSocket=class{}};function connect(){const Socket=globalThis.WebSocket,ignored=replace(globalThis);new Socket("wss://example.test/function-capture")}connect();',
    ["wss://example.test/function-capture"],
  ],
  [
    "same function later declarator",
    'function replace(root){root.WebSocket=class{}};function connect(){const ignored=replace(globalThis),Socket=globalThis.WebSocket;new Socket("wss://example.test/function-capture")}connect();',
    [],
  ],
  [
    "outer earlier escape precedes function capture",
    'function replace(root){root.WebSocket=class{}};function connect(){const Socket=globalThis.WebSocket;new Socket("wss://example.test/function-capture")}replace(globalThis);connect();',
    [],
  ],
  [
    "outer later escape follows function capture",
    'function replace(root){root.WebSocket=class{}};function connect(){const Socket=globalThis.WebSocket;new Socket("wss://example.test/function-capture")}connect();replace(globalThis);',
    ["wss://example.test/function-capture"],
  ],
  [
    "saved constructor survives nested callback",
    'function replace(root){root.WebSocket=class{}};function escape(){replace(globalThis)}function connect(){const Socket=globalThis.WebSocket;escape();new Socket("wss://example.test/function-capture")}connect();',
    ["wss://example.test/function-capture"],
  ],
  [
    "nested callback precedes constructor capture",
    'function replace(root){root.WebSocket=class{}};function escape(){replace(globalThis)}function connect(){escape();const Socket=globalThis.WebSocket;new Socket("wss://example.test/function-capture")}connect();',
    [],
  ],
  [
    "saved constructor across await",
    'function replace(root){root.WebSocket=class{}};async function connect(){const Socket=globalThis.WebSocket;await 0;replace(globalThis);new Socket("wss://example.test/function-capture")}await connect();',
    ["wss://example.test/function-capture"],
  ],
  [
    "loop escape before later iteration capture",
    'function replace(root){root.WebSocket=class{}};function connect(){for(let i=0;i<2;i++){if(i===0){replace(globalThis);continue}const Socket=globalThis.WebSocket;new Socket("wss://example.test/function-capture")}}connect();',
    [],
  ],
  [
    "passed global replacement",
    'function replace(root){root.WebSocket=class{}};replace(globalThis);new globalThis.WebSocket("wss://example.test/global-escape");',
    [],
  ],
  [
    "bare constructor replacement",
    'function replace(root){root.WebSocket=class{}};replace(globalThis);new WebSocket("wss://example.test/global-escape");',
    [],
  ],
  [
    "global alias replacement",
    'const root=globalThis;function replace(root){root.WebSocket=class{}};replace(root);new root.WebSocket("wss://example.test/global-escape");',
    [],
  ],
  [
    "late captured constructor",
    'function replace(root){root.WebSocket=class{}};replace(globalThis);const Socket=globalThis.WebSocket;new Socket("wss://example.test/global-escape");',
    [],
  ],
  [
    "late destructured constructor",
    'function replace(root){root.WebSocket=class{}};replace(globalThis);const {WebSocket:Socket}=globalThis;new Socket("wss://example.test/global-escape");',
    [],
  ],
  [
    "early captured constructor",
    'const Socket=globalThis.WebSocket;function replace(root){root.WebSocket=class{}};replace(globalThis);new Socket("wss://example.test/global-escape");',
    ["wss://example.test/global-escape"],
  ],
  [
    "early destructured constructor",
    'const {WebSocket:Socket}=globalThis;function replace(root){root.WebSocket=class{}};replace(globalThis);new Socket("wss://example.test/global-escape");',
    ["wss://example.test/global-escape"],
  ],
  [
    "read before later escape",
    'new globalThis.WebSocket("wss://example.test/global-escape");function replace(root){root.WebSocket=class{}};replace(globalThis);',
    ["wss://example.test/global-escape"],
  ],
  [
    "namespace alias is not constructor capture",
    'const root=globalThis;function replace(root){root.WebSocket=class{}};replace(globalThis);new root.WebSocket("wss://example.test/global-escape");',
    [],
  ],
  [
    "same declaration early capture",
    'function replace(root){root.WebSocket=class{}};const Socket=globalThis.WebSocket,ignored=replace(globalThis);new Socket("wss://example.test/global-escape");',
    ["wss://example.test/global-escape"],
  ],
  [
    "same declaration late capture",
    'function replace(root){root.WebSocket=class{}};const ignored=replace(globalThis),Socket=globalThis.WebSocket;new Socket("wss://example.test/global-escape");',
    [],
  ],
  [
    "unrelated receiver escape",
    'const other={};function replace(root){root.WebSocket=class{}};replace(other);new globalThis.WebSocket("wss://example.test/global-escape");',
    ["wss://example.test/global-escape"],
  ],
  [
    "escaped nested global alias",
    'function replace(root){root.WebSocket=class{}};replace(globalThis.globalThis);new globalThis.WebSocket("wss://example.test/global-escape");',
    [],
  ],
  [
    "stored constructor survives later callback escape",
    'const Socket=globalThis.WebSocket;function replace(root){root.WebSocket=class{}};replace(globalThis);const connect=()=>new Socket("wss://example.test/global-escape");connect();',
    ["wss://example.test/global-escape"],
  ],
  [
    "iterator abrupt branches",
    'Array.prototype[Symbol.iterator]=function(){if(globalThis.flag){throw 0}else{throw 1}};(async()=>{try{const []=[];const [y=await 0]=(function*(){try{yield undefined}finally{new Socket("wss://example.test/reachability")}})();}catch{}})();const Socket=globalThis.WebSocket;',
    [],
  ],
  [
    "iterator prior declaration",
    'Array.prototype[Symbol.iterator]=function(){const ignored=0;throw ignored};(async()=>{try{const []=[];const [y=await 0]=(function*(){try{yield undefined}finally{new Socket("wss://example.test/reachability")}})();}catch{}})();const Socket=globalThis.WebSocket;',
    [],
  ],
  [
    "iterator caught throw",
    'Array.prototype[Symbol.iterator]=function(){try{throw 0}catch{};return {next(){return {done:true}}}};(async()=>{try{const []=[];const [y=await 0]=(function*(){try{yield undefined}finally{new Socket("wss://example.test/reachability")}})();}catch{}})();const Socket=globalThis.WebSocket;',
    ["wss://example.test/reachability"],
  ],
  [
    "raw review",
    'Array.prototype[Symbol.iterator] = function(){ throw 0; }; (async()=>{ try { const [] = []; const [y = await 0] = (function*(){ try { yield undefined; } finally { new Socket("wss://example.test/empty"); } })(); } catch {} })(); const Socket = globalThis.WebSocket;',
    [],
  ],
  [
    "initialized but unreachable",
    'const Socket=globalThis.WebSocket;(async()=>{try{throw 0;const [y=await 0]=(function*(){try{yield undefined}finally{new Socket("wss://example.test/reachability")}})();}catch{}})();',
    [],
  ],
  [
    "multiple stored activations",
    'const produce=function*(){try{yield undefined}finally{new Socket("wss://example.test/reachability")}};(async()=>{try{throw 0;const [x=await 0]=produce()}catch{};const[y=await 0]=produce()})();const Socket=globalThis.WebSocket;',
    ["wss://example.test/reachability"],
  ],
  [
    "controlled throwing unknown",
    '(async()=>{try{stop();const [y=await 0]=(function*(){try{yield undefined}finally{new Socket("wss://example.test/reachability")}})();}catch{}})();const Socket=globalThis.WebSocket;',
    ["wss://example.test/reachability"],
  ],
  [
    "throwing empty",
    'Array.prototype[Symbol.iterator]=function(){throw 0};(async()=>{try{const []=[];const [y=await 0]=(function*(){try{yield undefined}finally{new Socket("wss://example.test/reachability")}})();}catch{}})();const Socket=globalThis.WebSocket;',
    [],
  ],
  [
    "throwing nonempty",
    'Array.prototype[Symbol.iterator]=function(){throw 0};(async()=>{try{const [x]=[];const [y=await 0]=(function*(){try{yield undefined}finally{new Socket("wss://example.test/reachability")}})();}catch{}})();const Socket=globalThis.WebSocket;',
    [],
  ],
  [
    "throwing assignment",
    'Array.prototype[Symbol.iterator]=function(){throw 0};(async()=>{try{let x;([]=[]);const [y=await 0]=(function*(){try{yield undefined}finally{new Socket("wss://example.test/reachability")}})();}catch{}})();const Socket=globalThis.WebSocket;',
    [],
  ],
  [
    "normal empty",
    '(async()=>{try{const []=[];const [y=await 0]=(function*(){try{yield undefined}finally{new Socket("wss://example.test/reachability")}})();}catch{}})();const Socket=globalThis.WebSocket;',
    ["wss://example.test/reachability"],
  ],
  [
    "literal throw",
    '(async()=>{try{throw 0;const [y=await 0]=(function*(){try{yield undefined}finally{new Socket("wss://example.test/reachability")}})();}catch{}})();const Socket=globalThis.WebSocket;',
    [],
  ],
  [
    "null empty",
    '(async()=>{try{const []=null;const [y=await 0]=(function*(){try{yield undefined}finally{new Socket("wss://example.test/reachability")}})();}catch{}})();const Socket=globalThis.WebSocket;',
    [],
  ],
  [
    "null property",
    '(async()=>{try{null.x;const [y=await 0]=(function*(){try{yield undefined}finally{new Socket("wss://example.test/reachability")}})();}catch{}})();const Socket=globalThis.WebSocket;',
    [],
  ],
  [
    "caught prior throw",
    '(async()=>{try{try{throw 0}catch{};const [y=await 0]=(function*(){try{yield undefined}finally{new Socket("wss://example.test/reachability")}})();}catch{}})();const Socket=globalThis.WebSocket;',
    ["wss://example.test/reachability"],
  ],
  [
    "maybe prior call",
    '(async()=>{try{inert();const [y=await 0]=(function*(){try{yield undefined}finally{new Socket("wss://example.test/reachability")}})();}catch{}})();const Socket=globalThis.WebSocket;',
    ["wss://example.test/reachability"],
  ],
  [
    "conditional false write",
    'if(false){Array.prototype[Symbol.iterator]=function(){throw 0};}(async()=>{try{const []=[];const [y=await 0]=(function*(){try{yield undefined}finally{new Socket("wss://example.test/reachability")}})();}catch{}})();const Socket=globalThis.WebSocket;',
    ["wss://example.test/reachability"],
  ],
  [
    "unrelated write",
    'Array.prototype.unrelated=0;(async()=>{try{const []=[];const [y=await 0]=(function*(){try{yield undefined}finally{new Socket("wss://example.test/reachability")}})();}catch{}})();const Socket=globalThis.WebSocket;',
    ["wss://example.test/reachability"],
  ],
  [
    "restored iterator",
    'const original=Array.prototype[Symbol.iterator];Array.prototype[Symbol.iterator]=function(){throw 0};Array.prototype[Symbol.iterator]=original;(async()=>{try{const []=[];const [y=await 0]=(function*(){try{yield undefined}finally{new Socket("wss://example.test/reachability")}})();}catch{}})();const Socket=globalThis.WebSocket;',
    ["wss://example.test/reachability"],
  ],
  [
    "shadowed Array",
    '{const Array={prototype:{}};Array.prototype[Symbol.iterator]=function(){throw 0};(async()=>{try{const []=[];const [y=await 0]=(function*(){try{yield undefined}finally{new Socket("wss://example.test/reachability")}})();}catch{}})();const Socket=globalThis.WebSocket;}',
    ["wss://example.test/reachability"],
  ],
  [
    "shadowed Symbol",
    '{const Symbol={iterator:"different"};Array.prototype[Symbol.iterator]=function(){throw 0};(async()=>{try{const []=[];const [y=await 0]=(function*(){try{yield undefined}finally{new Socket("wss://example.test/reachability")}})();}catch{}})();const Socket=globalThis.WebSocket;}',
    ["wss://example.test/reachability"],
  ],
  [
    "changed Symbol",
    'const Symbol={iterator:"different"};Array.prototype[Symbol.iterator]=function(){throw 0};(async()=>{try{const []=[];const [y=await 0]=(function*(){try{yield undefined}finally{new Socket("wss://example.test/reachability")}})();}catch{}})();const Socket=globalThis.WebSocket;',
    ["wss://example.test/reachability"],
  ],
  [
    "arrow iterator",
    'Array.prototype[Symbol.iterator]=()=>{throw 0};(async()=>{try{const []=[];const [y=await 0]=(function*(){try{yield undefined}finally{new Socket("wss://example.test/reachability")}})();}catch{}})();const Socket=globalThis.WebSocket;',
    [],
  ],
  [
    "async iterator",
    'Array.prototype[Symbol.iterator]=async function(){throw 0};(async()=>{try{const []=[];const [y=await 0]=(function*(){try{yield undefined}finally{new Socket("wss://example.test/reachability")}})();}catch{}})();const Socket=globalThis.WebSocket;',
    ["wss://example.test/reachability"],
  ],
  [
    "conditional throw",
    '(async()=>{try{if(globalThis.flag){throw 0};const [y=await 0]=(function*(){try{yield undefined}finally{new Socket("wss://example.test/reachability")}})();}catch{}})();const Socket=globalThis.WebSocket;',
    ["wss://example.test/reachability"],
  ],
  [
    "both branches throw",
    '(async()=>{try{if(globalThis.flag){throw 0}else{throw 1};const [y=await 0]=(function*(){try{yield undefined}finally{new Socket("wss://example.test/reachability")}})();}catch{}})();const Socket=globalThis.WebSocket;',
    [],
  ],
  [
    "stored consumer never reached",
    '(async()=>{try{const values=(function*(){try{yield undefined}finally{new Socket("wss://example.test/reachability")}})();throw 0;const [y=await 0]=values;}catch{}})();const Socket=globalThis.WebSocket;',
    [],
  ],
  [
    "stored creator never reached",
    '(async()=>{try{throw 0;const values=(function*(){try{yield undefined}finally{new Socket("wss://example.test/reachability")}})();const [y=await 0]=values;}catch{}})();const Socket=globalThis.WebSocket;',
    [],
  ],
  [
    "same declaration",
    '(async()=>{try{const []=null,y=(function*(){try{yield undefined}finally{new Socket("wss://example.test/reachability")}})();const [x=await 0]=y;}catch{}})();const Socket=globalThis.WebSocket;',
    [],
  ],
  [
    "delayed hoisted declaration",
    'Array.prototype[Symbol.iterator]=function(){throw 0};async function run(){try{const []=[];const [y=await 0]=(function*(){try{yield undefined}finally{new Socket("wss://example.test/reachability")}})();}catch{}}run();const Socket=globalThis.WebSocket;',
    ["wss://example.test/reachability"],
  ],
  [
    "hoisted called before write",
    'run();Array.prototype[Symbol.iterator]=function(){throw 0};async function run(){try{const []=[];const [y=await 0]=(function*(){try{yield undefined}finally{new Socket("wss://example.test/reachability")}})();}catch{}}const Socket=globalThis.WebSocket;',
    ["wss://example.test/reachability"],
  ],
  // Later Array iterator writes remain conservative metadata, not native absence.
  [
    "copy rest",
    'const {...rest}={get x(){new Socket("wss://example.test/review-copy-rest");}};const Socket=globalThis.WebSocket;',
    [],
  ],
  [
    "copy rest initialized",
    'const Socket=globalThis.WebSocket;const {...rest}={get x(){new Socket("wss://example.test/review-copy-rest");}};',
    ["wss://example.test/review-copy-rest"],
  ],
  [
    "copy spread",
    'const copied={...{get x(){new Socket("wss://example.test/review-copy-spread");}}};const Socket=globalThis.WebSocket;',
    [],
  ],
  [
    "copy spread initialized",
    'const Socket=globalThis.WebSocket;const copied={...{get x(){new Socket("wss://example.test/review-copy-spread");}}};',
    ["wss://example.test/review-copy-spread"],
  ],
  [
    "copy spread-overwrite",
    'const copied={...{get x(){new Socket("wss://example.test/review-copy-spread-overwrite");}},x:0};const Socket=globalThis.WebSocket;',
    [],
  ],
  [
    "copy spread-overwrite initialized",
    'const Socket=globalThis.WebSocket;const copied={...{get x(){new Socket("wss://example.test/review-copy-spread-overwrite");}},x:0};',
    ["wss://example.test/review-copy-spread-overwrite"],
  ],
  [
    "copy assignment-rest",
    'let rest;({...rest}={get x(){new Socket("wss://example.test/review-copy-assignment-rest");}});const Socket=globalThis.WebSocket;',
    [],
  ],
  [
    "copy assignment-rest initialized",
    'const Socket=globalThis.WebSocket;let rest;({...rest}={get x(){new Socket("wss://example.test/review-copy-assignment-rest");}});',
    ["wss://example.test/review-copy-assignment-rest"],
  ],
  [
    "copy rest awaited selected key",
    '(async()=>{try{const {[await "x"]:unused,...rest}={get x(){new Socket("wss://example.test/review-copy-prefix");}};}catch{}})();const Socket=globalThis.WebSocket;',
    ["wss://example.test/review-copy-prefix"],
  ],
  [
    "copy rest excludes earlier getter",
    '(async()=>{try{const {x:unused,y=await 0,...rest}={get x(){new Socket("wss://example.test/review-copy-prefix");}};}catch{}})();const Socket=globalThis.WebSocket;',
    [],
  ],
  [
    "copy spread later wait",
    '(async()=>{try{const copy={...{get x(){new Socket("wss://example.test/review-copy-prefix");}},[await 0]:0};}catch{}})();const Socket=globalThis.WebSocket;',
    [],
  ],
  [
    "copy spread prior wait",
    '(async()=>{try{const copy={[await 0]:0,...{get x(){new Socket("wss://example.test/review-copy-prefix");}}};}catch{}})();const Socket=globalThis.WebSocket;',
    ["wss://example.test/review-copy-prefix"],
  ],
  [
    "copy ordinary method remains deferred",
    'const copy={...{run(){new Socket("wss://example.test/review-copy-prefix");}}};const Socket=globalThis.WebSocket;',
    ["wss://example.test/review-copy-prefix"],
  ],
  [
    "failed array [[x], y=await 0]",
    'Array.prototype[Symbol.iterator]=function(){throw 0;};(async()=>{try{const [[x], y=await 0]=(function*(){try{yield [1];yield undefined;}finally{new Socket("wss://example.test/review-failed-array-13");}})();}catch{}})();const Socket=globalThis.WebSocket;',
    [],
  ],
  [
    "failed array [[x], y=await 0] initialized",
    'const Socket=globalThis.WebSocket;Array.prototype[Symbol.iterator]=function(){throw 0;};(async()=>{try{const [[x], y=await 0]=(function*(){try{yield [1];yield undefined;}finally{new Socket("wss://example.test/review-failed-array-13");}})();}catch{}})();',
    ["wss://example.test/review-failed-array-13"],
  ],
  [
    "native array [[x], y=await 0]",
    '(async()=>{try{const [[x], y=await 0]=(function*(){try{yield [1];yield undefined;}finally{new Socket("wss://example.test/review-failed-array-13");}})();}catch{}})();const Socket=globalThis.WebSocket;',
    ["wss://example.test/review-failed-array-13"],
  ],
  [
    "failed array [[], y=await 0]",
    'Array.prototype[Symbol.iterator]=function(){throw 0;};(async()=>{try{const [[], y=await 0]=(function*(){try{yield [1];yield undefined;}finally{new Socket("wss://example.test/review-failed-array-16");}})();}catch{}})();const Socket=globalThis.WebSocket;',
    [],
  ],
  [
    "failed array [[], y=await 0] initialized",
    'const Socket=globalThis.WebSocket;Array.prototype[Symbol.iterator]=function(){throw 0;};(async()=>{try{const [[], y=await 0]=(function*(){try{yield [1];yield undefined;}finally{new Socket("wss://example.test/review-failed-array-16");}})();}catch{}})();',
    ["wss://example.test/review-failed-array-16"],
  ],
  [
    "native array [[], y=await 0]",
    '(async()=>{try{const [[], y=await 0]=(function*(){try{yield [1];yield undefined;}finally{new Socket("wss://example.test/review-failed-array-16");}})();}catch{}})();const Socket=globalThis.WebSocket;',
    ["wss://example.test/review-failed-array-16"],
  ],
  [
    "failed array [[...x], y=await 0]",
    'Array.prototype[Symbol.iterator]=function(){throw 0;};(async()=>{try{const [[...x], y=await 0]=(function*(){try{yield [1];yield undefined;}finally{new Socket("wss://example.test/review-failed-array-19");}})();}catch{}})();const Socket=globalThis.WebSocket;',
    [],
  ],
  [
    "failed array [[...x], y=await 0] initialized",
    'const Socket=globalThis.WebSocket;Array.prototype[Symbol.iterator]=function(){throw 0;};(async()=>{try{const [[...x], y=await 0]=(function*(){try{yield [1];yield undefined;}finally{new Socket("wss://example.test/review-failed-array-19");}})();}catch{}})();',
    ["wss://example.test/review-failed-array-19"],
  ],
  [
    "native array [[...x], y=await 0]",
    '(async()=>{try{const [[...x], y=await 0]=(function*(){try{yield [1];yield undefined;}finally{new Socket("wss://example.test/review-failed-array-19");}})();}catch{}})();const Socket=globalThis.WebSocket;',
    ["wss://example.test/review-failed-array-19"],
  ],
  [
    "erased declare static [Symbol.iterator]: any;",
    '(class {declare static [Symbol.iterator]: any;static run(){new Socket("wss://example.test/review-erased-22");}}).run();const Socket=globalThis.WebSocket;',
    [],
  ],
  [
    "erased declare static [Symbol.iterator]: any; initialized",
    'const Socket=globalThis.WebSocket;(class {declare static [Symbol.iterator]: any;static run(){new Socket("wss://example.test/review-erased-22");}}).run();',
    ["wss://example.test/review-erased-22"],
  ],
  [
    "erased declare static run: any;",
    '(class {declare static run: any;static run(){new Socket("wss://example.test/review-erased-24");}}).run();const Socket=globalThis.WebSocket;',
    [],
  ],
  [
    "erased declare static run: any; initialized",
    'const Socket=globalThis.WebSocket;(class {declare static run: any;static run(){new Socket("wss://example.test/review-erased-24");}}).run();',
    ["wss://example.test/review-erased-24"],
  ],
  [
    "erased declare [Symbol.iterator]: any;",
    '(class {declare [Symbol.iterator]: any;static run(){new Socket("wss://example.test/review-erased-26");}}).run();const Socket=globalThis.WebSocket;',
    [],
  ],
  [
    "erased declare [Symbol.iterator]: any; initialized",
    'const Socket=globalThis.WebSocket;(class {declare [Symbol.iterator]: any;static run(){new Socket("wss://example.test/review-erased-26");}}).run();',
    ["wss://example.test/review-erased-26"],
  ],
  [
    "runtime symbol iterator",
    '(class {static [Symbol.iterator]: any;static run(){new Socket("wss://example.test/review-runtime-symbol-iterator");}}).run();const Socket=globalThis.WebSocket;',
    [],
  ],
  [
    "runtime symbol iterator initialized",
    'const Socket=globalThis.WebSocket;(class {static [Symbol.iterator]: any;static run(){new Socket("wss://example.test/review-runtime-symbol-iterator");}}).run();',
    ["wss://example.test/review-runtime-symbol-iterator"],
  ],
  [
    "runtime symbol toStringTag",
    '(class {static [Symbol.toStringTag]: any;static run(){new Socket("wss://example.test/review-runtime-symbol-toStringTag");}}).run();const Socket=globalThis.WebSocket;',
    [],
  ],
  [
    "runtime symbol toStringTag initialized",
    'const Socket=globalThis.WebSocket;(class {static [Symbol.toStringTag]: any;static run(){new Socket("wss://example.test/review-runtime-symbol-toStringTag");}}).run();',
    ["wss://example.test/review-runtime-symbol-toStringTag"],
  ],
  [
    "runtime symbol asyncIterator",
    '(class {static [Symbol.asyncIterator]: any;static run(){new Socket("wss://example.test/review-runtime-symbol-asyncIterator");}}).run();const Socket=globalThis.WebSocket;',
    [],
  ],
  [
    "runtime symbol asyncIterator initialized",
    'const Socket=globalThis.WebSocket;(class {static [Symbol.asyncIterator]: any;static run(){new Socket("wss://example.test/review-runtime-symbol-asyncIterator");}}).run();',
    ["wss://example.test/review-runtime-symbol-asyncIterator"],
  ],
  [
    "runtime symbol shadowed",
    'const Symbol={iterator:"run"};(class {static [Symbol.iterator]: any;static run(){new Socket("wss://example.test/review-symbol-unknown");}}).run();const Socket=globalThis.WebSocket;',
    ["wss://example.test/review-symbol-unknown"],
  ],
  [
    "runtime symbol changed",
    'globalThis.Symbol={iterator:"run"};(class {static [Symbol.iterator]: any;static run(){new Socket("wss://example.test/review-symbol-unknown");}}).run();const Socket=globalThis.WebSocket;',
    ["wss://example.test/review-symbol-unknown"],
  ],
  [
    "later array iterator write remains conservative",
    '(async()=>{try{const [[x],y=await 0]=(function*(){try{yield [1];yield undefined;}finally{new Socket("wss://example.test/review-array-order");}})();}catch{}})();Array.prototype[Symbol.iterator]=function(){throw 0;};const Socket=globalThis.WebSocket;',
    [],
  ],
  [
    "array unrelated prototype write",
    'Array.prototype.unrelated=1;(async()=>{try{const [[x],y=await 0]=(function*(){try{yield [1];yield undefined;}finally{new Socket("wss://example.test/review-array-order");}})();}catch{}})();const Socket=globalThis.WebSocket;',
    ["wss://example.test/review-array-order"],
  ],
  [
    "array aliased throwing prototype",
    'const prototype=Array.prototype;prototype[Symbol.iterator]=function(){throw 0;};(async()=>{try{const [[x],y=await 0]=(function*(){try{yield [1];yield undefined;}finally{new Socket("wss://example.test/review-array-order");}})();}catch{}})();const Socket=globalThis.WebSocket;',
    [],
  ],
  [
    "array instance prototype throwing iterator",
    'const prototype=[].__proto__;prototype[Symbol.iterator]=function(){throw 0;};(async()=>{try{const [[x],y=await 0]=(function*(){try{yield [1];yield undefined;}finally{new Socket("wss://example.test/review-array-order");}})();}catch{}})();const Socket=globalThis.WebSocket;',
    [],
  ],
  [
    "erased class key does not wait",
    '(async()=>{(class{declare static [await 0]:any;static run(){new Socket("wss://example.test/review-erased-key-wait");}}).run()})();const Socket=globalThis.WebSocket;',
    [],
  ],
  [
    "runtime class key really waits",
    '(async()=>{(class{static [await 0]:any;static run(){new Socket("wss://example.test/review-erased-key-wait");}}).run()})();const Socket=globalThis.WebSocket;',
    ["wss://example.test/review-erased-key-wait"],
  ],
  [
    "object",
    'export {};const pending=(async()=>{await 0;new Socket("wss://example.test/review-rhs-object")})();try{({}).x=await pending}catch{}const Socket=globalThis.WebSocket;',
    [],
  ],
  [
    "computed",
    'export {};const pending=(async()=>{await 0;new Socket("wss://example.test/review-rhs-computed")})();try{({})["x"]=await pending}catch{}const Socket=globalThis.WebSocket;',
    [],
  ],
  [
    "null",
    'export {};const pending=(async()=>{await 0;new Socket("wss://example.test/review-rhs-null")})();try{null.x=await pending}catch{}const Socket=globalThis.WebSocket;',
    [],
  ],
  [
    "undefined",
    'export {};const pending=(async()=>{await 0;new Socket("wss://example.test/review-rhs-undefined")})();try{(void 0).x=await pending}catch{}const Socket=globalThis.WebSocket;',
    [],
  ],
  [
    "getter",
    'export {};const pending=(async()=>{await 0;new Socket("wss://example.test/review-rhs-getter")})();try{({get x(){throw 0}}).x=await pending}catch{}const Socket=globalThis.WebSocket;',
    [],
  ],
  [
    "setter",
    'export {};const pending=(async()=>{await 0;new Socket("wss://example.test/review-rhs-setter")})();try{({set x(v){throw 0}}).x=await pending}catch{}const Socket=globalThis.WebSocket;',
    [],
  ],
  [
    "throwing-key",
    'export {};const pending=(async()=>{await 0;new Socket("wss://example.test/review-rhs-throwing-key")})();try{({})[null.x]=await pending}catch{}const Socket=globalThis.WebSocket;',
    ["wss://example.test/review-rhs-throwing-key"],
  ],
  [
    "compound",
    'export {};const pending=(async()=>{await 0;new Socket("wss://example.test/review-rhs-compound")})();try{null.x+=await pending}catch{}const Socket=globalThis.WebSocket;',
    ["wss://example.test/review-rhs-compound"],
  ],
  [
    "prior-failure",
    'export {};const pending=(async()=>{await 0;new Socket("wss://example.test/review-rhs-prior-failure")})();try{null.x;({}).x=await pending}catch{}const Socket=globalThis.WebSocket;',
    ["wss://example.test/review-rhs-prior-failure"],
  ],
  [
    "prior-getter",
    'export {};const pending=(async()=>{await 0;new Socket("wss://example.test/review-rhs-prior-getter")})();try{({get x(){throw 0}}).x;({}).x=await pending}catch{}const Socket=globalThis.WebSocket;',
    ["wss://example.test/review-rhs-prior-getter"],
  ],
  [
    "ready",
    'export {};const Socket=globalThis.WebSocket;const pending=(async()=>{await 0;new Socket("wss://example.test/review-rhs-ready")})();try{({}).x=await pending}catch{}',
    ["wss://example.test/review-rhs-ready"],
  ],
  [
    "nested",
    'export {};const pending=(async()=>{await 0;new Socket("wss://example.test/review-rhs-nested")})();try{try{({}).x=await pending}finally{}}catch{}const Socket=globalThis.WebSocket;',
    [],
  ],
  [
    "class-before",
    'class Value{};(async()=>{try{const[{[await 0]:x},next]=(function*(){yield Value;new Socket("wss://example.test/review-class-before");yield 1})()}catch{}})();const Socket=globalThis.WebSocket;',
    ["wss://example.test/review-class-before"],
  ],
  [
    "class-after",
    '(async()=>{try{const[{[await 0]:x},next]=(function*(){yield Value;new Socket("wss://example.test/review-class-after");yield 1})()}catch{}})();class Value{};const Socket=globalThis.WebSocket;',
    [],
  ],
  [
    "class-extends",
    'class Base{};class Value extends Base{};(async()=>{try{const[{[await 0]:x},next]=(function*(){yield Value;new Socket("wss://example.test/review-class-extends");yield 1})()}catch{}})();const Socket=globalThis.WebSocket;',
    ["wss://example.test/review-class-extends"],
  ],
  [
    "await-receiver",
    'export {};const pending=(async()=>{await 0;new Socket("wss://example.test/review-await-receiver")})();try{(await pending).x=0}catch{}const Socket=globalThis.WebSocket;',
    [],
  ],
  [
    "await-key",
    'export {};const pending=(async()=>{await 0;new Socket("wss://example.test/review-await-key")})();try{({})[await pending]=0}catch{}const Socket=globalThis.WebSocket;',
    [],
  ],
  [
    "await-receiver-ready",
    'export {};const Socket=globalThis.WebSocket;const pending=(async()=>{await 0;new Socket("wss://example.test/review-await-receiver-ready")})();try{(await pending).x=0}catch{}',
    ["wss://example.test/review-await-receiver-ready"],
  ],

  [
    "assignment null",
    '(async()=>{try{for(const x of(function*(){try{yield 0}finally{new Socket("wss://example.test/review-assignment-null")}})()){null.x=await 0}}catch{}})();const Socket=globalThis.WebSocket;',
    ["wss://example.test/review-assignment-null"],
  ],
  [
    "assignment void",
    '(async()=>{try{for(const x of(function*(){try{yield 0}finally{new Socket("wss://example.test/review-assignment-void")}})()){(void 0).x=await 0}}catch{}})();const Socket=globalThis.WebSocket;',
    ["wss://example.test/review-assignment-void"],
  ],
  [
    "assignment computed",
    '(async()=>{try{for(const x of(function*(){try{yield 0}finally{new Socket("wss://example.test/review-assignment-computed")}})()){null["x"]=await 0}}catch{}})();const Socket=globalThis.WebSocket;',
    ["wss://example.test/review-assignment-computed"],
  ],
  [
    "assignment sequence",
    '(async()=>{try{for(const x of(function*(){try{yield 0}finally{new Socket("wss://example.test/review-assignment-sequence")}})()){(0,null).x=await 0}}catch{}})();const Socket=globalThis.WebSocket;',
    ["wss://example.test/review-assignment-sequence"],
  ],
  [
    "assignment compound",
    '(async()=>{try{for(const x of(function*(){try{yield 0}finally{new Socket("wss://example.test/review-assignment-compound")}})()){null.x+=await 0}}catch{}})();const Socket=globalThis.WebSocket;',
    [],
  ],
  [
    "assignment throwing-key",
    '(async()=>{try{for(const x of(function*(){try{yield 0}finally{new Socket("wss://example.test/review-assignment-throwing-key")}})()){null[null.x]=await 0}}catch{}})();const Socket=globalThis.WebSocket;',
    [],
  ],
  [
    "import attributes number",
    'export {};const options={with(){}};options.with.type=1;const {WebSocket:Socket}=await import("ws",options);new Socket("wss://example.test/review-import-number");',
    [],
  ],
  [
    "import attributes method-alias",
    'export {};const options={with(){}};const attrs=options.with;attrs.type=1;const {WebSocket:Socket}=await import("ws",options);new Socket("wss://example.test/review-import-method-alias");',
    [],
  ],
  [
    "import attributes escaped",
    'export {};const options={with(){}};mutate(options.with);const {WebSocket:Socket}=await import("ws",options);new Socket("wss://example.test/review-import-escaped");',
    [],
  ],
  [
    "import attributes unchanged",
    'export {};const options={with(){}};const {WebSocket:Socket}=await import("ws",options);new Socket("wss://example.test/review-import-unchanged");',
    ["wss://example.test/review-import-unchanged"],
  ],
  [
    "import attributes later-write",
    'export {};const options={with(){}};const {WebSocket:Socket}=await import("ws",options);new Socket("wss://example.test/review-import-later-write");options.with.type=1;',
    ["wss://example.test/review-import-later-write"],
  ],
  [
    "import attributes function-value",
    'export {};const attrs=function(){};const options={with:attrs};attrs.type=1;const {WebSocket:Socket}=await import("ws",options);new Socket("wss://example.test/review-import-function-value");',
    [],
  ],
  [
    "import attributes unrelated",
    'export {};const options={with(){},other:{}};options.other.type=1;const {WebSocket:Socket}=await import("ws",options);new Socket("wss://example.test/review-import-unrelated");',
    ["wss://example.test/review-import-unrelated"],
  ],
  [
    "failed yielded object",
    '(async()=>{try{const[a,{[await 0]:b},c]=(function*(){yield 1;yield u;new Socket("wss://example.test/review-yield-object");yield 2})()}catch{}const u={}})();const Socket=globalThis.WebSocket;',
    [],
  ],
  [
    "failed yielded number",
    '(async()=>{try{const[a,{[await 0]:b},c]=(function*(){yield 1;yield u;new Socket("wss://example.test/review-yield-number");yield 2})()}catch{}const u=1})();const Socket=globalThis.WebSocket;',
    [],
  ],
  [
    "failed yielded function",
    '(async()=>{try{const[a,{[await 0]:b},c]=(function*(){yield 1;yield u;new Socket("wss://example.test/review-yield-function");yield 2})()}catch{}const u=function(){}})();const Socket=globalThis.WebSocket;',
    [],
  ],
  [
    "yield initialized",
    'const u={};(async()=>{const[a,{[await 0]:b},c]=(function*(){yield 1;yield u;new Socket("wss://example.test/review-yield-initialized");yield 2})()})();const Socket=globalThis.WebSocket;',
    ["wss://example.test/review-yield-initialized"],
  ],
  [
    "yield parameter",
    '(async(u)=>{const[a,{[await 0]:b},c]=(function*(){yield 1;yield u;new Socket("wss://example.test/review-yield-parameter");yield 2})()})({});const Socket=globalThis.WebSocket;',
    ["wss://example.test/review-yield-parameter"],
  ],
  [
    "yield earlier-cleanup",
    '(async()=>{try{const[a=await 0,b,c]=(function*(){try{yield;yield u;yield 2}finally{new Socket("wss://example.test/review-yield-earlier-cleanup")}})()}catch{}const u={};})();const Socket=globalThis.WebSocket;',
    ["wss://example.test/review-yield-earlier-cleanup"],
  ],

  [
    "dense alias defaults reuse settled prefixes",
    'const u=undefined;(async()=>{const[x0=await 0,x1=await 0,x2=await 0,x3=await 0,x4=await 0,x5=await 0,x6=await 0,x7=await 0,x8=await 0,x9=await 0,x10=await 0,x11=await 0,x12=await 0,x13=await 0,x14=await 0,x15=await 0,x16=await 0,x17=await 0,x18=await 0,x19=await 0,x20=await 0,x21=await 0,x22=await 0,x23=await 0,x24=await 0,x25=await 0,x26=await 0,x27=await 0,x28=await 0,x29=await 0,x30=await 0,x31=await 0,x32=await 0,x33=await 0,x34=await 0,x35=await 0,x36=await 0,x37=await 0,x38=await 0,x39=await 0,x40=await 0,x41=await 0,x42=await 0,x43=await 0,x44=await 0,x45=await 0,x46=await 0,x47=await 0,x48=await 0,x49=await 0,x50=await 0,x51=await 0,x52=await 0,x53=await 0,x54=await 0,x55=await 0,x56=await 0,x57=await 0,x58=await 0,x59=await 0,x60=await 0,x61=await 0,x62=await 0,x63=await 0,x64=await 0,x65=await 0,x66=await 0,x67=await 0,x68=await 0,x69=await 0,x70=await 0,x71=await 0,x72=await 0,x73=await 0,x74=await 0,x75=await 0,x76=await 0,x77=await 0,x78=await 0,x79=await 0,x80=await 0,x81=await 0,x82=await 0,x83=await 0,x84=await 0,x85=await 0,x86=await 0,x87=await 0,x88=await 0,x89=await 0,x90=await 0,x91=await 0,x92=await 0,x93=await 0,x94=await 0,x95=await 0,x96=await 0,x97=await 0,x98=await 0,x99=await 0,x100=await 0,x101=await 0,x102=await 0,x103=await 0,x104=await 0,x105=await 0,x106=await 0,x107=await 0,x108=await 0,x109=await 0,x110=await 0,x111=await 0,x112=await 0,x113=await 0,x114=await 0,x115=await 0,x116=await 0,x117=await 0,x118=await 0,x119=await 0,x120=await 0,x121=await 0,x122=await 0,x123=await 0,x124=await 0,x125=await 0,x126=await 0,x127=await 0,last]=(function*(){yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;yield u;new Socket("wss://example.test/resume-dense");yield 1})()})();const Socket=globalThis.WebSocket;',
    ["wss://example.test/resume-dense"],
  ],
  [
    "second yield alias selects default",
    'const u=undefined;(async()=>{const[a,b=await 0,c]=(function*(){yield 1;yield u;new Socket("wss://example.test/resume-default");yield 2})()})();const Socket=globalThis.WebSocket;',
    ["wss://example.test/resume-default"],
  ],
  [
    "later default cannot delay an earlier yield read",
    'const u=undefined;(async()=>{try{const[a,b=await 0,c]=(function*(){yield 1;new Socket("wss://example.test/resume-earlier");yield u;yield 2})()}catch{}})();const Socket=globalThis.WebSocket;',
    [],
  ],
  [
    "second alias without default stays eager",
    'const u=undefined;(async()=>{try{const[a,b,c]=(function*(){yield 1;yield u;new Socket("wss://example.test/resume-eager");yield 2})()}catch{}})();const Socket=globalThis.WebSocket;',
    [],
  ],
  [
    "second yield nullish binding blocks key wait",
    'const u=undefined;(async()=>{try{const[a,{[await 0]:b},c]=(function*(){yield 1;yield u;new Socket("wss://example.test/resume-blocked");yield 2})()}catch{}})();const Socket=globalThis.WebSocket;',
    [],
  ],
  [
    "second yield failed binding enters eager cleanup",
    'const u=null;(async()=>{try{const[a,{[await 0]:b},c]=(function*(){try{yield 1;yield u}finally{new Socket("wss://example.test/resume-cleanup")}})()}catch{}})();const Socket=globalThis.WebSocket;',
    [],
  ],
  [
    "earlier required default survives later alias",
    'const u=undefined;(async()=>{const[a=await 0,b=await 0,c]=(function*(){yield undefined;yield u;new Socket("wss://example.test/resume-prior");yield 2})()})();const Socket=globalThis.WebSocket;',
    ["wss://example.test/resume-prior"],
  ],
  [
    "producer local second yield alias",
    '(async()=>{const[a,b=await 0,c]=(function*(){yield 1;const u=undefined;yield u;new Socket("wss://example.test/resume-local");yield 2})()})();const Socket=globalThis.WebSocket;',
    ["wss://example.test/resume-local"],
  ],
  [
    "second yield cannot read late alias",
    '(async()=>{try{const[a,b=await 0,c]=(function*(){yield 1;yield u;new Socket("wss://example.test/resume-late");yield 2})()}catch{}const u=undefined})();const Socket=globalThis.WebSocket;',
    [],
  ],
  [
    "repeated aliases after multiple resumes",
    'const u=undefined;const v=u;(async()=>{const[a,b=await 0,c=await 0,d]=(function*(){yield 1;yield u;yield v;new Socket("wss://example.test/resume-chain");yield 2})()})();const Socket=globalThis.WebSocket;',
    ["wss://example.test/resume-chain"],
  ],
  [
    "initialized second yield cleanup preserves endpoint",
    'const Socket=globalThis.WebSocket;const u=null;(async()=>{try{const[a,{[await 0]:b},c]=(function*(){try{yield 1;yield u}finally{new Socket("wss://example.test/resume-initialized")}})()}catch{}})();',
    ["wss://example.test/resume-initialized"],
  ],
  [
    "second yield nonnull alias skips default",
    'const u={};(async()=>{try{const[a,b=await 0,c]=(function*(){yield 1;yield u;new Socket("wss://example.test/resume-object");yield 2})()}catch{}})();const Socket=globalThis.WebSocket;',
    [],
  ],
  [
    "later alias initialization cannot lend default wait",
    '(async()=>{try{const[value=await 0,next]=(function*(){try{yield u}finally{new Socket("wss://example.test/alias-late")}})()}catch{}const u=undefined;})();const Socket=globalThis.WebSocket;',
    [],
  ],
  [
    "alias initialized after generator creation",
    '(async()=>{try{const values=(function*(){yield u;new Socket("wss://example.test/alias-created");yield{}})();const u=undefined;const[{[await 0]:x},next]=values; }catch{}})();const Socket=globalThis.WebSocket;',
    [],
  ],

  [
    "mutable object is not treated as undefined",
    '(async()=>{let u=undefined;u={};for(const{[await 0]:x}of(function*(){yield u;new Socket("wss://example.test/alias-mutable");yield{}})()){} })();const Socket=globalThis.WebSocket;',
    ["wss://example.test/alias-mutable"],
  ],
  [
    "producer local undefined alias",
    '(async()=>{try{for(const{[await 0]:x}of(function*(){const u=undefined;yield u;new Socket("wss://example.test/alias-local");yield{}})()){} }catch{}})();const Socket=globalThis.WebSocket;',
    [],
  ],
  [
    "producer local null alias",
    '(async()=>{try{for(const{[await 0]:x}of(function*(){const u=null;yield u;new Socket("wss://example.test/alias-local-null");yield{}})()){} }catch{}})();const Socket=globalThis.WebSocket;',
    [],
  ],
  [
    "nullish alias cleanup precedes key wait",
    '(async()=>{try{const u=undefined;for(const{[await 0]:x}of(function*(){try{yield u}finally{new Socket("wss://example.test/alias-cleanup")}})()){} }catch{}})();const Socket=globalThis.WebSocket;',
    [],
  ],
  [
    "initialized nullish alias cleanup",
    'const Socket=globalThis.WebSocket;(async()=>{try{const u=undefined;for(const{[await 0]:x}of(function*(){try{yield u}finally{new Socket("wss://example.test/alias-initialized-cleanup")}})()){} }catch{}})();',
    ["wss://example.test/alias-initialized-cleanup"],
  ],
  [
    "number alias permits object coercion",
    '(async()=>{const u=1;for(const{[await 0]:x}of(function*(){yield u;new Socket("wss://example.test/alias-number");yield{}})()){} })();const Socket=globalThis.WebSocket;',
    ["wss://example.test/alias-number"],
  ],

  [
    "constant undefined before binding",
    '(async()=>{try{const u=undefined;for(const{[await 0]:x}of(function*(){yield u;new Socket("wss://example.test/alias-undefined");yield{}})()){} }catch{}})();const Socket=globalThis.WebSocket;',
    [],
  ],
  [
    "constant null before binding",
    '(async()=>{try{const u=null;for(const{[await 0]:x}of(function*(){yield u;new Socket("wss://example.test/alias-null");yield{}})()){} }catch{}})();const Socket=globalThis.WebSocket;',
    [],
  ],
  [
    "constant void before binding",
    '(async()=>{try{const u=void 0;for(const{[await 0]:x}of(function*(){yield u;new Socket("wss://example.test/alias-void");yield{}})()){} }catch{}})();const Socket=globalThis.WebSocket;',
    [],
  ],
  [
    "constant alias chain before binding",
    '(async()=>{try{const first=undefined;const u=first;for(const{[await 0]:x}of(function*(){yield u;new Socket("wss://example.test/alias-chain");yield{}})()){} }catch{}})();const Socket=globalThis.WebSocket;',
    [],
  ],
  [
    "constant undefined blocks nested iterator",
    '(async()=>{try{const u=undefined;for(const[x=await 0]of(function*(){yield u;new Socket("wss://example.test/alias-array");yield[]})()){} }catch{}})();const Socket=globalThis.WebSocket;',
    [],
  ],
  [
    "constant object retains key wait",
    '(async()=>{const u={};for(const{[await 0]:x}of(function*(){yield u;new Socket("wss://example.test/alias-object");yield{}})()){} })();const Socket=globalThis.WebSocket;',
    ["wss://example.test/alias-object"],
  ],
  [
    "constant undefined selects array default",
    '(async()=>{const u=undefined;const[value=await 0,next]=(function*(){yield u;new Socket("wss://example.test/alias-default");yield 1})();})();const Socket=globalThis.WebSocket;',
    ["wss://example.test/alias-default"],
  ],
  [
    "shadowed undefined is an object",
    '(async()=>{const undefined={};const u=undefined;for(const{[await 0]:x}of(function*(){yield u;new Socket("wss://example.test/alias-shadowed");yield{}})()){} })();const Socket=globalThis.WebSocket;',
    ["wss://example.test/alias-shadowed"],
  ],
  [
    "unknown parameter may be object",
    '(async(u)=>{for(const{[await 0]:x}of(function*(){yield u;new Socket("wss://example.test/alias-parameter");yield{}})()){} })({});const Socket=globalThis.WebSocket;',
    ["wss://example.test/alias-parameter"],
  ],

  [
    "bare yield blocks object binding",
    '(async()=>{try{for(const{missing=await 0,[await 0]:x}of(function*(){yield;new Socket("wss://example.test/bare");yield{}})()){} }catch{}})();const Socket=globalThis.WebSocket;',
    [],
  ],
  [
    "bare yield blocks array binding",
    '(async()=>{try{for(const[x=await 0]of(function*(){yield;new Socket("wss://example.test/bare-array");yield[]})()){} }catch{}})();const Socket=globalThis.WebSocket;',
    [],
  ],
  [
    "explicit undefined blocks binding",
    '(async()=>{try{for(const{missing=await 0,[await 0]:x}of(function*(){yield undefined;new Socket("wss://example.test/explicit-undefined");yield{}})()){} }catch{}})();const Socket=globalThis.WebSocket;',
    [],
  ],
  [
    "null blocks binding",
    '(async()=>{try{for(const{missing=await 0,[await 0]:x}of(function*(){yield null;new Socket("wss://example.test/null");yield{}})()){} }catch{}})();const Socket=globalThis.WebSocket;',
    [],
  ],
  [
    "bare yield selects object default",
    '(async()=>{const[{missing=await 0,[await 0]:x}={},next]=(function*(){yield;new Socket("wss://example.test/bare-default");yield{}})(); })();const Socket=globalThis.WebSocket;',
    ["wss://example.test/bare-default"],
  ],
  [
    "bare yield selects scalar default",
    '(async()=>{const[value=await 0,next]=(function*(){yield;new Socket("wss://example.test/bare-scalar");yield 1})(); })();const Socket=globalThis.WebSocket;',
    ["wss://example.test/bare-scalar"],
  ],
  [
    "bare yield cleanup precedes waits",
    '(async()=>{try{for(const{missing=await 0,[await 0]:x}of(function*(){try{yield}finally{new Socket("wss://example.test/bare-cleanup")}})()){} }catch{}})();const Socket=globalThis.WebSocket;',
    [],
  ],
  [
    "initialized bare yield cleanup",
    'const Socket=globalThis.WebSocket;(async()=>{try{for(const{missing=await 0,[await 0]:x}of(function*(){try{yield}finally{new Socket("wss://example.test/bare-initialized-cleanup")}})()){} }catch{}})();',
    ["wss://example.test/bare-initialized-cleanup"],
  ],

  [
    "wrapped class after prefix wait",
    '(async()=>{(new (await 0,class{run([x]){}})()).run((function*(){new Socket("wss://example.test/wrapped-after-wait");yield 0})())})();const Socket=globalThis.WebSocket;',
    ["wss://example.test/wrapped-after-wait"],
  ],
  [
    "loop required key after optional default",
    '(async()=>{for(const{missing=await 0,[await 0]:x}of(function*(){yield{};new Socket("wss://example.test/loop-later-key");yield{}})()){} })();const Socket=globalThis.WebSocket;',
    ["wss://example.test/loop-later-key"],
  ],

  [
    "wrapped class method",
    '(new (0,class{run([x]){}})()).run((function*(){new Socket("wss://example.test/wrapped-class");yield 0})());const Socket=globalThis.WebSocket;',
    [],
  ],
  [
    "initialized wrapped class method",
    'const Socket=globalThis.WebSocket;(new (0,class{run([x]){}})()).run((function*(){new Socket("wss://example.test/wrapped-initialized");yield 0})());',
    ["wss://example.test/wrapped-initialized"],
  ],
  [
    "wrapped class setter",
    '(new (0,class{set run([x]){}})()).run=(function*(){new Socket("wss://example.test/wrapped-setter");yield 0})();const Socket=globalThis.WebSocket;',
    [],
  ],
  [
    "conditional class method",
    '(new (true?class{run([x]){}}:class{})()).run((function*(){new Socket("wss://example.test/conditional-class");yield 0})());const Socket=globalThis.WebSocket;',
    [],
  ],
  [
    "required key after optional default",
    '(async()=>{const[{missing=await 0,[await 0]:x},next]=(function*(){yield{};new Socket("wss://example.test/later-key");yield 1})();})();const Socket=globalThis.WebSocket;',
    ["wss://example.test/later-key"],
  ],
  [
    "required key after selected default",
    '(async()=>{const[{missing=await 0,[await 0]:x},next]=(function*(){yield{missing:undefined};new Socket("wss://example.test/selected-key");yield 1})();})();const Socket=globalThis.WebSocket;',
    ["wss://example.test/selected-key"],
  ],
  [
    "required key after skipped default",
    '(async()=>{const[{missing=await 0,[await 0]:x},next]=(function*(){yield{missing:1};new Socket("wss://example.test/skipped-key");yield 1})();})();const Socket=globalThis.WebSocket;',
    ["wss://example.test/skipped-key"],
  ],
  [
    "cleanup cannot borrow key after optional default",
    'Object.defineProperty(Object.prototype,"missing",{get(){throw 0},configurable:true});(async()=>{try{const[{missing=await 0,[await 0]:x},next]=(function*(){try{yield{};yield 1}finally{new Socket("wss://example.test/cleanup-key")}})()}catch{}})();const Socket=globalThis.WebSocket;',
    [],
  ],

  [
    "fresh instance method parameter",
    '(new(class{run([x]){}})()).run((function*(){new Socket("wss://example.test/instance-method");yield 0})());const Socket=globalThis.WebSocket;',
    [],
  ],
  [
    "fresh instance setter parameter",
    '(new(class{set consume([x]){}})()).consume=(function*(){new Socket("wss://example.test/instance-setter");yield 0})();const Socket=globalThis.WebSocket;',
    [],
  ],

  [
    "stored generator after wait",
    '(async()=>{const values=(function*(){new Socket("wss://example.test/stored");yield 0})();await 0;const [x]=values})();const Socket=globalThis.WebSocket;',
    ["wss://example.test/stored"],
  ],
  [
    "stored generator before initialization",
    'const values=(function*(){new Socket("wss://example.test/stored-early");yield 0})();const [x]=values;const Socket=globalThis.WebSocket;',
    [],
  ],

  [
    "later getter",
    'const { unused, run } = { get run() { new Socket("wss://example.test/later-getter"); } }; const Socket = globalThis.WebSocket;',
    [],
  ],
  [
    "later assigned getter",
    'let unused, run; ({ unused, run } = { get run() { new Socket("wss://example.test/assigned-getter"); } }); const Socket = globalThis.WebSocket;',
    [],
  ],
  [
    "initialized later getter",
    'const Socket = globalThis.WebSocket; const { unused, run } = { get run() { new Socket("wss://example.test/initialized-getter"); } };',
    ["wss://example.test/initialized-getter"],
  ],
  [
    "earlier pattern default waits",
    '(async()=>{ const { unused = await 0, run } = { get run() { new Socket("wss://example.test/earlier-default"); } }; })(); const Socket = globalThis.WebSocket;',
    ["wss://example.test/earlier-default"],
  ],
  [
    "earlier pattern key waits",
    '(async()=>{ const { [void await 0]: unused, run } = { get run() { new Socket("wss://example.test/earlier-key"); } }; })(); const Socket = globalThis.WebSocket;',
    ["wss://example.test/earlier-key"],
  ],
  [
    "known earlier default waits",
    '(async()=>{ const { unused = await 0, run } = { unused: undefined, get run() { new Socket("wss://example.test/known-default"); } }; })(); const Socket = globalThis.WebSocket;',
    ["wss://example.test/known-default"],
  ],
  [
    "failed callback argument",
    'const invoke = run => run(); const connect = () => new Socket("wss://example.test/argument"); function earlier() { try { invoke(alias); } catch {} } earlier(); const alias = connect; const Socket = globalThis.WebSocket; invoke(connect);',
    ["wss://example.test/argument"],
  ],
  [
    "failed callback alias chain",
    'const invoke = run => run(); const connect = () => new Socket("wss://example.test/alias-chain"); function earlier() { try { invoke(alias); } catch {} } earlier(); const other = connect; const alias = other; const Socket = globalThis.WebSocket; invoke(connect);',
    ["wss://example.test/alias-chain"],
  ],
  [
    "initialized callback argument still orders entry",
    'const invoke = run => run(); const connect = () => new Socket("wss://example.test/early-argument"); const alias = connect; invoke(alias); const Socket = globalThis.WebSocket;',
    [],
  ],
  [
    "later callback alias works",
    'const invoke = run => run(); const connect = () => new Socket("wss://example.test/later-alias"); function later() { invoke(alias); } const alias = connect; const Socket = globalThis.WebSocket; later();',
    ["wss://example.test/later-alias"],
  ],
  [
    "callback call helper",
    'const invoke = run => run.call(null); const connect = () => new Socket("wss://example.test/callback-call"); const Socket = globalThis.WebSocket; invoke(connect);',
    ["wss://example.test/callback-call"],
  ],
  [
    "callback apply helper",
    'const invoke = run => run.apply(null, []); const connect = () => new Socket("wss://example.test/callback-apply"); const Socket = globalThis.WebSocket; invoke(connect);',
    ["wss://example.test/callback-apply"],
  ],
  [
    "changed string iterator",
    'String.prototype[Symbol.iterator] = function(){ throw 0; }; (async()=>{ try { const [[x], y = await 0] = (function*(){ try { yield "a"; yield undefined; } finally { new Socket("wss://example.test/string-iterator"); } })(); } catch {} })(); const Socket = globalThis.WebSocket;',
    [],
  ],
  [
    "aliased changed string iterator",
    'const prototype = String.prototype; prototype[Symbol.iterator] = function(){ throw 0; }; (async()=>{ try { const [[x], y = await 0] = (function*(){ try { yield "a"; yield undefined; } finally { new Socket("wss://example.test/string-alias"); } })(); } catch {} })(); const Socket = globalThis.WebSocket;',
    [],
  ],
  [
    "native string iterator preserves later wait",
    '(async()=>{ const [[x], y = await 0] = (function*(){ try { yield "a"; yield undefined; } finally { new Socket("wss://example.test/native-string"); } })(); })(); const Socket = globalThis.WebSocket;',
    ["wss://example.test/native-string"],
  ],
  [
    "unrelated string property preserves iteration",
    'String.prototype.unrelated = 0; (async()=>{ const [[x], y = await 0] = (function*(){ try { yield "a"; yield undefined; } finally { new Socket("wss://example.test/unrelated-string"); } })(); })(); const Socket = globalThis.WebSocket;',
    ["wss://example.test/unrelated-string"],
  ],
  [
    "later iterator write follows acquisition",
    '(async()=>{ const [[x], y = await 0] = (function*(){ try { yield "a"; yield undefined; } finally { new Socket("wss://example.test/later-string"); } })(); })(); String.prototype[Symbol.iterator] = function(){ throw 0; }; const Socket = globalThis.WebSocket;',
    ["wss://example.test/later-string"],
  ],
  [
    "initialized cleanup after changed iterator",
    'const Socket = globalThis.WebSocket; String.prototype[Symbol.iterator] = function(){ throw 0; }; (async()=>{ try { const [[x], y = await 0] = (function*(){ try { yield "a"; yield undefined; } finally { new Socket("wss://example.test/initialized-string"); } })(); } catch {} })();',
    ["wss://example.test/initialized-string"],
  ],
] as const;

for (const consumer of ["source", "captured"] as const) {
  it.each(cases)(
    `${consumer} preserves activation order: %s`,
    (_name, source, expected) => {
      if (consumer === "source") {
        const standalone = analyzeJavaScriptStaticSource(source);
        expect(standalone.parse_status).not.toBe("failed");
        expect(standalone.endpoints.map(({ value }) => value)).toEqual(
          expected,
        );
      } else {
        const captured = analyzeWebBundleFixture(
          createWebPageInspection([
            {
              source,
              scriptKey: `scr_${"1".repeat(64)}`,
              url: "https://app.example.test/main.js",
              origin: "https://app.example.test",
              cdpHash: "hash",
            },
          ]),
        );
        expect(
          captured.observations.endpoints.map(({ value }) => value),
        ).toEqual(expected);
      }
    },
  );
}

it("retains all independently stored generator consumers", () => {
  const count = 80;
  const entries = Array.from(
    { length: count },
    (_, index) =>
      `const values${index}=(function*(){new Socket("wss://example.test/stored-${index}");yield 0})();const [item${index}]=values${index};`,
  ).join("");
  const source = `const Socket=globalThis.WebSocket;${entries}`;
  const endpoints = analyzeJavaScriptStaticSource(source).endpoints.map(
    ({ value }) => value,
  );
  expect(endpoints).toHaveLength(count);
  expect(new Set(endpoints)).toEqual(
    new Set(
      Array.from(
        { length: count },
        (_, index) => `wss://example.test/stored-${index}`,
      ),
    ),
  );
});
