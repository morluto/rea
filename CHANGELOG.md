# Changelog

## [0.4.0](https://github.com/morluto/rea/compare/rea-agents-2.4.0...rea-agents-0.4.0) (2026-07-23)


### ⚠ BREAKING CHANGES

* **mcp:** require Evidence for managed reconstruction
* **mcp:** comparison tools now require session-owned Evidence IDs or approved bundle paths, and structured Evidence results use compact references.
* **contracts:** batch_decompile, get_call_graph, and find_xrefs_to_name now return structured discriminated output shapes.

### Features

* add cross-platform installation lifecycle ([cc6a955](https://github.com/morluto/rea/commit/cc6a9557e1fdd8c057902e9c0fcfbba2561cbcd7))
* add cross-platform installation lifecycle ([e651cb6](https://github.com/morluto/rea/commit/e651cb65db87b6d9df9fb13b66a6e5e76f0965e0))
* add evidence-backed process investigations ([cc8681a](https://github.com/morluto/rea/commit/cc8681a856dacb296f835112d0a27133d4c05ad1))
* add guided MCP workflow prompts ([08d5b91](https://github.com/morluto/rea/commit/08d5b913b00a382af6e9e8c847459608e2f2384e))
* add guided MCP workflow prompts ([24c3adb](https://github.com/morluto/rea/commit/24c3adb553407fb9ac696e8e7c8d6eea643d14d6))
* add managed characterization and coverage closure ([1943496](https://github.com/morluto/rea/commit/194349683a19ee8b35c1bd9b124d032e83e6867a))
* add managed characterization and reconstruction coverage ([02c913b](https://github.com/morluto/rea/commit/02c913bcdab5904e1b6ce8a24940b75ddc20c826))
* add passive website reverse engineering ([9986971](https://github.com/morluto/rea/commit/998697155dcc733be73e75bc77c069638942f111))
* add passive website reverse engineering ([2c1ceab](https://github.com/morluto/rea/commit/2c1ceabbf1f117daafe166e1134b47737b38e1f6))
* add persistent cross-version investigation workspaces ([c52eb46](https://github.com/morluto/rea/commit/c52eb4600a275fe080d8ba1f27fd6cef95f85850))
* add persistent cross-version investigation workspaces ([41366ed](https://github.com/morluto/rea/commit/41366edd566ba17cce81cd0cc3b503065775febc))
* add web and Electron reverse-engineering workflows ([be76f80](https://github.com/morluto/rea/commit/be76f8090b5195680cdf73a8c21f65e6516efc92))
* **analysis:** add provider-neutral persistent snapshots ([c439b9e](https://github.com/morluto/rea/commit/c439b9e7787f3947eced0126a9c7b4d091584363))
* **analysis:** harden agent workflows and evidence boundaries ([883db91](https://github.com/morluto/rea/commit/883db912da6e38e1078286997cc9048471e03896))
* **analysis:** persist snapshots and close Hopper reliably ([c6407ef](https://github.com/morluto/rea/commit/c6407ef3d66d78e7635ec1b082144cd38068f93a))
* **application:** add cross-layer graph workflows ([778b995](https://github.com/morluto/rea/commit/778b995bbfd4b4bb28ace9bf0f7428e50cd1be50))
* **application:** add isolated JavaScript replay ([d86231a](https://github.com/morluto/rea/commit/d86231ad33e750c2a6ef60a33d833ac8db9219be))
* **artifact:** reconstruct JavaScript application structure ([aa46abf](https://github.com/morluto/rea/commit/aa46abfe1b59ecab160029c88b0c925ff68d6033))
* **artifacts:** add approved native DMG traversal ([24d000a](https://github.com/morluto/rea/commit/24d000a76e3fb98c69d47ab26ac1322a4c87f901))
* **artifacts:** project mobile application inventories ([c6a1a93](https://github.com/morluto/rea/commit/c6a1a93a9aff1efa06a39aae9911f6c704c350f5))
* **artifacts:** project mobile application inventories ([d36b385](https://github.com/morluto/rea/commit/d36b38537821dd2d74d99a9e49eccd569cfaf341))
* **artifacts:** support MSIX and AppX packages ([6e6cce1](https://github.com/morluto/rea/commit/6e6cce1bf3cbd9c48799bee9969c53d66c42162e))
* **cli:** add explicit package-runner setup wizard ([891a11f](https://github.com/morluto/rea/commit/891a11f315d02628bbf04f290d211e48d1916a1d))
* **cli:** add self-upgrade command ([c004220](https://github.com/morluto/rea/commit/c004220a2699ac60a67a9c7edf1f96cad8a31d3e))
* **cli:** add self-upgrade command ([0d77a9f](https://github.com/morluto/rea/commit/0d77a9f1350056a7d2c43771d579e0461029f5b5))
* **cli:** align terminal workflows with MCP ([b1912b1](https://github.com/morluto/rea/commit/b1912b18e1723c594a030b16acf01341f083455b))
* **cli:** improve setup onboarding ([4851449](https://github.com/morluto/rea/commit/4851449f715af122d02e5517b4f6b925962f2a01))
* **cli:** improve setup onboarding ([16002ff](https://github.com/morluto/rea/commit/16002ff3c216ecd91e9c28bab8de288f3b553e57))
* **cli:** support package-name setup wizard ([1b90e7f](https://github.com/morluto/rea/commit/1b90e7f992276e4e05644823583f77c27ccac702))
* complete REA remediation program ([d25e98c](https://github.com/morluto/rea/commit/d25e98c3f9f16e1758ee2a7b5ea44ed6d9534351))
* **core:** add typed policy and integrity contracts ([190efca](https://github.com/morluto/rea/commit/190efcaf1728743a02fb65a35319abdc14ea2227))
* **doctor:** admit the Windows x64 Ghidra boundary ([32dda0c](https://github.com/morluto/rea/commit/32dda0c19eee5ddf91a35d9e21374f9cb111b07d))
* **domain:** add versioned JavaScript Application Graph ([2ca5672](https://github.com/morluto/rea/commit/2ca56724e4be7429372904ad26fe97fa5943bcf4))
* **dotnet:** add BYO ILSpy oracle diagnostics ([aa200ce](https://github.com/morluto/rea/commit/aa200ce8ca5690113a39259e91ab1ae9edc0b436))
* **dotnet:** add managed artifact triage ([c251c38](https://github.com/morluto/rea/commit/c251c38aa2ead24e4aaeb95678a10dddaa212dc4))
* **dotnet:** add managed member comparison ([55794d6](https://github.com/morluto/rea/commit/55794d6083d6746fa2c7ad08a5f548c05272b1ae))
* **dotnet:** add managed member inspection ([98cad37](https://github.com/morluto/rea/commit/98cad3788d05ae31d86bb448d6fa8e5ebb1c742c))
* **dotnet:** add managed native boundary inspection ([466b1bb](https://github.com/morluto/rea/commit/466b1bbebee8c9266708de885b5e5405d23d0b7c))
* **dotnet:** add managed runtime correlation planning ([5f66cfd](https://github.com/morluto/rea/commit/5f66cfd57aeec39bb3337cbbbc2b7c3c8460df54))
* **dotnet:** import managed reconstructions ([c506664](https://github.com/morluto/rea/commit/c5066647445f3a8be0a9df4ff0f41b7e478f79b5))
* **dotnet:** verify managed native boundaries ([8cbc125](https://github.com/morluto/rea/commit/8cbc125b9393f3cc84a8a1b4e1cb160714c833ad))
* **electron:** map static process and IPC boundaries ([3fa2304](https://github.com/morluto/rea/commit/3fa2304bc70beb96cf30feb51bb6d7ac4fb7a2b0))
* **electron:** reconcile static artifacts with passive runtime ([8c67dbd](https://github.com/morluto/rea/commit/8c67dbd49e74b2f304a03845a8a55e6a433cc915))
* **errors:** add caller-safe typed error projections ([3be439c](https://github.com/morluto/rea/commit/3be439cbf3db2c53c766bf93a4e247fdfb8242ae))
* **evidence:** generate verifier completion ledgers ([c02d33f](https://github.com/morluto/rea/commit/c02d33f381b42028186dcf76e3fb1976a42488bf))
* **evidence:** generate verifier completion ledgers ([f5b3e22](https://github.com/morluto/rea/commit/f5b3e22e720011fa346ee17acaaa927e3379499f))
* evolve REA analysis platform ([4f18e26](https://github.com/morluto/rea/commit/4f18e26ee58f616de788e07639f5b2f91d37ef11))
* expand reactive capture and package analysis ([9da1794](https://github.com/morluto/rea/commit/9da179425e83df9f255597437320c1ab6ff5c5c2))
* **ghidra:** add authenticated Windows loopback transport ([629ffc3](https://github.com/morluto/rea/commit/629ffc3872cdf2f3dabbe053890ac6a4103fdd1c))
* **ghidra:** add function analysis and conformance ([d8321de](https://github.com/morluto/rea/commit/d8321defd77c57df424b2635a4a70d38fe9a1fae))
* **ghidra:** add private headless provider session ([f0e625d](https://github.com/morluto/rea/commit/f0e625d7ee5a3f79158514aa93f89fca81a2da6a))
* **ghidra:** bind imports to admitted target bytes ([be19c3f](https://github.com/morluto/rea/commit/be19c3fd12da55df84d92c5ec2641fe739df0438))
* **ghidra:** define the Windows P0 admission boundary ([6b1fd16](https://github.com/morluto/rea/commit/6b1fd166b0a6d37af9d42c38c5fd587fe3989659))
* **ghidra:** implement read-only inventory operations ([b1c07dd](https://github.com/morluto/rea/commit/b1c07dd9c6fe8c4dd109fefe67f4b16fdd1115d1))
* **ghidra:** inspect Windows headless installations ([86e44be](https://github.com/morluto/rea/commit/86e44bef08d36cc1b56e44b7b544d5d6d21d141d))
* **ghidra:** launch bounded Windows headless sessions ([bc0fb45](https://github.com/morluto/rea/commit/bc0fb45f16db97d3f79860d850c9f2fe0f6b7b22))
* harden authority and runtime conformance boundaries ([b537ebf](https://github.com/morluto/rea/commit/b537ebfa3460f782c2aee4996ced2e726f7d6328))
* **identity:** derive MCP surface metadata ([2722722](https://github.com/morluto/rea/commit/2722722425cb7e7f5954de95ea4641ba2f1ae03b))
* **javascript:** add binding and constant-value semantic IR ([3ea8523](https://github.com/morluto/rea/commit/3ea852323aa9a0509691105d47f5e5622c24050b))
* **javascript:** add binding and constant-value semantic IR ([3d71bb5](https://github.com/morluto/rea/commit/3d71bb551e3353df23afa5832883e5074fe0f2d0))
* **javascript:** add bounded semantic relation graph ([b3939ea](https://github.com/morluto/rea/commit/b3939ea9ffc79a6f0998af76b0f6c9f166d2963b))
* **javascript:** add bounded semantic tracing ([56c1a66](https://github.com/morluto/rea/commit/56c1a669d7edb295ecfce1d348ef7c043ee48390))
* **javascript:** add local semantic call flow ([a26a1c7](https://github.com/morluto/rea/commit/a26a1c73df019e060a5ca50208e71dad1eb55f1e))
* **javascript:** add webpack and rspack runtime adapters ([7bccb7c](https://github.com/morluto/rea/commit/7bccb7c6ae2f48a37e053cfd871309971e81bbc4))
* **javascript:** add webpack and rspack runtime adapters ([44c7017](https://github.com/morluto/rea/commit/44c70176b845e2900244151aaadb7a4dc3f8b302))
* **javascript:** expose bounded semantic tracing ([508a9cc](https://github.com/morluto/rea/commit/508a9ccde9c4beef2fa4dbd39093a1030287e967))
* **javascript:** recover commonjs and esm module relationships ([9766fc0](https://github.com/morluto/rea/commit/9766fc04c13a366fa449f60cccabb1c97d68e84d))
* **javascript:** recover commonjs and esm module relationships ([6c41791](https://github.com/morluto/rea/commit/6c41791519069811d0be0115c450801432f96660))
* **managed:** project static evidence into application graph ([6194c1a](https://github.com/morluto/rea/commit/6194c1a781a97043dbd02f0f6717c17598459abe))
* **managed:** project static evidence into application graph ([77178bb](https://github.com/morluto/rea/commit/77178bba543ed40b5cb29d301ad930e698a1968c))
* **mcp:** add typed bounded analysis tools ([893d2e2](https://github.com/morluto/rea/commit/893d2e2d0550271297c452b418f80bdf8ae21514))
* **mcp:** expose progress resources and availability ([da59299](https://github.com/morluto/rea/commit/da59299a8a83241e6912a062cf8d5744993cad9e))
* **mcp:** harden contracts and evidence references ([ee1cd40](https://github.com/morluto/rea/commit/ee1cd40405405097b9d5f9686cbcc765ab03d96a))
* **mcp:** land policy, resources, and typed contracts ([8f79ee7](https://github.com/morluto/rea/commit/8f79ee771e362f69001a483dcbdb59f4c7b89af0))
* **mcp:** require Evidence for managed reconstruction ([d36af5d](https://github.com/morluto/rea/commit/d36af5d0f708637f514f356521242b2b1066c8ed))
* **mcp:** return structured typed tool results ([eb38e4c](https://github.com/morluto/rea/commit/eb38e4c4024a7d66001b3e69f8309c85492f05c0))
* **permissions:** add scoped process capture elicitation ([e6cfce3](https://github.com/morluto/rea/commit/e6cfce3902a8f0c403caa07e2c597e8156aa5498))
* **process:** add bounded reactive scenario domain ([42f3b9c](https://github.com/morluto/rea/commit/42f3b9c2ec46f48fa680489259fce4841d3ddc0b))
* **process:** add bounded reactive scenario domain ([d34463c](https://github.com/morluto/rea/commit/d34463c27c9b5d71c9e2e3b33cdaef2eab5b99de))
* **process:** add bounded replay state machines ([fea965b](https://github.com/morluto/rea/commit/fea965b1b82a858fe423df2ef8fb004524f1934e))
* **process:** add bounded replay state machines ([dc0c2e5](https://github.com/morluto/rea/commit/dc0c2e5ac31387138ec47b027bac6a4cbf007ba0))
* **process:** add deterministic capture v3 ([d0e21f9](https://github.com/morluto/rea/commit/d0e21f923158b7a3de73d06edf57462869022556))
* **process:** add deterministic capture v3 ([5a361a6](https://github.com/morluto/rea/commit/5a361a67258e1f89507497eafd5fc487e54d5820))
* **process:** add direct replay machine runner ([3df9a07](https://github.com/morluto/rea/commit/3df9a074136faf9c279c9ea936de33f25b6dd447))
* **process:** add reactive capture scenarios ([69761e9](https://github.com/morluto/rea/commit/69761e95b63ec7617aa161f7a1b4e3c8847a6175))
* **process:** compare declared concurrent traces ([d81745c](https://github.com/morluto/rea/commit/d81745cb95b1564b94bf260d4f737d03b4625849))
* **process:** compare repeatable paired experiments ([e9899c0](https://github.com/morluto/rea/commit/e9899c003b72c2799c67d74bd9553c9a03d083dd))
* **process:** compare repeatable paired experiments ([9ab7aa3](https://github.com/morluto/rea/commit/9ab7aa320c2f234e86d16ff8535b11768a0e080e))
* **process:** coordinate reactive capture effects ([b874efd](https://github.com/morluto/rea/commit/b874efd96824e98ac2120b93368e30a921dcf872))
* **process:** coordinate reactive capture effects ([db9a831](https://github.com/morluto/rea/commit/db9a83190b841c8195da0b3036644831770ba369))
* **process:** introduce evidence-safe capture v4 ([ee4d284](https://github.com/morluto/rea/commit/ee4d284597a32b4acc4279b74083d9bf4e32d08b))
* **process:** record global capture event order ([8bcdb98](https://github.com/morluto/rea/commit/8bcdb986893becd151c4dbb825f69bb6ced8b52e))
* **process:** record provider and verifier run lineage ([02b01d4](https://github.com/morluto/rea/commit/02b01d4193a78a1180e5dd467a4e85838546fcde))
* **process:** record provider and verifier run lineage ([513fa29](https://github.com/morluto/rea/commit/513fa294a49cd5059d4039e1d267e003b0234fad))
* **process:** run finite-state replay during capture ([820af60](https://github.com/morluto/rea/commit/820af60c25cb342d74a06d733b8eac8be814ef6b))
* **process:** run finite-state replay during capture ([34c583a](https://github.com/morluto/rea/commit/34c583a170782b4b28d16a2ec33223922608008d))
* **session:** add explicit provider registry and target binding ([941d710](https://github.com/morluto/rea/commit/941d7101dd3c8b7cdd790724c55ff00a90f42270))
* **setup:** make installation explicit and safe ([29d92ca](https://github.com/morluto/rea/commit/29d92cac5ab23a4e6a5286b0871224abbe705642))
* **setup:** make installation explicit and safe ([3793889](https://github.com/morluto/rea/commit/3793889ce8662ca8e1e92af1bb5c6ee854848467))
* **setup:** verify installed skill catalog identity ([b2d1f2a](https://github.com/morluto/rea/commit/b2d1f2affdc7faa0e1c56feefe596eb39dea0612))
* **skill:** rename skill to reverse-engineer-anything ([9356634](https://github.com/morluto/rea/commit/9356634ccba8d913a376798dae47bb3c4a86c07a))
* streamline agent integration and MCP routing ([02cb20b](https://github.com/morluto/rea/commit/02cb20b54682bc334077d8e247841e179a26abd7))
* streamline agent integration and MCP routing ([3e3d458](https://github.com/morluto/rea/commit/3e3d45856ede849371027b62ad1a7b0687798951))
* **target:** classify Windows PE admission metadata ([24274fe](https://github.com/morluto/rea/commit/24274fe6b694c5bf08ae21fd7f4afa1846f67ef2))
* **windows:** define native authority boundary ([a1a6b42](https://github.com/morluto/rea/commit/a1a6b4200ed638b1ea4d186ae1253805032d002a))


### Bug Fixes

* address setup, upgrade, and process test regressions ([960d759](https://github.com/morluto/rea/commit/960d759cc1979a32ae416c50e6095abfd629fbe7))
* address setup, upgrade, and process test regressions ([02f12b9](https://github.com/morluto/rea/commit/02f12b927a17615150d6e1126d1b841c5dca648b))
* align session filters and Hopper verification ([d7d6bdf](https://github.com/morluto/rea/commit/d7d6bdf474a1672a9b33888044a38672d28ab0ee))
* **analysis:** accept valid final dossier pages ([7c36f36](https://github.com/morluto/rea/commit/7c36f3631862e67a0751967c84abc4f423f5475c))
* **application:** add explicit investigation replay ([7112e1e](https://github.com/morluto/rea/commit/7112e1e6bf33bccd605bf3ee5541b83a522831e5))
* **application:** add explicit investigation replay ([a6b5ca4](https://github.com/morluto/rea/commit/a6b5ca4135ac2cf168470b47e97a05d8b67f3147))
* **artifacts:** align projection provider targets ([560dbda](https://github.com/morluto/rea/commit/560dbda76d9a07ea9291c00bec8a383456ad0e03))
* **artifacts:** bound mobile projection candidates ([0cc9d46](https://github.com/morluto/rea/commit/0cc9d468c4d6f3036b5888d12173157b487371c3))
* **artifacts:** diagnose unpacked ASAR integrity failures ([a504342](https://github.com/morluto/rea/commit/a504342d2b7e5ed87620d449f78102282054e063))
* **bridge:** bound regex search work ([733a382](https://github.com/morluto/rea/commit/733a382b3020c4953747d7c6e2caf73883a6274c))
* **bridge:** bound regex search work ([65682ee](https://github.com/morluto/rea/commit/65682ee65c9f899875be5a785c0ec688bc4eda14))
* **bridge:** harden bounded Hopper boundaries ([f8e8ea3](https://github.com/morluto/rea/commit/f8e8ea35ff08ce5071acbccab188df808708b71c))
* **browser:** drop disallowed redirect evidence ([8481be9](https://github.com/morluto/rea/commit/8481be9c9709b13f572fefefcf8508d9e2605386))
* **browser:** keep page endpoint type internal ([3743962](https://github.com/morluto/rea/commit/37439620710d4c47bf48f1df0b099eab0c115446))
* **browser:** observe direct target disconnects ([9be24f8](https://github.com/morluto/rea/commit/9be24f8de14edc04cdd3649e0ea66d53edb72328))
* **browser:** preserve operation-aware cancellation errors ([0aac8aa](https://github.com/morluto/rea/commit/0aac8aaba5a5097d99277d7501dae6fdd017f2d0))
* **browser:** redact transitional target titles ([f6095cb](https://github.com/morluto/rea/commit/f6095cb6ba9db4e69e7bcd64643c59c8ac129a4c))
* **browser:** scope CDP events and fail closed ([5279d77](https://github.com/morluto/rea/commit/5279d7755c74df579028ce51b4bc53b089bb2749))
* **browser:** scope workers and binary frame sizes ([dfc06cf](https://github.com/morluto/rea/commit/dfc06cf0ad4a39719ef74846cb83f05e7b6f6289))
* **browser:** support page-scoped CDP transports ([c4930f4](https://github.com/morluto/rea/commit/c4930f4820dbf114da6fa850500f1415d0d6b7a9))
* **browser:** support page-scoped CDP transports ([bf96192](https://github.com/morluto/rea/commit/bf9619267b45f2383ebdd648dea05a7d2e3945a6))
* **browser:** support relative source map URLs ([5231e95](https://github.com/morluto/rea/commit/5231e95c19d309113a4335fe44a5793e3924219a))
* **build:** preserve native generated-file line endings ([00a3078](https://github.com/morluto/rea/commit/00a3078148e90a2d45648891f96158378c2561ce))
* **capabilities:** expose typed availability codes ([b906def](https://github.com/morluto/rea/commit/b906defbff28885a1d39f78da7c2b7170a7108c6))
* **ci:** automate release version artifacts ([49ae23b](https://github.com/morluto/rea/commit/49ae23bde2281ee7528e8d235fc5e9410efc63e1))
* **ci:** keep generated error docs with their owner ([3e60e38](https://github.com/morluto/rea/commit/3e60e38a147eafa0445e4f9935ede279b4aab688))
* **ci:** keep tool kind type internal ([b9bead2](https://github.com/morluto/rea/commit/b9bead2809eca4448ac28f3e2465f8021a109983))
* **ci:** preserve stacked integration changes ([cf8e5cf](https://github.com/morluto/rea/commit/cf8e5cf5e61fe00731768107790e715958a96fc8))
* **ci:** remove redundant process exports ([19bb231](https://github.com/morluto/rea/commit/19bb2317d1bd6773e5fa3f61e32cbf3d6d257830))
* **ci:** remove retired native rebuild steps ([2d22731](https://github.com/morluto/rea/commit/2d22731ebb3f81483ec8a561ed8b1cb313b4eac1))
* **ci:** remove unused setup type export ([c5728af](https://github.com/morluto/rea/commit/c5728af0b4574631d056f7ed1eb7785e80d80111))
* **ci:** retry published package verification ([0810486](https://github.com/morluto/rea/commit/0810486f636a99b492f26758f6cd0fa65935f5aa))
* **ci:** retry published package verification ([c379455](https://github.com/morluto/rea/commit/c379455da7b32069c861addfbf8d19bb432ddb84))
* **ci:** validate packaged Windows CLI commands exactly ([43418ee](https://github.com/morluto/rea/commit/43418ee9112358d81d56d78b5cbe1ca37f6099be))
* **cli:** confirm project grant revocation ([6397e54](https://github.com/morluto/rea/commit/6397e54169a55b4fcab7ad92f42bbd8f8c616810))
* **cli:** confirm project grant revocation ([7a4cfb4](https://github.com/morluto/rea/commit/7a4cfb4fbd96df34f5502adbf70f5bfb12bbc56c))
* **cli:** make clean source checkouts start reliably ([ed17e76](https://github.com/morluto/rea/commit/ed17e764733c819a1123372ad64d4122ba0c06e3))
* **cli:** make clean source checkouts start reliably ([6ba9765](https://github.com/morluto/rea/commit/6ba97656ca73e97ae1dbecc15a86a193978298b6))
* **cli:** preserve function provider provenance ([c630f41](https://github.com/morluto/rea/commit/c630f410b6a81864bf90211a088c715bfe234722))
* **cli:** render actionable analysis errors ([af8c4ef](https://github.com/morluto/rea/commit/af8c4efb4a415e4bdeae0151a8d29cd71af61916))
* **cli:** require explicit setup selections ([992ec50](https://github.com/morluto/rea/commit/992ec505b279114dcb13230fcd008db8668578af))
* **cli:** restrict production MCP dispatch ([8bd0e5f](https://github.com/morluto/rea/commit/8bd0e5f1ea7f36b23f83113ef285c31a36ff315c))
* **cli:** restrict production MCP dispatch ([190e5d3](https://github.com/morluto/rea/commit/190e5d3282f0f1bc980ad488a7774a500ae3e87d))
* **cli:** retain bundled skill and bias setup wizard toward apply ([5692b3f](https://github.com/morluto/rea/commit/5692b3f809a6868c7c1e4b6f17ca03ad84557427))
* **cli:** retain bundled skill and bias setup wizard toward apply ([fec5c3c](https://github.com/morluto/rea/commit/fec5c3ce7fc8899bf312a67da2c39e8615781748))
* **cli:** return nonzero status for operation failures ([#121](https://github.com/morluto/rea/issues/121)) ([00c187e](https://github.com/morluto/rea/commit/00c187e32b3d2add37245a48f21185c2bd4fc22a))
* **cli:** return nonzero status for operation failures ([#122](https://github.com/morluto/rea/issues/122)) ([964620a](https://github.com/morluto/rea/commit/964620a0a108c3c671d982da37b5d4c05c4ef035))
* **cli:** route JavaScript applications from analyze ([737940c](https://github.com/morluto/rea/commit/737940c90c7507a1b0ede3e839598c922ca7a81e))
* **cli:** route JavaScript applications from analyze ([74965d9](https://github.com/morluto/rea/commit/74965d9088cca6e048a62352567b95c63c6621d2))
* **contracts:** keep error schema internal ([ac8cc66](https://github.com/morluto/rea/commit/ac8cc668fb6b9305d2dc9014f7a6006d96b18ba6))
* **contracts:** make agent-facing schemas self-describing ([0df11dd](https://github.com/morluto/rea/commit/0df11dd4d1de4cb1c4fab6562d874e3be285aeec))
* **contracts:** return structured workflow failures ([4c54ff6](https://github.com/morluto/rea/commit/4c54ff6bcaac02f39c6620a54ac29690a121f33d))
* **copy:** use agent terminology ([12060f6](https://github.com/morluto/rea/commit/12060f6d8dd3ed61fbd1d07fa604652c6b0a93e2))
* **deps:** run freshness check from escaped paths ([8a1c128](https://github.com/morluto/rea/commit/8a1c128b67ee41ce054fe984946a5d7bfcc1a3b4))
* **doctor:** honor explicit Hopper launcher ([c69fe2c](https://github.com/morluto/rea/commit/c69fe2c897b8f567e1607424690e9d59aaefadf1))
* **doctor:** honor explicit Hopper launcher ([9208592](https://github.com/morluto/rea/commit/9208592f41ed920c32206c78fcf43c8d7db77f22))
* **dotnet:** admit real CLI GUID and fat CIL bodies ([735973b](https://github.com/morluto/rea/commit/735973b08b364d45a8e2a551e17ad96c31b039c9))
* **dotnet:** correct CLI pointer and byref signatures ([1387be0](https://github.com/morluto/rea/commit/1387be08dd398ca8ef92410307fe35faa8936ed5))
* **dotnet:** correct CLI pointer and byref signatures ([fb9ff56](https://github.com/morluto/rea/commit/fb9ff5659dffb6af5185c9465ddac6e86eca7dd2))
* **dotnet:** downgrade truncated CIL identity and coverage ([736a4e1](https://github.com/morluto/rea/commit/736a4e1480fb34df12b00372c697acc327b0046c))
* **dotnet:** downgrade truncated CIL identity and coverage ([dae6807](https://github.com/morluto/rea/commit/dae6807c4a4aad7a20c4b9da085e39dcfb58430a))
* **electron:** keep missing unpacked ASAR entries unavailable ([fb6964a](https://github.com/morluto/rea/commit/fb6964a74ea60751560a6d10366bfdad3dab4535))
* **electron:** resolve package and dirname entrypoints by context ([4847fc4](https://github.com/morluto/rea/commit/4847fc4fc14114cbb15350a23f6db4a2ad7962fe))
* **electron:** resolve package and dirname entrypoints by context ([1ac9a09](https://github.com/morluto/rea/commit/1ac9a09ce1574b202d98177392628ba468a568df))
* **errors:** improve recovery guidance ([77454dc](https://github.com/morluto/rea/commit/77454dc8f412e8431bbceff1a4c90ee8f636c9c7))
* **errors:** return actionable caller-safe failures ([fb0da03](https://github.com/morluto/rea/commit/fb0da031cf6305f5aaec5e9ec8178f08fd664479))
* **evidence:** enforce the combined record limit ([c791802](https://github.com/morluto/rea/commit/c7918024bc89995f4054bd499fef88a34a3e24d7))
* **evidence:** enforce the combined record limit ([834c70c](https://github.com/morluto/rea/commit/834c70cf4b9c8dca000c7a20491215d1acc0db89))
* **ghidra:** preserve native endpoint diagnostics ([5970a71](https://github.com/morluto/rea/commit/5970a7182481656e30a8ad51e4855d4c8e50eed7))
* **ghidra:** preserve Windows batch invocation semantics ([0ac418d](https://github.com/morluto/rea/commit/0ac418dd8be62357f852767a64f0d5b5c78495cc))
* **ghidra:** validate Windows control characters explicitly ([4dccbec](https://github.com/morluto/rea/commit/4dccbecf064b56b0d33c7d8c926772353667c739))
* harden PTY events and configured roots ([ae8b1c5](https://github.com/morluto/rea/commit/ae8b1c5ca9c2d122d7fc30ebfa25e08d57ca7a51))
* harden PTY events and configured roots ([31b40f3](https://github.com/morluto/rea/commit/31b40f39e4c29a077deebefbe29e90c30e50cd0c))
* **hopper:** cancel analysis and close documents reliably ([179870e](https://github.com/morluto/rea/commit/179870e8256419402464f02c918146865c6fbb93))
* **hopper:** cancel startup before closing ([f471a63](https://github.com/morluto/rea/commit/f471a63c87679eff9564553741d9967724c57f0a))
* **hopper:** cancel startup before closing ([6cc2fdf](https://github.com/morluto/rea/commit/6cc2fdf80ce2d0220fe996ddbed2f0378f5397cd))
* **hopper:** complete owned Linux shutdown ([#116](https://github.com/morluto/rea/issues/116)) ([fb51874](https://github.com/morluto/rea/commit/fb51874bb9ee1d5144c897e0de4c7e083ba4d390))
* **hopper:** return addresses for procedure relationships ([2c707ab](https://github.com/morluto/rea/commit/2c707abb66433f9065733398a0e5ea9af04cfb96))
* **hopper:** select verified Linux demo mode explicitly ([46e4052](https://github.com/morluto/rea/commit/46e40520285c2338bd1ffedd16599977c333befb))
* **hopper:** select verified Linux demo mode explicitly ([04c5fd6](https://github.com/morluto/rea/commit/04c5fd63b72e6e497363ecbde5e24088eef639cd))
* **javascript:** preserve candidate trace ambiguity ([8678b57](https://github.com/morluto/rea/commit/8678b57b5e03b0fb103803eb0a9e9ebda3124647))
* keep execution options internal ([167a824](https://github.com/morluto/rea/commit/167a824f9131a60d07fca3e99301eecc98d5d5e9))
* **knip:** ignore ps binary and in-file schema exports ([9960982](https://github.com/morluto/rea/commit/99609823ef496245c18c9630dc9ef82fc748ef1a))
* **lifecycle:** validate owned Hopper process identity ([898d6b0](https://github.com/morluto/rea/commit/898d6b0192126030cedd7e5c2cb76f40568cda05))
* **linux:** start Hopper demo sessions headlessly ([32c5080](https://github.com/morluto/rea/commit/32c5080a26cae603f02dce9dc5777e98d1e5fc75))
* **linux:** start Hopper demo sessions headlessly ([75818d1](https://github.com/morluto/rea/commit/75818d119e3eb3b8df5acdbd554a2b86b82af23a))
* **managed:** emit valid x64 conformance PE ([dcd94f1](https://github.com/morluto/rea/commit/dcd94f1472cbdfd5fff90eb26bbac68f5fb2b06b))
* **managed:** emit valid x64 conformance PE ([c52a822](https://github.com/morluto/rea/commit/c52a8223c62ab85373eb86a68dbdc626648aa40f))
* **managed:** preserve page incompleteness in graph and comparison ([a6f02a0](https://github.com/morluto/rea/commit/a6f02a05a48254e46a6485cedfadda426ab60e21))
* **managed:** preserve page incompleteness in graph and comparison ([8ee0f04](https://github.com/morluto/rea/commit/8ee0f04562814e44f77fd8a0f19184c127bcf92e))
* **mcp:** align runtime unknown argument validation ([d1e7220](https://github.com/morluto/rea/commit/d1e72207f48609e3214a66c2a248c70a2a1abd6c))
* **mcp:** clarify advertised schema fields ([1581e40](https://github.com/morluto/rea/commit/1581e40fce733c19e11b460b47722e4121e9fd0e))
* **mcp:** hide managed workflows without a session ([412bbaf](https://github.com/morluto/rea/commit/412bbaf05e0d6fa5add68303c83325628cc2e7da))
* **mcp:** integrate managed contracts after rebase ([9c4a93d](https://github.com/morluto/rea/commit/9c4a93d9b1be36155bd9c0a39d8b541ec3986c64))
* **mcp:** normalize inferred field descriptions ([a807471](https://github.com/morluto/rea/commit/a807471e4e612e215ef82ebd2d16a1c454d5ad31))
* **mcp:** parse adapter inputs exactly once ([37c0f39](https://github.com/morluto/rea/commit/37c0f399544c9424c55e468d6784da61426a458e))
* **mcp:** preserve investigation input policy ([5a908a0](https://github.com/morluto/rea/commit/5a908a03a673fe499421283a9309c52164d14a9d))
* **mcp:** preserve investigation input policy ([f4156d9](https://github.com/morluto/rea/commit/f4156d9663a1847d5b3bbe29f98036b9c76606b4))
* **mcp:** preserve migrated revisions and valid links ([4149472](https://github.com/morluto/rea/commit/414947243963fed5f769a124758424dda371dcd7))
* **mcp:** remove arbitrary schema byte gate ([fd08025](https://github.com/morluto/rea/commit/fd08025dcd21cc31fa1e7356c90e76b4863b1af2))
* **mcp:** remove schema byte compaction ([f728295](https://github.com/morluto/rea/commit/f728295bd00585623b9597cf5702051aefa8ddc9))
* **native:** classify pre-aborted analysis first ([dfd598f](https://github.com/morluto/rea/commit/dfd598f76505af978f2d11afffb5e1f362d3a769))
* **native:** harden command capture edge cases ([c2e64a4](https://github.com/morluto/rea/commit/c2e64a42c84bd245f3df4eb8b61039c8594704f8))
* **native:** harden command capture edge cases ([d39f98d](https://github.com/morluto/rea/commit/d39f98d06dd53cdfd427e75e2f45f2c8b8792f50))
* **npm:** use latest entry points without install scripts ([34252f5](https://github.com/morluto/rea/commit/34252f55e963fcd63c0fd127dc249ba2c8398082))
* **npm:** use latest entry points, remove install scripts, and rename skill ([bf85ee6](https://github.com/morluto/rea/commit/bf85ee62c976dd06fdc47429a9b3c7f3d99b7f3b))
* **package:** accept expected doctor diagnostics ([0f2d013](https://github.com/morluto/rea/commit/0f2d01300a4bc9fc534114a6913ec8dfcd5fa457))
* **permission:** defer cache write grants ([6a3fd5b](https://github.com/morluto/rea/commit/6a3fd5b4cec7569eebfe8a7ca6a7c0c1e3a7340d))
* **permission:** defer cache write grants ([f840e70](https://github.com/morluto/rea/commit/f840e70749ffadfe34cf8b7e464b54e8ffebd816))
* preserve actionable artifact diagnostics ([#119](https://github.com/morluto/rea/issues/119)) ([7385220](https://github.com/morluto/rea/commit/73852202d42743fe5589fd9477f0d0991d87c060))
* preserve optional unknown filters ([db1efef](https://github.com/morluto/rea/commit/db1efef9d285d1726f56c288593161434b9f322f))
* preserve requested evidence paths on macOS ([0c0e2b8](https://github.com/morluto/rea/commit/0c0e2b8a1efb3f56672b9c95fda5c5ab5746284b))
* preserve requested evidence paths on macOS ([3d0ad79](https://github.com/morluto/rea/commit/3d0ad799c4deb1d3627d8721c31bc76be3f3abd2))
* preserve setup diagnostics and clean Knip config ([2d1e021](https://github.com/morluto/rea/commit/2d1e021782dc903faaa401207dad47278bfb57b2))
* preserve setup diagnostics and clean Knip config ([5a7ccef](https://github.com/morluto/rea/commit/5a7ccefc68e3d7359bfd9a6262701641da380d37))
* **process:** bound trace comparison semantics ([b4df565](https://github.com/morluto/rea/commit/b4df565b779c4f38ebf1c784dad73bf7f3de68eb))
* **process:** default capture networking to loopback ([bce3398](https://github.com/morluto/rea/commit/bce3398dbe3a3b20952f37573a656aa77b168977))
* **process:** gate sampling on initialized PTY root ([57938a8](https://github.com/morluto/rea/commit/57938a8465add2d6e89dae13e66059bad7f72a45))
* **process:** gate sampling on initialized PTY roots ([e831a41](https://github.com/morluto/rea/commit/e831a41375148336d72beadd5d13405047c82e67))
* **process:** harden capture validation and cleanup ([ac78de0](https://github.com/morluto/rea/commit/ac78de0a74b09a01efd91d9f88a16fde4f0ed9d9))
* **process:** keep network approval fail-closed ([9526389](https://github.com/morluto/rea/commit/9526389f815f0937fc01198ff3a8a850c6c1c81a))
* **process:** keep validation detail internal ([614a119](https://github.com/morluto/rea/commit/614a1197f5b699b61c46d82a24e0564bf0d87829))
* **process:** normalize resize frame timestamps ([74d1c7b](https://github.com/morluto/rea/commit/74d1c7b2748a88341b98bd463be3ad227501c4f4))
* **process:** normalize resize frame timestamps ([77696df](https://github.com/morluto/rea/commit/77696dff9144fd6c110247711bbff144ec63b19b))
* **process:** preserve nonconforming differences ([f1cc485](https://github.com/morluto/rea/commit/f1cc48558122a922365a1b71dbf4fb196b037825))
* **process:** preserve replay event causality ([d895e49](https://github.com/morluto/rea/commit/d895e49145222eb02eb34cd7de93c5212884f5cc))
* **process:** protect unrelated Hopper during cleanup ([81539c4](https://github.com/morluto/rea/commit/81539c47fb5dbebec83e83526685b0f6b85095aa))
* **process:** protect unrelated Hopper during cleanup ([e4ee4c9](https://github.com/morluto/rea/commit/e4ee4c963547f026defe3f5e5e2978c1ab2e6f21))
* **process:** restrict cleanup to captured group leaders ([40c6f60](https://github.com/morluto/rea/commit/40c6f60ac9a4b86f4cbe28a72e7692e1acf761b1))
* **process:** settle exited zombie groups ([072ce5a](https://github.com/morluto/rea/commit/072ce5aede03a2dab59ce8776a04063218448925))
* **process:** settle exited zombie groups ([4828326](https://github.com/morluto/rea/commit/482832607910a6e872bccc27c956eeaf55dd6056))
* **process:** stabilize and speed up the test suite ([a3b7de9](https://github.com/morluto/rea/commit/a3b7de9fa5e89808a3c01a5623779709edb7c691))
* **reference:** preserve distinct parse failures ([e02cb2f](https://github.com/morluto/rea/commit/e02cb2f877e8fd9874245ee6e15f68666afaeb46))
* **reference:** preserve distinct parse failures ([543510f](https://github.com/morluto/rea/commit/543510f62fd257b42e6a7dfc876112dda0e0ea01))
* regenerate release product catalog ([732d606](https://github.com/morluto/rea/commit/732d606609d220ecc4d6e6812e0bcab70bc1b608))
* regenerate release product catalog ([f1694c2](https://github.com/morluto/rea/commit/f1694c27424f0c88cd971e31720de0f9f31c94bf))
* remove unused boundary exports ([49f1ec1](https://github.com/morluto/rea/commit/49f1ec14fe4f5b67345ff9dde8af8ef1066fb3c8))
* resolve triaged correctness issues ([2575b30](https://github.com/morluto/rea/commit/2575b30dfcb79c2e26ed16311f780a8723578c6a))
* resolve triaged correctness issues ([e8ed307](https://github.com/morluto/rea/commit/e8ed3073ac915e32b5ea630446ed6e14bc788119))
* resolve validation and artifact edge cases ([2468682](https://github.com/morluto/rea/commit/246868232e4196394fbc6e67cfae4d3ca214fe60))
* resolve validation and artifact edge cases ([ef7f2f9](https://github.com/morluto/rea/commit/ef7f2f93747f0a4d9f70c9fc2e252456d20843f3))
* rollup batch of fixes ([b348b2c](https://github.com/morluto/rea/commit/b348b2c98772b3d38b33e6aa4d14ae7dce78a4b9))
* **runtime:** apply permission reloads atomically ([49e843e](https://github.com/morluto/rea/commit/49e843e8ff2eb87bf1c6174823191cc97ad1ced8))
* **runtime:** apply permission reloads atomically ([3ae7109](https://github.com/morluto/rea/commit/3ae7109faa29175e84ef695b296ad4db14097a37))
* **runtime:** serialize permission reloads ([7e53dd6](https://github.com/morluto/rea/commit/7e53dd6ad321f9b75dbe458f9e116da7637d740c))
* **runtime:** unregister shutdown handlers ([71072d8](https://github.com/morluto/rea/commit/71072d86b161530d523a10e920e5d67ca220a7e9))
* **runtime:** unregister shutdown handlers ([f9e3c23](https://github.com/morluto/rea/commit/f9e3c23987bdf37be07d6c4602666c6ac90ae0ed))
* satisfy dead-code and generated-doc checks ([b15a9ec](https://github.com/morluto/rea/commit/b15a9ecfef55dec00b92babf92883f6dedaa2209))
* **security:** restrict investigation artifact inputs ([a2076b4](https://github.com/morluto/rea/commit/a2076b47a6b43d9c80396ee4a5954af590d65088))
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
* **setup:** preserve onboarding after refactor ([da48033](https://github.com/morluto/rea/commit/da48033c191f491f47b9933f65806f0f0a223643))
* **setup:** replace managed Hopper on reinstall ([0ca93f9](https://github.com/morluto/rea/commit/0ca93f9779bc6c576479561c488982963fbb9167))
* **skill:** disclose retired skill cleanup ([4c69e61](https://github.com/morluto/rea/commit/4c69e6120a2c0a630272e845cda2112724c4be7b))
* **test:** adapt mainReload shutdown seam to registerShutdown signature ([0a430c1](https://github.com/morluto/rea/commit/0a430c12c158cf7f1ef04cdf537d5277c08c6106))
* **test:** make host fixtures portable ([f23f529](https://github.com/morluto/rea/commit/f23f52903cb6df4eed6fec0e09f79c82ad9825dc))
* **tooling:** isolate concurrent repository checks ([fb17156](https://github.com/morluto/rea/commit/fb17156499c592b5e18ffae996c55c372e3727d0))
* **tooling:** isolate concurrent repository checks ([ab8c5c1](https://github.com/morluto/rea/commit/ab8c5c1e13041690e07896f2f2f0dfa2134ad97e))
* **upgrade:** prevent version downgrades ([a204840](https://github.com/morluto/rea/commit/a2048406302b808e4f897eabd6c00ce64c529c16))
* **upgrade:** prevent version downgrades ([1d1d234](https://github.com/morluto/rea/commit/1d1d234eedd3b73108cd2fb41878680ca107bb7c))
* **verify:** reconcile PR-212/215/228 package E2E expectations ([cfa110c](https://github.com/morluto/rea/commit/cfa110ccb4021d383cc8be1caa17fef923edc183))
* **workspace:** migrate legacy integrity identities ([d092d4c](https://github.com/morluto/rea/commit/d092d4c97a51882f7cdbc0e3dd167cea309b8adf))


### Performance Improvements

* **application:** scan version artifacts in parallel ([528c05e](https://github.com/morluto/rea/commit/528c05e2faa557e17b6b83ccd7e1b0e779ba892a))
* **application:** scan version artifacts in parallel ([c00739b](https://github.com/morluto/rea/commit/c00739bb1f1ae3cb6f00464e8fd9f5b5f7dc6b6e))


### Code Refactoring

* **adapters:** split oversized provider workflows ([1a99a60](https://github.com/morluto/rea/commit/1a99a60a29c231c7a104c5900c2c20a7d10268d5))
* **app:** split session and CLI workflows ([c6ee004](https://github.com/morluto/rea/commit/c6ee0049c4bffe2880ddb8cf5a2a6c4195ae18f6))
* **artifacts:** simplify inventory traversal ([c8d762e](https://github.com/morluto/rea/commit/c8d762e6ffe0a2e23fb539590d7b1850ef1ce2a7))
* **cli:** share direct analysis tool types ([329fdf6](https://github.com/morluto/rea/commit/329fdf6fe8f3a2bf9679b13a8ce5cb16cf946129))
* **domain:** remove provider-specific target and snapshot state ([21da71e](https://github.com/morluto/rea/commit/21da71ec6d30a63e497b871d16a69ab02f5b210b))
* **domain:** split analysis boundaries ([e2c868c](https://github.com/morluto/rea/commit/e2c868c4bdd4f83f1e33a50bca0e3d91d4605387))
* finish lint cleanup ([2bea405](https://github.com/morluto/rea/commit/2bea40571d47f8b3454cdb9b467839521d3174b4))
* **managed:** split metadata analysis ([20c88dd](https://github.com/morluto/rea/commit/20c88dd5676a3081e13bef26cfa38d8a69856842))
* **mcp:** remove obsolete managed evidence parser ([f7aa191](https://github.com/morluto/rea/commit/f7aa19154d9bc24b3ccdb8bde40ee926f06049a1))
* **process:** extract capture journal recorder ([a32b988](https://github.com/morluto/rea/commit/a32b988a35a31d0fbabaa861eddb6e3bbb363943))
* **process:** extract reusable provider lifecycle primitives ([70e1a0f](https://github.com/morluto/rea/commit/70e1a0f5326fa1598e4f4e673a4ba1545cef5b65))
* **process:** split trace comparison domain logic ([75d5a87](https://github.com/morluto/rea/commit/75d5a8705498bf567a9860eef9eecdf4521c9cc6))
* **process:** split trace comparison helpers ([6d8ecd2](https://github.com/morluto/rea/commit/6d8ecd2b88ddd4868ee55bef84bf88a542d4616b))
* **setup:** keep planner helpers private ([2d1f961](https://github.com/morluto/rea/commit/2d1f9616b76b9e383d0196b820a377573def836d))
* **setup:** split setup and CLI registration ([07e1b5a](https://github.com/morluto/rea/commit/07e1b5ac5f6a1724b1064c47ea05f04ccffcb4f3))
* simplify authorization boundaries ([2e5b443](https://github.com/morluto/rea/commit/2e5b44365fd1ea3c515efd03b56fee0083a20a31))
* simplify doctor and error projections ([37f4ac6](https://github.com/morluto/rea/commit/37f4ac6d7073693fb4d2290b5aff6bcb6b36cd19))
* **skill:** keep only the canonical skill identity ([a7c1e87](https://github.com/morluto/rea/commit/a7c1e87365cec0333bc9431ec5d7418cb7a54be1))
* **skill:** remove legacy skill compatibility ([8cf0dd2](https://github.com/morluto/rea/commit/8cf0dd2bf645d18afe6a9c8493178bdd905c0647))
* split oversized analysis workflows ([af2399e](https://github.com/morluto/rea/commit/af2399eeacbca5f1af344c7d7ef747f3d976bcf7))
* split oversized analysis workflows ([3e61a63](https://github.com/morluto/rea/commit/3e61a63a104859e1c8ca3bcdc6bad0511d1f1735))
* **windows:** keep capability outcomes module-private ([585f523](https://github.com/morluto/rea/commit/585f52389107c79cea99ecd26ea87cbcda08d245))


### Documentation

* add Hopper screenshot to README ([a699fdd](https://github.com/morluto/rea/commit/a699fdd6a5cc9c9812c7d78fd98b51469488866f))
* add Hopper screenshot to README ([08981a3](https://github.com/morluto/rea/commit/08981a31b5e9b76e15914c0570244158d491e047))
* **analysis:** define managed-code evidence boundary ([80faff3](https://github.com/morluto/rea/commit/80faff3e5bf8baa65b0b18e03594e86753a76ac6))
* **api:** refresh managed reconstruction contracts ([2b06433](https://github.com/morluto/rea/commit/2b064335ea63db4484d16b35544dd5e8024ecf6d))
* **api:** refresh profile source anchors ([bd3cf96](https://github.com/morluto/rea/commit/bd3cf964d62bea2571559cfde6bdfe686922255f))
* **api:** refresh provider source anchors ([a7621c2](https://github.com/morluto/rea/commit/a7621c263392a92c63162febf511824c9c788548))
* **api:** regenerate TypeDoc reference ([0a66cae](https://github.com/morluto/rea/commit/0a66cae16ef8e2a243bbed502bbb7cdbd12a965f))
* **architecture:** define provider selection and analysis profiles ([75f8696](https://github.com/morluto/rea/commit/75f8696a57cf25a2a72a2a337d8076214f04ece4))
* **architecture:** define provider selection and analysis profiles ([f9f2fbe](https://github.com/morluto/rea/commit/f9f2fbe2fc04bd202d9fd580fc54c30529809fc0))
* **cli:** clarify setup consent comment ([e869137](https://github.com/morluto/rea/commit/e8691378a07b083277e3b963c5f6d179e12d7626))
* **cli:** describe every command input ([d4be3e7](https://github.com/morluto/rea/commit/d4be3e7f9a609050303c82aa83d4884bb6daae77))
* correct pull request tool inventory ([d806480](https://github.com/morluto/rea/commit/d806480e41bcb623448a258ddffeb75082fe1e1f))
* define REA contributor priorities ([5df4ef6](https://github.com/morluto/rea/commit/5df4ef67a4676f46900aa6022c1af2224efa8761))
* document capture v4 and native mounts ([aca518b](https://github.com/morluto/rea/commit/aca518bb885825b912567eba95eb64a776a5624c))
* document CLI safety and provider evaluation ([efc9bd2](https://github.com/morluto/rea/commit/efc9bd270f58a5aaba15edb07cee135d2c54db83))
* document installation and Linux support ([034563a](https://github.com/morluto/rea/commit/034563a4c015c69e878054d4fd06e0e9fa630e24))
* document process capture v3 ([50f4a29](https://github.com/morluto/rea/commit/50f4a298f44bf56dc78d5717cb23d69db5df4265))
* document the 43-tool workflow ([1f235cb](https://github.com/morluto/rea/commit/1f235cb52f61c08b65ecb674cac649c34005bc66))
* **dotnet:** refresh managed reconstruction api ([cc1e47c](https://github.com/morluto/rea/commit/cc1e47c615bbbb6d2f7dc24ec1710c39e4b96bf4))
* explain the installation workflow ([1c83263](https://github.com/morluto/rea/commit/1c83263bbb79aa050d1e560d17da66557afdbad2))
* **ghidra:** define the experimental Windows P0 ([8b5ae41](https://github.com/morluto/rea/commit/8b5ae417f3a69e679ad69574f13d1d179ebb22c3))
* list upgrade in CLI reference ([8a24088](https://github.com/morluto/rea/commit/8a24088c2bffd34050ea6f6f0e103f64a3f67a64))
* **managed:** align normalized CIL claims with shipped v1 semantics ([9a92a79](https://github.com/morluto/rea/commit/9a92a7958cceedafe184b48ca93ab094386401a7))
* **managed:** align normalized CIL claims with shipped v1 semantics ([3f788e9](https://github.com/morluto/rea/commit/3f788e9065d5ce457ba174c13bc8e4e0b74d5156))
* normalize inherited source paths ([d33213a](https://github.com/morluto/rea/commit/d33213a99c824b5834323c924dac6b7852df5831))
* preserve generated source links ([2ea375f](https://github.com/morluto/rea/commit/2ea375f8ea413aba05baab0d9af3e3401d8b2956))
* prioritize agent usability in tool design ([ad17fe7](https://github.com/morluto/rea/commit/ad17fe7aa71f5cbffcdff3e27b08bc4538e73c7d))
* **process:** preserve capture invariants ([841990b](https://github.com/morluto/rea/commit/841990bde158a996be65feabcef4aa5e18fc3a4b))
* reconcile product documentation with shipped behavior ([addc208](https://github.com/morluto/rea/commit/addc208f12790e3b0e48697c75e978e08814d303))
* reconcile product documentation with shipped behavior ([54056a9](https://github.com/morluto/rea/commit/54056a9782f3f51f8f1b510d8b9c1bf4c3c9f067))
* redesign and localize README ([051b6db](https://github.com/morluto/rea/commit/051b6db65687fd14826b6462cd623feb2504f123))
* refresh 2.2.0 generated metadata ([909139e](https://github.com/morluto/rea/commit/909139e4b69538982b7cfc28e3bc67ee3744426b))
* refresh application workflow API links ([4a30820](https://github.com/morluto/rea/commit/4a30820a93a33f4ebb7b69202890c5c6a114ba0f))
* refresh Electron path resolution API ([734a4ef](https://github.com/morluto/rea/commit/734a4ef04fce7bbff76b3fbf9c3f1250d7ab8963))
* refresh generated API links ([a2089a4](https://github.com/morluto/rea/commit/a2089a40671b3edae7db98ce37587da87f093d1b))
* refresh generated API reference ([f5f653b](https://github.com/morluto/rea/commit/f5f653bd8dba8d441efe13f2404b8677dc6dd8f3))
* refresh generated artifacts for 1.7.0 ([3988a86](https://github.com/morluto/rea/commit/3988a866f1bf0db8e639955feb1d20edd5c29ac7))
* refresh generated artifacts for 1.7.0 ([13c79b6](https://github.com/morluto/rea/commit/13c79b670a4df2bfed80a38f61c245ddee6c8baf))
* refresh generated artifacts for 1.7.0 ([4647b32](https://github.com/morluto/rea/commit/4647b324b8bc7a7a96005fa1c91dd998974b3980))
* refresh Ghidra inventory API links ([a45de27](https://github.com/morluto/rea/commit/a45de27d9e97b8c7a76b3e6da12b0b4efdfa5dcb))
* refresh managed native verification api ([849c052](https://github.com/morluto/rea/commit/849c05290aced212505c2621f208e89266c3ea96))
* refresh managed runtime api docs ([798631a](https://github.com/morluto/rea/commit/798631ade628464b6b233d240e53b7eea44721a0))
* refresh Node 24 TypeDoc output ([846193c](https://github.com/morluto/rea/commit/846193c60305242b27f39c69715f332627ba1725))
* refresh product catalog for 1.7.0 release ([0f97e21](https://github.com/morluto/rea/commit/0f97e21bf77427edb07be1ddac6493a59f9e35d8))
* refresh runtime reconciliation API ([87b2348](https://github.com/morluto/rea/commit/87b23482e28ed4e43674c4b9a775da4b16cb4636))
* regenerate 2.1.0 release metadata ([2ea4589](https://github.com/morluto/rea/commit/2ea45899c17be06628876ddc25dae4229a2797cb))
* regenerate JavaScript graph API with Node 24 ([da4817a](https://github.com/morluto/rea/commit/da4817abd10fe2d6b68bf4d393d067ce42ece910))
* regenerate managed coverage API with Node 24 ([e47c00e](https://github.com/morluto/rea/commit/e47c00ef04b537bd67caff69d27f48a81bdf04e3))
* **security:** define controlled replay authority ([461990d](https://github.com/morluto/rea/commit/461990da3f8e4ec573217432943f04311d577524))
* simplify REA onboarding ([e1dfe86](https://github.com/morluto/rea/commit/e1dfe8613e5a986d5ee64764851f0abcc901398b))
* simplify REA onboarding ([d85b661](https://github.com/morluto/rea/commit/d85b661be80bd19d477c46ebe0501839c7b63ee7))
* **skill:** document capture v4 and DMG mounts ([f0a9a3c](https://github.com/morluto/rea/commit/f0a9a3cd258d60046dcd74feea243956489c60dc))
* stabilize replay API source links ([a8c1057](https://github.com/morluto/rea/commit/a8c1057279d529d9f16ab9b093b0f6518915b6fa))
* update application projection API ([b0cb28a](https://github.com/morluto/rea/commit/b0cb28a9bf04f849e792346306bb42ed4fac6b29))
* update paired process experiment API ([a222327](https://github.com/morluto/rea/commit/a222327f304555104b51370d0955dc6c8ca4d0ce))
* update replay machine API ([d74f897](https://github.com/morluto/rea/commit/d74f89754fe4e5c19a757893a3fe388f2c64372f))


### Tests

* add limit monotonicity and partial-evidence regressions ([2cce98c](https://github.com/morluto/rea/commit/2cce98cca29ab8752c34281c4b439a0150308b2c))
* add limit monotonicity and partial-evidence regressions ([4afd970](https://github.com/morluto/rea/commit/4afd97029c3eebc0c755b0c9dee2fd74217a1305))
* add package installation end-to-end coverage ([993356b](https://github.com/morluto/rea/commit/993356b85adc72036ba44cd87b9335e2ec172a32))
* add source-built Hopper conformance fixtures ([d648bcd](https://github.com/morluto/rea/commit/d648bcd2e41ec0b45bc02a69dee0d7206fc64f8f))
* **application:** verify packaged MCP replay ([6601e0c](https://github.com/morluto/rea/commit/6601e0cb7e57fe94cf0ae65bf0d04de25a3a7b49))
* **browser:** harden Chrome startup on CI ([74c5121](https://github.com/morluto/rea/commit/74c512130c5bc25d6c119eda72a86e73fcc9f1ff))
* **browser:** route discovery sockets through proxy ([e363f0e](https://github.com/morluto/rea/commit/e363f0eab8325a9f83568295d4669d70e7d47a2d))
* **browser:** stabilize real shape capture ([bb2e243](https://github.com/morluto/rea/commit/bb2e2432a5ff4634b4f54eff7834b6da826f725f))
* **browser:** verify page-scoped Chrome transport ([c252536](https://github.com/morluto/rea/commit/c252536494c15f36e69978eaf068eae176e71688))
* budget CLI output variant subprocesses ([8d3587b](https://github.com/morluto/rea/commit/8d3587bbcac18e90652cc95e5853158a4f9aef18))
* cap workers across all hosts ([bc80359](https://github.com/morluto/rea/commit/bc8035918b1d6a3eac7fc2307867d4dc2787d3b5))
* **ci:** guard Windows Ghidra workflow isolation ([81ed68f](https://github.com/morluto/rea/commit/81ed68f67d8332b3013131dc6d86a001d1dc55a3))
* **ci:** guard Windows Ghidra workflow isolation ([98540c8](https://github.com/morluto/rea/commit/98540c8a12722aaa005102518746916018107ccb))
* **cli:** allow cold-start integration timing ([7d5621d](https://github.com/morluto/rea/commit/7d5621dfbc4333f99846cbe52227d3b4f53ee0cd))
* **cli:** cover package-name binary alias ([40e2f94](https://github.com/morluto/rea/commit/40e2f943a52cbf957db2ae898c3624e5ac5faec6))
* **cli:** verify packaged policy revocation ([3d71737](https://github.com/morluto/rea/commit/3d71737dc9ba8b449c0d174da90c3f1df54789d2))
* **docs:** keep localized claims and tool counts aligned ([a7b84a9](https://github.com/morluto/rea/commit/a7b84a9b4b7ea4336c0f327e13b2948a8d94fba9))
* **dotnet:** add managed conformance verifier ([2b75fcf](https://github.com/morluto/rea/commit/2b75fcfaac8432b08b2d88cd95492333df2674d4))
* **dotnet:** verify managed app graph manifests ([5be4051](https://github.com/morluto/rea/commit/5be405169ef752e34199022e97c5fa4896693472))
* **dotnet:** verify managed app graph manifests ([a5e5c68](https://github.com/morluto/rea/commit/a5e5c68d117cdef33a47291ed4f641c9a89045f3))
* **dotnet:** verify managed app manifests ([793a948](https://github.com/morluto/rea/commit/793a948c1b6a61ce3ba2860fe977b19180c6fa9b))
* **hopper:** add semantic runtime conformance ([da1da3b](https://github.com/morluto/rea/commit/da1da3bfb83e2fdd2a7a0a84a6a70aa73a4a68d6))
* **hopper:** avoid scheduler-sensitive exit timing ([6e6827c](https://github.com/morluto/rea/commit/6e6827cd76fc080a959695ab19bfcc34b80c270c))
* **hopper:** cover verified Linux rejection ([db202c2](https://github.com/morluto/rea/commit/db202c2b6ac9ce771c401cc558c56ecf6d2e51ee))
* **hopper:** retry after cancelled startup ([6de726f](https://github.com/morluto/rea/commit/6de726ffddc54ea354e6970f022eaab2f0863586))
* **hopper:** verify alternate Linux launcher path ([d93257b](https://github.com/morluto/rea/commit/d93257b50fae81272cbd2da28ba24d03647c2c99))
* **identity:** defer live MCP integration proof ([74db3fc](https://github.com/morluto/rea/commit/74db3fcd4259f3c09fb29cc7762952320b99ae71))
* inherit root options in Vitest projects ([168100e](https://github.com/morluto/rea/commit/168100e5326958fc89431a26a1f3cca762516133))
* isolate slow filesystem and CLI suites ([c2e134b](https://github.com/morluto/rea/commit/c2e134b8e46d780b61faab1021772704380e6a37))
* keep package setup verification read-only ([acaf030](https://github.com/morluto/rea/commit/acaf03056d6b457d85c6b7744565d6c7d56c424c))
* **linux:** verify setup through CLI and MCP ([67504d2](https://github.com/morluto/rea/commit/67504d2d51151fd9eed76b12c9bae67c70817432))
* **mcp:** cover strict compact wire contracts ([8de25d0](https://github.com/morluto/rea/commit/8de25d02302e7a03c1a0c6ab19ccb459758973ca))
* **mcp:** derive sessionless managed inventory ([cab7c4a](https://github.com/morluto/rea/commit/cab7c4a5212eb5bf2b233c835ac57b5764a4e0f3))
* **package:** align setup preflight contract ([b33ebb1](https://github.com/morluto/rea/commit/b33ebb1627423a09fa56b628284362118e68ca40))
* **package:** cover aligned setup plan ([a597639](https://github.com/morluto/rea/commit/a5976396eb424933232844e161cdab84b452b361))
* **package:** cover config symlink lifecycle ([d1ef7a5](https://github.com/morluto/rea/commit/d1ef7a54394ff2ed4316ba01cfe0aa4aac313aed))
* **package:** preserve unrelated symlink config ([c50e51e](https://github.com/morluto/rea/commit/c50e51eb6fe5686ad9d680abe0d96b3e4b58dc78))
* **package:** preserve unsupported host verification ([977119f](https://github.com/morluto/rea/commit/977119f91b4af39ea208a5e63d9445bf366b2eeb))
* **process:** use deterministic hang fixture ([ba15d16](https://github.com/morluto/rea/commit/ba15d16c5869ef29e85a0e9bacff3ac07edda3a2))
* reduce test suite runtime ([2223da1](https://github.com/morluto/rea/commit/2223da19166a3ec485d98a0d005113a9d0358f37))
* **reference:** cover failure normalization ([3d5041f](https://github.com/morluto/rea/commit/3d5041fb2f8964c30f0273615b4f039620eef0bf))
* **replay:** use portable seam executables ([3183f47](https://github.com/morluto/rea/commit/3183f47c0f785bdda52f9db6613932440094c522))
* **runtime:** cover idempotent handler cleanup ([1bdb59e](https://github.com/morluto/rea/commit/1bdb59e201a26b53f5ed8b2eb870941ca4b788f7))
* serialize subprocess-heavy integrations ([f46fc7f](https://github.com/morluto/rea/commit/f46fc7f1f3a265123c69d007c64c928a8974d98f))
* **session:** reopen replaced target through MCP ([1c32880](https://github.com/morluto/rea/commit/1c32880e56450b610d766c5a6c1bee6873ee6323))
* **setup:** cover later clients after failure ([8f73112](https://github.com/morluto/rea/commit/8f7311285b2ba7a1ed427d61e437dd2665e20d12))
* stabilize artifact pagination coverage ([f56bdde](https://github.com/morluto/rea/commit/f56bdde27679e1f05b34d2cf5efbc6e49bd4c2ca))
* stabilize subprocess-heavy integration suites ([a556e94](https://github.com/morluto/rea/commit/a556e945096fd9430fc48217a2f4b6dc3d06518c))
* strengthen MCP prompt acceptance coverage ([05fb9b1](https://github.com/morluto/rea/commit/05fb9b17c91b2ed7bfb58c3399499e0fb9e3f73e))
* **verification:** strengthen conformance and real-Hopper checks ([0d36976](https://github.com/morluto/rea/commit/0d369762770d2d92dd72c7dcb2f2f90a64b206ff))


### Continuous Integration

* enforce conventional pull request titles ([07a0b98](https://github.com/morluto/rea/commit/07a0b984f2bdbc4fe1ce18d5db13500aa8f3992f))
* enforce conventional pull request titles ([3a21f16](https://github.com/morluto/rea/commit/3a21f16c1832430765083636511a8c12dbccf2dd))
* **ghidra:** add Windows P0 acceptance and real-engine lanes ([0b35510](https://github.com/morluto/rea/commit/0b3551076d591be04efbb829d3eb1d17bcc828a9))
* remove redundant typecheck, lint, and format compatibility jobs ([eb27f01](https://github.com/morluto/rea/commit/eb27f01aeef0f531eebeb0342eba6cc507dfa6f4))
* remove redundant typecheck, lint, and format compatibility jobs ([aeb5cb3](https://github.com/morluto/rea/commit/aeb5cb3adb0e43c45017cf61d2a95bac200024ae))
* remove release check trigger ([c9bd91d](https://github.com/morluto/rea/commit/c9bd91d7c33c7adf15b296f3d89f53e32ea49679))
* shard coverage tests and skip docs-only suites ([c736317](https://github.com/morluto/rea/commit/c7363178e7c8c1f8db1e69085bcd0826293e3814))
* shard coverage tests and skip docs-only suites ([fa58082](https://github.com/morluto/rea/commit/fa58082bf0268b9f9f6c7aac2d6871576e7d5fae))
* trigger release checks ([e698c97](https://github.com/morluto/rea/commit/e698c977ed16df7c88abb0dc55878ecca44e09b6))
* verify installed package with Linux Hopper ([4f97f69](https://github.com/morluto/rea/commit/4f97f699e4d5471557d1ce0ff91e144065d06a61))

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
