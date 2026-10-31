<div align="center">

[English](../../README.md) · [简体中文](README_zh.md) · [繁體中文](README_zh-TW.md) · [日本語](README_ja.md) · [한국어](README_ko.md) · [Türkçe](README_tr.md) · [Русский](README_ru.md) · [Tiếng Việt](README_vi.md) · [ไทย](README_th.md) · [Deutsch](README_de.md) · [Español](README_es.md) · [Français](README_fr.md) · [Українська](README_uk.md) · [Polski](README_pl.md) · [Português (Brasil)](README_pt-BR.md) · [العربية](README_ar.md) · [فارسی](README_fa.md) · [Bahasa Indonesia](README_id.md) · [Italiano](README_it.md) · [Ελληνικά](README_el.md) · [മലയാളം](README_ml.md) · [Roman Urdu](README_ur-Latn.md) · [Română](README_ro.md) · **বাংলা**

# REA: Reverse Engineer Anything

### বাইনারি, অ্যাপ্লিকেশন এবং runtime আচরণ — সবকিছুর reverse engineering-এর জন্য একটিই MCP।

**পছন্দের কোনো ফিচার চোখে পড়েছে? সেটি কীভাবে কাজ করে, বাইনারি স্তর পর্যন্ত বুঝে নিন।**

[![npm version](https://img.shields.io/npm/v/rea-agents?style=flat-square&color=cb3837)](https://www.npmjs.com/package/rea-agents)
[![MCP tool catalog](https://img.shields.io/badge/MCP-tool_catalog-5c4ee5?style=flat-square)](../mcp-contracts.md#generated-catalog)
[![Node.js requirements](https://img.shields.io/badge/Node.js-requirements-339933?style=flat-square&logo=nodedotjs&logoColor=white)](#current-status)
[![skills.sh](https://skills.sh/b/morluto/rea?style=flat-square)](https://skills.sh/morluto/rea/reverse-engineer-anything)
[![MIT license](https://img.shields.io/badge/license-MIT-f4c430?style=flat-square)](../../LICENSE)
[![Discord](https://img.shields.io/discord/1556595354999332884?logo=discord&logoColor=white&label=Discord&color=5865F2)](https://discord.gg/GkcryMnJDM)

<a href="https://trendshift.io/repositories/82054?utm_source=repository-badge&amp;utm_medium=badge&amp;utm_campaign=badge-repository-82054" target="_blank" rel="noopener noreferrer"><img src="https://trendshift.io/api/badge/repositories/82054" alt="morluto%2Frea | Trendshift" width="250" height="55"/></a>

**[ওয়েবসাইট](https://rea.tools/bn/) · [গাইড](https://rea.tools/bn/guides/) · [শোকেস](https://rea.tools/bn/showcase/)**

[দ্রুত শুরু](#দ্রুত-শুরু) · [REA কীভাবে কাজ করে](#rea-কীভাবে-কাজ-করে) · [কী কী বিশ্লেষণ করা যায়](#কী-কী-বিশ্লেষণ-করা-যায়) · [শোকেস](#শোকেস) · [RL এনভায়রনমেন্ট তৈরি করুন](#rl-এনভায়রনমেন্ট-তৈরি-করুন) · [সাধারণ প্রশ্নোত্তর](#সাধারণ-প্রশ্নোত্তর-faq) · [ডকুমেন্টেশন](#ডকুমেন্টেশন)

<code>npx rea-agents setup</code>

</div>

> [!IMPORTANT]
> REA-এর অফিসিয়াল উৎস: [morluto/rea](https://github.com/morluto/rea), [rea.tools](https://rea.tools/), [rea-agents](https://www.npmjs.com/package/rea-agents) (npm)।
> ইনস্টলেশন ও release লিংকের জন্য এই অফিসিয়াল উৎসগুলোই অনুসরণ করুন। একই রকম repository নাম বা কপি করা README দেখে কোনো download অফিসিয়াল বলে ধরে নেওয়া যায় না।

<div align="center">

<br />

<img src="../assets/rea-hopper-analysis.png" alt="একটি native বাইনারি পরীক্ষার সময় Hopper-এর ভেতরে REA তার analysis bridge চালু করছে" width="1200" />

<br /><br />

<table aria-label="REA কমিউনিটি">
<tr>
<td align="center" width="360">
  <a href="https://discord.gg/GkcryMnJDM">
    <img src="../assets/discord.svg" height="42" alt="Discord" /><br />
    <strong>Reverse Engineering কমিউনিটিতে যোগ দিন</strong>
  </a><br />
  <sub>Discord · প্রশ্নোত্তর · Show and Tell</sub>
</td>
</tr>
</table>

<br />

</div>

---

কোনো অ্যাপের এমন একটি ফিচার দেখেছেন যা নিজের প্রোডাক্টে চান? আপনার agent-কে REA দিয়ে সেটি খুঁজে দেখতে বলুন। সোর্স কোড ছাড়াই এটি অ্যাপটি পরীক্ষা করতে পারে, ফিচারটি কীভাবে কাজ করে তা ব্যাখ্যা করতে পারে, প্রমাণ দেখাতে পারে এবং আপনার প্রজেক্টের জন্য একটি সংস্করণ তৈরি করে দিতে পারে।

REA আপনার agent-কে native বাইনারি, JavaScript ও Electron অ্যাপ, .NET assembly এবং ওয়েবসাইট পরীক্ষা করার টুলের সঙ্গে যুক্ত করে। একই টুল আপনি টার্মিনাল থেকেও ব্যবহার করতে পারেন। বিশ্লেষণ চলে আপনার নিজের কম্পিউটারে, আর প্রতিটি সিদ্ধান্তের পেছনের প্রমাণ ও সীমাবদ্ধতা ফলাফলেই থাকে।

Setup আপনার agent-এ REA নিবন্ধন করে এবং মানানসই workflow নির্দেশনা ইনস্টল করে। Native বিশ্লেষণে আগে থেকে ইনস্টল করা Hopper, Ghidra, IDA বা Kuna ব্যবহার করা যায়; চাইলে setup আপনার অনুমোদন নিয়ে Hopper ইনস্টল করে দিতে পারে। Static JavaScript বিশ্লেষণের জন্য কোনো native analysis engine লাগে না।

> **[REA ওয়েবসাইট দেখুন](https://rea.tools/bn/)** — সেখানে setup নির্দেশনা, ছবিসহ গাইড এবং বাস্তব case study পাবেন।

## দ্রুত শুরু

Linux-এ Ghidra, JADX, firmware tool চালু করা এবং static JavaScript/Electron
বিশ্লেষণের জন্য process ownership যাচাইয়ে REA-এর `PATH`-এ একটি
procps-সামঞ্জস্যপূর্ণ `ps` লাগে। পুনরুদ্ধারের ধাপ `docs/installation.md`-এর
"Linux owned-process prerequisite" শিরোনামের নিচে আছে।

### আপনার agent সেট আপ করুন

Node.js ও npm ইনস্টল থাকলে চালান:

```bash
npx rea-agents setup
```

আপনার agent বেছে নিন, প্রস্তাবিত পরিবর্তনগুলো দেখে নিন এবং অনুমোদন দিন। Setup
REA-এর MCP server ও মানানসই workflow নির্দেশনা যোগ করে, আর বিদ্যমান
configuration-এর ব্যাকআপ রাখে। এরপর আপনার agent রিস্টার্ট করুন। Setup নির্বাচিত
runtime ও REA entry script সরাসরি রেকর্ড করে। Package runner-এর মাধ্যমে পেয়ে
থাকলে তার cache entry যেন পাওয়া যায়, সেভাবে রাখুন। Package সংগ্রহের কাজটি
টার্গেট প্রজেক্টের বাইরে একটি বিশ্বস্ত ডিরেক্টরি থেকে চালান। ইনস্টলেশন ও
পুনরুদ্ধারের বিস্তারিত নিচের setup গাইডে আছে।

Setup সমর্থন করে Claude Code, Codex, Cursor, Gemini CLI, Grok Build এবং
[অন্যান্য agent](../installation.md#supported-agents)। Provider configuration,
ম্যানুয়াল MCP নিবন্ধন এবং Claude Code/Codex plugin ইনস্টলেশনের জন্য
[ইনস্টলেশন ও setup](../installation.md) দেখুন।

Context-এর বাড়তি চাপ কমাতে MCP ডিফল্টভাবে compact input schema ব্যবহার করে। পুরো
field নির্দেশনা ও nested validation-এর বিস্তারিত দরকার হলে আপনার MCP নিবন্ধনে
`REA_MCP_INPUT_SCHEMA_PROFILE=full` সেট করুন। দুই profile-এই সব tool থাকে এবং
server-এর canonical validation বজায় থাকে। বিস্তারিত জানতে MCP contracts গাইডের
"Compact input schema profile" অংশটি দেখুন।

সম্পূর্ণ output schema ডিফল্টভাবেই advertise করা হয়। আপনার client যদি পুরো
`tools/list` frame সীমিত করে, প্রতিটি advertised output schema সীমিত রাখতে
`REA_MCP_OUTPUT_SCHEMA_PROFILE=compact` সেট করুন, অথবা output schema একেবারে
বাদ দিতে `off` সেট করুন। দুই সেটিংসেই server-পক্ষের canonical validation এবং
সম্পূর্ণ structured result বজায় থাকে। MCP contracts গাইডের "Output schemas"
অংশটি দেখুন।

### আপনার agent-কে জিজ্ঞাসা করুন

```text
Notes অ্যাপে search কীভাবে কাজ করে তা বুঝে নাও, আমাকে প্রমাণ দেখাও, এবং আমার
প্রজেক্টের জন্য একই রকম একটি ফিচার তৈরি করো।
```

Notes-এর জায়গায় আপনার টার্গেট অ্যাপ এবং যে ফিচারটি বুঝতে চান সেটি বসান।

### টার্মিনাল ব্যবহার করুন

Extract করা একটি JavaScript/Electron অ্যাপ ডিরেক্টরি বা ASAR পরীক্ষা করুন:

```bash
npx -y rea-agents@latest analyze-javascript-application /absolute/path/to/app --json
```

ফলাফলে module, import, Electron boundary এবং সেগুলোর প্রমাণ থাকে।
Path-এর জায়গায় আপনার টার্গেট দিন, যেমন Windows-এ `"D:/apps/example"`।

নিয়মিত ব্যবহারের জন্য `rea` কমান্ড ইনস্টল করতে:

```bash
npm install --global rea-agents
rea --help
```

Native বিশ্লেষণের জন্য আগে একটি provider কনফিগার করুন। Native কমান্ড, provider
বাছাই, snapshot এবং scripting-এর জন্য [CLI ও Evidence গাইড](../cli.md) দেখুন।

### REA আপডেট করুন

REA দ্রুত বদলায়, এবং নতুন release-এ প্রায়ই bug fix থাকে। আপনার
ইনস্টলেশন হালনাগাদ রাখুন।

`npm install --global` বা `bun add --global` দিয়ে ইনস্টল করা CLI-এর জন্য:

```bash
rea update
```

`rea --update` এই যাচাইকৃত workflow-এর একটি alias, এবং একই global output flag
নেয়। অন্য command control-এর সঙ্গে মিলিয়ে চালাতে `rea update` ব্যবহার করুন।

Updater কমান্ড stdout ও stderr মিলিয়ে সর্বোচ্চ 4 MiB রাখে। এর চেয়ে বড় metadata
উত্তর কমান্ড শেষ হওয়ার পর বাতিল করা হয়; verbose ইনস্টল সীমিত diagnostics নিয়ে
চলতে থাকে। মানুষের জন্য progress output টার্মিনালের backpressure মেনে চলে এবং
জমা দেওয়া write শেষ হওয়া পর্যন্ত অপেক্ষা করে।

Bun-এ global আপডেটের জন্য Bun 1.2.17 বা তার পরের সংস্করণ লাগবে। পুরোনো Bun
থাকলে `rea update` চালানোর আগে নিজে Bun আপগ্রেড করে নিন।

আপনার agent নিবন্ধন ও skill রিফ্রেশ করতে, আপডেটের পর যে setup কমান্ডটি
দেখানো হয় সেটি চালান।

`npx` ব্যবহার করলে আপনার agent setup আপডেট করুন এভাবে:

```bash
npx rea-agents@latest setup
```

Setup-এর পরিবর্তনগুলো দেখে নিয়ে আপনার agent রিস্টার্ট করুন। একবারের CLI কমান্ডের জন্য
`npx rea-agents@latest`-এর পরে কমান্ডটি লিখুন। Bun-এ `npx rea-agents@latest`-এর
বদলে `bunx rea-agents@latest` ব্যবহার করুন।

## REA কীভাবে কাজ করে

আপনার agent MCP-এর মাধ্যমে REA-কে call করে টার্গেট পরীক্ষা করে এবং প্রাসঙ্গিক কোড trace করে।
REA প্রমাণসহ ফলাফল ফেরত দেয়। Agent সেগুলো ব্যবহার করে পরবর্তী প্রশ্ন করে,
আচরণ ব্যাখ্যা করে, অথবা একটি implementation লিখে test করে।
CLI কমান্ডও একই workflow ব্যবহার করে।

![REA অনুসন্ধানের ধারা: আপনার agent একটি local টার্গেট সম্পর্কে প্রশ্ন করে, REA analysis টুল দিয়ে সেটি পরীক্ষা ও trace করে, আর agent ফেরত পাওয়া কোড, reference ও অজানা বিষয়গুলো ব্যবহার করে ব্যাখ্যা, implementation ও test করে।](../../website/public/assets/figures/rea-investigation-flow.svg)

[পূর্ণ আকারের চিত্রটি খুলুন](../../website/public/assets/figures/rea-investigation-flow.svg)।

<a id="current-status"></a>

## কী কী বিশ্লেষণ করা যায়

REA-এর জন্য লাগবে Node.js 22.x (>=22.23.4), 24.x (>=24.22.1) বা 26.12.1+, সঙ্গে npm।
অতিরিক্ত টুল ও host সমর্থন টার্গেটের ওপর নির্ভর করে:

| টার্গেট                   | REA কী ফেরত দেয়                                                                           | প্রয়োজনীয়তা ও গাইড                                                                                                            |
| ----------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| ডেস্কটপ ইনস্টলেশন         | Runtime candidate, সহায়ক ফাইল, component marker ও পরবর্তী probe                              | বিল্ট-ইন সীমিত directory/header পরীক্ষা; [ডেস্কটপ অ্যাপ্লিকেশন](../desktop-applications.md)                                       |
| Native বাইনারি            | Pseudocode, assembly, string, symbol, call ও reference                                    | Hopper, Ghidra, IDA বা Kuna; [native বিশ্লেষণ](../native-investigation.md)                                                   |
| Offline ELF layout      | Section, segment, মূল symbol/relocation এবং static mitigation-এর সম্ভাব্য তালিকা                | Linux x64-এ caller-এর দেওয়া pwntools; [binary diagnostics](../binary-diagnostics.md)                                        |
| Go বাইনারি                | Embedded compiler সংস্করণ, module, replacement ও build setting                             | বিল্ট-ইন static ELF/PE/thin Mach-O পরীক্ষা; Go ইনস্টল করার দরকার নেই                                                             |
| GPU code object         | CUDA/HIP target, নির্বাচিত kernel-এর parameter ও resource এবং সংরক্ষিত PTX text              | বিল্ট-ইন static ELF/PE/fatbin/CUBIN/PTX পরীক্ষা; [GPU code object](../gpu-code-objects.md)                                    |
| Model artifact          | GGUF / safetensors metadata, tensor ঘোষণা ও উদ্ভূত মোট মান                                    | বিল্ট-ইন header পরীক্ষা; ঐচ্ছিক পূর্ণ-ফাইল hash; [model ফাইল](../model-artifacts.md)                                               |
| IL2CPP metadata         | Unity global-metadata.dat-এর assembly image, type ও method-এর নাম এবং index range          | বিল্ট-ইন static decoding (version 24, 27, 29, 31 ও 39); Unity লাগে না                                                         |
| Godot PCK               | Archive-এর তালিকা ও extraction, মূল header/directory তথ্য এবং নির্বাচিত content identity        | বিল্ট-ইন static format 2, 3 ও 4; Godot লাগে না                                                                                |
| Rust বাইনারি              | এমবেড করা cargo-auditable crate-এর নাম, সংস্করণ, উৎস ও dependency সম্পর্ক                      | বিল্ট-ইন static ELF/PE/thin Mach-O পরীক্ষা; [Rust বাইনারি](../rust-binaries.md)                                                 |
| PE certificate          | Authenticode WIN_CERTIFICATE entry এবং PKCS#7 signer/X.509 পরিচয়ের field                  | বিল্ট-ইন static PE পরীক্ষা; [PE certificate](../pe-certificates.md)                                                           |
| PE import               | Import ও delay-load DLL-এর নাম, ordinal, IAT RVA এবং pefile import hash                    | বিল্ট-ইন static PE পরীক্ষা; [PE import](../pe-imports.md)                                                                     |
| ELF note                | PT_NOTE/SHT_NOTE owner, type, GNU build-id ও ABI-tag field                                | বিল্ট-ইন static ELF পরীক্ষা; [ELF note](../elf-notes.md)                                                                      |
| Apple IPS crash         | .ips metadata, thread, image, register এবং নথিভুক্ত crash শ্রেণি                             | বিল্ট-ইন static JSON পরীক্ষা; [Apple IPS](../apple-ips.md)                                                                    |
| Linux kernel module     | .modinfo key, __versions CRC, this_module উপস্থিতি এবং signature trailer                   | বিল্ট-ইন static ELF পরীক্ষা; [kernel module](../kernel-modules.md)                                                            |
| Erlang BEAM             | IFF chunk, atom, export, import, lambda এবং Code header                                   | বিল্ট-ইন static BEAM পরীক্ষা; [Erlang BEAM](../erlang-beam.md)                                                                |
| WASM artifact           | Validation, section, হুবহু import/export WAT রূপ এবং decode করা WAT                           | Caller-এর দেওয়া WABT 1.0.42; `inspect_wasm_artifact`                                                                        |
| EVM bytecode            | Dispatch selector, byte offset, অনুমিত argument ও mutability                               | Linux x64-এ local raw/hex carrier; [offline EVM গাইড](../evm-bytecode.md)                                                   |
| SQLite ডেটাবেস           | Table, column, index, view, trigger এবং নির্বাচিত সাধারণ table-এর row                         | Local database/WAL snapshot; native SQLite সীমাসহ Node.js 24.x >=24.15 বা 26+                                                |
| রেকর্ড করা Linux crash    | Raw note, রেকর্ড করা প্রতিটি thread-এর register/signal এবং ঐচ্ছিক mapping candidate           | Linux x64-এ caller-এর দেওয়া pwntools; ঐচ্ছিক GDB/pwndbg; [রেকর্ড করা crash](../recorded-crashes.md)                            |
| JavaScript / Electron   | Module, import, source map, route, IPC এবং native add-on-এর সম্পর্ক                         | Node.js ও npm; Linux: procps-সামঞ্জস্যপূর্ণ `ps`; [অ্যাপ্লিকেশন বিশ্লেষণ](../javascript-application-workflows.md)                   |
| ওয়েবসাইট                 | পেজের গঠন, script, network পর্যবেক্ষণ এবং অনুরোধ করা screenshot                               | একটি Chrome-ঘরানার ব্রাউজার; [ব্রাউজার বিশ্লেষণ](../browser-observation.md)                                                         |
| সংরক্ষিত network capture | Request, response, উন্মুক্ত payload ও source location                                        | HAR বা Fiddler Everywhere SAZ; native mitmproxy capture-এর জন্য Linux-এ mitmdump; [capture গাইড](../web-network-captures.md)  |
| .NET assembly           | Metadata, CIL instruction, ঘোষিত native dependency এবং build তুলনা                          | কিছু লাগে না (শুধু static); [managed-code গাইড](../managed-code-analysis.md)                                                     |
| Android APK             | Manifest ঘোষণা, class, decompile করা method ও reference                                     | Linux/macOS/Windows x64-এ headless JADX ও পূর্ণ JDK; [Android গাইড](../android-analysis.md)                                   |
| APK signature           | v1/v2/v3/v3.1 signer, certificate fingerprint, key rotation এবং digest-এর অভ্যন্তরীণ সামঞ্জস্য | কিছু লাগে না (শুধু static); `inspect_apk_signature`                                                                             |
| Android ডিভাইস           | ডিভাইস, package, process, log, dump, screen capture এবং APK/ফাইল আদান-প্রদান                   | Caller-এর দেওয়া adb (emulator বা হার্ডওয়্যার); [ADB গাইড](../adb-device-analysis.md)                                              |
| JEB প্রজেক্ট              | Engine-চালিত project unit, artifact digest এবং type/method pseudo-code                     | REA_JEB_MCP_URL দিয়ে নির্বাচিত, caller-এর চালু করা একটি MCP-সার্ভিং JEB client; [JEB গাইড](../jeb-analysis.md)                     |
| Android resource        | Decode করা manifest, string table, locale ও সংস্করণের তথ্য                                   | Caller-এর দেওয়া Apktool launcher; [resource গাইড](../apktool-resource-analysis.md)                                           |
| Flutter অ্যাপ             | Dart snapshot hash, প্রতিটি ABI-এর library digest এবং engine build-এর উৎস                  | কিছু লাগে না (static APK parsing); [Flutter গাইড](../flutter-analysis.md)                                                      |
| Firmware                | Region, extraction-এর ফলাফল এবং native বিশ্লেষণে হস্তান্তর                                     | Linux-এ Binwalk / Unblob; [firmware গাইড](../firmware-analysis.md)                                                          |
| রেকর্ড করা packet         | নির্বাচিত field, পুনরাবৃত্ত value, filter এবং decode-as rule                                    | Linux: TShark 4.x + prlimit; [capture গাইড](../packet-captures.md)                                                          |
| Packet সারাংশ             | Endpoint, DNS, TLS SNI, protocol বণ্টন এবং HTTP request                                    | Caller-এর দেওয়া tshark ও capinfos (Linux-এ যাচাই করা); [pcap গাইড](../pcap-analysis.md)                                         |
| রেকর্ড করা logic signal   | Decoder annotation, sample range এবং diagnostics                                          | Linux: sigrok-cli 0.7.2 + prlimit; [signal রেকর্ডিং](../signal-recordings.md)                                               |
| Package ও resource      | ফাইলের তালিকা, digest, plist, Apple bundle-এর গঠন এবং extract করা resource                    | [Artifact ও JavaScript গাইড](../javascript-artifact-reconstruction.md), [Apple অ্যাপ্লিকেশন](../apple-application-analysis.md) |
| Process-এর আচরণ         | টার্মিনাল output, interaction, exit ও filesystem পর্যবেক্ষণ এবং run-এর তুলনা                     | Native PTY-সহ Linux/macOS; [process capture](../process-capture.md)                                                        |
| PyInstaller executable  | CArchive member, Python সংস্করণ, entry script ও extract করা bytecode                        | কিছু লাগে না (শুধু static); [Python প্যাকেজ করা অ্যাপ্লিকেশন](../python-packaged-applications.md)                                     |

Static JavaScript ও .NET পরীক্ষা অ্যাপ্লিকেশন না চালিয়েই দেওয়া ফাইলগুলো পড়ে।
Runtime capture আপনার user permission নিয়ে নির্বাচিত টার্গেট চালায় বা তার সঙ্গে
interact করে; প্রতিটি runtime গাইডে এর প্রভাব বর্ণনা করা আছে।

Offline native-binary পরীক্ষার জন্য REA caller-এর দেওয়া GNU objdump ও Rizin-ও
সমর্থন করে। Provider setup, CLI কমান্ড এবং Evidence-এর সীমাবদ্ধতার জন্য
[reverse-engineering tools গাইড](../reverse-engineering-tools.md) দেখুন। REA
এই দুই provider-এর কোনোটিই ইনস্টল বা আপডেট করে না।

<a id="choosing-a-deep-analysis-provider"></a>

Native format ও host সমর্থন provider ভেদে আলাদা। দেখুন
[Hopper ও Ghidra setup](../installation.md#hopper),
[IDA গাইড](../ida-provider.md) (ঐচ্ছিক native MCP bridge-সহ),
[Kuna decompiler গাইড](../kuna-provider.md) এবং
[পরীক্ষামূলক Windows Ghidra সমর্থন](../windows-ghidra-p0.md)।
Ghidra [16-bit DOS বিশ্লেষণ](../ghidra-dos.md)-ও সমর্থন করে।
বড় বাইনারির জন্য `REA_GHIDRA_STARTUP_TIMEOUT_MS` বা `REA_HOPPER_STARTUP_TIMEOUT_MS`
দিয়ে provider-এর startup deadline বাড়িয়ে দিন।
Provider বাছাইয়ের জন্য [CLI গাইড](../cli.md#choose-a-provider) দেখুন।
সর্বশেষ npm release-এর পরে যোগ হওয়া ফিচারের জন্য
[release-এ প্রাপ্যতা](../installation.md#released-package-and-main) দেখে নিন।

## শোকেস

<a href="https://rea.tools/bn/showcase/">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../assets/rea-showcases-dark.svg" />
    <img alt="DX-Ball sound-pan, Notion clipboard-bridge এবং TH04 bullet-ring শোকেসের চিত্র" src="../assets/rea-showcases.svg" />
  </picture>
</a>

### DX-Ball: একটি sound-pan হিসাব পুনর্গঠন

একটি sound call অনুসরণ করে তার position-to-pan helper-এ পৌঁছান, instruction পরীক্ষা করুন
এবং অসম্পূর্ণ pseudocode-কে C-তে রূপ দিন। পুনর্গঠিত কোডটি মূল x86-এর 3,205টি
case পাস করে এবং compile করা function-এর 63টি byte হুবহু পুনরুৎপাদন করে।

[Case study পড়ুন](https://rea.tools/bn/showcase/dx-ball/) ·
[পুনর্গঠনের repository](https://github.com/N0zoM1z0/dx-ball)

### Notion: Electron clipboard bridge trace করা

Renderer-এর clipboard API খুঁজে বের করুন, preload ও IPC হয়ে main process পর্যন্ত
সেটি অনুসরণ করুন এবং rich clipboard format পরীক্ষা করুন।

[Case study পড়ুন](https://rea.tools/bn/showcase/notion/)

### TH04: একটি DOS bullet-ring হিসাব উদ্ধার

মূল PC-98 গেমের 16-bit instruction পরীক্ষা করুন, স্থির ও লক্ষ্য-অভিমুখী (aimed) কোণের
হিসাব উদ্ধার করুন এবং পুনর্গঠিত C++ কোডকে ঐতিহাসিক compiler output-এর
সঙ্গে মিলিয়ে দেখুন।

[Case study পড়ুন](https://rea.tools/bn/showcase/th04/) ·
[পুনর্গঠনের repository](https://github.com/N0zoM1z0/th04)

### REA দিয়ে RL এনভায়রনমেন্ট তৈরি করুন

একটি ওয়েব অ্যাপের session রেকর্ড করুন, এর API-কে tool-এ রূপান্তর করুন এবং এমন একটি এনভায়রনমেন্ট export করুন যা একটি AI agent ব্যবহার করতে পারে। AgentEnv দিয়ে এটি চালান, তারপর RL training বা মূল্যায়নের জন্য task ও reward check যোগ করুন।

[গাইড পড়ুন](https://rea.tools/bn/guides/rl-environments/) ·
[ভিডিও দেখুন](https://x.com/reatools/status/2112574822584918075?s=20)

আপনি যদি মজার কিছুতে REA ব্যবহার করে থাকেন, আমরা তা দেখতে চাই। একটি
[issue](https://github.com/morluto/rea/issues) বা
[pull request](https://github.com/morluto/rea/pulls)-এ আপনার অভিজ্ঞতা শেয়ার করুন —
টার্গেট, আপনার প্রশ্ন, REA কীভাবে সাহায্য করেছে এবং আপনি কী পেয়েছেন তা সহ।

## RL এনভায়রনমেন্ট তৈরি করুন

একটি AI agent-কে মূল অ্যাপ না চালিয়েই কোনো issue খুঁজে বের করা বা ফোল্ডার তৈরি করার মতো কাজ অনুশীলনের জন্য একটি লোকাল এনভায়রনমেন্ট দিন। এটি reinforcement learning (RL)-এর জন্য, অথবা একটি agent কতটা ভালোভাবে কাজ সম্পন্ন করে তা পরীক্ষা করতে ব্যবহার করুন।

REA রেকর্ড করা API request ও response-কে এমন tool-এ রূপান্তর করে যা agent কল করতে পারে। এনভায়রনমেন্টটি রেকর্ড করা ডেটা ব্যবহার করে এবং কেবল তখনই পরিবর্তন সমর্থন করে যখন রেকর্ডিং তাদের প্রভাব নিশ্চিত করে।

আপনার agent-এ REA সেট আপ থাকলে, নিচের উদাহরণের URL ও ফোল্ডার-সংক্রান্ত কাজগুলো নিজের কাজ দিয়ে বদলে নিন:

```text
Use REA to build an RL environment from my test web app at
http://127.0.0.1:3000.
Cover listing, creating, renaming, and deleting folders. You may create and
remove test folders. Leave existing data unchanged.
Save it in a folder named my-env. Check which operations work and tell me
how to run it.
```

<details>
<summary>এর বদলে কমান্ড লাইন ব্যবহার করুন</summary>

অ্যাপের রেকর্ড করা browser request ও response-সহ একটি ফাইল আগে থেকেই থাকলে এই কমান্ডগুলো ব্যবহার করুন। ফলাফল চালাতে AgentEnv এবং Docker-ও লাগবে।

```sh
rea environment-build ./session.har ./my-env --name my-env --json
agent-env run ./my-env
```

</details>

REA একটি চালানোযোগ্য এনভায়রনমেন্ট export করে, সঙ্গে একটি সাধারণ test থাকে যা যাচাই করে এটি চালু হয় এবং সাড়া দেয়। আপনার RL framework-এর সঙ্গে এটি ব্যবহার করে task-এর লক্ষ্য নির্ধারণ করুন, reward check যোগ করুন এবং training চালান।

[এনভায়রনমেন্ট তৈরির গাইড](https://rea.tools/bn/guides/rl-environments/) ·
[এনভায়রনমেন্ট রেফারেন্স](../agent-environments.md) ·
[X-এ ডেমো দেখুন](https://x.com/reatools/status/2112574822584918075?s=20)

## সাধারণ প্রশ্নোত্তর (FAQ)

<details>
<summary><strong>কোন কোন agent REA ব্যবহার করতে পারে?</strong></summary>

Local MCP server সমর্থন করে এমন যেকোনো agent। Setup
[সমর্থিত agent](../installation.md#supported-agents)-গুলো কনফিগার করে; অন্য client
[ম্যানুয়াল MCP নিবন্ধন](../installation.md#mcp-registry) ব্যবহার করতে পারে।

</details>

<details>
<summary><strong>আমার কি native analysis engine লাগবে?</strong></summary>

গভীর native বিশ্লেষণে টার্গেট ও কাজের ধরন অনুযায়ী Hopper, Ghidra, IDA বা Kuna
ব্যবহৃত হয়। Static JavaScript ও .NET পরীক্ষা native analysis engine ছাড়াই কাজ
করে। অনুমোদন পেলে setup Hopper ইনস্টল করতে পারে; Ghidra, IDA ও Kuna-র ক্ষেত্রে
আপনার বিদ্যমান ইনস্টলেশন ব্যবহৃত হয়। Option ও সমর্থিত টার্গেটের জন্য
[Provider setup](../installation.md#hopper) দেখুন।

</details>

<details>
<summary><strong>আমাকে কি আগে Hopper চালু করতে হবে?</strong></summary>

কোনো কাজে দরকার হলে REA নিজেই Hopper চালু করে। macOS-এ প্রথমবার চালানোর সময় একটি
dialog আপনাকে demo mode বেছে নিতে বা license সক্রিয় করতে বলতে পারে। প্রথম CLI/MCP
কাজ বা স্বয়ংক্রিয় job-এর আগে একই user session-এ সেই prompt-টি সম্পন্ন করুন।
প্রয়োজনে Hopper নিজে খুলুন। দেখুন
[Hopper চালু করা ও সমস্যা সমাধান](../installation.md#launcher-paths-and-troubleshooting)।

</details>

<details>
<summary><strong>skills.sh থেকে skill ইনস্টল করলে কী হয়?</strong></summary>

Skill আপনার agent-কে অনুসন্ধানের নির্দেশনা দেয়। REA-এর MCP server নিবন্ধন করতে এবং
মানানসই নির্দেশনা ইনস্টল করতে `npx rea-agents setup` ব্যবহার করুন, তারপর আপনার agent
রিস্টার্ট করুন। দেখুন [শুধু skill ইনস্টলেশন](../installation.md#skill-only-installation)।

</details>

<details>
<summary><strong>REA কী ধরনের কোড ফেরত দেয়?</strong></summary>

Native বিশ্লেষণ pseudocode ও assembly ফেরত দেয়। JavaScript/Electron বিশ্লেষণ
module ও সেগুলোর পারস্পরিক সম্পর্ক উদ্ধার করে। আপনার agent এই ফলাফল ব্যবহার করে
implementation লেখে ও test করে; [শোকেস](#শোকেস)-এ হাতে-কলমে উদাহরণ আছে।

</details>

<details>
<summary><strong>REA কি আমার অ্যাপ আপলোড করে?</strong></summary>

REA টার্গেট local-ভাবে বিশ্লেষণ করে। টুলের ফলাফল আপনার agent পায়, আর সেই agent-এর
model provider-এর নিজস্ব data policy আছে।

</details>

<details>
<summary><strong>কোনো bug পেলে কী করব?</strong></summary>

আগে আপডেট করুন; সাম্প্রতিক কোনো release-এ হয়তো সমস্যাটি ঠিক হয়ে গেছে।

`npm install --global` বা `bun add --global` দিয়ে ইনস্টল করা CLI-এর জন্য:

```bash
rea update
```

`npx`-এর মাধ্যমে agent setup-এর জন্য:

```bash
npx rea-agents@latest setup
```

Agent ব্যবহার করলে [setup রিফ্রেশ](#rea-আপডেট-করুন) সম্পন্ন করে সেটি রিস্টার্ট করুন।
একই কাজ আবার চেষ্টা করুন। সমস্যা থেকে গেলে আপনার REA সংস্করণ, টার্গেটের ধরন,
সমস্যাটি ঘটানোর ধাপ এবং error output সহ [একটি issue খুলুন](https://github.com/morluto/rea/issues)।

</details>

## ডকুমেন্টেশন

ওয়েবসাইটের [হাতে-কলমে গাইড](https://rea.tools/bn/guides/) দিয়ে শুরু করুন।
সুনির্দিষ্ট option, পূর্বশর্ত ও result contract-এর জন্য:

- [ইনস্টলেশন ও setup](../installation.md): agent নিবন্ধন, provider configuration, আপডেট ও uninstall।
- [প্রস্তুতি যাচাই ও সমস্যা সমাধান](../installation.md#check-readiness-for-your-task): একটি agent বা analysis engine-এর সমস্যা নির্ণয়।
- [CLI ও Evidence](../cli.md): কমান্ড, provider বাছাই, snapshot, import/export ও exit status।
- [MCP contract](../mcp-contracts.md) ও [agent prompt](../mcp-prompts.md): টুলের ফলাফল, session ও নির্দেশিত অনুসন্ধান।
- [টুল ক্যাটালগ](../mcp-contracts.md#generated-catalog): টুল, provider ও CLI কমান্ডের স্বয়ংক্রিয়ভাবে তৈরি তালিকা।
- [Roadmap](../roadmap.md): পরিকল্পিত কাজ ও সক্ষমতার tracker।

নিরাপত্তা-ত্রুটি (vulnerability) জানাতে [SECURITY.md](../../SECURITY.md) দেখুন।

## Star-এর ইতিহাস

🎉 **400,000 GitHub star — সবাইকে ধন্যবাদ!**

যাঁরা REA ব্যবহার করছেন, bug রিপোর্ট করছেন, ফিচারের অনুরোধ জানাচ্ছেন, build test করছেন এবং fix দিয়ে অবদান রাখছেন — সবাইকে ধন্যবাদ।

<a href="https://www.star-history.com/?repos=morluto%2Frea&amp;type=date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=morluto/rea&amp;type=date&amp;theme=dark&amp;legend=top-left" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=morluto/rea&amp;type=date" />
    <img alt="REA GitHub star history" src="https://api.star-history.com/chart?repos=morluto/rea&amp;type=date" />
  </picture>
</a>

## দায়মুক্তি

দায়িত্বশীল ব্যবহারের নির্দেশনার জন্য [DISCLAIMER.md](../../DISCLAIMER.md) দেখুন।

অবৈধ বা অননুমোদিত ব্যবহার নিয়ে প্রজেক্টের অবস্থান REA-এর সব সংস্করণ, বিতরণের মাধ্যম
ও প্ল্যাটফর্মের ক্ষেত্রে প্রযোজ্য; প্রতিটি কপিতে তার প্রযোজ্য license বহাল থাকে।

REA বৈধ গবেষণা, শিক্ষা, interoperability, সফটওয়্যার সংরক্ষণ এবং আপনার নিজের
অথবা পরীক্ষা করার অনুমতি আছে এমন সফটওয়্যার বিশ্লেষণের জন্য।

## অবদান রাখুন

REA-তে আপনার সাহায্য পেলে আমরা খুশি হব! Bug রিপোর্ট করতে বা ফিচারের পরামর্শ দিতে
[একটি issue খুলুন](https://github.com/morluto/rea/issues), অথবা কোড বা ডকুমেন্টেশন উন্নত করতে
[pull request পাঠান](https://github.com/morluto/rea/pulls)।

Development setup ও check-এর জন্য [CONTRIBUTING.md](../../CONTRIBUTING.md), যাচাইয়ের ধাপের জন্য
[testing](../testing.md) এবং নির্বাচিত layer ও dependency path-এর জন্য
[architecture map](../architecture.mermaid) দেখুন।

## লাইসেন্স

[MIT](../../LICENSE)

REA-র নিজস্ব কোড MIT license-এর অধীনে। Third-party উপাদানগুলোর নিজস্ব
license ও copyright notice বহাল থাকে; dependency-র তালিকা, সংরক্ষিত license
টেক্সট ও বাইরের টুলের শর্তাবলির জন্য [Third-party notices](../../THIRD_PARTY_NOTICES.md) দেখুন।

**বাণিজ্যিক টুল — যেমন IDA Pro / Hex-Rays decompiler, Hopper ও JEB — আপনাকে অবশ্যই
বৈধভাবে সংগ্রহ করতে হবে এবং প্রযোজ্য license অনুযায়ী ব্যবহারের অনুমতি থাকতে হবে।**
REA কোনো টুলের license, key বা activation-এর অধিকার দেয় না। Trial ও demo সংস্করণ
vendor-এর শর্তাবলির অধীন, যার মধ্যে user, ফিচার, automation ও output শেয়ার করার
সীমাবদ্ধতাও আছে। Crack করা কপি, চুরি করা key, অননুমোদিতভাবে key শেয়ার করা এবং
license-এর সীমাবদ্ধতা এড়িয়ে যাওয়া অনুমোদিত নয়। এই নির্দেশনা MIT বা third-party
license-এ কোনো পরিবর্তন আনে না।
