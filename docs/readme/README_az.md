<div align="center">

[English](../../README.md) · [简体中文](README_zh.md) · [繁體中文](README_zh-TW.md) · [日本語](README_ja.md) · [한국어](README_ko.md) · [Türkçe](README_tr.md) · [Русский](README_ru.md) · [Tiếng Việt](README_vi.md) · [ไทย](README_th.md) · [Deutsch](README_de.md) · [Español](README_es.md) · [Français](README_fr.md) · [Українська](README_uk.md) · [Polski](README_pl.md) · [Português (Brasil)](README_pt-BR.md) · [العربية](README_ar.md) · [فارسی](README_fa.md) · [Bahasa Indonesia](README_id.md) · [Italiano](README_it.md)
· [Ελληνικά](README_el.md) · [മലയാളം](README_ml.md) · [Roman Urdu](README_ur-Latn.md) · [Română](README_ro.md) · [Български](README_bg.md) · **Azərbaycanca**

# REA: Hər şeyi tərs mühəndislikdən keçirin

### Binar fayllar, tətbiqlər və icra zamanı davranışı üzrə tərs mühəndislik üçün vahid MCP.

**Bəyəndiyiniz bir funksiya gördünüz? Onun necə işlədiyini binar səviyyəyə qədər anlayın.**

[![GitHub stars](https://img.shields.io/github/stars/morluto/rea?style=flat-square&logo=github)](https://github.com/morluto/rea/stargazers)
[![Monthly npm downloads](https://img.shields.io/npm/dm/rea-agents?style=flat-square&label=npm%20downloads)](https://www.npmjs.com/package/rea-agents)
[![MIT license](https://img.shields.io/badge/license-MIT-f4c430?style=flat-square)](../../LICENSE)
[![REA Discord-una qoşulun](https://img.shields.io/badge/Discord-5865F2?style=flat-square&logo=discord&logoColor=white)](https://discord.gg/GkcryMnJDM)
[![REA-nı X-də izləyin](https://img.shields.io/badge/X-000000?style=flat-square&logo=x&logoColor=white)](https://x.com/reatools)
[![Dəstəklənən platformalar: macOS, Windows və Linux](https://img.shields.io/badge/macOS%20%7C%20Windows%20%7C%20Linux-4493F8?style=flat-square)](../getting-started/installation.md)
[![skills.sh](https://skills.sh/b/morluto/rea?style=flat-square)](https://skills.sh/morluto/rea/reverse-engineer-anything)

**[Vebsayt](https://rea.tools/) · [Bələdçilər](https://rea.tools/guides/) · [Nümunələr](https://rea.tools/showcase/)**

<a href="https://discord.com/invite/GkcryMnJDM"><img alt="Discord-da REA icmasına qoşulun" src="https://img.shields.io/badge/Join%20us%20on%20Discord-5865F2?style=for-the-badge&logo=discord&logoColor=white" height="40"></a>

[Sürətli başlanğıc](#sürətli-başlanğıc) · [Nümunələr](#nümunələr) · [REA necə işləyir](#rea-necə-işləyir) · [Nələri analiz edə bilərsiniz](#nələri-analiz-edə-bilərsiniz) · [RL mühitləri qurun](#rl-mühitləri-qurun) · [Tez-tez verilən suallar](#tez-tez-verilən-suallar) · [Sənədlər](#sənədlər)

<code>npx rea-agents setup</code>

</div>

> [!IMPORTANT]
> REA-nı [morluto/rea](https://github.com/morluto/rea),
> [rea.tools](https://rea.tools/) və ya [rea-agents npm paketi](https://www.npmjs.com/package/rea-agents) vasitəsilə əldə edin.
> Quraşdırma və buraxılış keçidlərini bu rəsmi mənbələrdən izləyin. Oxşar
> repozitoriya adı və ya kopyalanmış README yüklənən faylın rəsmi olduğunu sübut etmir.

<div align="center">

<br />

<img src="../assets/rea-hopper-analysis.png" alt="REA yerli binar faylı araşdırarkən Hopper daxilində analiz körpüsünü işə salır" width="1200" />

<br /><br />

<table aria-label="REA icması">
<tr>
<td align="center" width="360">
  <a href="https://discord.gg/GkcryMnJDM">
    <img src="../assets/discord.svg" height="42" alt="Discord" /><br />
    <strong>Tərs mühəndislik icmasına qoşulun</strong>
  </a><br />
  <sub>Discord · Sual-cavab · Nəticələrinizi paylaşın</sub>
</td>
</tr>
</table>

<br />

</div>

---

Bir tətbiqdə öz məhsulunuzda görmək istədiyiniz funksiya gördünüz? Agentinizdən onu REA ilə araşdırmasını istəyin. Agent tətbiqi mənbə kodu olmadan araşdıra, funksiyanın necə işlədiyini izah edə, sübutları göstərə və layihəniz üçün onun bir versiyasını qura bilər.

REA agentinizi yerli binar faylları, JavaScript və Electron tətbiqlərini, .NET assembly-lərini və vebsaytları araşdıran alətlərə qoşur. Eyni alətlərdən terminalınızdan da istifadə edə bilərsiniz. Analiz lokal olaraq işləyir və nəticələr hər bir nəticənin arxasındakı sübutları və məhdudiyyətləri ehtiva edir.

Quraşdırma REA-nı agentinizdə qeydiyyatdan keçirir və uyğun iş axını təlimatlarını quraşdırır. Yerli kod analizi mövcud Hopper, Ghidra, IDA və ya Kuna quraşdırmasından istifadə edə bilər; quraşdırma, istəyə bağlı olaraq, təsdiqinizlə Hopper-i də quraşdıra bilər. Statik JavaScript analizi üçün heç bir yerli analiz mühərriki lazım deyil.

## Sürətli başlanğıc

Əməliyyat sistemi, agent və analiz provayderi üzrə addım-addım təlimatlar üçün
**[rea.tools saytında başlayın](https://rea.tools/get-started/)**.

### Agentinizi qoşun (MCP)

[Node.js və npm](../reference/supported-targets.md) quraşdırılmış halda bu əmri analiz
etməyi planlaşdırdığınız layihədən kənarda, etibarlı bir qovluqdan işlədin.

```bash
npx rea-agents setup
```

Agentinizi seçin, quraşdırma planına baxıb onu təsdiqləyin, sonra agentinizi yenidən başladın.
Quraşdırma mövcud konfiqurasiyanın ehtiyat nüsxəsini yaradır və REA-nın MCP bağlantısını və
araşdırma skill-ini əlavə edir. Dəstəklənən klientlər, plaginlər, əl ilə qeydiyyat və
problemlərin həlli üçün [quraşdırma bələdçisinə](../getting-started/installation.md) baxın.

Agentinizdən bunu soruşmağa çalışın:

```text
Notes tətbiqində axtarışın necə işlədiyini anla, mənə sübutları göstər və layihəm üçün
oxşar funksiya qur.
```

Notes əvəzinə hədəf tətbiqinizi və anlamaq istədiyiniz funksiyanı yazın.

### REA-dan terminalda istifadə edin (CLI)

Çıxarılmış JavaScript/Electron tətbiq qovluğunu və ya ASAR faylını araşdırın:

```bash
npx -y rea-agents@latest analyze-javascript-application /absolute/path/to/app --json
```

Nəticəyə modullar, importlar, Electron sərhədləri və onların sübutları daxildir.
Yolu öz hədəfinizlə əvəz edin, məsələn, Windows-da `"D:/apps/example"`.

Müntəzəm istifadə üçün `rea` əmrini quraşdırmaq üçün:

```bash
npm install --global rea-agents
rea --help
```

Yerli kod analizi üçün əvvəlcə provayder konfiqurasiya edin.
[CLI və Evidence bələdçisi](../getting-started/cli.md) provayder seçimini, yerli əmrləri,
snapshot-ları və skriptləşdirməni əhatə edir. Linux üçün ilkin şərtlərə
[quraşdırma bələdçisində](../getting-started/installation.md#linux-owned-process-prerequisite) baxın.

### REA-nı yeniləyin

Qlobal npm və ya Bun quraşdırması üçün yeniləyicini işlədin və onun quraşdırma
təlimatlarına əməl edin.

```bash
rea update
```

`npx` istifadə edirsinizsə, agent quraşdırmanızı bu əmrlə yeniləyin:

```bash
npx rea-agents@latest setup
```

Quraşdırma dəyişikliklərinə baxın və agentinizi yenidən başladın. Paket işlədici seçimləri və
problemlərin həlli üçün [yeniləmə və silinmə təlimatlarına](../getting-started/installation.md#diagnose-update-and-remove)
baxın.

## Nümunələr

<a href="https://rea.tools/showcase/">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../assets/rea-showcases-dark.svg" />
    <img alt="DX-Ball səs panoraması, Notion mübadilə buferi körpüsü və TH04 güllə halqası nümunələrinin illüstrasiyaları" src="../assets/rea-showcases.svg" />
  </picture>
</a>

<table>
<tbody>
<tr>
<td>
<h3>DX-Ball: səs panoraması hesablamasının bərpası</h3>
<p>Mövqeyi panoramaya çevirən köməkçi funksiyanı x86 təlimatlarından bərpa edin və C rekonstruksiyasını 3 205 orijinal x86 halı və kompilyasiya olunmuş funksiyanın bütün 63 baytı ilə yoxlayın.</p>
<a href="https://rea.tools/showcase/dx-ball/">Nümunəni oxuyun</a> ·
<a href="https://github.com/N0zoM1z0/dx-ball">Bərpa repozitoriyası</a>
</td>
</tr>
<tr>
<td>
<h3>Notion: Electron mübadilə buferi körpüsünün izlənməsi</h3>
<p>Notion-un zəngin mübadilə buferi məlumatlarını necə emal etdiyini görmək üçün renderer-in mübadilə buferi API-sini preload və IPC vasitəsilə əsas prosesə qədər izləyin.</p>
<a href="https://rea.tools/showcase/notion/">Nümunəni oxuyun</a>
</td>
</tr>
<tr>
<td>
<h3>TH04: DOS güllə halqası hesablamasının bərpası</h3>
<p>PC-98 oyununun 16 bitlik təlimatlarından sabit və hədəfə yönəlmiş bucaq hesablamalarını bərpa edin və bərpa olunmuş C++ kodunu tarixi kompilyator çıxışı ilə müqayisə edin.</p>
<a href="https://rea.tools/showcase/th04/">Nümunəni oxuyun</a> ·
<a href="https://github.com/N0zoM1z0/th04">Bərpa repozitoriyası</a>
</td>
</tr>
</tbody>
</table>

REA-dan maraqlı bir şey üçün istifadə etmisinizsə, onu görmək istərdik. Nümunənizi
[issue](https://github.com/morluto/rea/issues) və ya
[pull request](https://github.com/morluto/rea/pulls) vasitəsilə paylaşın; hədəfi,
sualınızı, REA-nın necə kömək etdiyini və nə tapdığınızı qeyd edin.

## REA necə işləyir

Agentiniz hədəfi araşdırmaq və müvafiq kodu izləmək üçün MCP vasitəsilə REA-dan istifadə edir.
REA-nın qaytardığı sübutlardan əlavə suallar vermək, davranışı izah etmək və ya
implementasiya qurub test etmək üçün istifadə edə bilər. CLI eyni iş axınlarından istifadə edir.

![REA araşdırma axını: agentiniz lokal hədəf haqqında soruşur, REA analiz alətləri ilə onu araşdırır və izləyir, agent isə qaytarılan kod, istinadlar və naməlumlardan izah etmək, implementasiya etmək və test etmək üçün istifadə edir.](../../website/public/assets/figures/rea-investigation-flow.svg)

[Şəkli tam ölçüdə açın](../../website/public/assets/figures/rea-investigation-flow.svg).

<a id="current-status"></a>

## Nələri analiz edə bilərsiniz

REA yerli binar faylları, JavaScript və Electron tətbiqlərini, vebsaytları, .NET
assembly-lərini, Android tətbiqlərini, firmware-i, həmçinin qeydə alınmış icra zamanı və şəbəkə fəaliyyətini əhatə edir.

[Dəstəklənən hədəflər və tələblər](../reference/supported-targets.md)

<a id="choosing-a-deep-analysis-provider"></a>

Yerli dekompilyasiya üçün hədəf formatınızı və host əməliyyat sistemini dəstəkləyən provayder
seçin. [Dərin analiz provayderinin seçilməsi](../reference/supported-targets.md#choosing-a-deep-analysis-provider) bölməsinə baxın.

## RL mühitləri qurun

Agentin tapşırığı məşq edib nəticəsini yoxlaya bilməsi üçün qeydə alınmış veb sessiyasından
və ya Linux masaüstü tətbiqindən lokal mühit qurun.
[REA ilə RL mühiti qurun](https://rea.tools/guides/rl-environments/).

## Tez-tez verilən suallar

<details>
<summary><strong>Hansı agentlər REA-dan istifadə edə bilər?</strong></summary>

Lokal MCP serverlərini dəstəkləyən istənilən agent. Quraşdırma
[dəstəklənən agentləri](../getting-started/installation.md#supported-agents) konfiqurasiya edir; digər klientlər
[əl ilə MCP qeydiyyatından](../getting-started/installation.md#mcp-registry) istifadə edə bilər.

</details>

<details>
<summary><strong>Mənə yerli analiz mühərriki lazımdır?</strong></summary>

Dərin yerli kod analizi hədəfdən və əməliyyatdan asılı olaraq Hopper, Ghidra, IDA və ya Kuna
istifadə edir. Statik JavaScript və .NET yoxlaması yerli analiz mühərriki olmadan işləyir.
Quraşdırma təsdiqdən sonra Hopper-i quraşdıra bilər; Ghidra, IDA və Kuna mövcud
quraşdırmalarınızdan istifadə edir. Seçimlər və onların dəstəklədiyi hədəflər üçün
[provayder quraşdırmasına](../getting-started/installation.md#hopper) baxın.

</details>

<details>
<summary><strong>Əvvəlcə Hopper-i işə salmalıyam?</strong></summary>

Əməliyyat Hopper tələb etdikdə REA onu özü işə salır. macOS-da ilk işə salınma zamanı
dialoq pəncərəsi sizdən demo rejimini seçməyi və ya lisenziyanızı aktivləşdirməyi xahiş edə bilər.
Bu sorğunu ilk CLI/MCP əməliyyatınızdan və ya nəzarətsiz tapşırığınızdan əvvəl eyni
istifadəçi sessiyasında tamamlayın. Lazım gələrsə, Hopper-i əl ilə açın. Bax:
[Hopper-in işə salınması və problemlərin həlli](../getting-started/installation.md#launcher-paths-and-troubleshooting).

</details>

<details>
<summary><strong>skills.sh-dən skill quraşdırmaq nə edir?</strong></summary>

Skill agentinizə araşdırma təlimatları verir. REA-nın MCP serverini qeydiyyatdan keçirmək
və uyğun təlimatları quraşdırmaq üçün `npx rea-agents setup` istifadə edin, sonra agentinizi
yenidən başladın. [Yalnız skill quraşdırması](../getting-started/installation.md#skill-only-installation) sənədinə baxın.

</details>

<details>
<summary><strong>REA hansı kodu qaytarır?</strong></summary>

Yerli kod analizi psevdokod və assembly qaytarır. JavaScript/Electron analizi
modulları və onların əlaqələrini bərpa edir. Agentiniz bu tapıntılardan implementasiya
yazmaq və test etmək üçün istifadə edir; [nümunələr](#nümunələr) praktik misallar göstərir.

</details>

<details>
<summary><strong>REA tətbiqimi yükləyir (upload edir)?</strong></summary>

REA hədəfləri lokal olaraq analiz edir. Agentiniz alət nəticələrini alır və onun
model provayderinin öz məlumat siyasəti var.

</details>

<details>
<summary><strong>Xəta ilə qarşılaşsam nə etməliyəm?</strong></summary>

Əvvəlcə yeniləyin; son buraxılış artıq onu düzəltmiş ola bilər.

`npm install --global` və ya `bun add --global` ilə quraşdırılmış CLI üçün:

```bash
rea update
```

`npx` vasitəsilə agent quraşdırması üçün:

```bash
npx rea-agents@latest setup
```

Agentdən istifadə edirsinizsə, [quraşdırmanın yenilənməsini](#rea-nı-yeniləyin) tamamlayın və onu
yenidən başladın. Eyni tapşırığı təkrar yoxlayın. Problem davam edərsə, REA versiyanız, hədəf
növü, təkrarlama addımları və xəta çıxışı ilə [issue açın](https://github.com/morluto/rea/issues).

</details>

## Sənədlər

Vebsaytdakı [praktik bələdçilərdən](https://rea.tools/guides/) başlayın.
Dəqiq seçimlər, ilkin şərtlər və nəticə müqavilələri üçün:

- [Quraşdırma və tənzimləmə](../getting-started/installation.md): agent qeydiyyatı, provayder konfiqurasiyası, yeniləmələr və silinmə.
- [Hazırlıq və problemlərin həlli](../getting-started/installation.md#check-readiness-for-your-task): bir agentin və ya analiz mühərrikinin diaqnostikası.
- [CLI və Evidence](../getting-started/cli.md): əmrlər, provayder seçimi, snapshot-lar, import/export və çıxış statusları.
- [MCP müqavilələri](../reference/mcp-contracts.md) və [agent prompt-ları](../getting-started/mcp-prompts.md): alət nəticələri, sessiyalar və istiqamətləndirilmiş araşdırmalar.
- [Alət kataloqu](../reference/mcp-contracts.md#generated-catalog): alətlərin, provayderlərin və CLI əmrlərinin avtomatik yaradılmış inventarı.

Zəiflikləri [SECURITY.md](../../SECURITY.md) vasitəsilə bildirin.

## İcma və dəstək

- **Discord** — Suallar verin və araşdırdıqlarınızı 50 000-dən çox tərs mühəndis və developerdən ibarət həvəsli icmamızla paylaşın! [![REA Discord-una qoşulun](https://img.shields.io/badge/Join%20Discord-5865F2?style=flat-square&logo=discord&logoColor=white)](https://discord.gg/GkcryMnJDM)
- **Twitter / X** — Yeniliklər və elanlar üçün [@reatools](https://x.com/reatools) hesabını izləyin.
- **Rəy və ideyalar** — Yeni funksiya və ya hansısa fayl formatı üçün dəstək istəyirsiniz? [GitHub-da issue açın](https://github.com/morluto/rea/issues) və ya [Discord-umuza qoşulub](https://discord.gg/GkcryMnJDM) bizə bildirin.

## Ulduz tarixçəsi

🎉 **400 000 GitHub ulduzu — təşəkkür edirik!**

REA-dan istifadə edən, xətalar barədə məlumat verən, funksiya tələb edən, build-ləri test edən və düzəlişlərlə töhfə verən hər kəsə təşəkkürlər.

<a href="https://rea.tools/contributors/">
  <img src="../../website/public/contributors/avatars.png" alt="REA töhfəçiləri" />
</a>

<a href="https://www.star-history.com/?repos=morluto%2Frea&amp;type=date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=morluto/rea&amp;type=date&amp;theme=dark&amp;legend=top-left" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=morluto/rea&amp;type=date" />
    <img alt="REA GitHub ulduz tarixçəsi" src="https://api.star-history.com/chart?repos=morluto/rea&amp;type=date" />
  </picture>
</a>

## Töhfə vermək

REA-ya köməyinizi məmnuniyyətlə qəbul edirik! Xəta bildirmək və ya funksiya təklif etmək üçün
[issue açın](https://github.com/morluto/rea/issues), kodu və ya sənədləri təkmilləşdirmək üçün isə
[pull request göndərin](https://github.com/morluto/rea/pulls).

İnkişaf mühitinin qurulması və yoxlamalar üçün [CONTRIBUTING.md](../../CONTRIBUTING.md) faylına baxın.
Yoxlama mərhələləri üçün [test bələdçisinə](../development/testing.md) baxın.

## Məsuliyyətdən imtina

Məsuliyyətli istifadə qaydaları üçün [DISCLAIMER.md](../../DISCLAIMER.md) faylına baxın.

Layihənin qanunsuz və ya icazəsiz istifadəyə dair mövqeyi bütün REA versiyalarını,
yayım kanallarını və platformaları əhatə edir; hər bir nüsxə tətbiq olunan lisenziyalarını saxlayır.

REA qanuni tədqiqat, təhsil, qarşılıqlı uyğunluq, proqram təminatının qorunması
və sizə məxsus olan və ya araşdırmağa icazəniz olan proqram təminatının analizi üçündür.

## Lisenziya

[MIT](../../LICENSE)

REA tərəfindən yazılmış kod MIT lisenziyası altındadır. Üçüncü tərəf materialları
öz lisenziyalarını və müəllif hüququ bildirişlərini saxlayır; asılılıq inventarı,
qorunan lisenziya mətnləri və xarici alət şərtləri üçün
[Üçüncü tərəf bildirişləri](../../THIRD_PARTY_NOTICES.md) sənədinə baxın.

**IDA Pro / Hex-Rays dekompilyatorları, Hopper və JEB daxil olmaqla kommersiya alətlərini
qanuni yolla əldə etməli və onların tətbiq olunan lisenziyaları çərçivəsində istifadə etməyə
icazəniz olmalıdır.** REA heç bir alət lisenziyası, açar və ya aktivləşdirmə hüququ vermir.
Sınaq və demo versiyalar istifadəçi, funksiya, avtomatlaşdırma və çıxışın paylaşılması
məhdudiyyətləri daxil olmaqla, təchizatçı şərtlərinə tabedir. Sındırılmış nüsxələr, oğurlanmış
açarlar, açarların icazəsiz paylaşılması və lisenziya məhdudiyyətlərinin yan keçilməsinə icazə
verilmir. Bu təlimat MIT və ya üçüncü tərəf lisenziyalarını dəyişdirmir.
