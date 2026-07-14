# Changelog

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
