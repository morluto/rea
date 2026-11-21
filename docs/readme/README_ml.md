<div align="center">

[English](../../README.md) · [简体中文](README_zh.md) · [繁體中文](README_zh-TW.md) · [日本語](README_ja.md) · [한국어](README_ko.md) · [Türkçe](README_tr.md) · [Русский](README_ru.md) · [Tiếng Việt](README_vi.md) · [ไทย](README_th.md) · [Deutsch](README_de.md) · [Español](README_es.md) · [Français](README_fr.md) · [Українська](README_uk.md) · [Polski](README_pl.md) · [Português (Brasil)](README_pt-BR.md) · [العربية](README_ar.md) · [فارسی](README_fa.md) · [Bahasa Indonesia](README_id.md) · [Italiano](README_it.md)
· [Ελληνικά](README_el.md) · **മലയാളം** · [Roman Urdu](README_ur-Latn.md) · [Română](README_ro.md) · [Български](README_bg.md)

# REA: എന്തും Reverse Engineer ചെയ്യുക

### Binaries, applications, runtime behavior എന്നിവയുടെ Reverse Engineering-നായി ഒരൊറ്റ MCP.

**നിങ്ങൾക്ക് ഇഷ്ടപ്പെട്ട ഒരു feature കണ്ടോ? അത് എങ്ങനെ പ്രവർത്തിക്കുന്നു എന്ന് binary തലത്തിലേക്ക് വരെ മനസ്സിലാക്കൂ.**

[![GitHub stars](https://img.shields.io/github/stars/morluto/rea?style=flat-square&logo=github)](https://github.com/morluto/rea/stargazers)
[![Monthly npm downloads](https://img.shields.io/npm/dm/rea-agents?style=flat-square&label=npm%20downloads)](https://www.npmjs.com/package/rea-agents)
[![MIT license](https://img.shields.io/badge/license-MIT-f4c430?style=flat-square)](../../LICENSE)
[![Join the REA Discord](https://img.shields.io/badge/Discord-5865F2?style=flat-square&logo=discord&logoColor=white)](https://discord.gg/GkcryMnJDM)
[![Follow REA on X](https://img.shields.io/badge/X-000000?style=flat-square&logo=x&logoColor=white)](https://x.com/reatools)
[![Supported platforms: macOS, Windows, and Linux](https://img.shields.io/badge/macOS%20%7C%20Windows%20%7C%20Linux-4493F8?style=flat-square)](../getting-started/installation.md)
[![skills.sh](https://skills.sh/b/morluto/rea?style=flat-square)](https://skills.sh/morluto/rea/reverse-engineer-anything)

**[വെബ്സൈറ്റ്](https://rea.tools/) · [ഗൈഡുകൾ](https://rea.tools/guides/) · [ഉദാഹരണങ്ങൾ](https://rea.tools/showcase/)**

<a href="https://discord.com/invite/GkcryMnJDM"><img alt="Discord-ൽ REA കമ്മ്യൂണിറ്റിയിൽ ചേരുക" src="https://img.shields.io/badge/Join%20us%20on%20Discord-5865F2?style=for-the-badge&logo=discord&logoColor=white" height="40"></a>

[ദ്രുതാരംഭം](#ദ്രുതാരംഭം) · [ഉദാഹരണങ്ങൾ](#ഉദാഹരണങ്ങൾ) · [REA എങ്ങനെ പ്രവർത്തിക്കുന്നു](#rea-എങ്ങനെ-പ്രവർത്തിക്കുന്നു) · [എന്തൊക്കെ വിശകലനം ചെയ്യാം](#എന്തൊക്കെ-വിശകലനം-ചെയ്യാം) · [RL പരിതസ്ഥിതികൾ നിർമ്മിക്കുക](#build-rl-environments) · [പതിവുചോദ്യങ്ങൾ](#പതിവുചോദ്യങ്ങൾ) · [ഡോക്യുമെന്റേഷൻ](#ഡോക്യുമെന്റേഷൻ)

<code>npx rea-agents setup</code>

</div>

> [!IMPORTANT]
> REA ലഭ്യമാക്കേണ്ടത് [morluto/rea](https://github.com/morluto/rea),
> [rea.tools](https://rea.tools/), അല്ലെങ്കിൽ [rea-agents npm package](https://www.npmjs.com/package/rea-agents) എന്നിവയിൽ നിന്നാണ്.
> ഈ ഔദ്യോഗിക ഉറവിടങ്ങളിലെ ഇൻസ്റ്റലേഷൻ, റിലീസ് ലിങ്കുകൾ പിന്തുടരുക. സമാനമായ
> repository പേരോ പകർത്തിയ README-യോ മാത്രം ഒരു download ഔദ്യോഗികമാണെന്ന് ഉറപ്പാക്കുന്നില്ല.

<div align="center">

<br />

<img src="../assets/rea-hopper-analysis.png" alt="ഒരു native binary പരിശോധിക്കുന്നതിനിടെ Hopper-ൽ REA അതിന്റെ analysis bridge ആരംഭിക്കുന്നു" width="1200" />

<br /><br />

<table aria-label="REA community">
<tr>
<td align="center" width="360">
  <a href="https://discord.gg/GkcryMnJDM">
    <img src="../assets/discord.svg" height="42" alt="Discord" /><br />
    <strong>Reverse Engineering കമ്മ്യൂണിറ്റിയിൽ ചേരുക</strong>
  </a><br />
  <sub>Discord · ചോദ്യോത്തരങ്ങൾ · അനുഭവങ്ങളും കണ്ടെത്തലുകളും പങ്കിടുക</sub>
</td>
</tr>
</table>

<br />

</div>

---

നിങ്ങളുടെ സ്വന്തം product-ൽ ഉൾപ്പെടുത്താൻ ആഗ്രഹിക്കുന്ന ഒരു feature ഏതെങ്കിലും app-ൽ കണ്ടോ? REA ഉപയോഗിച്ച് അത് പരിശോധിക്കാൻ നിങ്ങളുടെ agent-നോട് ആവശ്യപ്പെടുക. source code ഇല്ലാതെയും അതിന് app പരിശോധിക്കാനും feature എങ്ങനെ പ്രവർത്തിക്കുന്നുവെന്ന് വിശദീകരിക്കാനും അതിനുള്ള തെളിവുകൾ കാണിക്കാനും നിങ്ങളുടെ project-നായി അതിന് സമാനമായൊരു പതിപ്പ് നിർമ്മിക്കാനും കഴിയും.

Native binaries, JavaScript, Electron apps, .NET assemblies, websites എന്നിവ പരിശോധിക്കുന്നതിനുള്ള tools-ലേക്ക് REA നിങ്ങളുടെ agent-നെ ബന്ധിപ്പിക്കുന്നു. ഇതേ tools നിങ്ങളുടെ terminal-ൽ നിന്നും ഉപയോഗിക്കാം. വിശകലനം local ആയി നടക്കുന്നു; ഓരോ നിഗമനത്തിനും പിന്നിലെ തെളിവുകളും പരിമിതികളും ഫലങ്ങളിൽ ഉൾപ്പെടുന്നു.

Setup നിങ്ങളുടെ agent-ിൽ REA രജിസ്റ്റർ ചെയ്യുകയും അനുയോജ്യമായ workflow നിർദ്ദേശങ്ങൾ ഇൻസ്റ്റാൾ ചെയ്യുകയും ചെയ്യുന്നു. Native analysis-നായി നിലവിലുള്ള Hopper, Ghidra, IDA, അല്ലെങ്കിൽ Kuna installation ഉപയോഗിക്കാം; അനുമതി നൽകിയാൽ setup-ന് Hopper ഇൻസ്റ്റാൾ ചെയ്യാനും കഴിയും. Static JavaScript analysis-ന് native analysis engine ആവശ്യമില്ല.

## ദ്രുതാരംഭം

**[ദ്രുതാരംഭം · rea.tools](https://rea.tools/ml/get-started/)**

### നിങ്ങളുടെ agent സജ്ജമാക്കുക (MCP)

[Node.js, npm](../reference/supported-targets.md) എന്നിവ ഇൻസ്റ്റാൾ ചെയ്ത ശേഷം പരിശോധിക്കേണ്ട പ്രോജക്റ്റിന് പുറത്തുള്ള വിശ്വസനീയമായ ഡയറക്ടറിയിൽ നിന്ന് ഈ കമാൻഡ് പ്രവർത്തിപ്പിക്കുക.

```bash
npx rea-agents setup
```

നിങ്ങൾ ഉപയോഗിക്കുന്ന agents തിരഞ്ഞെടുക്കുക, നിർദ്ദേശിച്ച മാറ്റങ്ങൾ പരിശോധിക്കുക, തുടർന്ന് അവയ്ക്ക് അനുമതി നൽകുക. നിലവിലുള്ള configuration-ന്റെ backup-ുകൾ സൂക്ഷിച്ചുകൊണ്ട് setup, REA-യുടെ MCP server-ഉം അനുയോജ്യമായ workflow നിർദ്ദേശങ്ങളും ചേർക്കും. അതിനുശേഷം നിങ്ങളുടെ agent വീണ്ടും ആരംഭിക്കുക.

[installation and setup](../getting-started/installation.md)

നിങ്ങളുടെ agent-നോട് ആവശ്യപ്പെടുക:

```text
Notes app-ൽ search എങ്ങനെ പ്രവർത്തിക്കുന്നു എന്ന് മനസ്സിലാക്കി, അതിനുള്ള തെളിവുകൾ കാണിച്ചുതരികയും എന്റെ project-നായി സമാനമായൊരു feature നിർമ്മിക്കുകയും ചെയ്യുക.
```

`Notes` എന്നതിന് പകരം നിങ്ങൾ പരിശോധിക്കാൻ ആഗ്രഹിക്കുന്ന app-ിന്റെയും മനസ്സിലാക്കേണ്ട feature-ിന്റെയും പേരുകൾ നൽകുക.

### Terminal ഉപയോഗിക്കുക (CLI)

Extract ചെയ്ത JavaScript/Electron app directory അല്ലെങ്കിൽ ASAR പരിശോധിക്കുക:

```bash
npx -y rea-agents@latest analyze-javascript-application /absolute/path/to/app --json
```

ഫലത്തിൽ modules, imports, Electron boundaries, അവയ്ക്കുള്ള തെളിവുകൾ എന്നിവ ഉൾപ്പെടും. `/absolute/path/to/app` എന്നതിന് പകരം നിങ്ങളുടെ target-ന്റെ path നൽകുക; Windows-ൽ ഉദാഹരണത്തിന് `"D:/apps/example"` ഉപയോഗിക്കാം.

സാധാരണ ഉപയോഗത്തിനായി `rea` command ഇൻസ്റ്റാൾ ചെയ്യാൻ:

```bash
npm install --global rea-agents
rea --help
```

Native analysis നടത്തുന്നതിന് മുമ്പ് ഒരു provider ക്രമീകരിക്കുക. Native commands, provider തിരഞ്ഞെടുക്കൽ, snapshots, scripting എന്നിവയ്ക്കായി [CLI and Evidence guide](../getting-started/cli.md) കാണുക.

[Linux ആവശ്യകതകൾ](../getting-started/installation.md#linux-owned-process-prerequisite)

### REA അപ്‌ഡേറ്റ് ചെയ്യുക

`npm install --global` അല്ലെങ്കിൽ `bun add --global` ഉപയോഗിച്ച് ഇൻസ്റ്റാൾ ചെയ്ത CLI-ക്കായി:

```bash
rea update
```

`npx` ഉപയോഗിക്കുന്നുവെങ്കിൽ, agent setup പുതുക്കാൻ:

```bash
npx rea-agents@latest setup
```

[അപ്‌ഡേറ്റും അൺഇൻസ്റ്റാളും](../getting-started/installation.md#diagnose-update-and-remove)

## ഉദാഹരണങ്ങൾ

<a href="https://rea.tools/showcase/">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../assets/rea-showcases-dark.svg" />
    <img alt="DX-Ball sound-pan, Notion clipboard-bridge, TH04 bullet-ring എന്നിവയുടെ ചിത്രീകരണങ്ങൾ" src="../assets/rea-showcases.svg" />
  </picture>
</a>

<table>
<tbody>
<tr><td>
<h3>DX-Ball: sound-pan കണക്കുകൂട്ടൽ പുനർനിർമ്മിക്കുക</h3>
<p>ഒരു sound call-നെ അതിന്റെ position-to-pan helper വരെ പിന്തുടരുക, instructions പരിശോധിക്കുക, അപൂർണ്ണമായ pseudocode-നെ C-യാക്കി മാറ്റുക. ഈ പുനർനിർമ്മാണം യഥാർത്ഥ x86-ലെ 3,205 test cases വിജയിക്കുകയും compile ചെയ്ത function-ന്റെ 63 bytes-ഉം അതേപടി പുനരുത്പാദിപ്പിക്കുകയും ചെയ്യുന്നു.</p>
<p><a href="https://rea.tools/showcase/dx-ball/">Case study വായിക്കുക</a> ·
<a href="https://github.com/N0zoM1z0/dx-ball">പുനർനിർമ്മാണ repository</a></p>
</td></tr>
<tr><td>
<h3>Notion: Electron clipboard bridge പിന്തുടരുക</h3>
<p>Renderer-ന്റെ clipboard API കണ്ടെത്തി, അതിനെ preload-ഉം IPC-ഉം വഴി main process വരെ പിന്തുടർന്ന് rich clipboard format പരിശോധിക്കുക.</p>
<p><a href="https://rea.tools/showcase/notion/">Case study വായിക്കുക</a></p>
</td></tr>
<tr><td>
<h3>TH04: DOS bullet-ring കണക്കുകൂട്ടൽ വീണ്ടെടുക്കുക</h3>
<p>യഥാർത്ഥ PC-98 game-ന്റെ 16-bit instructions പരിശോധിക്കുക, fixed, aimed angle കണക്കുകൂട്ടലുകൾ വീണ്ടെടുക്കുക, പുനർനിർമ്മിച്ച C++-നെ ചരിത്രപരമായ compiler output-ുമായി താരതമ്യം ചെയ്യുക.</p>
<p><a href="https://rea.tools/showcase/th04/">Case study വായിക്കുക</a> ·
<a href="https://github.com/N0zoM1z0/th04">പുനർനിർമ്മാണ repository</a></p>
</td></tr>
</tbody>
</table>

REA ഉപയോഗിച്ച് നിങ്ങൾ രസകരമായ എന്തെങ്കിലും പരിശോധിച്ചിട്ടുണ്ടെങ്കിൽ അത് കാണാൻ ഞങ്ങൾ ആഗ്രഹിക്കുന്നു. പരിശോധിച്ച target, നിങ്ങളുടെ ചോദ്യം, REA എങ്ങനെ സഹായിച്ചു, നിങ്ങൾ കണ്ടെത്തിയത് എന്നിവ ഉൾപ്പെടുത്തി [issue](https://github.com/morluto/rea/issues) അല്ലെങ്കിൽ [pull request](https://github.com/morluto/rea/pulls) വഴി നിങ്ങളുടെ case പങ്കിടുക.

## REA എങ്ങനെ പ്രവർത്തിക്കുന്നു

Target പരിശോധിക്കാനും പ്രസക്തമായ code-ന്റെ പാത പിന്തുടരാനും നിങ്ങളുടെ agent MCP വഴി REA-യെ വിളിക്കുന്നു. REA കണ്ടെത്തലുകളും അവയ്ക്കുള്ള തെളിവുകളും തിരികെ നൽകുന്നു. തുടർന്ന് agent കൂടുതൽ ചോദ്യങ്ങൾ ചോദിക്കാനും പെരുമാറ്റം വിശദീകരിക്കാനും implementation എഴുതുകയും പരിശോധിക്കുകയും ചെയ്യാനും അവ ഉപയോഗിക്കുന്നു. CLI commands-ഉം ഇതേ workflows ഉപയോഗിക്കുന്നു.

![REA അന്വേഷണ പ്രവാഹം: നിങ്ങളുടെ agent ഒരു local target-നെക്കുറിച്ച് ചോദിക്കുന്നു; REA analysis tools ഉപയോഗിച്ച് അത് പരിശോധിക്കുകയും code-ന്റെ പാത പിന്തുടരുകയും ചെയ്യുന്നു; തിരികെ ലഭിക്കുന്ന code, references, അറിയാത്ത കാര്യങ്ങൾ എന്നിവ ഉപയോഗിച്ച് agent വിശദീകരിക്കുകയും implementation നടത്തുകയും പരിശോധിക്കുകയും ചെയ്യുന്നു.](../../website/public/assets/figures/rea-investigation-flow.svg)

[പൂർണ്ണ വലുപ്പത്തിലുള്ള ചിത്രം തുറക്കുക](../../website/public/assets/figures/rea-investigation-flow.svg).

<a id="current-status"></a>

## എന്തൊക്കെ വിശകലനം ചെയ്യാം

Native binaries · JavaScript / Electron · Websites · .NET assemblies · Android APKs · Firmware · Process behavior

[പിന്തുണയ്ക്കുന്ന ഫോർമാറ്റുകളും ആവശ്യകതകളും](../reference/supported-targets.md)

<a id="choosing-a-deep-analysis-provider"></a>

[വിശകലന ഉപകരണം തിരഞ്ഞെടുക്കൽ](../reference/supported-targets.md#choosing-a-deep-analysis-provider)

<a id="build-rl-environments"></a>

## RL പരിതസ്ഥിതികൾ നിർമ്മിക്കുക

റെക്കോർഡ് ചെയ്ത വെബ് സെഷനിൽ നിന്നോ Linux ഡെസ്‌ക്‌ടോപ്പ് ആപ്പിൽ നിന്നോ ഒരു ലോക്കൽ പരിസ്ഥിതി സൃഷ്ടിച്ച് ഏജന്റിന് ഒരു ജോലി പരിശീലിക്കാനും ഫലം പരിശോധിക്കാനും കഴിയും.

[RL പരിതസ്ഥിതികൾ നിർമ്മിക്കുക](https://rea.tools/guides/rl-environments/)

## പതിവുചോദ്യങ്ങൾ

<details>
<summary><strong>ഏതൊക്കെ agents-ന് REA ഉപയോഗിക്കാം?</strong></summary>

Local MCP servers പിന്തുണയ്ക്കുന്ന ഏത് agent-നും REA ഉപയോഗിക്കാം. Setup, [പിന്തുണയ്ക്കുന്ന agents](../getting-started/installation.md#supported-agents) ക്രമീകരിക്കുന്നു; മറ്റ് clients-ന് [manual MCP registration](../getting-started/installation.md#mcp-registry) ഉപയോഗിക്കാം.

</details>

<details>
<summary><strong>Hopper, Ghidra, IDA അല്ലെങ്കിൽ Kuna ആവശ്യമാണോ?</strong></summary>

ആഴത്തിലുള്ള native analysis-ന് ഇവയിൽ ഒന്ന് ആവശ്യമാണ്. Static JavaScript, .NET പരിശോധനകൾ native analysis engine ഇല്ലാതെയും പ്രവർത്തിക്കും. അനുമതി ലഭിച്ചാൽ setup-ന് Hopper ഇൻസ്റ്റാൾ ചെയ്യാം; Ghidra, IDA, Kuna എന്നിവയ്ക്കായി നിങ്ങളുടെ നിലവിലുള്ള installations ഉപയോഗിക്കുന്നു. [Provider setup](../getting-started/installation.md#hopper) കാണുക.

</details>

<details>
<summary><strong>Hopper ആദ്യം ആരംഭിക്കേണ്ടതുണ്ടോ?</strong></summary>

ഒരു operation-ന് ആവശ്യമാകുമ്പോൾ REA Hopper ആരംഭിക്കും. macOS-ൽ ആദ്യമായി പ്രവർത്തിപ്പിക്കുമ്പോൾ demo mode തിരഞ്ഞെടുക്കാനോ license activate ചെയ്യാനോ ആവശ്യപ്പെടുന്ന dialog പ്രത്യക്ഷപ്പെടാം. ആദ്യ CLI/MCP operation അല്ലെങ്കിൽ unattended job നടത്തുന്നതിന് മുമ്പ് അതേ user session-ൽ ആ prompt പൂർത്തിയാക്കുക. ആവശ്യമെങ്കിൽ Hopper സ്വമേധയാ തുറക്കുക. [Hopper startup and troubleshooting](../getting-started/installation.md#launcher-paths-and-troubleshooting) കാണുക.

</details>

<details>
<summary><strong>skills.sh-ൽ നിന്ന് skill ഇൻസ്റ്റാൾ ചെയ്യുന്നത് എന്താണ് ചെയ്യുന്നത്?</strong></summary>

ഈ skill നിങ്ങളുടെ agent-ന് അന്വേഷണ നിർദ്ദേശങ്ങൾ നൽകുന്നു. REA-യുടെ MCP server രജിസ്റ്റർ ചെയ്യാനും അനുയോജ്യമായ നിർദ്ദേശങ്ങൾ ഇൻസ്റ്റാൾ ചെയ്യാനും `npx rea-agents setup` ഉപയോഗിക്കുക; തുടർന്ന് നിങ്ങളുടെ agent വീണ്ടും ആരംഭിക്കുക. [Skill-only installation](../getting-started/installation.md#skill-only-installation) കാണുക.

</details>

<details>
<summary><strong>REA ഏത് തരത്തിലുള്ള code ആണ് നൽകുന്നത്?</strong></summary>

Native analysis pseudocode-ഉം assembly-ഉം നൽകുന്നു. JavaScript/Electron analysis modules-ഉം അവയുടെ ബന്ധങ്ങളും വീണ്ടെടുക്കുന്നു. ഈ കണ്ടെത്തലുകൾ ഉപയോഗിച്ച് നിങ്ങളുടെ agent implementation എഴുതുകയും പരിശോധിക്കുകയും ചെയ്യും; പ്രായോഗിക ഉദാഹരണങ്ങൾക്കായി [ഉദാഹരണങ്ങൾ](#ഉദാഹരണങ്ങൾ) കാണുക.

</details>

<details>
<summary><strong>REA എന്റെ app upload ചെയ്യുമോ?</strong></summary>

REA targets local ആയി വിശകലനം ചെയ്യുന്നു. Tool-ൽ നിന്നുള്ള ഫലങ്ങൾ നിങ്ങളുടെ agent-ന് ലഭിക്കും; അതിന്റെ model provider-ന് സ്വന്തമായ data policy ഉണ്ടായിരിക്കും.

</details>

<details>
<summary><strong>ഒരു bug നേരിട്ടാൽ എന്തുചെയ്യണം?</strong></summary>

ആദ്യം അപ്‌ഡേറ്റ് ചെയ്യുക; പുതിയ release-ൽ ആ പ്രശ്നത്തിനുള്ള പരിഹാരം ഇതിനകം ഉണ്ടായേക്കാം.

`npm install --global` അല്ലെങ്കിൽ `bun add --global` ഉപയോഗിച്ച് ഇൻസ്റ്റാൾ ചെയ്ത CLI-ക്കായി:

```bash
rea update
```

`npx` വഴി agent setup നടത്തുന്നതിനായി:

```bash
npx rea-agents@latest setup
```

നിങ്ങൾ agent ഉപയോഗിക്കുന്നുണ്ടെങ്കിൽ, [setup പുതുക്കൽ](#rea-അപ്‌ഡേറ്റ്-ചെയ്യുക) പൂർത്തിയാക്കി അത് വീണ്ടും ആരംഭിക്കുക. അതേ task വീണ്ടും ശ്രമിക്കുക. പ്രശ്നം തുടരുകയാണെങ്കിൽ, നിങ്ങളുടെ REA version, target type, പ്രശ്നം ആവർത്തിക്കാൻ ആവശ്യമായ ഘട്ടങ്ങൾ, error output എന്നിവ ഉൾപ്പെടുത്തി [issue തുറക്കുക](https://github.com/morluto/rea/issues).

</details>

## ഡോക്യുമെന്റേഷൻ

വെബ്സൈറ്റിലെ [പ്രായോഗിക ഗൈഡുകൾ](https://rea.tools/guides/) ഉപയോഗിച്ച് തുടങ്ങുക.
കൃത്യമായ options, prerequisites, result contracts എന്നിവയ്ക്കായി:

- [Installation and setup](../getting-started/installation.md): agent registration, provider configuration, updates, uninstall.
- [Readiness and troubleshooting](../getting-started/installation.md#check-readiness-for-your-task): ഒരു agent-ന്റെയോ analysis engine-ന്റെയോ പ്രശ്നങ്ങൾ കണ്ടെത്തുക.
- [CLI and Evidence](../getting-started/cli.md): commands, provider തിരഞ്ഞെടുക്കൽ, snapshots, import/export, exit statuses.
- [MCP contracts](../reference/mcp-contracts.md), [agent prompts](../getting-started/mcp-prompts.md): tool results, sessions, guided investigations.
- [Tool catalog](../reference/mcp-contracts.md#generated-catalog): tools, providers, CLI commands എന്നിവയുടെ സ്വയമേവ സൃഷ്ടിച്ച പട്ടിക.

സുരക്ഷാ ദുർബലതകൾ [SECURITY.md](../../SECURITY.md) വഴി റിപ്പോർട്ട് ചെയ്യുക.

## കമ്മ്യൂണിറ്റിയും സഹായവും

- **Discord** — റിവേഴ്‌സ് എൻജിനീയറിങ്ങിനെയും പുതിയ പ്രോജക്റ്റുകൾ നിർമ്മിക്കുന്നതിനെയും സ്നേഹിക്കുന്ന 50,000-ത്തിലധികം പേരുള്ള നമ്മുടെ കൂട്ടായ്മയിൽ ചോദ്യങ്ങൾ ചോദിക്കൂ, കണ്ടെത്തലുകൾ പങ്കിടൂ! [![Discord](https://img.shields.io/badge/Join%20Discord-5865F2?style=flat-square&logo=discord&logoColor=white)](https://discord.gg/GkcryMnJDM)
- **Twitter / X** — വാർത്തകൾക്കും അറിയിപ്പുകൾക്കുമായി [@reatools](https://x.com/reatools) പിന്തുടരൂ.
- **അഭിപ്രായങ്ങളും നിർദേശങ്ങളും** — ഒരു പുതിയ സൗകര്യമോ ഫയൽ ഫോർമാറ്റിനുള്ള പിന്തുണയോ വേണോ? [GitHub](https://github.com/morluto/rea/issues) അല്ലെങ്കിൽ [Discord](https://discord.gg/GkcryMnJDM) വഴി ഞങ്ങളെ അറിയിക്കൂ.

## Star ചരിത്രം

🎉 **400,000 GitHub stars — നന്ദി!**

REA ഉപയോഗിക്കുന്നവർക്കും, bugs റിപ്പോർട്ട് ചെയ്യുന്നവർക്കും, features ആവശ്യപ്പെടുന്നവർക്കും, builds പരിശോധിക്കുന്നവർക്കും, fixes സംഭാവന ചെയ്യുന്നവർക്കും നന്ദി.

<a href="https://www.star-history.com/?repos=morluto%2Frea&amp;type=date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=morluto/rea&amp;type=date&amp;theme=dark&amp;legend=top-left" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=morluto/rea&amp;type=date" />
    <img alt="REA GitHub star ചരിത്രം" src="https://api.star-history.com/chart?repos=morluto/rea&amp;type=date" />
  </picture>
</a>

## സംഭാവനകൾ

REA-യ്ക്കായി നിങ്ങളുടെ സഹായം ഞങ്ങൾ സ്വാഗതം ചെയ്യുന്നു! bug റിപ്പോർട്ട് ചെയ്യാനോ feature നിർദ്ദേശിക്കാനോ [issue തുറക്കുക](https://github.com/morluto/rea/issues), code അല്ലെങ്കിൽ docs മെച്ചപ്പെടുത്താൻ [pull request അയയ്ക്കുക](https://github.com/morluto/rea/pulls).

Development setup-നും checks-നും [CONTRIBUTING.md](../../CONTRIBUTING.md), verification lanes-നായി [testing](../development/testing.md) എന്നിവ കാണുക.

## നിരാകരണം

ഉത്തരവാദിത്തത്തോടെ ഉപയോഗിക്കുന്നതിനുള്ള മാർഗനിർദ്ദേശങ്ങൾക്ക് [DISCLAIMER.md](../../DISCLAIMER.md) കാണുക.

നിയമവിരുദ്ധമോ അനുമതിയില്ലാത്തതോ ആയ ഉപയോഗത്തെക്കുറിച്ചുള്ള project-ന്റെ നിലപാട് എല്ലാ REA versions-നും distribution channels-നും platforms-നും ബാധകമാണ്; ഓരോ copy-യും അതിന് ബാധകമായ licenses നിലനിർത്തുന്നു.

നിയമാനുസൃതമായ research, education, interoperability, software preservation, കൂടാതെ നിങ്ങൾക്ക് സ്വന്തമായതോ പരിശോധിക്കാൻ അനുമതിയുള്ളതോ ആയ software-ന്റെ analysis എന്നിവയ്ക്കാണ് REA ഉദ്ദേശിച്ചിരിക്കുന്നത്.

## ലൈസൻസ്

[MIT](../../LICENSE)

REA-യുടെ രചയിതാക്കൾ സൃഷ്ടിച്ച code MIT license പ്രകാരമാണ് ലൈസൻസ് ചെയ്തിരിക്കുന്നത്. Third-party material അതിന്റെ സ്വന്തം licenses-ഉം copyright notices-ഉം നിലനിർത്തുന്നു; dependencies-ന്റെ പട്ടിക, നിലനിർത്തിയ license text-ുകൾ, external tool നിബന്ധനകൾ എന്നിവയ്ക്കായി [Third-party notices](../../THIRD_PARTY_NOTICES.md) കാണുക.

**IDA Pro / Hex-Rays decompilers, Hopper, JEB എന്നിവ ഉൾപ്പെടെയുള്ള commercial tools നിയമാനുസൃതമായി സ്വന്തമാക്കുകയും അവയുടെ ബാധകമായ licenses പ്രകാരം ഉപയോഗിക്കാൻ അനുമതിയുണ്ടെന്ന് ഉറപ്പാക്കുകയും വേണം.** REA ഒരു tool license-ഓ key-യോ activation entitlement-ഓ നൽകുന്നില്ല. Trials-ഉം demos-ഉം ഉൾപ്പെടെ vendor നിബന്ധനകൾക്ക് വിധേയമാണ്; ഇതിൽ user, feature, automation, output sharing നിയന്ത്രണങ്ങളും ഉൾപ്പെടാം. Cracked copies, മോഷ്ടിച്ച keys, അനുമതിയില്ലാത്ത key sharing, license നിയന്ത്രണങ്ങൾ മറികടക്കൽ എന്നിവയ്ക്ക് അനുമതിയില്ല. ഈ മാർഗനിർദ്ദേശം MIT അല്ലെങ്കിൽ third-party licenses-ൽ മാറ്റം വരുത്തുന്നില്ല.
