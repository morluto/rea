<div align="center">

[English](../../README.md) · [简体中文](README_zh.md) · [繁體中文](README_zh-TW.md) · [日本語](README_ja.md) · [한국어](README_ko.md) · [Türkçe](README_tr.md) · [Русский](README_ru.md) · [Tiếng Việt](README_vi.md) · [ไทย](README_th.md) · [Deutsch](README_de.md) · [Español](README_es.md) · **Français** · [Українська](README_uk.md) · [Polski](README_pl.md) · [Português (Brasil)](README_pt-BR.md) · [العربية](README_ar.md) · [فارسی](README_fa.md) · [Bahasa Indonesia](README_id.md) · [Italiano](README_it.md)
· [Ελληνικά](README_el.md) · [മലയാളം](README_ml.md) · [Roman Urdu](README_ur-Latn.md) · [Română](README_ro.md) · [Български](README_bg.md)

# REA : rétro-ingénierie de tout

### Un seul MCP pour la rétro-ingénierie des binaires, des applications et du comportement à l'exécution.

**Repérez une fonctionnalité qui vous plaît. Comprenez son fonctionnement, jusqu'au niveau du binaire.**

[![GitHub stars](https://img.shields.io/github/stars/morluto/rea?style=flat-square&logo=github)](https://github.com/morluto/rea/stargazers)
[![Monthly npm downloads](https://img.shields.io/npm/dm/rea-agents?style=flat-square&label=npm%20downloads)](https://www.npmjs.com/package/rea-agents)
[![MIT license](https://img.shields.io/badge/license-MIT-f4c430?style=flat-square)](../../LICENSE)
[![Join the REA Discord](https://img.shields.io/badge/Discord-5865F2?style=flat-square&logo=discord&logoColor=white)](https://discord.gg/GkcryMnJDM)
[![Follow REA on X](https://img.shields.io/badge/X-000000?style=flat-square&logo=x&logoColor=white)](https://x.com/reatools)
[![Supported platforms: macOS, Windows, and Linux](https://img.shields.io/badge/macOS%20%7C%20Windows%20%7C%20Linux-4493F8?style=flat-square)](../getting-started/installation.md)
[![skills.sh](https://skills.sh/b/morluto/rea?style=flat-square)](https://skills.sh/morluto/rea/reverse-engineer-anything)

**[Site web](https://rea.tools/fr/) · [Guides](https://rea.tools/fr/guides/) · [Études de cas](https://rea.tools/fr/showcase/)**

<a href="https://discord.com/invite/GkcryMnJDM"><img alt="Rejoignez la communauté REA sur Discord" src="https://img.shields.io/badge/Join%20us%20on%20Discord-5865F2?style=for-the-badge&logo=discord&logoColor=white" height="40"></a>

[Démarrage rapide](#démarrage-rapide) · [Études de cas](#études-de-cas) · [Comment fonctionne REA](#comment-fonctionne-rea) · [Ce que vous pouvez analyser](#ce-que-vous-pouvez-analyser) · [Créer des environnements RL](#build-rl-environments) · [Questions fréquentes](#questions-fréquentes) · [Documentation](#documentation)

<code>npx rea-agents setup</code>

</div>

> [!IMPORTANT]
> Sources officielles de REA : [morluto/rea](https://github.com/morluto/rea), [rea.tools](https://rea.tools/), [rea-agents](https://www.npmjs.com/package/rea-agents) (npm).
> Utilisez les liens d’installation et de publication de ces sources officielles. Un nom de dépôt similaire ou un README copié ne prouve pas qu’un téléchargement est officiel.

<div align="center">

<br />

<img src="../assets/rea-hopper-analysis.png" alt="REA lance son pont d'analyse dans Hopper pendant l'inspection d'un binaire natif" width="1200" />

<br /><br />

<table aria-label="REA community">
<tr>
<td align="center" width="360">
  <a href="https://discord.gg/GkcryMnJDM">
    <img src="../assets/discord.svg" height="42" alt="Discord" /><br />
    <strong>Rejoignez la communauté de rétro-ingénierie</strong>
  </a><br />
  <sub>Discord · Questions et réponses · Partage de projets</sub>
</td>
</tr>
</table>

<br />

</div>

---

Vous avez repéré dans une application une fonctionnalité que vous aimeriez avoir dans votre propre produit ? Demandez à votre agent de l'étudier avec REA. Il peut inspecter l'application sans son code source, expliquer le fonctionnement de la fonctionnalité, présenter les preuves et en construire une version pour votre projet.

REA connecte votre agent à des outils d'inspection de binaires natifs, d'applications JavaScript et Electron, d'assemblys .NET et de sites web. Les mêmes outils sont aussi disponibles depuis votre terminal. L'analyse s'exécute localement, et chaque conclusion s'accompagne des preuves et des limites sur lesquelles elle repose.

Setup enregistre REA auprès de votre agent et installe les instructions de workflow correspondantes. L'analyse native peut utiliser une installation existante de Hopper, de Ghidra, d'IDA ou de Kuna ; Setup peut aussi installer Hopper après votre accord. L'analyse statique JavaScript ne nécessite aucun moteur d'analyse natif.

## Démarrage rapide

**[Démarrage rapide · rea.tools](https://rea.tools/fr/get-started/)**

### Configurer votre agent (MCP)

Une fois [Node.js et npm](../reference/supported-targets.md) installés, lancez cette commande depuis un répertoire de confiance en dehors du projet à analyser.

```bash
npx rea-agents setup
```

Choisissez vos agents, vérifiez les modifications proposées et approuvez-les. Setup ajoute le serveur MCP de REA et les instructions de workflow correspondantes, et sauvegarde la configuration existante. Redémarrez ensuite votre agent.

[Installation et configuration](../getting-started/installation.md)

Interroger votre agent:

```text
Comprends comment fonctionne la recherche dans l'app Notes, montre-moi les preuves
et construis une fonctionnalité similaire pour mon projet.
```

Remplacez Notes par votre application cible et la fonctionnalité que vous voulez comprendre.

### Utiliser le terminal (CLI)

Inspectez le répertoire extrait ou l'archive ASAR d'une application JavaScript/Electron :

```bash
npx -y rea-agents@latest analyze-javascript-application /absolute/path/to/app --json
```

Le résultat comprend les modules, les imports, les frontières Electron et les preuves associées. Remplacez le chemin par votre cible, par exemple `"D:/apps/example"` sous Windows.

Pour installer la commande `rea` pour un usage régulier :

```bash
npm install --global rea-agents
rea --help
```

Pour l'analyse native, configurez d'abord un fournisseur. Consultez le [guide CLI et Evidence](../getting-started/cli.md) pour les commandes natives, le choix du fournisseur, les snapshots et l'utilisation dans des scripts.

[Prérequis sous Linux](../getting-started/installation.md#linux-owned-process-prerequisite)

### Mettre à jour REA

Pour une CLI installée avec `npm install --global` ou `bun add --global` :

```bash
rea update
```

Si vous utilisez `npx`, mettez à jour la configuration de votre agent avec :

```bash
npx rea-agents@latest setup
```

[Mise à jour et désinstallation](../getting-started/installation.md#diagnose-update-and-remove)

## Études de cas

<a href="https://rea.tools/fr/showcase/">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../assets/rea-showcases-dark.svg" />
    <img alt="Illustrations des études sur la spatialisation sonore de DX-Ball, le pont du presse-papiers de Notion et le cercle de projectiles de TH04" src="../assets/rea-showcases.svg" />
  </picture>
</a>

<table>
<tbody>
<tr><td>
<h3>DX-Ball : reconstruire un calcul de panoramique sonore</h3>
<p>Suivez un appel sonore jusqu'à la fonction qui convertit une position en panoramique, inspectez ses instructions et transformez un pseudo-code incomplet en C. La reconstruction réussit 3 205 cas issus du x86 d'origine et reproduit à l'identique les 63 octets de la fonction compilée.</p>
<p><a href="https://rea.tools/fr/showcase/dx-ball/">Lire l'étude de cas</a> · <a href="https://github.com/N0zoM1z0/dx-ball">Dépôt de la reconstruction</a></p>
</td></tr>
<tr><td>
<h3>Notion : suivre le pont du presse-papiers d'Electron</h3>
<p>Trouvez l'API de presse-papiers du renderer, suivez-la à travers le preload et l'IPC jusqu'au processus principal, puis inspectez le format de presse-papiers enrichi.</p>
<p><a href="https://rea.tools/fr/showcase/notion/">Lire l'étude de cas</a></p>
</td></tr>
<tr><td>
<h3>TH04 : retrouver un calcul d'anneau de projectiles sous DOS</h3>
<p>Inspectez les instructions 16 bits du jeu PC-98 d'origine, retrouvez les calculs d'angles fixes et visés, et comparez le C++ reconstruit avec la sortie du compilateur d'époque.</p>
<p><a href="https://rea.tools/fr/showcase/th04/">Lire l'étude de cas</a> · <a href="https://github.com/N0zoM1z0/th04">Dépôt de la reconstruction</a></p>
</td></tr>
</tbody>
</table>

Si vous avez utilisé REA sur un projet intéressant, nous serions ravis de le découvrir. Partagez votre cas dans une [issue](https://github.com/morluto/rea/issues) ou une [pull request](https://github.com/morluto/rea/pulls), en précisant la cible, votre question, la manière dont REA vous a aidé et ce que vous avez découvert.

## Comment fonctionne REA

Votre agent appelle REA via MCP pour inspecter la cible et suivre le code pertinent. REA renvoie ses constatations avec les preuves correspondantes. L'agent s'en sert pour poser des questions complémentaires, expliquer le comportement, ou écrire et tester une implémentation. Les commandes CLI utilisent les mêmes workflows.

![Flux d'investigation de REA : votre agent pose une question sur une cible locale, REA l'inspecte et la trace avec des outils d'analyse, et l'agent utilise le code, les références et les inconnues renvoyés pour expliquer, implémenter et tester.](../../website/public/assets/figures/rea-investigation-flow.svg)

[Ouvrir la figure en taille réelle](../../website/public/assets/figures/rea-investigation-flow.svg).

<a id="current-status"></a>

## Ce que vous pouvez analyser

Binaires natifs · JavaScript / Electron · Sites web · Assemblys .NET · APK Android · Firmware · Comportement des processus

[Formats pris en charge et prérequis](../reference/supported-targets.md)

<a id="choosing-a-deep-analysis-provider"></a>

[Choisir un moteur d’analyse](../reference/supported-targets.md#choosing-a-deep-analysis-provider)

<a id="build-rl-environments"></a>

## Créer des environnements RL

Créez un environnement local à partir d’une session web enregistrée ou d’une application de bureau Linux pour qu’un agent puisse s’exercer et vérifier le résultat.

[Créer des environnements RL](https://rea.tools/guides/rl-environments/)

## Questions fréquentes

<details>
<summary><strong>Quels agents peuvent utiliser REA ?</strong></summary>

Tout agent compatible avec les serveurs MCP locaux. Setup configure les [agents pris en charge](../getting-started/installation.md#supported-agents) ; les autres clients peuvent utiliser [l'enregistrement MCP manuel](../getting-started/installation.md#mcp-registry).

</details>

<details>
<summary><strong>Ai-je besoin de Hopper, Ghidra, IDA ou Kuna ?</strong></summary>

L'analyse native approfondie utilise l'un d'eux. L'inspection statique JavaScript et .NET fonctionne sans moteur d'analyse native. Setup peut installer Hopper après votre accord ; Ghidra, IDA et Kuna utilisent vos installations existantes. Consultez [la configuration des fournisseurs](../getting-started/installation.md#hopper).

</details>

<details>
<summary><strong>Dois-je lancer Hopper au préalable ?</strong></summary>

REA lance Hopper lorsqu'une opération en a besoin. Sous macOS, une boîte de dialogue de premier lancement peut vous demander de choisir le mode démo ou d'activer votre licence. Consultez [Démarrage et dépannage de Hopper](../getting-started/installation.md#launcher-paths-and-troubleshooting).

</details>

<details>
<summary><strong>Que fait l'installation du skill depuis skills.sh ?</strong></summary>

Le skill fournit des instructions d'investigation à votre agent. Utilisez `npx rea-agents setup` pour enregistrer le serveur MCP de REA et installer les instructions correspondantes, puis redémarrez votre agent. Consultez [l'installation du skill seul](../getting-started/installation.md#skill-only-installation).

</details>

<details>
<summary><strong>Quel code REA renvoie-t-il ?</strong></summary>

L'analyse native renvoie du pseudo-code et de l'assembleur. L'analyse JavaScript/Electron récupère les modules et leurs relations. Votre agent s'appuie sur ces résultats pour écrire et tester une implémentation ; les [études de cas](#études-de-cas) en donnent des exemples concrets.

</details>

<details>
<summary><strong>REA envoie-t-il mon application en ligne ?</strong></summary>

REA analyse les cibles localement. Votre agent reçoit les résultats des outils, et son fournisseur de modèle applique sa propre politique de données.

</details>

<details>
<summary><strong>Que faire si je rencontre un bug ?</strong></summary>

Commencez par mettre à jour ; une version récente l'a peut-être déjà corrigé.

Pour une CLI installée avec `npm install --global` ou `bun add --global` :

```bash
rea update
```

Pour une configuration d'agent via `npx` :

```bash
npx rea-agents@latest setup
```

Si vous utilisez un agent, terminez l'[actualisation de la configuration](#mettre-à-jour-rea) et redémarrez-le. Relancez la même tâche. Si le problème persiste, [ouvrez une issue](https://github.com/morluto/rea/issues) en indiquant votre version de REA, le type de cible, les étapes pour reproduire le problème et la sortie d'erreur.

</details>

## Documentation

Commencez par les [guides pas à pas](https://rea.tools/fr/guides/) du site web. Pour les options exactes, les prérequis et les contrats de résultats :

- [Installation et configuration](../getting-started/installation.md) : enregistrement des agents, configuration des fournisseurs, mises à jour et désinstallation.
- [Vérification et dépannage](../getting-started/installation.md#check-readiness-for-your-task) : diagnostiquer un agent ou un moteur d'analyse donné.
- [CLI et Evidence](../getting-started/cli.md) : commandes, choix du fournisseur, snapshots, import/export et codes de sortie.
- [Contrats MCP](../reference/mcp-contracts.md) et [prompts pour agents](../getting-started/mcp-prompts.md) : résultats des outils, sessions et investigations guidées.
- [Catalogue des outils](../reference/mcp-contracts.md#generated-catalog) : inventaire des outils, fournisseurs et commandes CLI, généré lors du build.

Signalez les vulnérabilités via [SECURITY.md](../../SECURITY.md).

## Communauté et assistance

- **Discord** — Posez vos questions et partagez vos recherches avec notre communauté de plus de 50 000 passionnés de rétro-ingénierie et de création de projets ! [![Discord](https://img.shields.io/badge/Join%20Discord-5865F2?style=flat-square&logo=discord&logoColor=white)](https://discord.gg/GkcryMnJDM)
- **Twitter / X** — Suivez [@reatools](https://x.com/reatools) pour les annonces.
- **Suggestions et idées** — Une fonctionnalité ou un format de fichier vous manque ? Parlez-nous-en sur [GitHub](https://github.com/morluto/rea/issues) ou [Discord](https://discord.gg/GkcryMnJDM).

## Historique des étoiles

🎉 **400 000 étoiles GitHub — merci !**

Merci à toutes les personnes qui utilisent REA, signalent des bugs, proposent des fonctionnalités, testent les builds et contribuent des correctifs.

<a href="https://rea.tools/fr/contributors/">
  <img src="../../website/public/contributors/avatars.png" alt="Personnes ayant contribué à REA" />
</a>

<a href="https://www.star-history.com/?repos=morluto%2Frea&amp;type=date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=morluto/rea&amp;type=date&amp;theme=dark&amp;legend=top-left" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=morluto/rea&amp;type=date" />
    <img alt="Historique des étoiles GitHub de REA" src="https://api.star-history.com/chart?repos=morluto/rea&amp;type=date" />
  </picture>
</a>

## Contribuer

Votre aide sur REA est la bienvenue ! [Ouvrez une issue](https://github.com/morluto/rea/issues) pour signaler un bug ou proposer une fonctionnalité, ou [envoyez une pull request](https://github.com/morluto/rea/pulls) pour améliorer le code ou la documentation.

Consultez [CONTRIBUTING.md](../../CONTRIBUTING.md) pour l'environnement de développement et les vérifications, la page [tests](../development/testing.md) pour les procédures de vérification.

## Avertissement

Consultez [DISCLAIMER.md](../../DISCLAIMER.md) pour les consignes d'utilisation responsable.

> [!WARNING]
> **Avertissement relatif au bannissement de compte et utilisation autorisée :** Les fournisseurs et plateformes d'IA (tels qu'Anthropic, OpenAI, Cursor, etc.) appliquent une surveillance automatisée des abus et des filtres de sécurité. Demander à des agents d'IA de décompiler des logiciels propriétaires, d'extraire de la propriété intellectuelle protégée ou de contourner des DRM et systèmes anti-triche enfreint les politiques d'utilisation acceptable de l'IA et peut entraîner la suspension immédiate et le bannissement définitif de comptes ou de clés API.
>
> N'utilisez REA que sur des logiciels dont vous êtes propriétaire, placés dans le domaine public ou pour lesquels vous détenez une autorisation expresse. La rétro-ingénierie non autorisée de logiciels propriétaires ne confère aucun droit sur le code généré et peut violer les lois sur le droit d'auteur et les conditions d'utilisation.

REA est destiné à la recherche, à l’éducation, à l’interopérabilité, à la préservation logicielle et à l’analyse de logiciels que vous possédez ou êtes autorisé à examiner, dans le respect de la loi.

The project's position on illegal or unauthorized use covers all REA
versions, distribution channels, and platforms; each copy retains its
applicable licenses.

## Licence

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
