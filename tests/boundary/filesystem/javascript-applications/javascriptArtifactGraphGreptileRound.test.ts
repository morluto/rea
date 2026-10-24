import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";
import { scanCanonicalArtifactInventory } from "../../../fixtures/artifactInventory.js";
import { readJavaScriptArtifactFiles } from "../../../support/javascriptApplicationScope.js";
import { createJavaScriptArtifactReader } from "../../../../src/artifacts/javascript/JavaScriptArtifactReader.js";
import { analyzeJavaScriptArtifactFiles } from "../../../../src/application/javascript/JavaScriptArtifactAnalysis.js";
import { buildJavaScriptArtifactGraph } from "../../../../src/application/javascript/JavaScriptArtifactGraphBuilder.js";

const sources = [
  {
    file: "review-implicit-0.mjs",
    source:
      '(async()=>{[({})[await 0]]=(function*(){new Socket("wss://example.test/reference");yield 0})()})();const Socket=globalThis.WebSocket;',
    endpoint: "wss://example.test/reference",
  },
  {
    file: "review-implicit-1.mjs",
    source:
      'let args;try{(()=>{}).apply(null,args={length:2,get 0(){throw 0},get 1(){new Socket("wss://example.test/later-getter")}})}catch{}const Socket=globalThis.WebSocket;args[1];',
    endpoint: "wss://example.test/later-getter",
  },
  {
    file: "review-implicit-2.mjs",
    source:
      'export {};function expose(value){}const pending=(async()=>{await 0;Object.keys({});new Socket("wss://example.test/stale-wait")})();expose(Object);try{await pending.then(()=>{})}catch{}const Socket=globalThis.WebSocket;',
  },
  {
    file: "review-apply-rest-6.mjs",
    source:
      '(()=>{}).apply(null,{length:1,get 0(){new Socket("wss://example.test/apply-index")}});const Socket=globalThis.WebSocket;',
  },
  {
    file: "review-apply-rest-7.mjs",
    source:
      '(async()=>{(()=>{}).apply(null,{get length(){new Socket("wss://example.test/apply-args-wait");return 0}},await 0)})();const Socket=globalThis.WebSocket;',
    endpoint: "wss://example.test/apply-args-wait",
  },
  {
    file: "review-apply-rest-8.mjs",
    source:
      'const Socket=globalThis.WebSocket;(()=>{}).apply(null,{length:1,get 0(){new Socket("wss://example.test/apply-index-ready")}});',
    endpoint: "wss://example.test/apply-index-ready",
  },
  {
    file: "review-apply-rest-9.mjs",
    source:
      'const fn=()=>{};fn.apply=(unused,list)=>queueMicrotask(()=>list.length);fn.apply(null,{get length(){new Socket("wss://example.test/apply-replaced");return 0}});const Socket=globalThis.WebSocket;',
    endpoint: "wss://example.test/apply-replaced",
  },
  {
    file: "review-apply-rest-10.mjs",
    source:
      '(async()=>{({...null[(await 0,null.x)]}={get entry(){new Socket("wss://example.test/rest-key-throws")}})})();const Socket=globalThis.WebSocket;',
  },
  {
    file: "review-apply-rest-11.mjs",
    source:
      '(async()=>{({...((await 0,null).x.y)}={get entry(){new Socket("wss://example.test/rest-nested-throws")}})})();const Socket=globalThis.WebSocket;',
  },

  {
    file: "review-apply-rest-0.mjs",
    source:
      '(()=>{}).apply(null,{get length(){new Socket("wss://example.test/apply-length");return 0}});const Socket=globalThis.WebSocket;',
  },
  {
    file: "review-apply-rest-1.mjs",
    source:
      'const Socket=globalThis.WebSocket;(()=>{}).apply(null,{get length(){new Socket("wss://example.test/apply-length-initialized");return 0}});',
    endpoint: "wss://example.test/apply-length-initialized",
  },
  {
    file: "review-apply-rest-2.mjs",
    source:
      '(async()=>{({...((await 0,null).x)}={get entry(){new Socket("wss://example.test/rest-reference")}})})();const Socket=globalThis.WebSocket;',
    endpoint: "wss://example.test/rest-reference",
  },
  {
    file: "review-apply-rest-3.mjs",
    source:
      '({...((null).x)}={get entry(){new Socket("wss://example.test/rest-early")}});const Socket=globalThis.WebSocket;',
  },
  {
    file: "review-apply-rest-4.mjs",
    source:
      '(async()=>{({...((null.x,await 0,{}).x)}={get entry(){new Socket("wss://example.test/rest-base-throws")}})})();const Socket=globalThis.WebSocket;',
  },
  {
    file: "review-apply-rest-5.mjs",
    source:
      '(async()=>{({...null[await 0]}={get entry(){new Socket("wss://example.test/rest-key-waits")}})})();const Socket=globalThis.WebSocket;',
    endpoint: "wss://example.test/rest-key-waits",
  },

  {
    file: "escaped-capture-0.mjs",
    source:
      'function replace(root){root.WebSocket=class{}};function run(i){const Socket=globalThis.WebSocket;replace(globalThis);if(i)new Socket("wss://example.test/repeated-capture")}function unknown(fn){fn(false)}unknown(run);run(true);',
  },
  {
    file: "escaped-capture-1.mjs",
    source:
      'function replace(root){root.WebSocket=class{}};function run(i){const Socket=globalThis.WebSocket;replace(globalThis);if(i)new Socket("wss://example.test/repeated-capture")}const alias=run;function unknown(fn){fn(false)}unknown(alias);run(true);',
  },
  {
    file: "escaped-capture-2.mjs",
    source:
      'function replace(root){root.WebSocket=class{}};function run(i){const Socket=globalThis.WebSocket;replace(globalThis);if(i)new Socket("wss://example.test/repeated-capture")}unknown(run);run(true);',
  },

  {
    file: "repeated-capture-0.mjs",
    source:
      'function replace(root){root.WebSocket=class{}};for(let i=0;i<2;i++){const Socket=globalThis.WebSocket;replace(globalThis);if(i===1)new Socket("wss://example.test/repeated-capture");}',
  },
  {
    file: "repeated-capture-1.mjs",
    source:
      'function replace(root){root.WebSocket=class{}};let i=0;while(i<2){const Socket=globalThis.WebSocket;replace(globalThis);if(i===1)new Socket("wss://example.test/repeated-capture");i++;}',
  },
  {
    file: "repeated-capture-2.mjs",
    source:
      'function replace(root){root.WebSocket=class{}};let i=0;do{const Socket=globalThis.WebSocket;replace(globalThis);if(i===1)new Socket("wss://example.test/repeated-capture");i++;}while(i<2);',
  },
  {
    file: "repeated-capture-3.mjs",
    source:
      'function replace(root){root.WebSocket=class{}};for(const i of [0,1]){const Socket=globalThis.WebSocket;replace(globalThis);if(i===1)new Socket("wss://example.test/repeated-capture");}',
  },
  {
    file: "repeated-capture-4.mjs",
    source:
      'function replace(root){root.WebSocket=class{}};for(const key in {a:0,b:1}){const i=key==="a"?0:1;const Socket=globalThis.WebSocket;replace(globalThis);if(i===1)new Socket("wss://example.test/repeated-capture");}',
  },
  {
    file: "repeated-capture-5.mjs",
    source:
      'function replace(root){root.WebSocket=class{}};for(let outer=0;outer<1;outer++)for(let i=0;i<2;i++){const Socket=globalThis.WebSocket;replace(globalThis);if(i===1)new Socket("wss://example.test/repeated-capture");}',
  },
  {
    file: "repeated-capture-6.mjs",
    source:
      'function replace(root){root.WebSocket=class{}};for(let i=0;i<2;i++){const {WebSocket:Socket}=globalThis;replace(globalThis);if(i===1)new Socket("wss://example.test/repeated-capture");}',
  },
  {
    file: "repeated-capture-7.mjs",
    source:
      'function replace(root){root.WebSocket=class{}};function run(){for(let i=0;i<2;i++){const Socket=globalThis.WebSocket;replace(globalThis);if(i===1)new Socket("wss://example.test/repeated-capture");}}run();',
  },
  {
    file: "repeated-capture-8.mjs",
    source:
      'function replace(root){root.WebSocket=class{}};function run(i){const Socket=globalThis.WebSocket;replace(globalThis);if(i===1)new Socket("wss://example.test/repeated-capture");}for(let i=0;i<2;i++)run(i);',
  },
  {
    file: "repeated-capture-9.mjs",
    source:
      'function replace(root){root.WebSocket=class{}};function run(i){const Socket=globalThis.WebSocket;replace(globalThis);if(i===1)new Socket("wss://example.test/repeated-capture");}run(0);run(1);',
  },
  {
    file: "repeated-capture-10.mjs",
    source:
      'function replace(root){root.WebSocket=class{}};const run=i=>{const Socket=globalThis.WebSocket;replace(globalThis);if(i===1)new Socket("wss://example.test/repeated-capture");};run(0);run(1);',
  },
  {
    file: "repeated-capture-11.mjs",
    source:
      'function replace(root){root.WebSocket=class{}};function run(i){const Socket=globalThis.WebSocket;replace(globalThis);if(i===1)new Socket("wss://example.test/repeated-capture");}function outer(i){run(i)}for(let i=0;i<2;i++)outer(i);',
  },
  {
    file: "repeated-capture-12.mjs",
    source:
      'function replace(root){root.WebSocket=class{}};function run(i){const Socket=globalThis.WebSocket;replace(globalThis);if(i===1)new Socket("wss://example.test/repeated-capture");}function outer(i){run(i)}outer(0);outer(1);',
  },
  {
    file: "repeated-capture-13.mjs",
    source:
      'function replace(root){root.WebSocket=class{}};function run(i){const Socket=globalThis.WebSocket;replace(globalThis);if(i===1)new Socket("wss://example.test/repeated-capture");if(i===0)run(1)}run(0);',
  },
  {
    file: "repeated-capture-14.mjs",
    source:
      'function replace(root){root.WebSocket=class{}};const client={run(i){const Socket=globalThis.WebSocket;replace(globalThis);if(i===1)new Socket("wss://example.test/repeated-capture");}};client.run(0);client.run(1);',
  },
  {
    file: "repeated-capture-15.mjs",
    source:
      'function replace(root){root.WebSocket=class{}};class Client{run(i){const Socket=globalThis.WebSocket;replace(globalThis);if(i===1)new Socket("wss://example.test/repeated-capture");}}const client=new Client();client.run(0);client.run(1);',
  },
  {
    file: "repeated-capture-16.mjs",
    source:
      'function replace(root){root.WebSocket=class{}};const Socket=globalThis.WebSocket;for(let i=0;i<2;i++){replace(globalThis);new Socket("wss://example.test/repeated-capture")}',
    endpoint: "wss://example.test/repeated-capture",
  },
  {
    file: "repeated-capture-17.mjs",
    source:
      'function replace(root){root.WebSocket=class{}};const Socket=globalThis.WebSocket;let i=0;while(i++<2){replace(globalThis);new Socket("wss://example.test/repeated-capture")}',
    endpoint: "wss://example.test/repeated-capture",
  },
  {
    file: "repeated-capture-18.mjs",
    source:
      'function replace(root){root.WebSocket=class{}};const Socket=globalThis.WebSocket;do{replace(globalThis);new Socket("wss://example.test/repeated-capture")}while(false);',
    endpoint: "wss://example.test/repeated-capture",
  },
  {
    file: "repeated-capture-19.mjs",
    source:
      'function replace(root){root.WebSocket=class{}};const Socket=globalThis.WebSocket;for(const i of [0,1]){replace(globalThis);new Socket("wss://example.test/repeated-capture")}',
    endpoint: "wss://example.test/repeated-capture",
  },
  {
    file: "repeated-capture-20.mjs",
    source:
      'function replace(root){root.WebSocket=class{}};({run(){const Socket=globalThis.WebSocket;replace(globalThis);new Socket("wss://example.test/repeated-capture")}}).run();',
    endpoint: "wss://example.test/repeated-capture",
  },
  {
    file: "repeated-capture-21.mjs",
    source:
      'function replace(root){root.WebSocket=class{}};new(class{run(){const Socket=globalThis.WebSocket;replace(globalThis);new Socket("wss://example.test/repeated-capture")}})().run();',
    endpoint: "wss://example.test/repeated-capture",
  },
  {
    file: "repeated-capture-22.mjs",
    source:
      'function replace(root){root.WebSocket=class{}};const Socket=globalThis.WebSocket;function run(){replace(globalThis);new Socket("wss://example.test/repeated-capture")}run();run();',
    endpoint: "wss://example.test/repeated-capture",
  },
  {
    file: "repeated-capture-23.mjs",
    source:
      'function replace(root){root.WebSocket=class{}};function run(){const Socket=globalThis.WebSocket;replace(globalThis);new Socket("wss://example.test/repeated-capture")}',
  },

  {
    file: "function-capture-0.mjs",
    source:
      'function replace(root){root.WebSocket=class{}};function connect(){const Socket=globalThis.WebSocket;replace(globalThis);new Socket("wss://example.test/function-capture")}connect();',
    endpoint: "wss://example.test/function-capture",
  },
  {
    file: "function-capture-1.mjs",
    source:
      'function replace(root){root.WebSocket=class{}};(()=>{const Socket=globalThis.WebSocket;replace(globalThis);new Socket("wss://example.test/function-capture")})();',
    endpoint: "wss://example.test/function-capture",
  },
  {
    file: "function-capture-2.mjs",
    source:
      'function replace(root){root.WebSocket=class{}};function connect(){const {WebSocket:Socket}=globalThis;replace(globalThis);new Socket("wss://example.test/function-capture")}connect();',
    endpoint: "wss://example.test/function-capture",
  },
  {
    file: "function-capture-3.mjs",
    source:
      'function replace(root){root.WebSocket=class{}};const client={connect(){const Socket=globalThis.WebSocket;replace(globalThis);new Socket("wss://example.test/function-capture")}};client.connect();',
  },
  {
    file: "function-capture-4.mjs",
    source:
      'function replace(root){root.WebSocket=class{}};class Client{connect(){const Socket=globalThis.WebSocket;replace(globalThis);new Socket("wss://example.test/function-capture")}}new Client().connect();',
  },
  {
    file: "function-capture-5.mjs",
    source:
      'function replace(root){root.WebSocket=class{}};function connect(){const Socket=globalThis.WebSocket;{replace(globalThis);new Socket("wss://example.test/function-capture")}}connect();',
    endpoint: "wss://example.test/function-capture",
  },
  {
    file: "function-capture-6.mjs",
    source:
      'function replace(root){root.WebSocket=class{}};function connect(){replace(globalThis);const Socket=globalThis.WebSocket;new Socket("wss://example.test/function-capture")}connect();',
  },
  {
    file: "function-capture-7.mjs",
    source:
      'function replace(root){root.WebSocket=class{}};function connect(){const root=globalThis;replace(globalThis);new root.WebSocket("wss://example.test/function-capture")}connect();',
  },
  {
    file: "function-capture-8.mjs",
    source:
      'function replace(root){root.WebSocket=class{}};function connect(){const Socket=globalThis.WebSocket,ignored=replace(globalThis);new Socket("wss://example.test/function-capture")}connect();',
    endpoint: "wss://example.test/function-capture",
  },
  {
    file: "function-capture-9.mjs",
    source:
      'function replace(root){root.WebSocket=class{}};function connect(){const ignored=replace(globalThis),Socket=globalThis.WebSocket;new Socket("wss://example.test/function-capture")}connect();',
  },
  {
    file: "function-capture-10.mjs",
    source:
      'function replace(root){root.WebSocket=class{}};function connect(){const Socket=globalThis.WebSocket;new Socket("wss://example.test/function-capture")}replace(globalThis);connect();',
  },
  {
    file: "function-capture-11.mjs",
    source:
      'function replace(root){root.WebSocket=class{}};function connect(){const Socket=globalThis.WebSocket;new Socket("wss://example.test/function-capture")}connect();replace(globalThis);',
    endpoint: "wss://example.test/function-capture",
  },
  {
    file: "function-capture-12.mjs",
    source:
      'function replace(root){root.WebSocket=class{}};function escape(){replace(globalThis)}function connect(){const Socket=globalThis.WebSocket;escape();new Socket("wss://example.test/function-capture")}connect();',
    endpoint: "wss://example.test/function-capture",
  },
  {
    file: "function-capture-13.mjs",
    source:
      'function replace(root){root.WebSocket=class{}};function escape(){replace(globalThis)}function connect(){escape();const Socket=globalThis.WebSocket;new Socket("wss://example.test/function-capture")}connect();',
  },
  {
    file: "function-capture-14.mjs",
    source:
      'function replace(root){root.WebSocket=class{}};async function connect(){const Socket=globalThis.WebSocket;await 0;replace(globalThis);new Socket("wss://example.test/function-capture")}await connect();',
    endpoint: "wss://example.test/function-capture",
  },
  {
    file: "function-capture-15.mjs",
    source:
      'function replace(root){root.WebSocket=class{}};function connect(){for(let i=0;i<2;i++){if(i===0){replace(globalThis);continue}const Socket=globalThis.WebSocket;new Socket("wss://example.test/function-capture")}}connect();',
  },
  {
    file: "global-escape-0.mjs",
    source:
      'function replace(root){root.WebSocket=class{}};replace(globalThis);new globalThis.WebSocket("wss://example.test/global-escape");',
  },
  {
    file: "global-escape-1.mjs",
    source:
      'function replace(root){root.WebSocket=class{}};replace(globalThis);new WebSocket("wss://example.test/global-escape");',
  },
  {
    file: "global-escape-2.mjs",
    source:
      'const root=globalThis;function replace(root){root.WebSocket=class{}};replace(root);new root.WebSocket("wss://example.test/global-escape");',
  },
  {
    file: "global-escape-3.mjs",
    source:
      'function replace(root){root.WebSocket=class{}};replace(globalThis);const Socket=globalThis.WebSocket;new Socket("wss://example.test/global-escape");',
  },
  {
    file: "global-escape-4.mjs",
    source:
      'function replace(root){root.WebSocket=class{}};replace(globalThis);const {WebSocket:Socket}=globalThis;new Socket("wss://example.test/global-escape");',
  },
  {
    file: "global-escape-5.mjs",
    source:
      'const Socket=globalThis.WebSocket;function replace(root){root.WebSocket=class{}};replace(globalThis);new Socket("wss://example.test/global-escape");',
    endpoint: "wss://example.test/global-escape",
  },
  {
    file: "global-escape-6.mjs",
    source:
      'const {WebSocket:Socket}=globalThis;function replace(root){root.WebSocket=class{}};replace(globalThis);new Socket("wss://example.test/global-escape");',
    endpoint: "wss://example.test/global-escape",
  },
  {
    file: "global-escape-7.mjs",
    source:
      'new globalThis.WebSocket("wss://example.test/global-escape");function replace(root){root.WebSocket=class{}};replace(globalThis);',
    endpoint: "wss://example.test/global-escape",
  },
  {
    file: "global-escape-8.mjs",
    source:
      'const root=globalThis;function replace(root){root.WebSocket=class{}};replace(globalThis);new root.WebSocket("wss://example.test/global-escape");',
  },
  {
    file: "global-escape-9.mjs",
    source:
      'function replace(root){root.WebSocket=class{}};const Socket=globalThis.WebSocket,ignored=replace(globalThis);new Socket("wss://example.test/global-escape");',
    endpoint: "wss://example.test/global-escape",
  },
  {
    file: "global-escape-10.mjs",
    source:
      'function replace(root){root.WebSocket=class{}};const ignored=replace(globalThis),Socket=globalThis.WebSocket;new Socket("wss://example.test/global-escape");',
  },
  {
    file: "global-escape-11.mjs",
    source:
      'const other={};function replace(root){root.WebSocket=class{}};replace(other);new globalThis.WebSocket("wss://example.test/global-escape");',
    endpoint: "wss://example.test/global-escape",
  },
  {
    file: "global-escape-12.mjs",
    source:
      'function replace(root){root.WebSocket=class{}};replace(globalThis.globalThis);new globalThis.WebSocket("wss://example.test/global-escape");',
  },
  {
    file: "global-escape-13.mjs",
    source:
      'const Socket=globalThis.WebSocket;function replace(root){root.WebSocket=class{}};replace(globalThis);const connect=()=>new Socket("wss://example.test/global-escape");connect();',
    endpoint: "wss://example.test/global-escape",
  },
  {
    file: "reachability-28.mjs",
    source:
      'Array.prototype[Symbol.iterator]=function(){if(globalThis.flag){throw 0}else{throw 1}};(async()=>{try{const []=[];const [y=await 0]=(function*(){try{yield undefined}finally{new Socket("wss://example.test/reachability")}})();}catch{}})();const Socket=globalThis.WebSocket;',
  },
  {
    file: "reachability-29.mjs",
    source:
      'Array.prototype[Symbol.iterator]=function(){const ignored=0;throw ignored};(async()=>{try{const []=[];const [y=await 0]=(function*(){try{yield undefined}finally{new Socket("wss://example.test/reachability")}})();}catch{}})();const Socket=globalThis.WebSocket;',
  },
  {
    file: "reachability-30.mjs",
    source:
      'Array.prototype[Symbol.iterator]=function(){try{throw 0}catch{};return {next(){return {done:true}}}};(async()=>{try{const []=[];const [y=await 0]=(function*(){try{yield undefined}finally{new Socket("wss://example.test/reachability")}})();}catch{}})();const Socket=globalThis.WebSocket;',
    endpoint: "wss://example.test/reachability",
  },
  {
    file: "reachability-24.mjs",
    source:
      'Array.prototype[Symbol.iterator] = function(){ throw 0; }; (async()=>{ try { const [] = []; const [y = await 0] = (function*(){ try { yield undefined; } finally { new Socket("wss://example.test/empty"); } })(); } catch {} })(); const Socket = globalThis.WebSocket;',
  },
  {
    file: "reachability-25.mjs",
    source:
      'const Socket=globalThis.WebSocket;(async()=>{try{throw 0;const [y=await 0]=(function*(){try{yield undefined}finally{new Socket("wss://example.test/reachability")}})();}catch{}})();',
  },
  {
    file: "reachability-26.mjs",
    source:
      'const produce=function*(){try{yield undefined}finally{new Socket("wss://example.test/reachability")}};(async()=>{try{throw 0;const [x=await 0]=produce()}catch{};const[y=await 0]=produce()})();const Socket=globalThis.WebSocket;',
    endpoint: "wss://example.test/reachability",
  },
  {
    file: "reachability-27.mjs",
    source:
      '(async()=>{try{stop();const [y=await 0]=(function*(){try{yield undefined}finally{new Socket("wss://example.test/reachability")}})();}catch{}})();const Socket=globalThis.WebSocket;',
    endpoint: "wss://example.test/reachability",
  },
  {
    file: "reachability-0.mjs",
    source:
      'Array.prototype[Symbol.iterator]=function(){throw 0};(async()=>{try{const []=[];const [y=await 0]=(function*(){try{yield undefined}finally{new Socket("wss://example.test/reachability")}})();}catch{}})();const Socket=globalThis.WebSocket;',
  },
  {
    file: "reachability-1.mjs",
    source:
      'Array.prototype[Symbol.iterator]=function(){throw 0};(async()=>{try{const [x]=[];const [y=await 0]=(function*(){try{yield undefined}finally{new Socket("wss://example.test/reachability")}})();}catch{}})();const Socket=globalThis.WebSocket;',
  },
  {
    file: "reachability-2.mjs",
    source:
      'Array.prototype[Symbol.iterator]=function(){throw 0};(async()=>{try{let x;([]=[]);const [y=await 0]=(function*(){try{yield undefined}finally{new Socket("wss://example.test/reachability")}})();}catch{}})();const Socket=globalThis.WebSocket;',
  },
  {
    file: "reachability-3.mjs",
    source:
      '(async()=>{try{const []=[];const [y=await 0]=(function*(){try{yield undefined}finally{new Socket("wss://example.test/reachability")}})();}catch{}})();const Socket=globalThis.WebSocket;',
    endpoint: "wss://example.test/reachability",
  },
  {
    file: "reachability-4.mjs",
    source:
      '(async()=>{try{throw 0;const [y=await 0]=(function*(){try{yield undefined}finally{new Socket("wss://example.test/reachability")}})();}catch{}})();const Socket=globalThis.WebSocket;',
  },
  {
    file: "reachability-5.mjs",
    source:
      '(async()=>{try{const []=null;const [y=await 0]=(function*(){try{yield undefined}finally{new Socket("wss://example.test/reachability")}})();}catch{}})();const Socket=globalThis.WebSocket;',
  },
  {
    file: "reachability-6.mjs",
    source:
      '(async()=>{try{null.x;const [y=await 0]=(function*(){try{yield undefined}finally{new Socket("wss://example.test/reachability")}})();}catch{}})();const Socket=globalThis.WebSocket;',
  },
  {
    file: "reachability-7.mjs",
    source:
      '(async()=>{try{try{throw 0}catch{};const [y=await 0]=(function*(){try{yield undefined}finally{new Socket("wss://example.test/reachability")}})();}catch{}})();const Socket=globalThis.WebSocket;',
    endpoint: "wss://example.test/reachability",
  },
  {
    file: "reachability-8.mjs",
    source:
      '(async()=>{try{inert();const [y=await 0]=(function*(){try{yield undefined}finally{new Socket("wss://example.test/reachability")}})();}catch{}})();const Socket=globalThis.WebSocket;',
    endpoint: "wss://example.test/reachability",
  },
  {
    file: "reachability-9.mjs",
    source:
      'if(false){Array.prototype[Symbol.iterator]=function(){throw 0};}(async()=>{try{const []=[];const [y=await 0]=(function*(){try{yield undefined}finally{new Socket("wss://example.test/reachability")}})();}catch{}})();const Socket=globalThis.WebSocket;',
    endpoint: "wss://example.test/reachability",
  },
  {
    file: "reachability-10.mjs",
    source:
      'Array.prototype.unrelated=0;(async()=>{try{const []=[];const [y=await 0]=(function*(){try{yield undefined}finally{new Socket("wss://example.test/reachability")}})();}catch{}})();const Socket=globalThis.WebSocket;',
    endpoint: "wss://example.test/reachability",
  },
  {
    file: "reachability-11.mjs",
    source:
      'const original=Array.prototype[Symbol.iterator];Array.prototype[Symbol.iterator]=function(){throw 0};Array.prototype[Symbol.iterator]=original;(async()=>{try{const []=[];const [y=await 0]=(function*(){try{yield undefined}finally{new Socket("wss://example.test/reachability")}})();}catch{}})();const Socket=globalThis.WebSocket;',
    endpoint: "wss://example.test/reachability",
  },
  {
    file: "reachability-12.mjs",
    source:
      '{const Array={prototype:{}};Array.prototype[Symbol.iterator]=function(){throw 0};(async()=>{try{const []=[];const [y=await 0]=(function*(){try{yield undefined}finally{new Socket("wss://example.test/reachability")}})();}catch{}})();const Socket=globalThis.WebSocket;}',
    endpoint: "wss://example.test/reachability",
  },
  {
    file: "reachability-13.mjs",
    source:
      '{const Symbol={iterator:"different"};Array.prototype[Symbol.iterator]=function(){throw 0};(async()=>{try{const []=[];const [y=await 0]=(function*(){try{yield undefined}finally{new Socket("wss://example.test/reachability")}})();}catch{}})();const Socket=globalThis.WebSocket;}',
    endpoint: "wss://example.test/reachability",
  },
  {
    file: "reachability-14.mjs",
    source:
      'const Symbol={iterator:"different"};Array.prototype[Symbol.iterator]=function(){throw 0};(async()=>{try{const []=[];const [y=await 0]=(function*(){try{yield undefined}finally{new Socket("wss://example.test/reachability")}})();}catch{}})();const Socket=globalThis.WebSocket;',
    endpoint: "wss://example.test/reachability",
  },
  {
    file: "reachability-15.mjs",
    source:
      'Array.prototype[Symbol.iterator]=()=>{throw 0};(async()=>{try{const []=[];const [y=await 0]=(function*(){try{yield undefined}finally{new Socket("wss://example.test/reachability")}})();}catch{}})();const Socket=globalThis.WebSocket;',
  },
  {
    file: "reachability-16.mjs",
    source:
      'Array.prototype[Symbol.iterator]=async function(){throw 0};(async()=>{try{const []=[];const [y=await 0]=(function*(){try{yield undefined}finally{new Socket("wss://example.test/reachability")}})();}catch{}})();const Socket=globalThis.WebSocket;',
    endpoint: "wss://example.test/reachability",
  },
  {
    file: "reachability-17.mjs",
    source:
      '(async()=>{try{if(globalThis.flag){throw 0};const [y=await 0]=(function*(){try{yield undefined}finally{new Socket("wss://example.test/reachability")}})();}catch{}})();const Socket=globalThis.WebSocket;',
    endpoint: "wss://example.test/reachability",
  },
  {
    file: "reachability-18.mjs",
    source:
      '(async()=>{try{if(globalThis.flag){throw 0}else{throw 1};const [y=await 0]=(function*(){try{yield undefined}finally{new Socket("wss://example.test/reachability")}})();}catch{}})();const Socket=globalThis.WebSocket;',
  },
  {
    file: "reachability-19.mjs",
    source:
      '(async()=>{try{const values=(function*(){try{yield undefined}finally{new Socket("wss://example.test/reachability")}})();throw 0;const [y=await 0]=values;}catch{}})();const Socket=globalThis.WebSocket;',
  },
  {
    file: "reachability-20.mjs",
    source:
      '(async()=>{try{throw 0;const values=(function*(){try{yield undefined}finally{new Socket("wss://example.test/reachability")}})();const [y=await 0]=values;}catch{}})();const Socket=globalThis.WebSocket;',
  },
  {
    file: "reachability-21.mjs",
    source:
      '(async()=>{try{const []=null,y=(function*(){try{yield undefined}finally{new Socket("wss://example.test/reachability")}})();const [x=await 0]=y;}catch{}})();const Socket=globalThis.WebSocket;',
  },
  {
    file: "reachability-22.mjs",
    source:
      'Array.prototype[Symbol.iterator]=function(){throw 0};async function run(){try{const []=[];const [y=await 0]=(function*(){try{yield undefined}finally{new Socket("wss://example.test/reachability")}})();}catch{}}run();const Socket=globalThis.WebSocket;',
    endpoint: "wss://example.test/reachability",
  },
  {
    file: "reachability-23.mjs",
    source:
      'run();Array.prototype[Symbol.iterator]=function(){throw 0};async function run(){try{const []=[];const [y=await 0]=(function*(){try{yield undefined}finally{new Socket("wss://example.test/reachability")}})();}catch{}}const Socket=globalThis.WebSocket;',
    endpoint: "wss://example.test/reachability",
  },
  {
    file: "review37-0.mjs",
    source:
      'const {...rest}={get x(){new Socket("wss://example.test/review-copy-rest");}};const Socket=globalThis.WebSocket;',
  },
  {
    file: "review37-1.mjs",
    source:
      'const Socket=globalThis.WebSocket;const {...rest}={get x(){new Socket("wss://example.test/review-copy-rest");}};',
    endpoint: "wss://example.test/review-copy-rest",
  },
  {
    file: "review37-2.mjs",
    source:
      'const copied={...{get x(){new Socket("wss://example.test/review-copy-spread");}}};const Socket=globalThis.WebSocket;',
  },
  {
    file: "review37-3.mjs",
    source:
      'const Socket=globalThis.WebSocket;const copied={...{get x(){new Socket("wss://example.test/review-copy-spread");}}};',
    endpoint: "wss://example.test/review-copy-spread",
  },
  {
    file: "review37-4.mjs",
    source:
      'const copied={...{get x(){new Socket("wss://example.test/review-copy-spread-overwrite");}},x:0};const Socket=globalThis.WebSocket;',
  },
  {
    file: "review37-5.mjs",
    source:
      'const Socket=globalThis.WebSocket;const copied={...{get x(){new Socket("wss://example.test/review-copy-spread-overwrite");}},x:0};',
    endpoint: "wss://example.test/review-copy-spread-overwrite",
  },
  {
    file: "review37-6.mjs",
    source:
      'let rest;({...rest}={get x(){new Socket("wss://example.test/review-copy-assignment-rest");}});const Socket=globalThis.WebSocket;',
  },
  {
    file: "review37-7.mjs",
    source:
      'const Socket=globalThis.WebSocket;let rest;({...rest}={get x(){new Socket("wss://example.test/review-copy-assignment-rest");}});',
    endpoint: "wss://example.test/review-copy-assignment-rest",
  },
  {
    file: "review37-8.mjs",
    source:
      '(async()=>{try{const {[await "x"]:unused,...rest}={get x(){new Socket("wss://example.test/review-copy-prefix");}};}catch{}})();const Socket=globalThis.WebSocket;',
    endpoint: "wss://example.test/review-copy-prefix",
  },
  {
    file: "review37-9.mjs",
    source:
      '(async()=>{try{const {x:unused,y=await 0,...rest}={get x(){new Socket("wss://example.test/review-copy-prefix");}};}catch{}})();const Socket=globalThis.WebSocket;',
  },
  {
    file: "review37-10.mjs",
    source:
      '(async()=>{try{const copy={...{get x(){new Socket("wss://example.test/review-copy-prefix");}},[await 0]:0};}catch{}})();const Socket=globalThis.WebSocket;',
  },
  {
    file: "review37-11.mjs",
    source:
      '(async()=>{try{const copy={[await 0]:0,...{get x(){new Socket("wss://example.test/review-copy-prefix");}}};}catch{}})();const Socket=globalThis.WebSocket;',
    endpoint: "wss://example.test/review-copy-prefix",
  },
  {
    file: "review37-12.mjs",
    source:
      'const copy={...{run(){new Socket("wss://example.test/review-copy-prefix");}}};const Socket=globalThis.WebSocket;',
    endpoint: "wss://example.test/review-copy-prefix",
  },
  {
    file: "review37-13.mjs",
    source:
      'Array.prototype[Symbol.iterator]=function(){throw 0;};(async()=>{try{const [[x], y=await 0]=(function*(){try{yield [1];yield undefined;}finally{new Socket("wss://example.test/review-failed-array-13");}})();}catch{}})();const Socket=globalThis.WebSocket;',
  },
  {
    file: "review37-14.mjs",
    source:
      'const Socket=globalThis.WebSocket;Array.prototype[Symbol.iterator]=function(){throw 0;};(async()=>{try{const [[x], y=await 0]=(function*(){try{yield [1];yield undefined;}finally{new Socket("wss://example.test/review-failed-array-13");}})();}catch{}})();',
    endpoint: "wss://example.test/review-failed-array-13",
  },
  {
    file: "review37-15.mjs",
    source:
      '(async()=>{try{const [[x], y=await 0]=(function*(){try{yield [1];yield undefined;}finally{new Socket("wss://example.test/review-failed-array-13");}})();}catch{}})();const Socket=globalThis.WebSocket;',
    endpoint: "wss://example.test/review-failed-array-13",
  },
  {
    file: "review37-16.mjs",
    source:
      'Array.prototype[Symbol.iterator]=function(){throw 0;};(async()=>{try{const [[], y=await 0]=(function*(){try{yield [1];yield undefined;}finally{new Socket("wss://example.test/review-failed-array-16");}})();}catch{}})();const Socket=globalThis.WebSocket;',
  },
  {
    file: "review37-17.mjs",
    source:
      'const Socket=globalThis.WebSocket;Array.prototype[Symbol.iterator]=function(){throw 0;};(async()=>{try{const [[], y=await 0]=(function*(){try{yield [1];yield undefined;}finally{new Socket("wss://example.test/review-failed-array-16");}})();}catch{}})();',
    endpoint: "wss://example.test/review-failed-array-16",
  },
  {
    file: "review37-18.mjs",
    source:
      '(async()=>{try{const [[], y=await 0]=(function*(){try{yield [1];yield undefined;}finally{new Socket("wss://example.test/review-failed-array-16");}})();}catch{}})();const Socket=globalThis.WebSocket;',
    endpoint: "wss://example.test/review-failed-array-16",
  },
  {
    file: "review37-19.mjs",
    source:
      'Array.prototype[Symbol.iterator]=function(){throw 0;};(async()=>{try{const [[...x], y=await 0]=(function*(){try{yield [1];yield undefined;}finally{new Socket("wss://example.test/review-failed-array-19");}})();}catch{}})();const Socket=globalThis.WebSocket;',
  },
  {
    file: "review37-20.mjs",
    source:
      'const Socket=globalThis.WebSocket;Array.prototype[Symbol.iterator]=function(){throw 0;};(async()=>{try{const [[...x], y=await 0]=(function*(){try{yield [1];yield undefined;}finally{new Socket("wss://example.test/review-failed-array-19");}})();}catch{}})();',
    endpoint: "wss://example.test/review-failed-array-19",
  },
  {
    file: "review37-21.mjs",
    source:
      '(async()=>{try{const [[...x], y=await 0]=(function*(){try{yield [1];yield undefined;}finally{new Socket("wss://example.test/review-failed-array-19");}})();}catch{}})();const Socket=globalThis.WebSocket;',
    endpoint: "wss://example.test/review-failed-array-19",
  },
  {
    file: "review37-22.ts",
    source:
      '(class {declare static [Symbol.iterator]: any;static run(){new Socket("wss://example.test/review-erased-22");}}).run();const Socket=globalThis.WebSocket;',
  },
  {
    file: "review37-23.ts",
    source:
      'const Socket=globalThis.WebSocket;(class {declare static [Symbol.iterator]: any;static run(){new Socket("wss://example.test/review-erased-22");}}).run();',
    endpoint: "wss://example.test/review-erased-22",
  },
  {
    file: "review37-24.ts",
    source:
      '(class {declare static run: any;static run(){new Socket("wss://example.test/review-erased-24");}}).run();const Socket=globalThis.WebSocket;',
  },
  {
    file: "review37-25.ts",
    source:
      'const Socket=globalThis.WebSocket;(class {declare static run: any;static run(){new Socket("wss://example.test/review-erased-24");}}).run();',
    endpoint: "wss://example.test/review-erased-24",
  },
  {
    file: "review37-26.ts",
    source:
      '(class {declare [Symbol.iterator]: any;static run(){new Socket("wss://example.test/review-erased-26");}}).run();const Socket=globalThis.WebSocket;',
  },
  {
    file: "review37-27.ts",
    source:
      'const Socket=globalThis.WebSocket;(class {declare [Symbol.iterator]: any;static run(){new Socket("wss://example.test/review-erased-26");}}).run();',
    endpoint: "wss://example.test/review-erased-26",
  },
  {
    file: "review37-28.ts",
    source:
      '(class {static [Symbol.iterator]: any;static run(){new Socket("wss://example.test/review-runtime-symbol-iterator");}}).run();const Socket=globalThis.WebSocket;',
  },
  {
    file: "review37-29.ts",
    source:
      'const Socket=globalThis.WebSocket;(class {static [Symbol.iterator]: any;static run(){new Socket("wss://example.test/review-runtime-symbol-iterator");}}).run();',
    endpoint: "wss://example.test/review-runtime-symbol-iterator",
  },
  {
    file: "review37-30.ts",
    source:
      '(class {static [Symbol.toStringTag]: any;static run(){new Socket("wss://example.test/review-runtime-symbol-toStringTag");}}).run();const Socket=globalThis.WebSocket;',
  },
  {
    file: "review37-31.ts",
    source:
      'const Socket=globalThis.WebSocket;(class {static [Symbol.toStringTag]: any;static run(){new Socket("wss://example.test/review-runtime-symbol-toStringTag");}}).run();',
    endpoint: "wss://example.test/review-runtime-symbol-toStringTag",
  },
  {
    file: "review37-32.ts",
    source:
      '(class {static [Symbol.asyncIterator]: any;static run(){new Socket("wss://example.test/review-runtime-symbol-asyncIterator");}}).run();const Socket=globalThis.WebSocket;',
  },
  {
    file: "review37-33.ts",
    source:
      'const Socket=globalThis.WebSocket;(class {static [Symbol.asyncIterator]: any;static run(){new Socket("wss://example.test/review-runtime-symbol-asyncIterator");}}).run();',
    endpoint: "wss://example.test/review-runtime-symbol-asyncIterator",
  },
  {
    file: "review37-34.ts",
    source:
      'const Symbol={iterator:"run"};(class {static [Symbol.iterator]: any;static run(){new Socket("wss://example.test/review-symbol-unknown");}}).run();const Socket=globalThis.WebSocket;',
    endpoint: "wss://example.test/review-symbol-unknown",
  },
  {
    file: "review37-35.ts",
    source:
      'globalThis.Symbol={iterator:"run"};(class {static [Symbol.iterator]: any;static run(){new Socket("wss://example.test/review-symbol-unknown");}}).run();const Socket=globalThis.WebSocket;',
    endpoint: "wss://example.test/review-symbol-unknown",
  },
  {
    file: "review37-36.mjs",
    source:
      '(async()=>{try{const [[x],y=await 0]=(function*(){try{yield [1];yield undefined;}finally{new Socket("wss://example.test/review-array-order");}})();}catch{}})();Array.prototype[Symbol.iterator]=function(){throw 0;};const Socket=globalThis.WebSocket;',
  },
  {
    file: "review37-37.mjs",
    source:
      'Array.prototype.unrelated=1;(async()=>{try{const [[x],y=await 0]=(function*(){try{yield [1];yield undefined;}finally{new Socket("wss://example.test/review-array-order");}})();}catch{}})();const Socket=globalThis.WebSocket;',
    endpoint: "wss://example.test/review-array-order",
  },
  {
    file: "review37-38.mjs",
    source:
      'const prototype=Array.prototype;prototype[Symbol.iterator]=function(){throw 0;};(async()=>{try{const [[x],y=await 0]=(function*(){try{yield [1];yield undefined;}finally{new Socket("wss://example.test/review-array-order");}})();}catch{}})();const Socket=globalThis.WebSocket;',
  },
  {
    file: "review37-39.mjs",
    source:
      'const prototype=[].__proto__;prototype[Symbol.iterator]=function(){throw 0;};(async()=>{try{const [[x],y=await 0]=(function*(){try{yield [1];yield undefined;}finally{new Socket("wss://example.test/review-array-order");}})();}catch{}})();const Socket=globalThis.WebSocket;',
  },
  {
    file: "review37-40.ts",
    source:
      '(async()=>{(class{declare static [await 0]:any;static run(){new Socket("wss://example.test/review-erased-key-wait");}}).run()})();const Socket=globalThis.WebSocket;',
  },
  {
    file: "review37-41.ts",
    source:
      '(async()=>{(class{static [await 0]:any;static run(){new Socket("wss://example.test/review-erased-key-wait");}}).run()})();const Socket=globalThis.WebSocket;',
    endpoint: "wss://example.test/review-erased-key-wait",
  },
  {
    file: "review33-0.mjs",
    source:
      'export {};const pending=(async()=>{await 0;new Socket("wss://example.test/review-rhs-object")})();try{({}).x=await pending}catch{}const Socket=globalThis.WebSocket;',
  },
  {
    file: "review33-1.mjs",
    source:
      'export {};const pending=(async()=>{await 0;new Socket("wss://example.test/review-rhs-computed")})();try{({})["x"]=await pending}catch{}const Socket=globalThis.WebSocket;',
  },
  {
    file: "review33-2.mjs",
    source:
      'export {};const pending=(async()=>{await 0;new Socket("wss://example.test/review-rhs-null")})();try{null.x=await pending}catch{}const Socket=globalThis.WebSocket;',
  },
  {
    file: "review33-3.mjs",
    source:
      'export {};const pending=(async()=>{await 0;new Socket("wss://example.test/review-rhs-undefined")})();try{(void 0).x=await pending}catch{}const Socket=globalThis.WebSocket;',
  },
  {
    file: "review33-4.mjs",
    source:
      'export {};const pending=(async()=>{await 0;new Socket("wss://example.test/review-rhs-getter")})();try{({get x(){throw 0}}).x=await pending}catch{}const Socket=globalThis.WebSocket;',
  },
  {
    file: "review33-5.mjs",
    source:
      'export {};const pending=(async()=>{await 0;new Socket("wss://example.test/review-rhs-setter")})();try{({set x(v){throw 0}}).x=await pending}catch{}const Socket=globalThis.WebSocket;',
  },
  {
    file: "review33-6.mjs",
    source:
      'export {};const pending=(async()=>{await 0;new Socket("wss://example.test/review-rhs-throwing-key")})();try{({})[null.x]=await pending}catch{}const Socket=globalThis.WebSocket;',
    endpoint: "wss://example.test/review-rhs-throwing-key",
  },
  {
    file: "review33-7.mjs",
    source:
      'export {};const pending=(async()=>{await 0;new Socket("wss://example.test/review-rhs-compound")})();try{null.x+=await pending}catch{}const Socket=globalThis.WebSocket;',
    endpoint: "wss://example.test/review-rhs-compound",
  },
  {
    file: "review33-8.mjs",
    source:
      'export {};const pending=(async()=>{await 0;new Socket("wss://example.test/review-rhs-prior-failure")})();try{null.x;({}).x=await pending}catch{}const Socket=globalThis.WebSocket;',
    endpoint: "wss://example.test/review-rhs-prior-failure",
  },
  {
    file: "review33-9.mjs",
    source:
      'export {};const pending=(async()=>{await 0;new Socket("wss://example.test/review-rhs-prior-getter")})();try{({get x(){throw 0}}).x;({}).x=await pending}catch{}const Socket=globalThis.WebSocket;',
    endpoint: "wss://example.test/review-rhs-prior-getter",
  },
  {
    file: "review33-10.mjs",
    source:
      'export {};const Socket=globalThis.WebSocket;const pending=(async()=>{await 0;new Socket("wss://example.test/review-rhs-ready")})();try{({}).x=await pending}catch{}',
    endpoint: "wss://example.test/review-rhs-ready",
  },
  {
    file: "review33-11.mjs",
    source:
      'export {};const pending=(async()=>{await 0;new Socket("wss://example.test/review-rhs-nested")})();try{try{({}).x=await pending}finally{}}catch{}const Socket=globalThis.WebSocket;',
  },
  {
    file: "review32b-0.mjs",
    source:
      'class Value{};(async()=>{try{const[{[await 0]:x},next]=(function*(){yield Value;new Socket("wss://example.test/review-class-before");yield 1})()}catch{}})();const Socket=globalThis.WebSocket;',
    endpoint: "wss://example.test/review-class-before",
  },
  {
    file: "review32b-1.mjs",
    source:
      '(async()=>{try{const[{[await 0]:x},next]=(function*(){yield Value;new Socket("wss://example.test/review-class-after");yield 1})()}catch{}})();class Value{};const Socket=globalThis.WebSocket;',
  },
  {
    file: "review32b-2.mjs",
    source:
      'class Base{};class Value extends Base{};(async()=>{try{const[{[await 0]:x},next]=(function*(){yield Value;new Socket("wss://example.test/review-class-extends");yield 1})()}catch{}})();const Socket=globalThis.WebSocket;',
    endpoint: "wss://example.test/review-class-extends",
  },
  {
    file: "review32b-3.mjs",
    source:
      'export {};const pending=(async()=>{await 0;new Socket("wss://example.test/review-await-receiver")})();try{(await pending).x=0}catch{}const Socket=globalThis.WebSocket;',
  },
  {
    file: "review32b-4.mjs",
    source:
      'export {};const pending=(async()=>{await 0;new Socket("wss://example.test/review-await-key")})();try{({})[await pending]=0}catch{}const Socket=globalThis.WebSocket;',
  },
  {
    file: "review32b-5.mjs",
    source:
      'export {};const Socket=globalThis.WebSocket;const pending=(async()=>{await 0;new Socket("wss://example.test/review-await-receiver-ready")})();try{(await pending).x=0}catch{}',
    endpoint: "wss://example.test/review-await-receiver-ready",
  },

  {
    file: "review32-0.mjs",
    source:
      '(async()=>{try{for(const x of(function*(){try{yield 0}finally{new Socket("wss://example.test/review-assignment-null")}})()){null.x=await 0}}catch{}})();const Socket=globalThis.WebSocket;',
    endpoint: "wss://example.test/review-assignment-null",
  },
  {
    file: "review32-1.mjs",
    source:
      '(async()=>{try{for(const x of(function*(){try{yield 0}finally{new Socket("wss://example.test/review-assignment-void")}})()){(void 0).x=await 0}}catch{}})();const Socket=globalThis.WebSocket;',
    endpoint: "wss://example.test/review-assignment-void",
  },
  {
    file: "review32-2.mjs",
    source:
      '(async()=>{try{for(const x of(function*(){try{yield 0}finally{new Socket("wss://example.test/review-assignment-computed")}})()){null["x"]=await 0}}catch{}})();const Socket=globalThis.WebSocket;',
    endpoint: "wss://example.test/review-assignment-computed",
  },
  {
    file: "review32-3.mjs",
    source:
      '(async()=>{try{for(const x of(function*(){try{yield 0}finally{new Socket("wss://example.test/review-assignment-sequence")}})()){(0,null).x=await 0}}catch{}})();const Socket=globalThis.WebSocket;',
    endpoint: "wss://example.test/review-assignment-sequence",
  },
  {
    file: "review32-4.mjs",
    source:
      '(async()=>{try{for(const x of(function*(){try{yield 0}finally{new Socket("wss://example.test/review-assignment-compound")}})()){null.x+=await 0}}catch{}})();const Socket=globalThis.WebSocket;',
  },
  {
    file: "review32-5.mjs",
    source:
      '(async()=>{try{for(const x of(function*(){try{yield 0}finally{new Socket("wss://example.test/review-assignment-throwing-key")}})()){null[null.x]=await 0}}catch{}})();const Socket=globalThis.WebSocket;',
  },
  {
    file: "review32-6.mjs",
    source:
      'export {};const options={with(){}};options.with.type=1;const {WebSocket:Socket}=await import("ws",options);new Socket("wss://example.test/review-import-number");',
  },
  {
    file: "review32-7.mjs",
    source:
      'export {};const options={with(){}};const attrs=options.with;attrs.type=1;const {WebSocket:Socket}=await import("ws",options);new Socket("wss://example.test/review-import-method-alias");',
  },
  {
    file: "review32-8.mjs",
    source:
      'export {};const options={with(){}};mutate(options.with);const {WebSocket:Socket}=await import("ws",options);new Socket("wss://example.test/review-import-escaped");',
  },
  {
    file: "review32-9.mjs",
    source:
      'export {};const options={with(){}};const {WebSocket:Socket}=await import("ws",options);new Socket("wss://example.test/review-import-unchanged");',
    endpoint: "wss://example.test/review-import-unchanged",
  },
  {
    file: "review32-10.mjs",
    source:
      'export {};const options={with(){}};const {WebSocket:Socket}=await import("ws",options);new Socket("wss://example.test/review-import-later-write");options.with.type=1;',
    endpoint: "wss://example.test/review-import-later-write",
  },
  {
    file: "review32-11.mjs",
    source:
      'export {};const attrs=function(){};const options={with:attrs};attrs.type=1;const {WebSocket:Socket}=await import("ws",options);new Socket("wss://example.test/review-import-function-value");',
  },
  {
    file: "review32-12.mjs",
    source:
      'export {};const options={with(){},other:{}};options.other.type=1;const {WebSocket:Socket}=await import("ws",options);new Socket("wss://example.test/review-import-unrelated");',
    endpoint: "wss://example.test/review-import-unrelated",
  },
  {
    file: "review32-13.mjs",
    source:
      '(async()=>{try{const[a,{[await 0]:b},c]=(function*(){yield 1;yield u;new Socket("wss://example.test/review-yield-object");yield 2})()}catch{}const u={}})();const Socket=globalThis.WebSocket;',
  },
  {
    file: "review32-14.mjs",
    source:
      '(async()=>{try{const[a,{[await 0]:b},c]=(function*(){yield 1;yield u;new Socket("wss://example.test/review-yield-number");yield 2})()}catch{}const u=1})();const Socket=globalThis.WebSocket;',
  },
  {
    file: "review32-15.mjs",
    source:
      '(async()=>{try{const[a,{[await 0]:b},c]=(function*(){yield 1;yield u;new Socket("wss://example.test/review-yield-function");yield 2})()}catch{}const u=function(){}})();const Socket=globalThis.WebSocket;',
  },
  {
    file: "review32-16.mjs",
    source:
      'const u={};(async()=>{const[a,{[await 0]:b},c]=(function*(){yield 1;yield u;new Socket("wss://example.test/review-yield-initialized");yield 2})()})();const Socket=globalThis.WebSocket;',
    endpoint: "wss://example.test/review-yield-initialized",
  },
  {
    file: "review32-17.mjs",
    source:
      '(async(u)=>{const[a,{[await 0]:b},c]=(function*(){yield 1;yield u;new Socket("wss://example.test/review-yield-parameter");yield 2})()})({});const Socket=globalThis.WebSocket;',
    endpoint: "wss://example.test/review-yield-parameter",
  },
  {
    file: "review32-18.mjs",
    source:
      '(async()=>{try{const[a=await 0,b,c]=(function*(){try{yield;yield u;yield 2}finally{new Socket("wss://example.test/review-yield-earlier-cleanup")}})()}catch{}const u={};})();const Socket=globalThis.WebSocket;',
    endpoint: "wss://example.test/review-yield-earlier-cleanup",
  },

  {
    file: "resume-alias-0.js",
    source:
      'const u=undefined;(async()=>{const[a,b=await 0,c]=(function*(){yield 1;yield u;new Socket("wss://example.test/resume-default");yield 2})()})();const Socket=globalThis.WebSocket;',
    endpoint: "wss://example.test/resume-default",
  },
  {
    file: "resume-alias-1.js",
    source:
      'const u=undefined;(async()=>{try{const[a,b=await 0,c]=(function*(){yield 1;new Socket("wss://example.test/resume-earlier");yield u;yield 2})()}catch{}})();const Socket=globalThis.WebSocket;',
  },
  {
    file: "resume-alias-2.js",
    source:
      'const u=undefined;(async()=>{try{const[a,b,c]=(function*(){yield 1;yield u;new Socket("wss://example.test/resume-eager");yield 2})()}catch{}})();const Socket=globalThis.WebSocket;',
  },
  {
    file: "resume-alias-3.js",
    source:
      'const u=undefined;(async()=>{try{const[a,{[await 0]:b},c]=(function*(){yield 1;yield u;new Socket("wss://example.test/resume-blocked");yield 2})()}catch{}})();const Socket=globalThis.WebSocket;',
  },
  {
    file: "resume-alias-4.js",
    source:
      'const u=null;(async()=>{try{const[a,{[await 0]:b},c]=(function*(){try{yield 1;yield u}finally{new Socket("wss://example.test/resume-cleanup")}})()}catch{}})();const Socket=globalThis.WebSocket;',
  },
  {
    file: "resume-alias-5.js",
    source:
      'const u=undefined;(async()=>{const[a=await 0,b=await 0,c]=(function*(){yield undefined;yield u;new Socket("wss://example.test/resume-prior");yield 2})()})();const Socket=globalThis.WebSocket;',
    endpoint: "wss://example.test/resume-prior",
  },
  {
    file: "resume-alias-6.js",
    source:
      '(async()=>{const[a,b=await 0,c]=(function*(){yield 1;const u=undefined;yield u;new Socket("wss://example.test/resume-local");yield 2})()})();const Socket=globalThis.WebSocket;',
    endpoint: "wss://example.test/resume-local",
  },
  {
    file: "resume-alias-7.js",
    source:
      '(async()=>{try{const[a,b=await 0,c]=(function*(){yield 1;yield u;new Socket("wss://example.test/resume-late");yield 2})()}catch{}const u=undefined})();const Socket=globalThis.WebSocket;',
  },
  {
    file: "resume-alias-8.js",
    source:
      'const u=undefined;const v=u;(async()=>{const[a,b=await 0,c=await 0,d]=(function*(){yield 1;yield u;yield v;new Socket("wss://example.test/resume-chain");yield 2})()})();const Socket=globalThis.WebSocket;',
    endpoint: "wss://example.test/resume-chain",
  },
  {
    file: "resume-alias-9.js",
    source:
      'const Socket=globalThis.WebSocket;const u=null;(async()=>{try{const[a,{[await 0]:b},c]=(function*(){try{yield 1;yield u}finally{new Socket("wss://example.test/resume-initialized")}})()}catch{}})();',
    endpoint: "wss://example.test/resume-initialized",
  },
  {
    file: "resume-alias-10.js",
    source:
      'const u={};(async()=>{try{const[a,b=await 0,c]=(function*(){yield 1;yield u;new Socket("wss://example.test/resume-object");yield 2})()}catch{}})();const Socket=globalThis.WebSocket;',
  },
  {
    file: "alias-order-0.js",
    source:
      '(async()=>{try{const[value=await 0,next]=(function*(){try{yield u}finally{new Socket("wss://example.test/alias-late")}})()}catch{}const u=undefined;})();const Socket=globalThis.WebSocket;',
  },
  {
    file: "alias-order-1.js",
    source:
      '(async()=>{try{const values=(function*(){yield u;new Socket("wss://example.test/alias-created");yield{}})();const u=undefined;const[{[await 0]:x},next]=values; }catch{}})();const Socket=globalThis.WebSocket;',
  },

  {
    file: "alias-control-0.js",
    endpoint: "wss://example.test/alias-mutable",
    source:
      '(async()=>{let u=undefined;u={};for(const{[await 0]:x}of(function*(){yield u;new Socket("wss://example.test/alias-mutable");yield{}})()){} })();const Socket=globalThis.WebSocket;',
  },
  {
    file: "alias-control-1.js",
    source:
      '(async()=>{try{for(const{[await 0]:x}of(function*(){const u=undefined;yield u;new Socket("wss://example.test/alias-local");yield{}})()){} }catch{}})();const Socket=globalThis.WebSocket;',
  },
  {
    file: "alias-control-2.js",
    source:
      '(async()=>{try{for(const{[await 0]:x}of(function*(){const u=null;yield u;new Socket("wss://example.test/alias-local-null");yield{}})()){} }catch{}})();const Socket=globalThis.WebSocket;',
  },
  {
    file: "alias-control-3.js",
    source:
      '(async()=>{try{const u=undefined;for(const{[await 0]:x}of(function*(){try{yield u}finally{new Socket("wss://example.test/alias-cleanup")}})()){} }catch{}})();const Socket=globalThis.WebSocket;',
  },
  {
    file: "alias-control-4.js",
    endpoint: "wss://example.test/alias-initialized-cleanup",
    source:
      'const Socket=globalThis.WebSocket;(async()=>{try{const u=undefined;for(const{[await 0]:x}of(function*(){try{yield u}finally{new Socket("wss://example.test/alias-initialized-cleanup")}})()){} }catch{}})();',
  },
  {
    file: "alias-control-5.js",
    endpoint: "wss://example.test/alias-number",
    source:
      '(async()=>{const u=1;for(const{[await 0]:x}of(function*(){yield u;new Socket("wss://example.test/alias-number");yield{}})()){} })();const Socket=globalThis.WebSocket;',
  },

  {
    file: "alias-binding-0.js",
    source:
      '(async()=>{try{const u=undefined;for(const{[await 0]:x}of(function*(){yield u;new Socket("wss://example.test/alias-undefined");yield{}})()){} }catch{}})();const Socket=globalThis.WebSocket;',
  },
  {
    file: "alias-binding-1.js",
    source:
      '(async()=>{try{const u=null;for(const{[await 0]:x}of(function*(){yield u;new Socket("wss://example.test/alias-null");yield{}})()){} }catch{}})();const Socket=globalThis.WebSocket;',
  },
  {
    file: "alias-binding-2.js",
    source:
      '(async()=>{try{const u=void 0;for(const{[await 0]:x}of(function*(){yield u;new Socket("wss://example.test/alias-void");yield{}})()){} }catch{}})();const Socket=globalThis.WebSocket;',
  },
  {
    file: "alias-binding-3.js",
    source:
      '(async()=>{try{const first=undefined;const u=first;for(const{[await 0]:x}of(function*(){yield u;new Socket("wss://example.test/alias-chain");yield{}})()){} }catch{}})();const Socket=globalThis.WebSocket;',
  },
  {
    file: "alias-binding-4.js",
    source:
      '(async()=>{try{const u=undefined;for(const[x=await 0]of(function*(){yield u;new Socket("wss://example.test/alias-array");yield[]})()){} }catch{}})();const Socket=globalThis.WebSocket;',
  },
  {
    file: "alias-binding-5.js",
    endpoint: "wss://example.test/alias-object",
    source:
      '(async()=>{const u={};for(const{[await 0]:x}of(function*(){yield u;new Socket("wss://example.test/alias-object");yield{}})()){} })();const Socket=globalThis.WebSocket;',
  },
  {
    file: "alias-binding-6.js",
    endpoint: "wss://example.test/alias-default",
    source:
      '(async()=>{const u=undefined;const[value=await 0,next]=(function*(){yield u;new Socket("wss://example.test/alias-default");yield 1})();})();const Socket=globalThis.WebSocket;',
  },
  {
    file: "alias-binding-7.js",
    endpoint: "wss://example.test/alias-shadowed",
    source:
      '(async()=>{const undefined={};const u=undefined;for(const{[await 0]:x}of(function*(){yield u;new Socket("wss://example.test/alias-shadowed");yield{}})()){} })();const Socket=globalThis.WebSocket;',
  },
  {
    file: "alias-binding-8.js",
    endpoint: "wss://example.test/alias-parameter",
    source:
      '(async(u)=>{for(const{[await 0]:x}of(function*(){yield u;new Socket("wss://example.test/alias-parameter");yield{}})()){} })({});const Socket=globalThis.WebSocket;',
  },

  {
    file: "bare-binding-0.js",
    source:
      '(async()=>{try{for(const{missing=await 0,[await 0]:x}of(function*(){yield;new Socket("wss://example.test/bare");yield{}})()){} }catch{}})();const Socket=globalThis.WebSocket;',
  },
  {
    file: "bare-binding-1.js",
    source:
      '(async()=>{try{for(const[x=await 0]of(function*(){yield;new Socket("wss://example.test/bare-array");yield[]})()){} }catch{}})();const Socket=globalThis.WebSocket;',
  },
  {
    file: "bare-binding-2.js",
    source:
      '(async()=>{try{for(const{missing=await 0,[await 0]:x}of(function*(){yield undefined;new Socket("wss://example.test/explicit-undefined");yield{}})()){} }catch{}})();const Socket=globalThis.WebSocket;',
  },
  {
    file: "bare-binding-3.js",
    source:
      '(async()=>{try{for(const{missing=await 0,[await 0]:x}of(function*(){yield null;new Socket("wss://example.test/null");yield{}})()){} }catch{}})();const Socket=globalThis.WebSocket;',
  },
  {
    file: "bare-binding-4.js",
    endpoint: "wss://example.test/bare-default",
    source:
      '(async()=>{const[{missing=await 0,[await 0]:x}={},next]=(function*(){yield;new Socket("wss://example.test/bare-default");yield{}})(); })();const Socket=globalThis.WebSocket;',
  },
  {
    file: "bare-binding-5.js",
    endpoint: "wss://example.test/bare-scalar",
    source:
      '(async()=>{const[value=await 0,next]=(function*(){yield;new Socket("wss://example.test/bare-scalar");yield 1})(); })();const Socket=globalThis.WebSocket;',
  },
  {
    file: "bare-binding-6.js",
    source:
      '(async()=>{try{for(const{missing=await 0,[await 0]:x}of(function*(){try{yield}finally{new Socket("wss://example.test/bare-cleanup")}})()){} }catch{}})();const Socket=globalThis.WebSocket;',
  },
  {
    file: "bare-binding-7.js",
    endpoint: "wss://example.test/bare-initialized-cleanup",
    source:
      'const Socket=globalThis.WebSocket;(async()=>{try{for(const{missing=await 0,[await 0]:x}of(function*(){try{yield}finally{new Socket("wss://example.test/bare-initialized-cleanup")}})()){} }catch{}})();',
  },

  {
    file: "wrapped-class.js",
    source:
      '(new(0,class{run([x]){}})()).run((function*(){new Socket("wss://example.test/wrapped-class");yield 0})());const Socket=globalThis.WebSocket;',
  },
  {
    file: "required-pattern-key.js",
    endpoint: "wss://example.test/later-key",
    source:
      '(async()=>{const[{missing=await 0,[await 0]:x},next]=(function*(){yield{};new Socket("wss://example.test/later-key");yield 1})();})();const Socket=globalThis.WebSocket;',
  },

  {
    file: "stored-after-wait.js",
    endpoint: "wss://example.test/stored-after-wait",
    source:
      '(async()=>{const values=(function*(){new Socket("wss://example.test/stored-after-wait");yield 0})();await 0;const [x]=values})();const Socket=globalThis.WebSocket;',
  },
  {
    file: "assigned-later-getter.js",
    source:
      'let unused,run;({unused,run}={get run(){new Socket("wss://example.test/assigned-getter")}});const Socket=globalThis.WebSocket;',
  },
  {
    file: "earlier-getter-key-wait.js",
    endpoint: "wss://example.test/earlier-key",
    source:
      '(async()=>{const{[await 0]:unused,run}={get run(){new Socket("wss://example.test/earlier-key")}}})();const Socket=globalThis.WebSocket;',
  },
  {
    file: "early-callback-helper.js",
    source:
      '((run)=>run.call(null))(()=>new Socket("wss://example.test/early-callback"));const Socket=globalThis.WebSocket;',
  },

  {
    file: "finally-0.mjs",
    source:
      'export {};const pending=(async()=>{await 0;new Socket("wss://example.test/finally-0")})();await pending.finally(()=>{});const Socket=globalThis.WebSocket;',
  },
  {
    file: "finally-1.mjs",
    source:
      'export {};const pending=new Promise(async resolve=>{await 0;new Socket("wss://example.test/finally-1");resolve()});await pending.finally(()=>{});const Socket=globalThis.WebSocket;',
  },
  {
    file: "finally-2.mjs",
    source:
      'export {};const pending=(async()=>{await 0;new Socket("wss://example.test/finally-2")})();const tail=pending.finally(()=>{});await tail;const Socket=globalThis.WebSocket;',
  },
  {
    file: "finally-3.mjs",
    source:
      'export {};const pending=(async()=>{await 0;new Socket("wss://example.test/finally-3")})();await pending.catch(()=>{}).finally(()=>{}).then(()=>{});const Socket=globalThis.WebSocket;',
  },
  {
    file: "finally-4.mjs",
    source:
      'export {};const pending=(async()=>{await 0;new Socket("wss://example.test/finally-4")})();await pending["finally"](()=>{});const Socket=globalThis.WebSocket;',
  },
  {
    file: "finally-5.mjs",
    source:
      'export {};const pending=(async()=>{await 0;new Socket("wss://example.test/finally-5")})();await pending.finally();const Socket=globalThis.WebSocket;',
  },
  {
    file: "finally-initialized.mjs",
    endpoint: "wss://example.test/finally-initialized",
    source:
      'export {};const Socket=globalThis.WebSocket;const pending=new Promise(async resolve=>{await 0;new Socket("wss://example.test/finally-initialized");resolve()});await pending.finally(()=>{});',
  },
  {
    file: "finally-changed-0.mjs",
    endpoint: "wss://example.test/changed-finally-0",
    source:
      'export {};let release;const ready=new Promise(resolve=>{release=resolve});const pending=(async()=>{await ready;new Socket("wss://example.test/changed-finally-0")})();pending.finally=()=>undefined;await pending.finally();const Socket=globalThis.WebSocket;release();',
  },
  {
    file: "finally-changed-1.mjs",
    endpoint: "wss://example.test/changed-finally-1",
    source:
      'export {};let release;const ready=new Promise(resolve=>{release=resolve});const pending=(async()=>{await ready;new Socket("wss://example.test/changed-finally-1")})();const alias=pending;alias.finally=()=>undefined;await pending.finally();const Socket=globalThis.WebSocket;release();',
  },
  {
    file: "finally-changed-2.mjs",
    endpoint: "wss://example.test/changed-finally-2",
    source:
      'export {};let release;const ready=new Promise(resolve=>{release=resolve});const pending=(async()=>{await ready;new Socket("wss://example.test/changed-finally-2")})();Promise.prototype.finally=()=>undefined;await pending.finally();const Socket=globalThis.WebSocket;release();',
  },
  {
    file: "finally-changed-3.mjs",
    endpoint: "wss://example.test/changed-finally-3",
    source:
      'export {};let release;const ready=new Promise(resolve=>{release=resolve});const pending=(async()=>{await ready;new Socket("wss://example.test/changed-finally-3")})();pending.then=()=>undefined;await pending.finally();const Socket=globalThis.WebSocket;release();',
  },
  {
    file: "replaced-import-then.mjs",
    source:
      'export {};const {WebSocket:Socket}=await import("ws").then(()=>({WebSocket:class{}}));new Socket("wss://example.test/replaced-import-then");',
  },
  {
    file: "replaced-import-alias.mjs",
    source:
      'export {};const loaded=import("ws");const replacement=loaded.then(()=>({WebSocket:class{}}));const {WebSocket:Socket}=await replacement;new Socket("wss://example.test/replaced-import-alias");',
  },
  {
    file: "replaced-import-catch.mjs",
    source:
      'export {};const {WebSocket:Socket}=await import("ws").catch(()=>({WebSocket:class{}}));new Socket("wss://example.test/replaced-import-catch");',
  },
  {
    file: "replaced-import-wrapper.mjs",
    source:
      'export {};const {WebSocket:Socket}=await (async()=>await import("ws").then(()=>({WebSocket:class{}})))();new Socket("wss://example.test/replaced-import-wrapper");',
  },
  {
    file: "async-then.mjs",
    source:
      'export {};const pending=(async()=>{await 0;new Socket("wss://example.test/async-then")})();await pending.then(()=>{});const Socket=globalThis.WebSocket;',
  },
  {
    file: "async-catch.mjs",
    source:
      'export {};const pending=(async()=>{await 0;new Socket("wss://example.test/async-catch")})();await pending.catch(()=>{});const Socket=globalThis.WebSocket;',
  },
  {
    file: "executor-then.mjs",
    source:
      'export {};const pending=new Promise(async resolve=>{await 0;new Socket("wss://example.test/executor-then");resolve()});await pending.then(()=>{});const Socket=globalThis.WebSocket;',
  },
  {
    file: "executor-catch.mjs",
    source:
      'export {};const pending=new Promise(async resolve=>{await 0;new Socket("wss://example.test/executor-catch");resolve()});await pending.catch(()=>{});const Socket=globalThis.WebSocket;',
  },
  {
    file: "chained-alias.mjs",
    source:
      'export {};const pending=(async()=>{await 0;new Socket("wss://example.test/chained-alias")})();const tail=pending.then(()=>{});await tail.catch(()=>{});const Socket=globalThis.WebSocket;',
  },
  {
    file: "initialized-chain.mjs",
    endpoint: "wss://example.test/initialized-chain",
    source:
      'export {};const Socket=globalThis.WebSocket;const pending=(async()=>{await 0;new Socket("wss://example.test/initialized-chain")})();await pending.catch(()=>{});',
  },
  {
    file: "capability-name-0.mjs",
    source:
      'export {};const pending=new Promise(async function(resolve){({resolve:0});await 0;new Socket("wss://example.test/property-name-0");resolve()});await pending;const Socket=globalThis.WebSocket;',
  },
  {
    file: "capability-name-1.mjs",
    source:
      'export {};const pending=new Promise(async function(resolve){({}).resolve;await 0;new Socket("wss://example.test/property-name-1");resolve()});await pending;const Socket=globalThis.WebSocket;',
  },
  {
    file: "capability-name-2.mjs",
    source:
      'export {};const pending=new Promise(async function(resolve){({resolve(){}});await 0;new Socket("wss://example.test/property-name-2");resolve()});await pending;const Socket=globalThis.WebSocket;',
  },
  {
    file: "capability-name-3.mjs",
    source:
      'export {};const pending=new Promise(async function(resolve){class K{resolve(){}}await 0;new Socket("wss://example.test/property-name-3");resolve()});await pending;const Socket=globalThis.WebSocket;',
  },
  {
    file: "capability-name-4.mjs",
    source:
      'export {};const pending=new Promise(async function(resolve){resolve:for(;;){break resolve;}await 0;new Socket("wss://example.test/property-name-4");resolve()});await pending;const Socket=globalThis.WebSocket;',
  },
  {
    file: "capability-name-5.mjs",
    source:
      'export {};const pending=new Promise(async function(resolve){{const {resolve}= {resolve:0};}await 0;new Socket("wss://example.test/property-name-5");resolve()});await pending;const Socket=globalThis.WebSocket;',
  },
  {
    file: "capability-name-6.mjs",
    source:
      'export {};const pending=new Promise(async function(resolve){({eval:0});await 0;new Socket("wss://example.test/property-name-6");resolve()});await pending;const Socket=globalThis.WebSocket;',
  },
  {
    file: "capability-name-7.mjs",
    source:
      'export {};const pending=new Promise(async function(resolve){({arguments:0});await 0;new Socket("wss://example.test/property-name-7");resolve()});await pending;const Socket=globalThis.WebSocket;',
  },
  {
    file: "callback.js",
    endpoint: "wss://example.test/pair",
    source:
      'const invoke=run=>run();invoke(()=>{});const Socket=globalThis.WebSocket;invoke(()=>new Socket("wss://example.test/pair"));',
  },
  {
    file: "apply.js",
    endpoint: "wss://example.test/apply",
    source:
      'const connect=()=>new Socket("wss://example.test/apply");try{connect.apply(null,1)}catch{}const Socket=globalThis.WebSocket;',
  },
  {
    file: "options.mjs",
    endpoint: "wss://example.test/options",
    source:
      'export {};const{WebSocket:Socket}=await import("ws",{with(){}});new Socket("wss://example.test/options");',
  },
  {
    file: "disposer.js",
    endpoint: "wss://example.test/disposer",
    source:
      '(async()=>{for(const x of(function*(){yield 0;new Socket("wss://example.test/disposer")})()){await using r={set[Symbol.asyncDispose](value){},[Symbol.dispose](){}}}})();const Socket=globalThis.WebSocket;',
  },
  {
    file: "helper-read.js",
    source:
      'const connect=()=>new Socket("wss://example.test/helper-read");connect.call(null,connect.call=()=>{});const Socket=globalThis.WebSocket;',
  },
  {
    file: "base-field.js",
    source:
      'class Base{field=new Socket("wss://example.test/base-field")}class Derived extends Base{}new Derived();const Socket=globalThis.WebSocket;',
  },
  {
    file: "promise-executor.js",
    source:
      'new Promise(()=>new Socket("wss://example.test/promise-executor"));const Socket=globalThis.WebSocket;',
  },
  {
    file: "destructured-getter.js",
    source:
      'const{run}={get run(){return new Socket("wss://example.test/destructured-getter")}};const Socket=globalThis.WebSocket;',
  },
  {
    file: "later-destructured-getter.js",
    source:
      'const{unused,run}={get run(){new Socket("wss://example.test/second")}};const Socket=globalThis.WebSocket;',
  },
  {
    file: "failed-callback-alias.js",
    endpoint: "wss://example.test/argument",
    source:
      'const invoke=run=>run();const connect=()=>new Socket("wss://example.test/argument");function earlier(){try{invoke(alias)}catch{}}earlier();const alias=connect;const Socket=globalThis.WebSocket;invoke(connect);',
  },
  {
    file: "native-string-iterator.js",
    endpoint: "wss://example.test/iterator",
    source:
      '(async()=>{const values=(function*(){yield "a";yield undefined;try{}finally{new Socket("wss://example.test/iterator")}})();const [[x],y=await 0]=values})();const Socket=globalThis.WebSocket;',
  },
  {
    file: "throwing-string-iterator.js",
    source:
      'String.prototype[Symbol.iterator]=function*(){throw Error("stop")};(async()=>{const values=(function*(){yield "a";yield undefined;try{}finally{new Socket("wss://example.test/iterator")}})();const [[x],y=await 0]=values})();const Socket=globalThis.WebSocket;',
  },
  {
    file: "getter-key-wait.js",
    endpoint: "wss://example.test/getter-key-wait",
    source:
      '(async()=>{const{[void await 0]:value}={get undefined(){return new Socket("wss://example.test/getter-key-wait")}}})();const Socket=globalThis.WebSocket;',
  },
  {
    file: "async-executor.mjs",
    endpoint: "wss://example.test/async-executor",
    source:
      'let release;const ready=new Promise(resolve=>{release=resolve});const pending=new Promise(async resolve=>{resolve();await ready;new Socket("wss://example.test/async-executor")});await pending;const Socket=globalThis.WebSocket;release();',
  },
  {
    file: "changed-base.js",
    endpoint: "wss://example.test/changed-base",
    source:
      'class Base{field=new Socket("wss://example.test/changed-base")}class Other{}class Derived extends Base{}Object.setPrototypeOf(Derived,Other);new Derived();const Socket=globalThis.WebSocket;',
  },
  {
    file: "nested-getter.js",
    source:
      '(async()=>{const{run:{[await 0]:x}}={get run(){new Socket("wss://example.test/nested-getter");return {}}}})();const Socket=globalThis.WebSocket;',
  },
  {
    file: "default-getter.js",
    source:
      '(async()=>{const{run:x=await 0}={get run(){new Socket("wss://example.test/default-getter")}}})();const Socket=globalThis.WebSocket;',
  },
  {
    file: "key-before-getter.js",
    endpoint: "wss://example.test/key-before-getter",
    source:
      '(async()=>{const{[void await 0]:{x}}={get undefined(){new Socket("wss://example.test/key-before-getter");return {}}}})();const Socket=globalThis.WebSocket;',
  },
  {
    file: "late-resolve.mjs",
    source:
      'const pending=new Promise(async resolve=>{await 0;new Socket("wss://example.test/late-resolve");resolve()});await pending;const Socket=globalThis.WebSocket;',
  },
  {
    file: "late-reject.mjs",
    source:
      'const pending=new Promise(async(resolve,reject)=>{await 0;new Socket("wss://example.test/late-reject");reject()});await pending;const Socket=globalThis.WebSocket;',
  },
  {
    file: "no-settlement.mjs",
    source:
      'const pending=new Promise(async()=>{await 0;new Socket("wss://example.test/no-settlement")});await pending;const Socket=globalThis.WebSocket;',
  },
  {
    file: "escaped-resolve.mjs",
    endpoint: "wss://example.test/escaped-resolve",
    source:
      'let release;const pending=new Promise(async resolve=>{release=resolve;await 0;new Socket("wss://example.test/escaped-resolve")});release();await pending;const Socket=globalThis.WebSocket;',
  },
  {
    file: "shadowed-resolve.mjs",
    source:
      'const pending=new Promise(async resolve=>{(()=>{const resolve=()=>{};resolve()})();await 0;new Socket("wss://example.test/shadowed-resolve");resolve()});await pending;const Socket=globalThis.WebSocket;',
  },
] as const;

it("retains reviewed callback and descriptor endpoints with source provenance", async () => {
  const root = await createTestTempDirectory("rea-reviewed-calls-");
  for (const fixture of sources)
    await writeFile(join(root, fixture.file), fixture.source);
  const snapshot = await scanCanonicalArtifactInventory(root, {});
  const reader = createJavaScriptArtifactReader(root, "directory");
  try {
    const files = await readJavaScriptArtifactFiles(reader, snapshot);
    const graph = buildJavaScriptArtifactGraph(
      snapshot,
      files,
      analyzeJavaScriptArtifactFiles(files),
    );
    const observations = graph.nodes
      .filter(({ kind }) => kind === "endpoint")
      .flatMap(({ observations }) => observations);
    const expected = sources.filter((fixture) => "endpoint" in fixture);
    expect(observations).toHaveLength(expected.length);
    for (const fixture of expected)
      expect(observations).toContainEqual(
        expect.objectContaining({
          properties: expect.objectContaining({ value: fixture.endpoint }),
          evidence: expect.objectContaining({
            location: {
              available: true,
              value: expect.objectContaining({ source: fixture.file }),
            },
          }),
        }),
      );
  } finally {
    await reader.close();
    await rm(root, { recursive: true, force: true });
  }
});
