<div align="center">

[English](../../README.md) · [简体中文](README_zh.md) · [繁體中文](README_zh-TW.md) · **日本語** · [한국어](README_ko.md) · [Türkçe](README_tr.md) · [Русский](README_ru.md) · [Tiếng Việt](README_vi.md) · [ไทย](README_th.md) · [Deutsch](README_de.md) · [Español](README_es.md) · [Français](README_fr.md) · [Українська](README_uk.md) · [Polski](README_pl.md) · [Português (Brasil)](README_pt-BR.md) · [العربية](README_ar.md) · [فارسی](README_fa.md) · [Bahasa Indonesia](README_id.md) · [Italiano](README_it.md)
· [Ελληνικά](README_el.md) · [മലയാളം](README_ml.md) · [Roman Urdu](README_ur-Latn.md) · [Română](README_ro.md) · [Български](README_bg.md) · [বাংলা](README_bn.md)

# REA：あらゆるものをリバースエンジニアリング

### バイナリ、アプリケーション、実行時の動作を、ひとつの MCP でリバースエンジニアリング。

**気に入った機能を見つけたら、その仕組みをバイナリのレベルまで理解する。**

[![GitHub stars](https://img.shields.io/github/stars/morluto/rea?style=flat-square&logo=github)](https://github.com/morluto/rea/stargazers)
[![Monthly npm downloads](https://img.shields.io/npm/dm/rea-agents?style=flat-square&label=npm%20downloads)](https://www.npmjs.com/package/rea-agents)
[![MIT license](https://img.shields.io/badge/license-MIT-f4c430?style=flat-square)](../../LICENSE)
[![Join the REA Discord](https://img.shields.io/badge/Discord-5865F2?style=flat-square&logo=discord&logoColor=white)](https://discord.gg/GkcryMnJDM)
[![Follow REA on X](https://img.shields.io/badge/X-000000?style=flat-square&logo=x&logoColor=white)](https://x.com/reatools)
[![Supported platforms: macOS, Windows, and Linux](https://img.shields.io/badge/macOS%20%7C%20Windows%20%7C%20Linux-4493F8?style=flat-square)](../getting-started/installation.md)
[![skills.sh](https://skills.sh/b/morluto/rea?style=flat-square)](https://skills.sh/morluto/rea/reverse-engineer-anything)

**[ウェブサイト](https://rea.tools/ja/) · [ガイド](https://rea.tools/ja/guides/) · [事例](https://rea.tools/ja/showcase/)**

<a href="https://discord.com/invite/GkcryMnJDM"><img alt="DiscordのREAコミュニティに参加" src="https://img.shields.io/badge/Join%20us%20on%20Discord-5865F2?style=for-the-badge&logo=discord&logoColor=white" height="40"></a>

[クイックスタート](#クイックスタート) · [事例](#事例) · [REA の仕組み](#rea-の仕組み) · [分析できる対象](#分析できる対象) · [RL 環境を構築する](#build-rl-environments) · [よくある質問](#よくある質問) · [ドキュメント](#ドキュメント)

<code>npx rea-agents setup</code>

</div>

> [!IMPORTANT]
> REA の公式配布元： [morluto/rea](https://github.com/morluto/rea), [rea.tools](https://rea.tools/), [rea-agents](https://www.npmjs.com/package/rea-agents) (npm).
> インストールとリリースのリンクは、これらの公式配布元からたどってください。似たリポジトリ名やコピーされた README だけでは、公式の配布物とは確認できません。

<div align="center">

<br />

<img src="../assets/rea-hopper-analysis.png" alt="REA が Hopper 内で分析ブリッジを起動し、ネイティブバイナリを調べる様子" width="1200" />

<br /><br />

<table aria-label="REA コミュニティ">
<tr>
<td align="center" width="360">
  <a href="https://discord.gg/GkcryMnJDM">
    <img src="../assets/discord.svg" height="42" alt="Discord" /><br />
    <strong>リバースエンジニアリングのコミュニティに参加</strong>
  </a><br />
  <sub>Discord · 質問と回答 · 成果の共有</sub>
</td>
</tr>
</table>

<br />

</div>

---

アプリに、自分の製品にも取り入れたい機能を見つけましたか？エージェントに REA で調査を依頼してください。ソースコードがなくてもアプリを調べ、機能の仕組みを説明し、根拠を示したうえで、あなたのプロジェクト向けに実装できます。

REA はエージェントを分析ツールにつなぎ、ネイティブバイナリ、JavaScript や Electron のアプリ、.NET アセンブリ、ウェブサイトを調べられるようにします。同じツールをターミナルからも使えます。分析はローカルで実行され、結果には各結論を裏付ける根拠と制限事項が含まれます。

セットアップはエージェントに REA を登録し、対応するワークフロー指示をインストールします。ネイティブ解析には既存の Hopper、Ghidra、IDA、Kuna を使用でき、承認すれば Hopper をインストールできます。静的 JavaScript 解析にネイティブ解析エンジンは不要です。

## クイックスタート

**[クイックスタート · rea.tools](https://rea.tools/ja/get-started/)**

### エージェントを設定する (MCP)

[Node.js と npm](../reference/supported-targets.md) をインストールしてから、解析対象のプロジェクト外にある信頼できるディレクトリで次のコマンドを実行します。

```bash
npx rea-agents setup
```

使うエージェントを選び、予定されている変更を確認して承認してください。セットアップは REA の MCP サーバーと対応するワークフローの手順を追加し、既存の設定をバックアップします。完了後にエージェントを再起動してください。

[インストールとセットアップ](../getting-started/installation.md)

エージェントに依頼する：

```text
Notes アプリの検索機能の仕組みを調べ、根拠を示して、私のプロジェクトにも同様の機能を実装してください。
```

Notes を対象のアプリに置き換え、理解したい機能を指定してください。

### ターミナルを使う (CLI)

展開済みの JavaScript/Electron アプリのディレクトリ、または ASAR を調べます。

```bash
npx -y rea-agents@latest analyze-javascript-application /absolute/path/to/app --json
```

結果にはモジュール、インポート、Electron の境界と、それらの根拠が含まれます。パスは対象に合わせて変更してください。Windows では、たとえば `"D:/apps/example"` を指定します。

日常的に使う場合は、`rea` コマンドをインストールできます。

```bash
npm install --global rea-agents
rea --help
```

ネイティブ分析には、先にプロバイダーの設定が必要です。ネイティブ分析のコマンド、プロバイダーの選択、スナップショット、スクリプトでの利用は、[CLI と Evidence のガイド](../getting-started/cli.md)を参照してください。

[Linux の動作要件](../getting-started/installation.md#linux-owned-process-prerequisite)

### REA を更新する

`npm install --global` / `bun add --global` でインストールした CLI の場合：

```bash
rea update
```

`npx` を使っている場合は、次のコマンドでエージェントの設定を更新します。

```bash
npx rea-agents@latest setup
```

[更新とアンインストール](../getting-started/installation.md#diagnose-update-and-remove)

## 事例

<a href="https://rea.tools/ja/showcase/">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../assets/rea-showcases-dark.svg" />
    <img alt="DX-Ball の音声パン、Notion のクリップボードブリッジ、TH04 の弾幕リングの事例を表すイラスト" src="../assets/rea-showcases.svg" />
  </picture>
</a>

<table>
<tbody>
<tr><td>
<h3>DX-Ball：音声のパン計算を再構築する</h3>
<p>音声の呼び出しから位置をパンに変換する補助関数をたどり、命令を調べ、不完全な疑似コードを C に書き直します。再構築した実装は、元の x86 に対する 3,205 ケースの検証を通過し、コンパイル後の関数の全 63 バイトを再現しています。</p>
<p><a href="https://rea.tools/ja/showcase/dx-ball/">事例を読む</a> ·
<a href="https://github.com/N0zoM1z0/dx-ball">再構築リポジトリ</a></p>
</td></tr>
<tr><td>
<h3>Notion：Electron のクリップボードブリッジを追跡する</h3>
<p>レンダラーのクリップボード API を見つけ、preload と IPC を経由してメインプロセスまでたどり、リッチなクリップボード形式を調べます。</p>
<p><a href="https://rea.tools/ja/showcase/notion/">事例を読む</a></p>
</td></tr>
<tr><td>
<h3>TH04：DOS の弾幕リングの計算を復元する</h3>
<p>元の PC-98 ゲームの 16 ビット命令を調べ、固定角度と自機を狙う角度の計算を復元し、再構築した C++ を当時のコンパイラーの出力と比較します。</p>
<p><a href="https://rea.tools/ja/showcase/th04/">事例を読む</a> ·
<a href="https://github.com/N0zoM1z0/th04">再構築リポジトリ</a></p>
</td></tr>
</tbody>
</table>

REA で興味深い対象を調べたら、ぜひ共有してください。[issue](https://github.com/morluto/rea/issues) または [pull request](https://github.com/morluto/rea/pulls) に、対象、調べたかったこと、REA がどう役立ったか、何が分かったかを記載してください。

## REA の仕組み

エージェントは MCP 経由で REA を呼び出し、対象を調べて関連するコードを追跡します。REA は調査結果と根拠を返します。エージェントはそれを使って追加の質問をしたり、動作を説明したり、実装を書いてテストしたりします。CLI コマンドも同じワークフローを使います。

![REA の調査フロー：エージェントがローカルの対象について質問し、REA が分析ツールで調査・追跡します。エージェントは返されたコード、参照、未解明の点を使い、説明、実装、テストを行います。](../../website/public/assets/figures/rea-investigation-flow.svg)

[原寸大の図を開く](../../website/public/assets/figures/rea-investigation-flow.svg)。

<a id="current-status"></a>

## 分析できる対象

ネイティブバイナリ · JavaScript / Electron · ウェブサイト · .NET アセンブリ · Android APK · ファームウェア · プロセスの動作

[対応形式と動作要件](../reference/supported-targets.md)

<a id="choosing-a-deep-analysis-provider"></a>

[解析プロバイダーの選択](../reference/supported-targets.md#choosing-a-deep-analysis-provider)

<a id="build-rl-environments"></a>

## RL 環境を構築する

記録したウェブセッションや Linux デスクトップアプリからローカル環境を作成し、エージェントにタスクを練習させて結果を確認できます。

[RL 環境を構築する](https://rea.tools/guides/rl-environments/)

## よくある質問

<details>
<summary><strong>どのエージェントで REA を使えますか？</strong></summary>

ローカル MCP サーバーに対応するエージェントなら使えます。セットアップは[対応エージェント](../getting-started/installation.md#supported-agents)を設定します。その他のクライアントでは、[MCP の手動登録](../getting-started/installation.md#mcp-registry)を利用できます。

</details>

<details>
<summary><strong>Hopper、Ghidra、IDA、Kuna は必要ですか？</strong></summary>

深いネイティブ分析には、そのいずれかを使います。静的な JavaScript と .NET の検査には、ネイティブ分析エンジンは必要ありません。セットアップは承認後に Hopper をインストールできます。Ghidra、IDA、Kuna は既存のインストールを使います。[プロバイダーのセットアップ](../getting-started/installation.md#hopper)を参照してください。

</details>

<details>
<summary><strong>先に Hopper を起動する必要はありますか？</strong></summary>

REA は必要な操作の際に Hopper を起動します。macOS では、初回起動時にデモモードを選ぶか、ライセンスを有効化するよう求められることがあります。[Hopper の起動とトラブルシューティング](../getting-started/installation.md#launcher-paths-and-troubleshooting)を参照してください。

</details>

<details>
<summary><strong>skills.sh からスキルをインストールすると何ができますか？</strong></summary>

スキルはエージェントに調査の手順を提供します。`npx rea-agents setup` で REA の MCP サーバーを登録し、対応する手順をインストールしてから、エージェントを再起動してください。[スキルのみのインストール](../getting-started/installation.md#skill-only-installation)を参照してください。

</details>

<details>
<summary><strong>REA はどのようなコードを返しますか？</strong></summary>

ネイティブ分析は疑似コードとアセンブリを返します。JavaScript/Electron 分析はモジュールとその関係を復元します。エージェントはその結果を使って実装を書き、テストします。[事例](#事例)に具体的な手順があります。

</details>

<details>
<summary><strong>REA はアプリをアップロードしますか？</strong></summary>

REA は対象をローカルで分析します。エージェントはツールの結果を受け取り、そのモデルプロバイダーには独自のデータポリシーがあります。

</details>

<details>
<summary><strong>バグに遭遇したらどうすればよいですか？</strong></summary>

まず更新してください。最近のリリースですでに修正されている可能性があります。

npm でインストールした CLI の場合：

```bash
rea update
```

`npx` でエージェントを設定している場合：

```bash
npx rea-agents@latest setup
```

エージェントを使っている場合は、[設定の更新](#rea-を更新する)を完了し、再起動してください。同じタスクをもう一度試し、問題が続く場合は [issue を作成](https://github.com/morluto/rea/issues)して、REA のバージョン、対象の種類、再現手順、エラー出力を記載してください。

</details>

## ドキュメント

まずはウェブサイトの[実践ガイド](https://rea.tools/ja/guides/)を参照してください。正確なオプション、前提条件、結果の契約については、以下を参照してください。

- [インストールとセットアップ](../getting-started/installation.md)：エージェントの登録、プロバイダーの設定、更新、アンインストール。
- [準備状況の確認とトラブルシューティング](../getting-started/installation.md#check-readiness-for-your-task)：特定のエージェントや分析エンジンを診断。
- [CLI と Evidence](../getting-started/cli.md)：コマンド、プロバイダーの選択、スナップショット、インポート／エクスポート、終了ステータス。
- [MCP 契約](../reference/mcp-contracts.md)と[エージェント向けプロンプト](../getting-started/mcp-prompts.md)：ツールの結果、セッション、ガイド付き調査。
- [ツールカタログ](../reference/mcp-contracts.md#generated-catalog)：ビルド時に生成されるツール、プロバイダー、CLI コマンドの一覧。

脆弱性の報告は [SECURITY.md](../../SECURITY.md) に従ってください。

## コミュニティとサポート

- **Discord** — リバースエンジニアリングやものづくりに情熱を注ぐ5万人以上の仲間と、質問や調査結果を共有しましょう！ [![Discord](https://img.shields.io/badge/Join%20Discord-5865F2?style=flat-square&logo=discord&logoColor=white)](https://discord.gg/GkcryMnJDM)
- **Twitter / X** — 最新情報やお知らせは [@reatools](https://x.com/reatools) でご覧ください。
- **フィードバックと提案** — 新機能やファイル形式の対応を希望する場合は、[GitHub](https://github.com/morluto/rea/issues) または [Discord](https://discord.gg/GkcryMnJDM) でお知らせください。

## スター履歴

🎉 **GitHub スター 400,000 件、ありがとうございます！**

REA の利用、バグ報告、機能の要望、ビルドのテスト、修正への貢献に感謝します。

<a href="https://rea.tools/ja/contributors/">
  <img src="../../website/public/contributors/avatars.png" alt="REA のコントリビューター" />
</a>

<a href="https://www.star-history.com/?repos=morluto%2Frea&amp;type=date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=morluto/rea&amp;type=date&amp;theme=dark&amp;legend=top-left" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=morluto/rea&amp;type=date" />
    <img alt="REA の GitHub スター履歴" src="https://api.star-history.com/chart?repos=morluto/rea&amp;type=date" />
  </picture>
</a>

## 貢献する

REA への貢献を歓迎します！[issue を作成](https://github.com/morluto/rea/issues)してバグや機能の提案を報告したり、[pull request を送信](https://github.com/morluto/rea/pulls)してコードやドキュメントを改善したりできます。

開発環境とチェックは [CONTRIBUTING.md](../../CONTRIBUTING.md)、検証レーンは[テストガイド](../development/testing.md)を参照してください。

## 免責事項

責任ある利用については [DISCLAIMER.md](../../DISCLAIMER.md) を参照してください。

REA は、法令に従った研究、教育、相互運用性の確保、ソフトウェアの保存、および所有するソフトウェアや調査を許可されたソフトウェアの解析を目的としています。

違法または無許可の利用に関するプロジェクトの立場は、REA のすべてのバージョン、配布チャネル、およびプラットフォームに適用されます。各コピーには、それぞれに適用されるライセンスが引き続き適用されます。

## ライセンス

[MIT](../../LICENSE)

REA が作成したコードは MIT ライセンスの下で提供されます。サードパーティの素材には、それぞれのライセンスと著作権表示が引き続き適用されます。依存関係の一覧、保存されたライセンス本文、および外部ツールの利用条件については、[サードパーティ通知](../../THIRD_PARTY_NOTICES.md)を参照してください。

**IDA Pro / Hex-Rays デコンパイラ、Hopper、JEB を含む商用ツールは、適用されるライセンスに従って合法的に入手し、使用する権限を得ている必要があります。** REA はツールのライセンス、キー、またはアクティベーションの権利を一切付与しません。試用版やデモ版も、ユーザー、機能、自動化、および出力の共有に関する制限を含め、ベンダーの利用条件に従います。クラックされたコピー、盗まれたキー、無許可のキー共有、およびライセンス制限の回避は認められていません。このガイダンスは、MIT ライセンスやサードパーティのライセンスを変更するものではありません。
