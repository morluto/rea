# Changelog

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
