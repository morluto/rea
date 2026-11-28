<div align="center">

[English](../../README.md) · [简体中文](README_zh.md) · [繁體中文](README_zh-TW.md) · [日本語](README_ja.md) · [한국어](README_ko.md) · [Türkçe](README_tr.md) · [Русский](README_ru.md) · [Tiếng Việt](README_vi.md) · [ไทย](README_th.md) · **Deutsch** · [Español](README_es.md) · [Français](README_fr.md) · [Українська](README_uk.md) · [Polski](README_pl.md) · [Português (Brasil)](README_pt-BR.md) · [العربية](README_ar.md) · [فارسی](README_fa.md) · [Bahasa Indonesia](README_id.md) · [Italiano](README_it.md)
· [Ελληνικά](README_el.md) · [മലയാളം](README_ml.md) · [Roman Urdu](README_ur-Latn.md) · [Română](README_ro.md) · [Български](README_bg.md) · [हिन्दी](README_hi.md)

# REA: Alles reverse-engineeren

### Ein MCP für das Reverse Engineering von Binärdateien, Anwendungen und Laufzeitverhalten.

**Eine Funktion gefällt dir? Verstehe, wie sie funktioniert – bis hinunter auf die Binärebene.**

[![GitHub stars](https://img.shields.io/github/stars/morluto/rea?style=flat-square&logo=github)](https://github.com/morluto/rea/stargazers)
[![Monthly npm downloads](https://img.shields.io/npm/dm/rea-agents?style=flat-square&label=npm%20downloads)](https://www.npmjs.com/package/rea-agents)
[![MIT license](https://img.shields.io/badge/license-MIT-f4c430?style=flat-square)](../../LICENSE)
[![Join the REA Discord](https://img.shields.io/badge/Discord-5865F2?style=flat-square&logo=discord&logoColor=white)](https://discord.gg/GkcryMnJDM)
[![Follow REA on X](https://img.shields.io/badge/X-000000?style=flat-square&logo=x&logoColor=white)](https://x.com/reatools)
[![Supported platforms: macOS, Windows, and Linux](https://img.shields.io/badge/macOS%20%7C%20Windows%20%7C%20Linux-4493F8?style=flat-square)](../getting-started/installation.md)
[![skills.sh](https://skills.sh/b/morluto/rea?style=flat-square)](https://skills.sh/morluto/rea/reverse-engineer-anything)

**[Website](https://rea.tools/de/) · [Anleitungen](https://rea.tools/de/guides/) · [Fallstudien](https://rea.tools/de/showcase/)**

<a href="https://discord.com/invite/GkcryMnJDM"><img alt="Der REA-Community auf Discord beitreten" src="https://img.shields.io/badge/Join%20us%20on%20Discord-5865F2?style=for-the-badge&logo=discord&logoColor=white" height="40"></a>

[Schnellstart](#schnellstart) · [Fallstudien](#fallstudien) · [So funktioniert REA](#so-funktioniert-rea) · [Was du analysieren kannst](#was-du-analysieren-kannst) · [RL-Umgebungen erstellen](#build-rl-environments) · [Häufige Fragen](#häufige-fragen) · [Dokumentation](#dokumentation)

<code>npx rea-agents setup</code>

</div>

> [!IMPORTANT]
> Offizielle Quellen für REA: [morluto/rea](https://github.com/morluto/rea), [rea.tools](https://rea.tools/), [rea-agents](https://www.npmjs.com/package/rea-agents) (npm).
> Folge den Installations- und Release-Links aus diesen offiziellen Quellen. Ein ähnlicher Repository-Name oder eine kopierte README belegt nicht, dass ein Download offiziell ist.

<div align="center">

<br />

<img src="../assets/rea-hopper-analysis.png" alt="REA startet seine Analysebrücke in Hopper und untersucht eine native Binärdatei" width="1200" />

<br /><br />

<table aria-label="REA-Community">
<tr>
<td align="center" width="360">
  <a href="https://discord.gg/GkcryMnJDM">
    <img src="../assets/discord.svg" height="42" alt="Discord" /><br />
    <strong>Der Reverse-Engineering-Community beitreten</strong>
  </a><br />
  <sub>Discord · Fragen und Antworten · Ergebnisse teilen</sub>
</td>
</tr>
</table>

<br />

</div>

---

Du hast in einer App eine Funktion entdeckt, die du in dein eigenes Produkt übernehmen möchtest? Lass deinen Agenten sie mit REA untersuchen. Er kann die App ohne ihren Quellcode analysieren, die Funktionsweise erklären, Belege zeigen und eine passende Umsetzung für dein Projekt entwickeln.

REA verbindet deinen Agenten mit Werkzeugen zum Untersuchen nativer Binärdateien, von JavaScript- und Electron-Apps, .NET-Assemblies und Websites. Dieselben Werkzeuge kannst du auch im Terminal nutzen. Die Analyse läuft lokal; die Ergebnisse enthalten die Belege und Einschränkungen hinter jeder Schlussfolgerung.

Die Einrichtung registriert REA bei deinem Agenten und installiert passende Workflow-Anweisungen. Native Analysen nutzen eine vorhandene Installation von Hopper, Ghidra, IDA oder Kuna; nach Zustimmung kann die Einrichtung Hopper installieren. Statische JavaScript-Analysen benötigen keine native Analyse-Engine.

## Schnellstart

**[Schnellstart · rea.tools](https://rea.tools/de/get-started/)**

### Deinen Agenten einrichten (MCP)

Führe diesen Befehl mit installiertem [Node.js und npm](../reference/supported-targets.md) in einem vertrauenswürdigen Verzeichnis außerhalb des zu analysierenden Projekts aus.

```bash
npx rea-agents setup
```

Wähle deine Agenten aus, prüfe die geplanten Änderungen und bestätige sie. Die Einrichtung fügt den MCP-Server von REA und passende Workflow-Anweisungen hinzu und sichert vorhandene Konfigurationen. Starte deinen Agenten anschließend neu.

[Installation und Einrichtung](../getting-started/installation.md)

Deinen Agenten fragen:

```text
Untersuche, wie die Suche in der Notes-App funktioniert, zeige mir die Belege und entwickle eine ähnliche Funktion für mein Projekt.
```

Ersetze Notes durch deine Ziel-App und benenne die Funktion, die du verstehen möchtest.

### Das Terminal verwenden (CLI)

Untersuche ein entpacktes JavaScript-/Electron-App-Verzeichnis oder eine ASAR-Datei:

```bash
npx -y rea-agents@latest analyze-javascript-application /absolute/path/to/app --json
```

Das Ergebnis enthält Module, Imports, Electron-Grenzen und die zugehörigen Belege. Ersetze den Pfad durch dein Ziel, beispielsweise `"D:/apps/example"` unter Windows.

Für die regelmäßige Nutzung kannst du den Befehl `rea` installieren:

```bash
npm install --global rea-agents
rea --help
```

Konfiguriere für native Analysen zuerst einen Provider. Native Befehle, Provider-Auswahl, Snapshots und Skriptnutzung beschreibt der [CLI- und Evidence-Leitfaden](../getting-started/cli.md).

[Voraussetzungen unter Linux](../getting-started/installation.md#linux-owned-process-prerequisite)

### REA aktualisieren

Für eine über `npm install --global` / `bun add --global` installierte CLI:

```bash
rea update
```

Wenn du `npx` verwendest, aktualisiere die Agenteneinrichtung mit:

```bash
npx rea-agents@latest setup
```

[Aktualisieren und deinstallieren](../getting-started/installation.md#diagnose-update-and-remove)

## Fallstudien

<a href="https://rea.tools/de/showcase/">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../assets/rea-showcases-dark.svg" />
    <img alt="Illustrationen der Fallstudien zu DX-Balls Klangbalance, Notions Zwischenablage-Brücke und TH04s Geschossring" src="../assets/rea-showcases.svg" />
  </picture>
</a>

<table>
<tbody>
<tr><td>
<h3>DX-Ball: Eine Stereo-Panning-Berechnung rekonstruieren</h3>
<p>Verfolge einen Sound-Aufruf zur Hilfsfunktion, die Positionen in Panning-Werte umrechnet, untersuche die Anweisungen und überführe unvollständigen Pseudocode in C. Die Rekonstruktion besteht 3.205 Tests mit dem ursprünglichen x86-Code und reproduziert alle 63 Bytes der kompilierten Funktion.</p>
<p><a href="https://rea.tools/de/showcase/dx-ball/">Fallstudie lesen</a> · <a href="https://github.com/N0zoM1z0/dx-ball">Rekonstruktionsrepository</a></p>
</td></tr>
<tr><td>
<h3>Notion: Die Electron-Zwischenablagebrücke verfolgen</h3>
<p>Finde die Zwischenablage-API des Renderers, verfolge sie über preload und IPC bis zum Hauptprozess und untersuche das Zwischenablageformat samt Formatierungsdaten.</p>
<p><a href="https://rea.tools/de/showcase/notion/">Fallstudie lesen</a></p>
</td></tr>
<tr><td>
<h3>TH04: Eine DOS-Geschossring-Berechnung wiederherstellen</h3>
<p>Untersuche die 16-Bit-Anweisungen des ursprünglichen PC-98-Spiels, rekonstruiere die festen und zielgerichteten Winkelberechnungen und vergleiche das rekonstruierte C++ mit der Ausgabe des damaligen Compilers.</p>
<p><a href="https://rea.tools/de/showcase/th04/">Fallstudie lesen</a> · <a href="https://github.com/N0zoM1z0/th04">Rekonstruktionsrepository</a></p>
</td></tr>
</tbody>
</table>

Wenn du mit REA etwas Interessantes untersucht hast, würden wir es gern sehen. Teile deine Fallstudie in einem [Issue](https://github.com/morluto/rea/issues) oder [Pull Request](https://github.com/morluto/rea/pulls) und beschreibe das Ziel, deine Frage, wie REA geholfen hat und was du herausgefunden hast.

## So funktioniert REA

Dein Agent ruft REA über MCP auf, um das Ziel zu untersuchen und relevanten Code zu verfolgen. REA liefert Ergebnisse mit ihren Belegen zurück. Der Agent nutzt sie für weitere Fragen, Erklärungen oder zum Schreiben und Testen einer Implementierung. CLI-Befehle verwenden dieselben Workflows.

![REA-Untersuchungsablauf: Dein Agent fragt nach einem lokalen Ziel, REA untersucht und verfolgt es mit Analysewerkzeugen, und der Agent nutzt den zurückgegebenen Code, Verweise und offene Fragen zum Erklären, Implementieren und Testen.](../../website/public/assets/figures/rea-investigation-flow.svg)

[Abbildung in voller Größe öffnen](../../website/public/assets/figures/rea-investigation-flow.svg).

<a id="current-status"></a>

## Was du analysieren kannst

Native Binärdateien · JavaScript / Electron · Websites · .NET-Assemblies · Android-APKs · Firmware · Prozessverhalten

[Unterstützte Formate und Voraussetzungen](../reference/supported-targets.md)

<a id="choosing-a-deep-analysis-provider"></a>

[Analyseanbieter auswählen](../reference/supported-targets.md#choosing-a-deep-analysis-provider)

<a id="build-rl-environments"></a>

## RL-Umgebungen erstellen

Aus einer aufgezeichneten Websitzung oder einer Linux-Desktop-App kannst du eine lokale Umgebung erstellen, in der ein Agent eine Aufgabe übt und das Ergebnis prüft.

[RL-Umgebungen erstellen](https://rea.tools/guides/rl-environments/)

## Häufige Fragen

<details>
<summary><strong>Welche Agenten können REA verwenden?</strong></summary>

Jeder Agent, der lokale MCP-Server unterstützt. Die Einrichtung konfiguriert die [unterstützten Agenten](../getting-started/installation.md#supported-agents); andere Clients können die [manuelle MCP-Registrierung](../getting-started/installation.md#mcp-registry) nutzen.

</details>

<details>
<summary><strong>Brauche ich Hopper, Ghidra, IDA oder Kuna?</strong></summary>

Für tiefgehende native Analysen wird eines dieser Programme verwendet. Statische JavaScript- und .NET-Untersuchungen funktionieren ohne native Analyse-Engine. Die Einrichtung kann Hopper nach Zustimmung installieren; Ghidra, IDA und Kuna nutzen deine vorhandenen Installationen. Siehe [Provider-Einrichtung](../getting-started/installation.md#hopper).

</details>

<details>
<summary><strong>Muss ich Hopper vorher starten?</strong></summary>

REA startet Hopper, wenn eine Operation es benötigt. Unter macOS kann beim ersten Start ein Dialog erscheinen, in dem du den Demomodus auswählst oder deine Lizenz aktivierst. Siehe [Hopper-Start und Fehlerbehebung](../getting-started/installation.md#launcher-paths-and-troubleshooting).

</details>

<details>
<summary><strong>Was bewirkt die Installation des Skills über skills.sh?</strong></summary>

Der Skill stellt Untersuchungsanweisungen für deinen Agenten bereit. Verwende `npx rea-agents setup`, um den MCP-Server von REA zu registrieren und passende Anweisungen zu installieren. Starte deinen Agenten anschließend neu. Siehe [Installation nur des Skills](../getting-started/installation.md#skill-only-installation).

</details>

<details>
<summary><strong>Welchen Code liefert REA zurück?</strong></summary>

Native Analysen liefern Pseudocode und Assemblercode. JavaScript-/Electron-Analysen rekonstruieren Module und ihre Beziehungen. Dein Agent nutzt diese Ergebnisse zum Schreiben und Testen einer Implementierung; die [Fallstudien](#fallstudien) zeigen konkrete Beispiele.

</details>

<details>
<summary><strong>Lädt REA meine App hoch?</strong></summary>

REA analysiert Ziele lokal. Dein Agent erhält die Werkzeugergebnisse; sein Modellanbieter hat eine eigene Datenrichtlinie.

</details>

<details>
<summary><strong>Was soll ich tun, wenn ich einen Fehler finde?</strong></summary>

Aktualisiere zuerst; eine neuere Version könnte den Fehler bereits behoben haben.

Für eine über npm installierte CLI:

```bash
rea update
```

Für die Agenteneinrichtung über `npx`:

```bash
npx rea-agents@latest setup
```

Wenn du einen Agenten verwendest, schließe die [Aktualisierung der Einrichtung](#rea-aktualisieren) ab und starte ihn neu. Wiederhole dieselbe Aufgabe. Besteht das Problem weiterhin, [öffne ein Issue](https://github.com/morluto/rea/issues) mit deiner REA-Version, dem Zieltyp, den Reproduktionsschritten und der Fehlerausgabe.

</details>

## Dokumentation

Beginne mit den [praxisnahen Anleitungen](https://rea.tools/de/guides/) auf der Website. Genaue Optionen, Voraussetzungen und Ergebniskontrakte findest du hier:

- [Installation und Einrichtung](../getting-started/installation.md): Agentenregistrierung, Provider-Konfiguration, Updates und Deinstallation.
- [Bereitschaft und Fehlerbehebung](../getting-started/installation.md#check-readiness-for-your-task): Diagnose eines bestimmten Agenten oder einer Analyse-Engine.
- [CLI und Evidence](../getting-started/cli.md): Befehle, Provider-Auswahl, Snapshots, Import/Export und Exit-Status.
- [MCP-Kontrakte](../reference/mcp-contracts.md) und [Agenten-Prompts](../getting-started/mcp-prompts.md): Werkzeugergebnisse, Sitzungen und geführte Untersuchungen.
- [Werkzeugkatalog](../reference/mcp-contracts.md#generated-catalog): Beim Build erzeugtes Inventar von Werkzeugen, Providern und CLI-Befehlen.

Melde Sicherheitslücken gemäß [SECURITY.md](../../SECURITY.md).

## Community und Support

- **Discord** — Stell Fragen und teile deine Untersuchungen mit über 50.000 Menschen, die mit Leidenschaft Software untersuchen und eigene Projekte entwickeln! [![Discord](https://img.shields.io/badge/Join%20Discord-5865F2?style=flat-square&logo=discord&logoColor=white)](https://discord.gg/GkcryMnJDM)
- **Twitter / X** — Folge [@reatools](https://x.com/reatools) für Neuigkeiten.
- **Feedback und Ideen** — Du wünschst dir eine Funktion oder Unterstützung für ein Dateiformat? Schreib uns auf [GitHub](https://github.com/morluto/rea/issues) oder [Discord](https://discord.gg/GkcryMnJDM).

## Sternverlauf

🎉 **400.000 GitHub-Sterne – vielen Dank!**

Danke an alle, die REA nutzen, Fehler melden, Funktionswünsche äußern, Builds testen und Fehlerbehebungen beitragen.

<a href="https://rea.tools/de/contributors/">
  <img src="../../website/public/contributors/avatars.png" alt="Mitwirkende an REA" />
</a>

<a href="https://www.star-history.com/?repos=morluto%2Frea&amp;type=date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=morluto/rea&amp;type=date&amp;theme=dark&amp;legend=top-left" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=morluto/rea&amp;type=date" />
    <img alt="GitHub-Sternverlauf von REA" src="https://api.star-history.com/chart?repos=morluto/rea&amp;type=date" />
  </picture>
</a>

## Mitwirken

Wir freuen uns über deine Hilfe bei REA! [Öffne ein Issue](https://github.com/morluto/rea/issues), um einen Fehler zu melden oder eine Funktion vorzuschlagen, oder [sende einen Pull Request](https://github.com/morluto/rea/pulls), um Code oder Dokumentation zu verbessern.

Die Entwicklungsumgebung und Prüfungen beschreibt [CONTRIBUTING.md](../../CONTRIBUTING.md), die Verifikationspfade der [Testleitfaden](../development/testing.md).

## Haftungsausschluss

Hinweise zur verantwortungsvollen Nutzung findest du in [DISCLAIMER.md](../../DISCLAIMER.md).

REA dient der rechtmäßigen Forschung, Bildung, Interoperabilität, Softwareerhaltung und Analyse von Software, die dir gehört oder die du mit entsprechender Genehmigung untersuchen darfst.

The project's position on illegal or unauthorized use covers all REA
versions, distribution channels, and platforms; each copy retains its
applicable licenses.

## Lizenz

[MIT](../../LICENSE)

REA-authored code is licensed under MIT. Third-party material retains its own
licenses and copyright notices; see [Third-party notices](../../THIRD_PARTY_NOTICES.md)
for the dependency inventory, preserved license texts, and external-tool terms.

**You must legally obtain and be authorized to use commercial tools**, including
IDA Pro / Hex-Rays decompilers, Hopper, and JEB, under their applicable licenses.
REA grants no tool license, key, or activation entitlement. Trials and demos
remain subject to vendor terms, including user, feature, automation, and output
sharing restrictions. Cracked copies, stolen keys, unauthorized key sharing,
and bypassing license restrictions are not authorized. This guidance does not
amend MIT or third-party licenses.
