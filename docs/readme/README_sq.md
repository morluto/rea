<div align="center">

[English](../../README.md) · [简体中文](README_zh.md) · [繁體中文](README_zh-TW.md) · [日本語](README_ja.md) · [한국어](README_ko.md) · [Türkçe](README_tr.md) · [Русский](README_ru.md) · [Tiếng Việt](README_vi.md) · [ไทย](README_th.md) · [Deutsch](README_de.md) · [Español](README_es.md) · [Français](README_fr.md) · [Українська](README_uk.md) · [Polski](README_pl.md) · [Português (Brasil)](README_pt-BR.md) · [العربية](README_ar.md) · [فارسی](README_fa.md) · [Bahasa Indonesia](README_id.md) · [Italiano](README_it.md)
· [Ελληνικά](README_el.md) · [മലയാളം](README_ml.md) · [Roman Urdu](README_ur-Latn.md) · [Română](README_ro.md) · [Български](README_bg.md) · **Shqip**

# REA: Reverse Engineer Anything

### Një MCP për inxhinierinë e kundërt të skedarëve binarë, aplikacioneve dhe sjelljes gjatë ekzekutimit.

**Shikoni një veçori që ju pëlqen. Kuptoni se si funksionon, deri në nivelin binar.**

[![Yjet në GitHub](https://img.shields.io/github/stars/morluto/rea?style=flat-square&logo=github)](https://github.com/morluto/rea/stargazers)
[![Shkarkimet mujore në npm](https://img.shields.io/npm/dm/rea-agents?style=flat-square&label=npm%20downloads)](https://www.npmjs.com/package/rea-agents)
[![Licenca MIT](https://img.shields.io/badge/license-MIT-f4c430?style=flat-square)](../../LICENSE)
[![Bashkohuni me REA në Discord](https://img.shields.io/badge/Discord-5865F2?style=flat-square&logo=discord&logoColor=white)](https://discord.gg/GkcryMnJDM)
[![Ndiqni REA në X](https://img.shields.io/badge/X-000000?style=flat-square&logo=x&logoColor=white)](https://x.com/reatools)
[![Platformat e mbështetura: macOS, Windows dhe Linux](https://img.shields.io/badge/macOS%20%7C%20Windows%20%7C%20Linux-4493F8?style=flat-square)](../getting-started/installation.md)
[![skills.sh](https://skills.sh/b/morluto/rea?style=flat-square)](https://skills.sh/morluto/rea/reverse-engineer-anything)

**[Uebsajti](https://rea.tools/sq/) · [Udhëzues](https://rea.tools/sq/guides/) · [Vitrinë](https://rea.tools/sq/showcase/)**

<a href="https://discord.com/invite/GkcryMnJDM"><img alt="Bashkohuni me komunitetin REA në Discord" src="https://img.shields.io/badge/Join%20us%20on%20Discord-5865F2?style=for-the-badge&logo=discord&logoColor=white" height="40"></a>

[Fillimi i shpejtë](#fillimi-i-shpejtë) · [Shembuj praktikë](#shembuj-praktikë) · [Si funksionon REA](#si-funksionon-rea) · [Çfarë mund të analizoni](#çfarë-mund-të-analizoni) · [Ndërtoni mjedise RL](#ndërtoni-mjedise-rl) · [Pyetje të shpeshta](#pyetje-të-shpeshta) · [Dokumentacioni](#dokumentacioni)

<code>npx rea-agents setup</code>

</div>

> [!IMPORTANT]
> Merreni REA nga [morluto/rea](https://github.com/morluto/rea),
> [rea.tools](https://rea.tools/) ose [paketa npm rea-agents](https://www.npmjs.com/package/rea-agents).
> Ndiqni lidhjet e instalimit dhe publikimit nga këto burime zyrtare. Një emër i ngjashëm
> depoje ose një README i kopjuar nuk dëshmon se shkarkimi është zyrtar.

<div align="center">

<br />

<img src="../assets/rea-hopper-analysis.png" alt="REA nis urën e analizës brenda Hopper gjatë inspektimit të një skedari binar me kod makine" width="1200" />

<br /><br />

<table aria-label="Komuniteti REA">
<tr>
<td align="center" width="360">
  <a href="https://discord.gg/GkcryMnJDM">
    <img src="../assets/discord.svg" height="42" alt="Discord" /><br />
    <strong>Bashkohu në komunitetin e inxhinierisë së kundërt</strong>
  </a><br />
  <sub>Discord · Pyetje dhe përgjigje · Shfaq dhe trego</sub>
</td>
</tr>
</table>

<br />

</div>

---

Shihni një veçori në një aplikacion që dëshironi në produktin tuaj? Kërkojini agjentit tuaj ta hetojë atë me REA. Ai mund të inspektojë aplikacionin pa kodin e tij burimor, të shpjegojë se si funksionon veçoria, të tregojë provat dhe të ndërtojë një version për projektin tuaj.

REA e lidh agjentin tuaj me mjete për inspektimin e skedarëve binarë me kod makine, aplikacioneve JavaScript dhe Electron, asambleve .NET dhe faqeve të internetit. Të njëjtat mjete mund t'i përdorni edhe nga terminali. Analiza kryhet lokalisht dhe rezultatet përfshijnë provat dhe kufizimet mbi të cilat mbështetet çdo përfundim.

Konfigurimi regjistron REA tek agjenti juaj dhe instalon udhëzimet përkatëse të punës. Analiza e kodit të makinës mund të përdorë një instalim ekzistues të Hopper, Ghidra, IDA ose Kuna; me miratimin tuaj, konfigurimi mund të instalojë edhe Hopper. Analiza statike e JavaScript nuk kërkon një motor analize të kodit të makinës.

## Fillimi i shpejtë

**[Filloni në rea.tools](https://rea.tools/sq/get-started/)** për udhëzime
hap pas hapi sipas sistemit operativ, agjentit dhe ofruesit të analizës.

### Lidhni agjentin tuaj (MCP)

Me [Node.js dhe npm](../reference/supported-targets.md) të instaluara, ekzekutojeni këtë nga një
direktori e besuar jashtë projektit që planifikoni të analizoni.

```bash
npx rea-agents setup
```

Zgjidhni agjentin tuaj, shqyrtoni dhe miratoni planin e konfigurimit, pastaj rinisni agjentin.
Konfigurimi ruan kopje rezervë të konfigurimit ekzistues dhe shton lidhjen MCP të REA dhe
aftësinë e hetimit. Shihni
[udhëzuesin e instalimit](../getting-started/installation.md) për klientët e mbështetur,
shtojcat, regjistrimin manual dhe zgjidhjen e problemeve.

Provoni t'i kërkoni agjentit tuaj:

```text
Kuptoni si funksionon kërkimi në aplikacionin Notes, më tregoni provat dhe
ndërtoni një veçori të ngjashme për projektin tim.
```

Zëvendësoni Notes me aplikacionin objektiv dhe veçorinë që dëshironi të kuptoni.

### Përdorni REA nga terminali (CLI)

Inspektoni një direktori aplikacioni të nxjerrë JavaScript/Electron ose ASAR:

```bash
npx -y rea-agents@latest analyze-javascript-application /absolute/path/to/app --json
```

Rezultati përfshin modulet, importet, kufijtë Electron dhe dëshmitë e tyre.
Zëvendësoni shtegun me objektivin tuaj, si p.sh. `"D:/apps/example"` në Windows.

Për të instaluar komandën `rea` për përdorim të rregullt:

```bash
npm install --global rea-agents
rea --help
```

Për analizën e kodit të makinës, fillimisht konfiguroni një ofrues.
[Udhëzuesi për CLI dhe Evidence](../getting-started/cli.md) mbulon zgjedhjen e ofruesit,
komandat e kodit të makinës, pamjet e ruajtura të gjendjes dhe përdorimin në skripte. Për kushtet paraprake në Linux, shihni
[udhëzuesin e instalimit](../getting-started/installation.md#linux-owned-process-prerequisite).

### Përditëso REA

Për një instalim global npm ose Bun, ekzekutoni përditësuesin dhe ndiqni udhëzimet e tij të
konfigurimit.

```bash
rea update
```

Nëse përdorni `npx`, rifreskoni konfigurimin e agjentit tuaj me:

```bash
npx rea-agents@latest setup
```

Rishikoni ndryshimet e konfigurimit dhe rinisni agjentin tuaj. Shihni
[udhëzimet e përditësimit dhe çinstalimit](../getting-started/installation.md#diagnose-update-and-remove)
për opsionet e ekzekutuesve të paketave dhe zgjidhjen e problemeve.

## Shembuj praktikë

<a href="https://rea.tools/sq/showcase/">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../assets/rea-showcases-dark.svg" />
    <img alt="Ilustrime të studimeve të rasteve: panoramimi i zërit në DX-Ball, ura e clipboard-it në Notion dhe unaza e predhave në TH04" src="../assets/rea-showcases.svg" />
  </picture>
</a>

<table>
<tbody>
<tr>
<td>
<h3>DX-Ball: rindërtoni llogaritjen e panoramimit të zërit</h3>
<p>Rikuperoni një funksion ndihmës nga pozicioni në panoramim nga instruksionet x86 dhe verifikoni rindërtimin në C ndaj 3,205 rasteve origjinale x86 dhe të 63 bajteve të funksionit të përpiluar.</p>
<a href="https://rea.tools/sq/showcase/dx-ball/">Lexoni studimin e rastit</a> ·
<a href="https://github.com/N0zoM1z0/dx-ball">Depoja e rindërtimit</a>
</td>
</tr>
<tr>
<td>
<h3>Notion: gjurmoni urën e kujtesës Electron</h3>
<p>Ndiqni API-në e clipboard-it të procesit të paraqitjes përmes preload dhe IPC deri te procesi kryesor për të parë si i trajton Notion të dhënat e pasura të clipboard-it.</p>
<a href="https://rea.tools/sq/showcase/notion/">Lexoni studimin e rastit</a>
</td>
</tr>
<tr>
<td>
<h3>TH04: rikuperoni llogaritjen e një unaze predhash në DOS</h3>
<p>Rikuperoni llogaritjet e këndeve fikse dhe të drejtuara drejt objektivit nga instruksionet 16-bit të lojës PC-98 dhe krahasoni kodin C++ të rindërtuar me rezultatin e përpiluesit historik.</p>
<a href="https://rea.tools/sq/showcase/th04/">Lexoni studimin e rastit</a> ·
<a href="https://github.com/N0zoM1z0/th04">Depoja e rindërtimit</a>
</td>
</tr>
</tbody>
</table>

Nëse e keni përdorur REA për diçka interesante, do të donim ta shihnim. Ndajeni
rastin tuaj në një [issue](https://github.com/morluto/rea/issues) ose
[pull request](https://github.com/morluto/rea/pulls), duke përfshirë objektivin,
pyetjen tuaj, si ju ndihmoi REA dhe çfarë zbuluat.

## Si funksionon REA

Agjenti juaj përdor REA përmes MCP për të inspektuar një objektiv dhe për të gjurmuar kodin përkatës.
Ai mund të përdorë provat që kthen REA për të bërë pyetje të mëtejshme, për të shpjeguar sjelljen
ose për të ndërtuar dhe testuar një zbatim. CLI përdor të njëjtat rrjedha pune.

![REA rrjedha e hetimit: agjenti juaj pyet për një objektiv lokal, REA e inspekton dhe e gjurmon atë duke përdorur mjetet e analizës dhe agjenti përdor kodin e kthyer, referencat dhe të panjohurat për të shpjeguar, zbatuar dhe testuar.](../../website/public/assets/figures/rea-investigation-flow.svg)

[Hap figurën në madhësi të plotë](../../website/public/assets/figures/rea-investigation-flow.svg).

<a id="current-status"></a>

## Çfarë mund të analizoni

REA mbulon skedarë binarë me kod makine, aplikacione JavaScript dhe Electron, faqe interneti, asamble .NET,
aplikacione Android, firmware dhe aktivitet të regjistruar gjatë ekzekutimit dhe në rrjet.

[Objektivat e mbështetur dhe kërkesat](../reference/supported-targets.md)

<a id="choosing-a-deep-analysis-provider"></a>

Për dekompilimin e kodit të makinës, zgjidhni një ofrues që mbështet formatin e objektivit
dhe sistemin tuaj operativ. Shihni [zgjedhjen e një ofruesi të analizës së thellë](../reference/supported-targets.md#choosing-a-deep-analysis-provider).

## Ndërtoni mjedise RL

Ndërtoni një mjedis lokal nga një seancë e regjistruar web ose një aplikacion desktop Linux
në mënyrë që një agjent të mund të ushtrohet në një detyrë dhe të kontrollojë rezultatin e saj.
[Ndërtoni një mjedis RL me REA](https://rea.tools/sq/guides/rl-environments/).

## Pyetje të shpeshta

<details>
<summary><strong>Cilët agjentë mund të përdorin REA?</strong></summary>

Çdo agjent që mbështet serverët lokalë MCP. Konfigurimi konfiguron
[agjentët e mbështetur](../getting-started/installation.md#supported-agents); klientët e tjerë mund të përdorin
[regjistrimin manual MCP](../getting-started/installation.md#mcp-registry).

</details>

<details>
<summary><strong>A më duhet një motor analize i kodit të makinës?</strong></summary>

Analiza e thellë e kodit të makinës përdor Hopper, Ghidra, IDA ose Kuna, sipas objektivit
dhe operacionit. Inspektimi statik i JavaScript dhe .NET funksionon pa një motor
analize të kodit të makinës. Konfigurimi mund të instalojë Hopper pas miratimit; Ghidra, IDA dhe Kuna
përdorin instalimet tuaja ekzistuese. Shihni [konfigurimin e ofruesit](../getting-started/installation.md#hopper)
për opsionet dhe objektivat e tyre të mbështetur.

</details>

<details>
<summary><strong>A duhet të nis fillimisht Hopper?</strong></summary>

REA e nis Hopper kur një operacion ka nevojë për të. Në macOS, një dialog gjatë nisjes së parë mund
t'ju kërkojë të zgjidhni modalitetin demonstrues ose të aktivizoni licencën. Përfundojeni këtë hap në
të njëjtin sesion përdoruesi përpara operacionit të parë CLI/MCP ose një pune të pambikëqyrur. Hapeni
Hopper manualisht nëse është e nevojshme. Shihni
[nisjen e Hopper dhe zgjidhjen e problemeve](../getting-started/installation.md#launcher-paths-and-troubleshooting).

</details>

<details>
<summary><strong>Çfarë bën instalimi i aftësisë nga skills.sh?</strong></summary>

Aftësia i jep agjentit tuaj udhëzime për hetimin. Përdorni `npx rea-agents setup`
për të regjistruar serverin MCP të REA dhe për të instaluar udhëzimet përkatëse, pastaj rinisni
agjentin tuaj. Shihni [instalimin vetëm të aftësisë](../getting-started/installation.md#skill-only-installation).

</details>

<details>
<summary><strong>Çfarë kodi kthen REA?</strong></summary>

Analiza e kodit të makinës kthen pseudokod dhe instruksione assembly. Analiza JavaScript/Electron
rikuperon modulet dhe marrëdhëniet e tyre. Agjenti juaj i përdor këto gjetje për të
shkruar dhe testuar një zbatim; [shembujt praktikë](#shembuj-praktikë) japin shembuj të punuar.

</details>

<details>
<summary><strong>A e ngarkon REA aplikacionin tim?</strong></summary>

REA i analizon objektivat lokalisht. Agjenti juaj merr rezultatet e mjeteve dhe ofruesi i
modelit të tij ka politikën e vet për të dhënat.

</details>

<details>
<summary><strong>Çfarë duhet të bëj nëse has një gabim?</strong></summary>

Përditëso së pari; një version i fundit tashmë mund ta rregullojë atë.

Për një CLI të instaluar me `npm install --global` ose `bun add --global`:

```bash
rea update
```

Për konfigurimin e agjentit përmes `npx`:

```bash
npx rea-agents@latest setup
```

Nëse jeni duke përdorur një agjent, plotësoni [rifreskimin e konfigurimit](#përditëso-rea) dhe rinisni
atë. Provo sërish të njëjtën detyrë. Nëse problemi vazhdon, [hap një issue](https://github.com/morluto/rea/issues)
me versionin tuaj të REA, llojin e objektivit, hapat për ta riprodhuar dhe daljen e gabimit.

</details>

## Dokumentacioni

Filloni me [udhëzuesit praktikë](https://rea.tools/sq/guides/) të faqes.
Për opsionet e sakta, kushtet paraprake dhe kontratat e rezultateve:

- [Instalimi dhe konfigurimi](../getting-started/installation.md): regjistrimi i agjentit, konfigurimi i ofruesit, përditësimet dhe çinstalimi.
- [Gatishmëria dhe zgjidhja e problemeve](../getting-started/installation.md#check-readiness-for-your-task): diagnostikoni një agjent ose motor analize.
- [CLI dhe Evidence](../getting-started/cli.md): komandat, zgjedhja e ofruesit, pamjet e ruajtura, importi/eksporti dhe statuset e daljes.
- [Kontratat MCP](../reference/mcp-contracts.md) dhe [kërkesat e agjentit](../getting-started/mcp-prompts.md): rezultatet e veglave, seancat dhe hetimet e drejtuara.
- [Katalogu i veglave](../reference/mcp-contracts.md#generated-catalog): inventari i gjeneruar i mjeteve, ofruesve dhe komandave CLI.

Raportoni dobësitë përmes [SECURITY.md](../../SECURITY.md).

## Komuniteti dhe Mbështetja

- **Discord** — Bëni pyetje dhe ndani atë që po hetoni me komunitetin tonë pasionant prej mbi 50,000 inxhinierësh të kundërt dhe ndërtuesish! [![Bashkohuni me REA në Discord](https://img.shields.io/badge/Join%20Discord-5865F2?style=flat-square&logo=discord&logoColor=white)](https://discord.gg/GkcryMnJDM)
- **Twitter / X** — Ndiqni [@reatools](https://x.com/reatools) për përditësime dhe njoftime.
- **Komente dhe Ide** — Dëshironi një veçori të re ose mbështetje për një format skedari? [Hapni një issue në GitHub](https://github.com/morluto/rea/issues) ose [bashkohuni në Discord-in tonë](https://discord.gg/GkcryMnJDM) dhe na njoftoni.

## Historia e yjeve

🎉 **400,000 yje GitHub — faleminderit!**

Faleminderit të gjithëve që përdorin REA, raportojnë defekte, kërkojnë veçori, testojnë ndërtime dhe kontribuojnë me rregullime.

<a href="https://rea.tools/sq/contributors/">
  <img src="../../website/public/contributors/avatars.png" alt="Kontribuuesit e REA" />
</a>

<a href="https://www.star-history.com/?repos=morluto%2Frea&amp;type=date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=morluto/rea&amp;type=date&amp;theme=dark&amp;legend=top-left" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=morluto/rea&amp;type=date" />
    <img alt="REA GitHub star history" src="https://api.star-history.com/chart?repos=morluto/rea&amp;type=date" />
  </picture>
</a>

## Kontributi

Ndihma juaj për REA është e mirëpritur! [Hapni një issue](https://github.com/morluto/rea/issues) për të
raportuar një gabim ose për të sugjeruar një veçori, ose [dërgoni një pull request](https://github.com/morluto/rea/pulls)
për të përmirësuar kodin ose dokumentacionin.

Shihni [CONTRIBUTING.md](../../CONTRIBUTING.md) për konfigurimin dhe kontrollet e zhvillimit. Shihni
[udhëzuesin e testimit](../development/testing.md) për korsitë e verifikimit.

## Mohim përgjegjësie

Shihni [DISCLAIMER.md](../../DISCLAIMER.md) për udhëzime për përdorim të përgjegjshëm.

Pozicioni i projektit për përdorimin e paligjshëm ose të paautorizuar mbulon të gjitha versionet e REA,
kanalet dhe platformat e shpërndarjes; çdo kopje ruan licencat e saj të zbatueshme.

REA është për kërkime të ligjshme, edukim, ndërveprueshmëri, ruajtje të softuerit,
dhe analiza e softuerit që zotëroni ose jeni të autorizuar ta ekzaminoni.

## Licencë

[MIT](../../LICENSE)

Kodi i shkruar nga REA licencohet sipas MIT. Materialet e palëve të treta ruajnë licencat dhe njoftimet e tyre për të drejtat e autorit; shihni
[Njoftimet e palëve të treta](../../THIRD_PARTY_NOTICES.md) për inventarin e varësisë,
tekstet e ruajtura të licencës dhe termat e veglave të jashtme.

**Mjetet komerciale duhet t'i siguroni ligjërisht dhe të keni autorizim për përdorimin e tyre**, përfshirë IDA Pro / dekompiluesit Hex-Rays, Hopper dhe JEB, sipas licencave përkatëse. REA nuk jep asnjë licencë mjeti, çelës apo të drejtë aktivizimi. Versionet provë dhe demonstrimet u nënshtrohen kushteve të furnizuesit, përfshirë kufizimet për përdoruesit, veçoritë, automatizimin dhe ndarjen e rezultateve. Kopjet e thyera, çelësat e vjedhur, ndarja e paautorizuar e çelësave dhe anashkalimi i kufizimeve të licencës nuk janë të autorizuara. Ky udhëzim nuk ndryshon MIT apo licencat e palëve të treta.
