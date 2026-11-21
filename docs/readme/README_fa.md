<div align="center" dir="rtl">

[English](../../README.md) · [简体中文](README_zh.md) · [繁體中文](README_zh-TW.md) · [日本語](README_ja.md) · [한국어](README_ko.md) · [Türkçe](README_tr.md) · [Русский](README_ru.md) · [Tiếng Việt](README_vi.md) · [ไทย](README_th.md) · [Deutsch](README_de.md) · [Español](README_es.md) · [Français](README_fr.md) · [Українська](README_uk.md) · [Polski](README_pl.md) · [Português (Brasil)](README_pt-BR.md) · [العربية](README_ar.md) · **فارسی** · [Bahasa Indonesia](README_id.md) · [Italiano](README_it.md)
· [Ελληνικά](README_el.md) · [മലയാളം](README_ml.md) · [Roman Urdu](README_ur-Latn.md) · [Română](README_ro.md) · [Български](README_bg.md)

# REA: مهندسی معکوس هر چیزی

### یک MCP برای مهندسی معکوس فایل‌های باینری، برنامه‌ها و رفتار زمان اجرا.

**قابلیتی دیده‌اید که دوستش دارید؟ سازوکارش را تا سطح باینری درک کنید.**

[![GitHub stars](https://img.shields.io/github/stars/morluto/rea?style=flat-square&logo=github)](https://github.com/morluto/rea/stargazers)
[![Monthly npm downloads](https://img.shields.io/npm/dm/rea-agents?style=flat-square&label=npm%20downloads)](https://www.npmjs.com/package/rea-agents)
[![MIT license](https://img.shields.io/badge/license-MIT-f4c430?style=flat-square)](../../LICENSE)
[![Join the REA Discord](https://img.shields.io/badge/Discord-5865F2?style=flat-square&logo=discord&logoColor=white)](https://discord.gg/GkcryMnJDM)
[![Follow REA on X](https://img.shields.io/badge/X-000000?style=flat-square&logo=x&logoColor=white)](https://x.com/reatools)
[![Supported platforms: macOS, Windows, and Linux](https://img.shields.io/badge/macOS%20%7C%20Windows%20%7C%20Linux-4493F8?style=flat-square)](../getting-started/installation.md)
[![skills.sh](https://skills.sh/b/morluto/rea?style=flat-square)](https://skills.sh/morluto/rea/reverse-engineer-anything)

**[وب‌سایت](https://rea.tools/fa/) · [راهنماها](https://rea.tools/fa/guides/) · [نمونه‌های عملی](https://rea.tools/fa/showcase/)**

<a href="https://discord.com/invite/GkcryMnJDM"><img alt="به انجمن REA در دیسکورد بپیوندید" src="https://img.shields.io/badge/Join%20us%20on%20Discord-5865F2?style=for-the-badge&logo=discord&logoColor=white" height="40"></a>

[شروع سریع](#شروع-سریع) · [نمونه‌های عملی](#نمونه‌های-عملی) · [REA چگونه کار می‌کند؟](#rea-چگونه-کار-می‌کند) · [چه چیزهایی را میتوان تحلیل کرد؟](#چه-چیزهایی-را-می‌توان-تحلیل-کرد) · [ساخت محیط‌های RL](#build-rl-environments) · [پرسش‌های متداول](#پرسش‌های-متداول) · [مستندات](#مستندات)

<code>npx rea-agents setup</code>

</div>

> [!IMPORTANT]
> منابع رسمی REA: [morluto/rea](https://github.com/morluto/rea), [rea.tools](https://rea.tools/), [rea-agents](https://www.npmjs.com/package/rea-agents) (npm).
> از پیوندهای نصب و انتشار در این منابع رسمی استفاده کنید. نام مشابه مخزن یا README کپی‌شده ثابت نمی‌کند که فایل دانلودی رسمی است.

<div align="center" dir="rtl">

<br />

<img src="../assets/rea-hopper-analysis.png" alt="اجرای پل تحلیل REA در Hopper هنگام بررسی یک فایل باینری بومی" width="1200" />

<br /><br />

<table aria-label="انجمن REA"><tr><td align="center" width="360"><a href="https://discord.gg/GkcryMnJDM"><img    src="../assets/discord.svg" height="42" alt="Discord" /><br /><strong>به انجمن مهندسی معکوس بپیوندید</strong></a><br /><sub>دیسکورد · پرسش و پاسخ · نمایش دستاوردها</sub></td></tr></table>

<br />

</div>

---

<div dir="rtl">

قابلیتی در یک برنامه دیده‌اید که می‌خواهید در محصول خودتان داشته باشید؟ از ایجنت خود بخواهید با REA آن را بررسی کند. ایجنت می‌تواند بدون دسترسی به کد منبع برنامه، نحوهٔ کار قابلیت را بررسی و توضیح دهد، شواهد را نشان دهد و نسخه‌ای مشابه برای پروژهٔ شما بسازد.

REA ایجنت شما را به ابزارهایی برای بررسی باینری‌های بومی، برنامه‌های JavaScript و Electron، اسمبلی‌های .NET و وب‌سایت‌ها متصل می‌کند. همین ابزارها از ترمینال نیز قابل استفاده‌اند. تحلیل به‌صورت محلی انجام می‌شود و نتایج شامل شواهد و محدودیت‌های پشت هر نتیجه‌گیری هستند.

راه‌اندازی، REA را در ایجنت ثبت و دستورالعمل‌های متناظر را نصب می‌کند. تحلیل بومی می‌تواند از Hopper، Ghidra، IDA یا Kuna موجود استفاده کند؛ نصب Hopper پس از تأیید شما ممکن است. تحلیل ایستای JavaScript به موتور تحلیل بومی نیاز ندارد.

## شروع سریع

**[شروع سریع · rea.tools](https://rea.tools/fa/get-started/)**

### ایجنت خود را راه‌اندازی کنید (MCP)

پس از نصب [Node.js و npm](../reference/supported-targets.md)، دستور زیر را از پوشه‌ای قابل اعتماد خارج از پروژه‌ای که می‌خواهید تحلیل کنید اجرا کنید.

```bash
npx rea-agents setup
```

ایجنت‌های موردنظر را انتخاب کنید، تغییرات پیشنهادی را بررسی و تأیید کنید. فرایند راه‌اندازی، سرور MCP مربوط به REA و دستورالعمل‌های گردش‌کار متناظر را اضافه می‌کند و از پیکربندی موجود نسخهٔ پشتیبان می‌گیرد. پس از آن ایجنت خود را مجدداً راه‌اندازی کنید.

[نصب و راه‌اندازی](../getting-started/installation.md)

از ایجنت خود بپرسید:

```text
بررسی کن جست‌وجو در برنامهٔ Notes چگونه کار می‌کند، شواهدش را نشان بده و قابلیتی مشابه برای پروژهٔ من بساز.
```

به‌جای Notes، نام برنامهٔ هدف و قابلیتی را قرار دهید که می‌خواهید درک کنید.

### استفاده از ترمینال (CLI)

برای بررسی پوشهٔ استخراج‌شدهٔ یک برنامهٔ JavaScript/Electron یا فایل ASAR:

```bash
npx -y rea-agents@latest analyze-javascript-application /absolute/path/to/app --json
```

نتیجه شامل ماژول‌ها، importها، مرزهای Electron و شواهد مربوط به آن‌هاست. مسیر را با مسیر برنامهٔ هدف جایگزین کنید؛ مثلاً در ویندوز `"D:/apps/example"`.

برای نصب دستور `rea` جهت استفادهٔ مداوم:

```bash
npm install --global rea-agents
rea --help
```

برای تحلیل بومی ابتدا یک ارائه‌دهنده پیکربندی کنید. برای دستورات بومی، انتخاب ارائه‌دهنده، snapshotها و اسکریپت‌نویسی، [راهنمای CLI و شواهد](../getting-started/cli.md) را ببینید.

[پیش‌نیازهای لینوکس](../getting-started/installation.md#linux-owned-process-prerequisite)

### به‌روزرسانی REA

برای CLI نصب‌شده از طریق `npm install --global` / `bun add --global`:

```bash
rea update
```

اگر از `npx` استفاده می‌کنید، راه‌اندازی ایجنت را با دستور زیر به‌روز کنید:

```bash
npx rea-agents@latest setup
```

[به‌روزرسانی و حذف نصب](../getting-started/installation.md#diagnose-update-and-remove)

## نمونه‌های عملی

<a href="https://rea.tools/fa/showcase/">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../assets/rea-showcases-dark.svg" />
    <img alt="تصویرهایی از نمونه‌های پنینگ صدای DX-Ball، پل کلیپ‌بورد Notion و حلقهٔ گلوله‌های TH04" src="../assets/rea-showcases.svg" />
  </picture>
</a>

<table>
<tbody>
<tr><td>
<h3>DX-Ball: بازسازی محاسبهٔ موقعیت استریوی صدا</h3>
<p>یک فراخوانی صوتی را تا تابع کمکی تبدیل موقعیت به pan دنبال کنید، دستورالعمل‌ها را بررسی کنید و شبه‌کد ناقص را به C تبدیل کنید. بازسازی حاصل، هر ۳٬۲۰۵ مورد آزمایش x86 اصلی را با موفقیت پشت سر می‌گذارد و هر ۶۳ بایت تابع کامپایل‌شده را دقیقاً بازتولید می‌کند.</p>
<p><a href="https://rea.tools/fa/showcase/dx-ball/">مطالعهٔ موردی</a> · <a href="https://github.com/N0zoM1z0/dx-ball">مخزن بازسازی</a></p>
</td></tr>
<tr><td>
<h3>Notion: ردیابی پل کلیپ‌بورد Electron</h3>
<p>API کلیپ‌بورد در renderer را پیدا کنید، مسیر آن را از preload و IPC تا فرایند اصلی دنبال کنید و قالب غنی کلیپ‌بورد را بررسی کنید.</p>
<p><a href="https://rea.tools/fa/showcase/notion/">مطالعهٔ موردی</a></p>
</td></tr>
<tr><td>
<h3>TH04: بازیابی محاسبهٔ حلقهٔ گلوله در DOS</h3>
<p>دستورالعمل‌های ۱۶بیتی بازی اصلی PC-98 را بررسی کنید، محاسبات زاویهٔ ثابت و هدف‌گیری‌شده را بازیابی کنید و کد C++ بازسازی‌شده را با خروجی کامپایلر تاریخی مقایسه کنید.</p>
<p><a href="https://rea.tools/fa/showcase/th04/">مطالعهٔ موردی</a> · <a href="https://github.com/N0zoM1z0/th04">مخزن بازسازی</a></p>
</td></tr>
</tbody>
</table>

اگر از REA برای بررسی موضوع جالبی استفاده کرده‌اید، خوشحال می‌شویم آن را به اشتراک بگذارید. یک [issue](https://github.com/morluto/rea/issues) یا [pull request](https://github.com/morluto/rea/pulls) ثبت کنید و هدف، پرسش خود، نقش REA و یافته‌هایتان را توضیح دهید.

## REA چگونه کار می‌کند؟

ایجنت شما از طریق MCP، REA را فراخوانی می‌کند تا هدف را بررسی و کد مرتبط را ردیابی کند. REA یافته‌ها را همراه با شواهد برمی‌گرداند. ایجنت از این نتایج برای طرح پرسش‌های تکمیلی، توضیح رفتار یا نوشتن و آزمایش یک پیاده‌سازی استفاده می‌کند. دستورات CLI نیز از همین گردش‌کارها بهره می‌برند.

![جریان بررسی REA: ایجنت دربارهٔ هدف محلی سؤال می‌پرسد، REA آن را با ابزارهای تحلیل بررسی و ردیابی می‌کند و ایجنت از کد، ارجاعات و ناشناخته‌های بازگردانده‌شده برای توضیح، پیاده‌سازی و آزمایش استفاده می‌کند.](../../website/public/assets/figures/rea-investigation-flow.svg)

[نمایش تصویر در اندازهٔ کامل](../../website/public/assets/figures/rea-investigation-flow.svg).

<a id="current-status"></a>

## چه چیزهایی را می‌توان تحلیل کرد؟

باینری‌های بومی · JavaScript / Electron · وب‌سایت‌ها · اسمبلی‌های .NET · فایل‌های APK اندروید · Firmware · رفتار فرایند

[قالب‌های پشتیبانی‌شده و پیش‌نیازها](../reference/supported-targets.md)

<a id="choosing-a-deep-analysis-provider"></a>

[انتخاب ابزار تحلیل](../reference/supported-targets.md#choosing-a-deep-analysis-provider)

<a id="build-rl-environments"></a>

## ساخت محیط‌های RL

از یک نشست وب ضبط‌شده یا یک برنامهٔ دسکتاپ لینوکس محیطی محلی بسازید تا ایجنت بتواند کاری را تمرین کند و نتیجه‌اش را بررسی کند.

[ساخت محیط‌های RL](https://rea.tools/guides/rl-environments/)

## پرسش‌های متداول

<details><summary><strong>کدام ایجنت‌ها می‌توانند از REA استفاده کنند؟</strong></summary>

هر ایجنتی که از سرورهای MCP محلی پشتیبانی کند. فرایند setup، [ایجنت‌های پشتیبانی‌شده](../getting-started/installation.md#supported-agents) را پیکربندی می‌کند؛ سایر کلاینت‌ها می‌توانند از [ثبت دستی MCP](../getting-started/installation.md#mcp-registry) استفاده کنند.

</details>

<details><summary><strong>آیا به Hopper، Ghidra، IDA یا Kuna نیاز دارم؟</strong></summary>

تحلیل عمیق بومی به یکی از آن‌ها نیاز دارد. بررسی ایستای JavaScript و .NET بدون موتور تحلیل بومی کار می‌کند. setup می‌تواند با تأیید شما Hopper را نصب کند؛ Ghidra، IDA و Kuna از نصب‌های موجود شما استفاده می‌کنند. [راه‌اندازی ارائه‌دهنده](../getting-started/installation.md#hopper) را ببینید.

</details>

<details><summary><strong>آیا باید ابتدا Hopper را اجرا کنم؟</strong></summary>

REA زمانی که عملیاتی به Hopper نیاز داشته باشد آن را اجرا می‌کند. در macOS، ممکن است هنگام نخستین اجرا پنجره‌ای برای انتخاب حالت آزمایشی یا فعال‌سازی مجوز نمایش داده شود. [راه‌اندازی Hopper و رفع اشکال](../getting-started/installation.md#launcher-paths-and-troubleshooting) را ببینید.

</details>

<details><summary><strong>نصب skill از skills.sh چه کاری انجام می‌دهد؟</strong></summary>

این skill دستورالعمل‌های بررسی را برای ایجنت فراهم می‌کند. برای ثبت سرور MCP مربوط به REA و نصب دستورالعمل‌های متناظر، `npx rea-agents setup` را اجرا کنید و سپس ایجنت را مجدداً راه‌اندازی کنید. [نصب مستقل skill](../getting-started/installation.md#skill-only-installation) را ببینید.

</details>

<details><summary><strong>REA چه نوع کدی برمی‌گرداند؟</strong></summary>

تحلیل بومی، شبه‌کد و اسمبلی برمی‌گرداند. تحلیل JavaScript/Electron ماژول‌ها و روابط میان آن‌ها را بازیابی می‌کند. ایجنت شما از این یافته‌ها برای نوشتن و آزمایش یک پیاده‌سازی استفاده می‌کند؛ [نمونه‌های عملی](#نمونه‌های-عملی) مثال‌های گام‌به‌گام ارائه می‌دهند.

</details>

<details><summary><strong>آیا REA برنامهٔ من را آپلود می‌کند؟</strong></summary>

REA اهداف را به‌صورت محلی تحلیل می‌کند. ایجنت شما نتایج ابزارها را دریافت می‌کند و ارائه‌دهندهٔ مدل آن سیاست مستقل خود را دربارهٔ داده‌ها دارد.

</details>

<details><summary><strong>اگر با خطا مواجه شدم چه کنم؟</strong></summary>

ابتدا به‌روزرسانی کنید؛ ممکن است مشکل در نسخه‌ای جدید رفع شده باشد.

برای CLI نصب‌شده با npm:

```bash
rea update
```

برای راه‌اندازی ایجنت با `npx`:

```bash
npx rea-agents@latest setup
```

اگر از ایجنت استفاده می‌کنید، [به‌روزرسانی راه‌اندازی](#به‌روزرسانی-rea) را تکمیل و ایجنت را مجدداً اجرا کنید. همان کار را دوباره امتحان کنید. اگر مشکل ادامه داشت، یک [issue ثبت کنید](https://github.com/morluto/rea/issues) و نسخهٔ REA، نوع هدف، مراحل بازتولید و خروجی خطا را ذکر کنید.

</details>

## مستندات

از [راهنماهای عملی وب‌سایت](https://rea.tools/fa/guides/) شروع کنید. برای گزینه‌های دقیق، پیش‌نیازها و قراردادهای خروجی:

- [نصب و راه‌اندازی](../getting-started/installation.md): ثبت ایجنت، پیکربندی ارائه‌دهنده، به‌روزرسانی و حذف نصب.
- [آمادگی و رفع اشکال](../getting-started/installation.md#check-readiness-for-your-task): عیب‌یابی یک ایجنت یا موتور تحلیل.
- [CLI و شواهد](../getting-started/cli.md): دستورات، انتخاب ارائه‌دهنده، snapshotها، ورود/خروج داده و وضعیت‌های خروج.
- [قراردادهای MCP](../reference/mcp-contracts.md) و [پرامپت‌های ایجنت](../getting-started/mcp-prompts.md): نتایج ابزارها، نشست‌ها و بررسی‌های هدایت‌شده.
- [فهرست ابزارها](../reference/mcp-contracts.md#generated-catalog): فهرست تولیدشده هنگام build از ابزارها، ارائه‌دهندگان و دستورات CLI.

آسیب‌پذیری‌ها را از طریق [SECURITY.md](../../SECURITY.md) گزارش کنید.

## جامعه و پشتیبانی

- **Discord** — پرسش‌ها و یافته‌های خود را با جامعهٔ ما در میان بگذارید؛ بیش از ۵۰ هزار نفر که به مهندسی معکوس و ساخت پروژه‌های تازه علاقه دارند! [![Discord](https://img.shields.io/badge/Join%20Discord-5865F2?style=flat-square&logo=discord&logoColor=white)](https://discord.gg/GkcryMnJDM)
- **Twitter / X** — برای دریافت خبرها [@reatools](https://x.com/reatools) را دنبال کنید.
- **بازخورد و پیشنهادها** — قابلیت تازه‌ای می‌خواهید یا به پشتیبانی از قالب فایل خاصی نیاز دارید؟ در [GitHub](https://github.com/morluto/rea/issues) یا [Discord](https://discord.gg/GkcryMnJDM) به ما بگویید.

## تاریخچهٔ ستاره‌ها

🎉 **۴۰۰٬۰۰۰ ستارهٔ GitHub — سپاسگزاریم!**

از همهٔ کسانی که از REA استفاده می‌کنند، خطاها را گزارش می‌دهند، قابلیت‌های جدید پیشنهاد می‌کنند، buildها را آزمایش می‌کنند و در بهبود پروژه مشارکت دارند سپاسگزاریم.

<a href="https://rea.tools/fa/contributors/">
  <img src="https://contrib.rocks/image?repo=morluto/rea&amp;max=500&amp;columns=30" alt="مشارکت‌کنندگان REA" />
</a>

<a href="https://www.star-history.com/?repos=morluto%2Frea&amp;type=date"><picture><source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=morluto/rea&amp;type=date&amp;theme=dark&amp;legend=top-left" /><source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=morluto/rea&amp;type=date" /><img alt="تاریخچهٔ ستاره‌های GitHub پروژهٔ REA" src="https://api.star-history.com/chart?repos=morluto/rea&amp;type=date" /></picture></a>

## مشارکت

از کمک شما به REA استقبال می‌کنیم! برای گزارش خطا یا پیشنهاد قابلیت، یک [issue باز کنید](https://github.com/morluto/rea/issues) یا برای بهبود کد و مستندات [pull request بفرستید](https://github.com/morluto/rea/pulls).

برای راه‌اندازی محیط توسعه و بررسی‌ها، [CONTRIBUTING.md](../../CONTRIBUTING.md)، برای مراحل اعتبارسنجی [آزمایش‌ها](../development/testing.md) را ببینید.

## سلب مسئولیت

برای راهنمای استفادهٔ مسئولانه، [DISCLAIMER.md](../../DISCLAIMER.md) را ببینید.

REA برای پژوهش، آموزش، تعامل‌پذیری، حفظ نرم‌افزار و تحلیل نرم‌افزارهایی است که مالک آن‌ها هستید یا اجازهٔ بررسی آن‌ها را دارید، در چارچوب قانون.

The project's position on illegal or unauthorized use covers all REA
versions, distribution channels, and platforms; each copy retains its
applicable licenses.

## مجوز

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

</div>
