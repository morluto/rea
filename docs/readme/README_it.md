<div align="center">

[English](../../README.md) · [简体中文](README_zh.md) · [繁體中文](README_zh-TW.md) · [日本語](README_ja.md) · [한국어](README_ko.md) · [Türkçe](README_tr.md) · [Русский](README_ru.md) · [Tiếng Việt](README_vi.md) · [ไทย](README_th.md) · [Deutsch](README_de.md) · [Español](README_es.md) · [Français](README_fr.md) · [Українська](README_uk.md) · [Polski](README_pl.md) · [Português (Brasil)](README_pt-BR.md) · [العربية](README_ar.md) · [فارسی](README_fa.md) · [Bahasa Indonesia](README_id.md) · **Italiano**
· [Ελληνικά](README_el.md) · [മലയാളം](README_ml.md) · [Roman Urdu](README_ur-Latn.md) · [Română](README_ro.md) · [Български](README_bg.md) · [বাংলা](README_bn.md)

# REA: Reverse Engineer Anything

### Un unico MCP per l'ingegneria inversa su binari, applicazioni e comportamento a runtime.

**Vedi una funzionalità che ti piace. Capisci come funziona, fino al livello binario.**

[![GitHub stars](https://img.shields.io/github/stars/morluto/rea?style=flat-square&logo=github)](https://github.com/morluto/rea/stargazers)
[![Monthly npm downloads](https://img.shields.io/npm/dm/rea-agents?style=flat-square&label=npm%20downloads)](https://www.npmjs.com/package/rea-agents)
[![MIT license](https://img.shields.io/badge/license-MIT-f4c430?style=flat-square)](../../LICENSE)
[![Join the REA Discord](https://img.shields.io/badge/Discord-5865F2?style=flat-square&logo=discord&logoColor=white)](https://discord.gg/GkcryMnJDM)
[![Follow REA on X](https://img.shields.io/badge/X-000000?style=flat-square&logo=x&logoColor=white)](https://x.com/reatools)
[![Supported platforms: macOS, Windows, and Linux](https://img.shields.io/badge/macOS%20%7C%20Windows%20%7C%20Linux-4493F8?style=flat-square)](../getting-started/installation.md)
[![skills.sh](https://skills.sh/b/morluto/rea?style=flat-square)](https://skills.sh/morluto/rea/reverse-engineer-anything)

**[Sito web](https://rea.tools/it/) · [Guide](https://rea.tools/it/guides/) · [Showcase](https://rea.tools/it/showcase/)**

<a href="https://discord.com/invite/GkcryMnJDM"><img alt="Unisciti alla community REA su Discord" src="https://img.shields.io/badge/Join%20us%20on%20Discord-5865F2?style=for-the-badge&logo=discord&logoColor=white" height="40"></a>

[Avvio rapido](#avvio-rapido) · [Showcase](#showcase) · [Come funziona REA](#come-funziona-rea) · [Cosa puoi analizzare](#cosa-puoi-analizzare) · [Creare ambienti RL](#build-rl-environments) · [FAQ](#faq) · [Documentazione](#documentazione)

<code>npx rea-agents setup</code>

</div>

> [!IMPORTANT]
> Fonti ufficiali di REA: [morluto/rea](https://github.com/morluto/rea), [rea.tools](https://rea.tools/), [rea-agents](https://www.npmjs.com/package/rea-agents) (npm).
> Segui i link di installazione e delle versioni pubblicate da queste fonti ufficiali. Un nome di repository simile o un README copiato non dimostra che un download sia ufficiale.

<div align="center">

<br />

<img src="../assets/rea-hopper-analysis.png" alt="REA che avvia il suo bridge di analisi dentro Hopper mentre ispeziona un binario nativo" width="1200" />

<br /><br />

<table aria-label="Community REA">
<tr>
<td align="center" width="360">
  <a href="https://discord.gg/GkcryMnJDM">
    <img src="../assets/discord.svg" height="42" alt="Discord" /><br />
    <strong>Unisciti alla community di ingegneria inversa</strong>
  </a><br />
  <sub>Discord · Domande e risposte · Show and Tell</sub>
</td>
</tr>
</table>

<br />

</div>

---

Hai visto una funzionalità in un'app che vorresti nel tuo prodotto? Chiedi al tuo agente di analizzarla con REA. Può ispezionare l'app senza il suo codice sorgente, spiegare come funziona la funzionalità, mostrare le prove e realizzare una versione per il tuo progetto.

REA collega il tuo agente a strumenti per ispezionare binari nativi, app JavaScript ed Electron, assembly .NET e siti web. Puoi usare gli stessi strumenti anche dal terminale. L'analisi viene eseguita localmente e i risultati includono le prove e i limiti dietro ogni conclusione.

La configurazione registra REA con il tuo agente e installa le istruzioni di workflow corrispondenti. L'analisi nativa può usare un'installazione esistente di Hopper, Ghidra, IDA o Kuna; la configurazione può installare opzionalmente Hopper previa approvazione. L'analisi statica JavaScript non richiede alcun motore di analisi nativo.

## Avvio rapido

**[Avvio rapido · rea.tools](https://rea.tools/it/get-started/)**

### Configura il tuo agente (MCP)

Dopo aver installato [Node.js e npm](../reference/supported-targets.md), esegui questo comando da una directory attendibile esterna al progetto da analizzare.

```bash
npx rea-agents setup
```

Scegli i tuoi agenti, rivedi le modifiche proposte e approvale. La configurazione aggiunge il server MCP di REA e le istruzioni di workflow corrispondenti, con backup della configurazione esistente. Riavvia quindi il tuo agente.

[installazione e configurazione](../getting-started/installation.md)

Chiedi al tuo agente:

```text
Spiega come funziona la ricerca nell'app Note, mostrami le prove e realizza
una funzionalità simile per il mio progetto.
```

Sostituisci Note con la tua app di destinazione e la funzionalità che vuoi capire.

### Usa il terminale (CLI)

Ispeziona una directory di app JavaScript/Electron estratta o un ASAR:

```bash
npx -y rea-agents@latest analyze-javascript-application /absolute/path/to/app --json
```

Il risultato include moduli, import, confini Electron e le relative prove. Sostituisci il percorso con il tuo bersaglio, ad esempio `"D:/apps/example"` su Windows.

Per installare il comando `rea` per un uso regolare:

```bash
npm install --global rea-agents
rea --help
```

Per l'analisi nativa, configura prima un provider. Vedi la [guida CLI ed Evidence](../getting-started/cli.md) per i comandi nativi, la selezione del provider, gli snapshot e lo scripting.

[Requisiti per Linux](../getting-started/installation.md#linux-owned-process-prerequisite)

### Aggiorna REA

Per una CLI installata con `npm install --global` o `bun add --global`:

```bash
rea update
```

Se usi `npx`, aggiorna la configurazione del tuo agente con:

```bash
npx rea-agents@latest setup
```

[Aggiornamento e disinstallazione](../getting-started/installation.md#diagnose-update-and-remove)

## Showcase

<a href="https://rea.tools/it/showcase/">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../assets/rea-showcases-dark.svg" />
    <img alt="Illustrazioni degli showcase del sound-pan di DX-Ball, del clipboard-bridge di Notion e dell'anello di proiettili di TH04" src="../assets/rea-showcases.svg" />
  </picture>
</a>

<table>
<tbody>
<tr><td>
<h3>DX-Ball: ricostruisci un calcolo sound-pan</h3>
<p>Segui una chiamata sonora fino al suo helper posizione-to-pan, ispeziona le istruzioni e trasforma il pseudocodice incompleto in C. La ricostruzione supera 3.205 casi x86 originali e riproduce tutti i 63 byte di funzione compilati.</p>
<p><a href="https://rea.tools/it/showcase/dx-ball/">Leggi il case study</a> · <a href="https://github.com/N0zoM1z0/dx-ball">Repository di ricostruzione</a></p>
</td></tr>
<tr><td>
<h3>Notion: traccia il clipboard bridge di Electron</h3>
<p>Trova l'API clipboard del renderer, seguila attraverso preload e IPC fino al processo principale e ispeziona il formato rich clipboard.</p>
<p><a href="https://rea.tools/it/showcase/notion/">Leggi il case study</a></p>
</td></tr>
<tr><td>
<h3>TH04: recupera un calcolo dell'anello di proiettili DOS</h3>
<p>Ispeziona le istruzioni a 16 bit del gioco PC-98 originale, recupera i calcoli dell'angolo fisso e mirato e confronta il C++ ricostruito con l'output del compilatore storico.</p>
<p><a href="https://rea.tools/it/showcase/th04/">Leggi il case study</a> · <a href="https://github.com/N0zoM1z0/th04">Repository di ricostruzione</a></p>
</td></tr>
</tbody>
</table>

Se hai usato REA su qualcosa di interessante, ci piacerebbe vederlo. Condividi il tuo caso in una [issue](https://github.com/morluto/rea/issues) o in una [pull request](https://github.com/morluto/rea/pulls), includendo il bersaglio, la tua domanda, come REA ti ha aiutato e cosa hai scoperto.

## Come funziona REA

Il tuo agente chiama REA tramite MCP per ispezionare il bersaglio e tracciare il codice rilevante. REA restituisce i risultati con le relative prove. L'agente li usa per fare domande di approfondimento, spiegare il comportamento o scrivere e testare un'implementazione. Anche i comandi CLI usano gli stessi workflow.

![Flusso di indagine REA: il tuo agente pone domande su un bersaglio locale, REA lo ispeziona e ne traccia il codice usando strumenti di analisi, e l'agente usa il codice, i riferimenti e gli elementi sconosciuti restituiti per spiegare, implementare e testare.](../../website/public/assets/figures/rea-investigation-flow.svg)

[Apri la figura a dimensione intera](../../website/public/assets/figures/rea-investigation-flow.svg).

<a id="current-status"></a>

## Cosa puoi analizzare

Binari nativi · JavaScript / Electron · Siti web · Assembly .NET · APK Android · Firmware · Comportamento dei processi

[Formati supportati e requisiti](../reference/supported-targets.md)

<a id="choosing-a-deep-analysis-provider"></a>

[Scegliere un motore di analisi](../reference/supported-targets.md#choosing-a-deep-analysis-provider)

<a id="build-rl-environments"></a>

## Creare ambienti RL

Crea un ambiente locale da una sessione web registrata o da un’app desktop Linux per consentire a un agente di esercitarsi e verificare il risultato.

[Creare ambienti RL](https://rea.tools/guides/rl-environments/)

## FAQ

<details>
<summary><strong>Quali agenti possono usare REA?</strong></summary>

Qualsiasi agente che supporti server MCP locali. La configurazione configura gli [agenti supportati](../getting-started/installation.md#supported-agents); altri client possono usare la [registrazione MCP manuale](../getting-started/installation.md#mcp-registry).

</details>

<details>
<summary><strong>Ho bisogno di Hopper, Ghidra, IDA o Kuna?</strong></summary>

L'analisi nativa profonda ne usa uno. L'ispezione statica di JavaScript e .NET funziona senza un motore di analisi nativo. La configurazione può installare Hopper previa approvazione; Ghidra, IDA e Kuna usano le tue installazioni esistenti. Vedi [configurazione provider](../getting-started/installation.md#hopper).

</details>

<details>
<summary><strong>Devo avviare Hopper per primo?</strong></summary>

REA avvia Hopper quando un'operazione ne ha bisogno. Su macOS, una finestra di dialogo al primo avvio potrebbe chiederti di scegliere la modalità demo o di attivare la licenza. Vedi [avvio di Hopper e risoluzione dei problemi](../getting-started/installation.md#launcher-paths-and-troubleshooting).

</details>

<details>
<summary><strong>Cosa fa l'installazione dello skill da skills.sh?</strong></summary>

Lo skill fornisce istruzioni di indagine per il tuo agente. Usa `npx rea-agents setup` per registrare il server MCP di REA e installare le istruzioni corrispondenti, quindi riavvia il tuo agente. Vedi [installazione solo skill](../getting-started/installation.md#skill-only-installation).

</details>

<details>
<summary><strong>Quale codice restituisce REA?</strong></summary>

L'analisi nativa restituisce pseudocodice e assembly. L'analisi JavaScript/Electron recupera moduli e le loro relazioni. Il tuo agente usa questi risultati per scrivere e testare un'implementazione; gli [showcase](#showcase) offrono esempi concreti.

</details>

<details>
<summary><strong>REA carica la mia app da qualche parte?</strong></summary>

REA analizza i bersagli localmente. Il tuo agente riceve i risultati degli strumenti e il suo provider di modello ha la propria politica sui dati.

</details>

<details>
<summary><strong>Cosa devo fare se trovo un bug?</strong></summary>

Aggiorna prima; una release recente potrebbe averlo già risolto.

Per una CLI installata con `npm install --global` o `bun add --global`:

```bash
rea update
```

Per la configurazione dell'agente tramite `npx`:

```bash
npx rea-agents@latest setup
```

Se stai usando un agente, completa l'[aggiornamento della configurazione](#aggiorna-rea) e riavvialo. Riprova lo stesso task. Se il problema persiste, [apri un issue](https://github.com/morluto/rea/issues) con la tua versione di REA, il tipo di bersaglio, i passaggi per riprodurlo e l'output di errore.

</details>

## Documentazione

Inizia dalle [guide pratiche](https://rea.tools/it/guides/) del sito web. Per opzioni esatte, prerequisiti e contratti dei risultati:

- [Installazione e configurazione](../getting-started/installation.md): registrazione agente, configurazione provider, aggiornamenti e disinstallazione.
- [Pronto all'uso e risoluzione dei problemi](../getting-started/installation.md#check-readiness-for-your-task): diagnostica un agente o un motore di analisi.
- [CLI ed Evidence](../getting-started/cli.md): comandi, selezione provider, snapshot, import/export e stati di uscita.
- [Contratti MCP](../reference/mcp-contracts.md) e [prompt agente](../getting-started/mcp-prompts.md): risultati degli strumenti, sessioni e indagini guidate.
- [Catalogo strumenti](../reference/mcp-contracts.md#generated-catalog): inventario generato di strumenti, provider e comandi CLI.

Segnala vulnerabilità tramite [SECURITY.md](../../SECURITY.md).

## Community e assistenza

- **Discord** — Fai domande e condividi le tue ricerche con oltre 50.000 persone che amano il reverse engineering e la creazione di nuovi progetti! [![Discord](https://img.shields.io/badge/Join%20Discord-5865F2?style=flat-square&logo=discord&logoColor=white)](https://discord.gg/GkcryMnJDM)
- **Twitter / X** — Segui [@reatools](https://x.com/reatools) per le novità.
- **Idee e suggerimenti** — Vorresti una funzione o il supporto per un formato? Scrivici su [GitHub](https://github.com/morluto/rea/issues) o [Discord](https://discord.gg/GkcryMnJDM).

## Cronologia delle stelle

🎉 **400.000 stelle su GitHub — grazie!**

Grazie a tutti coloro che usano REA, segnalano bug, propongono funzionalità, testano le build e contribuiscono con correzioni.

<a href="https://rea.tools/it/contributors/">
  <img src="../../website/public/contributors/avatars.png" alt="Chi contribuisce a REA" />
</a>

<a href="https://www.star-history.com/?repos=morluto%2Frea&amp;type=date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=morluto/rea&amp;type=date&amp;theme=dark&amp;legend=top-left" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=morluto/rea&amp;type=date" />
    <img alt="Cronologia stelle GitHub di REA" src="https://api.star-history.com/chart?repos=morluto/rea&amp;type=date" />
  </picture>
</a>

## Contributing

Apprezzeremmo il tuo aiuto con REA! [Apri un issue](https://github.com/morluto/rea/issues) per segnalare un bug o suggerire una funzionalità, oppure [invia una pull request](https://github.com/morluto/rea/pulls) per migliorare il codice o la documentazione.

Vedi [CONTRIBUTING.md](../../CONTRIBUTING.md) per la configurazione di sviluppo e i controlli, [testing](../development/testing.md) per le lane di verifica.

## Disclaimer

Consulta [DISCLAIMER.md](../../DISCLAIMER.md) per le indicazioni sull'uso responsabile.

REA è destinato alla ricerca, alla formazione, all’interoperabilità, alla conservazione del software e all’analisi di software di tua proprietà o che sei autorizzato a esaminare, nel rispetto della legge.

The project's position on illegal or unauthorized use covers all REA
versions, distribution channels, and platforms; each copy retains its
applicable licenses.

## License

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
