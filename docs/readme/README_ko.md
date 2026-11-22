<div align="center">

[English](../../README.md) · [简体中文](README_zh.md) · [繁體中文](README_zh-TW.md) · [日本語](README_ja.md) · **한국어** · [Türkçe](README_tr.md) · [Русский](README_ru.md) · [Tiếng Việt](README_vi.md) · [ไทย](README_th.md) · [Deutsch](README_de.md) · [Español](README_es.md) · [Français](README_fr.md) · [Українська](README_uk.md) · [Polski](README_pl.md) · [Português (Brasil)](README_pt-BR.md) · [العربية](README_ar.md) · [فارسی](README_fa.md) · [Bahasa Indonesia](README_id.md) · [Italiano](README_it.md)
· [Ελληνικά](README_el.md) · [മലയാളം](README_ml.md) · [Roman Urdu](README_ur-Latn.md) · [Română](README_ro.md) · [Български](README_bg.md) · [বাংলা](README_bn.md)

# REA: 무엇이든 리버스 엔지니어링

### 하나의 MCP로 바이너리, 애플리케이션, 런타임 동작을 리버스 엔지니어링합니다.

**마음에 드는 기능을 발견했다면, 바이너리 수준까지 작동 원리를 이해하세요.**

[![GitHub stars](https://img.shields.io/github/stars/morluto/rea?style=flat-square&logo=github)](https://github.com/morluto/rea/stargazers)
[![Monthly npm downloads](https://img.shields.io/npm/dm/rea-agents?style=flat-square&label=npm%20downloads)](https://www.npmjs.com/package/rea-agents)
[![MIT license](https://img.shields.io/badge/license-MIT-f4c430?style=flat-square)](../../LICENSE)
[![Join the REA Discord](https://img.shields.io/badge/Discord-5865F2?style=flat-square&logo=discord&logoColor=white)](https://discord.gg/GkcryMnJDM)
[![Follow REA on X](https://img.shields.io/badge/X-000000?style=flat-square&logo=x&logoColor=white)](https://x.com/reatools)
[![Supported platforms: macOS, Windows, and Linux](https://img.shields.io/badge/macOS%20%7C%20Windows%20%7C%20Linux-4493F8?style=flat-square)](../getting-started/installation.md)
[![skills.sh](https://skills.sh/b/morluto/rea?style=flat-square)](https://skills.sh/morluto/rea/reverse-engineer-anything)

**[웹사이트](https://rea.tools/ko/) · [가이드](https://rea.tools/ko/guides/) · [사례](https://rea.tools/ko/showcase/)**

<a href="https://discord.com/invite/GkcryMnJDM"><img alt="Discord에서 REA 커뮤니티에 참여하세요" src="https://img.shields.io/badge/Join%20us%20on%20Discord-5865F2?style=for-the-badge&logo=discord&logoColor=white" height="40"></a>

[빠른 시작](#빠른-시작) · [사례](#사례) · [REA의 작동 방식](#rea의-작동-방식) · [분석할 수 있는 대상](#분석할-수-있는-대상) · [RL 환경 만들기](#build-rl-environments) · [자주 묻는 질문](#자주-묻는-질문) · [문서](#문서)

<code>npx rea-agents setup</code>

</div>

> [!IMPORTANT]
> REA 공식 배포처: [morluto/rea](https://github.com/morluto/rea), [rea.tools](https://rea.tools/), [rea-agents](https://www.npmjs.com/package/rea-agents) (npm).
> 이 공식 배포처에서 제공하는 설치 및 릴리스 링크를 이용하세요. 비슷한 저장소 이름이나 복사된 README만으로는 공식 배포 파일인지 확인할 수 없습니다.

<div align="center">

<br />

<img src="../assets/rea-hopper-analysis.png" alt="REA가 Hopper 안에서 분석 브리지를 실행해 네이티브 바이너리를 검사하는 모습" width="1200" />

<br /><br />

<table aria-label="REA 커뮤니티">
<tr>
<td align="center" width="360">
  <a href="https://discord.gg/GkcryMnJDM">
    <img src="../assets/discord.svg" height="42" alt="Discord" /><br />
    <strong>리버스 엔지니어링 커뮤니티에 참여하세요</strong>
  </a><br />
  <sub>Discord · 질문과 답변 · 결과 공유</sub>
</td>
</tr>
</table>

<br />

</div>

---

앱에서 내 제품에도 넣고 싶은 기능을 발견했나요? 에이전트에게 REA로 조사해 달라고 요청하세요. 소스 코드가 없어도 앱을 검사하고, 기능의 작동 원리를 설명하고, 근거를 보여 주고, 프로젝트에 맞는 기능을 구현할 수 있습니다.

REA는 에이전트를 분석 도구에 연결해 네이티브 바이너리, JavaScript와 Electron 앱, .NET 어셈블리, 웹사이트를 검사할 수 있게 합니다. 터미널에서도 같은 도구를 사용할 수 있습니다. 분석은 로컬에서 실행되며, 결과에는 각 결론의 근거와 한계가 포함됩니다.

설정 과정은 에이전트에 REA를 등록하고 해당 버전에 맞는 워크플로 지침을 설치합니다. 네이티브 분석에는 기존 Hopper, Ghidra, IDA 또는 Kuna 설치를 사용할 수 있습니다. 승인하면 설정 과정에서 Hopper를 설치할 수도 있습니다. 정적 JavaScript 분석에는 네이티브 분석 엔진이 필요하지 않습니다.

## 빠른 시작

**[빠른 시작 · rea.tools](https://rea.tools/ko/get-started/)**

### 에이전트 설정 (MCP)

[Node.js와 npm](../reference/supported-targets.md)을 설치한 다음 분석 대상 프로젝트 외부의 신뢰할 수 있는 디렉터리에서 다음 명령을 실행하세요.

```bash
npx rea-agents setup
```

에이전트를 선택하고, 예정된 변경 사항을 검토한 뒤 승인하세요. 설정 과정은 기존 설정을 백업하고 REA의 MCP 서버와 버전에 맞는 워크플로 지침을 추가합니다. 완료 후 에이전트를 다시 시작하세요.

[설치 및 설정](../getting-started/installation.md)

에이전트에게 요청:

```text
Notes 앱의 검색 기능이 어떻게 작동하는지 조사하고, 근거를 보여 준 다음, 내 프로젝트에 비슷한 기능을 구현해 줘.
```

Notes를 대상 앱으로 바꾸고 이해하고 싶은 기능을 지정하세요.

### 터미널 사용 (CLI)

압축을 푼 JavaScript/Electron 앱 디렉터리 또는 ASAR를 검사합니다.

```bash
npx -y rea-agents@latest analyze-javascript-application /absolute/path/to/app --json
```

결과에는 모듈, 임포트, Electron 경계와 관련 근거가 포함됩니다. 경로를 분석할 대상으로 바꾸세요. Windows에서는 `"D:/apps/example"` 같은 경로를 사용할 수 있습니다.

자주 사용할 경우 `rea` 명령을 설치하세요.

```bash
npm install --global rea-agents
rea --help
```

네이티브 분석에는 먼저 제공자를 설정해야 합니다. 네이티브 명령, 제공자 선택, 스냅샷, 스크립트 사용은 [CLI 및 Evidence 가이드](../getting-started/cli.md)를 참고하세요.

[Linux 요구 사항](../getting-started/installation.md#linux-owned-process-prerequisite)

### REA 업데이트

`npm install --global` 또는 `bun add --global`로 설치한 CLI에서는 다음 명령을 사용합니다.

```bash
rea update
```

`npx`를 사용한다면 다음 명령으로 에이전트 설정을 갱신하세요.

```bash
npx rea-agents@latest setup
```

[업데이트 및 제거](../getting-started/installation.md#diagnose-update-and-remove)

## 사례

<a href="https://rea.tools/ko/showcase/">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../assets/rea-showcases-dark.svg" />
    <img alt="DX-Ball 사운드 패닝, Notion 클립보드 브리지, TH04 탄환 고리 사례를 보여 주는 그림" src="../assets/rea-showcases.svg" />
  </picture>
</a>

<table>
<tbody>
<tr><td>
<h3>DX-Ball: 사운드 패닝 계산 재구현</h3>
<p>사운드 호출에서 위치를 패닝 값으로 변환하는 보조 함수까지 추적하고, 명령을 검사하여 불완전한 의사 코드를 C로 옮깁니다. 재구현한 코드는 원본 x86에 대한 3,205개 테스트 케이스를 통과했으며, 컴파일된 함수의 63바이트 전체를 재현합니다.</p>
<p><a href="https://rea.tools/ko/showcase/dx-ball/">사례 읽기</a> ·
<a href="https://github.com/N0zoM1z0/dx-ball">재구현 저장소</a></p>
</td></tr>
<tr><td>
<h3>Notion: Electron 클립보드 브리지 추적</h3>
<p>렌더러의 클립보드 API를 찾고, preload와 IPC를 거쳐 메인 프로세스까지 추적한 뒤, 서식 있는 클립보드 형식을 검사합니다.</p>
<p><a href="https://rea.tools/ko/showcase/notion/">사례 읽기</a></p>
</td></tr>
<tr><td>
<h3>TH04: DOS 원형 탄막 계산 복원</h3>
<p>원본 PC-98 게임의 16비트 명령을 검사하고 고정 각도와 조준 각도의 계산을 복원합니다. 재구현한 C++를 당시 컴파일러의 출력과 비교합니다.</p>
<p><a href="https://rea.tools/ko/showcase/th04/">사례 읽기</a> ·
<a href="https://github.com/N0zoM1z0/th04">재구현 저장소</a></p>
</td></tr>
</tbody>
</table>

REA로 흥미로운 대상을 분석했다면 알려 주세요. [issue](https://github.com/morluto/rea/issues) 또는 [pull request](https://github.com/morluto/rea/pulls)에 대상, 조사하려던 질문, REA가 어떻게 도움이 되었는지, 무엇을 알아냈는지를 담아 공유하세요.

## REA의 작동 방식

에이전트는 MCP를 통해 REA를 호출하여 대상을 검사하고 관련 코드를 추적합니다. REA는 조사 결과와 근거를 반환합니다. 에이전트는 이를 바탕으로 추가 질문을 하고, 동작을 설명하거나, 구현을 작성하고 테스트합니다. CLI 명령도 같은 워크플로를 사용합니다.

![REA 조사 흐름: 에이전트가 로컬 대상에 대해 질문하면 REA가 분석 도구로 대상을 검사하고 추적합니다. 에이전트는 반환된 코드, 참조, 확인되지 않은 사항을 이용해 설명하고 구현하고 테스트합니다.](../../website/public/assets/figures/rea-investigation-flow.svg)

[원본 크기의 그림 열기](../../website/public/assets/figures/rea-investigation-flow.svg).

<a id="current-status"></a>

## 분석할 수 있는 대상

네이티브 바이너리 · JavaScript / Electron · 웹사이트 · .NET 어셈블리 · Android APK · 펌웨어 · 프로세스 동작

[지원 형식 및 요구 사항](../reference/supported-targets.md)

<a id="choosing-a-deep-analysis-provider"></a>

[분석 도구 선택](../reference/supported-targets.md#choosing-a-deep-analysis-provider)

<a id="build-rl-environments"></a>

## RL 환경 만들기

녹화한 웹 세션이나 Linux 데스크톱 앱으로 로컬 환경을 만들어 에이전트가 작업을 연습하고 결과를 확인할 수 있습니다.

[RL 환경 만들기](https://rea.tools/guides/rl-environments/)

## 자주 묻는 질문

<details>
<summary><strong>어떤 에이전트에서 REA를 사용할 수 있나요?</strong></summary>

로컬 MCP 서버를 지원하는 에이전트라면 사용할 수 있습니다. 설정 과정은 [지원하는 에이전트](../getting-started/installation.md#supported-agents)를 구성합니다. 다른 클라이언트는 [수동 MCP 등록](../getting-started/installation.md#mcp-registry)을 이용할 수 있습니다.

</details>

<details>
<summary><strong>Hopper, Ghidra, IDA 또는 Kuna가 필요한가요?</strong></summary>

심층 네이티브 분석에는 이 중 하나를 사용합니다. 정적 JavaScript 및 .NET 검사에는 네이티브 분석 엔진이 필요하지 않습니다. 설정 과정에서 승인 후 Hopper를 설치할 수 있으며, Ghidra, IDA, Kuna는 기존 설치를 사용합니다. [제공자 설정](../getting-started/installation.md#hopper)을 참고하세요.

</details>

<details>
<summary><strong>Hopper를 먼저 실행해야 하나요?</strong></summary>

REA는 작업에 필요할 때 Hopper를 실행합니다. macOS에서는 처음 실행할 때 데모 모드를 선택하거나 라이선스를 활성화하라는 대화 상자가 나타날 수 있습니다. 첫 CLI/MCP 작업이나 무인 작업을 실행하기 전에 같은 사용자 세션에서 이 대화 상자를 완료하세요. 필요하면 Hopper를 직접 여세요. [Hopper 실행 및 문제 해결](../getting-started/installation.md#launcher-paths-and-troubleshooting)을 참고하세요.

</details>

<details>
<summary><strong>skills.sh에서 설치하는 스킬은 어떤 역할을 하나요?</strong></summary>

스킬은 에이전트에게 조사 지침을 제공합니다. `npx rea-agents setup`으로 REA의 MCP 서버를 등록하고 버전에 맞는 지침을 설치한 뒤 에이전트를 다시 시작하세요. [스킬만 설치하기](../getting-started/installation.md#skill-only-installation)를 참고하세요.

</details>

<details>
<summary><strong>REA는 어떤 코드를 반환하나요?</strong></summary>

네이티브 분석은 의사 코드와 어셈블리를 반환합니다. JavaScript/Electron 분석은 모듈과 그 관계를 복원합니다. 에이전트는 이 결과를 사용해 구현을 작성하고 테스트합니다. [사례](#사례)에서 구체적인 예를 볼 수 있습니다.

</details>

<details>
<summary><strong>REA가 내 앱을 업로드하나요?</strong></summary>

REA는 대상을 로컬에서 분석합니다. 에이전트는 도구 결과를 받으며, 에이전트의 모델 제공자에는 별도의 데이터 정책이 있습니다.

</details>

<details>
<summary><strong>버그가 발생하면 어떻게 해야 하나요?</strong></summary>

먼저 업데이트하세요. 최근 릴리스에서 이미 수정되었을 수 있습니다.

`npm install --global` 또는 `bun add --global`로 설치한 CLI에서는 다음 명령을 사용합니다.

```bash
rea update
```

`npx`로 에이전트를 설정했다면 다음 명령을 사용합니다.

```bash
npx rea-agents@latest setup
```

에이전트를 사용 중이라면 [설정 갱신](#rea-업데이트)을 완료하고 다시 시작하세요. 같은 작업을 다시 시도하세요. 문제가 계속되면 REA 버전, 대상 유형, 재현 단계, 오류 출력을 포함해 [issue를 등록](https://github.com/morluto/rea/issues)하세요.

</details>

## 문서

웹사이트의 [실습 가이드](https://rea.tools/ko/guides/)부터 읽어 보세요. 정확한 옵션, 사전 요구 사항, 결과 계약은 다음 문서를 참고하세요.

- [설치 및 설정](../getting-started/installation.md): 에이전트 등록, 제공자 설정, 업데이트, 제거.
- [준비 상태 확인 및 문제 해결](../getting-started/installation.md#check-readiness-for-your-task): 특정 에이전트 또는 분석 엔진 진단.
- [CLI 및 Evidence](../getting-started/cli.md): 명령, 제공자 선택, 스냅샷, 가져오기/내보내기, 종료 상태.
- [MCP 계약](../reference/mcp-contracts.md) 및 [에이전트 프롬프트](../getting-started/mcp-prompts.md): 도구 결과, 세션, 안내에 따른 조사.
- [도구 카탈로그](../reference/mcp-contracts.md#generated-catalog): 빌드 시 생성되는 도구, 제공자, CLI 명령 목록.

취약점은 [SECURITY.md](../../SECURITY.md)에 따라 보고하세요.

## 커뮤니티 및 지원

- **Discord** — 리버스 엔지니어링과 개발을 사랑하는 5만 명 이상의 회원과 함께 질문하고 조사 결과를 공유하세요! [![Discord](https://img.shields.io/badge/Join%20Discord-5865F2?style=flat-square&logo=discord&logoColor=white)](https://discord.gg/GkcryMnJDM)
- **Twitter / X** — 업데이트와 공지는 [@reatools](https://x.com/reatools) 에서 확인하세요.
- **의견 및 제안** — 필요한 기능이나 지원을 원하는 파일 형식이 있나요? [GitHub](https://github.com/morluto/rea/issues) 또는 [Discord](https://discord.gg/GkcryMnJDM) 에서 알려 주세요.

## 스타 기록

🎉 **GitHub 스타 400,000개, 감사합니다!**

REA를 사용하고, 버그를 보고하고, 기능을 요청하고, 빌드를 테스트하고, 수정에 기여해 주신 모든 분께 감사드립니다.

<a href="https://rea.tools/ko/contributors/">
  <img src="../../website/public/contributors/avatars.png" alt="REA 기여자" />
</a>

<a href="https://www.star-history.com/?repos=morluto%2Frea&amp;type=date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=morluto/rea&amp;type=date&amp;theme=dark&amp;legend=top-left" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=morluto/rea&amp;type=date" />
    <img alt="REA GitHub 스타 기록" src="https://api.star-history.com/chart?repos=morluto/rea&amp;type=date" />
  </picture>
</a>

## 기여

REA에 도움을 보태 주세요! [issue를 등록](https://github.com/morluto/rea/issues)해 버그나 기능을 제안하거나, [pull request를 보내](https://github.com/morluto/rea/pulls) 코드와 문서를 개선할 수 있습니다.

개발 환경과 검사 항목은 [CONTRIBUTING.md](../../CONTRIBUTING.md), 검증 절차는 [테스트 가이드](../development/testing.md)를 참고하세요.

한국어 번역도 개선할 수 있습니다. 이 README를 수정할 때는 [영문 README](../../README.md)의 명령어, 요구 사항, 분석 범위와 일치하는지 확인하세요. 웹사이트 번역은 `website/locales/ko/messages.po`의 `msgstr` 값을 수정하세요.

웹사이트 번역의 수정 방법, 검사 명령, 로컬 미리보기는 `website/locales/README.md`를 따르세요. 위 기여 문서의 **Translation corrections** 절에서 이 가이드로 이동할 수 있습니다. 명령어, 경로, 자리표시자, 기록된 근거는 그대로 보존하세요. `website/_site/`의 한국어 HTML은 자동 생성되므로 직접 수정하지 마세요.

## 면책 조항

책임 있는 사용에 관한 안내는 [DISCLAIMER.md](../../DISCLAIMER.md)를 참고하세요.

불법적이거나 허가되지 않은 사용에 대한 프로젝트의 입장은 모든 REA 버전, 배포 채널, 플랫폼에 적용되며, 각 사본에는 해당 라이선스가 그대로 유지됩니다.

REA는 법을 준수하는 연구, 교육, 상호운용성 확보, 소프트웨어 보존, 그리고 본인이 소유하거나 조사 권한을 가진 소프트웨어의 분석을 위한 도구입니다.

## 라이선스

[MIT](../../LICENSE)

REA가 작성한 코드는 MIT 라이선스를 따릅니다. 제3자 자료에는 각자의 라이선스와 저작권 고지가 그대로 유지됩니다. 의존성 목록, 보존된 라이선스 원문, 외부 도구 약관은 [제3자 고지](../../THIRD_PARTY_NOTICES.md)를 참고하세요.

IDA Pro / Hex-Rays 디컴파일러, Hopper, JEB 등 상용 도구는 해당 라이선스에 따라 **합법적으로 취득하고 사용 권한을 갖춰야 합니다.** REA는 어떤 도구의 라이선스, 키, 활성화 권한도 부여하지 않습니다. 체험판과 데모는 사용자, 기능, 자동화, 출력 공유 제한을 포함한 공급업체 약관을 따릅니다. 크랙 버전, 도난 키, 무단 키 공유, 라이선스 제한 우회는 허용되지 않습니다. 이 안내는 MIT 라이선스나 제3자 라이선스를 변경하지 않습니다.
