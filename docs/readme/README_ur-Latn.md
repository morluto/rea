<div align="center">

[English](../../README.md) · [简体中文](README_zh.md) · [繁體中文](README_zh-TW.md) · [日本語](README_ja.md) · [한국어](README_ko.md) · [Türkçe](README_tr.md) · [Русский](README_ru.md) · [Tiếng Việt](README_vi.md) · [ไทย](README_th.md) · [Deutsch](README_de.md) · [Español](README_es.md) · [Français](README_fr.md) · [Українська](README_uk.md) · [Polski](README_pl.md) · [Português (Brasil)](README_pt-BR.md) · [العربية](README_ar.md) · [فارسی](README_fa.md) · [Bahasa Indonesia](README_id.md) · [Italiano](README_it.md)
· [Ελληνικά](README_el.md) · [മലയാളം](README_ml.md) · **Roman Urdu** · [Română](README_ro.md) · [Български](README_bg.md)

# REA: Reverse Engineer Anything

### Binaries, applications aur runtime behavior ki reverse engineering ke liye ek MCP.

**Koi feature pasand aaya? Samjhein ke woh kaise kaam karta hai, binary level tak.**

[![GitHub stars](https://img.shields.io/github/stars/morluto/rea?style=flat-square&logo=github)](https://github.com/morluto/rea/stargazers)
[![Monthly npm downloads](https://img.shields.io/npm/dm/rea-agents?style=flat-square&label=npm%20downloads)](https://www.npmjs.com/package/rea-agents)
[![MIT license](https://img.shields.io/badge/license-MIT-f4c430?style=flat-square)](../../LICENSE)
[![Join the REA Discord](https://img.shields.io/badge/Discord-5865F2?style=flat-square&logo=discord&logoColor=white)](https://discord.gg/GkcryMnJDM)
[![Follow REA on X](https://img.shields.io/badge/X-000000?style=flat-square&logo=x&logoColor=white)](https://x.com/reatools)
[![Supported platforms: macOS, Windows, and Linux](https://img.shields.io/badge/macOS%20%7C%20Windows%20%7C%20Linux-4493F8?style=flat-square)](../getting-started/installation.md)
[![skills.sh](https://skills.sh/b/morluto/rea?style=flat-square)](https://skills.sh/morluto/rea/reverse-engineer-anything)

**[Website](https://rea.tools/) · [Guides](https://rea.tools/guides/) · [Showcases](https://rea.tools/showcase/)**

<a href="https://discord.com/invite/GkcryMnJDM"><img alt="Discord par REA community mein shamil hon" src="https://img.shields.io/badge/Join%20us%20on%20Discord-5865F2?style=for-the-badge&logo=discord&logoColor=white" height="40"></a>

[Jaldi shuru karein](#jaldi-shuru-karein) · [Amli misaalein](#amli-misaalein) · [REA kaise kaam karta hai](#rea-kaise-kaam-karta-hai) · [Kya kuch analyze kar sakte hain](#kya-kuch-analyze-kar-sakte-hain) · [RL environments banayein](#build-rl-environments) · [FAQ](#faq) · [Documentation](#documentation)

<code>npx rea-agents setup</code>

</div>

> [!IMPORTANT]
> REA [morluto/rea](https://github.com/morluto/rea),
> [rea.tools](https://rea.tools/) ya [rea-agents npm package](https://www.npmjs.com/package/rea-agents) se hasil karein.
> Installation aur release ke links inhi official sources se kholein. Sirf milta-julta
> repository naam ya copy kiya hua README kisi download ko official sabit nahi karta.

<div align="center">

<br />

<img src="../assets/rea-hopper-analysis.png" alt="REA ek native binary inspect karte hue Hopper ke andar apna analysis bridge shuru kar raha hai" width="1200" />

<br /><br />

<table aria-label="REA community">
<tr>
<td align="center" width="360">
  <a href="https://discord.gg/GkcryMnJDM">
    <img src="../assets/discord.svg" height="42" alt="Discord" /><br />
    <strong>Reverse Engineering Community mein shamil hon</strong>
  </a><br />
  <sub>Discord · Sawal jawab · Apna kaam dikhayein</sub>
</td>
</tr>
</table>

<br />

</div>

---

Kisi app mein aisa feature dekha jo aap apne product mein chahte hain? Apne agent se kahein ke REA ke zariye uski jaanch kare. Woh app ka source code mile baghair bhi use inspect kar sakta hai, feature kaam kaise karta hai samjha sakta hai, saboot dikha sakta hai aur aapke project ke liye uska ek version bana sakta hai.

REA aapke agent ko native binaries, JavaScript aur Electron apps, .NET assemblies aur websites inspect karne wale tools se jorta hai. Yehi tools terminal se bhi use kar sakte hain. Analysis local machine par hota hai, aur har natije ke saath uske saboot aur limitations bhi milti hain.

Setup REA ko aapke agent ke saath register karta hai aur uske mutabiq workflow instructions install karta hai. Native analysis ke liye pehle se installed Hopper, Ghidra, IDA ya Kuna use ho sakta hai; aapki approval par setup Hopper bhi install kar sakta hai. Static JavaScript analysis ke liye native analysis engine ki zaroorat nahi.

## Jaldi shuru karein

**[Jaldi shuru karein · rea.tools](https://rea.tools/ur-Latn/get-started/)**

### Apna agent setup karein (MCP)

[Node.js aur npm](../reference/supported-targets.md) install karne ke baad yeh command target project se bahar kisi bharosemand directory mein chalayein.

```bash
npx rea-agents setup
```

Apne agents select karein, proposed changes dekhein aur approve karein. Setup
REA ka MCP server aur matching workflow instructions add karta hai, aur existing
configuration ke backups banata hai. Iske baad apna agent restart karein.

[installation aur setup](../getting-started/installation.md)

Apne agent se kahein:

```text
Samjho ke Notes app mein search kaise kaam karti hai, mujhe saboot dikhao aur
mere project ke liye aisa hi feature banao.
```

Notes ki jagah apni target app aur jis feature ko samajhna hai uska naam likhein.

### Terminal se use karein (CLI)

Extract ki hui JavaScript/Electron app directory ya ASAR inspect karein:

```bash
npx -y rea-agents@latest analyze-javascript-application /absolute/path/to/app --json
```

Natije mein modules, imports, Electron boundaries aur unke saboot milte hain.
Path ko apne target se badlein, jaise Windows par `"D:/apps/example"`.

Rozmarra use ke liye `rea` command install karne ke liye:

```bash
npm install --global rea-agents
rea --help
```

Native analysis se pehle provider configure karein. Native commands, provider
selection, snapshots aur scripting ke liye
[CLI aur Evidence guide](../getting-started/cli.md) dekhein.

[Linux ki zaroori cheezein](../getting-started/installation.md#linux-owned-process-prerequisite)

### REA update karein

Agar CLI `npm install --global` ya `bun add --global` se install ki hai:

```bash
rea update
```

Agar aap `npx` use karte hain to agent setup is tarah update karein:

```bash
npx rea-agents@latest setup
```

[Update aur uninstall](../getting-started/installation.md#diagnose-update-and-remove)

## Amli misaalein

<a href="https://rea.tools/showcase/">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../assets/rea-showcases-dark.svg" />
    <img alt="DX-Ball sound-pan, Notion clipboard-bridge aur TH04 bullet-ring case studies ki tasveerein" src="../assets/rea-showcases.svg" />
  </picture>
</a>

<table>
<tbody>
<tr><td>
<h3>DX-Ball: sound-pan calculation dobara banayein</h3>
<p>Sound call se uske position-to-pan helper tak jayein, instructions inspect
karein aur adhoore pseudocode ko C mein badlein. Dobara banaya gaya code 3,205
original-x86 cases pass karta hai aur compiled function ke tamam 63 bytes
dobara hasil karta hai.</p>
<p><a href="https://rea.tools/showcase/dx-ball/">Case study parhein</a> ·
<a href="https://github.com/N0zoM1z0/dx-ball">Reconstruction repository</a></p>
</td></tr>
<tr><td>
<h3>Notion: Electron clipboard bridge trace karein</h3>
<p>Renderer ki clipboard API dhoondein, preload aur IPC ke raste main process tak
uska flow follow karein aur rich clipboard format inspect karein.</p>
<p><a href="https://rea.tools/showcase/notion/">Case study parhein</a></p>
</td></tr>
<tr><td>
<h3>TH04: DOS bullet-ring calculation recover karein</h3>
<p>Original PC-98 game ki 16-bit instructions inspect karein, fixed aur aimed angle
calculations recover karein aur dobara banaye gaye C++ ko purane compiler ke
output se compare karein.</p>
<p><a href="https://rea.tools/showcase/th04/">Case study parhein</a> ·
<a href="https://github.com/N0zoM1z0/th04">Reconstruction repository</a></p>
</td></tr>
</tbody>
</table>

Agar aapne REA se koi dilchasp kaam kiya hai to hum dekhna chahenge. Apna case
[issue](https://github.com/morluto/rea/issues) ya
[pull request](https://github.com/morluto/rea/pulls) mein share karein. Target,
apna sawal, REA ne kaise madad ki aur kya mila, yeh sab batayein.

## REA kaise kaam karta hai

Aapka agent MCP ke zariye REA ko call karta hai, taake target inspect kare aur
relevant code trace kare. REA apni findings saboot ke saath wapas deta hai.
Agent unki bunyaad par agle sawal poochta hai, behavior samjhata hai ya
implementation likh kar test karta hai. CLI commands bhi yehi workflows use
karti hain.

![REA ki jaanch ka flow: agent local target ke bare mein sawal karta hai, REA analysis tools se use inspect aur trace karta hai, phir agent wapas milne wale code, references aur unknowns se samjhata, implement aur test karta hai.](../../website/public/assets/figures/rea-investigation-flow.svg)

[Puri size mein figure kholein](../../website/public/assets/figures/rea-investigation-flow.svg).

<a id="current-status"></a>

## Kya kuch analyze kar sakte hain

Native binaries · JavaScript / Electron · Websites · .NET assemblies · Android APKs · Firmware · Process behavior

[Supported formats aur zaroori cheezein](../reference/supported-targets.md)

<a id="choosing-a-deep-analysis-provider"></a>

[Analysis provider ka intikhab](../reference/supported-targets.md#choosing-a-deep-analysis-provider)

<a id="build-rl-environments"></a>

## RL environments banayein

Record kiye gaye web session ya Linux desktop app se ek local environment banayein jahan agent task ki practice kare aur natija check kare.

[RL environments banayein](https://rea.tools/guides/rl-environments/)

## FAQ

<details>
<summary><strong>Kaun se agents REA use kar sakte hain?</strong></summary>

Har woh agent jo local MCP servers support karta ho. Setup
[supported agents](../getting-started/installation.md#supported-agents) configure karta hai;
doosre clients [manual MCP registration](../getting-started/installation.md#mcp-registry)
use kar sakte hain.

</details>

<details>
<summary><strong>Kya mujhe Hopper, Ghidra, IDA ya Kuna chahiye?</strong></summary>

Deep native analysis in mein se ek use karta hai. Static JavaScript aur .NET
inspection native analysis engine ke baghair kaam karti hai. Approval ke baad
setup Hopper install kar sakta hai; Ghidra, IDA aur Kuna ke liye aapki existing
installations use hoti hain. [Provider setup](../getting-started/installation.md#hopper) dekhein.

</details>

<details>
<summary><strong>Kya pehle Hopper shuru karna hoga?</strong></summary>

Jab kisi operation ko Hopper chahiye hota hai to REA use shuru karta hai.
macOS par pehli dafa khulne wala dialog demo mode select karne ya license
activate karne ko keh sakta hai. Pehle CLI/MCP operation ya unattended job se
pehle usi user session mein yeh prompt complete karein. Zaroorat ho to Hopper
manually kholein.
[Hopper startup aur troubleshooting](../getting-started/installation.md#launcher-paths-and-troubleshooting)
dekhein.

</details>

<details>
<summary><strong>skills.sh se skill install karne se kya hota hai?</strong></summary>

Skill aapke agent ko jaanch karne ki instructions deti hai. REA ka MCP server
register karne aur matching instructions install karne ke liye
`npx rea-agents setup` use karein, phir agent restart karein.
[Sirf skill ki installation](../getting-started/installation.md#skill-only-installation) dekhein.

</details>

<details>
<summary><strong>REA kis tarah ka code wapas deta hai?</strong></summary>

Native analysis pseudocode aur assembly wapas deta hai. JavaScript/Electron
analysis modules aur unke relationships recover karta hai. Aapka agent in
findings se implementation likhta aur test karta hai;
[amli misaalein](#amli-misaalein) iska tareeqa dikhati hain.

</details>

<details>
<summary><strong>Kya REA meri app upload karta hai?</strong></summary>

REA targets ko local machine par analyze karta hai. Aapke agent ko tool results
milte hain, aur uske model provider ki apni data policy hoti hai.

</details>

<details>
<summary><strong>Bug mile to kya karun?</strong></summary>

Pehle update karein; ho sakta hai recent release mein masla hal ho chuka ho.

Agar CLI `npm install --global` ya `bun add --global` se install ki hai:

```bash
rea update
```

`npx` se agent setup ke liye:

```bash
npx rea-agents@latest setup
```

Agar agent use kar rahe hain to [setup refresh](#rea-update-karein) complete
karke agent restart karein. Wohi task dobara try karein. Masla phir bhi ho to
REA version, target type, reproduce karne ke steps aur error output ke saath
[issue kholein](https://github.com/morluto/rea/issues).

</details>

## Documentation

Website ki [amli guides](https://rea.tools/guides/) se shuru karein.
Exact options, prerequisites aur result contracts ke liye:

- [Installation aur setup](../getting-started/installation.md): agent registration, provider configuration, updates aur uninstall.
- [Readiness aur troubleshooting](../getting-started/installation.md#check-readiness-for-your-task): ek agent ya analysis engine ka masla diagnose karein.
- [CLI aur Evidence](../getting-started/cli.md): commands, provider selection, snapshots, import/export aur exit statuses.
- [MCP contracts](../reference/mcp-contracts.md) aur [agent prompts](../getting-started/mcp-prompts.md): tool results, sessions aur guided investigations.
- [Tool catalog](../reference/mcp-contracts.md#generated-catalog): tools, providers aur CLI commands ki generated inventory.

Security vulnerabilities [SECURITY.md](../../SECURITY.md) ke zariye report karein.

## Community aur madad

- **Discord** — Sawal poochhein aur apni tehqeeq hamari community ke saath share karein, jahan 50,000 se zyada log reverse engineering aur naye projects banane ka shauq rakhte hain! [![Discord](https://img.shields.io/badge/Join%20Discord-5865F2?style=flat-square&logo=discord&logoColor=white)](https://discord.gg/GkcryMnJDM)
- **Twitter / X** — Nayi khabron aur updates ke liye [@reatools](https://x.com/reatools) ko follow karein.
- **Raye aur tajaveez** — Koi naya feature chahiye ya kisi file format ki support? [GitHub](https://github.com/morluto/rea/issues) ya [Discord](https://discord.gg/GkcryMnJDM) par hamein batayein.

## Stars ki history

🎉 **400,000 GitHub stars — shukriya!**

REA use karne, bugs report karne, features suggest karne, builds test karne aur
fixes contribute karne wale sab logon ka shukriya.

<a href="https://rea.tools/ur-Latn/contributors/">
  <img src="../../website/public/contributors/avatars.png" alt="REA mein hissa lene wale" />
</a>

<a href="https://www.star-history.com/?repos=morluto%2Frea&amp;type=date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=morluto/rea&amp;type=date&amp;theme=dark&amp;legend=top-left" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=morluto/rea&amp;type=date" />
    <img alt="REA ke GitHub stars ki history" src="https://api.star-history.com/chart?repos=morluto/rea&amp;type=date" />
  </picture>
</a>

## Hissa dalein

REA mein aapki madad ka khairmaqdam hai! Bug report karne ya feature suggest
karne ke liye [issue kholein](https://github.com/morluto/rea/issues), ya code aur
docs behtar karne ke liye [pull request bhejein](https://github.com/morluto/rea/pulls).

Development setup aur checks ke liye [CONTRIBUTING.md](../../CONTRIBUTING.md),
verification lanes ke liye [testing](../development/testing.md) dekhein.

## Zimmedarana istemal

Responsible-use guidance ke liye [DISCLAIMER.md](../../DISCLAIMER.md) dekhein.

Ghair qanooni ya ghair ijazati istemal ke bare mein project ki position REA ke
tamam versions, distribution channels aur platforms par lagu hoti hai; har copy
par uske applicable licenses barqarar rehte hain.

REA qanooni research, taleem, interoperability, software preservation aur aise
software ke analysis ke liye hai jo aapka apna ho ya jise examine karne ki aapko
ijazat ho.

## License

[MIT](../../LICENSE)

REA ka apna likha hua code MIT ke tehat licensed hai. Third-party material
ke apne licenses aur copyright notices barqarar rehte hain. Dependency
inventory, preserved license texts aur external tools ki terms ke liye
[Third-party notices](../../THIRD_PARTY_NOTICES.md) dekhein.

IDA Pro / Hex-Rays decompilers, Hopper aur JEB samet **commercial tools qanooni
tareeqe se hasil karna aur unke applicable licenses ke mutabiq use karne ki
ijazat rakhna zaroori hai**. REA koi tool license, key ya activation ka haq
nahi deta. Trials aur demos vendor ki terms ke tehat rehte hain, jin mein user,
feature, automation aur output sharing ki pabandiyan bhi shamil hain. Cracked
copies, chori ki hui keys, ghair ijazati key sharing aur license restrictions
bypass karne ki ijazat nahi. Yeh guidance MIT ya third-party licenses ko
tabdeel nahi karti.
