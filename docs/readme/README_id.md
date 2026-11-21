<div align="center">

[English](../../README.md) · [简体中文](README_zh.md) · [繁體中文](README_zh-TW.md) · [日本語](README_ja.md) · [한국어](README_ko.md) · [Türkçe](README_tr.md) · [Русский](README_ru.md) · [Tiếng Việt](README_vi.md) · [ไทย](README_th.md) · [Deutsch](README_de.md) · [Español](README_es.md) · [Français](README_fr.md) · [Українська](README_uk.md) · [Polski](README_pl.md) · [Português (Brasil)](README_pt-BR.md) · [العربية](README_ar.md) · [فارسی](README_fa.md) · **Bahasa Indonesia** · [Italiano](README_it.md)
· [Ελληνικά](README_el.md) · [മലയാളം](README_ml.md) · [Roman Urdu](README_ur-Latn.md) · [Română](README_ro.md) · [Български](README_bg.md)

# REA: Rekayasa Balik Apa Pun

### Satu MCP untuk rekayasa balik pada berbagai biner, aplikasi, dan perilaku saat runtime.

**Melihat fitur yang Anda sukai. Pahami cara kerjanya hingga ke tingkat biner.**

[![GitHub stars](https://img.shields.io/github/stars/morluto/rea?style=flat-square&logo=github)](https://github.com/morluto/rea/stargazers)
[![Monthly npm downloads](https://img.shields.io/npm/dm/rea-agents?style=flat-square&label=npm%20downloads)](https://www.npmjs.com/package/rea-agents)
[![MIT license](https://img.shields.io/badge/license-MIT-f4c430?style=flat-square)](../../LICENSE)
[![Join the REA Discord](https://img.shields.io/badge/Discord-5865F2?style=flat-square&logo=discord&logoColor=white)](https://discord.gg/GkcryMnJDM)
[![Follow REA on X](https://img.shields.io/badge/X-000000?style=flat-square&logo=x&logoColor=white)](https://x.com/reatools)
[![Supported platforms: macOS, Windows, and Linux](https://img.shields.io/badge/macOS%20%7C%20Windows%20%7C%20Linux-4493F8?style=flat-square)](../getting-started/installation.md)
[![skills.sh](https://skills.sh/b/morluto/rea?style=flat-square)](https://skills.sh/morluto/rea/reverse-engineer-anything)

**[Situs Web](https://rea.tools/id/) · [Panduan](https://rea.tools/id/guides/) · [Contoh Penggunaan](https://rea.tools/id/showcase/)**

<a href="https://discord.com/invite/GkcryMnJDM"><img alt="Bergabunglah dengan komunitas REA di Discord" src="https://img.shields.io/badge/Join%20us%20on%20Discord-5865F2?style=for-the-badge&logo=discord&logoColor=white" height="40"></a>

[Mulai Cepat](#mulai-cepat) · [Contoh Penggunaan](#contoh-penggunaan) · [Cara Kerja REA](#cara-kerja-rea) · [Hal yang Dapat Anda Analisis](#hal-yang-dapat-anda-analisis) · [Membangun lingkungan RL](#build-rl-environments) · [FAQ](#faq) · [Dokumentasi](#dokumentasi)

<code>npx rea-agents setup</code>

</div>

> [!IMPORTANT]
> Sumber resmi REA: [morluto/rea](https://github.com/morluto/rea), [rea.tools](https://rea.tools/), [rea-agents](https://www.npmjs.com/package/rea-agents) (npm).
> Gunakan tautan instalasi dan rilis dari sumber resmi ini. Nama repositori yang mirip atau README yang disalin tidak membuktikan bahwa unduhan tersebut resmi.

<div align="center">

<br />

<img src="../assets/rea-hopper-analysis.png" alt="REA menjalankan jembatan analisisnya di dalam Hopper saat memeriksa biner native" width="1200" />

<br /><br />

<table aria-label="Komunitas REA">
<tr>
<td align="center" width="360">
  <a href="https://discord.gg/GkcryMnJDM">
    <img src="../assets/discord.svg" height="42" alt="Discord" /><br />
    <strong>Bergabunglah dengan Komunitas Rekayasa Balik</strong>
  </a><br />
  <sub>Discord · Tanya Jawab · Berbagi Hasil</sub>
</td>
</tr>
</table>

<br />

</div>

---

Melihat fitur dalam suatu aplikasi yang ingin Anda hadirkan di produk sendiri? Minta agen Anda menyelidikinya menggunakan REA. REA dapat memeriksa aplikasi tanpa kode sumbernya, menjelaskan cara kerja fitur tersebut, menunjukkan bukti, dan membangun versi untuk proyek Anda.

REA menghubungkan agen Anda dengan berbagai alat untuk memeriksa biner native, aplikasi JavaScript dan Electron, assembly .NET, serta situs web. Anda juga dapat menggunakan alat yang sama dari terminal. Analisis dijalankan secara lokal, dan hasilnya mencakup bukti serta keterbatasan yang mendasari setiap kesimpulan.

Proses penyiapan mendaftarkan REA ke agen Anda dan memasang instruksi alur kerja yang sesuai. Analisis native dapat menggunakan instalasi Hopper, Ghidra, IDA, atau Kuna yang sudah ada. Proses penyiapan juga dapat memasang Hopper secara opsional setelah mendapatkan persetujuan. Analisis JavaScript statis tidak memerlukan mesin analisis native.

## Mulai Cepat

**[Mulai Cepat · rea.tools](https://rea.tools/id/get-started/)**

### Siapkan agen Anda (MCP)

Setelah memasang [Node.js dan npm](../reference/supported-targets.md), jalankan perintah ini dari direktori tepercaya di luar proyek yang ingin Anda analisis.

```bash
npx rea-agents setup
```

Pilih agen yang ingin digunakan, tinjau perubahan yang diusulkan, lalu setujui perubahan tersebut. Proses penyiapan menambahkan server MCP REA dan instruksi alur kerja yang sesuai, serta membuat cadangan konfigurasi yang sudah ada. Setelah itu, mulai ulang agen Anda.

[instalasi dan penyiapan](../getting-started/installation.md)

Minta agen Anda:

```text
Pahami cara kerja pencarian di aplikasi Notes, tunjukkan buktinya, dan buat fitur serupa untuk proyek saya.
```

Ganti Notes dengan aplikasi target dan fitur yang ingin Anda pahami.

### Gunakan terminal (CLI)

Periksa direktori aplikasi JavaScript/Electron yang telah diekstrak atau berkas ASAR:

```bash
npx -y rea-agents@latest analyze-javascript-application /absolute/path/to/app --json
```

Hasilnya mencakup modul, impor, batas antarkomponen Electron, dan bukti yang mendasarinya. Ganti jalur tersebut dengan lokasi target Anda, misalnya `"D:/apps/example"` di Windows.

Untuk memasang perintah `rea` agar dapat digunakan secara rutin:

```bash
npm install --global rea-agents
rea --help
```

Untuk analisis native, konfigurasikan penyedia terlebih dahulu. Lihat [Panduan CLI dan Bukti](../getting-started/cli.md) untuk perintah native, pemilihan penyedia, snapshot, dan pembuatan skrip.

[Persyaratan Linux](../getting-started/installation.md#linux-owned-process-prerequisite)

### Perbarui REA

Untuk CLI yang dipasang melalui `npm install --global` atau `bun add --global`:

```bash
rea update
```

Jika Anda menggunakan `npx`, perbarui penyiapan agen dengan:

```bash
npx rea-agents@latest setup
```

[Pembaruan dan penghapusan instalasi](../getting-started/installation.md#diagnose-update-and-remove)

## Contoh Penggunaan

<a href="https://rea.tools/id/showcase/">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../assets/rea-showcases-dark.svg" />
    <img alt="Ilustrasi contoh penggunaan DX-Ball sound-pan, Notion clipboard-bridge, dan TH04 bullet-ring" src="../assets/rea-showcases.svg" />
  </picture>
</a>

<table>
<tbody>
<tr><td>
<h3>DX-Ball: merekonstruksi perhitungan sound-pan</h3>
<p>Ikuti pemanggilan suara hingga ke fungsi pembantu yang mengubah posisi menjadi nilai pan, periksa instruksinya, lalu ubah pseudocode yang belum lengkap menjadi C. Hasil rekonstruksi tersebut lolos pada 3.205 kasus x86 asli dan mereproduksi seluruh 63 byte fungsi hasil kompilasi.</p>
<p><a href="https://rea.tools/id/showcase/dx-ball/">Baca studi kasus</a> · <a href="https://github.com/N0zoM1z0/dx-ball">Repositori rekonstruksi</a></p>
</td></tr>
<tr><td>
<h3>Notion: menelusuri jembatan clipboard Electron</h3>
<p>Temukan API clipboard pada renderer, telusuri jalurnya melalui preload dan IPC hingga ke proses utama, lalu periksa format clipboard kaya.</p>
<p><a href="https://rea.tools/id/showcase/notion/">Baca studi kasus</a></p>
</td></tr>
<tr><td>
<h3>TH04: memulihkan perhitungan bullet-ring DOS</h3>
<p>Periksa instruksi 16-bit dari gim PC-98 asli, pulihkan perhitungan sudut tetap dan sudut yang diarahkan, lalu bandingkan C++ hasil rekonstruksi dengan keluaran historis kompiler.</p>
<p><a href="https://rea.tools/id/showcase/th04/">Baca studi kasus</a> · <a href="https://github.com/N0zoM1z0/th04">Repositori rekonstruksi</a></p>
</td></tr>
</tbody>
</table>

Jika Anda telah menggunakan REA untuk menganalisis sesuatu yang menarik, kami ingin melihat hasilnya. Bagikan kasus Anda melalui [issue](https://github.com/morluto/rea/issues) atau [pull request](https://github.com/morluto/rea/pulls), sertakan target, pertanyaan Anda, bagaimana REA membantu, dan apa yang Anda temukan.

## Cara Kerja REA

Agen Anda memanggil REA melalui MCP untuk memeriksa target dan menelusuri kode yang relevan. REA mengembalikan temuan beserta bukti pendukungnya. Agen kemudian menggunakan temuan tersebut untuk mengajukan pertanyaan lanjutan, menjelaskan perilaku, atau menulis dan menguji implementasi.

Perintah CLI menggunakan alur kerja yang sama.

![Alur investigasi REA: agen Anda menanyakan sesuatu tentang target lokal, REA memeriksa dan menelusurinya menggunakan alat analisis, lalu agen menggunakan kode, referensi, dan hal-hal yang belum diketahui dari hasil tersebut untuk menjelaskan, mengimplementasikan, dan menguji.](../../website/public/assets/figures/rea-investigation-flow.svg)

[Buka ilustrasi dalam ukuran penuh](../../website/public/assets/figures/rea-investigation-flow.svg).

<a id="current-status"></a>

## Hal yang Dapat Anda Analisis

Biner native · JavaScript / Electron · Situs web · Assembly .NET · APK Android · Firmware · Perilaku proses

[Format yang didukung dan persyaratan](../reference/supported-targets.md)

<a id="choosing-a-deep-analysis-provider"></a>

[Memilih penyedia analisis](../reference/supported-targets.md#choosing-a-deep-analysis-provider)

<a id="build-rl-environments"></a>

## Membangun lingkungan RL

Buat lingkungan lokal dari rekaman sesi web atau aplikasi desktop Linux agar agen dapat berlatih menjalankan tugas dan memeriksa hasilnya.

[Membangun lingkungan RL](https://rea.tools/guides/rl-environments/)

## FAQ

<details>
<summary><strong>Agen apa saja yang dapat menggunakan REA?</strong></summary>

Agen apa pun yang mendukung server MCP lokal dapat menggunakan REA. Proses penyiapan mengonfigurasi [agen yang didukung](../getting-started/installation.md#supported-agents). Klien lain dapat menggunakan [pendaftaran MCP manual](../getting-started/installation.md#mcp-registry).

</details>

<details>
<summary><strong>Apakah saya memerlukan Hopper, Ghidra, IDA, atau Kuna?</strong></summary>

Analisis native mendalam menggunakan salah satu dari keempatnya. Pemeriksaan JavaScript dan .NET statis dapat dilakukan tanpa mesin analisis native.

Proses penyiapan dapat memasang Hopper setelah memperoleh persetujuan. Ghidra, IDA, dan Kuna menggunakan instalasi yang sudah tersedia. Lihat [penyiapan penyedia](../getting-started/installation.md#hopper).

</details>

<details>
<summary><strong>Apakah saya harus menjalankan Hopper terlebih dahulu?</strong></summary>

REA akan menjalankan Hopper saat suatu operasi membutuhkannya. Di macOS, dialog saat pertama kali dijalankan mungkin meminta Anda memilih mode demo atau mengaktifkan lisensi.

Lihat [startup dan pemecahan masalah Hopper](../getting-started/installation.md#launcher-paths-and-troubleshooting).

</details>

<details>
<summary><strong>Apa fungsi memasang skill dari skills.sh?</strong></summary>

Skill tersebut menyediakan instruksi investigasi untuk agen Anda. Gunakan `npx rea-agents setup` untuk mendaftarkan server MCP REA dan memasang instruksi yang sesuai, lalu mulai ulang agen Anda.

Lihat [instalasi khusus skill](../getting-started/installation.md#skill-only-installation).

</details>

<details>
<summary><strong>Kode seperti apa yang dihasilkan REA?</strong></summary>

Analisis native menghasilkan pseudocode dan assembly. Analisis JavaScript/Electron memulihkan modul dan hubungan antarmodulnya. Agen Anda menggunakan temuan tersebut untuk menulis dan menguji implementasi. [Contoh penggunaan](#contoh-penggunaan) menyediakan contoh yang telah dikerjakan.

</details>

<details>
<summary><strong>Apakah REA mengunggah aplikasi saya?</strong></summary>

REA menganalisis target secara lokal. Agen Anda menerima hasil alat, sedangkan penyedia model yang digunakannya memiliki kebijakan datanya sendiri.

</details>

<details>
<summary><strong>Apa yang harus saya lakukan jika menemukan bug?</strong></summary>

Perbarui terlebih dahulu. Rilis terbaru mungkin sudah memperbaiki masalah tersebut.

Untuk CLI yang dipasang melalui `npm install --global` atau `bun add --global`:

```bash
rea update
```

Untuk penyiapan agen melalui `npx`:

```bash
npx rea-agents@latest setup
```

Jika Anda menggunakan agen, selesaikan [pembaruan penyiapan](#perbarui-rea) dan mulai ulang agen tersebut.

Coba kembali tugas yang sama. Jika masalah masih terjadi, [buat issue](https://github.com/morluto/rea/issues) dengan menyertakan versi REA, jenis target, langkah-langkah untuk mereproduksi masalah, dan keluaran kesalahan.

</details>

## Dokumentasi

Mulailah dengan [panduan praktik di situs web](https://rea.tools/id/guides/).

Untuk mengetahui opsi, prasyarat, dan kontrak hasil secara tepat:

- [Instalasi dan penyiapan](../getting-started/installation.md): pendaftaran agen, konfigurasi penyedia, pembaruan, dan penghapusan instalasi.
- [Kesiapan dan pemecahan masalah](../getting-started/installation.md#check-readiness-for-your-task): mendiagnosis satu agen atau mesin analisis.
- [CLI dan Bukti](../getting-started/cli.md): perintah, pemilihan penyedia, snapshot, impor/ekspor, dan status keluar.
- [Kontrak MCP](../reference/mcp-contracts.md) dan [prompt agen](../getting-started/mcp-prompts.md): hasil alat, sesi, dan investigasi terpandu.
- [Katalog alat](../reference/mcp-contracts.md#generated-catalog): inventaris alat, penyedia, dan perintah CLI yang dibuat secara otomatis.

Laporkan kerentanan melalui [SECURITY.md](../../SECURITY.md).

## Komunitas dan dukungan

- **Discord** — Ajukan pertanyaan dan bagikan temuan Anda bersama komunitas kami yang terdiri dari lebih dari 50.000 penggemar rekayasa balik dan pembuat proyek! [![Discord](https://img.shields.io/badge/Join%20Discord-5865F2?style=flat-square&logo=discord&logoColor=white)](https://discord.gg/GkcryMnJDM)
- **Twitter / X** — Ikuti [@reatools](https://x.com/reatools) untuk kabar terbaru.
- **Masukan dan ide** — Ingin fitur baru atau dukungan untuk suatu format berkas? Beri tahu kami melalui [GitHub](https://github.com/morluto/rea/issues) atau [Discord](https://discord.gg/GkcryMnJDM).

## Riwayat Bintang

🎉 **400.000 bintang GitHub, terima kasih!**

Terima kasih kepada semua orang yang menggunakan REA, melaporkan bug, meminta fitur, menguji build, dan berkontribusi dalam perbaikan.

<a href="https://rea.tools/id/contributors/">
  <img src="https://contrib.rocks/image?repo=morluto/rea&amp;max=500&amp;columns=30" alt="Kontributor REA" />
</a>

<a href="https://www.star-history.com/?repos=morluto%2Frea&amp;type=date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=morluto/rea&amp;type=date&amp;theme=dark&amp;legend=top-left" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=morluto/rea&amp;type=date" />
    <img alt="Riwayat bintang GitHub REA" src="https://api.star-history.com/chart?repos=morluto/rea&amp;type=date" />
  </picture>
</a>

## Kontribusi

Kami sangat menghargai bantuan Anda untuk REA! [Buat issue](https://github.com/morluto/rea/issues) untuk melaporkan bug atau menyarankan fitur, atau [kirim pull request](https://github.com/morluto/rea/pulls) untuk meningkatkan kode atau dokumentasi.

Lihat [CONTRIBUTING.md](../../CONTRIBUTING.md) untuk penyiapan pengembangan dan pemeriksaan, [pengujian](../development/testing.md) untuk tahapan verifikasi.

## Penafian

Lihat [DISCLAIMER.md](../../DISCLAIMER.md) untuk panduan penggunaan yang bertanggung jawab.

REA ditujukan untuk penelitian, pendidikan, interoperabilitas, pelestarian perangkat lunak, dan analisis perangkat lunak yang Anda miliki atau diizinkan untuk Anda periksa, sesuai hukum.

The project's position on illegal or unauthorized use covers all REA
versions, distribution channels, and platforms; each copy retains its
applicable licenses.

## Lisensi

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
