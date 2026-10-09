# Changelog

## [6.2.0](https://github.com/morluto/rea/compare/rea-agents-6.1.0...rea-agents-6.2.0) (2026-10-09)


### ⚠ BREAKING CHANGES

Read the [6.1 to 6.2 migration guide](docs/migration-6.2.md) before upgrading. REA's `always-bump-minor` policy includes breaking changes; 6.2 is not a backward-compatibility promise. Preserve original saved files and regenerate missing observations rather than fabricating identities or facts.

* **MCP / Evidence / snapshots / artifacts:** Success results are direct canonical Evidence; read `normalized_result` rather than the old `result`/`evidence` wrapper. Evidence requires nullable `analysis_profile`, session provider aliases are removed, snapshots require complete profile-bound query records, and artifact roles/permissions belong to occurrences. Recreate incompatible saved data; adding fields without recomputing their semantic identity is invalid. ([63bf914](https://github.com/morluto/rea/commit/63bf91405cf97b114a84f337fb1272d98a267999))
* **Process captures:** Legacy v3 conversion is removed. Explicit executable identity and `event_journal` are required; retain old captures and recapture when current comparisons are needed instead of inventing launch identity or event order. ([2a77469](https://github.com/morluto/rea/commit/2a7746998d47446c4db6d4f524e0f183d6803f3f))
* **Cleanup and evaluation:** A one-shot analysis reports cleanup failure while preserving the completed observation or primary diagnostic. Handle `cleanup_incomplete` and retained observations/resources. Configured agent-evaluation fixtures require Evidence-backed correctness, not routing or answer wording alone. ([#1211](https://github.com/morluto/rea/pull/1211), [27a9cea](https://github.com/morluto/rea/commit/27a9ceade7232c1c9a24dc7d454ae060948183a1))
* **JavaScript:** Return-field projections require explicit presence; export-shape changes carry both sides' presence and property inventory coverage. Semantic object operations retain complete `property_path` segments. Regenerate old analysis and distinguish unknown values from unknown presence. ([475a0f8](https://github.com/morluto/rea/commit/475a0f84dac63d710e032bc7f731c1a3bda624ec))
* **Function comparisons:** Remove the unreachable `truncated` dimension state and `summary.truncated` counter; update enum and display consumers while retaining explicit `unknown` facts. ([5510b27](https://github.com/morluto/rea/commit/5510b27d7f863a3df26212fba4a59f8df0da3712))
* **Historical sources:** Unreadable/unknown symlink targets require `target: null`; external targets retain the observed absolute target. Reimport graphs containing display placeholders such as `<outside-root>` and handle nullable targets. ([b7b4333](https://github.com/morluto/rea/commit/b7b433370310c3ffe33d5027d8393151d5e862da))

### Features

* **javascript:** report observed export property presence ([#1160](https://github.com/morluto/rea/issues/1160)) ([45e3edc](https://github.com/morluto/rea/commit/45e3edc17f48954c89d8db86f7313c479bd39344))
* **mcp:** select views of retained analysis results ([#1180](https://github.com/morluto/rea/issues/1180)) ([db675f1](https://github.com/morluto/rea/commit/db675f1d52acda62b6f57b5a8773532f49b259e7))
* **website:** add an Aegis APK code-generation showcase ([0270dd5](https://github.com/morluto/rea/commit/0270dd5739480acced62e045b5890ec0ebde2631))
* **website:** add an Android showcase and clearer project prompts ([6cc817e](https://github.com/morluto/rea/commit/6cc817e8bd377b064b3568ef1eacb27eaefcb4c1))
* **website:** add beginner examples and synchronized publishing ([0fec65d](https://github.com/morluto/rea/commit/0fec65d06b2f5431e704c472e53015d4b3cc967c))
* **website:** add beginner examples and synchronized publishing ([#1203](https://github.com/morluto/rea/issues/1203)) ([0fec65d](https://github.com/morluto/rea/commit/0fec65d06b2f5431e704c472e53015d4b3cc967c))
* **website:** add Discord link beside GitHub badge ([cc39fc5](https://github.com/morluto/rea/commit/cc39fc53b829a349ae199823472990a53014c507))
* **website:** add homepage navigation and faster reading paths ([863674b](https://github.com/morluto/rea/commit/863674b2e92dd7c699768db82d521ccc88b7ebe4))
* **website:** add homepage navigation and faster reading paths ([c94f06d](https://github.com/morluto/rea/commit/c94f06d98f895eb8b6c5ffa5e999ef1d4bb5eea2))
* **website:** add homepage navigation and faster reading paths ([#1213](https://github.com/morluto/rea/issues/1213)) ([863674b](https://github.com/morluto/rea/commit/863674b2e92dd7c699768db82d521ccc88b7ebe4))
* **website:** add search metadata and automatic sitemap ([99f257b](https://github.com/morluto/rea/commit/99f257bbf03c27327e5e0a232fefd3c792acd5bc))
* **website:** add search metadata and automatic sitemap ([b8851cb](https://github.com/morluto/rea/commit/b8851cb977cfdd608798d32bf5877f645b960831)), closes [#1283](https://github.com/morluto/rea/issues/1283)
* **website:** clarify reverse engineering and showcase goals ([e750c26](https://github.com/morluto/rea/commit/e750c262fbf37100369ab25bf8659daa1a2c4cc7))
* **website:** explain REA through a first investigation ([5160d9b](https://github.com/morluto/rea/commit/5160d9b717d0207a357c754bdf72e215e59d19d1))
* **website:** explain REA with Calculator and a playable dinosaur lab ([11b9f03](https://github.com/morluto/rea/commit/11b9f0346cf5413045b41ff552a024e11ba46ccc))
* **website:** lead with the playable dinosaur example ([19c52f5](https://github.com/morluto/rea/commit/19c52f5e3f42fb754fc154bbd16552c5111df0c5))
* **website:** show manual analysis beside a one-prompt workflow ([291bc6f](https://github.com/morluto/rea/commit/291bc6fb70f47d28d23440f03a8a7fa49eb9a391))


### Bug Fixes

* **dev:** accept formatter-ignored staged documentation without failing the commit hook; malformed JSON remains rejected. ([bd2db2f](https://github.com/morluto/rea/commit/bd2db2f0fa495fb08dea443cd16d7683d4b86e6a))

* **release:** publish reviewed release-PR merges from their exact reviewed source. ([c12bad7](https://github.com/morluto/rea/commit/c12bad7f139431fc0db7a8b7c9db1eab95f96dc2))

* **android:** support owned JADX stdio on Windows ([#1276](https://github.com/morluto/rea/issues/1276)) ([636b245](https://github.com/morluto/rea/commit/636b245f1badf2a7ecfa63c6e2378ac2f7673cc3)), closes [#1262](https://github.com/morluto/rea/issues/1262)
* **android:** validate engine archive prerequisites ([#1145](https://github.com/morluto/rea/issues/1145)) ([e9ebfb9](https://github.com/morluto/rea/commit/e9ebfb94eff0699b1ea84bba000c4467fa1cb998))
* **apple:** report unusable dylib-resolution roots as invalid input ([6a1e558](https://github.com/morluto/rea/commit/6a1e558db3ec2b69561e91ea817f1c2065dfc676))
* **apple:** report unusable dylib-resolution roots as invalid input ([24a30fd](https://github.com/morluto/rea/commit/24a30fd91c144b7f2533e5f5de8c91268773519c))
* **artifacts:** keep cancellation and the caller path in extraction refusals ([37025cc](https://github.com/morluto/rea/commit/37025cc09f12d49f46e61eedc3564c710089146b))
* **artifacts:** keep cancellation and the caller path in extraction refusals ([eacf846](https://github.com/morluto/rea/commit/eacf8461dad6bab11a3d5438e6db001a10f33a9b))
* **artifacts:** match lipo arm64e variant names to their FAT slices ([de5bfec](https://github.com/morluto/rea/commit/de5bfec79fe862816350b2deeb42a12c0734d855))
* **artifacts:** match lipo arm64e variant names to their FAT slices ([0b32577](https://github.com/morluto/rea/commit/0b32577a90aef97e36adf2a7af4f3eccd5d82357)), closes [#1168](https://github.com/morluto/rea/issues/1168)
* **artifacts:** name only host-available workflows for non-archive plists ([f4c99ab](https://github.com/morluto/rea/commit/f4c99ab8a53806dd57dc24b3d5a600905bcb4686))
* **artifacts:** name only host-available workflows for non-archive plists ([2295855](https://github.com/morluto/rea/commit/22958558eafdfccf71a7d5bbbcf360574a6b2e3c))
* **artifacts:** recheck failed DMG detaches before reporting cleanup failure ([#1155](https://github.com/morluto/rea/issues/1155)) ([58a91f0](https://github.com/morluto/rea/commit/58a91f03d72162849991caf537ab058ccc918594))
* **artifacts:** refuse unsupported extraction formats before scanning ([8e74c9c](https://github.com/morluto/rea/commit/8e74c9c62fb44556b90f20bb6c12771ac05a18f2))
* **artifacts:** report encrypted archive entries as unsupported extraction ([de43da7](https://github.com/morluto/rea/commit/de43da71ae982dd0f3d7b5ae49c914729db3a6ec))
* **artifacts:** report non-archive keyed-archive selections as unsupported targets ([fef38e4](https://github.com/morluto/rea/commit/fef38e4d22ee859ec43fb591d53e8b9973c69958))
* **artifacts:** report non-archive keyed-archive selections as unsupported targets ([8c5088c](https://github.com/morluto/rea/commit/8c5088c8cdf32a9f96f6c479c6e70a71fa360168))
* **artifacts:** report wrong target kinds as unsupported targets ([b34bdcd](https://github.com/morluto/rea/commit/b34bdcdb2877be394c59c9cbf70269dc1841ff78))
* **artifacts:** report wrong target kinds as unsupported targets ([637bcb5](https://github.com/morluto/rea/commit/637bcb5e4182b6c60e922b18688642d8e1008e90))
* **browser:** classify export-web-scripts capture selection failures by cause ([ddaa183](https://github.com/morluto/rea/commit/ddaa18301ab9c67e7a6f7ce66076075e8a4d5017))
* **browser:** classify export-web-scripts capture selection failures by cause ([8c5e34c](https://github.com/morluto/rea/commit/8c5e34cd379392ca40f651ca5eeb6a947b44aa33))
* **browser:** report Windows HAR heap exhaustion ([#1147](https://github.com/morluto/rea/issues/1147)) ([1393507](https://github.com/morluto/rea/commit/13935077ba039f6e342f9c11ab5eea935a335ae6))
* **browser:** retain scenario observations across failures ([614e0c2](https://github.com/morluto/rea/commit/614e0c2e74819bb5e3ef3d2e16ff31ee6cab76ae))
* **browser:** retain scenario resources until cleanup succeeds ([88640f6](https://github.com/morluto/rea/commit/88640f60fe566edbe2320688df62c7ef46c4c61c))
* **ci:** pass selected environment to Windows Ghidra fixture ([#1281](https://github.com/morluto/rea/issues/1281)) ([f085589](https://github.com/morluto/rea/commit/f085589957922eaf421db814399e88e415712050))
* **cli:** advertise defaulted inputs as optional in --schema and help ([#1175](https://github.com/morluto/rea/issues/1175)) ([b4927a0](https://github.com/morluto/rea/commit/b4927a0a4fa7e8935b101d214b396bfa78208281)), closes [#1169](https://github.com/morluto/rea/issues/1169)
* **cli:** cancel routed JavaScript analysis in rea analyze ([#1156](https://github.com/morluto/rea/issues/1156)) ([089bbf5](https://github.com/morluto/rea/commit/089bbf58f3561e3f465c544bbcf8c307287b1256))
* **cli:** complete cleanup after relayed interrupts ([#1202](https://github.com/morluto/rea/issues/1202)) ([911152a](https://github.com/morluto/rea/commit/911152a04d3aeb0d361141a8d54959009b269e49))
* **cli:** list the read failure cause for an unreadable JSON input file ([db0afce](https://github.com/morluto/rea/commit/db0afce5f344268271c59acee04e96f986c5619a))
* **cli:** list the read failure cause for an unreadable JSON input file ([6020df5](https://github.com/morluto/rea/commit/6020df53d9cd44845cf3b6b416db2d7802925578))
* **cli:** resolve xrefs symbol selectors after address validation ([#1209](https://github.com/morluto/rea/issues/1209)) ([7e9c911](https://github.com/morluto/rea/commit/7e9c91199ecd133d26a51cb33b6e63e1f942df7e))
* **config:** name the rejected setting and its constraint in configuration errors ([c3acc34](https://github.com/morluto/rea/commit/c3acc34475ca22387ea674839acfa1891b0b9f66))
* **config:** name the rejected setting and its constraint in configuration errors ([0a0244d](https://github.com/morluto/rea/commit/0a0244db4212bc1f59dec4b925fa90b3b473136a)), closes [#1184](https://github.com/morluto/rea/issues/1184)
* **doctor:** find the Homebrew Hopper cask without writing Homebrew caches ([98b07d0](https://github.com/morluto/rea/commit/98b07d07ddd20bea2c3bdf8d55ac2776a263bcf4))
* **doctor:** find the Homebrew Hopper cask without writing Homebrew caches ([a503376](https://github.com/morluto/rea/commit/a503376b2f9d9ba14d1602e58e0e93059e9d9181)), closes [#1165](https://github.com/morluto/rea/issues/1165)
* **domain:** report target read-permission denials as access_denied ([f36c10f](https://github.com/morluto/rea/commit/f36c10f9e8dc45a298d668e608f8e945bde487cf))
* **domain:** report target read-permission denials as access_denied ([d0ff57a](https://github.com/morluto/rea/commit/d0ff57a45c8da8938e7ae16d00bfd5ec63310af3)), closes [#1188](https://github.com/morluto/rea/issues/1188)
* **electron:** resolve effective preload after option overrides ([#1286](https://github.com/morluto/rea/issues/1286)) ([411498d](https://github.com/morluto/rea/commit/411498d45f860eba2fbc9d7051af20237b7a4cb1))
* emit v-mode-compatible patterns for tool schemas ([#1220](https://github.com/morluto/rea/issues/1220)) ([f0da05f](https://github.com/morluto/rea/commit/f0da05f67fff1411cf2f7a48a752ee7b348c71ff))
* **errors:** report caller-selected evidence path failures as invalid input ([d4a598e](https://github.com/morluto/rea/commit/d4a598e93649607dd293a9c81bbf79c211bc8dd4))
* **errors:** report caller-selected evidence path failures as invalid input ([db177c9](https://github.com/morluto/rea/commit/db177c91b83adb0c3edc4f9f6f06e31ac7523d53))
* **evidence:** cancel exports before atomic publication ([16624f1](https://github.com/morluto/rea/commit/16624f1324e156d14025b2c346596c9781c07488))
* **ghidra:** classify modern Swift manglings in swift type analysis ([#1208](https://github.com/morluto/rea/issues/1208)) ([6935dc7](https://github.com/morluto/rea/commit/6935dc7fe1258b340bb9cdfb8cecae66ef7bc0d4))
* **ghidra:** do not run Java from a relative JAVA_HOME in doctor and setup ([04a516b](https://github.com/morluto/rea/commit/04a516b1e369f7e57e08d0653cc08292ac497e07))
* **ghidra:** do not run Java from a relative JAVA_HOME in doctor and setup ([c3f1698](https://github.com/morluto/rea/commit/c3f169823f690371ecfdd2d1b3b07a5749438cf1))
* **ghidra:** keep and name a runtime directory that close could not remove ([5b769d3](https://github.com/morluto/rea/commit/5b769d3a781c645ed8885e4fabf01a00f0bbc89b))
* **ghidra:** keep and name a runtime directory that close could not remove ([b79d379](https://github.com/morluto/rea/commit/b79d379c25bcc8ed61571c41a94b912b5704a067)), closes [#1190](https://github.com/morluto/rea/issues/1190)
* **ghidra:** keep the NativeAOT target refusal's own recovery advice ([f198993](https://github.com/morluto/rea/commit/f198993f418e6aaa9755e7e6413abcb27c6cd684))
* **ghidra:** preserve decoded return flow evidence ([b189c3c](https://github.com/morluto/rea/commit/b189c3ceb175dd9fa089eada9e9ca54e76307cb3))
* **ghidra:** preserve decoded return flow evidence ([bcc8a77](https://github.com/morluto/rea/commit/bcc8a773e2a714e4899755b786a4fef1539bbace))
* **ghidra:** reject relative installation and Java paths in doctor and setup ([8998438](https://github.com/morluto/rea/commit/8998438c23aa19e68f4ffa7574c5d341aa419165))
* **ghidra:** reject relative installation and Java paths in doctor and setup ([5356856](https://github.com/morluto/rea/commit/53568568bf32b36274ba3a532f1e2cfb2daed271)), closes [#1183](https://github.com/morluto/rea/issues/1183)
* **ghidra:** report NativeAOT host and target refusals as unsupported, not failures ([cfb49eb](https://github.com/morluto/rea/commit/cfb49eb8a88fc51f460907024c51e05a2f272502))
* **ghidra:** report NativeAOT host and target refusals as unsupported, not failures ([42c276a](https://github.com/morluto/rea/commit/42c276af1ec02473a7b6700a31292aae9e53d53e)), closes [#1185](https://github.com/morluto/rea/issues/1185)
* **ghidra:** resolve secondary symbols at function entries ([#1195](https://github.com/morluto/rea/issues/1195)) ([6fbdbd6](https://github.com/morluto/rea/commit/6fbdbd682038d012b04f0fe92c470cf1789fb101))
* **ghidra:** stop dereferencing the removed error payload in address verification ([b80bd2d](https://github.com/morluto/rea/commit/b80bd2db966731fd3cfddfff7e92704053dbe955))
* **ghidra:** stop dereferencing the removed error payload in address verification ([59fbaa2](https://github.com/morluto/rea/commit/59fbaa2d33359216534407f99f49705ac04a3426))
* **ghidra:** use dot-free private session paths ([c3fc6c3](https://github.com/morluto/rea/commit/c3fc6c3aedc202e8ade015c4039a63e9f91cac6d))
* **hopper:** keep the OS error when the FAT64 source cannot be reopened ([9f5dc52](https://github.com/morluto/rea/commit/9f5dc52be8420fb5e874595d63312bf80d07a3a2))
* **hopper:** reserve Linux demo application before launch ([#1158](https://github.com/morluto/rea/issues/1158)) ([33d5ae0](https://github.com/morluto/rea/commit/33d5ae0b52b8684634ecf14d4e9469968c69d462))
* **javascript:** allow cancellation during semantic graph commitment ([#1218](https://github.com/morluto/rea/issues/1218)) ([9405bd6](https://github.com/morluto/rea/commit/9405bd660def9946afaa5fcc1d99921a816911bf))
* **javascript:** classify application input selection failures by cause ([fe5291e](https://github.com/morluto/rea/commit/fe5291e9166977a6ebbfa6ffcf7850af57192b34))
* **javascript:** classify application input selection failures by cause ([0a14bbb](https://github.com/morluto/rea/commit/0a14bbbf05e0e61c98e06326fe7136e52fa4fb3c))
* **javascript:** keep Wakaru version stderr out of the refusal message ([6489d58](https://github.com/morluto/rea/commit/6489d58851d055fd7ce621000d960bb42a0e4ce0))
* **javascript:** match source-map originals that name parent directories ([#1215](https://github.com/morluto/rea/issues/1215)) ([889fb37](https://github.com/morluto/rea/commit/889fb374df0f8986f49e9d61b0fefd536327f781))
* **javascript:** omit self-referential static references with disclosure ([#1157](https://github.com/morluto/rea/issues/1157)) ([b620e2a](https://github.com/morluto/rea/commit/b620e2a2bdcf3683b494d137bc409813735d5572))
* **javascript:** preserve alias and container uncertainty ([73e98b2](https://github.com/morluto/rea/commit/73e98b2516dd792ea7b510aeed6b71f384bea21d))
* **javascript:** preserve graphs with async chunk self-references ([#1152](https://github.com/morluto/rea/issues/1152)) ([7220166](https://github.com/morluto/rea/commit/72201668ed88c2cc822a07c08cf35a1e5ba88f35))
* **javascript:** preserve property paths and uncertain slot presence ([475a0f8](https://github.com/morluto/rea/commit/475a0f84dac63d710e032bc7f731c1a3bda624ec))
* **javascript:** reject encoded separators joined by HTML URL whitespace ([2ddd945](https://github.com/morluto/rea/commit/2ddd9456cd405f081784a4b3cb02cb77cd90fbd6))
* **javascript:** reject encoded separators joined by HTML URL whitespace ([fb57c86](https://github.com/morluto/rea/commit/fb57c8643fb8b4733cbac9090ef58fd13a3b5347))
* **javascript:** report located sources with differing digests as modified ([#1216](https://github.com/morluto/rea/issues/1216)) ([01174c4](https://github.com/morluto/rea/commit/01174c4a81fea109ae712ea1a746a83996f928ac))
* **javascript:** resolve HTML script URLs after URL whitespace and percent decoding ([d601b80](https://github.com/morluto/rea/commit/d601b8016eaeb2955cea4e4c0aca10d17e7d12a7))
* **javascript:** resolve HTML script URLs after URL whitespace and percent decoding ([502528c](https://github.com/morluto/rea/commit/502528c58df54c7b34eefdb5837f36e58f473405)), closes [#1236](https://github.com/morluto/rea/issues/1236)
* **javascript:** resolve package exports targets only to the exact file ([#1181](https://github.com/morluto/rea/issues/1181)) ([2a620c0](https://github.com/morluto/rea/commit/2a620c06cdcaa32844c4a80aeb3df1793f1ce09e)), closes [#1174](https://github.com/morluto/rea/issues/1174)
* keep the Ghidra session root free of dot-prefixed path elements ([a8b8288](https://github.com/morluto/rea/commit/a8b8288396cf2e053db768ef03f4db756aa8f71e))
* **managed:** preserve literal library names during native matching ([81b70bc](https://github.com/morluto/rea/commit/81b70bc358031686c9d7afd049f21719c67a9525))
* **managed:** separate metadata and signature completeness ([2f02eff](https://github.com/morluto/rea/commit/2f02eff9887fc715c33f5d8770a6e6191ba70ca9))
* **mcp:** advertise input patterns without look-around ([1f099a6](https://github.com/morluto/rea/commit/1f099a6fc00b08fb0283dcabc5a238025d4c4c8b))
* **mcp:** advertise input patterns without look-around ([a8701ea](https://github.com/morluto/rea/commit/a8701eaf489692449739d5b2490502b1a14951c5)), closes [#1282](https://github.com/morluto/rea/issues/1282)
* **mcp:** deliver tool errors within advertised schema contracts ([da606ff](https://github.com/morluto/rea/commit/da606ff77718d9a3b10426fcf68c098138e6dcfa)), closes [#1261](https://github.com/morluto/rea/issues/1261)
* **mcp:** deliver typed errors without invalid structured output ([#1277](https://github.com/morluto/rea/issues/1277)) ([7e96f25](https://github.com/morluto/rea/commit/7e96f25f8b1380a13a086a68f8d5a70380468151))
* **mcp:** emit portable Unicode NUL patterns ([#1230](https://github.com/morluto/rea/issues/1230)) ([aa5750c](https://github.com/morluto/rea/commit/aa5750c263632d98d626c5ca3b985bb1519d2395))
* **mcp:** measure tool errors against their text-only delivery ([fe34ec2](https://github.com/morluto/rea/commit/fe34ec2ef3e2968eeb06f64a1a0fdb8b825f56c4))
* **mcp:** measure tool errors against their text-only delivery ([7b51121](https://github.com/morluto/rea/commit/7b51121f7cee21a5938f10ac3b5762e0bb41a58d))
* **mcp:** only recommend exporting retained evidence ([5f749c2](https://github.com/morluto/rea/commit/5f749c2096af2617d4b6b387ff19c13001af8e54))
* name host and tool requirements in optional adapter refusals ([68cb02f](https://github.com/morluto/rea/commit/68cb02fe8b123b9a0778c0065c13a15bcf0e577d))
* name host and tool requirements in optional adapter refusals ([170d0bf](https://github.com/morluto/rea/commit/170d0bf9e2d45b2512ad556c02f31bdc81ea03ca))
* **native:** distinguish batch selectors from resolved entries ([13c3b68](https://github.com/morluto/rea/commit/13c3b68730df80330fd867d921dea38770d5f880))
* **native:** distinguish batch selectors from resolved entries ([bfaa5a6](https://github.com/morluto/rea/commit/bfaa5a6c2c0ddc9e6fcf16cd11ad06f24db174a2))
* **native:** name the CLI flag that selects another plist ([9b69503](https://github.com/morluto/rea/commit/9b6950373cfaa1a2c0d28287bfadd4a421afb9e9))
* **native:** name the plist selection that works when Info.plist is missing ([5612496](https://github.com/morluto/rea/commit/5612496f6d34a462dcd0fb69fa38337592e2f72d))
* **native:** name the plist selection that works when Info.plist is missing ([a6fdf42](https://github.com/morluto/rea/commit/a6fdf426bd98c8cf7b7a7f589208d3193784062f))
* **native:** refuse truncated executable headers at target admission ([d39a450](https://github.com/morluto/rea/commit/d39a450bdfac425962c3a6a6f47b45600057a230))
* **native:** refuse truncated executable headers at target admission ([0b04d38](https://github.com/morluto/rea/commit/0b04d384cca4f22f271d60bcfe67f79cab89c8de)), closes [#1189](https://github.com/morluto/rea/issues/1189)
* **process:** apply one timeout rule to both execFileOutput modes ([3d32819](https://github.com/morluto/rea/commit/3d328193d69a63a355644c51bfb70f524d99bca9))
* **process:** await cleanup on CLI and MCP cancellation ([f6fe575](https://github.com/morluto/rea/commit/f6fe575094658e99ced78d45f385633fbfaaae32))
* **process:** keep ports before a chunk-final period ([184ed97](https://github.com/morluto/rea/commit/184ed970b9021552a5454ced20d202d10cabcbb8))
* **process:** localize capture truncation diagnostics ([#1284](https://github.com/morluto/rea/issues/1284)) ([33bf585](https://github.com/morluto/rea/commit/33bf585185ffcaea63d658e2d3145c900a680485))
* **process:** normalize ports that end a sentence ([098d769](https://github.com/morluto/rea/commit/098d76900effdbc682b0f97bcde7f8711380ecea))
* **process:** normalize ports that end a sentence ([db98a51](https://github.com/morluto/rea/commit/db98a51dd1750b09b3905e18efac526f7ebf90f7))
* **process:** preserve numeric output and original PTY evidence ([c5c75c3](https://github.com/morluto/rea/commit/c5c75c38c3a4ff0153513b8f8ad600d8a5bacc09))
* **process:** preserve numeric output and original PTY evidence ([00d8e44](https://github.com/morluto/rea/commit/00d8e44cbf82caa51709c2e0857fbaa69ea329b7))
* **process:** preserve unknown filesystem absence in partial captures ([c8544b1](https://github.com/morluto/rea/commit/c8544b1574a32838da6d4ed40f2b72582edb60dd))
* **process:** refuse malformed timeouts for stoppable commands ([136d4aa](https://github.com/morluto/rea/commit/136d4aab18d822f0f908096b8acfac556ef1873b))
* **process:** refuse malformed timeouts for stoppable commands ([59c91c8](https://github.com/morluto/rea/commit/59c91c88fe88210b4b22b9f1365a16567513da4a))
* **process:** require current captures and preserve cleanup failures ([2a77469](https://github.com/morluto/rea/commit/2a7746998d47446c4db6d4f524e0f183d6803f3f))
* **process:** retain known events from incomplete captures ([5eb0049](https://github.com/morluto/rea/commit/5eb0049a9f502b404f30e48c3fe3430a942bb0b5))
* **process:** stop cancelled Swift helper builds before removing their files ([cf41561](https://github.com/morluto/rea/commit/cf415619cadcfcb18cda59a54b26c9d164f750a4))
* **process:** stop cancelled Swift helper builds before removing their files ([c717204](https://github.com/morluto/rea/commit/c7172047951e7dbb9df58b57ff1b43ac9bd47909)), closes [#1173](https://github.com/morluto/rea/issues/1173)
* **process:** stop timed-out commands with the caller's stop signal ([4b38d18](https://github.com/morluto/rea/commit/4b38d1899566089d19b9fd137202f7d86b62fc6f))
* **process:** stop timed-out commands with the caller's stop signal ([063de50](https://github.com/morluto/rea/commit/063de5014f19e85c38b6bec5984de4f38e71adaa))
* **process:** treat non-ASCII letters as port continuations ([ad813e4](https://github.com/morluto/rea/commit/ad813e473b094ab0d3ab30798b7d252e2f4beb94))
* **process:** validate terminal byte totals against retained frames ([69833fb](https://github.com/morluto/rea/commit/69833fb0d0fe9b320b5745a992822342f2c54a92))
* **process:** validate terminal byte totals against retained frames ([39eb058](https://github.com/morluto/rea/commit/39eb0587c95ad028bb961c539ad1f326a1e8d81c))
* **providers:** preserve observations and primary cleanup failures ([0696bde](https://github.com/morluto/rea/commit/0696bde2660bb5d6538d8c01da15aa023312aa9f))
* **reference:** represent unreadable symlink targets explicitly ([b7b4333](https://github.com/morluto/rea/commit/b7b433370310c3ffe33d5027d8393151d5e862da))
* restore caching, preserve failures, and verify fixture claims ([#1211](https://github.com/morluto/rea/issues/1211)) ([27a9cea](https://github.com/morluto/rea/commit/27a9ceade7232c1c9a24dc7d454ae060948183a1))
* **server:** report 2025-era client identity and features in binary_session ([e6abaef](https://github.com/morluto/rea/commit/e6abaefbbc2bd81a6be34cbe71b87be801158c16))
* **server:** report 2025-era client identity and features in binary_session ([b8312fa](https://github.com/morluto/rea/commit/b8312fa8d184ba9f422d1f5592fb41e49811544a)), closes [#1167](https://github.com/morluto/rea/issues/1167)
* **session:** require an open target for session-bound native and artifact tools ([d8e314c](https://github.com/morluto/rea/commit/d8e314cb24e7a4a494347e45474234e0aad74ad1))
* **session:** require an open target for session-bound native and artifact tools ([cf77d07](https://github.com/morluto/rea/commit/cf77d073fc06ab95ce4181c30d68b1346e990b64)), closes [#1166](https://github.com/morluto/rea/issues/1166)
* **session:** retain failed provider cleanup for lifecycle retries ([#1260](https://github.com/morluto/rea/issues/1260)) ([24a3aa0](https://github.com/morluto/rea/commit/24a3aa08d1f69e25b441f086300ba3082d860a35))
* **setup:** keep Codex TOML comments when adding or removing REA ([f5539cf](https://github.com/morluto/rea/commit/f5539cfc2f6c0daf6c275fc97f3351e2cf89b2c3))
* **setup:** keep Codex TOML comments when adding or removing REA ([e9c48a6](https://github.com/morluto/rea/commit/e9c48a61e4c2c05c5b77ef4a815c5b2a65a9337e)), closes [#1163](https://github.com/morluto/rea/issues/1163)
* **setup:** preserve initial backups and Codex comments ([#1204](https://github.com/morluto/rea/issues/1204)) ([6051cb2](https://github.com/morluto/rea/commit/6051cb2c0c723d88dc43ee5ef8a96971bf84d49e))
* **setup:** stop remaining uninstall removals after a client fails ([fd975c7](https://github.com/morluto/rea/commit/fd975c75fa353840e6e887232ca68496cf8705ea))
* **setup:** stop uninstall before removals when a client config is unsafe ([4fb2f3e](https://github.com/morluto/rea/commit/4fb2f3e6ed0233505eada3cddeeff0ea0bfc6fe5))
* **setup:** stop uninstall before removals when a client config is unsafe ([5cc841d](https://github.com/morluto/rea/commit/5cc841d5c154f692bdc257e106cc4b212dc19dc0)), closes [#1164](https://github.com/morluto/rea/issues/1164)
* **snapshot:** report query workflow and Evidence counts separately ([04aef6d](https://github.com/morluto/rea/commit/04aef6df331634238cfc61f320ba4a4e720750a4))
* **snapshot:** report query workflow and Evidence counts separately ([0e77953](https://github.com/morluto/rea/commit/0e779533a9108a550b4d10dcb3920f91c7d48989))
* **website:** clarify Android host and JDK requirements ([5691606](https://github.com/morluto/rea/commit/5691606aa948bddc641e3ecbccf5375a12b65924))
* **website:** identify publication verifier requests ([e6905c1](https://github.com/morluto/rea/commit/e6905c18e09c41e04525fb1a84575483df789204))
* **windows:** retain runtime authority after cleanup failure ([af7a439](https://github.com/morluto/rea/commit/af7a43963351c655eb86197bf52ae798a04e9c22))
* **windows:** retain unsettled jobs for cleanup retry ([76b214e](https://github.com/morluto/rea/commit/76b214e45fa05fe723e216894327185b9b4e6f53))


### Performance Improvements

* **mcp:** share repeated output schema definitions. ([441813c](https://github.com/morluto/rea/commit/441813c0708dbee82ef554c91e973ae02964bf2e))

* **hopper:** resolve string search records once per query ([#1229](https://github.com/morluto/rea/issues/1229)) ([9426c3f](https://github.com/morluto/rea/commit/9426c3f1bbb94711d8b33097e604b9b8ed853b5e))
* **mcp:** reuse input schemas without losing caller guidance ([#1162](https://github.com/morluto/rea/issues/1162)) ([e1afbc1](https://github.com/morluto/rea/commit/e1afbc1914cc7ff90265313e942f34ea4a58a4fc))
* **snapshot:** avoid redundant result copies and serialization ([552634d](https://github.com/morluto/rea/commit/552634d634655a722b2204cfbc4b29f6d442c294))
* **snapshot:** avoid redundant result copies and serialization ([569d2bc](https://github.com/morluto/rea/commit/569d2bc6b9f600114267a4c69f8400393ea1bc2f))


### Code Refactoring

* **domain:** remove obsolete comparison representations ([5510b27](https://github.com/morluto/rea/commit/5510b27d7f863a3df26212fba4a59f8df0da3712))
* enforce canonical evidence and provider boundaries ([63bf914](https://github.com/morluto/rea/commit/63bf91405cf97b114a84f337fb1272d98a267999))
* remove forwarding exports and redundant aliases ([ad59531](https://github.com/morluto/rea/commit/ad59531a960a0c51ef6857fa1391270dda0fa7a4))
* **schemas:** share portable identifier and base64 patterns ([#1227](https://github.com/morluto/rea/issues/1227)) ([954badb](https://github.com/morluto/rea/commit/954badbaaadd24a210190ce3015e40c23d327567))


### Documentation

* add French README translation ([84094af](https://github.com/morluto/rea/commit/84094af54a4e0a6247445e59abff27bc4eca361b))
* add French README translation ([9664b2b](https://github.com/morluto/rea/commit/9664b2b101fe4ac334b2911f9210b50d58d90a89))
* celebrate 30,000 GitHub stars 🎉 ([6987cb0](https://github.com/morluto/rea/commit/6987cb066a5aa5e51480bb06a93a758e6f67cd1e))
* celebrate 30,000 GitHub stars 🎉 ([beca997](https://github.com/morluto/rea/commit/beca9977eb2b18fc7b9844cff0ca70004b6ff21a))
* clarify REA has no affiliated cryptocurrency or token ([#1214](https://github.com/morluto/rea/issues/1214)) ([c2d8146](https://github.com/morluto/rea/commit/c2d8146f94c7533eb87681c2405e93bdfef21b59))
* explain 6.2 contract and saved-data migration ([#1304](https://github.com/morluto/rea/issues/1304)) ([c267e99](https://github.com/morluto/rea/commit/c267e9922751c03df312655ebd623de1b480215c))
* **ghidra:** explain supported heap and CPU controls ([#1278](https://github.com/morluto/rea/issues/1278)) ([0c6852b](https://github.com/morluto/rea/commit/0c6852b392b34319a6fd2c6dffcac10cee51ab94)), closes [#1255](https://github.com/morluto/rea/issues/1255)
* keep the 30k milestone in Star History ([#1217](https://github.com/morluto/rea/issues/1217)) ([c399670](https://github.com/morluto/rea/commit/c399670653884673158f314ed38260aef74da593))
* require focused brittleness cleanup and executable examples ([d6832c3](https://github.com/morluto/rea/commit/d6832c3632847cf3e62d4082b4b8b8d9af554633))
* thank feature request contributors ([9db1fd0](https://github.com/morluto/rea/commit/9db1fd0bd7b17ed1dd21b9c72dabfa4ec6c23a3f))
* **website:** continue the Calculator example with reconstruction ([4578647](https://github.com/morluto/rea/commit/4578647c59a7487bce597a65be6eab8be0412e84))
* **website:** continue the Calculator example with reconstruction ([18a1e8c](https://github.com/morluto/rea/commit/18a1e8cd0efe14c06fd14aabe0c318d2ae390f78))
* **website:** explain SEO maintenance and indexing follow-up ([bb8ff2c](https://github.com/morluto/rea/commit/bb8ff2cfba638ee3a77f951c01e98340c757f525))
* **website:** introduce the worked homepage examples ([f6f5c16](https://github.com/morluto/rea/commit/f6f5c160979624cdcb33928f1a77cf000de403d4))
* **website:** invite deeper projects and reader feedback ([3fb9ffa](https://github.com/morluto/rea/commit/3fb9ffaa4d67685412873cbd3101c64fabbeaff3))


### Tests

* **apple:** verify compiled Mach-O root occurrence facts ([#1300](https://github.com/morluto/rea/issues/1300)) ([4bb4c6f](https://github.com/morluto/rea/commit/4bb4c6fe6d34525c7665a9d38b584b026dd5cdd9))
* **artifacts:** assert asset-catalog target refusal only on macOS ([44d5b4b](https://github.com/morluto/rea/commit/44d5b4b25e0831769c1bd4e5426ef498d0bd3c74))
* **artifacts:** pin per-occurrence roles for direct Mach-O roots and shared bytes ([701d90a](https://github.com/morluto/rea/commit/701d90aba48aaf4f23e1a73e46ebf9968fb85293))
* **artifacts:** pin per-occurrence roles for direct Mach-O roots and shared bytes ([b9e29c5](https://github.com/morluto/rea/commit/b9e29c52d483704c64cd88f87eaa117066288602)), closes [#1234](https://github.com/morluto/rea/issues/1234) [#1235](https://github.com/morluto/rea/issues/1235)
* **artifacts:** read /bin/ls slice layout from its FAT table ([#1223](https://github.com/morluto/rea/issues/1223)) ([c89b3a0](https://github.com/morluto/rea/commit/c89b3a00dce8df36ddb696b59c80e1adc6aceac1))
* **artifacts:** verify compiled Mach-O roles and permissions ([4bb4c6f](https://github.com/morluto/rea/commit/4bb4c6fe6d34525c7665a9d38b584b026dd5cdd9))
* consolidate redundant assertions into boundary workflows ([b71a591](https://github.com/morluto/rea/commit/b71a591a60e3fa5333889e3cf97e05f4ae03c686))
* **ghidra:** preserve selected verification resource limits ([1c3766a](https://github.com/morluto/rea/commit/1c3766a8bcc8a2b6af679cdaa92a73fec42b3372))
* **ghidra:** size oversized annotations for canonical delivery ([1e34197](https://github.com/morluto/rea/commit/1e341973cfad1dbf06755f3a086ffc23d42a723c))
* **ghidra:** use host-native absolute session root fixtures ([1e83d27](https://github.com/morluto/rea/commit/1e83d270c2098b1bcb59591698a257a05d2296fc))
* **javascript:** expect the invalid input_path code in the streamed CLI failure test ([d186ca7](https://github.com/morluto/rea/commit/d186ca7e41928fc2748de2631f5cb43115776571))
* **mcp:** read bundle failures from public error content ([69c3b32](https://github.com/morluto/rea/commit/69c3b32a21c90ea96194fb695f7b58992e8b3714))
* **mcp:** read typed errors in canonical Evidence regressions ([fd46cff](https://github.com/morluto/rea/commit/fd46cff017f0110aaab1216764cf01a71b341766))
* **mcp:** validate public error diagnostics in acceptance workflows ([09058eb](https://github.com/morluto/rea/commit/09058ebc4a68c76d865a92dbddb65811ba8344f7))
* **native:** assert batch identity in production registration ([933fcb3](https://github.com/morluto/rea/commit/933fcb33c1fa1eae109228b89c1200abb7745eb8))
* **native:** build the .app fixture executable with a complete Mach-O header ([facaae8](https://github.com/morluto/rea/commit/facaae865af243656ab8f557aeb42f5909748f2b))
* **process:** check malformed capture choices concurrently ([6020a0b](https://github.com/morluto/rea/commit/6020a0b3683ce16e1441963473605f870c247e29))
* **process:** check malformed capture choices concurrently ([48de11c](https://github.com/morluto/rea/commit/48de11ce2e5af9810fc97d1c2f89df56bf3a3d4d))
* remove duplicate workflow examples and self assertions ([d6d1cd2](https://github.com/morluto/rea/commit/d6d1cd248506015b59a2abdbbb84e3dbd02388fc))


### Continuous Integration

* **website:** allow explicitly requested Pages-only publication ([796b65e](https://github.com/morluto/rea/commit/796b65e1cd15f3cf819396716320db007655ee3f))
* **website:** allow explicitly requested Pages-only publication ([864160d](https://github.com/morluto/rea/commit/864160d8858fad3c0afebff81c31b090a1ebf823))
* **website:** allow explicitly requested Pages-only publication ([#1205](https://github.com/morluto/rea/issues/1205)) ([796b65e](https://github.com/morluto/rea/commit/796b65e1cd15f3cf819396716320db007655ee3f))
* **website:** publish Cloudflare and Pages from one artifact ([761881c](https://github.com/morluto/rea/commit/761881cec33b18d7228bae5e2093e5d44b96ceb1))

## [6.1.0](https://github.com/morluto/rea/compare/rea-agents-6.0.0...rea-agents-6.1.0) (2026-10-09)


### ⚠ BREAKING CHANGES

* **hopper:** Hopper regex mode uses ECMAScript Unicode syntax instead of Python re. Matching runs in a cancellable worker with a five-second deadline; literal mode keeps Unicode casefold matching.
* **hopper:** remove set_current_document. Use open_binary to switch targets; document arguments are scoped to the active target.

### Features

* **clients:** register Grok Build and Grok Bot during setup ([#1134](https://github.com/morluto/rea/issues/1134)) ([08561e0](https://github.com/morluto/rea/commit/08561e0eb7a4a01a256f3693a97061fbea7fb8fa))
* **ghidra:** make the startup deadline configurable ([#974](https://github.com/morluto/rea/issues/974)) ([d84bc8f](https://github.com/morluto/rea/commit/d84bc8f11abd6cbf5612daf5c8f7e1805d23c16e))
* **website:** add GitHub link with live star count ([2f59287](https://github.com/morluto/rea/commit/2f59287f1a1794a68102a45c61cc657659fa5de6))


### Bug Fixes

* **analysis:** bind overview document identity to the active target ([#1094](https://github.com/morluto/rea/issues/1094)) ([81b5104](https://github.com/morluto/rea/commit/81b51042767ad75310bad1a7a9faf954339841c0))
* **analysis:** resolve procedure identities and preserve literal queries ([d830cb7](https://github.com/morluto/rea/commit/d830cb79b305e6d4d255f8080de69ca668cbe0af))
* **android:** report actual provider readiness ([c715af8](https://github.com/morluto/rea/commit/c715af80587f808de816d3add6a6f989437ab66a))
* **android:** report startup and selector failure causes ([6c13fc8](https://github.com/morluto/rea/commit/6c13fc8e0a318ebe7be6b038089b350d99f8e286))
* **apple:** account for repeated archive projections ([e1df5e8](https://github.com/morluto/rea/commit/e1df5e85551125b27ef0debb7573de5507b149e1))
* **apple:** budget Interface Builder decoding and projection ([dbcf8c3](https://github.com/morluto/rea/commit/dbcf8c33915d924fdbc881bf2cf9676587f3b96f))
* **apple:** classify empty dyld settings by consumer semantics ([#1110](https://github.com/morluto/rea/issues/1110)) ([fe297e5](https://github.com/morluto/rea/commit/fe297e56e804130dd49cc0a95fcf2d115c183ae3))
* **apple:** decode bundle plist bytes before executable lookup ([d575a73](https://github.com/morluto/rea/commit/d575a7340bb19b84733c79b14de9f4df7181c6b3))
* **apple:** decode Interface Builder XML byte encodings ([#1095](https://github.com/morluto/rea/issues/1095)) ([f8e143a](https://github.com/morluto/rea/commit/f8e143a3bcd20ddcc0d76d90e73e238d456fe5a3))
* **apple:** derive dispatch coverage from located decode facts ([488f448](https://github.com/morluto/rea/commit/488f448ae27fd62904967ec1e0ab072e834a9822))
* **apple:** keep skipped catalog entries from reading as absence ([a079af2](https://github.com/morluto/rea/commit/a079af297bb454417dfd3d89b0037397554ad83e))
* **apple:** report apps without asset catalogs as empty inventories ([e2f0378](https://github.com/morluto/rea/commit/e2f03786f496ed742572acd87f47270c958171ec))
* **apple:** report apps without asset catalogs as empty inventories ([79e5a39](https://github.com/morluto/rea/commit/79e5a3923db896323c0491e31004214856529b74))
* **apple:** report missing keyed archive hierarchy references ([#1104](https://github.com/morluto/rea/issues/1104)) ([3b2ec69](https://github.com/morluto/rea/commit/3b2ec69c54fc9cf65bf8441edbb96e9619c3a37e))
* **apple:** validate dylib candidates and preserve search uncertainty ([#1100](https://github.com/morluto/rea/issues/1100)) ([7914e36](https://github.com/morluto/rea/commit/7914e36ab9adbbf591a6e1f3fafcb2e17f55d667))
* **apple:** validate physical slices and dylib platform compatibility ([15f92f2](https://github.com/morluto/rea/commit/15f92f298891c8b16d7d13c78cb6ca66cb90cd85))
* **application:** budget bridge candidate projection by bytes ([3d450a2](https://github.com/morluto/rea/commit/3d450a29fc91cef3e06ffce9a925ac70dcb24272))
* **artifacts:** preserve keyed archive integer precision ([4034883](https://github.com/morluto/rea/commit/4034883e9860a97edee03260fab59f9229debfa6))
* **artifacts:** report keyed-archive selection mistakes as invalid input ([5a55d5b](https://github.com/morluto/rea/commit/5a55d5b1c6aefb4a4e5df63ec43b7e2fc0a7d385))
* **artifacts:** report keyed-archive selection mistakes as invalid input ([25fb6d3](https://github.com/morluto/rea/commit/25fb6d32a325d88bb0f4e05e16f5f82e4f91c5ca))
* **artifacts:** retain failed DMG cleanup state and diagnostics ([#1103](https://github.com/morluto/rea/issues/1103)) ([4bb056b](https://github.com/morluto/rea/commit/4bb056bbb5b735e214ed8d725aa3de1c06fb0dc9))
* **browser:** advertise zero-based units for runtime source coordinates ([#1085](https://github.com/morluto/rea/issues/1085)) ([6218d28](https://github.com/morluto/rea/commit/6218d289e241715d0868004caafe15b5c4758450))
* **browser:** bind correlated replies to their selected session ([96d3caf](https://github.com/morluto/rea/commit/96d3cafb0725881b6cdab0e2185104957dc69f71))
* **browser:** bound aggregate source-map decoding before expansion ([f983c71](https://github.com/morluto/rea/commit/f983c718c33789ee40aec43f84315f6b53e95bde))
* **browser:** bound script metadata and preserve omissions ([faf209e](https://github.com/morluto/rea/commit/faf209e50d9faab03a185c1f044de3582552d11e))
* **browser:** bound source-map fetches and retain predecessor requests ([eaf5734](https://github.com/morluto/rea/commit/eaf57340831a753faec58246290f9502d159b6b1))
* **browser:** compose nested source-map column offsets ([#1109](https://github.com/morluto/rea/issues/1109)) ([8b08ec0](https://github.com/morluto/rea/commit/8b08ec0af936405fd20db25f941e2ae6318c5145))
* **browser:** keep initiator callsites out of script coordinate guidance ([#1096](https://github.com/morluto/rea/issues/1096)) ([3c157b4](https://github.com/morluto/rea/commit/3c157b4ec6297e6737bd3c2ec3dc520c7403402f))
* **browser:** normalize selected script manifest roots on Windows ([#1078](https://github.com/morluto/rea/issues/1078)) ([b49beb4](https://github.com/morluto/rea/commit/b49beb42d7a97f73d052a27fb99673b1bd0d3d39))
* **browser:** preserve captures when response bodies are unavailable ([96af2fa](https://github.com/morluto/rea/commit/96af2fa7444a3777d51ff46202ef563146929dbd))
* **browser:** preserve command failures and reject malformed replies ([6b92002](https://github.com/morluto/rea/commit/6b92002597d34555c32ebf24b9db6e4c17c0a08d))
* **browser:** treat module-import initiator positions as script positions ([ae0630a](https://github.com/morluto/rea/commit/ae0630a619ee2c98a68e65ca44bf0b93424e2f8e))
* **browser:** treat module-import initiator positions as script positions ([99d31ee](https://github.com/morluto/rea/commit/99d31ee24ad060babace9eca3325858418e0f55a))
* **browser:** validate and bound source-map evidence ([0a0174b](https://github.com/morluto/rea/commit/0a0174b9ac8a73b61094e857a2950f4e5a06f544))
* **build:** exclude the test-only generated catalog from packages ([#1116](https://github.com/morluto/rea/issues/1116)) ([d1c904b](https://github.com/morluto/rea/commit/d1c904bac7977d44b06bf2f823587baedcc88b9e))
* **build:** make catalogs and packaged skills generated outputs ([#1086](https://github.com/morluto/rea/issues/1086)) ([e613405](https://github.com/morluto/rea/commit/e6134056cf519410160a196363f8a04f0729324e))
* **capture:** retain Electron observations and HAR resource failures ([44fd183](https://github.com/morluto/rea/commit/44fd18305fa5a8893ebb5b952099fdf45dbd6e55))
* **ci:** align diagnostic regressions and format merged changes ([67756da](https://github.com/morluto/rea/commit/67756dacc0d435a61d2d0c403412151769da028f))
* **ci:** restore generated shard inputs and cleanup assertions ([5f93b4b](https://github.com/morluto/rea/commit/5f93b4b125e78f088a2349a178e60f8c0af3e1a2))
* **cli:** accept exact native names through explicit selectors ([c313606](https://github.com/morluto/rea/commit/c3136064c7f8f72b2f6c6799ec41ea6424111bb7))
* **cli:** drive mcp doctor help from a single option schema ([b7d803d](https://github.com/morluto/rea/commit/b7d803dd10c7ef8bb73f81f5e893168af8ea86e6))
* **cli:** preserve blank JSON paths for input validation ([#1068](https://github.com/morluto/rea/issues/1068)) ([3dcb732](https://github.com/morluto/rea/commit/3dcb732da33f6ceef597506b14a4536f1c9aff96))
* **cli:** preserve web cancellation exit status ([1d9b96a](https://github.com/morluto/rea/commit/1d9b96a9c497694592137cf95bea2af0a190abe7))
* **cli:** support MCP doctor help ([a69b833](https://github.com/morluto/rea/commit/a69b8337ab38707aaad2ac2fedb652f05afeb71c))
* **contracts:** preserve local inputs and comparison uncertainty ([70e8a8f](https://github.com/morluto/rea/commit/70e8a8f86060496452ccbc1a49b39822efef4113))
* **docs:** validate translated links to canonical product facts ([34f7c4f](https://github.com/morluto/rea/commit/34f7c4fd661e07db66c560a4d54272b0163a52b6))
* **domain:** order canonical paths by code point, not UTF-16 unit ([#1034](https://github.com/morluto/rea/issues/1034)) ([b5c2954](https://github.com/morluto/rea/commit/b5c2954ad67f0280732df043d5d9702f3d202819))
* **domain:** preserve prototype-named JSON members through Evidence boundaries ([#1049](https://github.com/morluto/rea/issues/1049)) ([40e18b2](https://github.com/morluto/rea/commit/40e18b2e37f2be11f452606c2d875981b03ad03e))
* **domain:** reject excessive JSON depth with actionable diagnostics ([#1029](https://github.com/morluto/rea/issues/1029)) ([bfbfc73](https://github.com/morluto/rea/commit/bfbfc7330aa7175018de04f1d099b8d4aeec3bd1))
* **electron:** bound hook retention and report dropped coverage ([02d0702](https://github.com/morluto/rea/commit/02d07027617a5df014f92a351aa9418aade6f06f))
* **evidence:** name the failed constraint when a bundle is rejected ([82a1a52](https://github.com/morluto/rea/commit/82a1a525d7aa725d939926ba953434fbf5db0ab0))
* **evidence:** name the failed constraint when a bundle is rejected ([cf96ceb](https://github.com/morluto/rea/commit/cf96ceb2119f52f61a621d2a790b7c8804c65595))
* **evidence:** report missing evidence files instead of permission advice ([e8b92a4](https://github.com/morluto/rea/commit/e8b92a40c003a5e6ce3cefe4ad18392d39759653))
* **evidence:** report missing evidence files instead of permission advice ([89252f1](https://github.com/morluto/rea/commit/89252f1f35de91494bd49460b1645d8c09cc6d33))
* **evidence:** require a complete record before the single-record hint ([38bbb65](https://github.com/morluto/rea/commit/38bbb656da2659088e30a1ca3e4434b2f65bab32))
* **firmware:** reject malformed UTF-8 producer reports ([4a45c14](https://github.com/morluto/rea/commit/4a45c14742e6868f687cead2ddf736c3f7c49acd))
* **ghidra:** admit Linux arm64 with matching native tools ([3e598b2](https://github.com/morluto/rea/commit/3e598b2d38a728cd9fd4a359741500a021ba9d3a))
* **ghidra:** harden location resolution and provider lifecycle ([1f5be75](https://github.com/morluto/rea/commit/1f5be750bced759339183945488cea352b18f28b))
* **ghidra:** make qualified function renames idempotent ([4458128](https://github.com/morluto/rea/commit/4458128a845c1448140b44d6e62d6ccfe611d37c))
* **ghidra:** parse long procedure selectors without recursion ([480b16b](https://github.com/morluto/rea/commit/480b16b9c151e1d4bfbca8b49a0668d74ceaa400))
* **ghidra:** preserve function references and snapshot boundaries ([84a17d5](https://github.com/morluto/rea/commit/84a17d55199b1b46493aea6bf4e41029a3b200fc))
* **ghidra:** preserve POSIX runtime paths with spaces ([80c3d36](https://github.com/morluto/rea/commit/80c3d36dfa2597f34fdeb69e0ba75277ee50c85c))
* **ghidra:** preserve source failures and snapshot ownership ([704fa76](https://github.com/morluto/rea/commit/704fa7699ca183d5d5e0518a6fcdbb953ec35a10))
* **ghidra:** preserve Unicode boundaries without breaking sessions ([bef234d](https://github.com/morluto/rea/commit/bef234d6ce63cd296a654400443fcdbbcd44d7de))
* **ghidra:** recover regex stack exhaustion without losing annotations ([bc4aa46](https://github.com/morluto/rea/commit/bc4aa46d7c3960a1f325523e48aed2089b176e84))
* **ghidra:** reject address truncation before reads and edits ([dcae3c6](https://github.com/morluto/rea/commit/dcae3c6c148582d235f5650aace6f9744eeb153c))
* **ghidra:** resolve exact external function entries ([549effa](https://github.com/morluto/rea/commit/549effa056729e5f9239d9ed7864537a9c49e421))
* **hopper:** bind analysis to the active target and correct boundary contracts ([2f71375](https://github.com/morluto/rea/commit/2f71375efc517bb9e6f9800f8e8a6849766bc893))
* **hopper:** bind file mappings to verified source bytes ([82626c4](https://github.com/morluto/rea/commit/82626c4499a53c227187575d40a845fadd5318e2))
* **hopper:** diagnose MCP provider failures with stage, state, and request context ([#1044](https://github.com/morluto/rea/issues/1044)) ([5a67c7f](https://github.com/morluto/rea/commit/5a67c7fc540c494371de76dcdf353923656993d3))
* **hopper:** enforce caller-supplied request deadlines ([#1119](https://github.com/morluto/rea/issues/1119)) ([e8939ca](https://github.com/morluto/rea/commit/e8939ca2208bc41454b73b90a32418714e6a2969))
* **hopper:** isolate regex matching from the native API thread ([f201b04](https://github.com/morluto/rea/commit/f201b04fbbb29591b0d2bb3f3b24636526e4ec4e))
* **hopper:** load verified FAT64 slices with native Mach-O semantics ([0a49d5b](https://github.com/morluto/rea/commit/0a49d5bfb931124d3d398dfbd64e9f6ae8a01405))
* **hopper:** normalize native block endpoints and retain terminal evidence ([2847311](https://github.com/morluto/rea/commit/2847311a579ce2da4c8ded4d89fcdd01545e6da5))
* **hopper:** preserve launcher evidence on readiness timeout ([458771c](https://github.com/morluto/rea/commit/458771cb583e38b848b3d8c58595d163143ff50a))
* **hopper:** preserve native navigation and annotation semantics ([f2e22e1](https://github.com/morluto/rea/commit/f2e22e13a6956985bd65a2d75e4db7e3128cce81))
* **hopper:** preserve owned basic-block endpoint instructions ([#1118](https://github.com/morluto/rea/issues/1118)) ([329cf20](https://github.com/morluto/rea/commit/329cf206d1111c051733c7115cabff4b46722deb))
* **hopper:** preserve partial native call and string evidence ([2461702](https://github.com/morluto/rea/commit/246170238ebb8669a20b57b559b03cfc26ee1b8c))
* **hopper:** preserve typed string values and verify real searches ([7d7b3f9](https://github.com/morluto/rea/commit/7d7b3f961af2dc9b7572e91aaec29e6c4eccf9d5))
* **hopper:** report launcher failures before bridge timeout ([#1105](https://github.com/morluto/rea/issues/1105)) ([cd756b0](https://github.com/morluto/rea/commit/cd756b07d5b9c06e085d778e9f1c4fc9bd403219))
* **hopper:** resolve FAT loaders and original file coordinates ([35f1ddd](https://github.com/morluto/rea/commit/35f1ddd6bc77588b9971961cd70968a815aae266))
* **hopper:** validate annotation destinations and symbol extents ([b2d5bc1](https://github.com/morluto/rea/commit/b2d5bc110914f2ad42d17bc739d5f37c1b0f0a4d))
* **hopper:** verify lease cleanup and repair the macOS test lane ([#1111](https://github.com/morluto/rea/issues/1111)) ([b743bd2](https://github.com/morluto/rea/commit/b743bd20a0cbc39728e2e822fa75c013d87e1730))
* **inspector:** bound retained metadata and preserve cancellation ([e714fb0](https://github.com/morluto/rea/commit/e714fb027afdf11bfbb0838722523d3fa9ebf244))
* **install:** guard empty prefix_args expansion on macOS Bash 3.2 under set -u ([#1061](https://github.com/morluto/rea/issues/1061)) ([68b9fa4](https://github.com/morluto/rea/commit/68b9fa489b0c07f580633785ec61c17fa20b5083))
* **javascript:** bound primitive string growth and repeated evaluation ([4a1837d](https://github.com/morluto/rea/commit/4a1837d9d52b1a6454469e2dc63eeb8d716fb296))
* **javascript:** bound semantic expansion and resolve lexical receivers ([16f4609](https://github.com/morluto/rea/commit/16f4609d689445c05a0befc744fce7e72f7047ec))
* **javascript:** classify direct defaults and argv elements ([6495171](https://github.com/morluto/rea/commit/649517181268a0b729970b7cbbda15e04b199e32))
* **javascript:** honor cancellation before evidence publication ([#1098](https://github.com/morluto/rea/issues/1098)) ([cc0ee2e](https://github.com/morluto/rea/commit/cc0ee2edc60dda42d7b7cfb2c08e39b0b736b5e9))
* **javascript:** omit self-referential import edges with disclosure ([#1130](https://github.com/morluto/rea/issues/1130)) ([1d7115b](https://github.com/morluto/rea/commit/1d7115b7b470719a32e477ca3cbb681f0ad408b8))
* **javascript:** parse plain TypeScript artifact dialects ([#1102](https://github.com/morluto/rea/issues/1102)) ([3db4681](https://github.com/morluto/rea/commit/3db46813f80f84504c5b87c73a4bece82a8fdc5e))
* **javascript:** preserve HTML carriage return source ranges ([#1092](https://github.com/morluto/rea/issues/1092)) ([23862af](https://github.com/morluto/rea/commit/23862af1b57413e09abf394f6e4f8369f6355d5a))
* **javascript:** preserve lexical open and exact template semantics ([d6cc9ca](https://github.com/morluto/rea/commit/d6cc9ca3a6e92604c837f61c193baf5abedaabc8))
* **javascript:** preserve original BOM source coordinates ([#1093](https://github.com/morluto/rea/issues/1093)) ([83defc0](https://github.com/morluto/rea/commit/83defc054b69e94da888d70bb3b05d835e1bf74d))
* **javascript:** retain NodeNext artifact source facts ([#1087](https://github.com/morluto/rea/issues/1087)) ([c1b370c](https://github.com/morluto/rea/commit/c1b370ce0dfcbd5725cf6aebe23b022dfc75ac84))
* **javascript:** use Node legacy package entry fields ([1706005](https://github.com/morluto/rea/commit/170600541bf44f2a63731e8b3d42aae3cbb8d6b3))
* **managed:** bind inspection evidence to artifact identity ([73b09f4](https://github.com/morluto/rea/commit/73b09f4c5c511ce80baa0c89717181bbe0ecba8f))
* **managed:** match exact method bytes without decoded signatures ([17809ca](https://github.com/morluto/rea/commit/17809caacd0f44fcc7c1af42932ea655489d64ae))
* **mcp:** flatten root union input schemas ([#1062](https://github.com/morluto/rea/issues/1062)) ([6a7650e](https://github.com/morluto/rea/commit/6a7650e93cba9169baad95d2c52b11351ae39d0e))
* **mcp:** preserve retained evidence on oversized delivery ([0639a54](https://github.com/morluto/rea/commit/0639a541a3b712940119f59e8189bc962b267726))
* **mcp:** retain complete application results across response limits ([a1ed423](https://github.com/morluto/rea/commit/a1ed4232de635d4acc0dd9eb293e309a29d03e80))
* **mcp:** retain oversized errors before transport delivery ([b3f1b4e](https://github.com/morluto/rea/commit/b3f1b4e822aec5626d1952a88f50c7520dc265d3))
* **metadata:** stop schema changes churning generated skill evidence ([#1075](https://github.com/morluto/rea/issues/1075)) ([d52f66d](https://github.com/morluto/rea/commit/d52f66d62a93ec09cccdf53e64e3ccd24d16e520))
* **native:** bind signature observations to registered target versions ([#1099](https://github.com/morluto/rea/issues/1099)) ([c789af0](https://github.com/morluto/rea/commit/c789af04b76c0e76a522a5dece34f461288f5ecd))
* **native:** bound retained observations and preserve failure evidence ([7c32387](https://github.com/morluto/rea/commit/7c323870c2dcab78654ee7a80128b06affdf2bbe))
* **native:** preserve bridge failure types during cleanup ([1d0baa3](https://github.com/morluto/rea/commit/1d0baa352fc76d1760abbe29a3cc80fa17296916))
* **native:** resample tool identity for each invocation ([14b19a0](https://github.com/morluto/rea/commit/14b19a0b8a5af401212c552173e761eac53bfe46))
* **native:** share command supervision and retain failure output ([f2e9c49](https://github.com/morluto/rea/commit/f2e9c491ea00bf79d5665102d95a3339b63cfe4f))
* **native:** supervise LLDB and preserve bounded capture uncertainty ([915855e](https://github.com/morluto/rea/commit/915855e75ca3fe3b1b54978ace6bbe10d1973f64))
* **process:** avoid cold ownership helper deadline exhaustion ([#1139](https://github.com/morluto/rea/issues/1139)) ([65a809a](https://github.com/morluto/rea/commit/65a809a0da0555aa8eeafbc2ec2559517471be02))
* **process:** derive executable names from the capture host ([#1108](https://github.com/morluto/rea/issues/1108)) ([34cc925](https://github.com/morluto/rea/commit/34cc9259c1076a0d9575a87679befca692ec86c2))
* **process:** identify unknown live processes in cleanup diagnostics ([eb89a16](https://github.com/morluto/rea/commit/eb89a16d9bc51b65dcc75e05f8492de894320753))
* **process:** name the reason two captures cannot be compared ([#1080](https://github.com/morluto/rea/issues/1080)) ([eb69763](https://github.com/morluto/rea/commit/eb69763d27e29fe3247c008925016e4c73cb6abe))
* **process:** preserve observations after successful cleanup ([2af12a1](https://github.com/morluto/rea/commit/2af12a18a36bb80fb7d91ef4c8009212750daa0a))
* **process:** retain ownership after incomplete cleanup ([e2fc249](https://github.com/morluto/rea/commit/e2fc2493b6a59f0663495d277c0cfec1aeb25a7a))
* **process:** stabilize native capture and ownership prerequisites ([2b27515](https://github.com/morluto/rea/commit/2b2751547662f8cb142f96d91eff50388a1ecb31))
* **process:** stop failing captures on tokens macOS cannot expose ([#1057](https://github.com/morluto/rea/issues/1057)) ([5547c1e](https://github.com/morluto/rea/commit/5547c1e697af8c2e1c771abe5344d10b7c1cd340))
* **providers:** validate ELF versions and preserve probe cancellation ([8b01e0c](https://github.com/morluto/rea/commit/8b01e0cc8904b512b517b4471ef2150f40c98f0d))
* **release:** always bump minor for releases ([be783ef](https://github.com/morluto/rea/commit/be783efaba62dc76c5d8d42229869a32afdb302a))
* **release:** publish prereleases under the next npm tag ([bfb7776](https://github.com/morluto/rea/commit/bfb7776006303c6164dba2f22b8e81fdb7c20beb))
* **release:** publish reviewed release PR merges ([cdddfdd](https://github.com/morluto/rea/commit/cdddfddf495ffd172f62a6a801f7697fe502847e))
* **release:** recognize conventional titles in GitHub merge commits ([f5009ed](https://github.com/morluto/rea/commit/f5009ed55f081939409808870458162991f836ca))
* **release:** restore automatic release proposals on main ([acb3e0f](https://github.com/morluto/rea/commit/acb3e0f2e5b38a9c97df7ed78c8e6e5f38bfa08f))
* **release:** validate frozen checkpoint versions and breaking notes ([8a31508](https://github.com/morluto/rea/commit/8a31508c8958800364e255540ded1586298d7008))
* **release:** validate frozen checkpoint versions and breaking notes ([60825fb](https://github.com/morluto/rea/commit/60825fb44751c9482bdf4cafdac3599da7c82d45)), closes [#1063](https://github.com/morluto/rea/issues/1063)
* select Node legacy package entry fields for import and require ([#1035](https://github.com/morluto/rea/issues/1035)) ([1706005](https://github.com/morluto/rea/commit/170600541bf44f2a63731e8b3d42aae3cbb8d6b3))
* **session:** serialize snapshot lifecycle with admitted requests ([e44cb45](https://github.com/morluto/rea/commit/e44cb45908af8d3902e0db044e0cf7b86cdd7ed0))
* **setup:** launch Windows npx registrations through cmd.exe ([#1072](https://github.com/morluto/rea/issues/1072)) ([ef30343](https://github.com/morluto/rea/commit/ef30343154d64d78b620d41c37457eee5d99fc71))
* **setup:** treat empty client config files as new documents ([#1117](https://github.com/morluto/rea/issues/1117)) ([9fd65ce](https://github.com/morluto/rea/commit/9fd65ce0711ce9257aee15e62a5ecf9832960035))
* **snapshot:** retain MCP workflow replay bindings ([5e1afe4](https://github.com/morluto/rea/commit/5e1afe454f2f283eeeea4532d07a9bdbea8bd51e))
* **target:** preserve app bundle filesystem failure reasons ([d4c2c3c](https://github.com/morluto/rea/commit/d4c2c3c18f691d04526fe38867347faa2530861d))
* **update:** accept npm 12 release metadata ([#1138](https://github.com/morluto/rea/issues/1138)) ([567a82f](https://github.com/morluto/rea/commit/567a82f8d4feb629a7c10d2cc9180377eb1f6f66))
* **verify:** close both sides of the browser proxy ([f7366a5](https://github.com/morluto/rea/commit/f7366a517ff0545f01df6202b1ed3231d9dd3b4a))
* **verify:** isolate package archives and published canary caches ([3eb7dbd](https://github.com/morluto/rea/commit/3eb7dbdc1689737b44cc4ff044bcb1a311511969))
* **verify:** remove stale mocked bridge package probe ([826583d](https://github.com/morluto/rea/commit/826583dd43fc918c70a87dfe148c2fdbc8612f3b))
* **verify:** report final success only after resource cleanup ([ee043e2](https://github.com/morluto/rea/commit/ee043e2cbf30152c60b403fff050a0fc848a3286))
* **workflows:** keep caller-input details in workflow input errors ([#1089](https://github.com/morluto/rea/issues/1089)) ([289aef6](https://github.com/morluto/rea/commit/289aef6838e424c14f331a9905020079e6b7539b))
* **workflows:** retain residual unknowns through CLI and MCP ([0136ee8](https://github.com/morluto/rea/commit/0136ee8c22300ed351af5eab6329ab4d271b5bb6))


### Performance Improvements

* **mcp:** advertise each tool JSON Schema once per target ([#1059](https://github.com/morluto/rea/issues/1059)) ([5ccb924](https://github.com/morluto/rea/commit/5ccb9241be15bb6a19b99fbbfb27ff3356ba157b))
* **build:** avoid duplicate documentation generation ([c701376](https://github.com/morluto/rea/commit/c701376777212ec9acfd10c97f45b1eaf0c885c6))
* **javascript:** index configuration and module lookups ([67252b2](https://github.com/morluto/rea/commit/67252b23b9e35e9526fed7842dab47a2c7c9fe5f))
* **javascript:** reuse validated immutable graphs ([#1112](https://github.com/morluto/rea/issues/1112)) ([ec6db0f](https://github.com/morluto/rea/commit/ec6db0f0630c4b0b35f0db84c0030784c1aa58a6))


### Code Refactoring

* **artifacts:** centralize stable inventory identities ([135d102](https://github.com/morluto/rea/commit/135d102f9df844d70d352870afce80f67c0ae96f))
* **browser:** charge source-map records before retention ([e762e32](https://github.com/morluto/rea/commit/e762e32afbba3fd32532fd42a3f4fdcd05252ad3))
* **config:** prune unused format wrappers and launcher export ([81ae838](https://github.com/morluto/rea/commit/81ae8385679ef10b95d34d0f0b5ba11732ac86b5))
* **input:** share schema issue error construction ([65a6288](https://github.com/morluto/rea/commit/65a6288257e4c3cab9adb53b0f9123ef567b61bd))
* **setup:** validate formats through canonical configuration ([4b10665](https://github.com/morluto/rea/commit/4b1066501b379107b2375e270f386fc9855a85c1))


### Documentation

* add Persian README translation with full language navigation ([7a7460f](https://github.com/morluto/rea/commit/7a7460f04f3cfd7e365d70ff891bdd0c474901b6))
* add ten README translations and expand language navigation ([a61491a](https://github.com/morluto/rea/commit/a61491ad00b21e912e16f68bff829927aed6e16f))
* align translated READMEs and website links with English ([d83f098](https://github.com/morluto/rea/commit/d83f0983d5aa18d29d95d24c4ccb3928be6f29f5))
* celebrate 20,000 GitHub stars 🎉 ([#1079](https://github.com/morluto/rea/issues/1079)) ([9455e7c](https://github.com/morluto/rea/commit/9455e7c8bc9d5c4a9a1fc9077aa15007ad80997e))
* check surrounding cases when changing boundaries ([46d195e](https://github.com/morluto/rea/commit/46d195e8a48b710fc355e84cb6b79461b9c39005))
* clarify contribution scope and cosmetic suggestions ([1f79002](https://github.com/morluto/rea/commit/1f7900249783956070af49c10f86002a0dfdc42b))
* clarify evidence ownership and verification guidance ([a9e00b8](https://github.com/morluto/rea/commit/a9e00b83f37651a8dd241375615b248062e04227))
* move Portuguese toward the end of language navigation ([2a4979b](https://github.com/morluto/rea/commit/2a4979b7cdc1a517865573d6c36654c022347d0a))
* move star milestone into history sections across readmes ([6e6ff7b](https://github.com/morluto/rea/commit/6e6ff7bd2eabb668602258ad5e31eb758b31f823))
* require partial native facts at provider boundaries ([2b86ea9](https://github.com/morluto/rea/commit/2b86ea9c7cd3cfc2141a021f8b531dbc84395c81))
* require surrounding boundary checks for review fixes ([9833c94](https://github.com/morluto/rea/commit/9833c94656e1d54e7711dc483bf8091ced14234f))
* **testing:** prioritize real workflows and distinct regressions ([9588482](https://github.com/morluto/rea/commit/9588482bfeeea869d7274d27fb96bac70278dd42))
* **website:** add a CTF showcase and FAQ ([#1077](https://github.com/morluto/rea/issues/1077)) ([a4d77f0](https://github.com/morluto/rea/commit/a4d77f0ff0242b7ab891030d2ffa09a4b4bc1c3c))


### Tests

* **acceptance:** add application workflow MCP parity harness and scenarios ([5ac3dc9](https://github.com/morluto/rea/commit/5ac3dc96f064e691b357aeddc11fa76b7b4d66d1))
* **artifacts:** retire simulated mounts after detach failures ([f591e37](https://github.com/morluto/rea/commit/f591e37a1e45d9b7179ed788c4e7ee77a708c6b0))
* **artifacts:** verify native directory identity on supported Windows runtimes ([#1069](https://github.com/morluto/rea/issues/1069)) ([e94be95](https://github.com/morluto/rea/commit/e94be95c66515fa6fba2a46e4b29850d34141fef))
* **browser:** pin DOM and source-map URL policy classifications ([#1120](https://github.com/morluto/rea/issues/1120)) ([c1d0002](https://github.com/morluto/rea/commit/c1d0002470dc2b6bde73e4ffe438e734dbb24d8d))
* **browser:** reject unmodeled CDP commands in protocol fixtures ([017297c](https://github.com/morluto/rea/commit/017297c40c0c38b9d9c17f5194f0f4c51748f0c3))
* classify application scenarios by their actual boundaries ([0e0b386](https://github.com/morluto/rea/commit/0e0b386dc35bdee1174df9a2d718e0f3e5793666))
* **cli:** verify self-import parity and cleanup ([55c9ce2](https://github.com/morluto/rea/commit/55c9ce26d1b52f359a21512103088048f9aa7492))
* consolidate failure guards and trim unused fixture APIs ([ffd9611](https://github.com/morluto/rea/commit/ffd9611308c91b894a7b0d27f331238f5117dacf))
* **hopper:** cover real boundary failures and CLI parity ([64717ad](https://github.com/morluto/rea/commit/64717ad7daa3152eeb718b4eb5fdcc77f1d76542))
* **hopper:** verify real boundaries and prune redundant happy paths ([7005166](https://github.com/morluto/rea/commit/7005166f5878737fb7b3c7ec4e3d2ee5f4dcce30))
* **mcp:** serialize real process capture and report unavailable authority ([8f9da25](https://github.com/morluto/rea/commit/8f9da251647beb530f6851c9dad5040b19a50a35))
* **process:** cover argv rewrites in native ownership inspection ([09d7b9b](https://github.com/morluto/rea/commit/09d7b9bab53ae968502fd6e19df694cca8cab817))
* **process:** distinguish native startup from producer verification ([9a70fb4](https://github.com/morluto/rea/commit/9a70fb482c974658088167c9d279bd70159e5dc8))
* **process:** expose unavailable capture and unexpected teardown failures ([90b06db](https://github.com/morluto/rea/commit/90b06db6c0b2c5863f292f63a226a5c5678a86ac))
* **process:** report the cause of terminal capture failures ([8a4c4b6](https://github.com/morluto/rea/commit/8a4c4b657fe3b0c249dd2e2147f6960361684c59))
* **process:** retain cancellation checks under unverified host cleanup ([9a5b077](https://github.com/morluto/rea/commit/9a5b0778993102460e333de6cad3ba85383c10be))
* **process:** retire native caches at worker teardown ([a0784c0](https://github.com/morluto/rea/commit/a0784c0d2cb70c48ecfeb0be23c6d68de5ee5be1))
* **process:** serialize real CLI capture boundaries ([82560eb](https://github.com/morluto/rea/commit/82560ebf593a7dfc704698ee312e4d8f1629be8f))
* prune redundant cases and promote configuration lifecycle coverage ([5945915](https://github.com/morluto/rea/commit/5945915f91adf85de91e16b69534bc3ed1d1b69a))
* prune resource-recovery wording assertions ([ae06dcf](https://github.com/morluto/rea/commit/ae06dcf83f65b06abb390d2e0b0ea33543278d6e))
* remove duplicate result assertions before throwing guards ([a1b7d40](https://github.com/morluto/rea/commit/a1b7d40bb0212cdfdddd770a1bccbed097601e0a))
* **session:** preserve live binding after cancelled switches ([1136ea8](https://github.com/morluto/rea/commit/1136ea881029eab59ffb0834149e86a6aff69e3b))
* **setup:** scope removal regression to its fixture client ([fe48e77](https://github.com/morluto/rea/commit/fe48e779c264745d28b5a819e51c06e6b5bd2776))
* **workflows:** verify residual questions in CLI snapshots ([770d2f6](https://github.com/morluto/rea/commit/770d2f60aa948cfdb61c71304be2f3e35f673840))


### Continuous Integration

* run signature target binding regressions on native macOS ([#1107](https://github.com/morluto/rea/issues/1107)) ([1e63144](https://github.com/morluto/rea/commit/1e63144390070f569998271fafd1459788ef3265))

## [6.0.0](https://github.com/morluto/rea/compare/rea-agents-5.0.0...rea-agents-6.0.0) (2026-10-08)


### ⚠ BREAKING CHANGES

* **contracts:** MCP filesystem inputs now require absolute host paths, including target/snapshot paths, evidence bundle paths, managed and firmware inputs, browser/Electron launch paths and expected server paths. Calls such as `open_binary({"path":"./app"})` must send an absolute path such as `/home/analyst/app` or `C:\analysis\app`. Optional paths remain optional. CLI operator-relative paths continue to work. See [#948](https://github.com/morluto/rea/pull/948) and [#1004](https://github.com/morluto/rea/pull/1004).

### Features

* **artifacts:** trace Mach-O dylib resolution in bundles ([78d594c](https://github.com/morluto/rea/commit/78d594cacd376725f833a99402069c103aae9aac))
* **browser:** inspect historical web network captures ([#992](https://github.com/morluto/rea/issues/992)) ([2bf3663](https://github.com/morluto/rea/commit/2bf3663f654386c9fd8c1437c49659df97bd4697))
* **evm:** inspect offline bytecode interfaces through EVMole ([#1051](https://github.com/morluto/rea/issues/1051)) ([7af7bc8](https://github.com/morluto/rea/commit/7af7bc88ce0e8f084eaa0db1e8f834d495440fd9))
* **ghidra:** support native x86 PE applications on Windows ([#1030](https://github.com/morluto/rea/issues/1030)) ([c6dad93](https://github.com/morluto/rea/commit/c6dad932084032bcb32acc61e8066a7784497710))
* **native:** inspect offline ELF layout through pwntools ([#1037](https://github.com/morluto/rea/issues/1037)) ([4fc6565](https://github.com/morluto/rea/commit/4fc6565b0ffb36d7105b3524e08d0c5d603ae07d))
* **native:** inspect recorded crashes through pwntools and pwndbg ([#1054](https://github.com/morluto/rea/issues/1054)) ([163ee09](https://github.com/morluto/rea/commit/163ee09a7425479385e0ed0b5d74043e2587eab2))
* **native:** observe function and Objective-C method calls under LLDB ([1d13cef](https://github.com/morluto/rea/commit/1d13cef5f46f5e07f594bde7b1a4725f189b9a5e))


### Bug Fixes

* **dotnet:** validate managed metadata and CIL boundaries ([#938](https://github.com/morluto/rea/pull/938)) ([bda4ada](https://github.com/morluto/rea/commit/bda4ada7fb6bd7dd70a444bb3c57e34f7f5cc00b))

* **build:** clarify generated-file check hint and drop redundant catalog step ([#998](https://github.com/morluto/rea/pull/998)) ([6f0ef16](https://github.com/morluto/rea/commit/6f0ef160501ea3b24dfa2939dfcd3eea0dc13ee7))

* **release:** extend npm propagation window and improve diagnostics ([#943](https://github.com/morluto/rea/pull/943)) ([06b047a](https://github.com/morluto/rea/commit/06b047a0929369d5b8635b3651da115c8fcd53a7))

* **contracts:** require absolute local paths for session filesystem inputs ([#948](https://github.com/morluto/rea/pull/948)) ([5b172b1](https://github.com/morluto/rea/commit/5b172b1042fc09a4e12d956018f15d86cf397ffe))

* **ci:** generate source catalog before shard tests ([#1002](https://github.com/morluto/rea/pull/1002)) ([eb8f649](https://github.com/morluto/rea/commit/eb8f6491a88bfa79d13f7923e4ef94d791f6ba4d))

* **contracts:** require absolute local paths for remaining caller-supplied file inputs ([#1004](https://github.com/morluto/rea/pull/1004)) ([cbc0dd1](https://github.com/morluto/rea/commit/cbc0dd1e7ca36fa3504a9ea8eae303a0876b176b))

* **cli:** classify ENOTDIR JSON input failures ([#1000](https://github.com/morluto/rea/pull/1000)) ([a6132be](https://github.com/morluto/rea/commit/a6132be0546d6a9e3fa83426c8b59b1280b3e5bd))

* **browser:** preserve authorized redirect hops ([#986](https://github.com/morluto/rea/pull/986)) ([ae0f725](https://github.com/morluto/rea/commit/ae0f725fad368730c6198d49716ccc410bca0536))

* **mcp:** reject unknown MCP tool inputs ([#975](https://github.com/morluto/rea/pull/975)) ([fe64fd6](https://github.com/morluto/rea/commit/fe64fd65d93eff202ad90145544dc9ff84651974))

* **release:** publish from explicit source checkpoints ([#1003](https://github.com/morluto/rea/pull/1003)) ([64c7188](https://github.com/morluto/rea/commit/64c71880ae4f7bc658ffce46eb729c4141dbdf19))

* **release:** publish from explicit source checkpoints ([#1006](https://github.com/morluto/rea/pull/1006)) ([b4fc0ec](https://github.com/morluto/rea/commit/b4fc0ecaa1f6b912dc27880e6b6127ace47abc2e))

* **javascript:** bound semantic node projection for resource safety ([#966](https://github.com/morluto/rea/pull/966)) ([96a46ad](https://github.com/morluto/rea/commit/96a46ada0a36f0349f2b0fc20b4c932401b4ad84))

* **ci:** avoid slow Azure archive for the native cross compiler ([#1016](https://github.com/morluto/rea/issues/1016)) ([51956c1](https://github.com/morluto/rea/commit/51956c1a49a7dc9ed70a6fba480a670a7e7b2b9b))
* **ci:** decouple stdio smoke tests from Linux display probes ([#1014](https://github.com/morluto/rea/issues/1014)) ([93731e1](https://github.com/morluto/rea/commit/93731e17ddea76db86dfa84bb54536dcf8ebfa0b))
* **cli:** stream large JavaScript JSON results ([#1024](https://github.com/morluto/rea/issues/1024)) ([0e25bef](https://github.com/morluto/rea/commit/0e25befe78f220691abe5d0291cc04a75c9cc877))
* **javascript:** complete large-ASAR analysis with file-local projection ([#1055](https://github.com/morluto/rea/issues/1055)) ([b9fb438](https://github.com/morluto/rea/commit/b9fb43883570bef7cb29fd16f27c25d5a7e5bb54))
* **javascript:** recognize digits in artifact URI schemes ([#1045](https://github.com/morluto/rea/issues/1045)) ([03424ae](https://github.com/morluto/rea/commit/03424ae91ef22efd57db1bdde9379a3ac450b8f7))
* **javascript:** reconstruct HTML script loads accurately ([#1042](https://github.com/morluto/rea/issues/1042)) ([1154f2f](https://github.com/morluto/rea/commit/1154f2f03c0b0bb6cb6c5da09b8d8e1c837febc4))
* **javascript:** report application analysis progress on the CLI ([#1008](https://github.com/morluto/rea/issues/1008)) ([7b18c58](https://github.com/morluto/rea/commit/7b18c581409848077de7a9cb6d7d1a0b91a02e12))
* **javascript:** resolve module URLs and reject invalid exports targets ([#1031](https://github.com/morluto/rea/issues/1031)) ([8d5c88f](https://github.com/morluto/rea/commit/8d5c88f17cde4ab4fa54c5142f0a45e612619a53))
* **javascript:** resolve root package exports arrays ([#1046](https://github.com/morluto/rea/issues/1046)) ([53409ab](https://github.com/morluto/rea/commit/53409ab1968d60c77f98feedefe237a08859a95c))
* **mcp:** advertise JSON values without recursive schemas ([#995](https://github.com/morluto/rea/issues/995)) ([7425f70](https://github.com/morluto/rea/commit/7425f70fd0247a7ea7192deb959fd6f48ba83a21)), closes [#919](https://github.com/morluto/rea/issues/919)
* **mcp:** bound capture comparison input schema depth ([#1005](https://github.com/morluto/rea/issues/1005)) ([6b55de0](https://github.com/morluto/rea/commit/6b55de017badc9066642e1ff2561eb1da0ff93f8))
* **process:** preserve partial evidence and verify detached cleanup ([#1011](https://github.com/morluto/rea/issues/1011)) ([63cf28f](https://github.com/morluto/rea/commit/63cf28fd8f8acaf656e993300a2a24280b2fd692))
* **release:** support built-in credentials and refresh release boundary ([6a278a6](https://github.com/morluto/rea/commit/6a278a68dd4fa69b9153697ecb7bba7de4c55c32))
* **release:** support default credentials and record 5.0.0 boundary ([#1012](https://github.com/morluto/rea/issues/1012)) ([6a278a6](https://github.com/morluto/rea/commit/6a278a68dd4fa69b9153697ecb7bba7de4c55c32))
* **release:** sync 5.0.0 checkpoint back to main ([966cca8](https://github.com/morluto/rea/commit/966cca8efe5ed08b3285cd06409688d871eb5e6b))
* **snapshot:** replay validated workflow evidence ([#984](https://github.com/morluto/rea/issues/984)) ([1d62e54](https://github.com/morluto/rea/commit/1d62e54e1f976e64130e4e9b651c3180aa4fa727))
* **windows:** allow Java to read retained target snapshots ([#1027](https://github.com/morluto/rea/issues/1027)) ([28d5c39](https://github.com/morluto/rea/commit/28d5c397c83f901e4086083868041711371ad32a))


### Performance Improvements

* **artifacts:** replace quadratic ZIP overlap checks ([#1013](https://github.com/morluto/rea/issues/1013)) ([76e7e51](https://github.com/morluto/rea/commit/76e7e510bb2d7d37728ca50749d524beb5890cf8))
* **javascript:** cache canonical export comparison sort keys ([#1028](https://github.com/morluto/rea/issues/1028)) ([63ba742](https://github.com/morluto/rea/commit/63ba7424c0ab69b94397e8913f8e231de111583f))


### Code Refactoring

* **build:** generate MCP tool catalog at build time instead of committing it ([#997](https://github.com/morluto/rea/pull/997)) ([35a4e18](https://github.com/morluto/rea/commit/35a4e18d3028014e24d2e209ec99a590fde63152))

* **process:** separate capture implementation from analyst workflows ([#988](https://github.com/morluto/rea/pull/988)) ([6aa9afb](https://github.com/morluto/rea/commit/6aa9afb5493a97801eb1126a0dcf11f9705165db))

* **artifacts:** move inventory and extraction into provider owners ([#1032](https://github.com/morluto/rea/issues/1032)) ([6e4535c](https://github.com/morluto/rea/commit/6e4535c1011f1982e9ab07b7ebcd600c19cd494d))
* remove abandoned test-only analysis scaffolding ([c93422a](https://github.com/morluto/rea/commit/c93422a898fdbedb7d28709144b4337a2669440b))


### Documentation

* improve Korean wording and particles ([#1047](https://github.com/morluto/rea/issues/1047)) ([c5d165b](https://github.com/morluto/rea/commit/c5d165bd03fed95a0b0105661d3ba7e0efbfa449))
* simplify the English README and organize guides ([#1043](https://github.com/morluto/rea/issues/1043)) ([28f10cf](https://github.com/morluto/rea/commit/28f10cf2bc7b7c590700b50d47072015f3e3c66e))


### Tests

* **process:** wait for observable snapshot ctime changes ([#999](https://github.com/morluto/rea/pull/999)) ([161ed91](https://github.com/morluto/rea/commit/161ed9157134d5c3b0fbae19ceb756ac58a26c04))

* **browser:** consolidate CDP workflows and colocate parser coverage ([2682904](https://github.com/morluto/rea/commit/26829045d0f0e744bb60d6babc2dc3312f4bfa53))
* **ci:** stabilize browser source identity fixture delivery ([#1023](https://github.com/morluto/rea/issues/1023)) ([ed725da](https://github.com/morluto/rea/commit/ed725dace4a689e4e5c804dc6bf06c7fc663c7c9))
* **cli:** reduce repeated startup and filesystem setup ([d88d6c1](https://github.com/morluto/rea/commit/d88d6c1897740ccbd6c57f4ba01861fc751fb3a8))
* consolidate service and process fixtures ([f8a53a8](https://github.com/morluto/rea/commit/f8a53a8c065f1ccbdaa051a4e1ef267a2047d759))
* **javascript:** consolidate source analysis and export regressions ([f517a5a](https://github.com/morluto/rea/commit/f517a5a1d7c0766ed50f8dfd5ee69e65525ac744))
* **javascript:** cover plain long-line loader identities ([#1025](https://github.com/morluto/rea/issues/1025)) ([984fc27](https://github.com/morluto/rea/commit/984fc27ce19d57f708bdae688a258cf8663cdea6))
* **mcp:** consolidate SDK schema checks and scenario ports ([9c3479e](https://github.com/morluto/rea/commit/9c3479ed95100d8ee5ed4d9158a4550e4ac2a752))
* **providers:** verify framing through client socket boundaries ([1fd1989](https://github.com/morluto/rea/commit/1fd1989d342375a01b6d14b282ad58001b7d1800))
* prune redundant conformance checks and document test priorities ([aafdf8a](https://github.com/morluto/rea/commit/aafdf8a01b42fb6fd927c0f2a66e758e1a510abc))

## [5.0.0](https://github.com/morluto/rea/compare/rea-agents-4.1.0...rea-agents-5.0.0) (2026-10-07)


### ⚠ BREAKING CHANGES

* **native:** preserve incomplete native UI captures ([#991](https://github.com/morluto/rea/issues/991))
* **android:** Android analysis now requires a full JDK 17 or newer with its compiler module for the packaged Java source bridge.

### Features

* **apple:** project macOS bundle anatomy in application graphs ([88c940b](https://github.com/morluto/rea/commit/88c940b165d788a491e212ea93e00462c4dde6a2))
* **apple:** project macOS bundle anatomy in application graphs ([dd3e7ae](https://github.com/morluto/rea/commit/dd3e7aef0d52c478f6cdf475501c42ebe7f5c97e))
* **application:** wire Android and Apple inventory graph tools ([#852](https://github.com/morluto/rea/issues/852)) ([e0fd820](https://github.com/morluto/rea/commit/e0fd8207a1fb738bcc34f204b55c4fa154f5f02d))
* **browser:** attribute native execution and listener sources ([#917](https://github.com/morluto/rea/issues/917)) ([b5afa5f](https://github.com/morluto/rea/commit/b5afa5f91eed9ae31d670aeab9bbf5112d790ec2))
* **browser:** capture correlated network content and lifecycle evidence ([#797](https://github.com/morluto/rea/issues/797)) ([f9eaf05](https://github.com/morluto/rea/commit/f9eaf056ef58215094513176a70fabae0740081f))
* **browser:** trace captured website module imports ([#879](https://github.com/morluto/rea/issues/879)) ([01be082](https://github.com/morluto/rea/commit/01be082e9e11c78b91828c06a9c543c754783c07))
* **browser:** trace captured website source-map locations ([#897](https://github.com/morluto/rea/issues/897)) ([f430c41](https://github.com/morluto/rea/commit/f430c416c72d444fbe521e0263f8935da4cdb040))
* **javascript:** recover readable modules with Wakaru ([#848](https://github.com/morluto/rea/issues/848)) ([166dcd2](https://github.com/morluto/rea/commit/166dcd21d06f687a9c480a6a6d36beb3b4954dd0))
* **native:** decode chained fixups, binds, ObjC categories and properties ([a657557](https://github.com/morluto/rea/commit/a65755728f7a10d984514c75fa863b84ddcdaee9))
* **native:** decode chained fixups, binds, ObjC categories and properties ([3e24a72](https://github.com/morluto/rea/commit/3e24a72465fe6c628db1f836e93d74d7f4a92b80))
* **native:** open iOS-style and iOS-on-Mac wrapper app bundles ([2ed89e6](https://github.com/morluto/rea/commit/2ed89e6529924248d2e21084f8730bedbb16bc3f))
* **native:** open iOS-style and iOS-on-Mac wrapper app bundles ([aeebba3](https://github.com/morluto/rea/commit/aeebba391ee5c288b75cd828e7d18d32b40aa698))
* **web:** export captured scripts for JavaScript application analysis ([#801](https://github.com/morluto/rea/issues/801)) ([472b72a](https://github.com/morluto/rea/commit/472b72a53068a8e2ec78fe239d687023482daaa7))
* **website:** add a shared back-to-top link ([5047373](https://github.com/morluto/rea/commit/504737300632d8644fbd6c658d2c97e38bb54c3b))
* **website:** introduce REA and the DX-Ball reconstruction ([#906](https://github.com/morluto/rea/issues/906)) ([4e3953c](https://github.com/morluto/rea/commit/4e3953cc45ce9c21786a7a6fc495d2350aa85d24))


### Bug Fixes

* address review nits from batch integration follow-ups ([#818](https://github.com/morluto/rea/issues/818)) ([5a0e0ba](https://github.com/morluto/rea/commit/5a0e0ba3b81ea0ec336addb07da98ec7bc0a35d3))
* **android:** align runtime suffix inference ([#977](https://github.com/morluto/rea/issues/977)) ([fb3749a](https://github.com/morluto/rea/commit/fb3749aff692a7a8225dff00a4516b48a76866b6))
* **android:** bound fragmented JADX MCP frame memory ([#937](https://github.com/morluto/rea/issues/937)) ([9e39795](https://github.com/morluto/rea/commit/9e397958951edb543134e3ad57e7ab253d6df21a))
* **android:** preserve JVM settings and reuse metadata sessions ([#908](https://github.com/morluto/rea/issues/908)) ([eab34a9](https://github.com/morluto/rea/commit/eab34a9d8c5eebad6b04b85750be0276d679c3f9))
* **apple:** attribute only application-root components in macOS inventories ([5524970](https://github.com/morluto/rea/commit/55249704c5c83cbf8d20ac7869863cc196da00a6))
* **apple:** count only real framework version directories ([2e81e86](https://github.com/morluto/rea/commit/2e81e867b24da8314f666f62d154de5803040cdf))
* **apple:** pair bridge hypotheses within one application root ([7acf4e7](https://github.com/morluto/rea/commit/7acf4e741a6a314ea7aabb18fc757e196158ff76))
* **apple:** pair bridge hypotheses within one application root ([9226ade](https://github.com/morluto/rea/commit/9226ade5114f287eb8e1b00b08dd91da1cc66003))
* **apple:** traverse keyed archive hierarchy collections ([#976](https://github.com/morluto/rea/issues/976)) ([71ac83f](https://github.com/morluto/rea/commit/71ac83f3dd376135098f460c86e7897183456ec5))
* **artifacts:** accept APFS image disks ejected with their container ([d93ebec](https://github.com/morluto/rea/commit/d93ebec9df951d40e66ced667f07fadd2dd5d25a))
* **artifacts:** accept APFS image disks ejected with their container ([b72c079](https://github.com/morluto/rea/commit/b72c079a9a90c374bd6dd30ff8c4387306b8f59b))
* **artifacts:** accept the bundle subject when extracting an app bundle ([#891](https://github.com/morluto/rea/issues/891)) ([37d2eba](https://github.com/morluto/rea/commit/37d2ebac4c2a524eec6e32c4c57cbbb632491ad8))
* **artifacts:** decode flat keyed-archive NIBs with data and shared references ([b3f013f](https://github.com/morluto/rea/commit/b3f013fa183e8351319a053575aeee5df337c276))
* **artifacts:** decode flat keyed-archive NIBs with data and shared references ([2a4667b](https://github.com/morluto/rea/commit/2a4667bb79117b202abb009c0bb9ebfdfde57158))
* **artifacts:** harden reader lifecycle boundaries ([#951](https://github.com/morluto/rea/issues/951)) ([2366bda](https://github.com/morluto/rea/commit/2366bda37b1084016d42a0d06920dc57e7c7723f))
* **artifacts:** keep the post-snapshot detach check out of provenance ([62634e4](https://github.com/morluto/rea/commit/62634e4c0177bde8a08decc356da98fbe25d2000))
* **artifacts:** preserve reader failure diagnostics ([#987](https://github.com/morluto/rea/issues/987)) ([fc4a9a0](https://github.com/morluto/rea/commit/fc4a9a05922ce8474fd0717bc800343b0a95bd41))
* **artifacts:** project compiled AppKit actions from the control to its target ([b08228d](https://github.com/morluto/rea/commit/b08228d19f8a0f6dbc940e8d322ef2bb42d2ce1a))
* **artifacts:** project compiled AppKit actions from the control to its target ([#905](https://github.com/morluto/rea/issues/905)) ([900d7c8](https://github.com/morluto/rea/commit/900d7c8606cbc1ccbca818827a55bf2eab28bca4))
* **artifacts:** project UIKit runtime outlet and event connections ([aa8082e](https://github.com/morluto/rea/commit/aa8082ea6c0898feb4d842135aea6b9539f769f8))
* **artifacts:** project UIKit runtime outlet and event connections ([8b24387](https://github.com/morluto/rea/commit/8b243877c22a5550d005e7b8abf93791ce8566b9))
* **artifacts:** read AppKit connectors from flat keyed-archive NIBs ([#900](https://github.com/morluto/rea/issues/900)) ([27c272b](https://github.com/morluto/rea/commit/27c272bd9a42e7235c7991881196c60dbc126714))
* **artifacts:** read keyed archive dictionaries keyed UID as dictionaries ([cfd2b0c](https://github.com/morluto/rea/commit/cfd2b0c75dfb9d51b936788a46d0338145803ece))
* **artifacts:** read keyed archive dictionaries keyed UID as dictionaries ([35c82b9](https://github.com/morluto/rea/commit/35c82b93eb2579687bb446c3a8a2a9f1a7563d28))
* **artifacts:** report which path constraint failed ([#847](https://github.com/morluto/rea/issues/847)) ([3f1a77f](https://github.com/morluto/rea/commit/3f1a77f68ec4355d8b792ccb2970bc03485889c9))
* **browser:** distinguish computed call keys from identifiers ([#808](https://github.com/morluto/rea/issues/808)) ([02beb74](https://github.com/morluto/rea/commit/02beb745358f02bdaabed4bb523c5e3527a9841e))
* **browser:** distinguish WebMCP registration frame owners ([#813](https://github.com/morluto/rea/issues/813)) ([b3b44d8](https://github.com/morluto/rea/commit/b3b44d8a2d8b2aa70a8ed8b9cddf365865fcc53f))
* **browser:** fingerprint cookies at the selected page URL ([#763](https://github.com/morluto/rea/issues/763)) ([78014e3](https://github.com/morluto/rea/commit/78014e3d149f762c848581a0aac7e44f75d51225))
* **browser:** identify NodeNext TypeScript original source artifacts ([#811](https://github.com/morluto/rea/issues/811)) ([e84ad86](https://github.com/morluto/rea/commit/e84ad86a7578fb46568663aca6fe6a6f3986cc8d))
* **browser:** preserve evidence through deep AST analysis ([#924](https://github.com/morluto/rea/issues/924)) ([f826aa8](https://github.com/morluto/rea/commit/f826aa893fa7d55e87d907f0c94c39421a166dd8))
* **browser:** preserve form destinations and satisfies mutation uncertainty ([#825](https://github.com/morluto/rea/issues/825)) ([6dd719e](https://github.com/morluto/rea/commit/6dd719eaf605b37cd5dad6d01d33527ca9d59f06)), closes [#820](https://github.com/morluto/rea/issues/820)
* **browser:** preserve Link header value delimiters ([#805](https://github.com/morluto/rea/issues/805)) ([dd36405](https://github.com/morluto/rea/commit/dd3640548fe3d1e8b92784a63fac55d757dcc1f0))
* **build:** validate installed dependencies before cache hits ([#982](https://github.com/morluto/rea/issues/982)) ([a45fe86](https://github.com/morluto/rea/commit/a45fe86a39b9e7a7c21e3665b6de4763cb72d782))
* capture IndexedDB object-store record fingerprints ([#809](https://github.com/morluto/rea/issues/809)) ([21a8bd0](https://github.com/morluto/rea/commit/21a8bd0ccde2326c8bc022714a88a438d8b89dde))
* **cli:** align structured output guard with native flags ([#777](https://github.com/morluto/rea/issues/777)) ([e9fac56](https://github.com/morluto/rea/commit/e9fac56232e74c8287863ca5c4cc7d8e39fb4a40))
* **cli:** emit empty structured filter projections ([#914](https://github.com/morluto/rea/issues/914)) ([2db668f](https://github.com/morluto/rea/commit/2db668f6ca91d2514a354fd459239b84031812e7))
* **cli:** honor the selected native plist path ([#773](https://github.com/morluto/rea/issues/773)) ([0374865](https://github.com/morluto/rea/commit/0374865836aa4960657fb92f588c71e35dd3bed8))
* **cli:** preserve output and comparison input validation ([#981](https://github.com/morluto/rea/issues/981)) ([d5c43d6](https://github.com/morluto/rea/commit/d5c43d65f0f6a1de8fb2eb5f2c1940a6ea2af20c))
* **cli:** preserve unsupported historical-source imports ([#795](https://github.com/morluto/rea/issues/795)) ([911d580](https://github.com/morluto/rea/commit/911d58063477912042da5e9e573a9e8008956622))
* **contracts:** align CLI/MCP boundary contracts ([#946](https://github.com/morluto/rea/issues/946)) ([4a60738](https://github.com/morluto/rea/commit/4a6073810a955d058c10f209157cbd68832a92c5))
* **deps:** remediate smol-toml advisories ([93091ab](https://github.com/morluto/rea/commit/93091abb4dbd3cceee217d179db816895df24d70))
* **deps:** remediate smol-toml advisories ([c55ae3b](https://github.com/morluto/rea/commit/c55ae3b9eccc17e6e8f4369e13044995d0650704))
* **dotnet:** compare members with undecoded signatures by exact identity ([28fd49f](https://github.com/morluto/rea/commit/28fd49f0f6cf54e373411f5999e6b5722dd826f5))
* **dotnet:** compare members with undecoded signatures by exact identity ([d52af3b](https://github.com/morluto/rea/commit/d52af3b321a321964598fb302edeb26552c9dffd))
* **dotnet:** inspect native boundaries of non-managed and malformed PEs ([d5f28fb](https://github.com/morluto/rea/commit/d5f28fb29c5c3e8acef940fcae042e660e3a4d72))
* **dotnet:** inspect native boundaries of non-managed and malformed PEs ([d98dcfa](https://github.com/morluto/rea/commit/d98dcfa8c2e46a7cc918aeb01058c26c4a84060c))
* **dotnet:** keep a decoded member unknown beside an undecoded counterpart ([76b7020](https://github.com/morluto/rea/commit/76b70203d941ab85c1772f330407fd832d438c9c))
* **dotnet:** keep admitted CLI header facts when metadata is unreadable ([e5ba693](https://github.com/morluto/rea/commit/e5ba6934e4ff819c09077ca70bd2417d37f85bc0))
* **dotnet:** name the shared key in exact-signature ambiguities ([7714e76](https://github.com/morluto/rea/commit/7714e763d9ac2e87994068b3dee37ca6c5ffc6f4))
* **dotnet:** treat ambiguous undecoded members as possible counterparts ([73370e1](https://github.com/morluto/rea/commit/73370e1c064899753988581c9a821e0e7f579561))
* **errors:** report union input issues at the union's path ([bddeb63](https://github.com/morluto/rea/commit/bddeb634b583cf4f7d5fa6cf3a1ee821e05d2923))
* **evaluation:** canonicalize Unicode argument keys ([#980](https://github.com/morluto/rea/issues/980)) ([0a4caf4](https://github.com/morluto/rea/commit/0a4caf4a0a1355b6a121fc88886b22e55843ac76))
* **firmware:** accept the verified Binwalk and Unblob release lines ([#844](https://github.com/morluto/rea/issues/844)) ([bef4321](https://github.com/morluto/rea/commit/bef4321afb3d0d480e8a04ad7e256663542caa3d))
* **firmware:** retain multi-file extraction failures ([#978](https://github.com/morluto/rea/issues/978)) ([8aaf9a1](https://github.com/morluto/rea/commit/8aaf9a19788beb6612332505850ad3407cb00027))
* **ghidra:** admit the 12.1 line and the install's JDK range ([#840](https://github.com/morluto/rea/issues/840)) ([5cbf06c](https://github.com/morluto/rea/commit/5cbf06c7ad0ace599721bffd7da566b8a790b622))
* **ghidra:** select exact packaged bridge scripts ([#800](https://github.com/morluto/rea/issues/800)) ([894c30e](https://github.com/morluto/rea/commit/894c30ef02d946f0c8de3ae6c9168d9525d95033))
* **ida:** share concurrent session cleanup ([#950](https://github.com/morluto/rea/issues/950)) ([f14b6a8](https://github.com/morluto/rea/commit/f14b6a84306116716e78c5ffc84353ac07939593))
* **installer:** validate exact semantic versions ([#954](https://github.com/morluto/rea/issues/954)) ([248972f](https://github.com/morluto/rea/commit/248972f327776687037dc07099117584c0674e77))
* integrate 24 reviewed browser/native/semantics corrections ([#815](https://github.com/morluto/rea/issues/815)) ([3af3811](https://github.com/morluto/rea/commit/3af3811ab0a212b6aab6185628d47ecad37958fc))
* **javascript:** advertise the exact empty seed rule and match empty API keys ([35e5508](https://github.com/morluto/rea/commit/35e5508fd095a062d7477bd6bb7d2d8e28201cd8))
* **javascript:** analyze source maps with empty source names ([58ef8ac](https://github.com/morluto/rea/commit/58ef8ac3aa803d7b64dd12a5b2a2e8ec24261060))
* **javascript:** analyze sources containing empty string literals ([e7cbfe0](https://github.com/morluto/rea/commit/e7cbfe04fdfd7affe50dba9e2c7a9a0a72291041))
* **javascript:** analyze sources containing empty string literals ([11fc3b9](https://github.com/morluto/rea/commit/11fc3b981509e8107b10b2e75363f5bb489879db))
* **javascript:** filter keyed-collection receivers only for get/delete ([00f707b](https://github.com/morluto/rea/commit/00f707b250451246d69a1205c39c6843fab6bb5b))
* **javascript:** handle deep AST traversal and addition without stack overflow ([#915](https://github.com/morluto/rea/issues/915)) ([62b3711](https://github.com/morluto/rea/commit/62b37111e7f09887eb712c6e8e721e0334cf10b9))
* **javascript:** handle deep static member paths ([#939](https://github.com/morluto/rea/issues/939)) ([348c65c](https://github.com/morluto/rea/commit/348c65c7ece1aee280f9431d995996b444e7549d))
* **javascript:** keep bare relative URLs for computed-method XHR ([e32028d](https://github.com/morluto/rea/commit/e32028d1b566872ba8cd08fc6800c198d6aef30b))
* **javascript:** keep computed-method XHR request URLs ([602d002](https://github.com/morluto/rea/commit/602d0021d45a6cdab9f806554f3ee12ea670ec97))
* **javascript:** keep exact empty env keys and method names ([522c2d0](https://github.com/morluto/rea/commit/522c2d0ecb1eb7be262eaef2926cceac9a68badc))
* **javascript:** keep exact empty env keys and method names ([f7954a8](https://github.com/morluto/rea/commit/f7954a8fd692f262ef3ce1507b957681150ce9c4)), closes [#783](https://github.com/morluto/rea/issues/783)
* **javascript:** keep exact empty require paths and request fields ([ad1f6b5](https://github.com/morluto/rea/commit/ad1f6b508fbdd44d8bf1884ed96ae69082808e7d)), closes [#783](https://github.com/morluto/rea/issues/783)
* **javascript:** keep exact empty values in graph identities ([f608127](https://github.com/morluto/rea/commit/f608127635ed8e0d105ad95252e5ea0dff899f5b))
* **javascript:** keep exact empty values in graph identities ([63012ee](https://github.com/morluto/rea/commit/63012eeb601fc74ca82f3a027d852a5da1b099d2))
* **javascript:** keep keyed-collection reads out of endpoints ([9075ce7](https://github.com/morluto/rea/commit/9075ce71ada4334407aa2d194dc82e3031e30260))
* **javascript:** keep keyed-collection reads out of endpoints ([eb68761](https://github.com/morluto/rea/commit/eb68761eb0a35b876e33dd6115d0d07f97e99dd5))
* **javascript:** keep literal HTTP methods on storage-named receivers ([9f48a76](https://github.com/morluto/rea/commit/9f48a76e1186cc43c6928eff1c82e93280caee1a))
* **javascript:** keep literal-method and URL-literal requests on aliased receivers ([e3e7664](https://github.com/morluto/rea/commit/e3e76646657e950e24241ba715eb97ea385933e9))
* **javascript:** keep mutated object initializer values unknown ([#752](https://github.com/morluto/rea/issues/752)) ([6caa38a](https://github.com/morluto/rea/commit/6caa38a0cad369ddff52b08f8d7d44c1b92ecac0))
* **javascript:** keep storage open versions out of XHR endpoints ([4f51103](https://github.com/morluto/rea/commit/4f5110306d9edab94bf63bf81cf259324d96af57))
* **javascript:** keep storage open versions out of XHR endpoints ([898b0f6](https://github.com/morluto/rea/commit/898b0f62d76ea1cf793140cb255cad16ab85b44d))
* **javascript:** keep XHR and client endpoints that receiver spellings hid ([05f43ed](https://github.com/morluto/rea/commit/05f43ed388ae4e9316d320b592b6eba5b119ce89))
* **javascript:** leave empty application values unlabeled ([527b76e](https://github.com/morluto/rea/commit/527b76ef78e84d29bb41bd45f1f83fae05ca66ca))
* **javascript:** match exact empty literal channels and seeds ([e20da1f](https://github.com/morluto/rea/commit/e20da1f205b105b1b6a5decd3c2d0fe36fd12410))
* **javascript:** never read window or document open as XHR ([ae849a7](https://github.com/morluto/rea/commit/ae849a72811857ba9755962ec48a1d76c9d1181a))
* **javascript:** preserve computed Electron member uncertainty ([3a4a63f](https://github.com/morluto/rea/commit/3a4a63f70a2e42fb1fa48881e08b08d612289f2e))
* **javascript:** preserve computed Electron member uncertainty ([1260cac](https://github.com/morluto/rea/commit/1260cacc67b8e0c93fb9434452053feca956e7e7))
* **javascript:** project decoded file URL paths ([#810](https://github.com/morluto/rea/issues/810)) ([2572e1e](https://github.com/morluto/rea/commit/2572e1eb2f853a4cebfc8303d9e293e1d106d608))
* **javascript:** read open() endpoints only from XHR method/URL pairs ([63e0822](https://github.com/morluto/rea/commit/63e0822cc794bd6ec1688340b3230ffb6b5c4a8c))
* **javascript:** read open() endpoints only from XHR method/URL pairs ([1be3705](https://github.com/morluto/rea/commit/1be370543f7ea39016f86ebdec80a8ceaf7f8a28))
* **javascript:** read substitution-free templates as exact strings ([c371d6e](https://github.com/morluto/rea/commit/c371d6e1e9cceb28e6cfc874e14c4e740bb87751))
* **javascript:** read substitution-free templates as exact strings ([77cf757](https://github.com/morluto/rea/commit/77cf75710369acc6c304ec352ab25aa7274e04b1))
* **javascript:** resolve bare source-map and worker URLs next to the script ([#890](https://github.com/morluto/rea/issues/890)) ([45fcd28](https://github.com/morluto/rea/commit/45fcd28b4018723bdb508a9229b74ab9eb749f75))
* **javascript:** retain recovered call argument positions ([#929](https://github.com/morluto/rea/issues/929)) ([e6ba9c3](https://github.com/morluto/rea/commit/e6ba9c3af3053485f154825eea6a156127328be9))
* **linux:** improve Hopper reliability and CachyOS support ([#963](https://github.com/morluto/rea/issues/963)) ([98b2b02](https://github.com/morluto/rea/commit/98b2b027afd8c80b68e9daaf97bdaa4d942105cc))
* **mcp:** advertise reserved process environment key ([#949](https://github.com/morluto/rea/issues/949)) ([e0d76ae](https://github.com/morluto/rea/commit/e0d76ae80ddc70ae4d5afcbd1427afb81eee3669))
* **mcp:** isolate optional observation adapter failures ([#838](https://github.com/morluto/rea/issues/838)) ([be3cfbf](https://github.com/morluto/rea/commit/be3cfbffdfbbb65da75dcec0518e2ebf387e66bc))
* **mcp:** preserve exact guided prompt context ([#761](https://github.com/morluto/rea/issues/761)) ([66c26f2](https://github.com/morluto/rea/commit/66c26f280b1d494806ee182b52564166760f0ae2))
* **native-ui:** handle incomplete accessibility child collections ([#944](https://github.com/morluto/rea/issues/944)) ([ac3bae3](https://github.com/morluto/rea/commit/ac3bae3cb97c4fb622eb1b6ac1f3b84e6a70ba03))
* **native:** inspect plists containing data, dates, and non-finite reals ([bc2cd8b](https://github.com/morluto/rea/commit/bc2cd8b874e115eee446860043758a80bd583ad0))
* **native:** inspect plists containing data, dates, and non-finite reals ([5ead2cf](https://github.com/morluto/rea/commit/5ead2cfbc47896b43502363d3568330f5d94762e))
* **native:** keep echoed codesign paths out of signature fields ([#865](https://github.com/morluto/rea/issues/865)) ([4aa2b60](https://github.com/morluto/rea/commit/4aa2b60c1d84607a138395ae93260b2e50c2a721))
* **native:** keep echoed Mach-O paths out of load commands and symbols ([ab985c6](https://github.com/morluto/rea/commit/ab985c6a10e9da856ed151100cee8459793c3573))
* **native:** keep echoed Mach-O paths out of load commands and symbols ([37fe105](https://github.com/morluto/rea/commit/37fe105ba168488d05226f2912bed802e2d48d75))
* **native:** keep integral plist reals beyond the JSON range as reals ([#860](https://github.com/morluto/rea/issues/860)) ([3b92a2b](https://github.com/morluto/rea/commit/3b92a2bceddaa1659654da08160813a3affbc6b7))
* **native:** keep plist XML element types for large numbers ([f85056d](https://github.com/morluto/rea/commit/f85056d83e42a461c8c947792774580294d0ceb9))
* **native:** keep the resolved bundle plist and permission failures ([418a556](https://github.com/morluto/rea/commit/418a5562f6f640503c751924a4787586c2c5c98a))
* **native:** pass Swift symbols to swift-demangle as operands ([dd90965](https://github.com/morluto/rea/commit/dd90965058a9e6f7dd7f30eb7e462572e777db7f))
* **native:** pass Swift symbols to swift-demangle as operands ([6c88094](https://github.com/morluto/rea/commit/6c88094da45258b346fe594764e561f999622a58))
* **native:** preserve incomplete native UI captures ([#991](https://github.com/morluto/rea/issues/991)) ([9f496ef](https://github.com/morluto/rea/commit/9f496ef2d4a3aa68816287bf5d2ba1620d72c97a))
* **native:** report exact plist integers beyond the JSON number range ([c9f49db](https://github.com/morluto/rea/commit/c9f49db907db0513ad8b22c9b2bbdcee400aff11))
* **native:** report exact plist integers beyond the JSON number range ([430c297](https://github.com/morluto/rea/commit/430c297ca4ddb3491c2b835b889486e6a2ffdc17))
* **native:** report plist permission denials as access failures ([5738a0c](https://github.com/morluto/rea/commit/5738a0cf8c111833847fecb2f7d0c2ee35eabbd6))
* **native:** report why a selected plist cannot be inspected ([14f9b3d](https://github.com/morluto/rea/commit/14f9b3d93119a60a3cf5f3d9c138ca829a5462e8))
* **native:** report why a selected plist cannot be inspected ([0674fac](https://github.com/morluto/rea/commit/0674facd468c3321584ece908031feee7220b9c6))
* **plist:** keep character references beyond Unicode literal ([5afd8a8](https://github.com/morluto/rea/commit/5afd8a850b2ebd62e3400a5e2ece1a1cfa98bab6))
* **plist:** read XML plists containing a __proto__ key ([faaee69](https://github.com/morluto/rea/commit/faaee693d5bb4bb957387ebd0f4338513c4c914a))
* **plist:** read XML plists containing a __proto__ key ([a08be51](https://github.com/morluto/rea/commit/a08be51e9f0d23bd46b66bbdb88dbda44bc54c88))
* **plist:** report omitted __proto__ entries in signatures and Interface Builder ([15ab5db](https://github.com/morluto/rea/commit/15ab5dbcaf3fac09756e98926373965247dad622))
* **plist:** report omitted __proto__ entries in signatures and Interface Builder ([6729ee7](https://github.com/morluto/rea/commit/6729ee7636889a0a2ebc9fca8e35860476f8ca34))
* preserve native UI failure reasons and dedupe version literals ([#854](https://github.com/morluto/rea/issues/854)) ([2d4a910](https://github.com/morluto/rea/commit/2d4a910fcd30e8d5b96fcb957b931e9aa3e4ab0c))
* **process:** clarify Windows capture support and recovery ([#798](https://github.com/morluto/rea/issues/798)) ([50787b2](https://github.com/morluto/rea/commit/50787b2faf1a4bea799d041960ca2b91199ef403))
* **process:** harden filesystem snapshot identity and cancellation ([#956](https://github.com/morluto/rea/issues/956)) ([93aa9eb](https://github.com/morluto/rea/commit/93aa9eb5c2551984182a4025d836e4223e8ecc8a))
* **process:** retain provider output until streams close ([#928](https://github.com/morluto/rea/issues/928)) ([b929251](https://github.com/morluto/rea/commit/b9292516f4eedc2dedba713abf57f665ef1fb596))
* **reference:** retain partial imports for unreadable directories ([#766](https://github.com/morluto/rea/issues/766)) ([cffc548](https://github.com/morluto/rea/commit/cffc548cd3127c5db811f20db4816039846b3170))
* **release:** drive checkpoint releases from frozen branches ([fc58fa1](https://github.com/morluto/rea/commit/fc58fa1eb01fe5a8200a78e9551799c9c1a3d256))
* **release:** publish from explicit source checkpoints ([49887f0](https://github.com/morluto/rea/commit/49887f0239da4483153a5e1610058619855525db))
* **semantics:** isolate named function expression bindings ([#776](https://github.com/morluto/rea/issues/776)) ([ae81f64](https://github.com/morluto/rea/commit/ae81f64d2ad10e5cdbf8356819351c02480aee7a))
* **semantics:** preserve direct promise ownership boundaries ([#758](https://github.com/morluto/rea/issues/758)) ([e1ca412](https://github.com/morluto/rea/commit/e1ca412757bb01be855a66bf72006e3becd497b6))
* **semantics:** preserve empty string property keys ([#764](https://github.com/morluto/rea/issues/764)) ([630bdaf](https://github.com/morluto/rea/commit/630bdafcacc621105f6a43ed68a6e51651aca629))
* **semantics:** recognize Node builtin default namespaces ([#769](https://github.com/morluto/rea/issues/769)) ([24a0bf9](https://github.com/morluto/rea/commit/24a0bf9a618604e2fa30817d673ce911c7842819))
* **semantics:** retain trailing rest argument flows ([#756](https://github.com/morluto/rea/issues/756)) ([4bfd803](https://github.com/morluto/rea/commit/4bfd8038be0a60c43a452bec15e23799a0b040c0))
* **setup:** accept the pinned Hopper RPM launcher ([#933](https://github.com/morluto/rea/issues/933)) ([dda8e6a](https://github.com/morluto/rea/commit/dda8e6a72890f87bdf8bbd3250b68b6648aae553))
* **setup:** read an OpenCode V2 server named type as a table entry ([#866](https://github.com/morluto/rea/issues/866)) ([4e17be5](https://github.com/morluto/rea/commit/4e17be57053fb0ce2561d92e05b6e38ef789b2d4))
* **setup:** register OpenCode V2 configurations in mcp.servers ([957069d](https://github.com/morluto/rea/commit/957069d14d832ddeac3f90dd141d379b81e2832a))
* **setup:** register OpenCode V2 configurations in mcp.servers ([69d8afe](https://github.com/morluto/rea/commit/69d8afefc19e014a4bba7a182983a9e77e100a75))
* **target:** decode app Info.plist executables with an XML parser ([c57f1b7](https://github.com/morluto/rea/commit/c57f1b74e0af5cf5fbb459cb247e1448cbf8df1b))
* **target:** decode app Info.plist executables with an XML parser ([c182f72](https://github.com/morluto/rea/commit/c182f72ad3d9eea10b084a43527acb7c8ca2d6bf))
* **test:** disconnect Hopper fixture IPC on SIGTERM ([b912b11](https://github.com/morluto/rea/commit/b912b117f019d5d3e4b4e3ef683e9b25f3a709bc))
* **windows:** accept ordinary drive path separators ([#791](https://github.com/morluto/rea/issues/791)) ([b62931f](https://github.com/morluto/rea/commit/b62931f8335f58bfe344883a4f149e9eef73d835))
* **windows:** remove cancelled snapshot outputs ([#957](https://github.com/morluto/rea/issues/957)) ([d76f7d1](https://github.com/morluto/rea/commit/d76f7d150895289aa1fb85a057b81ca7ff102df4))


### Performance Improvements

* **artifacts:** stream ASAR members without full buffering ([#962](https://github.com/morluto/rea/issues/962)) ([abd7a5e](https://github.com/morluto/rea/commit/abd7a5ed091061e4b1e83e5933e9009fb5b8d577))
* **call-path:** prune dead ends and enumerate without recursion ([#909](https://github.com/morluto/rea/issues/909)) ([e52fe97](https://github.com/morluto/rea/commit/e52fe9719fec03f2aa79b1a1b9e11b38c229903c))
* **cli:** defer catalog digests and use canonical cache scope ([9a15525](https://github.com/morluto/rea/commit/9a1552529889e9f5b52a88739eb767b92e57e24e))
* **cli:** defer unused catalog work during command startup ([#920](https://github.com/morluto/rea/issues/920)) ([9a15525](https://github.com/morluto/rea/commit/9a1552529889e9f5b52a88739eb767b92e57e24e))
* **comparison:** reuse canonical sort keys ([#990](https://github.com/morluto/rea/issues/990)) ([ebb065e](https://github.com/morluto/rea/commit/ebb065e2dc15f5763276f401521896f66bae6339))
* **dotnet:** index declaring-type ranges once per metadata table ([#918](https://github.com/morluto/rea/issues/918)) ([7a9f587](https://github.com/morluto/rea/commit/7a9f587c3a9998d828b83388438976527ca7074f))
* **dotnet:** index ordered declaring-type ranges once per table ([7a9f587](https://github.com/morluto/rea/commit/7a9f587c3a9998d828b83388438976527ca7074f))
* **evidence:** scale imports and dependency graphs ([#941](https://github.com/morluto/rea/issues/941)) ([7dc40d3](https://github.com/morluto/rea/commit/7dc40d3d9e00caf013109942a5d9a1d7fdf9ec62))
* **inspector:** bound runtime script location authorization ([#945](https://github.com/morluto/rea/issues/945)) ([58381ee](https://github.com/morluto/rea/commit/58381eefa24f73580e31eaa09dc14b9c04d78d6c))
* **javascript:** analyze member chains without recursive copying ([#932](https://github.com/morluto/rea/issues/932)) ([dcde958](https://github.com/morluto/rea/commit/dcde9584508830a5d99ac5e2032f539563c69002))
* **javascript:** index Promise return-site ownership ([#971](https://github.com/morluto/rea/issues/971)) ([2cedde9](https://github.com/morluto/rea/commit/2cedde9f1cf72b04bef37f9f004bb68d5ff6502a))
* **javascript:** index semantic fingerprint relations ([#942](https://github.com/morluto/rea/issues/942)) ([c92a344](https://github.com/morluto/rea/commit/c92a344d4770125d85a11f3fc7a23d800bd30003))
* **javascript:** reduce analysis and source-map work ([#955](https://github.com/morluto/rea/issues/955)) ([c7530f9](https://github.com/morluto/rea/commit/c7530f9a816d84354516d3ea137f4a0d91d3b8b3))
* **providers:** assemble fragmented responses once per line ([#911](https://github.com/morluto/rea/issues/911)) ([df7151b](https://github.com/morluto/rea/commit/df7151ba305eab3a33a9261a023705b29862b308))
* **reconstruction:** index coverage evaluation ([#983](https://github.com/morluto/rea/issues/983)) ([f26c8b5](https://github.com/morluto/rea/commit/f26c8b5b8cff10b93173359b5453874d659f2440))
* **setup:** reuse initial diagnostics during planning ([#940](https://github.com/morluto/rea/issues/940)) ([118d43e](https://github.com/morluto/rea/commit/118d43e787e38857714852cc846b1b604a61950d))


### Code Refactoring

* add incremental capability migration safeguards ([#819](https://github.com/morluto/rea/issues/819)) ([75f50d8](https://github.com/morluto/rea/commit/75f50d86f6d504f4dd97a707871d39ec022b3047))
* **android:** group layered source and verification ([#873](https://github.com/morluto/rea/issues/873)) ([8e8921d](https://github.com/morluto/rea/commit/8e8921d40c63b40ab7e1598f672063dd304d93f0))
* **apple:** group artifact producers and verification ([#952](https://github.com/morluto/rea/issues/952)) ([ef1a0cc](https://github.com/morluto/rea/commit/ef1a0cc65af7918ef7204a39f42a4299b486c453))
* **artifacts:** isolate JavaScript file acquisition ([#916](https://github.com/morluto/rea/issues/916)) ([f0a68dc](https://github.com/morluto/rea/commit/f0a68dce60e81b4d2f420bf774b61957a37326ac))
* **binary:** group session selection and snapshot ownership ([#886](https://github.com/morluto/rea/issues/886)) ([dd114d3](https://github.com/morluto/rea/commit/dd114d39801973e958a582c8fcba7ccce0e50299))
* **binary:** move production composition outside application workflows ([#965](https://github.com/morluto/rea/issues/965)) ([33d4761](https://github.com/morluto/rea/commit/33d4761cc7a96630b7c2fed890df83d433c45914))
* **browser:** align inspector exclusions with canonical vocabulary ([#834](https://github.com/morluto/rea/issues/834)) ([de9593a](https://github.com/morluto/rea/commit/de9593ad48c0b97507f18949b7ad86ad9c743ebc))
* **cli:** split core analysis command registrar ([#858](https://github.com/morluto/rea/issues/858)) ([8b9940a](https://github.com/morluto/rea/commit/8b9940a7b5d3fcd5a8eda6d397f0ab7c3aaf2ac9))
* colocate investigation record implementation ([#867](https://github.com/morluto/rea/issues/867)) ([bb19c94](https://github.com/morluto/rea/commit/bb19c9477ef3eefd9c5b2e6cabe78cc94e6779ae))
* compose investigation record ownership ([#845](https://github.com/morluto/rea/issues/845)) ([ce73c3f](https://github.com/morluto/rea/commit/ce73c3fed2e5fd20ae0113579345a69763eb7655))
* declare auxiliary capabilities from source ([#853](https://github.com/morluto/rea/issues/853)) ([4a6c17c](https://github.com/morluto/rea/commit/4a6c17ce83dfd20412f0e168525314a20c61169e))
* **domain:** consolidate property-key extraction behind semanticStaticPropertyKey ([#823](https://github.com/morluto/rea/issues/823)) ([764ff05](https://github.com/morluto/rea/commit/764ff05231f1a666dfa655492da42b4b6ba742c3))
* **domain:** converge comparison mechanics on shared vocabulary ([#824](https://github.com/morluto/rea/issues/824)) ([c13c9d4](https://github.com/morluto/rea/commit/c13c9d41f8441a711266adee21429fb7433a6aa1))
* **domain:** extract artifact path syntax helpers ([#830](https://github.com/morluto/rea/issues/830)) ([ef535b8](https://github.com/morluto/rea/commit/ef535b81fefc358b0bdb655e5aa057fc3949ce5f))
* **domain:** extract source-map envelope walk and disambiguate stringValue ([#828](https://github.com/morluto/rea/issues/828)) ([64ebdf4](https://github.com/morluto/rea/commit/64ebdf45016bda679674cbd2287576eadf66a1fc))
* **domain:** map validation taxonomies and add inventory Result seam ([#833](https://github.com/morluto/rea/issues/833)) ([78f4848](https://github.com/morluto/rea/commit/78f4848d70ce462426e9f221d6e7b3e34219bf46))
* **domain:** split Interface Builder keyed-archive parse from graph builder ([#859](https://github.com/morluto/rea/issues/859)) ([da09706](https://github.com/morluto/rea/commit/da0970672da725dbb095ffcaefad07303ae85aab))
* **firmware:** group layered source and verification ([#878](https://github.com/morluto/rea/issues/878)) ([507e8b3](https://github.com/morluto/rea/commit/507e8b3c7be75f8de69be214618394aca3585404))
* **ghidra:** extract createClient and load-image attestation ([#856](https://github.com/morluto/rea/issues/856)) ([b7df5b7](https://github.com/morluto/rea/commit/b7df5b78052539e57967db8e6562befd70c6ebdc))
* give Inspector its own capability directory ([#869](https://github.com/morluto/rea/issues/869)) ([021ba69](https://github.com/morluto/rea/commit/021ba690b07eab4b990be47f90946db9f70e0fc0))
* **javascript:** group application workflows and verification ([#896](https://github.com/morluto/rea/issues/896)) ([0804722](https://github.com/morluto/rea/commit/0804722cdf721a8d767d02f9342ebdf8d186f7e1))
* **javascript:** group domain semantics and contracts ([#907](https://github.com/morluto/rea/issues/907)) ([f6a58f1](https://github.com/morluto/rea/commit/f6a58f10629614fb7a6970421218b73d41bce6a5))
* **managed:** group capability workflows and verification ([#926](https://github.com/morluto/rea/issues/926)) ([28713f9](https://github.com/morluto/rea/commit/28713f9b4dcb882f0e811653890fde70cb5fdadb))
* **native:** group analyst semantics workflows and contracts ([#973](https://github.com/morluto/rea/issues/973)) ([ea4db4c](https://github.com/morluto/rea/commit/ea4db4c9f7cbc10dc701c4d5770109c08952a5b8))
* **native:** split Apple dispatch metadata decode facets ([#855](https://github.com/morluto/rea/issues/855)) ([676959e](https://github.com/morluto/rea/commit/676959ecb55b606a567af3d2eb3d3edc96f0aa2f))
* **provider:** declare deep capabilities from source ([#892](https://github.com/morluto/rea/issues/892)) ([b808e2d](https://github.com/morluto/rea/commit/b808e2d6bbbae38c1ff2e293e1cf77464d889bdd))
* share Android and firmware provider factories ([#826](https://github.com/morluto/rea/issues/826)) ([3ed59b2](https://github.com/morluto/rea/commit/3ed59b281247f2180b3c79e658078507e4cc1be2))


### Documentation

* add concise lawful-use disclaimer ([#888](https://github.com/morluto/rea/issues/888)) ([4037c65](https://github.com/morluto/rea/commit/4037c6545dc8cc47f4602d8f06e5329ed641cdbb))
* add DX-Ball reconstruction showcase ([#876](https://github.com/morluto/rea/issues/876)) ([895079d](https://github.com/morluto/rea/commit/895079dd093f02487789d9aa967f0cccbfe379d8))
* add prominent website and showcase links to READMEs ([2ccc86c](https://github.com/morluto/rea/commit/2ccc86cd13d71f08b553d3b9962175144b882539))
* add README star history chart ([#850](https://github.com/morluto/rea/issues/850)) ([11f27de](https://github.com/morluto/rea/commit/11f27deddf88703368942d3ddfc239a7ebe72e3e))
* add website and showcase links to READMEs ([#930](https://github.com/morluto/rea/issues/930)) ([2ccc86c](https://github.com/morluto/rea/commit/2ccc86cd13d71f08b553d3b9962175144b882539))
* **apple:** describe directory-based framework plist ambiguity ([6d74992](https://github.com/morluto/rea/commit/6d74992efed3271e8370c505afdde347609f8353))
* audit and improve localized readmes translations and wording ([00a6ac3](https://github.com/morluto/rea/commit/00a6ac3de99f432bd6dbb88148a2aab5f8d3d338))
* clarify NativeAOT scope and regenerate conformance ledger ([c945931](https://github.com/morluto/rea/commit/c945931961cbd488163c6d92ef91336ed506942e))
* fix stale IDA roadmap item, mermaid paths, toolchain wording ([d2aed17](https://github.com/morluto/rea/commit/d2aed172ab79d98ff4e62c14d8f34cc49c1d17b4))
* move quick start up and mark skill install optional ([554e9b1](https://github.com/morluto/rea/commit/554e9b1612f7799c2bc7177eb1a9b04a0f27d2e9))
* note Cloud Agent Node.js toolchain ([#837](https://github.com/morluto/rea/issues/837)) ([6aa6350](https://github.com/morluto/rea/commit/6aa6350c800796d0953937e894ff176ae248e930))
* publish VitePress documentation on GitHub Pages ([c78fe69](https://github.com/morluto/rea/commit/c78fe6990bcface6853ac5c11c90df6bc0df562d))
* separate ambiguous and unavailable provider recovery ([c3f2b8e](https://github.com/morluto/rea/commit/c3f2b8e7742915dc27ab7c801a8a1a9127169896))
* show task-scoped readiness and provider preference in the quick start ([880cca1](https://github.com/morluto/rea/commit/880cca1bca497bb53c97a821b470df0f2235e043))
* show task-scoped readiness and provider preference in the quick start ([5fd0db3](https://github.com/morluto/rea/commit/5fd0db37d94f1c1a0495920c79e121d799da0d30)), closes [#726](https://github.com/morluto/rea/issues/726)
* update release boundary to npm 4.1.0 with Windows native bundle ([69be514](https://github.com/morluto/rea/commit/69be514c67c8b2eb8b450355a9782d9237748fda))
* **website:** add Notion case study and improve onboarding ([a6ba772](https://github.com/morluto/rea/commit/a6ba772c08e2648e6602787a0ea537d75d72802d))
* **website:** add TH04 bullet-ring case study ([f8d84da](https://github.com/morluto/rea/commit/f8d84da127fad871050c098b004a503b36795ad0))
* **website:** add worked guides and keep Pages publishing manual ([#925](https://github.com/morluto/rea/issues/925)) ([4f25ee3](https://github.com/morluto/rea/commit/4f25ee33dcd4195f8d877f8835f81c4e08c95235))
* **website:** clarify guides and case studies ([5065fcd](https://github.com/morluto/rea/commit/5065fcd5205ec7c0d259131431c2cf54d9f69cf6))


### Tests

* **artifacts:** report compiled connector records when a storyboard route is missing ([d421d3f](https://github.com/morluto/rea/commit/d421d3f286ce515b5126859a0f9cac60667a168e))
* **artifacts:** report observed action routes when a compiled route is missing ([c60b737](https://github.com/morluto/rea/commit/c60b737f7db8e2c9a1982cdb4357fcda1f47ff08))
* **artifacts:** write the storyboard fixture's action in Cocoa syntax ([53bfa7e](https://github.com/morluto/rea/commit/53bfa7e3f792cdb9f2e95fc954f3616426414bcc))
* eliminate fixture races and prune redundant scaffolding ([#849](https://github.com/morluto/rea/issues/849)) ([f72931d](https://github.com/morluto/rea/commit/f72931d9dd54609bfca422750fc2667f80af691c))


### Continuous Integration

* consolidate macOS native baseline checks ([#935](https://github.com/morluto/rea/issues/935)) ([810fe53](https://github.com/morluto/rea/commit/810fe53e799b89dc215c52c9245d36fb2a44d9c4))
* verify native arm64 and Intel macOS workflows ([#898](https://github.com/morluto/rea/issues/898)) ([4801a24](https://github.com/morluto/rea/commit/4801a24089964860db7f4855be21d2d4313c7eab))

## [4.1.0](https://github.com/morluto/rea/compare/rea-agents-4.0.1...rea-agents-4.1.0) (2026-10-06)


### Features

* **android:** integrate static APK analysis with headless JADX ([#738](https://github.com/morluto/rea/issues/738)) ([904d03e](https://github.com/morluto/rea/commit/904d03e987a6c498561b314a266202dee84b13ab))
* **evidence:** accept exact retained application references ([#734](https://github.com/morluto/rea/issues/734)) ([d0f3480](https://github.com/morluto/rea/commit/d0f3480a3cb9887499c2b188c783dd1c4db09787))
* **firmware:** integrate Binwalk and Unblob analysis ([5a7c769](https://github.com/morluto/rea/commit/5a7c769692c21efc4cc0e5ebf06a9f2534dc75ed))
* **ghidra:** add atomic function annotation edits ([#709](https://github.com/morluto/rea/issues/709)) ([9bab553](https://github.com/morluto/rea/commit/9bab55337ab10616be6929afddb08fb19fbb8ab7))
* **ghidra:** admit explicit DOS COM analysis ([#702](https://github.com/morluto/rea/issues/702)) ([5bcb664](https://github.com/morluto/rea/commit/5bcb6645b561e666b7e07dd8f38d2296fa7cbba8))
* **ghidra:** enable Windows x64 read-only analysis ([#699](https://github.com/morluto/rea/issues/699)) ([26881da](https://github.com/morluto/rea/commit/26881da76aa320c8529fcc741df0fc9898d97bdc))
* **ghidra:** integrate optional NativeAOT metadata recovery ([#748](https://github.com/morluto/rea/issues/748)) ([fb679b6](https://github.com/morluto/rea/commit/fb679b63c27e6c5f137532953cfa24a2ffb1aaf2))
* **ghidra:** verify DOS load images and expose memory evidence ([#697](https://github.com/morluto/rea/issues/697)) ([a6a8f67](https://github.com/morluto/rea/commit/a6a8f67649cab558b0de11601e65425f280c7170))
* **ida:** add read-only GUI and headless MCP providers ([#754](https://github.com/morluto/rea/issues/754)) ([8238232](https://github.com/morluto/rea/commit/82382324855a3a4ed51d2cdc3b2b455c9e8419e2))
* **setup:** support Command Code MCP registration ([#645](https://github.com/morluto/rea/issues/645)) ([7f1ae42](https://github.com/morluto/rea/commit/7f1ae42f71ce85547d317eed5e62fa330d9876bb))


### Bug Fixes

* **android:** validate explicit Java runtime ([#742](https://github.com/morluto/rea/issues/742)) ([7390390](https://github.com/morluto/rea/commit/739039092f98c67e8e6ccfb1f8445e8f13ac8f15))
* **artifacts:** make extraction output tree work on Windows ([#753](https://github.com/morluto/rea/issues/753)) ([c8e66c7](https://github.com/morluto/rea/commit/c8e66c704a70f5133922aa1bd1a3ba42959093ba))
* **browser:** classify CSP host sources by their own origin ([#707](https://github.com/morluto/rea/issues/707)) ([1d15bcb](https://github.com/morluto/rea/commit/1d15bcb9ecd7efa487a8fd3f0d9755bd60051722))
* **browser:** keep bare module locations unresolved ([#676](https://github.com/morluto/rea/issues/676)) ([8189081](https://github.com/morluto/rea/commit/8189081511441f0e3909b21b80c21c658ec9a453))
* **ci:** upload Vitest blob reports from current path ([77799e6](https://github.com/morluto/rea/commit/77799e6c90ce36cd52e45b62c9cba2d46641c4cf))
* **cli:** disable unmanaged skill synchronization ([433ebda](https://github.com/morluto/rea/commit/433ebda8b492f388faf6e6cac63ccc6f9c2d8d7e))
* **cli:** disable unmanaged skill synchronization ([2c1bf92](https://github.com/morluto/rea/commit/2c1bf9201040ed3d60f475af9129b7bf85a508fa))
* **cli:** fail when JSON input files cannot be parsed ([18c1829](https://github.com/morluto/rea/commit/18c18290d048b78a435f6864dfc778a9fea0af2e))
* **cli:** fail when JSON input files cannot be parsed ([3201f05](https://github.com/morluto/rea/commit/3201f0538dc88e54bce00decf689bf9b5603bfd3))
* **cli:** include build step in missing-runtime recovery ([6a37346](https://github.com/morluto/rea/commit/6a37346acb9829acaab0e2042624e6ea0d03e2a9))
* **cli:** include build step in missing-runtime recovery ([ae72abd](https://github.com/morluto/rea/commit/ae72abd019b25347bfc7593b5dcadc5a2cbc3786))
* **cli:** report reference-source import failures ([00eb03d](https://github.com/morluto/rea/commit/00eb03d0f2247da95dfa7bda0f41a0f366a25dd9))
* **cli:** report reference-source import failures ([431e8eb](https://github.com/morluto/rea/commit/431e8ebfcfba2925904c0deb4888bbd3755b17bf))
* **comparison:** break function collection collation ties ([c3d013b](https://github.com/morluto/rea/commit/c3d013b2fd5c3a32dfa73ef40dafdaeaf935f37e))
* **comparison:** break function collection collation ties ([3aaf7e2](https://github.com/morluto/rea/commit/3aaf7e2c54029a456145d6e3287fd9122f3abbe3))
* **comparison:** break JSON shape collation ties ([217e8cf](https://github.com/morluto/rea/commit/217e8cf59f49e2f68b394fbcbc87f914dbee97ee))
* **comparison:** break JSON shape collation ties ([805c338](https://github.com/morluto/rea/commit/805c338f360184d73ae335a723fca656830d6328))
* **comparison:** retain container-only export shape paths ([a55b5bb](https://github.com/morluto/rea/commit/a55b5bb8ee400ef5565954d57916e8aae7dac760))
* **comparison:** retain container-only export shape paths ([7864d66](https://github.com/morluto/rea/commit/7864d665e15edec29ade0f3fb7ac374b8579c2c0))
* **dotnet:** preserve leading Unicode content in metadata strings ([#667](https://github.com/morluto/rea/issues/667)) ([ddea063](https://github.com/morluto/rea/commit/ddea06360a09508a0ff695ab6e141eff19534619))
* **electron:** respect computed option keys and overrides ([af48fe8](https://github.com/morluto/rea/commit/af48fe879161ee749692751b3e29ba06b63b7409))
* **electron:** respect computed option keys and overrides ([98de338](https://github.com/morluto/rea/commit/98de3380e3062cb25778263bfea07b215a09b39c))
* **evidence:** admit current process provider identity ([ab5a1c6](https://github.com/morluto/rea/commit/ab5a1c61b12475c554a5e4d60b48b642b2464bbb))
* **evidence:** admit current process provider identity ([d311940](https://github.com/morluto/rea/commit/d311940f2414fe5cceb750de4464b681bb44ae1e))
* **firmware:** validate configured executables ([#751](https://github.com/morluto/rea/issues/751)) ([9a4e6da](https://github.com/morluto/rea/commit/9a4e6da5a96ed2708a0f628b436dcd7415999327))
* **ghidra:** preserve request and shutdown failure diagnostics ([#647](https://github.com/morluto/rea/issues/647)) ([19f8cdd](https://github.com/morluto/rea/commit/19f8cddfd6f283188567b8ff1e49b810d79952ee))
* **ghidra:** refuse ambiguous universal Mach-O imports ([b1b687f](https://github.com/morluto/rea/commit/b1b687fb75325c0275a0cf161843fc5969ba1d47))
* **ghidra:** refuse ambiguous universal Mach-O imports ([6582b24](https://github.com/morluto/rea/commit/6582b2433a955167e33246ad07de1a40bcb20144))
* **hopper:** retain shutdown request diagnostics ([8d7071d](https://github.com/morluto/rea/commit/8d7071da4c61c5cfb4894be6536405affd90f276))
* **hopper:** retain shutdown request diagnostics ([7254871](https://github.com/morluto/rea/commit/72548712fea972b920834663a5e2ceea4738ce1e))
* integrate 14 approved fix PRs (668,671,673,675,678-681,685-690) ([#705](https://github.com/morluto/rea/issues/705)) ([cf06115](https://github.com/morluto/rea/commit/cf061159ab69a746675e48896fa953d6990c05f9))
* **javascript:** count all source line terminators ([e60aa11](https://github.com/morluto/rea/commit/e60aa1110800e1309b482e7a44ecd1762bade992))
* **javascript:** count all source line terminators ([03bc6d3](https://github.com/morluto/rea/commit/03bc6d36db94e70c709557cb7302d40af9e99e6b))
* **javascript:** expose result schema failures ([6d1f39b](https://github.com/morluto/rea/commit/6d1f39b250f8a1c6f924b1a6b9d26d56dff4beee))
* **javascript:** expose result schema failures ([99263a7](https://github.com/morluto/rea/commit/99263a720d7106aff059ad7fa43849151a94c963))
* **javascript:** hash graph and evidence JSON incrementally ([#646](https://github.com/morluto/rea/issues/646)) ([9f42495](https://github.com/morluto/rea/commit/9f42495d11100adc8646de5c8b62762ab9715ae6))
* **javascript:** preserve path.resolve reset semantics ([863ed47](https://github.com/morluto/rea/commit/863ed47de2e35ef9b734e45e3bb44ea9e9dc8ff6))
* **javascript:** preserve path.resolve reset semantics ([4177377](https://github.com/morluto/rea/commit/417737748aa96ba38ced7b0b22dbb972187f2ee0))
* **javascript:** preserve primitive addition coercion ([#666](https://github.com/morluto/rea/issues/666)) ([94cc847](https://github.com/morluto/rea/commit/94cc8475e0e9e24cd2e8345bd36a743a979e3620))
* **javascript:** preserve unknown branches in primitive unions ([75a75cb](https://github.com/morluto/rea/commit/75a75cbb20aa9b2148f9fd0547f613eadda68edd))
* **javascript:** preserve unknown branches in primitive unions ([9a2f395](https://github.com/morluto/rea/commit/9a2f3950286a01922be0b07b29c4aefee466ec1e))
* **javascript:** read source-map directives only from comments ([#672](https://github.com/morluto/rea/issues/672)) ([7f1fa64](https://github.com/morluto/rea/commit/7f1fa64019e01a654ad0eb80b47d268a58f04e57))
* **javascript:** scope candidate ambiguity to query traversal ([6ad62ce](https://github.com/morluto/rea/commit/6ad62cec6abf182a52cf9844145e147fb6399c8e))
* **javascript:** scope candidate ambiguity to query traversal ([f94fc79](https://github.com/morluto/rea/commit/f94fc7967b2e5604c144d3638515caad6273a0c6))
* **mcp:** retain shutdown failure diagnostics ([09c249d](https://github.com/morluto/rea/commit/09c249deb86068503611fc474e76018d5c2a4d0b))
* **mcp:** retain shutdown failure diagnostics ([fd008cd](https://github.com/morluto/rea/commit/fd008cd8e0b8277e691efd8e69dc96ac8e188d9e))
* **native:** inspect mixed-signature Mach-O slices ([1dccd0d](https://github.com/morluto/rea/commit/1dccd0dee04abfdc80e8b48e3f05fa39cccf0feb))
* **native:** inspect mixed-signature Mach-O slices ([66f3cfa](https://github.com/morluto/rea/commit/66f3cfa594a86cbf1f21fc6d2eca1a82e236c896))
* **native:** retain spaced symbols in dyld inventory ([#669](https://github.com/morluto/rea/issues/669)) ([fa02df9](https://github.com/morluto/rea/commit/fa02df9ad3bc3139ef10422dedffac88c4d51d36))
* **native:** select concrete arm64e Mach-O slices ([f04445c](https://github.com/morluto/rea/commit/f04445c57c597a8312211139b75da706cb0c2a96))
* **native:** select concrete arm64e Mach-O slices ([fd3282a](https://github.com/morluto/rea/commit/fd3282a87e40417cf3d7d6211743809f9bad2dc8))
* **process:** honor disabled PID normalization in samples ([44b3627](https://github.com/morluto/rea/commit/44b3627ab0b32c42e545dd2fd095006d249a77f6))
* **process:** honor disabled PID normalization in samples ([a4e5736](https://github.com/morluto/rea/commit/a4e57366dd75077bde07f25c7966204cedad929e))
* **process:** scope comparison unknowns to their evidence ([#732](https://github.com/morluto/rea/issues/732)) ([9dd6cef](https://github.com/morluto/rea/commit/9dd6cef90abf89f9191bce942e31900870231968))
* **reconstruction:** accept function comparison source parameters ([c3bc38b](https://github.com/morluto/rea/commit/c3bc38bf6c74d2175a4680530dcadd6cab0e7791))
* **reconstruction:** accept function comparison source parameters ([7a96391](https://github.com/morluto/rea/commit/7a96391001780012f704f4ef5cb6597baa590b7d))
* **reference:** bound Dockerfile language detection ([132a3a4](https://github.com/morluto/rea/commit/132a3a46be648b036ed36372a50d6e32a9e7f2e5))
* **reference:** bound Dockerfile language detection ([53fa559](https://github.com/morluto/rea/commit/53fa55937f241fc9ef3091eb22314cc370c749b9))
* **reference:** classify test suffixes before extensions ([e828acc](https://github.com/morluto/rea/commit/e828acce0e0bf3808773590cf2dbb0bc8227df7b))
* **reference:** classify test suffixes before extensions ([8b228ae](https://github.com/morluto/rea/commit/8b228ae7010144b69a243c9682aeb0a1dc4249a3))
* **reference:** distinguish computed require member names ([ba35b55](https://github.com/morluto/rea/commit/ba35b5509db60c18dd43e350e0dd4a0b5f229c69))
* **reference:** distinguish computed require member names ([df6e476](https://github.com/morluto/rea/commit/df6e476d67b2719c4b998daa3e9ad8a4b157ace2))
* **reference:** preserve unresolved absolute module specifiers ([#670](https://github.com/morluto/rea/issues/670)) ([c8aed47](https://github.com/morluto/rea/commit/c8aed4740d52b1eecaa93b3a527e8b3814dc88a4))
* **reference:** read linked worktree commit provenance ([#677](https://github.com/morluto/rea/issues/677)) ([d565ecd](https://github.com/morluto/rea/commit/d565ecdc257514f5d0c5a412081e322fc66d4215))
* **reference:** recognize CMake build manifests ([#665](https://github.com/morluto/rea/issues/665)) ([1a24be5](https://github.com/morluto/rea/commit/1a24be574d1860931ff8d4c8ec07f3968fff9fd5))
* **reference:** retain dynamic import relationships ([a5d2986](https://github.com/morluto/rea/commit/a5d2986b1e517b71a1ed51be433c95e975eafe32))
* **reference:** retain dynamic import relationships ([b89de8f](https://github.com/morluto/rea/commit/b89de8feab389477a468f0b89b8dfa35d7ddc102))
* **reference:** retain recovered parser diagnostics ([11d0ef2](https://github.com/morluto/rea/commit/11d0ef2e09308ac06889865b3fcf356b8ffa647f))
* **reference:** retain recovered parser diagnostics ([ed3a7f0](https://github.com/morluto/rea/commit/ed3a7f070cf0793e22b9a0bbfd1f2ebe9dabcfd0))
* **setup:** accept leading BOM in JSON client configs ([a5b970c](https://github.com/morluto/rea/commit/a5b970c6bf6848145a82de51c001410aa4d50f6f))
* **setup:** accept leading BOM in JSON client configs ([fe843ec](https://github.com/morluto/rea/commit/fe843ec0b101544e22d7599d93b36377d3e3bc34))
* **setup:** align Node runtime checks with package engines ([5802ef8](https://github.com/morluto/rea/commit/5802ef8746412649bb641332f2fa7e69bb1a86a3))
* **setup:** align Node runtime checks with package engines ([ea0b733](https://github.com/morluto/rea/commit/ea0b733687582d6cc28b42beaf2fc7a48be07b6a))
* **target:** explain the JavaScript directory analysis route ([#733](https://github.com/morluto/rea/issues/733)) ([8d44b3e](https://github.com/morluto/rea/commit/8d44b3edd36b528c308e32328552ca386dc43e91))
* **trace:** match typed seeds against member arrays ([65c8797](https://github.com/morluto/rea/commit/65c879757ea09fabc5fc036d6e3395fd2939995c))
* **trace:** match typed seeds against member arrays ([38ebd54](https://github.com/morluto/rea/commit/38ebd54776d661ced2e6cc2c5e4b260653a086d9))


### Code Refactoring

* **app:** split Setup and ProcessOwnership modules ([#628](https://github.com/morluto/rea/issues/628)) ([3c84080](https://github.com/morluto/rea/commit/3c84080aab5e5aa6c9fc14bafa07c635b537b64d))
* **cli:** collapse duplicate CLI layer into src/cli ([#630](https://github.com/morluto/rea/issues/630)) ([494d4db](https://github.com/morluto/rea/commit/494d4db6d9d519f9258a25504cf29b07d61fbb9f))
* **contracts:** split tool contracts by family ([#634](https://github.com/morluto/rea/issues/634)) ([5295d56](https://github.com/morluto/rea/commit/5295d56b105074b290e0d881df43cd13e34a2f8b))
* **domain:** consolidate canonical ordering and digest helpers ([#624](https://github.com/morluto/rea/issues/624)) ([ba3869c](https://github.com/morluto/rea/commit/ba3869c597133b63fdcc0077c558923ae2e17a3f))
* **domain:** split error taxonomy into thematic modules ([#636](https://github.com/morluto/rea/issues/636)) ([735c100](https://github.com/morluto/rea/commit/735c10059ca161967d71ccf8fa3f62011d2a22ca))
* **native:** extract FAT header format switch in Mach-O slice selection ([#632](https://github.com/morluto/rea/issues/632)) ([38b2933](https://github.com/morluto/rea/commit/38b293329ca06c424a58bb59a28728f19015ce22))
* **runtime:** centralize safe JSON parsing and preserve error causes ([#629](https://github.com/morluto/rea/issues/629)) ([e7f54b3](https://github.com/morluto/rea/commit/e7f54b3310b7f45af11c1754e468d4d3804191db))
* **runtime:** name all silent catch causes without changing diagnostics ([#637](https://github.com/morluto/rea/issues/637)) ([5f27e02](https://github.com/morluto/rea/commit/5f27e02fae670774667de3618c88ba2ab0e7b661))


### Documentation

* add the official Trendshift badge to README headers ([b6c21b1](https://github.com/morluto/rea/commit/b6c21b1db5d4ff4be0968aa26693916537622a06))
* add the official Trendshift badge to README headers ([7d4ed59](https://github.com/morluto/rea/commit/7d4ed59816388409885310f40c12dfdcdd2d9246))
* align MCP discovery and skill guidance with the stable catalog ([#664](https://github.com/morluto/rea/issues/664)) ([39db9fe](https://github.com/morluto/rea/commit/39db9fe4245cc8142f57f4feeadaff64cb894e31))
* **browser:** add an interaction example that captures the visible result ([#750](https://github.com/morluto/rea/issues/750)) ([91daaa6](https://github.com/morluto/rea/commit/91daaa68aea3bbee02b837ac64d3ad13127d601e))
* clarify onboarding and align provider guidance ([#745](https://github.com/morluto/rea/issues/745)) ([5af1699](https://github.com/morluto/rea/commit/5af169910391f6b95492865247fabf3c4735a9d6))
* correct CLI examples and documentation checks ([#655](https://github.com/morluto/rea/issues/655)) ([fc80ea8](https://github.com/morluto/rea/commit/fc80ea88dfb7bde43e89db0f341c99d7b53c1a7c))
* fix architecture diagram and pretty-print tool catalog ([#626](https://github.com/morluto/rea/issues/626)) ([5e7f35c](https://github.com/morluto/rea/commit/5e7f35c7c3ea8d504421a2623eafd1d73fea08a0))
* **ghidra:** explain first-query deadlines and recovery ([#736](https://github.com/morluto/rea/issues/736)) ([e2c23f3](https://github.com/morluto/rea/commit/e2c23f3640f83c13587603c763dbd7b5ef1bbbb0))
* **hopper:** document HopperTargetLease realpath fallback ([#711](https://github.com/morluto/rea/issues/711)) ([d3f498c](https://github.com/morluto/rea/commit/d3f498ceec65e4f61f39036ab943ace7ef1b9de5))
* **installation:** pin manual MCP registration to the release version ([#658](https://github.com/morluto/rea/issues/658)) ([8dd1d84](https://github.com/morluto/rea/commit/8dd1d8447146b9962ec7ab2f245b0fe47d3ddf44))
* update Trendshift repository badge ([3f6d6dc](https://github.com/morluto/rea/commit/3f6d6dc756d99ca6e7cdc1737522842fcbaee839))


### Tests

* extract shared fixtures, drop knip carve-outs ([#627](https://github.com/morluto/rea/issues/627)) ([55e5eb0](https://github.com/morluto/rea/commit/55e5eb090bb3d6cf347d7cc2f8f028b35b7461ba))
* **hopper:** synchronize startup cancellation with launcher readiness ([#662](https://github.com/morluto/rea/issues/662)) ([88a3c3f](https://github.com/morluto/rea/commit/88a3c3f8a4bf5cb31f60bca4696431c4e4512b30))

## [4.0.1](https://github.com/morluto/rea/compare/rea-agents-4.0.0...rea-agents-4.0.1) (2026-10-05)


### Bug Fixes

* **release:** allow npm propagation time ([2ef02ce](https://github.com/morluto/rea/commit/2ef02ced1603809f0fc6984612de31dce1801dd8))

## [4.0.0](https://github.com/morluto/rea/compare/rea-agents-3.2.1...rea-agents-4.0.0) (2026-10-05)


### ⚠ BREAKING CHANGES

* Managed comparison metadata adds exact-signature matching and its count, and name_matching now reports exact-signature-fallback.
* **setup:** unscoped setup refreshes only existing REA-owned registrations. Use --all-detected to configure every detected client. Setup JSON contains a compact doctor summary; use rea doctor for full diagnostics. Cancellation and successful dry runs now exit successfully.
* Remove controlled replay, Node characterization, finite replay-machine, managed runtime planning, and redundant string-tracing tools. Retire process replay, shims, reactive scenarios, custom checkpoints, and active browser replay and origin-scope inputs.
* **tools:** Removed permission configuration and policy commands, approval fields, filesystem scope inputs, and fixed confirmation options. Process capture inherits the host environment and accepts command names; callers must refresh tool schemas and migrate removed fields.

### Features

* **ghidra:** add DOS MZ analysis and complete function extents ([#556](https://github.com/morluto/rea/issues/556)) ([4f099a1](https://github.com/morluto/rea/commit/4f099a10f819125d52bd8baed9a9018496212eab))
* **native:** add inspection primitives, dispatch traces and approved UI observation ([#500](https://github.com/morluto/rea/issues/500)) ([4fbc501](https://github.com/morluto/rea/commit/4fbc501121e96b33665a76cad2e5c3e8ac2e2c6d))
* **setup:** expand agent integrations and verify updates ([#577](https://github.com/morluto/rea/issues/577)) ([6256b68](https://github.com/morluto/rea/commit/6256b6866616fa0c3137a77ebd31cf34155a642f))


### Bug Fixes

* **artifacts:** break directory child collation ties ([#587](https://github.com/morluto/rea/issues/587)) ([b37e47c](https://github.com/morluto/rea/commit/b37e47c9f729a66008b1dc8b0a1bb266e79c2776))
* **artifacts:** exclude removed paths from unchanged counts ([#569](https://github.com/morluto/rea/issues/569)) ([52bf709](https://github.com/morluto/rea/commit/52bf709bcefb17ab07e1f9c47c5fadf5eca9bd4e))
* **artifacts:** expand nested ASARs on Windows ([#582](https://github.com/morluto/rea/issues/582)) ([ebb4c45](https://github.com/morluto/rea/commit/ebb4c45b6892ab60f2c81e05fbb4cb528ffbffc4))
* **artifacts:** interrupt ZIP extraction under backpressure ([#594](https://github.com/morluto/rea/issues/594)) ([50f7e81](https://github.com/morluto/rea/commit/50f7e81432001239ca8b5de3a9cfe8f5980d2711))
* **artifacts:** preserve archive entry types and host paths ([#581](https://github.com/morluto/rea/issues/581)) ([28e0f4e](https://github.com/morluto/rea/commit/28e0f4e9ec09ae35b26920e4c6925f48770bf5ed))
* **artifacts:** refresh cached ASAR headers for each inventory ([#574](https://github.com/morluto/rea/issues/574)) ([f5013c5](https://github.com/morluto/rea/commit/f5013c50ca81795f91fd945fae2fb76f9dbe0f97))
* **artifacts:** resolve parents after archive enumeration ([#578](https://github.com/morluto/rea/issues/578)) ([8eac290](https://github.com/morluto/rea/commit/8eac290e8d716817526ab7f628e83c75fb33d06b))
* **artifacts:** respect XML plist byte-order marks ([#514](https://github.com/morluto/rea/issues/514)) ([23c4eba](https://github.com/morluto/rea/commit/23c4eba5b38b8de4f9547d879f2c3e54f741b1e1))
* **artifacts:** retain expanded ASAR container parents ([#583](https://github.com/morluto/rea/issues/583)) ([00fa974](https://github.com/morluto/rea/commit/00fa97422f585db878ffe5d1613c56608916f972))
* **artifacts:** retain relative paths in directory identities ([#580](https://github.com/morluto/rea/issues/580)) ([348323d](https://github.com/morluto/rea/commit/348323dd23360bbac3841a9632ffcd08290566d2))
* **browser:** capture popup network and report early event gaps ([#614](https://github.com/morluto/rea/issues/614)) ([f557207](https://github.com/morluto/rea/commit/f557207887ca9336f3d3c5fc02c76c354c1b2945))
* **browser:** capture selected events in popup pages ([#600](https://github.com/morluto/rea/issues/600)) ([a3bf4a0](https://github.com/morluto/rea/commit/a3bf4a0944ce5a52e100470273b91fdd48ebce49))
* **browser:** derive source-map imports from syntax nodes ([#588](https://github.com/morluto/rea/issues/588)) ([bae87b4](https://github.com/morluto/rea/commit/bae87b4ded343b34c4226b5e5d491145db7f85ff))
* **browser:** distinguish duplicate screenshot frame events ([#612](https://github.com/morluto/rea/issues/612)) ([1bd641d](https://github.com/morluto/rea/commit/1bd641d39f58461566e4a3f07fa00f84f34e87ad))
* **browser:** ignore duplicate frame navigations and read block-form source map directives ([#546](https://github.com/morluto/rea/issues/546)) ([828395d](https://github.com/morluto/rea/commit/828395d510bd4f29525e5a0807a550a2daad885c))
* **browser:** keep subresource redirects out of page navigation scope ([#524](https://github.com/morluto/rea/issues/524)) ([9c28f3c](https://github.com/morluto/rea/commit/9c28f3c4c0840fd7424dc669db1fb9baa1dde5d7))
* **browser:** preserve RGB PNG transparent samples ([#595](https://github.com/morluto/rea/issues/595)) ([9997152](https://github.com/morluto/rea/commit/9997152c2d3127162161a2b945f506f0e834be38))
* **browser:** release cancelled CDP cleanup without waiting for responses ([#517](https://github.com/morluto/rea/issues/517)) ([488fd5f](https://github.com/morluto/rea/commit/488fd5f60be3b2900c27a915c73322b9cb5eabb5))
* **browser:** release discarded source-map response bodies ([#611](https://github.com/morluto/rea/issues/611)) ([8642055](https://github.com/morluto/rea/commit/864205570a0a9452f96c11feacd00338d026f17b))
* **browser:** resolve redirected source map paths from final URL ([#518](https://github.com/morluto/rea/issues/518)) ([056c123](https://github.com/morluto/rea/commit/056c1237591de3710cb96a51ddd71fa94317b906))
* **cli:** fail commands returning projected analysis errors ([#506](https://github.com/morluto/rea/issues/506)) ([2fd1196](https://github.com/morluto/rea/commit/2fd11961cfba0c2d211a1aa643cbf05fa4e8c20d))
* **cli:** reject invalid UTF-8 JSON file bytes ([#613](https://github.com/morluto/rea/issues/613)) ([22acb0d](https://github.com/morluto/rea/commit/22acb0d5d730379fbe49e9e491f446e11425190e))
* **comparison:** account for unpaired records after explicit bundle pairing ([#603](https://github.com/morluto/rea/issues/603)) ([12a2e37](https://github.com/morluto/rea/commit/12a2e3793af63542448124311e17eacbd5235fc0))
* **comparison:** match generated names without swallowing symbol prefixes ([#596](https://github.com/morluto/rea/issues/596)) ([5f3ba3e](https://github.com/morluto/rea/commit/5f3ba3e6886b6b3186711e025da14875dc3c9684))
* **comparison:** normalize CFG identity by numeric addresses ([#593](https://github.com/morluto/rea/issues/593)) ([d1e5c0e](https://github.com/morluto/rea/commit/d1e5c0e1fd04d2d5a0d663cbe43787a010e3d783))
* **comparison:** require decoded signatures for structural method matches ([#604](https://github.com/morluto/rea/issues/604)) ([4a98c3e](https://github.com/morluto/rea/commit/4a98c3ea035480561d138d79288974a860c2aa22))
* **conformance:** preserve own JSON keys during comparison ([#573](https://github.com/morluto/rea/issues/573)) ([3460eda](https://github.com/morluto/rea/commit/3460eda9ca01ccf41e3b9895f3cbe975c0eaed51))
* correct native inventories and bridge error classification ([#503](https://github.com/morluto/rea/issues/503)) ([405732a](https://github.com/morluto/rea/commit/405732a7f55e3033c29533b18f7d8313dbd28570))
* **docs:** allow README installation wording to vary ([92617f9](https://github.com/morluto/rea/commit/92617f965720aaa74ec20ad67291adc5e83677a1))
* **ghidra:** avoid nested quotes in Windows Java options ([a574b74](https://github.com/morluto/rea/commit/a574b744b8fe95e906524684f6a3b28cdc656499))
* **ghidra:** recover evidenced switch cases and default targets ([#579](https://github.com/morluto/rea/issues/579)) ([b225b0f](https://github.com/morluto/rea/commit/b225b0f64bfa86586c17f193d30e278d8124b14e))
* **inspector:** preserve lossy Node discovery locations ([#542](https://github.com/morluto/rea/issues/542)) ([84e4361](https://github.com/morluto/rea/commit/84e4361c0936a4bb30951699fb68970d4d7a2327)), closes [#530](https://github.com/morluto/rea/issues/530)
* **javascript:** avoid invented computed destructuring properties ([#507](https://github.com/morluto/rea/issues/507)) ([80777d9](https://github.com/morluto/rea/commit/80777d96daf64d0266e5cf3f9aad9338b97be4ff))
* **javascript:** bind named class expressions in their class scope ([#510](https://github.com/morluto/rea/issues/510)) ([55f0267](https://github.com/morluto/rea/commit/55f0267c409cbf096bcdbd07d7604c44bcde3fbe))
* **javascript:** classify assignment targets and retain compound-assignment reads ([#537](https://github.com/morluto/rea/issues/537)) ([333d118](https://github.com/morluto/rea/commit/333d118c0fa65c8c418baaa337270c0ad25cd7cc))
* **javascript:** correct lexical and dynamic scope analysis ([#538](https://github.com/morluto/rea/issues/538)) ([6fa6f1f](https://github.com/morluto/rea/commit/6fa6f1f9b17318220abb2683c327146785dcc5d3))
* **javascript:** honor computed keys when naming callables, exports, requests and options ([#536](https://github.com/morluto/rea/issues/536)) ([4c8dc39](https://github.com/morluto/rea/commit/4c8dc39f439b5283b077c6aa47f262714d7c4bbd))
* **javascript:** honor package exports condition order ([#591](https://github.com/morluto/rea/issues/591)) ([8289595](https://github.com/morluto/rea/commit/82895959d1494f16bc59909a2575facf3ab19d79))
* **javascript:** isolate lexical loop bindings ([#511](https://github.com/morluto/rea/issues/511)) ([c30878f](https://github.com/morluto/rea/commit/c30878f616c4496c6cd1993d677aa019b2412b7e))
* **javascript:** prefer package entrypoints over directory indexes ([#575](https://github.com/morluto/rea/issues/575)) ([bb91abd](https://github.com/morluto/rea/commit/bb91abd3df52802ec8f9d3d1fb215dce5eb6ea49))
* **javascript:** preserve literal CommonJS path punctuation ([#576](https://github.com/morluto/rea/issues/576)) ([063cd25](https://github.com/morluto/rea/commit/063cd25a93ee9f16b45635fea196dde0d9309ab9))
* **javascript:** preserve Node exports fallback stop reasons ([#606](https://github.com/morluto/rea/issues/606)) ([adc07f5](https://github.com/morluto/rea/commit/adc07f5eaab005f013c88617aa09b6f2b4af4111))
* **javascript:** respect HTML base URL components ([#589](https://github.com/morluto/rea/issues/589)) ([ffbde92](https://github.com/morluto/rea/commit/ffbde92f9ab65a868b660abf17ce9d3c4577d125))
* **javascript:** respect lexical shadowing of require ([#509](https://github.com/morluto/rea/issues/509)) ([6a431d8](https://github.com/morluto/rea/commit/6a431d806a1574a660b96ba49412b24df9e93b50))
* **javascript:** retain property reads during updates ([#508](https://github.com/morluto/rea/issues/508)) ([6b7923c](https://github.com/morluto/rea/commit/6b7923cdd2a099d1481783f34970a3d1a71a8206))
* **managed:** classify truncated signatures as malformed ([#598](https://github.com/morluto/rea/issues/598)) ([1b6f054](https://github.com/morluto/rea/commit/1b6f05470d6fb1903346ef7a25fb5f9d23079cb7))
* **managed:** distinguish metadata handles from member accesses ([#607](https://github.com/morluto/rea/issues/607)) ([c73742f](https://github.com/morluto/rea/commit/c73742f3003ec6c1469f77ecc9ccb093df636b4a))
* **managed:** recognize PE Thumb and ARMNT machines ([#605](https://github.com/morluto/rea/issues/605)) ([0ce529a](https://github.com/morluto/rea/commit/0ce529af4e0280fcbd4e647d0fcb0a9ca9f3496e))
* **mcp:** emit valid schemas for empty arrays ([#535](https://github.com/morluto/rea/issues/535)) ([4007b20](https://github.com/morluto/rea/commit/4007b20fc277b4d20b52cae328dea58ae033be63)), closes [#528](https://github.com/morluto/rea/issues/528)
* **mcp:** return complete inline Evidence records ([#585](https://github.com/morluto/rea/issues/585)) ([ea9c3da](https://github.com/morluto/rea/commit/ea9c3dab6b2ff4fa943c8ca4fec7ae8b304dbd93)), closes [#551](https://github.com/morluto/rea/issues/551)
* **native:** capture Mach-O header metadata alongside load commands ([#525](https://github.com/morluto/rea/issues/525)) ([a8195ba](https://github.com/morluto/rea/commit/a8195ba2cc34a37f68d7bb8a8087d73ace40984b))
* **native:** decode little-endian fat headers ([bede3e3](https://github.com/morluto/rea/commit/bede3e3c60e53d445209096b360a81eaa0c446cc)), closes [#592](https://github.com/morluto/rea/issues/592)
* **native:** decode Mach protection bits in their proper positions ([#586](https://github.com/morluto/rea/issues/586)) ([6aba6ae](https://github.com/morluto/rea/commit/6aba6ae2316fe6299c855a3db52b221fff63c00c))
* **native:** inspect Apple dispatch metadata in FAT64 binaries ([#590](https://github.com/morluto/rea/issues/590)) ([f3e6582](https://github.com/morluto/rea/commit/f3e6582e9ed327c5accb8f9068ea0eb9bac49b1f))
* **native:** inspect the selected universal Mach-O architecture ([#601](https://github.com/morluto/rea/issues/601)) ([2b7bb3b](https://github.com/morluto/rea/commit/2b7bb3bb6a87704c18469768bc82d87e97b5c99c))
* **native:** match compound otool keys exactly and badge unknown thread entrypoints ([#534](https://github.com/morluto/rea/issues/534)) ([d40502a](https://github.com/morluto/rea/commit/d40502aa3b9a8c87fde49e5887547066128f19ba))
* **native:** normalize otool line endings and strip plist JSON BOM ([#533](https://github.com/morluto/rea/issues/533)) ([3e4d4d9](https://github.com/morluto/rea/commit/3e4d4d93fdc3eb5fdffda3a8dc8bec43201cdd98))
* **native:** preserve text-valued load command metadata ([#520](https://github.com/morluto/rea/issues/520)) ([bcfb407](https://github.com/morluto/rea/commit/bcfb4072f2ff665e93477206e14ce4b0581f97b9))
* **native:** reject signal-terminated command captures ([#608](https://github.com/morluto/rea/issues/608)) ([b81d18e](https://github.com/morluto/rea/commit/b81d18eeee9d93dafcb15e3d723de951509c2612))
* **native:** reject trailing text in lipo integers and keep multi-word otool keys ([#531](https://github.com/morluto/rea/issues/531)) ([9e30d93](https://github.com/morluto/rea/commit/9e30d93af3d2c0cc1a7536a10e3141f9f2fb499c))
* **native:** retain lazy dylibs, normalize version-min builds, limit thread entrypoints ([#532](https://github.com/morluto/rea/issues/532)) ([0f77ada](https://github.com/morluto/rea/commit/0f77ada55e6d1d01cb925993d871bf4a94f94bb2))
* **native:** retain re-exported Mach-O library dependencies ([#516](https://github.com/morluto/rea/issues/516)) ([4a5673e](https://github.com/morluto/rea/commit/4a5673e1dc6f2213cf94121384cff405e390677a))
* **package:** separate agent and Hopper setup support ([#584](https://github.com/morluto/rea/issues/584)) ([205a977](https://github.com/morluto/rea/commit/205a9777776476b4f361e38f25d1c75baaccd420))
* **platform:** accept absolute paths for any host and stop blaming the ceiling for a missing grant ([#552](https://github.com/morluto/rea/issues/552)) ([e793e12](https://github.com/morluto/rea/commit/e793e124a27b8087057f58f39028144ea6f6e173))
* **process:** align provider detach with configured platform ([3fff74f](https://github.com/morluto/rea/commit/3fff74fb5bb9725be2456e8c39bc0b98181d0687))
* repair boundary contracts across CLI and MCP ([#597](https://github.com/morluto/rea/issues/597)) ([9c25dc4](https://github.com/morluto/rea/commit/9c25dc4ed2915a81fc83a1d4dc22e7ba814b8dff))
* **replay:** keep __proto__ own properties and reject symbol-keyed results ([#540](https://github.com/morluto/rea/issues/540)) ([05bb630](https://github.com/morluto/rea/commit/05bb630a00aa521229cde53ded9a5345b8bd1a2b))
* **replay:** link the complete ESM graph before evaluating ([#515](https://github.com/morluto/rea/issues/515)) ([4200a42](https://github.com/morluto/rea/commit/4200a425d50eab80847edf3baa9ea4c5244e8be8))
* **replay:** preserve CommonJS object as ESM default export ([#519](https://github.com/morluto/rea/issues/519)) ([2df6b51](https://github.com/morluto/rea/commit/2df6b51ebb87e8d406d6201d8f3158aefefa7cc5))
* **replay:** preserve Date call and explicit constructor semantics ([#512](https://github.com/morluto/rea/issues/512)) ([9975bd2](https://github.com/morluto/rea/commit/9975bd23cdba7e196ca97c3fcec41a6eee925e57))
* **replay:** preserve sparse array positions in result projection ([#522](https://github.com/morluto/rea/issues/522)) ([9d1c363](https://github.com/morluto/rea/commit/9d1c3631b8deccb5fb91906130f38e3f24aa254e))
* **replay:** share one seeded generator and present builtins with real identity ([#539](https://github.com/morluto/rea/issues/539)) ([5b51fa0](https://github.com/morluto/rea/commit/5b51fa01e2391cd4b6d5e9ba7b6aa7615de891b1))
* **repo:** keep dependency links out of version control ([#617](https://github.com/morluto/rea/issues/617)) ([b3223e3](https://github.com/morluto/rea/commit/b3223e3f61a23b79152939ef755aca95e7640f09))
* **skill:** remove obsolete grants and audit tool effects ([2919def](https://github.com/morluto/rea/commit/2919def828b3c8fc7947989f1de3f4f4ac4cdd36))
* **test:** improve capture reliability and runner cleanup ([#609](https://github.com/morluto/rea/issues/609)) ([d19686a](https://github.com/morluto/rea/commit/d19686a2a5122c691f7885997906ecb31dd9827d))
* **tools:** simplify direct invocation and harden boundary contracts ([#555](https://github.com/morluto/rea/issues/555)) ([b5e9891](https://github.com/morluto/rea/commit/b5e98915c60968213141f33839e0c5c4b34df4db))
* **web:** retain uncertainty for incomplete capture inventories ([#513](https://github.com/morluto/rea/issues/513)) ([d8c18f6](https://github.com/morluto/rea/commit/d8c18f604f292c95b6b0b185d23517cb6881c5fb))
* **win32:** probe .cmd/.bat runtime shims via cmd.exe to avoid spawn EINVAL ([#505](https://github.com/morluto/rea/issues/505)) ([31ed005](https://github.com/morluto/rea/commit/31ed005183c315f1bc72f6e10730a47be73d7f1c))
* **workflows:** preserve punctuation in filesystem source paths ([#521](https://github.com/morluto/rea/issues/521)) ([5b28a8b](https://github.com/morluto/rea/commit/5b28a8b331259e026678e681210e9c3c4f48f2fa))
* **workflows:** retain container presence in export shape comparisons ([#523](https://github.com/morluto/rea/issues/523)) ([3854458](https://github.com/morluto/rea/commit/385445804ab45605a47edcb996ebbc026e2f0a43))


### Code Refactoring

* **config:** take the environment as an input at every configuration read ([#554](https://github.com/morluto/rea/issues/554)) ([53fe7d6](https://github.com/morluto/rea/commit/53fe7d6d3b3630472124563ccafdad3f4964b4bc))
* **domain:** consolidate duplicated semantic member and literal helpers ([#550](https://github.com/morluto/rea/issues/550)) ([09830da](https://github.com/morluto/rea/commit/09830dad053f2b1440e0b1cde63747606684be4b))
* **domain:** own digest and prefixed identifier shapes in one module ([#547](https://github.com/morluto/rea/issues/547)) ([ea58834](https://github.com/morluto/rea/commit/ea5883494036ddb30d138fdb381d54b2d9808b49))
* **host:** inject platform and environment instead of reading them ambiently ([#549](https://github.com/morluto/rea/issues/549)) ([5b59b87](https://github.com/morluto/rea/commit/5b59b87726b459cf9887dd4edc176981ef4e6afc))
* simplify runtime tools and remove replay engines ([#572](https://github.com/morluto/rea/issues/572)) ([e07b816](https://github.com/morluto/rea/commit/e07b81649e96668e5ce166cfc6db3b59a7777697))


### Documentation

* add boundary contract guidance ([42e6a8a](https://github.com/morluto/rea/commit/42e6a8a6f6da4c3aebb10235a27d471dc2590954))
* add Discord community links to README ([79bf26f](https://github.com/morluto/rea/commit/79bf26f33f980c20367986080a16d4a9f7952048))
* align roadmap with direct tool use ([eba709e](https://github.com/morluto/rea/commit/eba709e5c096796b0afe3ce9203659df9eaf0a7d))
* align translated READMEs and clarify support guides ([5b383b2](https://github.com/morluto/rea/commit/5b383b2ddd4195cb15e412b81853955b38419721))
* clarify README wording and analysis tool support ([97822f2](https://github.com/morluto/rea/commit/97822f233be49a8b582b4c2aa982af3854ca0bb2))
* move README image above Discord community ([ad86d39](https://github.com/morluto/rea/commit/ad86d39d2cb4f2d1ce0da08a17d5f7948c0797ec))
* place community invitation below README navigation ([69a45e0](https://github.com/morluto/rea/commit/69a45e0bbc03d87624de866a821b976e4aaca069))
* place Discord community below setup command ([778e464](https://github.com/morluto/rea/commit/778e464c206ba75a2f94edaad3c05e8bf63bed10))
* place setup command above README image ([c6d3bdf](https://github.com/morluto/rea/commit/c6d3bdf597d9cd75a6f7396236e1a47f5ee4288d))


### Tests

* **setup:** isolate client fixtures across host platforms ([f73bb0f](https://github.com/morluto/rea/commit/f73bb0fe116678543a73d13f58eaa3b48133afc5))

## [3.2.1](https://github.com/morluto/rea/compare/rea-agents-3.2.0...rea-agents-3.2.1) (2026-10-03)


### Bug Fixes

* **release:** tolerate npm registry propagation delay ([726b730](https://github.com/morluto/rea/commit/726b730b84830b208725df50fa0251ece1fa199f))


### Tests

* **release:** accept guarded npm publishing ([b7bc855](https://github.com/morluto/rea/commit/b7bc8554928c8eca9c29842c77e4021c1e42e054))

## [3.2.0](https://github.com/morluto/rea/compare/rea-agents-3.1.0...rea-agents-3.2.0) (2026-10-03)


### Features

* **native:** add investigation features ([#486](https://github.com/morluto/rea/issues/486)) ([ed933d1](https://github.com/morluto/rea/commit/ed933d18933814e3957a920972ccf91117d4ed87))


### Bug Fixes

* **artifacts:** stabilize extraction approval ([7eb1a95](https://github.com/morluto/rea/commit/7eb1a9500c62b66716878c18ee442c324a715a88))
* **browser:** reject unknown Electron input fields ([1860d4f](https://github.com/morluto/rea/commit/1860d4f0e531919ee9b10bec7ad8db43e18a291b))
* **ci:** retain artifacts for delayed reruns ([07888ec](https://github.com/morluto/rea/commit/07888ec096f69753a1535703fb7b3c3070e786b7))
* **cli:** remove ignored result limits ([f3645aa](https://github.com/morluto/rea/commit/f3645aa51e55c5207f7b9b1f0156ffaef7aaed42))
* consolidate boundary ownership and cleanup failure paths ([#477](https://github.com/morluto/rea/issues/477)) ([2160d4f](https://github.com/morluto/rea/commit/2160d4fae581243990e539a9c401d1b8824e1763))
* **contracts:** align byte read schema with provider ([f580d9d](https://github.com/morluto/rea/commit/f580d9d07382bc9642bce896d431c827955339e4))
* **ghidra:** return complete native analysis results ([a66e43a](https://github.com/morluto/rea/commit/a66e43a99dda1604c8250c9eb73aa8ef000371c9))
* **managed:** retain every source location ([33b2099](https://github.com/morluto/rea/commit/33b20991c455306d66f8687a9f80ea22073d4207))
* **process:** capture complete host probe output ([6c68ff5](https://github.com/morluto/rea/commit/6c68ff565fe1196fd8c7a63598e8bd94098abc3c))
* **runtime:** make observed target role optional ([593a8e1](https://github.com/morluto/rea/commit/593a8e12ceac1cfe350493cfe6b0d1360eb85f7c))
* **runtime:** retain complete reconciled graph content ([bedd55a](https://github.com/morluto/rea/commit/bedd55a4b4ccc9a0c1441d3836138b323de6d126))


### Code Refactoring

* **analysis:** remove caller-selected result caps ([a8c58c6](https://github.com/morluto/rea/commit/a8c58c6605ac37a8b504167732affc5ce4fc772f))
* **analysis:** remove fixed result quotas ([20152a9](https://github.com/morluto/rea/commit/20152a9872dd035714beb5ef5b8898a9b4d1d6c4))
* **artifacts:** consolidate inventory into inspection ([0fe96d9](https://github.com/morluto/rea/commit/0fe96d92dfefbaf28d2abfd5e237f6d0e82eee7b))
* **artifact:** simplify extraction and inventory results ([07ff8b3](https://github.com/morluto/rea/commit/07ff8b30ee497d9f4477a0a9ae97f3f5addbb45a))
* **artifacts:** remove duplicate inventory wrapper ([aa6eee1](https://github.com/morluto/rea/commit/aa6eee1a712d1a319bbaed5387aa5f4429755a1f))
* **artifacts:** remove selectors and traversal quotas ([8c24272](https://github.com/morluto/rea/commit/8c24272ee7e6d30b1493ee7ccd63e45734fe2f95))
* **artifacts:** select extraction by logical path ([7ba3580](https://github.com/morluto/rea/commit/7ba3580c860463adcd5edc73b7a80f34b92480cf))
* **browser:** remove arbitrary capture ceilings ([5dd3b46](https://github.com/morluto/rea/commit/5dd3b4655e21222a6598bf8cbc0be90f3cbf5e0f))
* **browser:** return complete observation evidence ([0e2738f](https://github.com/morluto/rea/commit/0e2738ffb6aa35bb06fe01d0af864aec968570cf))
* **browser:** return complete scenario observations ([e80fe41](https://github.com/morluto/rea/commit/e80fe414b13294446f959b382cb240c806cfe000))
* **browser:** share authorized main-frame polling ([eec75ce](https://github.com/morluto/rea/commit/eec75ce918cbac576fd217847911793331aa32a0))
* **browser:** share canonical identity digest ([a6d9e49](https://github.com/morluto/rea/commit/a6d9e49ab46150c8b757f5bdd5f80d3a8ff52f26))
* **contracts:** remove duplicate schema aliases ([4593c29](https://github.com/morluto/rea/commit/4593c29b64d3f6c43ddb19228da6231f1055eba4))
* **contracts:** simplify workflows and drop readiness tool ([7acac61](https://github.com/morluto/rea/commit/7acac615ca2b8e3f4edd65fd8a08b237f85b5ac7))
* **coverage:** evaluate inline without workspaces ([9e76054](https://github.com/morluto/rea/commit/9e7605482acf2de77ad04c5c5e03ac4280a11d7f))
* **domain:** encode comparison and lifecycle states exactly ([#473](https://github.com/morluto/rea/issues/473)) ([d65730c](https://github.com/morluto/rea/commit/d65730c4c24ab6183426516d4564e6c25294b35d))
* **domain:** share AST property name reader ([4f4cc59](https://github.com/morluto/rea/commit/4f4cc59873ec704811649aeca8a49e3bcdbdf324))
* **electron:** retain complete active observations ([e8c56e0](https://github.com/morluto/rea/commit/e8c56e0c0aeb114e09636ad1841d8fd73720b5cc))
* **errors:** remove stale workspace failures ([f570d40](https://github.com/morluto/rea/commit/f570d40f50bc8621b32ba4e255660ed1b1398356))
* **evidence:** remove obsolete ID resolvers ([a3920e2](https://github.com/morluto/rea/commit/a3920e2abd915eba31b59413710315a85caf1afa))
* **evidence:** remove session ledger quotas ([dca293a](https://github.com/morluto/rea/commit/dca293a446fa86767fb4bed6fe734f09b6cfafde))
* **files:** use caller paths for local evidence files ([c34efca](https://github.com/morluto/rea/commit/c34efca4cd322d4816ab4cd526a7475489edc814))
* **ghidra:** remove redundant schema markers ([c2a6f4b](https://github.com/morluto/rea/commit/c2a6f4bc437671c25ba318d21b82818c8e6bf2ce))
* **javascript:** remove analysis ceilings ([9aec690](https://github.com/morluto/rea/commit/9aec6908b5c7ad50da6882415700cbe53c3f62ed))
* **managed:** derive inspection from PE CLI extents ([dfad09e](https://github.com/morluto/rea/commit/dfad09e3b5769b079bf2d07382aee310d682724f))
* **mcp:** simplify evidence and workflows ([6740ed5](https://github.com/morluto/rea/commit/6740ed5215578eaaf33c785d6245649d76a0411c))
* **mcp:** simplify tool inputs and inline results ([f55c2b9](https://github.com/morluto/rea/commit/f55c2b92676e4a7eb06efbc8d9a908a7de62541a))
* **mcp:** simplify workflow and observation scope ([34d00fd](https://github.com/morluto/rea/commit/34d00fd323c793278c6ed126308c58e2fc7efd54))
* **observation:** internalize capture budgets ([7b3c797](https://github.com/morluto/rea/commit/7b3c7972377c7f77b1328e7d1de3f54835bc1397))
* **observation:** retain complete tool results ([fa2b6c5](https://github.com/morluto/rea/commit/fa2b6c5a61adcb75c4c2773ed1c9f7dba83fc1d3))
* **observation:** return complete inventories ([c523c38](https://github.com/morluto/rea/commit/c523c38027f536e8319eb2acc1840274c5bc5986))
* **permission:** remove unused authorization helpers ([1b0ab75](https://github.com/morluto/rea/commit/1b0ab75a84ccdcf036ccfc019d1890b2d626699a))
* **process:** remove fixed scenario ceilings ([abf7c11](https://github.com/morluto/rea/commit/abf7c1142e759a291d2267fedf15b0dd444a5684))
* **process:** remove redundant schema version markers ([b3aca52](https://github.com/morluto/rea/commit/b3aca5289bf973ffb4072253eebe86e0acced347))
* **process:** remove request count ceilings ([f2dc749](https://github.com/morluto/rea/commit/f2dc749c862a16d056de53e95914a9a411592583))
* **process:** remove unused paired experiment ([e1d755f](https://github.com/morluto/rea/commit/e1d755f7cd574860f59965a6244dbd43f5032f2c))
* **prompts:** make tool workflows optional ([3fd9650](https://github.com/morluto/rea/commit/3fd96506f223889a2d327cc7c97a95bf48ccb594))
* **reference:** share graph index projections ([6ee87fb](https://github.com/morluto/rea/commit/6ee87fbf2defcb10a17352b36ebeed67c6ce6dc5))
* remove cross-version investigation workflow ([81996df](https://github.com/morluto/rea/commit/81996df7a59ae6efb0f7be6687af89e66c64cdcb))
* **replay:** share sandbox probe arguments ([9fca6c0](https://github.com/morluto/rea/commit/9fca6c0296ac360f9d2c838440b24d2ea79234b5))
* **replay:** simplify runtime value checks ([60cb68a](https://github.com/morluto/rea/commit/60cb68a276b012964b08c18e9d60af22e64c468f))
* return complete analysis results inline ([a2a3243](https://github.com/morluto/rea/commit/a2a3243ea874ee1662c62a83ced63be218e0218e))
* return complete tool results inline ([0d96275](https://github.com/morluto/rea/commit/0d96275b6887b72519d2bc54f72012db6a8e482c))
* **runtime:** retain complete reconciliation outputs ([79ea571](https://github.com/morluto/rea/commit/79ea571512a1f55200eb5520d6c56104dba54e5b))
* **schema:** remove data-only version markers ([5457f4a](https://github.com/morluto/rea/commit/5457f4a2bceccb9c40e19a9986964025f279fc91))
* **server:** remove registration alias ([8097ec4](https://github.com/morluto/rea/commit/8097ec456a14992b578057438be8a6e89a076cdf))
* **server:** use canonical elicitation type ([bb6a58c](https://github.com/morluto/rea/commit/bb6a58c2a7eec15fb5f224376230398b51d1b952))
* **test:** colocate pure-domain tests and reduce test debt ([#471](https://github.com/morluto/rea/issues/471)) ([e91c8c3](https://github.com/morluto/rea/commit/e91c8c39c2acddc4389ed0d01950d1954c472e47))
* **test:** keep coverage at behavioral boundaries ([#474](https://github.com/morluto/rea/issues/474)) ([d4dc940](https://github.com/morluto/rea/commit/d4dc940bd871089ffa1b42d3475798b2f4f9c992))
* **tools:** remove arbitrary workflow ceilings ([5f73cb0](https://github.com/morluto/rea/commit/5f73cb061b6fec532d1cccf5a8bce59855823fa4))
* **tools:** remove artificial analysis ceilings ([2f08c7c](https://github.com/morluto/rea/commit/2f08c7c932d3619a481709935f07da59de3d3b27))
* **tools:** remove redundant limits and acknowledgements ([bd0e341](https://github.com/morluto/rea/commit/bd0e34157239613aed7aa9315df0e97d03d8636c))
* **tools:** remove remaining arbitrary workflow caps ([ecf3ed8](https://github.com/morluto/rea/commit/ecf3ed8bdb9ef7a83e7a2fb23443eced6c3824b0))
* **tools:** return complete analysis results inline ([2a6eb41](https://github.com/morluto/rea/commit/2a6eb41147e496b9e044011fa3b755ef74388c51))
* **workflows:** simplify evidence reference inputs ([24e1fa9](https://github.com/morluto/rea/commit/24e1fa9a76e447cff318da9f48c7adb659a1f8ab))


### Documentation

* add REA tool design guidance ([#485](https://github.com/morluto/rea/issues/485)) ([36aeec9](https://github.com/morluto/rea/commit/36aeec95863ca28d3e3aa5bec75a45d3824e17f5))
* clarify aggregate context tools ([c7e207c](https://github.com/morluto/rea/commit/c7e207c290e376db5c2f210f9ac08fe170ef3ec4))
* clarify MCP tool design guidance ([36aeec9](https://github.com/morluto/rea/commit/36aeec95863ca28d3e3aa5bec75a45d3824e17f5))
* correct inline evidence and Hopper behavior ([bf9cce1](https://github.com/morluto/rea/commit/bf9cce1aef89a769320d217e82b895b086880e69))
* describe complete application analysis outputs ([271b162](https://github.com/morluto/rea/commit/271b1620e68f3a6bbc69f28aa4c4d18d5c453baf))
* generalize reverse-engineering workflow ([#488](https://github.com/morluto/rea/issues/488)) ([4ecc7a7](https://github.com/morluto/rea/commit/4ecc7a72f2d6d78b8d9c59a146e532fe552c40bb))
* improve GitHub issue and pull request templates ([c490d85](https://github.com/morluto/rea/commit/c490d85045de07488e01747db9c9f77d264b2e36))
* prioritize reusable analysis primitives ([#493](https://github.com/morluto/rea/issues/493)) ([9dd72c4](https://github.com/morluto/rea/commit/9dd72c4911841671594570677f5ba6e3992d076d))
* refresh managed conformance manifest ([23e56c5](https://github.com/morluto/rea/commit/23e56c517c08abcafe3a81919215433458aef27e))
* refresh tool catalog and cleanup audit fixtures ([53db3a4](https://github.com/morluto/rea/commit/53db3a476b2881f498a5d6c87195e783268c1988))
* regenerate tool and evidence catalogs ([2f604a3](https://github.com/morluto/rea/commit/2f604a3c3ad037a68da4c33a30cb5316983b070f))
* regenerate tool and evidence catalogs ([f2bbd59](https://github.com/morluto/rea/commit/f2bbd5957eccac6164b3f12db87921ffb09bdcf2))
* **tools:** clarify complete inline results ([3b64c81](https://github.com/morluto/rea/commit/3b64c813cf8bcd0cdd262d0a3d5950819f320a12))
* **tools:** clarify complete inline workflows ([4168174](https://github.com/morluto/rea/commit/41681742ccea83a7956e7bc303da4aa223ed4877))
* **tools:** describe uncapped tool behavior accurately ([4cea84d](https://github.com/morluto/rea/commit/4cea84d7cbb0508e6c0dde36a2a0542855681f95))
* **tools:** update inline workflow guidance ([4ad937c](https://github.com/morluto/rea/commit/4ad937c6caeec89ded592ea82dec4fa13ea17d8c))


### Tests

* **artifacts:** exercise argument-free extraction preflight ([a6d5b3e](https://github.com/morluto/rea/commit/a6d5b3ea9d1f53afeda33ef53fe50f42feac2343))
* **browser:** assert strict inputs without legacy fields ([9ddf22e](https://github.com/morluto/rea/commit/9ddf22e1962803bf06d54b2e577a0c03a3f3ad48))
* **browser:** cover complete screenshot output ([3f547ea](https://github.com/morluto/rea/commit/3f547eafa4c6f27b8264025c754392161687908e))
* **browser:** remove stale input field assertion ([60c110d](https://github.com/morluto/rea/commit/60c110d97b1b22c010b8597965b3ad09f4f51480))
* **cli:** consolidate duplicate setup journey ([9bd7e2c](https://github.com/morluto/rea/commit/9bd7e2cb459d0354ee2c406555de9e427c549086))
* **cli:** remove duplicate browser discovery case ([dcb0362](https://github.com/morluto/rea/commit/dcb036292e975c81780dbf7a711fd1a565a13a10))
* **conformance:** remove fixture generator test option ([ea853ce](https://github.com/morluto/rea/commit/ea853cebde5641dc9c12ef59005de84197463467))
* **contracts:** remove duplicate tool inventories ([0ae3c08](https://github.com/morluto/rea/commit/0ae3c0837b387e53686bcd6e8aa03cb29f80458a))
* **hopper:** name regex search assertion accurately ([9240bd8](https://github.com/morluto/rea/commit/9240bd8d166ffee93a90fd55c5de4b58d8ff6ad4))
* **hopper:** remove dossier identity assertion ([b5c0b5b](https://github.com/morluto/rea/commit/b5c0b5b53e2d15dd6da9d4e8b1d3c3c21a16c409))
* **mcp:** align workflow assertions with current guidance ([f8bb113](https://github.com/morluto/rea/commit/f8bb113c22cf23916a8cd8a5d77734ccaf63fd08))
* **mcp:** consolidate catalog inventory checks ([3afcd64](https://github.com/morluto/rea/commit/3afcd641462bbd99ebdc3bf2fc8264e2c3344c09))
* **mcp:** validate defaults at tool boundary ([21241d2](https://github.com/morluto/rea/commit/21241d2323d323f405b3cff4692e01364b6ddbde))
* remove duplicate export schema acceptance ([b783e7f](https://github.com/morluto/rea/commit/b783e7febef8c22b41817a61a7f8293393ac6425))
* remove obsolete schema version assertions ([fe342fa](https://github.com/morluto/rea/commit/fe342faa832ec9b17a6fb1dd85b1cf269b33cf1b))
* remove stale limits and handoff expectations ([acf33d6](https://github.com/morluto/rea/commit/acf33d6df272873728aaa7527c5d43fa2a13132b))
* remove vacuous and duplicate assertions ([56e2bf7](https://github.com/morluto/rea/commit/56e2bf7696e6ccbc3e4b5baf9249c6d4152f4a43))
* remove Vitest config test exports ([d6e545c](https://github.com/morluto/rea/commit/d6e545cc4832ed47cc98d974aa8e4aa9453afb98))
* replace brittle workflow and readme checks ([b3529aa](https://github.com/morluto/rea/commit/b3529aa327026472798a5f0971dcb325d221ddc6))
* replace implementation lock-in with behavioural assertions ([#498](https://github.com/morluto/rea/issues/498)) ([7ee3f23](https://github.com/morluto/rea/commit/7ee3f236a9f753dfc90d84f95f20598e4e45fd0d))
* **replay:** remove duplicate schema coverage ([4ec2343](https://github.com/morluto/rea/commit/4ec2343d91925e583b15d5404af2eabaf6ffed0f))

## [3.1.0](https://github.com/morluto/rea/compare/rea-agents-3.0.0...rea-agents-3.1.0) (2026-08-09)


### Features

* **electron:** add autonomous Electron runtime analysis ([#464](https://github.com/morluto/rea/issues/464)) ([8f229ed](https://github.com/morluto/rea/commit/8f229ede70c0a4e224c1cf71d61487e17b779d6a))


### Bug Fixes

* **ci:** guard Release Please PR branch parsing ([84cc819](https://github.com/morluto/rea/commit/84cc819284b9ce7ee648850c85d5daf3a33e5a24))
* **ci:** guard release PR branch parsing ([6838b6b](https://github.com/morluto/rea/commit/6838b6bff9ab5c400432caefd8c8737b86c41f07))
* harden evidence lifecycle and MCP contracts ([5155924](https://github.com/morluto/rea/commit/51559245d2e1c2d7550cfe489716950fe6154bd0))
* harden structured configuration comparisons ([#467](https://github.com/morluto/rea/issues/467)) ([6901edc](https://github.com/morluto/rea/commit/6901edc05d56063bdbe8be96511b1b21863630b5))
* **npm:** preserve explicit setup versions ([#465](https://github.com/morluto/rea/issues/465)) ([1783bf6](https://github.com/morluto/rea/commit/1783bf6dfdd4ec11e824870ce5b1a2f5a321450e))


### Code Refactoring

* **mcp:** make analysis states unrepresentable ([#468](https://github.com/morluto/rea/issues/468)) ([b8a9da0](https://github.com/morluto/rea/commit/b8a9da0c0f9f0b2b022a350d2c7c671d1fa3f886))


### Documentation

* clarify agent reverse-engineering promise ([ed4a628](https://github.com/morluto/rea/commit/ed4a62871f7924948e3774ae6cf880514a560ff4))
* clarify the agent reverse-engineering promise ([#466](https://github.com/morluto/rea/issues/466)) ([ed4a628](https://github.com/morluto/rea/commit/ed4a62871f7924948e3774ae6cf880514a560ff4))
* **npm:** simplify current setup command ([#469](https://github.com/morluto/rea/issues/469)) ([8b62b1a](https://github.com/morluto/rea/commit/8b62b1a71586e9409e4dd645f3d4947ef61e59b1))

## [3.0.0](https://github.com/morluto/rea/compare/rea-agents-2.7.0...rea-agents-3.0.0) (2026-08-01)


### ⚠ BREAKING CHANGES

* export_evidence_bundle now requires a filesystem path and no longer returns an inline bundle.

### Features

* make evidence bundles canonical MCP resources ([1712e6d](https://github.com/morluto/rea/commit/1712e6d821965ce5edc3880fe4ebab2e3cc02fd4))


### Bug Fixes

* address MCP resource review feedback ([f3b3fb0](https://github.com/morluto/rea/commit/f3b3fb07ded3d1ad72c0a4f24ca3147ef9722c5d))
* align aggregate tools with session capabilities ([ede91ff](https://github.com/morluto/rea/commit/ede91ff1f04563001f695ec3869daeb3c826154a))
* **ci:** align Vitest project worker budgets ([f47ee1a](https://github.com/morluto/rea/commit/f47ee1abb4fc8dbd5da3fa13c5870d6580b28bfa))
* **ci:** allow documented public type aliases ([97f6a0f](https://github.com/morluto/rea/commit/97f6a0f3fd2ebf8fa884d7f7ba6e1c66ecfe80e0))
* **ci:** make coverage report merging composable ([788f405](https://github.com/morluto/rea/commit/788f4057aee65dfae441249d2c9789bb996912a7))
* **ci:** stabilize Vitest project routing and shards ([f07acde](https://github.com/morluto/rea/commit/f07acde513d4c74d027b66e143cf5072246b412b))
* **errors:** preserve actionable analysis diagnostics ([0f96bf3](https://github.com/morluto/rea/commit/0f96bf365c330a7eb121a173bfa140cc2b652764))
* **mcp:** clarify routing and advertise input examples ([969519c](https://github.com/morluto/rea/commit/969519c00f31b5bc0f23dcffe8867e091461fda6))
* **mcp:** clarify target routing and caller diagnostics ([3e1e8cd](https://github.com/morluto/rea/commit/3e1e8cd3f829e6d3ac8b3c63d979f9db84dec826))
* **test:** bound boundary worker pressure ([935721d](https://github.com/morluto/rea/commit/935721df10d25d23621dbc2be90d334644e0858c))
* **test:** honor boundary ownership and public aliases ([92a1c33](https://github.com/morluto/rea/commit/92a1c33625ff88d81581554687e7708dd3c91e2d))
* **test:** retain subprocess coverage and cleanup ([7f46bb1](https://github.com/morluto/rea/commit/7f46bb18241bf3815e5e01816277d0cafe8f923b))
* **test:** retain subprocess coverage and cleanup ([dae2b9c](https://github.com/morluto/rea/commit/dae2b9cc4e8753827702ada6e51f2ee01811cfed))
* **test:** stabilize boundary timing ([f0d8cda](https://github.com/morluto/rea/commit/f0d8cdafa86bafdc6ad5d8c2d23a97ef583b53d5))
* **verify:** follow dynamic Hopper tool availability ([281e41f](https://github.com/morluto/rea/commit/281e41f7660066addcc7a204128fb1f49bf7a674))


### Code Refactoring

* preserve provider-neutral runtime seams ([a8161f0](https://github.com/morluto/rea/commit/a8161f0e5540f3261a08015dfe56a4254980c064))


### Documentation

* document resource snapshot workflow ([2a45d8d](https://github.com/morluto/rea/commit/2a45d8de7d52d0a234672d03c7dae794859f8ced))
* refresh generated SDK metadata ([c824db1](https://github.com/morluto/rea/commit/c824db1ab7aed2886e9050c1b7fe2136b77e3698))
* refresh managed completion manifest ([59d4659](https://github.com/morluto/rea/commit/59d465971ea86f933e9037fa32ac2787d935d076))


### Tests

* **contracts:** cover validation branches ([8ccdb33](https://github.com/morluto/rea/commit/8ccdb33dd25922e039140bcd1e3cbf3d5acee837))
* derive MCP SDK identity expectations ([ab4193c](https://github.com/morluto/rea/commit/ab4193c1f48020ff6baa42cb75e033110ee72b36))
* **eval:** cover navigation and address tool routing ([ba098f2](https://github.com/morluto/rea/commit/ba098f24e59efbd567ae8438f65e31af0f0b8050))
* overhaul deterministic suite architecture ([48053d1](https://github.com/morluto/rea/commit/48053d1032324cce6e2fe782ecba43d1b91a1bba))
* overhaul deterministic suite architecture ([513d9b1](https://github.com/morluto/rea/commit/513d9b15558f9174a8e2c0ab00e31cbc05dbaba7))
* **package:** verify npx upgrade on published releases ([7b6f7be](https://github.com/morluto/rea/commit/7b6f7becd257170cebf80f4f9f9c385b0000f074))
* **package:** verify npx upgrade on published releases ([1f8ad7b](https://github.com/morluto/rea/commit/1f8ad7bc68f50d396715116467f19524da7e05e6))


### Continuous Integration

* document deterministic suite ownership ([3c42403](https://github.com/morluto/rea/commit/3c42403b78b53e7b5358c2bca9bc156ef2c32efd))

## [2.7.0](https://github.com/morluto/rea/compare/rea-agents-2.6.0...rea-agents-2.7.0) (2026-07-28)


### Features

* **bytecode:** add JVM and Python bytecode providers ([1a75f8d](https://github.com/morluto/rea/commit/1a75f8dc236d8269a5fa07e042471ac79e79d728))
* **bytecode:** add JVM and Python bytecode providers ([4e0127d](https://github.com/morluto/rea/commit/4e0127d620377e5dc7e09444f9db0977e3d47ed1)), closes [#367](https://github.com/morluto/rea/issues/367)
* **conformance:** add portable conformance export package format ([91fb87d](https://github.com/morluto/rea/commit/91fb87d17e7885439762667c96167af79a2e044e))
* **conformance:** add portable conformance export package format ([4ee30e4](https://github.com/morluto/rea/commit/4ee30e4145db9b496158cd980af05e22010856a7))
* **metadata:** add deeper ObjC/Swift metadata and database save/licensing ([4602efd](https://github.com/morluto/rea/commit/4602efd27cbf8701c2dc15542042bc9d9ef76e7f))
* **metadata:** add deeper ObjC/Swift metadata and database save/licensing ([d7a0753](https://github.com/morluto/rea/commit/d7a07535b0fb61ee8f9ae648bb673dda23290653)), closes [#353](https://github.com/morluto/rea/issues/353)
* **mobile:** add Android APK/AAB/DEX and iOS IPA static investigation providers ([18624df](https://github.com/morluto/rea/commit/18624df5724a2c4d14a4e8e178660456424b2344))
* **mobile:** add Android APK/AAB/DEX and iOS IPA static investigation providers ([fdeeb27](https://github.com/morluto/rea/commit/fdeeb27f23041c19b5857fe7873106f0cd9c6244)), closes [#366](https://github.com/morluto/rea/issues/366)
* **package:** add MSIX/MSI/AppX package, resource, and signature analysis ([0ef1b91](https://github.com/morluto/rea/commit/0ef1b91cf31f6ca53991ee5ca60b4a22f430c01e))
* **package:** add MSIX/MSI/AppX package, resource, and signature analysis ([6c03f83](https://github.com/morluto/rea/commit/6c03f83b1bd55095d136aeb3700733383365ecc4)), closes [#363](https://github.com/morluto/rea/issues/363)
* **pe:** add broader PE/COFF/PDB static inspection ([f942558](https://github.com/morluto/rea/commit/f9425585736a89165390178f245b0f0f5d6cdacf))
* **pe:** add broader PE/COFF/PDB static inspection ([94e6600](https://github.com/morluto/rea/commit/94e6600faf89436e4e2689fda8050792307b268d)), closes [#362](https://github.com/morluto/rea/issues/362)
* **process:** replace procfs sampling with event-backed process-tree capture ([a5e355a](https://github.com/morluto/rea/commit/a5e355a3d52b19e89535449cd923c35e56ccc60d))
* **process:** replace procfs sampling with event-backed process-tree capture ([d5d2e56](https://github.com/morluto/rea/commit/d5d2e56d0461cb0debba540bc658a9938ac30599)), closes [#332](https://github.com/morluto/rea/issues/332)
* **protocol:** add custom TCP/UDP/IPC/XPC and auth-flow capture ([1fb22b4](https://github.com/morluto/rea/commit/1fb22b4c21e3a5581f3928003cc32ddc1cc9530b))
* **protocol:** add custom TCP/UDP/IPC/XPC and auth-flow capture ([6fa6f9b](https://github.com/morluto/rea/commit/6fa6f9b6d9595a480a590766dadcfebb8e7111b5)), closes [#365](https://github.com/morluto/rea/issues/365)
* **protocol:** add gRPC/Protobuf and JSON-RPC/MessagePack capture ([54153ed](https://github.com/morluto/rea/commit/54153ed62cb4f55d1efd4794490c2481ab34e212))
* **protocol:** add gRPC/Protobuf and JSON-RPC/MessagePack capture ([3f336fe](https://github.com/morluto/rea/commit/3f336fefb132971bc6bb37b2b59aa01a5e3be5ca)), closes [#364](https://github.com/morluto/rea/issues/364)


### Bug Fixes

* **catalog:** digest provider projections ([645668b](https://github.com/morluto/rea/commit/645668b70dfdff74582d4ac26cda417947231764))
* **catalog:** digest provider projections ([c4cd033](https://github.com/morluto/rea/commit/c4cd0330e00eeb8e272abbf6ecc6ce961e72f317))

## [2.6.0](https://github.com/morluto/rea/compare/rea-agents-2.5.1...rea-agents-2.6.0) (2026-07-26)


### Features

* complete evidence-backed roadmap workflows ([1a0931b](https://github.com/morluto/rea/commit/1a0931b630587701d495d1634fbafe3638ad5516))
* **hopper:** report bridge progress diagnostics ([7a43420](https://github.com/morluto/rea/commit/7a434200297df85c62c02bb103cf870d14f202f7))
* **native:** inspect API boundaries with evidence ([521139d](https://github.com/morluto/rea/commit/521139d4a57a8ab2e25bb262d2a1fd09fd06be92))


### Bug Fixes

* **setup:** refresh stale local npx bootstrap ([6d37efe](https://github.com/morluto/rea/commit/6d37efe8fa1fb9b09c8eaa3a1ed6b6f63188ae22))
* **setup:** refresh stale local npx bootstrap ([90bb161](https://github.com/morluto/rea/commit/90bb1610f56448846adf85b31d9ae96be12dfb4a))


### Performance Improvements

* **mcp:** reduce cold-start work ([8ec9bb1](https://github.com/morluto/rea/commit/8ec9bb1bfea8bc57441bec72f3fcfbe93cf5d4f4))
* **mcp:** reduce cold-start work ([fecddc0](https://github.com/morluto/rea/commit/fecddc0549a31e99a5ea72cbda84e448b1a961d5))


### Tests

* add critical provider workflow coverage ([4716fa2](https://github.com/morluto/rea/commit/4716fa2ece954f5e53bdda9d1f33afad57d2e151))
* **hopper:** remove brittle diagnostic source assertion ([40bf55b](https://github.com/morluto/rea/commit/40bf55b74ca6b2c90b3243a29018cb75879ba081))
* **investigation:** prove multi-version fixture closure ([5184816](https://github.com/morluto/rea/commit/5184816199895ceff6a489810e12fba0c2c41eb7))
* **mcp:** stabilize lazy-loading verification ([7157ab0](https://github.com/morluto/rea/commit/7157ab0b70833cc8237271e8625ccb7965c318c3))
* **package:** prove artifact cleanup and identity ([9522adf](https://github.com/morluto/rea/commit/9522adf19ac915247e2c74b18d3ef5cab95befc5))

## [2.5.1](https://github.com/morluto/rea/compare/rea-agents-2.5.0...rea-agents-2.5.1) (2026-07-25)


### Bug Fixes

* **ci:** normalize generated release metadata ([d43a461](https://github.com/morluto/rea/commit/d43a461958c7bef56a61f75d7f7da73b43e7c387))
* **ci:** normalize release pull request metadata ([119954c](https://github.com/morluto/rea/commit/119954c701533491ccbc4de649592e059f3f5d39))


### Performance Improvements

* **browser:** lazy-load Playwright sessions ([305e729](https://github.com/morluto/rea/commit/305e72995bd52caee7ad8b42aae531b8924e7d0d))
* **dotnet:** reuse authenticated artifact snapshots ([c5e8871](https://github.com/morluto/rea/commit/c5e8871bda737c52d6b09303f9c95e225bf845f2))
* eliminate repeated work in analysis hot paths ([fbe442b](https://github.com/morluto/rea/commit/fbe442b1e2395b93d1bffa2c192ea5ac9a0fab34))
* **evidence:** validate ledger mutations incrementally ([809dfbf](https://github.com/morluto/rea/commit/809dfbfe4868478bf62be40e5f9db35d1b52f6be))
* **javascript:** reuse parsed source across analyses ([adc4852](https://github.com/morluto/rea/commit/adc4852f3aea5bd2847ce9efb53fe43ad030dde6))
* **server:** cache advertised JSON schemas ([6743644](https://github.com/morluto/rea/commit/674364443dc12b89fe6444fdfb364f1b53086f90))

## [2.5.0](https://github.com/morluto/rea/compare/rea-agents-2.4.0...rea-agents-2.5.0) (2026-07-24)


### Features

* add runtime reconstruction roadmap workflows ([1dbb157](https://github.com/morluto/rea/commit/1dbb15734f484db5f4945bd1d1805d8763bfef0e))
* **analysis:** add bounded memory and call tracing ([8e7709d](https://github.com/morluto/rea/commit/8e7709d35ae0ab49392418106b67c2eaa9ea82dc))
* **artifacts:** add provider-neutral inspection ([d997728](https://github.com/morluto/rea/commit/d9977286f95090b5db3afab78573fa29841f7e90))
* **browser:** capture controlled Playwright scenarios ([1ac3118](https://github.com/morluto/rea/commit/1ac3118aa29d846c266edd1e8cd504c4707cf4df))
* **browser:** compare scenario and storage evidence ([f27dd74](https://github.com/morluto/rea/commit/f27dd745b8e398bba544a97374eed9a45aa4b688))
* **javascript:** compare source with shipped bundles ([697be94](https://github.com/morluto/rea/commit/697be942e8780f3b94aaa6e9fd37432c0bb31b47))
* **javascript:** recover runtime semantic effects ([38c883b](https://github.com/morluto/rea/commit/38c883bbc8a8d059ef21cdd85272e6f31a9ee45c))
* **process:** support explicit stdin closure ([205bf15](https://github.com/morluto/rea/commit/205bf1529bf0679095f817ef2bc82c9e8166a669))
* **reconstruction:** add obligation ledgers ([9d48ca7](https://github.com/morluto/rea/commit/9d48ca788cacabb5bc329e9cc0467784359c5d6d))
* **reconstruction:** evaluate end-to-end readiness ([38ff741](https://github.com/morluto/rea/commit/38ff7418efc3299150f3a8a1eab65e8314ef7aa3))
* **runtime:** add passive V8 Inspector observation ([8271650](https://github.com/morluto/rea/commit/82716509451fff1d0b1f91d8e9479b9c7d94ec20))
* **server:** advertise available tools dynamically ([035e114](https://github.com/morluto/rea/commit/035e1144b0295434c6f3c7295d4b576ef72de396))


### Bug Fixes

* **analysis:** report call-edge truncation ([6039b92](https://github.com/morluto/rea/commit/6039b92be7af50e9f94095b4c6b375293ae38df4))
* **browser:** close scenario containment gaps ([1bd65f6](https://github.com/morluto/rea/commit/1bd65f68bc632345b74a62bffe4394c84415a7f2))
* **browser:** contain scenario pages and preserve inputs ([24b3dc4](https://github.com/morluto/rea/commit/24b3dc41dff1862405d6926aa618a60d06c737b1))
* **browser:** require storage fingerprint approval ([f0069cb](https://github.com/morluto/rea/commit/f0069cbee4551e7988cfc4865ccf03dda48dc0dd))
* **ci:** allow slower real browser startup ([095c75d](https://github.com/morluto/rea/commit/095c75df2349b9da5b8a2222eecd8fec67149f0c))
* **ci:** propagate readiness verifier failures ([9f9f9c3](https://github.com/morluto/rea/commit/9f9f9c39688f9201fbb5dfa2826e576873c2e3d8))
* **ci:** repair cross-platform package verification ([1c9e508](https://github.com/morluto/rea/commit/1c9e50814e3e3a7797c463e00e06afeb6afd0e20))
* **comparison:** preserve uncertainty and v1 inputs ([b9217dc](https://github.com/morluto/rea/commit/b9217dcd746a842f92c0ae0012b35fb8ab9fa310))
* **hopper:** add bounded analysis recovery ([e0bc7fd](https://github.com/morluto/rea/commit/e0bc7fd973b26448fb2192a2059ab1229bec0817))
* **javascript:** keep digestless bundle matches unknown ([5a76aaf](https://github.com/morluto/rea/commit/5a76aaffde3c728f8984e917ff53aa2a628f5941))
* **process:** expose launcher identity mismatch ([62ac73c](https://github.com/morluto/rea/commit/62ac73cdd79bee708d50b17a2dde8c23e0b66f1e))
* **process:** normalize macOS launcher identity ([9c3aec8](https://github.com/morluto/rea/commit/9c3aec81317cd6caf627f13ebb0c6dc0f6735516))
* **process:** tolerate exit during ownership revalidation ([a0f8b72](https://github.com/morluto/rea/commit/a0f8b72b7a4c90184390d5412690d3df20da047d))
* **reconstruction:** authenticate obligation proof boundaries ([7b1e3bd](https://github.com/morluto/rea/commit/7b1e3bda00e4f9737a8882983b8750345eb7e1e2))
* **reconstruction:** bind proof evidence to claims ([83b3368](https://github.com/morluto/rea/commit/83b3368d8debf95df29095ef53a4112ca666bcb2))
* **runtime:** preserve deterministic context identity ([9bd2ac5](https://github.com/morluto/rea/commit/9bd2ac590c00703826283ef11b35a0ba2149bfa1))
* **test:** use direct Node launcher on macOS ([13f3372](https://github.com/morluto/rea/commit/13f3372a8beaa165473bd7ecaccaa2997dcbf2ab))


### Performance Improvements

* **test:** speed up local and CI validation ([1546a8d](https://github.com/morluto/rea/commit/1546a8db029a56ed705e5246a6bf7020227234ce))
* **test:** speed up local and CI validation ([42fbbb2](https://github.com/morluto/rea/commit/42fbbb297b8f40bcfbbfa219a1de098f3d0780ad))


### Code Refactoring

* **application:** reuse graph evidence resolution ([4e8aa98](https://github.com/morluto/rea/commit/4e8aa98267bb837033bf0ced58afc52d24f42492))
* **browser:** centralize scenario metadata budgeting ([e79e367](https://github.com/morluto/rea/commit/e79e36785b51cf8c27a27516280a8f83a9ebd2cc))
* **browser:** clarify inspector capture identifiers ([ca035a7](https://github.com/morluto/rea/commit/ca035a75eb6b7d1a79a928cdde572b9cb1df0d54))
* **browser:** reuse CDP endpoint parsing ([00abf45](https://github.com/morluto/rea/commit/00abf45d2085464fd6090a44f786a53669111177))
* **javascript:** centralize source range comparison ([c9500d3](https://github.com/morluto/rea/commit/c9500d32f69e8076255d4206203a41e39bab8dcb))
* **javascript:** share semantic call-site lookup ([94a2c60](https://github.com/morluto/rea/commit/94a2c6013da122899f3d9aefbe5a0bf608033076))
* **reconstruction:** isolate ledger coverage ([4f62695](https://github.com/morluto/rea/commit/4f62695a5cfc9e627387b0a04c1cebe253debbc8))
* **server:** reuse availability policy type ([eeb4349](https://github.com/morluto/rea/commit/eeb4349f1f130b2bde9b0f89382d36a66553cbf1))


### Documentation

* document roadmap analysis workflows ([f29f683](https://github.com/morluto/rea/commit/f29f6834230fd0d3850c558c28af8a43746533c5))
* refresh generated roadmap metadata ([f904668](https://github.com/morluto/rea/commit/f904668fbcba9a7866c6cde21e9628cfa2afe7aa))


### Tests

* **browser:** use neutral scenario fixture identifiers ([fd25a7e](https://github.com/morluto/rea/commit/fd25a7e15aa2eba0bef01269e5061254b607bfdd))
* **package:** stabilize fake Hopper ownership ([0b70131](https://github.com/morluto/rea/commit/0b7013134c58085b72177f2954e55534be053ebe))


### Continuous Integration

* verify runtime observation and readiness ([9349ff5](https://github.com/morluto/rea/commit/9349ff5921fbd1bc7ac8b8d1d27bef0f36b76d92))

## [2.4.0](https://github.com/morluto/rea/compare/rea-agents-2.3.0...rea-agents-2.4.0) (2026-07-23)


### Features

* **artifacts:** support MSIX and AppX packages ([6e6cce1](https://github.com/morluto/rea/commit/6e6cce1bf3cbd9c48799bee9969c53d66c42162e))
* expand reactive capture and package analysis ([9da1794](https://github.com/morluto/rea/commit/9da179425e83df9f255597437320c1ab6ff5c5c2))
* **process:** add reactive capture scenarios ([69761e9](https://github.com/morluto/rea/commit/69761e95b63ec7617aa161f7a1b4e3c8847a6175))


### Bug Fixes

* **capabilities:** expose typed availability codes ([b906def](https://github.com/morluto/rea/commit/b906defbff28885a1d39f78da7c2b7170a7108c6))

## [2.3.0](https://github.com/morluto/rea/compare/rea-agents-2.2.0...rea-agents-2.3.0) (2026-07-23)


### Features

* complete REA remediation program ([d25e98c](https://github.com/morluto/rea/commit/d25e98c3f9f16e1758ee2a7b5ea44ed6d9534351))
* **evidence:** generate verifier completion ledgers ([c02d33f](https://github.com/morluto/rea/commit/c02d33f381b42028186dcf76e3fb1976a42488bf))
* **evidence:** generate verifier completion ledgers ([f5b3e22](https://github.com/morluto/rea/commit/f5b3e22e720011fa346ee17acaaa927e3379499f))
* **javascript:** add bounded semantic relation graph ([b3939ea](https://github.com/morluto/rea/commit/b3939ea9ffc79a6f0998af76b0f6c9f166d2963b))
* **javascript:** add bounded semantic tracing ([56c1a66](https://github.com/morluto/rea/commit/56c1a669d7edb295ecfce1d348ef7c043ee48390))
* **javascript:** add local semantic call flow ([a26a1c7](https://github.com/morluto/rea/commit/a26a1c73df019e060a5ca50208e71dad1eb55f1e))
* **javascript:** expose bounded semantic tracing ([508a9cc](https://github.com/morluto/rea/commit/508a9ccde9c4beef2fa4dbd39093a1030287e967))
* **process:** add bounded reactive scenario domain ([42f3b9c](https://github.com/morluto/rea/commit/42f3b9c2ec46f48fa680489259fce4841d3ddc0b))
* **process:** add bounded reactive scenario domain ([d34463c](https://github.com/morluto/rea/commit/d34463c27c9b5d71c9e2e3b33cdaef2eab5b99de))
* **process:** add direct replay machine runner ([3df9a07](https://github.com/morluto/rea/commit/3df9a074136faf9c279c9ea936de33f25b6dd447))
* **process:** compare declared concurrent traces ([d81745c](https://github.com/morluto/rea/commit/d81745cb95b1564b94bf260d4f737d03b4625849))
* **process:** coordinate reactive capture effects ([b874efd](https://github.com/morluto/rea/commit/b874efd96824e98ac2120b93368e30a921dcf872))
* **process:** coordinate reactive capture effects ([db9a831](https://github.com/morluto/rea/commit/db9a83190b841c8195da0b3036644831770ba369))
* **process:** record global capture event order ([8bcdb98](https://github.com/morluto/rea/commit/8bcdb986893becd151c4dbb825f69bb6ced8b52e))
* **process:** record provider and verifier run lineage ([02b01d4](https://github.com/morluto/rea/commit/02b01d4193a78a1180e5dd467a4e85838546fcde))
* **process:** record provider and verifier run lineage ([513fa29](https://github.com/morluto/rea/commit/513fa294a49cd5059d4039e1d267e003b0234fad))
* **process:** run finite-state replay during capture ([820af60](https://github.com/morluto/rea/commit/820af60c25cb342d74a06d733b8eac8be814ef6b))
* **process:** run finite-state replay during capture ([34c583a](https://github.com/morluto/rea/commit/34c583a170782b4b28d16a2ec33223922608008d))


### Bug Fixes

* **browser:** redact transitional target titles ([f6095cb](https://github.com/morluto/rea/commit/f6095cb6ba9db4e69e7bcd64643c59c8ac129a4c))
* **cli:** retain bundled skill and bias setup wizard toward apply ([5692b3f](https://github.com/morluto/rea/commit/5692b3f809a6868c7c1e4b6f17ca03ad84557427))
* **cli:** retain bundled skill and bias setup wizard toward apply ([fec5c3c](https://github.com/morluto/rea/commit/fec5c3ce7fc8899bf312a67da2c39e8615781748))
* **cli:** route JavaScript applications from analyze ([737940c](https://github.com/morluto/rea/commit/737940c90c7507a1b0ede3e839598c922ca7a81e))
* **cli:** route JavaScript applications from analyze ([74965d9](https://github.com/morluto/rea/commit/74965d9088cca6e048a62352567b95c63c6621d2))
* **javascript:** preserve candidate trace ambiguity ([8678b57](https://github.com/morluto/rea/commit/8678b57b5e03b0fb103803eb0a9e9ebda3124647))
* **knip:** ignore ps binary and in-file schema exports ([9960982](https://github.com/morluto/rea/commit/99609823ef496245c18c9630dc9ef82fc748ef1a))
* **mcp:** preserve investigation input policy ([5a908a0](https://github.com/morluto/rea/commit/5a908a03a673fe499421283a9309c52164d14a9d))
* **mcp:** preserve investigation input policy ([f4156d9](https://github.com/morluto/rea/commit/f4156d9663a1847d5b3bbe29f98036b9c76606b4))
* **process:** bound trace comparison semantics ([b4df565](https://github.com/morluto/rea/commit/b4df565b779c4f38ebf1c784dad73bf7f3de68eb))
* **process:** normalize resize frame timestamps ([74d1c7b](https://github.com/morluto/rea/commit/74d1c7b2748a88341b98bd463be3ad227501c4f4))
* **process:** normalize resize frame timestamps ([77696df](https://github.com/morluto/rea/commit/77696dff9144fd6c110247711bbff144ec63b19b))
* **process:** preserve nonconforming differences ([f1cc485](https://github.com/morluto/rea/commit/f1cc48558122a922365a1b71dbf4fb196b037825))
* **process:** preserve replay event causality ([d895e49](https://github.com/morluto/rea/commit/d895e49145222eb02eb34cd7de93c5212884f5cc))
* **process:** protect unrelated Hopper during cleanup ([81539c4](https://github.com/morluto/rea/commit/81539c47fb5dbebec83e83526685b0f6b85095aa))
* **process:** protect unrelated Hopper during cleanup ([e4ee4c9](https://github.com/morluto/rea/commit/e4ee4c963547f026defe3f5e5e2978c1ab2e6f21))


### Code Refactoring

* **process:** extract capture journal recorder ([a32b988](https://github.com/morluto/rea/commit/a32b988a35a31d0fbabaa861eddb6e3bbb363943))
* **process:** split trace comparison domain logic ([75d5a87](https://github.com/morluto/rea/commit/75d5a8705498bf567a9860eef9eecdf4521c9cc6))
* **process:** split trace comparison helpers ([6d8ecd2](https://github.com/morluto/rea/commit/6d8ecd2b88ddd4868ee55bef84bf88a542d4616b))


### Documentation

* **cli:** clarify setup consent comment ([e869137](https://github.com/morluto/rea/commit/e8691378a07b083277e3b963c5f6d179e12d7626))
* refresh Node 24 TypeDoc output ([846193c](https://github.com/morluto/rea/commit/846193c60305242b27f39c69715f332627ba1725))


### Tests

* **browser:** stabilize real shape capture ([bb2e243](https://github.com/morluto/rea/commit/bb2e2432a5ff4634b4f54eff7834b6da826f725f))


### Continuous Integration

* remove redundant typecheck, lint, and format compatibility jobs ([eb27f01](https://github.com/morluto/rea/commit/eb27f01aeef0f531eebeb0342eba6cc507dfa6f4))
* remove redundant typecheck, lint, and format compatibility jobs ([aeb5cb3](https://github.com/morluto/rea/commit/aeb5cb3adb0e43c45017cf61d2a95bac200024ae))
* shard coverage tests and skip docs-only suites ([c736317](https://github.com/morluto/rea/commit/c7363178e7c8c1f8db1e69085bcd0826293e3814))
* shard coverage tests and skip docs-only suites ([fa58082](https://github.com/morluto/rea/commit/fa58082bf0268b9f9f6c7aac2d6871576e7d5fae))

## [2.2.0](https://github.com/morluto/rea/compare/rea-agents-2.1.0...rea-agents-2.2.0) (2026-07-20)


### Features

* **artifacts:** project mobile application inventories ([c6a1a93](https://github.com/morluto/rea/commit/c6a1a93a9aff1efa06a39aae9911f6c704c350f5))
* **artifacts:** project mobile application inventories ([d36b385](https://github.com/morluto/rea/commit/d36b38537821dd2d74d99a9e49eccd569cfaf341))
* **process:** add bounded replay state machines ([fea965b](https://github.com/morluto/rea/commit/fea965b1b82a858fe423df2ef8fb004524f1934e))
* **process:** add bounded replay state machines ([dc0c2e5](https://github.com/morluto/rea/commit/dc0c2e5ac31387138ec47b027bac6a4cbf007ba0))
* **process:** compare repeatable paired experiments ([e9899c0](https://github.com/morluto/rea/commit/e9899c003b72c2799c67d74bd9553c9a03d083dd))
* **process:** compare repeatable paired experiments ([9ab7aa3](https://github.com/morluto/rea/commit/9ab7aa320c2f234e86d16ff8535b11768a0e080e))
* streamline agent integration and MCP routing ([02cb20b](https://github.com/morluto/rea/commit/02cb20b54682bc334077d8e247841e179a26abd7))
* streamline agent integration and MCP routing ([3e3d458](https://github.com/morluto/rea/commit/3e3d45856ede849371027b62ad1a7b0687798951))


### Bug Fixes

* align session filters and Hopper verification ([d7d6bdf](https://github.com/morluto/rea/commit/d7d6bdf474a1672a9b33888044a38672d28ab0ee))
* **artifacts:** align projection provider targets ([560dbda](https://github.com/morluto/rea/commit/560dbda76d9a07ea9291c00bec8a383456ad0e03))
* **artifacts:** bound mobile projection candidates ([0cc9d46](https://github.com/morluto/rea/commit/0cc9d468c4d6f3036b5888d12173157b487371c3))
* **ci:** keep tool kind type internal ([b9bead2](https://github.com/morluto/rea/commit/b9bead2809eca4448ac28f3e2465f8021a109983))
* **ci:** retry published package verification ([0810486](https://github.com/morluto/rea/commit/0810486f636a99b492f26758f6cd0fa65935f5aa))
* **ci:** retry published package verification ([c379455](https://github.com/morluto/rea/commit/c379455da7b32069c861addfbf8d19bb432ddb84))


### Documentation

* refresh generated API links ([a2089a4](https://github.com/morluto/rea/commit/a2089a40671b3edae7db98ce37587da87f093d1b))
* update application projection API ([b0cb28a](https://github.com/morluto/rea/commit/b0cb28a9bf04f849e792346306bb42ed4fac6b29))
* update paired process experiment API ([a222327](https://github.com/morluto/rea/commit/a222327f304555104b51370d0955dc6c8ca4d0ce))
* update replay machine API ([d74f897](https://github.com/morluto/rea/commit/d74f89754fe4e5c19a757893a3fe388f2c64372f))


### Tests

* budget CLI output variant subprocesses ([8d3587b](https://github.com/morluto/rea/commit/8d3587bbcac18e90652cc95e5853158a4f9aef18))
* cap workers across all hosts ([bc80359](https://github.com/morluto/rea/commit/bc8035918b1d6a3eac7fc2307867d4dc2787d3b5))
* inherit root options in Vitest projects ([168100e](https://github.com/morluto/rea/commit/168100e5326958fc89431a26a1f3cca762516133))
* isolate slow filesystem and CLI suites ([c2e134b](https://github.com/morluto/rea/commit/c2e134b8e46d780b61faab1021772704380e6a37))
* stabilize subprocess-heavy integration suites ([a556e94](https://github.com/morluto/rea/commit/a556e945096fd9430fc48217a2f4b6dc3d06518c))

## [2.1.0](https://github.com/morluto/rea/compare/rea-agents-2.0.0...rea-agents-2.1.0) (2026-07-18)


### Features

* add managed characterization and coverage closure ([1943496](https://github.com/morluto/rea/commit/194349683a19ee8b35c1bd9b124d032e83e6867a))
* add managed characterization and reconstruction coverage ([02c913b](https://github.com/morluto/rea/commit/02c913bcdab5904e1b6ce8a24940b75ddc20c826))
* **cli:** add explicit package-runner setup wizard ([891a11f](https://github.com/morluto/rea/commit/891a11f315d02628bbf04f290d211e48d1916a1d))
* **cli:** improve setup onboarding ([4851449](https://github.com/morluto/rea/commit/4851449f715af122d02e5517b4f6b925962f2a01))
* **cli:** improve setup onboarding ([16002ff](https://github.com/morluto/rea/commit/16002ff3c216ecd91e9c28bab8de288f3b553e57))
* **cli:** support package-name setup wizard ([1b90e7f](https://github.com/morluto/rea/commit/1b90e7f992276e4e05644823583f77c27ccac702))
* **doctor:** admit the Windows x64 Ghidra boundary ([32dda0c](https://github.com/morluto/rea/commit/32dda0c19eee5ddf91a35d9e21374f9cb111b07d))
* **dotnet:** add BYO ILSpy oracle diagnostics ([aa200ce](https://github.com/morluto/rea/commit/aa200ce8ca5690113a39259e91ab1ae9edc0b436))
* **ghidra:** add authenticated Windows loopback transport ([629ffc3](https://github.com/morluto/rea/commit/629ffc3872cdf2f3dabbe053890ac6a4103fdd1c))
* **ghidra:** bind imports to admitted target bytes ([be19c3f](https://github.com/morluto/rea/commit/be19c3fd12da55df84d92c5ec2641fe739df0438))
* **ghidra:** define the Windows P0 admission boundary ([6b1fd16](https://github.com/morluto/rea/commit/6b1fd166b0a6d37af9d42c38c5fd587fe3989659))
* **ghidra:** inspect Windows headless installations ([86e44be](https://github.com/morluto/rea/commit/86e44bef08d36cc1b56e44b7b544d5d6d21d141d))
* **ghidra:** launch bounded Windows headless sessions ([bc0fb45](https://github.com/morluto/rea/commit/bc0fb45f16db97d3f79860d850c9f2fe0f6b7b22))
* harden authority and runtime conformance boundaries ([b537ebf](https://github.com/morluto/rea/commit/b537ebfa3460f782c2aee4996ced2e726f7d6328))
* **javascript:** add binding and constant-value semantic IR ([3ea8523](https://github.com/morluto/rea/commit/3ea852323aa9a0509691105d47f5e5622c24050b))
* **javascript:** add binding and constant-value semantic IR ([3d71bb5](https://github.com/morluto/rea/commit/3d71bb551e3353df23afa5832883e5074fe0f2d0))
* **javascript:** add webpack and rspack runtime adapters ([7bccb7c](https://github.com/morluto/rea/commit/7bccb7c6ae2f48a37e053cfd871309971e81bbc4))
* **javascript:** add webpack and rspack runtime adapters ([44c7017](https://github.com/morluto/rea/commit/44c70176b845e2900244151aaadb7a4dc3f8b302))
* **javascript:** recover commonjs and esm module relationships ([9766fc0](https://github.com/morluto/rea/commit/9766fc04c13a366fa449f60cccabb1c97d68e84d))
* **javascript:** recover commonjs and esm module relationships ([6c41791](https://github.com/morluto/rea/commit/6c41791519069811d0be0115c450801432f96660))
* **permissions:** add scoped process capture elicitation ([e6cfce3](https://github.com/morluto/rea/commit/e6cfce3902a8f0c403caa07e2c597e8156aa5498))
* **skill:** rename skill to reverse-engineer-anything ([9356634](https://github.com/morluto/rea/commit/9356634ccba8d913a376798dae47bb3c4a86c07a))
* **target:** classify Windows PE admission metadata ([24274fe](https://github.com/morluto/rea/commit/24274fe6b694c5bf08ae21fd7f4afa1846f67ef2))
* **windows:** define native authority boundary ([a1a6b42](https://github.com/morluto/rea/commit/a1a6b4200ed638b1ea4d186ae1253805032d002a))


### Bug Fixes

* **build:** preserve native generated-file line endings ([00a3078](https://github.com/morluto/rea/commit/00a3078148e90a2d45648891f96158378c2561ce))
* **ci:** remove retired native rebuild steps ([2d22731](https://github.com/morluto/rea/commit/2d22731ebb3f81483ec8a561ed8b1cb313b4eac1))
* **ci:** validate packaged Windows CLI commands exactly ([43418ee](https://github.com/morluto/rea/commit/43418ee9112358d81d56d78b5cbe1ca37f6099be))
* **cli:** require explicit setup selections ([992ec50](https://github.com/morluto/rea/commit/992ec505b279114dcb13230fcd008db8668578af))
* **contracts:** make agent-facing schemas self-describing ([0df11dd](https://github.com/morluto/rea/commit/0df11dd4d1de4cb1c4fab6562d874e3be285aeec))
* **dotnet:** admit real CLI GUID and fat CIL bodies ([735973b](https://github.com/morluto/rea/commit/735973b08b364d45a8e2a551e17ad96c31b039c9))
* **dotnet:** correct CLI pointer and byref signatures ([1387be0](https://github.com/morluto/rea/commit/1387be08dd398ca8ef92410307fe35faa8936ed5))
* **dotnet:** correct CLI pointer and byref signatures ([fb9ff56](https://github.com/morluto/rea/commit/fb9ff5659dffb6af5185c9465ddac6e86eca7dd2))
* **dotnet:** downgrade truncated CIL identity and coverage ([736a4e1](https://github.com/morluto/rea/commit/736a4e1480fb34df12b00372c697acc327b0046c))
* **dotnet:** downgrade truncated CIL identity and coverage ([dae6807](https://github.com/morluto/rea/commit/dae6807c4a4aad7a20c4b9da085e39dcfb58430a))
* **electron:** keep missing unpacked ASAR entries unavailable ([fb6964a](https://github.com/morluto/rea/commit/fb6964a74ea60751560a6d10366bfdad3dab4535))
* **electron:** resolve package and dirname entrypoints by context ([4847fc4](https://github.com/morluto/rea/commit/4847fc4fc14114cbb15350a23f6db4a2ad7962fe))
* **electron:** resolve package and dirname entrypoints by context ([1ac9a09](https://github.com/morluto/rea/commit/1ac9a09ce1574b202d98177392628ba468a568df))
* **ghidra:** preserve native endpoint diagnostics ([5970a71](https://github.com/morluto/rea/commit/5970a7182481656e30a8ad51e4855d4c8e50eed7))
* **ghidra:** preserve Windows batch invocation semantics ([0ac418d](https://github.com/morluto/rea/commit/0ac418dd8be62357f852767a64f0d5b5c78495cc))
* **ghidra:** validate Windows control characters explicitly ([4dccbec](https://github.com/morluto/rea/commit/4dccbecf064b56b0d33c7d8c926772353667c739))
* **managed:** emit valid x64 conformance PE ([dcd94f1](https://github.com/morluto/rea/commit/dcd94f1472cbdfd5fff90eb26bbac68f5fb2b06b))
* **managed:** emit valid x64 conformance PE ([c52a822](https://github.com/morluto/rea/commit/c52a8223c62ab85373eb86a68dbdc626648aa40f))
* **managed:** preserve page incompleteness in graph and comparison ([a6f02a0](https://github.com/morluto/rea/commit/a6f02a05a48254e46a6485cedfadda426ab60e21))
* **managed:** preserve page incompleteness in graph and comparison ([8ee0f04](https://github.com/morluto/rea/commit/8ee0f04562814e44f77fd8a0f19184c127bcf92e))
* **mcp:** clarify advertised schema fields ([1581e40](https://github.com/morluto/rea/commit/1581e40fce733c19e11b460b47722e4121e9fd0e))
* **npm:** use latest entry points without install scripts ([34252f5](https://github.com/morluto/rea/commit/34252f55e963fcd63c0fd127dc249ba2c8398082))
* **npm:** use latest entry points, remove install scripts, and rename skill ([bf85ee6](https://github.com/morluto/rea/commit/bf85ee62c976dd06fdc47429a9b3c7f3d99b7f3b))
* preserve optional unknown filters ([db1efef](https://github.com/morluto/rea/commit/db1efef9d285d1726f56c288593161434b9f322f))
* remove unused boundary exports ([49f1ec1](https://github.com/morluto/rea/commit/49f1ec14fe4f5b67345ff9dde8af8ef1066fb3c8))
* satisfy dead-code and generated-doc checks ([b15a9ec](https://github.com/morluto/rea/commit/b15a9ecfef55dec00b92babf92883f6dedaa2209))
* **setup:** preserve onboarding after refactor ([da48033](https://github.com/morluto/rea/commit/da48033c191f491f47b9933f65806f0f0a223643))
* **skill:** disclose retired skill cleanup ([4c69e61](https://github.com/morluto/rea/commit/4c69e6120a2c0a630272e845cda2112724c4be7b))


### Code Refactoring

* **adapters:** split oversized provider workflows ([1a99a60](https://github.com/morluto/rea/commit/1a99a60a29c231c7a104c5900c2c20a7d10268d5))
* **app:** split session and CLI workflows ([c6ee004](https://github.com/morluto/rea/commit/c6ee0049c4bffe2880ddb8cf5a2a6c4195ae18f6))
* **domain:** split analysis boundaries ([e2c868c](https://github.com/morluto/rea/commit/e2c868c4bdd4f83f1e33a50bca0e3d91d4605387))
* finish lint cleanup ([2bea405](https://github.com/morluto/rea/commit/2bea40571d47f8b3454cdb9b467839521d3174b4))
* **managed:** split metadata analysis ([20c88dd](https://github.com/morluto/rea/commit/20c88dd5676a3081e13bef26cfa38d8a69856842))
* **setup:** keep planner helpers private ([2d1f961](https://github.com/morluto/rea/commit/2d1f9616b76b9e383d0196b820a377573def836d))
* simplify authorization boundaries ([2e5b443](https://github.com/morluto/rea/commit/2e5b44365fd1ea3c515efd03b56fee0083a20a31))
* simplify doctor and error projections ([37f4ac6](https://github.com/morluto/rea/commit/37f4ac6d7073693fb4d2290b5aff6bcb6b36cd19))
* **skill:** keep only the canonical skill identity ([a7c1e87](https://github.com/morluto/rea/commit/a7c1e87365cec0333bc9431ec5d7418cb7a54be1))
* **skill:** remove legacy skill compatibility ([8cf0dd2](https://github.com/morluto/rea/commit/8cf0dd2bf645d18afe6a9c8493178bdd905c0647))
* split oversized analysis workflows ([af2399e](https://github.com/morluto/rea/commit/af2399eeacbca5f1af344c7d7ef747f3d976bcf7))
* split oversized analysis workflows ([3e61a63](https://github.com/morluto/rea/commit/3e61a63a104859e1c8ca3bcdc6bad0511d1f1735))
* **windows:** keep capability outcomes module-private ([585f523](https://github.com/morluto/rea/commit/585f52389107c79cea99ecd26ea87cbcda08d245))


### Documentation

* **cli:** describe every command input ([d4be3e7](https://github.com/morluto/rea/commit/d4be3e7f9a609050303c82aa83d4884bb6daae77))
* **ghidra:** define the experimental Windows P0 ([8b5ae41](https://github.com/morluto/rea/commit/8b5ae417f3a69e679ad69574f13d1d179ebb22c3))
* **managed:** align normalized CIL claims with shipped v1 semantics ([9a92a79](https://github.com/morluto/rea/commit/9a92a7958cceedafe184b48ca93ab094386401a7))
* **managed:** align normalized CIL claims with shipped v1 semantics ([3f788e9](https://github.com/morluto/rea/commit/3f788e9065d5ce457ba174c13bc8e4e0b74d5156))
* normalize inherited source paths ([d33213a](https://github.com/morluto/rea/commit/d33213a99c824b5834323c924dac6b7852df5831))
* preserve generated source links ([2ea375f](https://github.com/morluto/rea/commit/2ea375f8ea413aba05baab0d9af3e3401d8b2956))
* prioritize agent usability in tool design ([ad17fe7](https://github.com/morluto/rea/commit/ad17fe7aa71f5cbffcdff3e27b08bc4538e73c7d))
* refresh Electron path resolution API ([734a4ef](https://github.com/morluto/rea/commit/734a4ef04fce7bbff76b3fbf9c3f1250d7ab8963))
* refresh generated API reference ([f5f653b](https://github.com/morluto/rea/commit/f5f653bd8dba8d441efe13f2404b8677dc6dd8f3))
* regenerate managed coverage API with Node 24 ([e47c00e](https://github.com/morluto/rea/commit/e47c00ef04b537bd67caff69d27f48a81bdf04e3))


### Tests

* add limit monotonicity and partial-evidence regressions ([2cce98c](https://github.com/morluto/rea/commit/2cce98cca29ab8752c34281c4b439a0150308b2c))
* add limit monotonicity and partial-evidence regressions ([4afd970](https://github.com/morluto/rea/commit/4afd97029c3eebc0c755b0c9dee2fd74217a1305))
* **ci:** guard Windows Ghidra workflow isolation ([81ed68f](https://github.com/morluto/rea/commit/81ed68f67d8332b3013131dc6d86a001d1dc55a3))
* **ci:** guard Windows Ghidra workflow isolation ([98540c8](https://github.com/morluto/rea/commit/98540c8a12722aaa005102518746916018107ccb))
* **cli:** cover package-name binary alias ([40e2f94](https://github.com/morluto/rea/commit/40e2f943a52cbf957db2ae898c3624e5ac5faec6))
* **hopper:** add semantic runtime conformance ([da1da3b](https://github.com/morluto/rea/commit/da1da3bfb83e2fdd2a7a0a84a6a70aa73a4a68d6))
* **package:** align setup preflight contract ([b33ebb1](https://github.com/morluto/rea/commit/b33ebb1627423a09fa56b628284362118e68ca40))


### Continuous Integration

* **ghidra:** add Windows P0 acceptance and real-engine lanes ([0b35510](https://github.com/morluto/rea/commit/0b3551076d591be04efbb829d3eb1d17bcc828a9))

## [2.0.0](https://github.com/morluto/rea/compare/rea-agents-1.7.0...rea-agents-2.0.0) (2026-07-16)


### ⚠ BREAKING CHANGES

* **mcp:** require Evidence for managed reconstruction
* **mcp:** comparison tools now require session-owned Evidence IDs or approved bundle paths, and structured Evidence results use compact references.

### Features

* **application:** add cross-layer graph workflows ([778b995](https://github.com/morluto/rea/commit/778b995bbfd4b4bb28ace9bf0f7428e50cd1be50))
* **application:** add isolated JavaScript replay ([d86231a](https://github.com/morluto/rea/commit/d86231ad33e750c2a6ef60a33d833ac8db9219be))
* **dotnet:** add managed artifact triage ([c251c38](https://github.com/morluto/rea/commit/c251c38aa2ead24e4aaeb95678a10dddaa212dc4))
* **dotnet:** add managed member comparison ([55794d6](https://github.com/morluto/rea/commit/55794d6083d6746fa2c7ad08a5f548c05272b1ae))
* **dotnet:** add managed member inspection ([98cad37](https://github.com/morluto/rea/commit/98cad3788d05ae31d86bb448d6fa8e5ebb1c742c))
* **dotnet:** add managed native boundary inspection ([466b1bb](https://github.com/morluto/rea/commit/466b1bbebee8c9266708de885b5e5405d23d0b7c))
* **dotnet:** add managed runtime correlation planning ([5f66cfd](https://github.com/morluto/rea/commit/5f66cfd57aeec39bb3337cbbbc2b7c3c8460df54))
* **dotnet:** import managed reconstructions ([c506664](https://github.com/morluto/rea/commit/c5066647445f3a8be0a9df4ff0f41b7e478f79b5))
* **dotnet:** verify managed native boundaries ([8cbc125](https://github.com/morluto/rea/commit/8cbc125b9393f3cc84a8a1b4e1cb160714c833ad))
* **electron:** map static process and IPC boundaries ([3fa2304](https://github.com/morluto/rea/commit/3fa2304bc70beb96cf30feb51bb6d7ac4fb7a2b0))
* **electron:** reconcile static artifacts with passive runtime ([8c67dbd](https://github.com/morluto/rea/commit/8c67dbd49e74b2f304a03845a8a55e6a433cc915))
* **managed:** project static evidence into application graph ([6194c1a](https://github.com/morluto/rea/commit/6194c1a781a97043dbd02f0f6717c17598459abe))
* **managed:** project static evidence into application graph ([77178bb](https://github.com/morluto/rea/commit/77178bba543ed40b5cb29d301ad930e698a1968c))
* **mcp:** harden contracts and evidence references ([ee1cd40](https://github.com/morluto/rea/commit/ee1cd40405405097b9d5f9686cbcc765ab03d96a))
* **mcp:** require Evidence for managed reconstruction ([d36af5d](https://github.com/morluto/rea/commit/d36af5d0f708637f514f356521242b2b1066c8ed))
* **setup:** verify installed skill catalog identity ([b2d1f2a](https://github.com/morluto/rea/commit/b2d1f2affdc7faa0e1c56feefe596eb39dea0612))


### Bug Fixes

* **deps:** run freshness check from escaped paths ([8a1c128](https://github.com/morluto/rea/commit/8a1c128b67ee41ce054fe984946a5d7bfcc1a3b4))
* **mcp:** align runtime unknown argument validation ([d1e7220](https://github.com/morluto/rea/commit/d1e72207f48609e3214a66c2a248c70a2a1abd6c))
* **mcp:** hide managed workflows without a session ([412bbaf](https://github.com/morluto/rea/commit/412bbaf05e0d6fa5add68303c83325628cc2e7da))
* **mcp:** integrate managed contracts after rebase ([9c4a93d](https://github.com/morluto/rea/commit/9c4a93d9b1be36155bd9c0a39d8b541ec3986c64))
* **mcp:** normalize inferred field descriptions ([a807471](https://github.com/morluto/rea/commit/a807471e4e612e215ef82ebd2d16a1c454d5ad31))
* **mcp:** parse adapter inputs exactly once ([37c0f39](https://github.com/morluto/rea/commit/37c0f399544c9424c55e468d6784da61426a458e))
* **mcp:** remove arbitrary schema byte gate ([fd08025](https://github.com/morluto/rea/commit/fd08025dcd21cc31fa1e7356c90e76b4863b1af2))
* **mcp:** remove schema byte compaction ([f728295](https://github.com/morluto/rea/commit/f728295bd00585623b9597cf5702051aefa8ddc9))
* **package:** accept expected doctor diagnostics ([0f2d013](https://github.com/morluto/rea/commit/0f2d01300a4bc9fc534114a6913ec8dfcd5fa457))
* **test:** make host fixtures portable ([f23f529](https://github.com/morluto/rea/commit/f23f52903cb6df4eed6fec0e09f79c82ad9825dc))


### Code Refactoring

* **mcp:** remove obsolete managed evidence parser ([f7aa191](https://github.com/morluto/rea/commit/f7aa19154d9bc24b3ccdb8bde40ee926f06049a1))


### Documentation

* **analysis:** define managed-code evidence boundary ([80faff3](https://github.com/morluto/rea/commit/80faff3e5bf8baa65b0b18e03594e86753a76ac6))
* **api:** refresh managed reconstruction contracts ([2b06433](https://github.com/morluto/rea/commit/2b064335ea63db4484d16b35544dd5e8024ecf6d))
* **dotnet:** refresh managed reconstruction api ([cc1e47c](https://github.com/morluto/rea/commit/cc1e47c615bbbb6d2f7dc24ec1710c39e4b96bf4))
* refresh application workflow API links ([4a30820](https://github.com/morluto/rea/commit/4a30820a93a33f4ebb7b69202890c5c6a114ba0f))
* refresh managed native verification api ([849c052](https://github.com/morluto/rea/commit/849c05290aced212505c2621f208e89266c3ea96))
* refresh managed runtime api docs ([798631a](https://github.com/morluto/rea/commit/798631ade628464b6b233d240e53b7eea44721a0))
* refresh runtime reconciliation API ([87b2348](https://github.com/morluto/rea/commit/87b23482e28ed4e43674c4b9a775da4b16cb4636))
* **security:** define controlled replay authority ([461990d](https://github.com/morluto/rea/commit/461990da3f8e4ec573217432943f04311d577524))
* stabilize replay API source links ([a8c1057](https://github.com/morluto/rea/commit/a8c1057279d529d9f16ab9b093b0f6518915b6fa))


### Tests

* **dotnet:** add managed conformance verifier ([2b75fcf](https://github.com/morluto/rea/commit/2b75fcfaac8432b08b2d88cd95492333df2674d4))
* **dotnet:** verify managed app graph manifests ([5be4051](https://github.com/morluto/rea/commit/5be405169ef752e34199022e97c5fa4896693472))
* **dotnet:** verify managed app graph manifests ([a5e5c68](https://github.com/morluto/rea/commit/a5e5c68d117cdef33a47291ed4f641c9a89045f3))
* **dotnet:** verify managed app manifests ([793a948](https://github.com/morluto/rea/commit/793a948c1b6a61ce3ba2860fe977b19180c6fa9b))
* **hopper:** avoid scheduler-sensitive exit timing ([6e6827c](https://github.com/morluto/rea/commit/6e6827cd76fc080a959695ab19bfcc34b80c270c))
* **mcp:** cover strict compact wire contracts ([8de25d0](https://github.com/morluto/rea/commit/8de25d02302e7a03c1a0c6ab19ccb459758973ca))
* **mcp:** derive sessionless managed inventory ([cab7c4a](https://github.com/morluto/rea/commit/cab7c4a5212eb5bf2b233c835ac57b5764a4e0f3))
* **replay:** use portable seam executables ([3183f47](https://github.com/morluto/rea/commit/3183f47c0f785bdda52f9db6613932440094c522))

## [1.7.0](https://github.com/morluto/rea/compare/rea-agents-1.6.0...rea-agents-1.7.0) (2026-07-15)


### Features

* **artifact:** reconstruct JavaScript application structure ([aa46abf](https://github.com/morluto/rea/commit/aa46abfe1b59ecab160029c88b0c925ff68d6033))
* **domain:** add versioned JavaScript Application Graph ([2ca5672](https://github.com/morluto/rea/commit/2ca56724e4be7429372904ad26fe97fa5943bcf4))
* **ghidra:** add function analysis and conformance ([d8321de](https://github.com/morluto/rea/commit/d8321defd77c57df424b2635a4a70d38fe9a1fae))
* **ghidra:** add private headless provider session ([f0e625d](https://github.com/morluto/rea/commit/f0e625d7ee5a3f79158514aa93f89fca81a2da6a))
* **ghidra:** implement read-only inventory operations ([b1c07dd](https://github.com/morluto/rea/commit/b1c07dd9c6fe8c4dd109fefe67f4b16fdd1115d1))
* **session:** add explicit provider registry and target binding ([941d710](https://github.com/morluto/rea/commit/941d7101dd3c8b7cdd790724c55ff00a90f42270))


### Bug Fixes

* address setup, upgrade, and process test regressions ([960d759](https://github.com/morluto/rea/commit/960d759cc1979a32ae416c50e6095abfd629fbe7))
* address setup, upgrade, and process test regressions ([02f12b9](https://github.com/morluto/rea/commit/02f12b927a17615150d6e1126d1b841c5dca648b))
* **cli:** make clean source checkouts start reliably ([ed17e76](https://github.com/morluto/rea/commit/ed17e764733c819a1123372ad64d4122ba0c06e3))
* **cli:** make clean source checkouts start reliably ([6ba9765](https://github.com/morluto/rea/commit/6ba97656ca73e97ae1dbecc15a86a193978298b6))
* **setup:** replace managed Hopper on reinstall ([0ca93f9](https://github.com/morluto/rea/commit/0ca93f9779bc6c576479561c488982963fbb9167))


### Code Refactoring

* **domain:** remove provider-specific target and snapshot state ([21da71e](https://github.com/morluto/rea/commit/21da71ec6d30a63e497b871d16a69ab02f5b210b))
* **process:** extract reusable provider lifecycle primitives ([70e1a0f](https://github.com/morluto/rea/commit/70e1a0f5326fa1598e4f4e673a4ba1545cef5b65))


### Documentation

* **api:** refresh profile source anchors ([bd3cf96](https://github.com/morluto/rea/commit/bd3cf964d62bea2571559cfde6bdfe686922255f))
* **api:** refresh provider source anchors ([a7621c2](https://github.com/morluto/rea/commit/a7621c263392a92c63162febf511824c9c788548))
* **architecture:** define provider selection and analysis profiles ([75f8696](https://github.com/morluto/rea/commit/75f8696a57cf25a2a72a2a337d8076214f04ece4))
* **architecture:** define provider selection and analysis profiles ([f9f2fbe](https://github.com/morluto/rea/commit/f9f2fbe2fc04bd202d9fd580fc54c30529809fc0))
* reconcile product documentation with shipped behavior ([addc208](https://github.com/morluto/rea/commit/addc208f12790e3b0e48697c75e978e08814d303))
* reconcile product documentation with shipped behavior ([54056a9](https://github.com/morluto/rea/commit/54056a9782f3f51f8f1b510d8b9c1bf4c3c9f067))
* refresh Ghidra inventory API links ([a45de27](https://github.com/morluto/rea/commit/a45de27d9e97b8c7a76b3e6da12b0b4efdfa5dcb))
* regenerate JavaScript graph API with Node 24 ([da4817a](https://github.com/morluto/rea/commit/da4817abd10fe2d6b68bf4d393d067ce42ece910))


### Tests

* keep package setup verification read-only ([acaf030](https://github.com/morluto/rea/commit/acaf03056d6b457d85c6b7744565d6c7d56c424c))

## [1.6.0](https://github.com/morluto/rea/compare/rea-agents-1.5.0...rea-agents-1.6.0) (2026-07-14)


### Features

* add web and Electron reverse-engineering workflows ([be76f80](https://github.com/morluto/rea/commit/be76f8090b5195680cdf73a8c21f65e6516efc92))


### Bug Fixes

* **application:** add explicit investigation replay ([7112e1e](https://github.com/morluto/rea/commit/7112e1e6bf33bccd605bf3ee5541b83a522831e5))
* **application:** add explicit investigation replay ([a6b5ca4](https://github.com/morluto/rea/commit/a6b5ca4135ac2cf168470b47e97a05d8b67f3147))
* **browser:** keep page endpoint type internal ([3743962](https://github.com/morluto/rea/commit/37439620710d4c47bf48f1df0b099eab0c115446))
* **browser:** observe direct target disconnects ([9be24f8](https://github.com/morluto/rea/commit/9be24f8de14edc04cdd3649e0ea66d53edb72328))
* **browser:** preserve operation-aware cancellation errors ([0aac8aa](https://github.com/morluto/rea/commit/0aac8aaba5a5097d99277d7501dae6fdd017f2d0))
* **browser:** support page-scoped CDP transports ([c4930f4](https://github.com/morluto/rea/commit/c4930f4820dbf114da6fa850500f1415d0d6b7a9))
* **browser:** support page-scoped CDP transports ([bf96192](https://github.com/morluto/rea/commit/bf9619267b45f2383ebdd648dea05a7d2e3945a6))
* **browser:** support relative source map URLs ([5231e95](https://github.com/morluto/rea/commit/5231e95c19d309113a4335fe44a5793e3924219a))
* **cli:** confirm project grant revocation ([6397e54](https://github.com/morluto/rea/commit/6397e54169a55b4fcab7ad92f42bbd8f8c616810))
* **cli:** confirm project grant revocation ([7a4cfb4](https://github.com/morluto/rea/commit/7a4cfb4fbd96df34f5502adbf70f5bfb12bbc56c))
* **cli:** restrict production MCP dispatch ([8bd0e5f](https://github.com/morluto/rea/commit/8bd0e5f1ea7f36b23f83113ef285c31a36ff315c))
* **cli:** restrict production MCP dispatch ([190e5d3](https://github.com/morluto/rea/commit/190e5d3282f0f1bc980ad488a7774a500ae3e87d))
* **doctor:** honor explicit Hopper launcher ([c69fe2c](https://github.com/morluto/rea/commit/c69fe2c897b8f567e1607424690e9d59aaefadf1))
* **doctor:** honor explicit Hopper launcher ([9208592](https://github.com/morluto/rea/commit/9208592f41ed920c32206c78fcf43c8d7db77f22))
* **evidence:** enforce the combined record limit ([c791802](https://github.com/morluto/rea/commit/c7918024bc89995f4054bd499fef88a34a3e24d7))
* **evidence:** enforce the combined record limit ([834c70c](https://github.com/morluto/rea/commit/834c70cf4b9c8dca000c7a20491215d1acc0db89))
* **hopper:** cancel startup before closing ([f471a63](https://github.com/morluto/rea/commit/f471a63c87679eff9564553741d9967724c57f0a))
* **hopper:** cancel startup before closing ([6cc2fdf](https://github.com/morluto/rea/commit/6cc2fdf80ce2d0220fe996ddbed2f0378f5397cd))
* **hopper:** select verified Linux demo mode explicitly ([46e4052](https://github.com/morluto/rea/commit/46e40520285c2338bd1ffedd16599977c333befb))
* **hopper:** select verified Linux demo mode explicitly ([04c5fd6](https://github.com/morluto/rea/commit/04c5fd63b72e6e497363ecbde5e24088eef639cd))
* **native:** harden command capture edge cases ([c2e64a4](https://github.com/morluto/rea/commit/c2e64a42c84bd245f3df4eb8b61039c8594704f8))
* **native:** harden command capture edge cases ([d39f98d](https://github.com/morluto/rea/commit/d39f98d06dd53cdfd427e75e2f45f2c8b8792f50))
* preserve setup diagnostics and clean Knip config ([2d1e021](https://github.com/morluto/rea/commit/2d1e021782dc903faaa401207dad47278bfb57b2))
* preserve setup diagnostics and clean Knip config ([5a7ccef](https://github.com/morluto/rea/commit/5a7ccefc68e3d7359bfd9a6262701641da380d37))
* **process:** gate sampling on initialized PTY root ([57938a8](https://github.com/morluto/rea/commit/57938a8465add2d6e89dae13e66059bad7f72a45))
* **process:** gate sampling on initialized PTY roots ([e831a41](https://github.com/morluto/rea/commit/e831a41375148336d72beadd5d13405047c82e67))
* **process:** keep validation detail internal ([614a119](https://github.com/morluto/rea/commit/614a1197f5b699b61c46d82a24e0564bf0d87829))
* **process:** restrict cleanup to captured group leaders ([40c6f60](https://github.com/morluto/rea/commit/40c6f60ac9a4b86f4cbe28a72e7692e1acf761b1))
* **process:** settle exited zombie groups ([072ce5a](https://github.com/morluto/rea/commit/072ce5aede03a2dab59ce8776a04063218448925))
* **process:** settle exited zombie groups ([4828326](https://github.com/morluto/rea/commit/482832607910a6e872bccc27c956eeaf55dd6056))
* **process:** stabilize and speed up the test suite ([a3b7de9](https://github.com/morluto/rea/commit/a3b7de9fa5e89808a3c01a5623779709edb7c691))
* **reference:** preserve distinct parse failures ([e02cb2f](https://github.com/morluto/rea/commit/e02cb2f877e8fd9874245ee6e15f68666afaeb46))
* **reference:** preserve distinct parse failures ([543510f](https://github.com/morluto/rea/commit/543510f62fd257b42e6a7dfc876112dda0e0ea01))
* rollup batch of fixes ([b348b2c](https://github.com/morluto/rea/commit/b348b2c98772b3d38b33e6aa4d14ae7dce78a4b9))
* **runtime:** apply permission reloads atomically ([49e843e](https://github.com/morluto/rea/commit/49e843e8ff2eb87bf1c6174823191cc97ad1ced8))
* **runtime:** apply permission reloads atomically ([3ae7109](https://github.com/morluto/rea/commit/3ae7109faa29175e84ef695b296ad4db14097a37))
* **runtime:** serialize permission reloads ([7e53dd6](https://github.com/morluto/rea/commit/7e53dd6ad321f9b75dbe458f9e116da7637d740c))
* **runtime:** unregister shutdown handlers ([71072d8](https://github.com/morluto/rea/commit/71072d86b161530d523a10e920e5d67ca220a7e9))
* **runtime:** unregister shutdown handlers ([f9e3c23](https://github.com/morluto/rea/commit/f9e3c23987bdf37be07d6c4602666c6ac90ae0ed))
* **session:** isolate availability observers ([43766fd](https://github.com/morluto/rea/commit/43766fda699f5498909af21e386ae4817159e4cf))
* **session:** isolate availability observers ([e5a80d4](https://github.com/morluto/rea/commit/e5a80d4f06cd0d4bf64e6b94b50f7430829c336a))
* **session:** reopen replaced targets ([e98413c](https://github.com/morluto/rea/commit/e98413c3d5b0adae72ac9f3814f401ad9eec2bb6))
* **session:** reopen replaced targets ([5c55999](https://github.com/morluto/rea/commit/5c559998e14bcb9be1e589a1266e31296a8f2af8))
* **setup:** configure every detected client ([69744a4](https://github.com/morluto/rea/commit/69744a421a28bad525fe95697938b99d7ffcf5b6))
* **setup:** configure every detected client ([24f9a1f](https://github.com/morluto/rea/commit/24f9a1ff11e4d1a6361071739fa937d88159fb33))
* **setup:** omit aligned client configurations from plan ([a86da4f](https://github.com/morluto/rea/commit/a86da4ff3f9279e4ca3fc792e6f18542fee9e0ce))
* **setup:** omit aligned skill from plan ([d81687f](https://github.com/morluto/rea/commit/d81687f38393128b0a91ca83deb9b250190fb509))
* **setup:** omit aligned skill from plan ([2984fa7](https://github.com/morluto/rea/commit/2984fa74acfb6f7cbb504677a348e20bff85b806))
* **setup:** preserve client config symlinks ([85285f1](https://github.com/morluto/rea/commit/85285f1563d8d24bb934e1fe227cb91fe36c6dd4))
* **setup:** preserve client config symlinks ([df87544](https://github.com/morluto/rea/commit/df87544a5dcee13f15aa6e435c2b61fb3b220397))
* **test:** adapt mainReload shutdown seam to registerShutdown signature ([0a430c1](https://github.com/morluto/rea/commit/0a430c12c158cf7f1ef04cdf537d5277c08c6106))
* **tooling:** isolate concurrent repository checks ([fb17156](https://github.com/morluto/rea/commit/fb17156499c592b5e18ffae996c55c372e3727d0))
* **tooling:** isolate concurrent repository checks ([ab8c5c1](https://github.com/morluto/rea/commit/ab8c5c1e13041690e07896f2f2f0dfa2134ad97e))
* **upgrade:** prevent version downgrades ([a204840](https://github.com/morluto/rea/commit/a2048406302b808e4f897eabd6c00ce64c529c16))
* **upgrade:** prevent version downgrades ([1d1d234](https://github.com/morluto/rea/commit/1d1d234eedd3b73108cd2fb41878680ca107bb7c))
* **verify:** reconcile PR-212/215/228 package E2E expectations ([cfa110c](https://github.com/morluto/rea/commit/cfa110ccb4021d383cc8be1caa17fef923edc183))


### Performance Improvements

* **application:** scan version artifacts in parallel ([528c05e](https://github.com/morluto/rea/commit/528c05e2faa557e17b6b83ccd7e1b0e779ba892a))
* **application:** scan version artifacts in parallel ([c00739b](https://github.com/morluto/rea/commit/c00739bb1f1ae3cb6f00464e8fd9f5b5f7dc6b6e))


### Tests

* **application:** verify packaged MCP replay ([6601e0c](https://github.com/morluto/rea/commit/6601e0cb7e57fe94cf0ae65bf0d04de25a3a7b49))
* **browser:** harden Chrome startup on CI ([74c5121](https://github.com/morluto/rea/commit/74c512130c5bc25d6c119eda72a86e73fcc9f1ff))
* **browser:** route discovery sockets through proxy ([e363f0e](https://github.com/morluto/rea/commit/e363f0eab8325a9f83568295d4669d70e7d47a2d))
* **browser:** verify page-scoped Chrome transport ([c252536](https://github.com/morluto/rea/commit/c252536494c15f36e69978eaf068eae176e71688))
* **cli:** verify packaged policy revocation ([3d71737](https://github.com/morluto/rea/commit/3d71737dc9ba8b449c0d174da90c3f1df54789d2))
* **hopper:** cover verified Linux rejection ([db202c2](https://github.com/morluto/rea/commit/db202c2b6ac9ce771c401cc558c56ecf6d2e51ee))
* **hopper:** retry after cancelled startup ([6de726f](https://github.com/morluto/rea/commit/6de726ffddc54ea354e6970f022eaab2f0863586))
* **hopper:** verify alternate Linux launcher path ([d93257b](https://github.com/morluto/rea/commit/d93257b50fae81272cbd2da28ba24d03647c2c99))
* **package:** cover aligned setup plan ([a597639](https://github.com/morluto/rea/commit/a5976396eb424933232844e161cdab84b452b361))
* **package:** cover config symlink lifecycle ([d1ef7a5](https://github.com/morluto/rea/commit/d1ef7a54394ff2ed4316ba01cfe0aa4aac313aed))
* **package:** preserve unrelated symlink config ([c50e51e](https://github.com/morluto/rea/commit/c50e51eb6fe5686ad9d680abe0d96b3e4b58dc78))
* reduce test suite runtime ([2223da1](https://github.com/morluto/rea/commit/2223da19166a3ec485d98a0d005113a9d0358f37))
* **reference:** cover failure normalization ([3d5041f](https://github.com/morluto/rea/commit/3d5041fb2f8964c30f0273615b4f039620eef0bf))
* **runtime:** cover idempotent handler cleanup ([1bdb59e](https://github.com/morluto/rea/commit/1bdb59e201a26b53f5ed8b2eb870941ca4b788f7))
* serialize subprocess-heavy integrations ([f46fc7f](https://github.com/morluto/rea/commit/f46fc7f1f3a265123c69d007c64c928a8974d98f))
* **session:** reopen replaced target through MCP ([1c32880](https://github.com/morluto/rea/commit/1c32880e56450b610d766c5a6c1bee6873ee6323))
* **setup:** cover later clients after failure ([8f73112](https://github.com/morluto/rea/commit/8f7311285b2ba7a1ed427d61e437dd2665e20d12))

## [1.5.0](https://github.com/morluto/rea/compare/rea-agents-1.4.0...rea-agents-1.5.0) (2026-07-14)


### Features

* add passive website reverse engineering ([9986971](https://github.com/morluto/rea/commit/998697155dcc733be73e75bc77c069638942f111))
* add passive website reverse engineering ([2c1ceab](https://github.com/morluto/rea/commit/2c1ceabbf1f117daafe166e1134b47737b38e1f6))


### Bug Fixes

* **browser:** drop disallowed redirect evidence ([8481be9](https://github.com/morluto/rea/commit/8481be9c9709b13f572fefefcf8508d9e2605386))
* **browser:** scope CDP events and fail closed ([5279d77](https://github.com/morluto/rea/commit/5279d7755c74df579028ce51b4bc53b089bb2749))
* **browser:** scope workers and binary frame sizes ([dfc06cf](https://github.com/morluto/rea/commit/dfc06cf0ad4a39719ef74846cb83f05e7b6f6289))
* harden PTY events and configured roots ([ae8b1c5](https://github.com/morluto/rea/commit/ae8b1c5ca9c2d122d7fc30ebfa25e08d57ca7a51))
* harden PTY events and configured roots ([31b40f3](https://github.com/morluto/rea/commit/31b40f39e4c29a077deebefbe29e90c30e50cd0c))
* **permission:** defer cache write grants ([6a3fd5b](https://github.com/morluto/rea/commit/6a3fd5b4cec7569eebfe8a7ca6a7c0c1e3a7340d))
* **permission:** defer cache write grants ([f840e70](https://github.com/morluto/rea/commit/f840e70749ffadfe34cf8b7e464b54e8ffebd816))
* resolve triaged correctness issues ([2575b30](https://github.com/morluto/rea/commit/2575b30dfcb79c2e26ed16311f780a8723578c6a))
* resolve triaged correctness issues ([e8ed307](https://github.com/morluto/rea/commit/e8ed3073ac915e32b5ea630446ed6e14bc788119))
* resolve validation and artifact edge cases ([2468682](https://github.com/morluto/rea/commit/246868232e4196394fbc6e67cfae4d3ca214fe60))
* resolve validation and artifact edge cases ([ef7f2f9](https://github.com/morluto/rea/commit/ef7f2f93747f0a4d9f70c9fc2e252456d20843f3))


### Documentation

* add Hopper screenshot to README ([a699fdd](https://github.com/morluto/rea/commit/a699fdd6a5cc9c9812c7d78fd98b51469488866f))
* add Hopper screenshot to README ([08981a3](https://github.com/morluto/rea/commit/08981a31b5e9b76e15914c0570244158d491e047))


### Tests

* **cli:** allow cold-start integration timing ([7d5621d](https://github.com/morluto/rea/commit/7d5621dfbc4333f99846cbe52227d3b4f53ee0cd))

## [1.4.0](https://github.com/morluto/rea/compare/rea-agents-1.3.0...rea-agents-1.4.0) (2026-07-14)


### Features

* **core:** add typed policy and integrity contracts ([190efca](https://github.com/morluto/rea/commit/190efcaf1728743a02fb65a35319abdc14ea2227))
* **identity:** derive MCP surface metadata ([2722722](https://github.com/morluto/rea/commit/2722722425cb7e7f5954de95ea4641ba2f1ae03b))
* **mcp:** expose progress resources and availability ([da59299](https://github.com/morluto/rea/commit/da59299a8a83241e6912a062cf8d5744993cad9e))
* **mcp:** land policy, resources, and typed contracts ([8f79ee7](https://github.com/morluto/rea/commit/8f79ee771e362f69001a483dcbdb59f4c7b89af0))


### Bug Fixes

* **ci:** keep generated error docs with their owner ([3e60e38](https://github.com/morluto/rea/commit/3e60e38a147eafa0445e4f9935ede279b4aab688))
* **ci:** preserve stacked integration changes ([cf8e5cf](https://github.com/morluto/rea/commit/cf8e5cf5e61fe00731768107790e715958a96fc8))
* **cli:** return nonzero status for operation failures ([#121](https://github.com/morluto/rea/issues/121)) ([00c187e](https://github.com/morluto/rea/commit/00c187e32b3d2add37245a48f21185c2bd4fc22a))
* **cli:** return nonzero status for operation failures ([#122](https://github.com/morluto/rea/issues/122)) ([964620a](https://github.com/morluto/rea/commit/964620a0a108c3c671d982da37b5d4c05c4ef035))
* **hopper:** complete owned Linux shutdown ([#116](https://github.com/morluto/rea/issues/116)) ([fb51874](https://github.com/morluto/rea/commit/fb51874bb9ee1d5144c897e0de4c7e083ba4d390))
* **mcp:** preserve migrated revisions and valid links ([4149472](https://github.com/morluto/rea/commit/414947243963fed5f769a124758424dda371dcd7))
* preserve actionable artifact diagnostics ([#119](https://github.com/morluto/rea/issues/119)) ([7385220](https://github.com/morluto/rea/commit/73852202d42743fe5589fd9477f0d0991d87c060))
* **workspace:** migrate legacy integrity identities ([d092d4c](https://github.com/morluto/rea/commit/d092d4c97a51882f7cdbc0e3dd167cea309b8adf))


### Tests

* **identity:** defer live MCP integration proof ([74db3fc](https://github.com/morluto/rea/commit/74db3fcd4259f3c09fb29cc7762952320b99ae71))

## [1.3.0](https://github.com/morluto/rea/compare/rea-agents-1.2.0...rea-agents-1.3.0) (2026-07-13)


### Features

* add guided MCP workflow prompts ([08d5b91](https://github.com/morluto/rea/commit/08d5b913b00a382af6e9e8c847459608e2f2384e))
* add guided MCP workflow prompts ([24c3adb](https://github.com/morluto/rea/commit/24c3adb553407fb9ac696e8e7c8d6eea643d14d6))
* add persistent cross-version investigation workspaces ([c52eb46](https://github.com/morluto/rea/commit/c52eb4600a275fe080d8ba1f27fd6cef95f85850))
* add persistent cross-version investigation workspaces ([41366ed](https://github.com/morluto/rea/commit/41366edd566ba17cce81cd0cc3b503065775febc))
* **analysis:** add provider-neutral persistent snapshots ([c439b9e](https://github.com/morluto/rea/commit/c439b9e7787f3947eced0126a9c7b4d091584363))
* **analysis:** persist snapshots and close Hopper reliably ([c6407ef](https://github.com/morluto/rea/commit/c6407ef3d66d78e7635ec1b082144cd38068f93a))
* **errors:** add caller-safe typed error projections ([3be439c](https://github.com/morluto/rea/commit/3be439cbf3db2c53c766bf93a4e247fdfb8242ae))
* **mcp:** return structured typed tool results ([eb38e4c](https://github.com/morluto/rea/commit/eb38e4c4024a7d66001b3e69f8309c85492f05c0))


### Bug Fixes

* **bridge:** bound regex search work ([733a382](https://github.com/morluto/rea/commit/733a382b3020c4953747d7c6e2caf73883a6274c))
* **bridge:** bound regex search work ([65682ee](https://github.com/morluto/rea/commit/65682ee65c9f899875be5a785c0ec688bc4eda14))
* **ci:** remove unused setup type export ([c5728af](https://github.com/morluto/rea/commit/c5728af0b4574631d056f7ed1eb7785e80d80111))
* **cli:** render actionable analysis errors ([af8c4ef](https://github.com/morluto/rea/commit/af8c4efb4a415e4bdeae0151a8d29cd71af61916))
* **copy:** use agent terminology ([12060f6](https://github.com/morluto/rea/commit/12060f6d8dd3ed61fbd1d07fa604652c6b0a93e2))
* **errors:** improve recovery guidance ([77454dc](https://github.com/morluto/rea/commit/77454dc8f412e8431bbceff1a4c90ee8f636c9c7))
* **errors:** return actionable caller-safe failures ([fb0da03](https://github.com/morluto/rea/commit/fb0da031cf6305f5aaec5e9ec8178f08fd664479))
* **hopper:** cancel analysis and close documents reliably ([179870e](https://github.com/morluto/rea/commit/179870e8256419402464f02c918146865c6fbb93))
* **hopper:** return addresses for procedure relationships ([2c707ab](https://github.com/morluto/rea/commit/2c707abb66433f9065733398a0e5ea9af04cfb96))
* **linux:** start Hopper demo sessions headlessly ([32c5080](https://github.com/morluto/rea/commit/32c5080a26cae603f02dce9dc5777e98d1e5fc75))
* **linux:** start Hopper demo sessions headlessly ([75818d1](https://github.com/morluto/rea/commit/75818d119e3eb3b8df5acdbd554a2b86b82af23a))
* **security:** restrict investigation artifact inputs ([a2076b4](https://github.com/morluto/rea/commit/a2076b47a6b43d9c80396ee4a5954af590d65088))


### Tests

* **linux:** verify setup through CLI and MCP ([67504d2](https://github.com/morluto/rea/commit/67504d2d51151fd9eed76b12c9bae67c70817432))
* **package:** preserve unsupported host verification ([977119f](https://github.com/morluto/rea/commit/977119f91b4af39ea208a5e63d9445bf366b2eeb))
* strengthen MCP prompt acceptance coverage ([05fb9b1](https://github.com/morluto/rea/commit/05fb9b17c91b2ed7bfb58c3399499e0fb9e3f73e))

## [1.2.0](https://github.com/morluto/rea/compare/rea-agents-1.1.0...rea-agents-1.2.0) (2026-07-13)


### Features

* **artifacts:** add approved native DMG traversal ([24d000a](https://github.com/morluto/rea/commit/24d000a76e3fb98c69d47ab26ac1322a4c87f901))
* **process:** add deterministic capture v3 ([d0e21f9](https://github.com/morluto/rea/commit/d0e21f923158b7a3de73d06edf57462869022556))
* **process:** add deterministic capture v3 ([5a361a6](https://github.com/morluto/rea/commit/5a361a67258e1f89507497eafd5fc487e54d5820))
* **process:** introduce evidence-safe capture v4 ([ee4d284](https://github.com/morluto/rea/commit/ee4d284597a32b4acc4279b74083d9bf4e32d08b))


### Bug Fixes

* **artifacts:** diagnose unpacked ASAR integrity failures ([a504342](https://github.com/morluto/rea/commit/a504342d2b7e5ed87620d449f78102282054e063))
* **ci:** remove redundant process exports ([19bb231](https://github.com/morluto/rea/commit/19bb2317d1bd6773e5fa3f61e32cbf3d6d257830))
* **process:** harden capture validation and cleanup ([ac78de0](https://github.com/morluto/rea/commit/ac78de0a74b09a01efd91d9f88a16fde4f0ed9d9))


### Code Refactoring

* **artifacts:** simplify inventory traversal ([c8d762e](https://github.com/morluto/rea/commit/c8d762e6ffe0a2e23fb539590d7b1850ef1ce2a7))
* **setup:** split setup and CLI registration ([07e1b5a](https://github.com/morluto/rea/commit/07e1b5ac5f6a1724b1064c47ea05f04ccffcb4f3))


### Documentation

* document capture v4 and native mounts ([aca518b](https://github.com/morluto/rea/commit/aca518bb885825b912567eba95eb64a776a5624c))
* document process capture v3 ([50f4a29](https://github.com/morluto/rea/commit/50f4a298f44bf56dc78d5717cb23d69db5df4265))
* **process:** preserve capture invariants ([841990b](https://github.com/morluto/rea/commit/841990bde158a996be65feabcef4aa5e18fc3a4b))
* **skill:** document capture v4 and DMG mounts ([f0a9a3c](https://github.com/morluto/rea/commit/f0a9a3cd258d60046dcd74feea243956489c60dc))


### Tests

* **process:** use deterministic hang fixture ([ba15d16](https://github.com/morluto/rea/commit/ba15d16c5869ef29e85a0e9bacff3ac07edda3a2))

## [1.1.0](https://github.com/morluto/rea/compare/rea-agents-1.0.0...rea-agents-1.1.0) (2026-07-13)


### Features

* **setup:** make installation explicit and safe ([29d92ca](https://github.com/morluto/rea/commit/29d92cac5ab23a4e6a5286b0871224abbe705642))
* **setup:** make installation explicit and safe ([3793889](https://github.com/morluto/rea/commit/3793889ce8662ca8e1e92af1bb5c6ee854848467))


### Bug Fixes

* preserve requested evidence paths on macOS ([0c0e2b8](https://github.com/morluto/rea/commit/0c0e2b8a1efb3f56672b9c95fda5c5ab5746284b))
* preserve requested evidence paths on macOS ([3d0ad79](https://github.com/morluto/rea/commit/3d0ad799c4deb1d3627d8721c31bc76be3f3abd2))


### Documentation

* **api:** regenerate TypeDoc reference ([0a66cae](https://github.com/morluto/rea/commit/0a66cae16ef8e2a243bbed502bbb7cdbd12a965f))
* define REA contributor priorities ([5df4ef6](https://github.com/morluto/rea/commit/5df4ef67a4676f46900aa6022c1af2224efa8761))
* explain the installation workflow ([1c83263](https://github.com/morluto/rea/commit/1c83263bbb79aa050d1e560d17da66557afdbad2))

## [1.0.0](https://github.com/morluto/rea/compare/rea-agents-0.5.0...rea-agents-1.0.0) (2026-07-13)


### ⚠ BREAKING CHANGES

* **contracts:** batch_decompile, get_call_graph, and find_xrefs_to_name now return structured discriminated output shapes.

### Features

* **cli:** add self-upgrade command ([c004220](https://github.com/morluto/rea/commit/c004220a2699ac60a67a9c7edf1f96cad8a31d3e))
* **cli:** add self-upgrade command ([0d77a9f](https://github.com/morluto/rea/commit/0d77a9f1350056a7d2c43771d579e0461029f5b5))


### Bug Fixes

* **contracts:** keep error schema internal ([ac8cc66](https://github.com/morluto/rea/commit/ac8cc668fb6b9305d2dc9014f7a6006d96b18ba6))
* **contracts:** return structured workflow failures ([4c54ff6](https://github.com/morluto/rea/commit/4c54ff6bcaac02f39c6620a54ac29690a121f33d))
* **native:** classify pre-aborted analysis first ([dfd598f](https://github.com/morluto/rea/commit/dfd598f76505af978f2d11afffb5e1f362d3a769))


### Documentation

* list upgrade in CLI reference ([8a24088](https://github.com/morluto/rea/commit/8a24088c2bffd34050ea6f6f0e103f64a3f67a64))

## [0.5.0](https://github.com/morluto/rea/compare/rea-agents-0.4.0...rea-agents-0.5.0) (2026-07-13)


### Features

* **analysis:** harden agent workflows and evidence boundaries ([883db91](https://github.com/morluto/rea/commit/883db912da6e38e1078286997cc9048471e03896))
* **cli:** align terminal workflows with MCP ([b1912b1](https://github.com/morluto/rea/commit/b1912b18e1723c594a030b16acf01341f083455b))


### Bug Fixes

* **analysis:** accept valid final dossier pages ([7c36f36](https://github.com/morluto/rea/commit/7c36f3631862e67a0751967c84abc4f423f5475c))
* **bridge:** harden bounded Hopper boundaries ([f8e8ea3](https://github.com/morluto/rea/commit/f8e8ea35ff08ce5071acbccab188df808708b71c))
* **cli:** preserve function provider provenance ([c630f41](https://github.com/morluto/rea/commit/c630f410b6a81864bf90211a088c715bfe234722))
* **lifecycle:** validate owned Hopper process identity ([898d6b0](https://github.com/morluto/rea/commit/898d6b0192126030cedd7e5c2cb76f40568cda05))
* **process:** default capture networking to loopback ([bce3398](https://github.com/morluto/rea/commit/bce3398dbe3a3b20952f37573a656aa77b168977))
* **process:** keep network approval fail-closed ([9526389](https://github.com/morluto/rea/commit/9526389f815f0937fc01198ff3a8a850c6c1c81a))


### Code Refactoring

* **cli:** share direct analysis tool types ([329fdf6](https://github.com/morluto/rea/commit/329fdf6fe8f3a2bf9679b13a8ce5cb16cf946129))


### Documentation

* correct pull request tool inventory ([d806480](https://github.com/morluto/rea/commit/d806480e41bcb623448a258ddffeb75082fe1e1f))
* document CLI safety and provider evaluation ([efc9bd2](https://github.com/morluto/rea/commit/efc9bd270f58a5aaba15edb07cee135d2c54db83))


### Tests

* **docs:** keep localized claims and tool counts aligned ([a7b84a9](https://github.com/morluto/rea/commit/a7b84a9b4b7ea4336c0f327e13b2948a8d94fba9))
* **verification:** strengthen conformance and real-Hopper checks ([0d36976](https://github.com/morluto/rea/commit/0d369762770d2d92dd72c7dcb2f2f90a64b206ff))

## [0.4.0](https://github.com/morluto/rea/compare/rea-agents-0.3.0...rea-agents-0.4.0) (2026-07-12)


### Features

* add cross-platform installation lifecycle ([cc6a955](https://github.com/morluto/rea/commit/cc6a9557e1fdd8c057902e9c0fcfbba2561cbcd7))
* add cross-platform installation lifecycle ([e651cb6](https://github.com/morluto/rea/commit/e651cb65db87b6d9df9fb13b66a6e5e76f0965e0))


### Documentation

* document installation and Linux support ([034563a](https://github.com/morluto/rea/commit/034563a4c015c69e878054d4fd06e0e9fa630e24))
* simplify REA onboarding ([e1dfe86](https://github.com/morluto/rea/commit/e1dfe8613e5a986d5ee64764851f0abcc901398b))
* simplify REA onboarding ([d85b661](https://github.com/morluto/rea/commit/d85b661be80bd19d477c46ebe0501839c7b63ee7))


### Tests

* add package installation end-to-end coverage ([993356b](https://github.com/morluto/rea/commit/993356b85adc72036ba44cd87b9335e2ec172a32))
* stabilize artifact pagination coverage ([f56bdde](https://github.com/morluto/rea/commit/f56bdde27679e1f05b34d2cf5efbc6e49bd4c2ca))


### Continuous Integration

* enforce conventional pull request titles ([07a0b98](https://github.com/morluto/rea/commit/07a0b984f2bdbc4fe1ce18d5db13500aa8f3992f))
* enforce conventional pull request titles ([3a21f16](https://github.com/morluto/rea/commit/3a21f16c1832430765083636511a8c12dbccf2dd))
* verify installed package with Linux Hopper ([4f97f69](https://github.com/morluto/rea/commit/4f97f699e4d5471557d1ce0ff91e144065d06a61))

## [0.3.0](https://github.com/morluto/rea/compare/rea-agents-0.2.1...rea-agents-0.3.0) (2026-07-12)


### Features

* add evidence-backed process investigations ([cc8681a](https://github.com/morluto/rea/commit/cc8681a856dacb296f835112d0a27133d4c05ad1))
* **cli:** add guided local onboarding ([8ca3db8](https://github.com/morluto/rea/commit/8ca3db829f90f99dcaa57bbfc44fb3fe6a6b60c0))
* evolve REA analysis platform ([4f18e26](https://github.com/morluto/rea/commit/4f18e26ee58f616de788e07639f5b2f91d37ef11))
* **identity:** rename package and CLI to REA ([3d70812](https://github.com/morluto/rea/commit/3d70812c373ca7ef9a41146555605455515998dd))
* **mcp:** add typed bounded analysis tools ([893d2e2](https://github.com/morluto/rea/commit/893d2e2d0550271297c452b418f80bdf8ae21514))
* **session:** add dynamic binary lifecycle ([f32e718](https://github.com/morluto/rea/commit/f32e718cc741bba4deb0162c1a9b93f127e7741a))


### Bug Fixes

* **boundaries:** reject unsafe local inputs ([15e8cf3](https://github.com/morluto/rea/commit/15e8cf3234bd3b5ee929db84c5c71e9a18441eb6))
* **doctor:** require an executable Hopper launcher ([aee9cb8](https://github.com/morluto/rea/commit/aee9cb8e4e919d28ae851987f6555cfceee46977))
* **hopper:** launch analysis without stealing focus ([ff321dc](https://github.com/morluto/rea/commit/ff321dc574cd510e036fe5910fba79058e5c015b))
* **hopper:** make loader selection non-interactive ([2b7ef86](https://github.com/morluto/rea/commit/2b7ef8610df3cbee5fe0a4600dce5381cce77793))
* keep execution options internal ([167a824](https://github.com/morluto/rea/commit/167a824f9131a60d07fca3e99301eecc98d5d5e9))
* **setup:** persist detected Hopper launcher ([b2866e4](https://github.com/morluto/rea/commit/b2866e4706f939ffebf65645f5e3feaf4b4095fd))
* **setup:** preserve consent and startup target kind ([a67054f](https://github.com/morluto/rea/commit/a67054f81500033c0a5b8d87f7f009ed2adda6e3))
* **setup:** preserve invalid MCP configuration ([88f5edc](https://github.com/morluto/rea/commit/88f5edc2365da92673c184ad0d2a9b218ba22f91))
* **targets:** cancel startup and probe PE offsets ([66b8d6e](https://github.com/morluto/rea/commit/66b8d6ea90dabc01162c7d42e37056ea3501939e))
* **verify:** tolerate exited Hopper helpers ([b167bd7](https://github.com/morluto/rea/commit/b167bd7e13ad2e4889f721235fd6b6e3d8e3b08c))


### Code Refactoring

* **cli:** share runtime between CLI and MCP ([97541d8](https://github.com/morluto/rea/commit/97541d8dad96e640ffd9ce5f0587dee0b5fbf6c1))


### Documentation

* document frictionless binary workflow ([ee6d539](https://github.com/morluto/rea/commit/ee6d539a407493617c1a58816e0329d600495217))
* document the 43-tool workflow ([1f235cb](https://github.com/morluto/rea/commit/1f235cb52f61c08b65ecb674cac649c34005bc66))
* record runtime and release constraints ([62ede51](https://github.com/morluto/rea/commit/62ede515b7c7e092714fa936575fd54d282deb93))
* redesign and localize README ([051b6db](https://github.com/morluto/rea/commit/051b6db65687fd14826b6462cd623feb2504f123))
* redesign and localize README ([910eda6](https://github.com/morluto/rea/commit/910eda6f323ba1151b0771fe5de6c60a91e3d46d))


### Tests

* add source-built Hopper conformance fixtures ([d648bcd](https://github.com/morluto/rea/commit/d648bcd2e41ec0b45bc02a69dee0d7206fc64f8f))

## [0.2.1](https://github.com/morluto/rea/compare/rea-0.2.0...rea-0.2.1) (2026-07-12)


### Documentation

* redesign and localize README ([051b6db](https://github.com/morluto/rea/commit/051b6db65687fd14826b6462cd623feb2504f123))
* redesign and localize README ([910eda6](https://github.com/morluto/rea/commit/910eda6f323ba1151b0771fe5de6c60a91e3d46d))

## [0.2.0](https://github.com/morluto/rea/compare/rea-0.1.0...rea-0.2.0) (2026-07-12)


### Features

* **cli:** add guided local onboarding ([8ca3db8](https://github.com/morluto/rea/commit/8ca3db829f90f99dcaa57bbfc44fb3fe6a6b60c0))
* **identity:** rename package and CLI to REA ([3d70812](https://github.com/morluto/rea/commit/3d70812c373ca7ef9a41146555605455515998dd))
* **session:** add dynamic binary lifecycle ([f32e718](https://github.com/morluto/rea/commit/f32e718cc741bba4deb0162c1a9b93f127e7741a))


### Bug Fixes

* **boundaries:** reject unsafe local inputs ([15e8cf3](https://github.com/morluto/rea/commit/15e8cf3234bd3b5ee929db84c5c71e9a18441eb6))
* **doctor:** require an executable Hopper launcher ([aee9cb8](https://github.com/morluto/rea/commit/aee9cb8e4e919d28ae851987f6555cfceee46977))
* **hopper:** launch analysis without stealing focus ([ff321dc](https://github.com/morluto/rea/commit/ff321dc574cd510e036fe5910fba79058e5c015b))
* **hopper:** make loader selection non-interactive ([2b7ef86](https://github.com/morluto/rea/commit/2b7ef8610df3cbee5fe0a4600dce5381cce77793))
* **setup:** persist detected Hopper launcher ([b2866e4](https://github.com/morluto/rea/commit/b2866e4706f939ffebf65645f5e3feaf4b4095fd))
* **setup:** preserve consent and startup target kind ([a67054f](https://github.com/morluto/rea/commit/a67054f81500033c0a5b8d87f7f009ed2adda6e3))
* **setup:** preserve invalid MCP configuration ([88f5edc](https://github.com/morluto/rea/commit/88f5edc2365da92673c184ad0d2a9b218ba22f91))
* **targets:** cancel startup and probe PE offsets ([66b8d6e](https://github.com/morluto/rea/commit/66b8d6ea90dabc01162c7d42e37056ea3501939e))
* **verify:** tolerate exited Hopper helpers ([b167bd7](https://github.com/morluto/rea/commit/b167bd7e13ad2e4889f721235fd6b6e3d8e3b08c))


### Code Refactoring

* **cli:** share runtime between CLI and MCP ([97541d8](https://github.com/morluto/rea/commit/97541d8dad96e640ffd9ce5f0587dee0b5fbf6c1))


### Documentation

* document frictionless binary workflow ([ee6d539](https://github.com/morluto/rea/commit/ee6d539a407493617c1a58816e0329d600495217))
* record runtime and release constraints ([62ede51](https://github.com/morluto/rea/commit/62ede515b7c7e092714fa936575fd54d282deb93))
