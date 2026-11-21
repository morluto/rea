<div align="center">

[English](../../README.md) · [简体中文](README_zh.md) · [繁體中文](README_zh-TW.md) · [日本語](README_ja.md) · [한국어](README_ko.md) · [Türkçe](README_tr.md) · [Русский](README_ru.md) · [Tiếng Việt](README_vi.md) · [ไทย](README_th.md) · [Deutsch](README_de.md) · [Español](README_es.md) · [Français](README_fr.md) · [Українська](README_uk.md) · **Polski** · [Português (Brasil)](README_pt-BR.md) · [العربية](README_ar.md) · [فارسی](README_fa.md) · [Bahasa Indonesia](README_id.md) · [Italiano](README_it.md)
· [Ελληνικά](README_el.md) · [മലയാളം](README_ml.md) · [Roman Urdu](README_ur-Latn.md) · [Română](README_ro.md) · [Български](README_bg.md)

# REA: Reverse Engineer Anything

### Jeden serwer MCP do inżynierii wstecznej plików binarnych, aplikacji i zachowania w czasie wykonywania.

**Widzisz funkcję, która Ci się podoba? Dowiedz się, jak działa, aż do poziomu kodu binarnego.**

[![GitHub stars](https://img.shields.io/github/stars/morluto/rea?style=flat-square&logo=github)](https://github.com/morluto/rea/stargazers)
[![Monthly npm downloads](https://img.shields.io/npm/dm/rea-agents?style=flat-square&label=npm%20downloads)](https://www.npmjs.com/package/rea-agents)
[![MIT license](https://img.shields.io/badge/license-MIT-f4c430?style=flat-square)](../../LICENSE)
[![Join the REA Discord](https://img.shields.io/badge/Discord-5865F2?style=flat-square&logo=discord&logoColor=white)](https://discord.gg/GkcryMnJDM)
[![Follow REA on X](https://img.shields.io/badge/X-000000?style=flat-square&logo=x&logoColor=white)](https://x.com/reatools)
[![Supported platforms: macOS, Windows, and Linux](https://img.shields.io/badge/macOS%20%7C%20Windows%20%7C%20Linux-4493F8?style=flat-square)](../getting-started/installation.md)
[![skills.sh](https://skills.sh/b/morluto/rea?style=flat-square)](https://skills.sh/morluto/rea/reverse-engineer-anything)

**[Strona internetowa](https://rea.tools/pl/) · [Przewodniki](https://rea.tools/pl/guides/) · [Przykłady zastosowań](https://rea.tools/pl/showcase/)**

<a href="https://discord.com/invite/GkcryMnJDM"><img alt="Dołącz do społeczności REA na Discordzie" src="https://img.shields.io/badge/Join%20us%20on%20Discord-5865F2?style=for-the-badge&logo=discord&logoColor=white" height="40"></a>

[Szybki start](#szybki-start) · [Przykłady zastosowań](#przykłady-zastosowań) · [Jak działa REA](#jak-działa-rea) · [Co możesz analizować](#co-możesz-analizować) · [Tworzenie środowisk RL](#build-rl-environments) · [FAQ](#faq) · [Dokumentacja](#dokumentacja)

<code>npx rea-agents setup</code>

</div>

> [!IMPORTANT]
> Oficjalne źródła REA: [morluto/rea](https://github.com/morluto/rea), [rea.tools](https://rea.tools/), [rea-agents](https://www.npmjs.com/package/rea-agents) (npm).
> Korzystaj z odnośników do instalacji i wydań w tych oficjalnych źródłach. Podobna nazwa repozytorium lub skopiowany README nie potwierdzają, że pobierany plik jest oficjalny.

<div align="center">

<br />

<img src="../assets/rea-hopper-analysis.png" alt="REA uruchamia most analityczny w Hopperze podczas analizy natywnego pliku binarnego" width="1200" />

<br /><br />

<table aria-label="Społeczność REA">
<tr>
<td align="center" width="360">
  <a href="https://discord.gg/GkcryMnJDM">
    <img src="../assets/discord.svg" height="42" alt="Discord" /><br />
    <strong>Dołącz do społeczności inżynierii wstecznej</strong>
  </a><br />
  <sub>Discord · Pytania i odpowiedzi · Pokaż swój projekt</sub>
</td>
</tr>
</table>

<br />

</div>

---

Widzisz w aplikacji funkcję, którą chcesz mieć we własnym produkcie? Poproś swojego agenta, aby zbadał ją za pomocą REA. Może przeanalizować aplikację bez jej kodu źródłowego, wyjaśnić działanie funkcji, pokazać dowody i stworzyć jej wersję dla Twojego projektu.

REA łączy Twojego agenta z narzędziami do analizy natywnych plików binarnych, aplikacji JavaScript i Electron, zestawów .NET oraz stron internetowych. Z tych samych narzędzi możesz korzystać w terminalu. Analiza odbywa się lokalnie, a wyniki zawierają dowody i ograniczenia stojące za każdym wnioskiem.

Konfigurator rejestruje REA w Twoim agencie i instaluje pasujące instrukcje pracy. Analiza kodu natywnego może korzystać z istniejącej instalacji Hoppera, Ghidry, IDA lub Kuna; konfigurator może też zainstalować Hoppera po uzyskaniu zgody. Statyczna analiza JavaScript nie wymaga żadnego z tych silników.

## Szybki start

**[Szybki start · rea.tools](https://rea.tools/pl/get-started/)**

### Skonfiguruj agenta (MCP)

Po zainstalowaniu [Node.js i npm](../reference/supported-targets.md) uruchom polecenie w zaufanym katalogu poza analizowanym projektem.

```bash
npx rea-agents setup
```

Wybierz swoich agentów, sprawdź proponowane zmiany i zatwierdź je. Konfigurator dodaje serwer MCP REA i pasujące instrukcje pracy, tworząc kopie zapasowe istniejącej konfiguracji. Następnie uruchom agenta ponownie.

[instalacji i konfiguracji](../getting-started/installation.md)

Zapytaj agenta:

```text
Sprawdź, jak działa wyszukiwanie w aplikacji Notes, pokaż mi dowody i stwórz podobną funkcję dla mojego projektu.
```

Zastąp Notes wybraną aplikacją i wskaż funkcję, którą chcesz zrozumieć.

### Korzystaj z terminala (CLI)

Przeanalizuj rozpakowany katalog aplikacji JavaScript/Electron lub archiwum ASAR:

```bash
npx -y rea-agents@latest analyze-javascript-application /absolute/path/to/app --json
```

Wynik obejmuje moduły, importy, granice komponentów Electron oraz dowody. Zastąp ścieżkę ścieżką do swojego celu, na przykład `"D:/apps/example"` w systemie Windows.

Aby zainstalować polecenie `rea` do regularnego użytku:

```bash
npm install --global rea-agents
rea --help
```

Przed analizą kodu natywnego skonfiguruj dostawcę analizy. Polecenia analizy natywnej, wybór dostawcy, migawki i użycie w skryptach opisuje [przewodnik CLI i Evidence](../getting-started/cli.md).

[Wymagania dla systemu Linux](../getting-started/installation.md#linux-owned-process-prerequisite)

### Zaktualizuj REA

Dla CLI zainstalowanego przez `npm install --global` / `bun add --global`:

```bash
rea update
```

Jeśli używasz `npx`, zaktualizuj konfigurację agenta poleceniem:

```bash
npx rea-agents@latest setup
```

[Aktualizacja i odinstalowanie](../getting-started/installation.md#diagnose-update-and-remove)

## Przykłady zastosowań

<a href="https://rea.tools/pl/showcase/">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../assets/rea-showcases-dark.svg" />
    <img alt="Ilustracje studiów przypadku panoramowania dźwięku w DX-Ball, mostka schowka w Notion i pierścienia pocisków w TH04" src="../assets/rea-showcases.svg" />
  </picture>
</a>

<table>
<tbody>
<tr><td>
<h3>DX-Ball: odtworzenie obliczania panoramy dźwięku</h3>
<p>Prześledź wywołanie dźwięku do funkcji pomocniczej przeliczającej pozycję na panoramę, sprawdź instrukcje i przekształć niepełny pseudokod w C. Odtworzona implementacja przechodzi 3 205 przypadków dla oryginalnego x86 i odtwarza wszystkie 63 bajty skompilowanej funkcji.</p>
<p><a href="https://rea.tools/pl/showcase/dx-ball/">Przeczytaj studium przypadku</a> · <a href="https://github.com/N0zoM1z0/dx-ball">Repozytorium odtworzonej implementacji</a></p>
</td></tr>
<tr><td>
<h3>Notion: śledzenie mostu schowka w Electron</h3>
<p>Znajdź API schowka w procesie renderującym, prześledź je przez preload i IPC do procesu głównego, a następnie sprawdź format schowka wraz z danymi formatowania.</p>
<p><a href="https://rea.tools/pl/showcase/notion/">Przeczytaj studium przypadku</a></p>
</td></tr>
<tr><td>
<h3>TH04: odtworzenie obliczania pierścienia pocisków w DOS-ie</h3>
<p>Sprawdź 16-bitowe instrukcje oryginalnej gry na PC-98, odtwórz obliczenia kątów stałych i skierowanych na cel oraz porównaj odtworzony C++ z wynikiem historycznego kompilatora.</p>
<p><a href="https://rea.tools/pl/showcase/th04/">Przeczytaj studium przypadku</a> · <a href="https://github.com/N0zoM1z0/th04">Repozytorium odtworzonej implementacji</a></p>
</td></tr>
</tbody>
</table>

Jeśli użyłeś REA do czegoś ciekawego, chętnie to zobaczymy. Opisz swój przypadek w [zgłoszeniu](https://github.com/morluto/rea/issues) lub [pull requeście](https://github.com/morluto/rea/pulls), podając cel analizy, pytanie, sposób, w jaki REA pomogło, i swoje ustalenia.

## Jak działa REA

Twój agent wywołuje REA przez MCP, aby analizować cel i śledzić istotny kod. REA zwraca ustalenia wraz z dowodami. Agent wykorzystuje je do zadawania dalszych pytań, wyjaśniania zachowania lub pisania i testowania implementacji. Polecenia CLI korzystają z tych samych procedur.

![Przebieg badania z REA: agent pyta o lokalny cel, REA analizuje go i śledzi za pomocą narzędzi analitycznych, a agent korzysta ze zwróconego kodu, odwołań i niewiadomych, aby wyjaśnić działanie, stworzyć implementację i ją przetestować.](../../website/public/assets/figures/rea-investigation-flow.svg)

[Otwórz ilustrację w pełnym rozmiarze](../../website/public/assets/figures/rea-investigation-flow.svg).

<a id="current-status"></a>

## Co możesz analizować

Natywne pliki binarne · JavaScript / Electron · Strony internetowe · Zestawy .NET · Pakiety APK dla Androida · Oprogramowanie układowe · Zachowanie procesów

[Obsługiwane formaty i wymagania](../reference/supported-targets.md)

<a id="choosing-a-deep-analysis-provider"></a>

[Wybór dostawcy analizy](../reference/supported-targets.md#choosing-a-deep-analysis-provider)

<a id="build-rl-environments"></a>

## Tworzenie środowisk RL

Utwórz lokalne środowisko z nagranej sesji internetowej lub aplikacji na pulpit systemu Linux, aby agent mógł ćwiczyć zadanie i sprawdzać wynik.

[Tworzenie środowisk RL](https://rea.tools/guides/rl-environments/)

## FAQ

<details>
<summary><strong>Którzy agenci mogą korzystać z REA?</strong></summary>

Każdy agent obsługujący lokalne serwery MCP. Konfigurator konfiguruje [obsługiwanych agentów](../getting-started/installation.md#supported-agents); inne klienty mogą użyć [ręcznej rejestracji MCP](../getting-started/installation.md#mcp-registry).

</details>

<details>
<summary><strong>Czy potrzebuję Hoppera, Ghidry, IDA lub Kuna?</strong></summary>

Dogłębna analiza kodu natywnego używa jednego z nich. Statyczna analiza JavaScript i .NET działa bez silnika analizy natywnej. Konfigurator może zainstalować Hoppera po uzyskaniu zgody; Ghidra, IDA i Kuna korzystają z istniejących instalacji. Zobacz [konfigurację dostawców analizy](../getting-started/installation.md#hopper).

</details>

<details>
<summary><strong>Czy muszę najpierw uruchomić Hoppera?</strong></summary>

REA uruchamia Hoppera, gdy wymaga tego operacja. W systemie macOS przy pierwszym uruchomieniu okno dialogowe może poprosić o wybór trybu demonstracyjnego lub aktywację licencji. Zobacz [uruchamianie Hoppera i rozwiązywanie problemów](../getting-started/installation.md#launcher-paths-and-troubleshooting).

</details>

<details>
<summary><strong>Co daje zainstalowanie umiejętności z skills.sh?</strong></summary>

Umiejętność dostarcza agentowi instrukcje prowadzenia analizy. Użyj `npx rea-agents setup`, aby zarejestrować serwer MCP REA i zainstalować pasujące instrukcje, a następnie uruchom agenta ponownie. Zobacz [instalację samej umiejętności](../getting-started/installation.md#skill-only-installation).

</details>

<details>
<summary><strong>Jaki kod zwraca REA?</strong></summary>

Analiza kodu natywnego zwraca pseudokod i kod asemblera. Analiza JavaScript/Electron odzyskuje moduły i ich powiązania. Agent wykorzystuje te ustalenia do napisania i przetestowania implementacji; [przykłady zastosowań](#przykłady-zastosowań) pokazują ten proces w praktyce.

</details>

<details>
<summary><strong>Czy REA przesyła moją aplikację?</strong></summary>

REA analizuje cele lokalnie. Twój agent otrzymuje wyniki narzędzi, a dostawca jego modelu ma własną politykę dotyczącą danych.

</details>

<details>
<summary><strong>Co zrobić, gdy napotkam błąd?</strong></summary>

Najpierw zaktualizuj REA; najnowsze wydanie mogło już naprawić ten problem.

Dla CLI zainstalowanego przez npm:

```bash
rea update
```

Dla konfiguracji agenta przez `npx`:

```bash
npx rea-agents@latest setup
```

Jeśli używasz agenta, wykonaj [odświeżenie konfiguracji](#zaktualizuj-rea) i uruchom go ponownie. Ponów tę samą operację. Jeśli problem pozostaje, [otwórz zgłoszenie](https://github.com/morluto/rea/issues), podając wersję REA, typ celu analizy, kroki odtworzenia problemu i komunikaty błędu.

</details>

## Dokumentacja

Zacznij od [przewodników z przykładami](https://rea.tools/pl/guides/) na stronie internetowej. Dokładne opcje, wymagania wstępne i kontrakty wyników opisano tutaj:

- [Instalacja i konfiguracja](../getting-started/installation.md): rejestracja agentów, konfiguracja dostawców analizy, aktualizacje i odinstalowanie.
- [Gotowość i rozwiązywanie problemów](../getting-started/installation.md#check-readiness-for-your-task): diagnostyka jednego agenta lub silnika analizy.
- [CLI i Evidence](../getting-started/cli.md): polecenia, wybór dostawcy, migawki, import/eksport i kody zakończenia.
- [Kontrakty MCP](../reference/mcp-contracts.md) i [prompty dla agentów](../getting-started/mcp-prompts.md): wyniki narzędzi, sesje i prowadzone analizy.
- [Katalog narzędzi](../reference/mcp-contracts.md#generated-catalog): generowany podczas kompilacji wykaz narzędzi, dostawców i poleceń CLI.

Zgłaszaj podatności zgodnie z [SECURITY.md](../../SECURITY.md).

## Społeczność i pomoc

- **Discord** — Zadawaj pytania i dziel się wynikami badań z ponad 50 000 osób, które z pasją zajmują się inżynierią wsteczną i tworzą własne projekty! [![Discord](https://img.shields.io/badge/Join%20Discord-5865F2?style=flat-square&logo=discord&logoColor=white)](https://discord.gg/GkcryMnJDM)
- **Twitter / X** — Obserwuj [@reatools](https://x.com/reatools), aby śledzić aktualności.
- **Opinie i pomysły** — Brakuje Ci funkcji lub obsługi formatu pliku? Napisz do nas przez [GitHub](https://github.com/morluto/rea/issues) lub [Discord](https://discord.gg/GkcryMnJDM).

## Historia gwiazdek

🎉 **400 000 gwiazdek na GitHubie — dziękujemy!**

Dziękujemy wszystkim, którzy używają REA, zgłaszają błędy, proponują nowe funkcje, testują kompilacje i przesyłają poprawki.

<a href="https://rea.tools/pl/contributors/">
  <img src="https://contrib.rocks/image?repo=morluto/rea&amp;max=500&amp;columns=30" alt="Współtwórcy REA" />
</a>

<a href="https://www.star-history.com/?repos=morluto%2Frea&amp;type=date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=morluto/rea&amp;type=date&amp;theme=dark&amp;legend=top-left" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=morluto/rea&amp;type=date" />
    <img alt="Historia gwiazdek REA na GitHubie" src="https://api.star-history.com/chart?repos=morluto/rea&amp;type=date" />
  </picture>
</a>

## Współtworzenie

Chętnie przyjmiemy Twoją pomoc w rozwoju REA! [Otwórz zgłoszenie](https://github.com/morluto/rea/issues), aby poinformować o błędzie lub zaproponować funkcję, albo [wyślij pull request](https://github.com/morluto/rea/pulls) z ulepszeniami kodu lub dokumentacji.

Zobacz [CONTRIBUTING.md](../../CONTRIBUTING.md), aby poznać konfigurację środowiska programistycznego i kontrole, [testowanie](../development/testing.md), aby poznać ścieżki weryfikacji.

## Zastrzeżenie

Wskazówki dotyczące odpowiedzialnego korzystania znajdziesz w [DISCLAIMER.md](../../DISCLAIMER.md).

REA służy zgodnym z prawem badaniom, edukacji, zapewnianiu interoperacyjności, zachowaniu oprogramowania oraz analizie oprogramowania, które posiadasz lub masz prawo badać.

The project's position on illegal or unauthorized use covers all REA
versions, distribution channels, and platforms; each copy retains its
applicable licenses.

## Licencja

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
