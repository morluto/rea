<div align="center">

[English](../../README.md) · [简体中文](README_zh.md) · [繁體中文](README_zh-TW.md) · [日本語](README_ja.md) · [한국어](README_ko.md) · [Türkçe](README_tr.md) · [Русский](README_ru.md) · [Tiếng Việt](README_vi.md) · [ไทย](README_th.md) · [Deutsch](README_de.md) · [Español](README_es.md) · [Français](README_fr.md) · [Українська](README_uk.md) · [Polski](README_pl.md) · [Português (Brasil)](README_pt-BR.md) · [العربية](README_ar.md) · [فارسی](README_fa.md) · [Bahasa Indonesia](README_id.md) · [Italiano](README_it.md)
· [Ελληνικά](README_el.md) · [മലയാളം](README_ml.md) · [Roman Urdu](README_ur-Latn.md) · **Română** · [Български](README_bg.md)

# REA: Reverse Engineer Anything

### Un singur server MCP pentru inginerie inversă: fișiere binare, aplicații și comportament în timpul execuției.

**Ai găsit o funcționalitate care îți place? Înțelege cum funcționează, până la nivel de cod binar.**

[![GitHub stars](https://img.shields.io/github/stars/morluto/rea?style=flat-square&logo=github)](https://github.com/morluto/rea/stargazers)
[![Monthly npm downloads](https://img.shields.io/npm/dm/rea-agents?style=flat-square&label=npm%20downloads)](https://www.npmjs.com/package/rea-agents)
[![Licența MIT](https://img.shields.io/badge/license-MIT-f4c430?style=flat-square)](../../LICENSE)
[![Join the REA Discord](https://img.shields.io/badge/Discord-5865F2?style=flat-square&logo=discord&logoColor=white)](https://discord.gg/GkcryMnJDM)
[![Follow REA on X](https://img.shields.io/badge/X-000000?style=flat-square&logo=x&logoColor=white)](https://x.com/reatools)
[![Supported platforms: macOS, Windows, and Linux](https://img.shields.io/badge/macOS%20%7C%20Windows%20%7C%20Linux-4493F8?style=flat-square)](../getting-started/installation.md)
[![skills.sh](https://skills.sh/b/morluto/rea?style=flat-square)](https://skills.sh/morluto/rea/reverse-engineer-anything)

**[Site web](https://rea.tools/) · [Ghiduri](https://rea.tools/guides/) · [Studii de caz](https://rea.tools/showcase/)**

<a href="https://discord.com/invite/GkcryMnJDM"><img alt="Alătură-te comunității REA pe Discord" src="https://img.shields.io/badge/Join%20us%20on%20Discord-5865F2?style=for-the-badge&logo=discord&logoColor=white" height="40"></a>

[Pornire rapidă](#pornire-rapidă) · [Studii de caz](#studii-de-caz) · [Cum funcționează REA](#cum-funcționează-rea) · [Ce poți analiza](#ce-poți-analiza) · [Construiește medii RL](#build-rl-environments) · [Întrebări frecvente](#întrebări-frecvente) · [Documentație](#documentație)

<code>npx rea-agents setup</code>

</div>

> [!IMPORTANT]
> Descarcă REA din [morluto/rea](https://github.com/morluto/rea),
> de pe [rea.tools](https://rea.tools/) sau prin [pachetul npm rea-agents](https://www.npmjs.com/package/rea-agents).
> Urmează linkurile de instalare și către versiunile publicate oferite de aceste surse oficiale.
> Un nume de repository asemănător sau un README copiat nu dovedește că descărcarea provine dintr-o sursă oficială.

<div align="center">

<br />

<img src="../assets/rea-hopper-analysis.png" alt="REA pornește componenta de legătură pentru analiză în Hopper în timp ce inspectează un fișier binar nativ" width="1200" />

<br /><br />

<table aria-label="Comunitatea REA">
<tr>
<td align="center" width="360">
  <a href="https://discord.gg/GkcryMnJDM">
    <img src="../assets/discord.svg" height="42" alt="Discord" /><br />
    <strong>Alătură-te comunității de inginerie inversă</strong>
  </a><br />
  <sub>Discord · Întrebări și răspunsuri · Prezentări și demonstrații</sub>
</td>
</tr>
</table>

<br />

</div>

---

Ai văzut într-o aplicație o funcționalitate pe care ai vrea să o incluzi în propriul produs? Cere-i agentului tău să o investigheze cu REA. Poate inspecta aplicația fără codul ei sursă, poate explica modul în care funcționează acea funcționalitate, poate prezenta dovezile și poate construi o variantă pentru proiectul tău.

REA conectează agentul tău la unelte pentru inspectarea fișierelor binare native, a aplicațiilor JavaScript și Electron, a ansamblurilor .NET și a site-urilor web. Poți folosi aceleași unelte și din terminal. Analiza rulează local, iar rezultatele includ dovezile și limitările care stau la baza fiecărei concluzii.

Programul de configurare înregistrează REA în agentul tău și instalează instrucțiunile corespunzătoare pentru fluxul de lucru. Analiza nativă poate folosi o instalare existentă de Hopper, Ghidra, IDA sau Kuna; programul de configurare poate instala opțional Hopper, cu aprobarea ta. Analiza statică JavaScript nu necesită un motor de analiză nativă.

## Pornire rapidă

**[Pornire rapidă · rea.tools](https://rea.tools/ro/get-started/)**

### Configurează agentul (MCP)

După ce instalezi [Node.js și npm](../reference/supported-targets.md), rulează comanda dintr-un director de încredere aflat în afara proiectului de analizat.

```bash
npx rea-agents setup
```

Alege agenții, verifică modificările propuse și aprobă-le. Configurarea adaugă
serverul MCP REA și instrucțiunile corespunzătoare pentru fluxul de lucru,
creând copii de siguranță ale configurației existente. Repornește apoi agentul.

[instalarea și configurarea](../getting-started/installation.md)

Cere-i agentului:

```text
Înțelege cum funcționează căutarea în aplicația Notes, arată-mi dovezile și
construiește o funcționalitate similară pentru proiectul meu.
```

Înlocuiește Notes cu aplicația vizată și precizează funcționalitatea pe care vrei să o înțelegi.

### Folosește terminalul (CLI)

Inspectează directorul extras al unei aplicații JavaScript/Electron sau o arhivă ASAR:

```bash
npx -y rea-agents@latest analyze-javascript-application /absolute/path/to/app --json
```

Rezultatul include modulele, importurile, delimitările dintre componentele Electron
și dovezile aferente. Înlocuiește calea cu cea a aplicației vizate, de exemplu
`"D:/apps/example"` pe Windows.

Pentru a instala comanda `rea` și a o folosi în mod curent:

```bash
npm install --global rea-agents
rea --help
```

Pentru analiza nativă, configurează mai întâi un motor de analiză. Consultă
[ghidul CLI și Evidence](../getting-started/cli.md) pentru comenzile de analiză nativă,
selectarea motorului, instantanee și utilizarea în scripturi.

[Cerințe pentru Linux](../getting-started/installation.md#linux-owned-process-prerequisite)

### Actualizează REA

Pentru o interfață CLI instalată cu `npm install --global` sau `bun add --global`:

```bash
rea update
```

Dacă folosești `npx`, actualizează configurarea agentului cu:

```bash
npx rea-agents@latest setup
```

[Actualizare și dezinstalare](../getting-started/installation.md#diagnose-update-and-remove)

## Studii de caz

<a href="https://rea.tools/showcase/">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../assets/rea-showcases-dark.svg" />
    <img alt="Ilustrații pentru studiile de caz despre panoramarea sunetului în DX-Ball, legătura cu clipboardul în Notion și inelele de proiectile din TH04" src="../assets/rea-showcases.svg" />
  </picture>
</a>

<table>
<tbody>
<tr><td>
<h3>DX-Ball: reconstruiește calculul panoramării sunetului</h3>
<p>Urmărește un apel audio până la funcția auxiliară care transformă poziția în
panoramare stereo, inspectează instrucțiunile și transformă pseudocodul incomplet
în C. Reconstrucția trece 3.205 cazuri de test comparate cu originalul x86 și
reproduce toți cei 63 de octeți ai funcției compilate.</p>
<p><a href="https://rea.tools/showcase/dx-ball/">Citește studiul de caz</a> ·
<a href="https://github.com/N0zoM1z0/dx-ball">Repository-ul reconstrucției</a></p>
</td></tr>
<tr><td>
<h3>Notion: urmărește legătura Electron cu clipboardul</h3>
<p>Găsește API-ul pentru clipboard din procesul de randare, urmărește-l prin preload
și IPC până în procesul principal și inspectează formatul datelor cu formatare din clipboard.</p>
<p><a href="https://rea.tools/showcase/notion/">Citește studiul de caz</a></p>
</td></tr>
<tr><td>
<h3>TH04: recuperează calculul unui inel de proiectile DOS</h3>
<p>Inspectează instrucțiunile pe 16 biți ale jocului original pentru PC-98,
recuperează calculele unghiurilor fixe și ale celor orientate spre țintă și
compară codul C++ reconstruit cu rezultatul compilatorului folosit la acea vreme.</p>
<p><a href="https://rea.tools/showcase/th04/">Citește studiul de caz</a> ·
<a href="https://github.com/N0zoM1z0/th04">Repository-ul reconstrucției</a></p>
</td></tr>
</tbody>
</table>

Dacă ai folosit REA pentru ceva interesant, ne-ar plăcea să vedem rezultatul.
Prezintă cazul într-un [issue](https://github.com/morluto/rea/issues) sau într-un
[pull request](https://github.com/morluto/rea/pulls), menționând ținta analizată,
întrebarea ta, cum te-a ajutat REA și ce ai descoperit.

## Cum funcționează REA

Agentul tău apelează REA prin MCP pentru a inspecta ținta și a urmări codul relevant.
REA returnează constatările împreună cu dovezile aferente. Agentul le folosește
pentru a pune întrebări suplimentare, a explica comportamentul sau a scrie și
testa o implementare. Comenzile CLI folosesc aceleași fluxuri de lucru.

![Fluxul unei investigații REA: agentul întreabă despre o țintă locală, REA o inspectează și îi urmărește comportamentul cu ajutorul uneltelor de analiză, iar agentul folosește codul, referințele și necunoscutele returnate pentru a explica, implementa și testa.](../../website/public/assets/figures/rea-investigation-flow.svg)

[Deschide figura la dimensiunea originală](../../website/public/assets/figures/rea-investigation-flow.svg).

<a id="current-status"></a>

## Ce poți analiza

Fișiere binare native · JavaScript / Electron · Site-uri web · Ansambluri .NET · APK-uri Android · Firmware · Comportamentul proceselor

[Formate acceptate și cerințe](../reference/supported-targets.md)

<a id="choosing-a-deep-analysis-provider"></a>

[Alegerea unui furnizor de analiză](../reference/supported-targets.md#choosing-a-deep-analysis-provider)

<a id="build-rl-environments"></a>

## Construiește medii RL

Creează un mediu local dintr-o sesiune web înregistrată sau dintr-o aplicație desktop Linux, în care un agent poate exersa o sarcină și verifica rezultatul.

[Construiește medii RL](https://rea.tools/guides/rl-environments/)

## Întrebări frecvente

<details>
<summary><strong>Ce agenți pot folosi REA?</strong></summary>

Orice agent care acceptă servere MCP locale. Programul de configurare pregătește
[agenții acceptați](../getting-started/installation.md#supported-agents); pentru ceilalți clienți
poți folosi [înregistrarea manuală MCP](../getting-started/installation.md#mcp-registry).

</details>

<details>
<summary><strong>Am nevoie de Hopper, Ghidra, IDA sau Kuna?</strong></summary>

Analiza nativă aprofundată folosește unul dintre aceste instrumente. Inspectarea
statică JavaScript și .NET funcționează fără un motor de analiză nativă.
Programul de configurare poate instala Hopper după aprobare; pentru Ghidra, IDA și Kuna
folosește instalările existente. Consultă [configurarea motoarelor de analiză](../getting-started/installation.md#hopper).

</details>

<details>
<summary><strong>Trebuie să pornesc mai întâi Hopper?</strong></summary>

REA pornește Hopper când o operație are nevoie de el. Pe macOS, un dialog afișat
la prima pornire îți poate cere să alegi modul demonstrativ sau să activezi licența.
Finalizează acel pas în aceeași sesiune de utilizator înainte de prima operație
CLI/MCP sau de prima sarcină nesupravegheată. Deschide Hopper manual dacă este nevoie.
Consultă [pornirea Hopper și depanarea](../getting-started/installation.md#launcher-paths-and-troubleshooting).

</details>

<details>
<summary><strong>Ce face instalarea skill-ului de pe skills.sh?</strong></summary>

Skill-ul oferă agentului instrucțiuni de investigare. Folosește `npx rea-agents setup`
pentru a înregistra serverul MCP REA și a instala instrucțiunile corespunzătoare,
apoi repornește agentul. Consultă [instalarea doar a skill-ului](../getting-started/installation.md#skill-only-installation).

</details>

<details>
<summary><strong>Ce cod returnează REA?</strong></summary>

Analiza nativă returnează pseudocod și cod de asamblare. Analiza JavaScript/Electron
recuperează modulele și relațiile dintre ele. Agentul tău folosește aceste
constatări pentru a scrie și testa o implementare;
[studiile de caz](#studii-de-caz) oferă exemple detaliate.

</details>

<details>
<summary><strong>REA îmi încarcă aplicația pe un server?</strong></summary>

REA analizează țintele local. Agentul tău primește rezultatele uneltelor, iar
furnizorul modelului său are propria politică privind datele.

</details>

<details>
<summary><strong>Ce fac dacă întâlnesc o eroare?</strong></summary>

Actualizează mai întâi; o versiune recentă ar putea să o fi remediat deja.

Pentru o interfață CLI instalată cu `npm install --global` sau `bun add --global`:

```bash
rea update
```

Pentru configurarea agentului prin `npx`:

```bash
npx rea-agents@latest setup
```

Dacă folosești un agent, finalizează [actualizarea configurării](#actualizează-rea)
și repornește-l. Reîncearcă aceeași sarcină. Dacă problema persistă,
[deschide un issue](https://github.com/morluto/rea/issues) și include versiunea REA,
tipul țintei analizate, pașii de reproducere și mesajele de eroare.

</details>

## Documentație

Începe cu [ghidurile practice](https://rea.tools/guides/) de pe site.
Pentru opțiunile exacte, cerințele preliminare și contractele rezultatelor:

- [Instalare și configurare](../getting-started/installation.md): înregistrarea agenților, configurarea motoarelor de analiză, actualizări și dezinstalare.
- [Verificarea pregătirii și depanare](../getting-started/installation.md#check-readiness-for-your-task): diagnosticarea unui agent sau motor de analiză.
- [CLI și Evidence](../getting-started/cli.md): comenzi, selectarea motorului, instantanee, import/export și coduri de ieșire.
- [Contracte MCP](../reference/mcp-contracts.md) și [prompturi pentru agenți](../getting-started/mcp-prompts.md): rezultatele uneltelor, sesiuni și investigații ghidate.
- [Catalogul uneltelor](../reference/mcp-contracts.md#generated-catalog): inventarul generat al uneltelor, motoarelor de analiză și comenzilor CLI.

Raportează vulnerabilitățile conform [SECURITY.md](../../SECURITY.md).

## Comunitate și asistență

- **Discord** — Pune întrebări și discută ce investighezi cu peste 50.000 de oameni pasionați de inginerie inversă și de construirea de proiecte! [![Discord](https://img.shields.io/badge/Join%20Discord-5865F2?style=flat-square&logo=discord&logoColor=white)](https://discord.gg/GkcryMnJDM)
- **Twitter / X** — Urmărește [@reatools](https://x.com/reatools) pentru noutăți.
- **Sugestii și idei** — Îți dorești o funcție sau suport pentru un format de fișier? Scrie-ne pe [GitHub](https://github.com/morluto/rea/issues) sau [Discord](https://discord.gg/GkcryMnJDM).

## Istoricul stelelor

🎉 **400.000 de stele pe GitHub — vă mulțumim!**

Mulțumim tuturor celor care folosesc REA, raportează erori, propun funcționalități,
testează versiuni și contribuie cu remedieri.

<a href="https://rea.tools/ro/contributors/">
  <img src="../../website/public/contributors/avatars.png" alt="Colaboratorii REA" />
</a>

<a href="https://www.star-history.com/?repos=morluto%2Frea&amp;type=date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=morluto/rea&amp;type=date&amp;theme=dark&amp;legend=top-left" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=morluto/rea&amp;type=date" />
    <img alt="Istoricul stelelor REA pe GitHub" src="https://api.star-history.com/chart?repos=morluto/rea&amp;type=date" />
  </picture>
</a>

## Contribuții

Ne-ar bucura să contribui la REA! [Deschide un issue](https://github.com/morluto/rea/issues)
pentru a raporta o eroare sau a propune o funcționalitate ori
[trimite un pull request](https://github.com/morluto/rea/pulls) pentru a îmbunătăți
codul sau documentația.

Consultă [CONTRIBUTING.md](../../CONTRIBUTING.md) pentru pregătirea mediului de dezvoltare
și verificări, [ghidul de testare](../development/testing.md) pentru categoriile de verificări.

## Precizări privind utilizarea

Consultă [DISCLAIMER.md](../../DISCLAIMER.md) pentru îndrumări privind utilizarea responsabilă.

> [!WARNING]
> **Account Ban Notice & Authorized Use Only:** AI providers and platforms (such as Anthropic, OpenAI, Cursor, and other model hosts) employ automated safety filters and abuse monitoring. Prompting AI agents to decompile proprietary software, extract protected intellectual property, or bypass DRM and anti-cheat protections violates AI acceptable use policies and can result in immediate and permanent account suspension or API access revocation.
>
> REA must only be used on software you own, public-domain code, or targets for which you possess explicit authorization. Reverse engineering proprietary software without authorization does not grant rights to generated code and may violate copyright laws and terms of service.

Poziția proiectului față de utilizarea ilegală sau neautorizată se aplică tuturor
versiunilor REA, canalelor de distribuție și platformelor; fiecare copie își
păstrează licențele aplicabile.

REA este destinat cercetării legale, educației, interoperabilității, conservării
software-ului și analizei programelor pe care le deții sau pe care ai autorizarea
să le examinezi.

## Licență

[MIT](../../LICENSE)

Codul scris în cadrul REA este licențiat sub MIT. Materialele terților își păstrează
propriile licențe și mențiuni privind drepturile de autor; consultă
[mențiunile privind terții](../../THIRD_PARTY_NOTICES.md) pentru inventarul
dependențelor, textele licențelor păstrate și condițiile aplicabile uneltelor externe.

**Trebuie să obții legal uneltele comerciale și să ai dreptul să le folosești**,
inclusiv decompilatoarele IDA Pro / Hex-Rays, Hopper și JEB, în condițiile
licențelor aplicabile. REA nu îți acordă nicio licență, cheie sau drept de activare
pentru aceste unelte. Versiunile de evaluare și demonstrative rămân supuse
condițiilor furnizorilor, inclusiv restricțiilor privind utilizatorii,
funcționalitățile, automatizarea și partajarea rezultatelor. Nu sunt autorizate
copiile piratate, cheile furate, partajarea neautorizată a cheilor sau ocolirea
restricțiilor de licențiere. Aceste îndrumări nu modifică licența MIT sau licențele terților.
