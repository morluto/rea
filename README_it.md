<div align="center">

[English](README.md) · [简体中文](README_zh.md) · [繁體中文](README_zh-TW.md) · [日本語](README_ja.md) · [한국어](README_ko.md) · [Türkçe](README_tr.md) · [Русский](README_ru.md) · [Tiếng Việt](README_vi.md) · [ไทย](README_th.md) · [Deutsch](README_de.md) · [Español](README_es.md) · [Français](README_fr.md) · [Українська](README_uk.md) · [Polski](README_pl.md) · [Português (Brasil)](README_pt-BR.md) · [العربية](README_ar.md) · [فارسی](README_fa.md) · [Bahasa Indonesia](README_id.md) · **Italiano**

# REA: Reverse Engineer Anything

### Un unico MCP per l'ingegneria inversa su binari, applicazioni e comportamento a runtime.

**Vedi una funzionalità che ti piace. Capisci come funziona, fino al livello binario.**

[![npm version](https://img.shields.io/npm/v/rea-agents?style=flat-square&color=cb3837)](https://www.npmjs.com/package/rea-agents)
[![CI](https://img.shields.io/github/actions/workflow/status/morluto/rea/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/morluto/rea/actions/workflows/ci.yml)
[![MCP tool catalog](https://img.shields.io/badge/MCP-tool_catalog-5c4ee5?style=flat-square)](docs/mcp-contracts.md#generated-catalog)
[![Node.js requirements](https://img.shields.io/badge/Node.js-requirements-339933?style=flat-square&logo=nodedotjs&logoColor=white)](#cosa-puoi-analizzare)
[![skills.sh](https://skills.sh/b/morluto/rea?style=flat-square)](https://skills.sh/morluto/rea/reverse-engineer-anything)
[![MIT license](https://img.shields.io/badge/license-MIT-f4c430?style=flat-square)](LICENSE)
[![Discord](https://img.shields.io/discord/1556595354999332884?logo=discord&logoColor=white&label=Discord&color=5865F2)](https://discord.gg/GkcryMnJDM)

<a href="https://trendshift.io/repositories/82054?utm_source=repository-badge&amp;utm_medium=badge&amp;utm_campaign=badge-repository-82054" target="_blank" rel="noopener noreferrer"><img src="https://trendshift.io/api/badge/repositories/82054" alt="morluto%2Frea | Trendshift" width="250" height="55"/></a>

**[Sito web](https://rea.tools/) · [Guide](https://rea.tools/guides/) · [Showcase](https://rea.tools/showcase/)**

[Quick start](#quick-start) · [Come funziona REA](#come-funziona-rea) · [Cosa puoi analizzare](#cosa-puoi-analizzare) · [Showcase](#showcase) · [FAQ](#faq) · [Documentazione](#documentazione)

<code>npx rea-agents setup</code>

<br />

<img src="docs/assets/rea-hopper-analysis.png" alt="REA che avvia il suo bridge di analisi dentro Hopper mentre ispeziona un binario nativo" width="1200" />

<br /><br />

<table aria-label="Community REA">
<tr>
<td align="center" width="360">
  <a href="https://discord.gg/GkcryMnJDM">
    <img src="docs/assets/discord.svg" height="42" alt="Discord" /><br />
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

La configurazione registra REA con il tuo agente e installa le istruzioni di workflow corrispondenti. L'analisi nativa può usare un'installazione esistente di Hopper, Ghidra o IDA; la configurazione può installare opzionalmente Hopper previa approvazione. L'analisi statica JavaScript non richiede alcun motore di analisi nativo.

> **[Visita il sito web di REA](https://rea.tools/)** per istruzioni di configurazione, guide illustrate e veri casi studio.

## Quick start

### Configura il tuo agente

Con Node.js e npm installati, esegui:

```bash
npx rea-agents setup
```

Scegli i tuoi agenti, rivedi le modifiche proposte e approvale. La configurazione aggiunge il server MCP di REA e le istruzioni di workflow corrispondenti, con backup della configurazione esistente. Riavvia quindi il tuo agente.

La configurazione supporta Claude Code, Codex, Cursor, Gemini CLI, Grok Build e [altri agenti](docs/installation.md#supported-agents). Vedi [installazione e configurazione](docs/installation.md) per la configurazione dei provider e la registrazione manuale MCP.

### Chiedi al tuo agente

```text
Spiega come funziona la ricerca nell'app Note, mostrami le prove e realizza
una funzionalità simile per il mio progetto.
```

Sostituisci Note con la tua app di destinazione e la funzionalità che vuoi capire.

### Usa il terminale

Ispeziona una directory di app JavaScript/Electron estratta o un ASAR:

```bash
npx -y rea-agents@latest analyze-javascript-application /percorso/assoluto/verso/app --json
```

Il risultato include moduli, import, confini Electron e le relative prove. Sostituisci il percorso con il tuo bersaglio, ad esempio `"D:/apps/example"` su Windows.

Per installare il comando `rea` per un uso regolare:

```bash
npm install --global rea-agents
rea --help
```

Per l'analisi nativa, configura prima un provider. Vedi la [guida CLI ed Evidence](docs/cli.md) per i comandi nativi, la selezione del provider, gli snapshot e lo scripting.

### Aggiorna REA

REA cambia rapidamente e le nuove versioni includono correzioni di bug frequenti. Tieni aggiornata la tua installazione.

Per una CLI installata via npm:

```bash
rea update
```

Per aggiornare le registrazioni del tuo agente e lo skill, esegui il comando di configurazione mostrato dall'aggiornamento.

Se usi `npx`, aggiorna la configurazione del tuo agente con:

```bash
npx rea-agents@latest setup
```

Rivedi le modifiche di configurazione e riavvia il tuo agente. Per comandi CLI singoli, usa `npx rea-agents@latest` seguito dal comando.

## Come funziona REA

Il tuo agente chiama REA tramite MCP per ispezionare il bersaglio e tracciare il codice rilevante. REA restituisce i risultati con le relative prove. L'agente li usa per fare domande di approfondimento, spiegare il comportamento o scrivere e testare un'implementazione. Anche i comandi CLI usano gli stessi workflow.

![Flusso di indagine REA: il tuo agente pone domande su un bersaglio locale, REA lo ispeziona e ne traccia il codice usando strumenti di analisi, e l'agente usa il codice, i riferimenti e gli elementi sconosciuti restituiti per spiegare, implementare e testare.](website/public/assets/figures/rea-investigation-flow.svg)

[Apri la figura a dimensione intera](website/public/assets/figures/rea-investigation-flow.svg).

<a id="current-status"></a>

## Cosa puoi analizzare

REA richiede Node.js 22.x (>=22.19), 24.x (>=24.11) o 26+, oltre a npm. Strumenti aggiuntivi e supporto host dipendono dal bersaglio:

| Obiettivo                    | Cosa restituisce REA                                                                              | Requisiti e guida                                                                                                                   |
| ---------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Binari nativi                | Pseudocodice, assembly, stringhe, simboli, chiamate e riferimenti                                 | Hopper, Ghidra o IDA; [analisi nativa](https://rea.tools/guides/native/)                                                            |
| Layout ELF offline           | Sezioni, segmenti, simboli/relocazioni originali e candidati mitigazioni statiche                 | pwntools fornito dal chiamante su Linux x64; [diagnostica binaria](docs/binary-diagnostics.md)                                      |
| Bytecode EVM                 | Selettori di dispatch, offset dei byte, argomenti inferiti e mutabilità                           | Carrier raw/hex locale; [guida EVM offline](docs/evm-bytecode.md)                                                                   |
| Crash Linux registrati       | Note grezze, registri/segnai di ogni thread registrato e candidati mapping opzionali              | pwntools fornito dal chiamante; GDB/pwndbg opzionale; [crash registrati](docs/recorded-crashes.md)                                  |
| JavaScript / Electron        | Moduli, import, source map, route, IPC e relazioni con add-on nativi                              | Node.js e npm; [analisi delle applicazioni](https://rea.tools/guides/javascript/)                                                   |
| Siti web                     | Struttura della pagina, script, osservazioni di rete e screenshot richiesti                       | Un browser della famiglia Chrome; [analisi browser](https://rea.tools/guides/browser/)                                              |
| Acquisizioni di rete salvate | Richieste, risposte, payload esposti e posizioni sorgente                                         | HAR; mitmdump su Linux per acquisizioni mitmproxy native; [guida alle acquisizioni](docs/web-network-captures.md)                   |
| Assembly .NET                | Metadati, istruzioni CIL, dipendenze native dichiarate e confronti di build                       | Nessuno (solo statico); [guida managed-code](docs/managed-code-analysis.md)                                                         |
| APK Android                  | Dichiarazioni manifest, classi, metodi decompilati e riferimenti                                  | JADX headless e un JDK completo su Linux/macOS/Windows x64; [guida Android](docs/android-analysis.md)                               |
| Firmware                     | Regioni, risultati di estrazione e passaggi all'analisi nativa                                    | Binwalk / Unblob su Linux; [guida firmware](docs/firmware-analysis.md)                                                              |
| Pacchetti e risorse          | Inventari file, digest, plist, anatomia dei bundle Apple e risorse estratte                       | [Guida artifact e JavaScript](docs/javascript-artifact-reconstruction.md), [Applicazioni Apple](docs/apple-application-analysis.md) |
| Comportamento dei processi   | Output del terminale, interazioni, osservazioni su uscita e filesystem ed confronti di esecuzione | Linux/macOS con un PTY nativo; [cattura dei processi](docs/process-capture.md)                                                      |

L'ispezione statica di JavaScript e .NET legge i file forniti senza eseguire l'applicazione. La cattura a runtime esegue o interagisce con il bersaglio selezionato usando i tuoi permessi utente; ogni guida runtime descrive i suoi effetti.

<a id="choosing-a-deep-analysis-provider"></a>

I formati nativi e il supporto host variano in base al provider. Vedi la [configurazione di Hopper e Ghidra](docs/installation.md#hopper), la [guida IDA](docs/ida-provider.md) e il [supporto sperimentale Windows Ghidra](docs/windows-ghidra-p0.md). Ghidra supporta anche l'[analisi DOS a 16 bit](docs/ghidra-dos.md). Per binari di grandi dimensioni, aumenta il timeout di avvio con `REA_GHIDRA_STARTUP_TIMEOUT_MS`. Per la selezione del provider, vedi la [guida CLI](docs/cli.md#choose-a-provider). Controlla la [disponibilità delle release](docs/installation.md#released-package-and-main) per le funzionalità aggiunte dall'ultima release npm.

## Showcase

[![Illustrazioni degli showcase del sound-pan di DX-Ball, del clipboard-bridge di Notion e dell'anello di proiettili di TH04](docs/assets/rea-showcases.png)](https://rea.tools/showcase/)

### DX-Ball: ricostruisci un calcolo sound-pan

Segui una chiamata sonora fino al suo helper posizione-to-pan, ispeziona le istruzioni e trasforma il pseudocodice incompleto in C. La ricostruzione supera 3.205 casi x86 originali e riproduce tutti i 63 byte di funzione compilati.

[Leggi il case study](https://rea.tools/showcase/dx-ball/) · [Repository di ricostruzione](https://github.com/N0zoM1z0/dx-ball)

### Notion: traccia il clipboard bridge di Electron

Trova l'API clipboard del renderer, seguila attraverso preload e IPC fino al processo principale e ispeziona il formato rich clipboard.

[Leggi il case study](https://rea.tools/showcase/notion/)

### TH04: recupera un calcolo dell'anello di proiettili DOS

Ispeziona le istruzioni a 16 bit del gioco PC-98 originale, recupera i calcoli dell'angolo fisso e mirato e confronta il C++ ricostruito con l'output del compilatore storico.

[Leggi il case study](https://rea.tools/showcase/th04/) · [Repository di ricostruzione](https://github.com/N0zoM1z0/th04)

Se hai usato REA su qualcosa di interessante, ci piacerebbe vederlo. Condividi il tuo caso in una [issue](https://github.com/morluto/rea/issues) o in una [pull request](https://github.com/morluto/rea/pulls), includendo il bersaglio, la tua domanda, come REA ti ha aiutato e cosa hai scoperto.

## FAQ

<details>
<summary><strong>Quali agenti possono usare REA?</strong></summary>

Qualsiasi agente che supporti server MCP locali. La configurazione configura gli [agenti supportati](docs/installation.md#supported-agents); altri client possono usare la [registrazione MCP manuale](docs/installation.md#mcp-registry).

</details>

<details>
<summary><strong>Ho bisogno di Hopper, Ghidra o IDA?</strong></summary>

L'analisi nativa profonda ne usa uno. L'ispezione statica di JavaScript e .NET funziona senza un motore di analisi nativo. La configurazione può installare Hopper previa approvazione; Ghidra e IDA usano le tue installazioni esistenti. Vedi [configurazione provider](docs/installation.md#hopper).

</details>

<details>
<summary><strong>Devo avviare Hopper per primo?</strong></summary>

REA avvia Hopper quando un'operazione ne ha bisogno. Su macOS, una finestra di dialogo al primo avvio potrebbe chiederti di scegliere la modalità demo o di attivare la licenza. Vedi [avvio di Hopper e risoluzione dei problemi](docs/installation.md#launcher-paths-and-troubleshooting).

</details>

<details>
<summary><strong>Cosa fa l'installazione dello skill da skills.sh?</strong></summary>

Lo skill fornisce istruzioni di indagine per il tuo agente. Usa `npx rea-agents setup` per registrare il server MCP di REA e installare le istruzioni corrispondenti, quindi riavvia il tuo agente. Vedi [installazione solo skill](docs/installation.md#skill-only-installation).

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

Per una CLI installata via npm:

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

Inizia dalle [guide pratiche](https://rea.tools/guides/) del sito web. Per opzioni esatte, prerequisiti e contratti dei risultati:

- [Installazione e configurazione](docs/installation.md): registrazione agente, configurazione provider, aggiornamenti e disinstallazione.
- [Pronto all'uso e risoluzione dei problemi](docs/installation.md#check-readiness-for-your-task): diagnostica un agente o un motore di analisi.
- [CLI ed Evidence](docs/cli.md): comandi, selezione provider, snapshot, import/export e stati di uscita.
- [Contratti MCP](docs/mcp-contracts.md) e [prompt agente](docs/mcp-prompts.md): risultati degli strumenti, sessioni e indagini guidate.
- [Catalogo strumenti](docs/mcp-contracts.md#generated-catalog): inventario generato di strumenti, provider e comandi CLI.
- [Roadmap](docs/roadmap.md): lavoro pianificato e tracker delle capacità.

Segnala vulnerabilità tramite [SECURITY.md](SECURITY.md).

## Cronologia delle stelle

🎉 **50.000 stelle su GitHub — grazie!**

Grazie a tutti coloro che usano REA, segnalano bug, propongono funzionalità, testano le build e contribuiscono con correzioni.

<a href="https://www.star-history.com/?repos=morluto%2Frea&amp;type=date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=morluto/rea&amp;type=date&amp;theme=dark&amp;legend=top-left" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=morluto/rea&amp;type=date" />
    <img alt="Cronologia stelle GitHub di REA" src="https://api.star-history.com/chart?repos=morluto/rea&amp;type=date" />
  </picture>
</a>

## Disclaimer

REA fornisce strumenti per la ricerca, l'analisi e la ricostruzione di ingegneria inversa lecita. Sei responsabile di ottenere le eventuali autorizzazioni richieste e di rispettare le leggi applicabili. Il progetto non approva l'uso illegale o non autorizzato.

REA è un progetto software open-source. Non abbiamo emesso né approvato alcuna criptovaluta o token. I token che usano il nome REA non sono affiliati al progetto.

## Contributing

Apprezzeremmo il tuo aiuto con REA! [Apri un issue](https://github.com/morluto/rea/issues) per segnalare un bug o suggerire una funzionalità, oppure [invia una pull request](https://github.com/morluto/rea/pulls) per migliorare il codice o la documentazione.

Vedi [CONTRIBUTING.md](CONTRIBUTING.md) per la configurazione di sviluppo e i controlli, [testing](docs/testing.md) per le lane di verifica e la [mappa dell'architettura](docs/architecture.mermaid) per la struttura del progetto.

## License

[MIT](LICENSE)
