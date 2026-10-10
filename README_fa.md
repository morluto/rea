<div align="center" dir="rtl">

[English](README.md) · [简体中文](README_zh.md) · [繁體中文](README_zh-TW.md) · [日本語](README_ja.md) · [한국어](README_ko.md) · [Türkçe](README_tr.md) · [Русский](README_ru.md) · [Tiếng Việt](README_vi.md) · [ไทย](README_th.md) · [Deutsch](README_de.md) · [Español](README_es.md) · [Français](README_fr.md) · [Українська](README_uk.md) · [Polski](README_pl.md) · [Português (Brasil)](README_pt-BR.md) · [العربية](README_ar.md) · **فارسی** · [Bahasa Indonesia](README_id.md) · [Italiano](README_it.md)

# REA: مهندسی معکوس هر چیزی

### یک MCP برای مهندسی معکوس فایل‌های باینری، برنامه‌ها و رفتار زمان اجرا.

**قابلیتی دیده‌اید که دوستش دارید؟ سازوکارش را تا سطح باینری درک کنید.**

[![npm version](https://img.shields.io/npm/v/rea-agents?style=flat-square&color=cb3837)](https://www.npmjs.com/package/rea-agents)
[![CI](https://img.shields.io/github/actions/workflow/status/morluto/rea/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/morluto/rea/actions/workflows/ci.yml)
[![MCP tool catalog](https://img.shields.io/badge/MCP-tool_catalog-5c4ee5?style=flat-square)](docs/mcp-contracts.md#generated-catalog)
[![Node.js requirements](https://img.shields.io/badge/Node.js-requirements-339933?style=flat-square&logo=nodedotjs&logoColor=white)](#current-status)
[![skills.sh](https://skills.sh/b/morluto/rea?style=flat-square)](https://skills.sh/morluto/rea/reverse-engineer-anything)
[![MIT license](https://img.shields.io/badge/license-MIT-f4c430?style=flat-square)](LICENSE)
[![Discord](https://img.shields.io/discord/1556595354999332884?logo=discord&logoColor=white&label=Discord&color=5865F2)](https://discord.gg/GkcryMnJDM)

<a href="https://trendshift.io/repositories/82054?utm_source=repository-badge&amp;utm_medium=badge&amp;utm_campaign=badge-repository-82054" target="_blank" rel="noopener noreferrer"><img src="https://trendshift.io/api/badge/repositories/82054" alt="morluto%2Frea | Trendshift" width="250" height="55" /></a>

**[وب‌سایت](https://rea.tools/) · [راهنماها](https://rea.tools/guides/) · [نمونه‌های عملی](https://rea.tools/showcase/)**

[شروع سریع](#شروع-سریع) · [REA چگونه کار می‌کند؟](#rea-چگونه-کار-میکند) · [چه چیزهایی را میتوان تحلیل کرد؟](#چه-چیزهایی-را-میتوان-تحلیل-کرد) · [نمونه‌های عملی](#نمونههای-عملی) · [پرسش‌های متداول](#پرسشهای-متداول) · [مستندات](#مستندات)

<code>npx rea-agents setup</code>

<br />

<img src="docs/assets/rea-hopper-analysis.png" alt="اجرای پل تحلیل REA در Hopper هنگام بررسی یک فایل باینری بومی" width="1200" />

<br /><br />

<table aria-label="انجمن REA"><tr><td align="center" width="360"><a href="https://discord.gg/GkcryMnJDM"><img    src="docs/assets/discord.svg" height="42" alt="Discord" /><br /><strong>به انجمن مهندسی معکوس بپیوندید</strong></a><br /><sub>دیسکورد · پرسش و پاسخ · نمایش دستاوردها</sub></td></tr></table>

<br />

</div>

---

<div dir="rtl">

قابلیتی در یک برنامه دیده‌اید که می‌خواهید در محصول خودتان داشته باشید؟ از ایجنت خود بخواهید با REA آن را بررسی کند. ایجنت می‌تواند بدون دسترسی به کد منبع برنامه، نحوهٔ کار قابلیت را بررسی و توضیح دهد، شواهد را نشان دهد و نسخه‌ای مشابه برای پروژهٔ شما بسازد.

REA ایجنت شما را به ابزارهایی برای بررسی باینری‌های بومی، برنامه‌های JavaScript و Electron، اسمبلی‌های .NET و وب‌سایت‌ها متصل می‌کند. همین ابزارها از ترمینال نیز قابل استفاده‌اند. تحلیل به‌صورت محلی انجام می‌شود و نتایج شامل شواهد و محدودیت‌های پشت هر نتیجه‌گیری هستند.

فرایند راه‌اندازی، REA را در ایجنت شما ثبت می‌کند و دستورالعمل‌های گردش‌کار متناظر را نصب می‌کند. تحلیل بومی می‌تواند از نصب موجود Hopper یا Ghidra استفاده کند؛ همچنین راه‌اندازی می‌تواند با تأیید شما Hopper را به‌صورت اختیاری نصب کند. تحلیل ایستای JavaScript به هیچ‌یک از این موتورهای تحلیل نیاز ندارد.

> برای دستورالعمل‌های راه‌اندازی، راهنماهای تصویری و مطالعات موردی واقعی، **[به وب‌سایت REA مراجعه کنید](https://rea.tools/)**.

## شروع سریع

### ایجنت خود را راه‌اندازی کنید

پس از نصب Node.js و npm، دستور زیر را اجرا کنید:

```bash
npx rea-agents setup
```

ایجنت‌های موردنظر را انتخاب کنید، تغییرات پیشنهادی را بررسی و تأیید کنید. فرایند راه‌اندازی، سرور MCP مربوط به REA و دستورالعمل‌های گردش‌کار متناظر را اضافه می‌کند و از پیکربندی موجود نسخهٔ پشتیبان می‌گیرد. پس از آن ایجنت خود را مجدداً راه‌اندازی کنید.

راه‌اندازی از Claude Code، Codex، Cursor، Gemini CLI، Grok Build و [ایجنت‌های دیگر](docs/installation.md#supported-agents) پشتیبانی می‌کند. برای پیکربندی ارائه‌دهنده و ثبت دستی MCP، [نصب و راه‌اندازی](docs/installation.md) را ببینید.

### از ایجنت خود بپرسید

```text
بررسی کن جست‌وجو در برنامهٔ Notes چگونه کار می‌کند، شواهدش را نشان بده و قابلیتی مشابه برای پروژهٔ من بساز.
```

به‌جای Notes، نام برنامهٔ هدف و قابلیتی را قرار دهید که می‌خواهید درک کنید.

### استفاده از ترمینال

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

برای تحلیل بومی ابتدا یک ارائه‌دهنده پیکربندی کنید. برای دستورات بومی، انتخاب ارائه‌دهنده، snapshotها و اسکریپت‌نویسی، [راهنمای CLI و شواهد](docs/cli.md) را ببینید.

### به‌روزرسانی REA

REA به‌سرعت تغییر می‌کند و نسخه‌های جدید معمولاً شامل رفع اشکال‌های متعددی هستند. نصب خود را به‌روز نگه دارید.

برای CLI نصب‌شده از طریق npm:

```bash
rea update
```

برای به‌روزرسانی ثبت ایجنت‌ها و skill، دستور setup نمایش‌داده‌شده توسط به‌روزرسانی را اجرا کنید.

اگر از `npx` استفاده می‌کنید، راه‌اندازی ایجنت را با دستور زیر به‌روز کنید:

```bash
npx rea-agents@latest setup
```

تغییرات راه‌اندازی را بررسی کنید و ایجنت را دوباره اجرا کنید. برای اجرای یک‌بارهٔ دستورات CLI، از `npx rea-agents@latest` و سپس دستور موردنظر استفاده کنید.

## REA چگونه کار می‌کند؟

ایجنت شما از طریق MCP، REA را فراخوانی می‌کند تا هدف را بررسی و کد مرتبط را ردیابی کند. REA یافته‌ها را همراه با شواهد برمی‌گرداند. ایجنت از این نتایج برای طرح پرسش‌های تکمیلی، توضیح رفتار یا نوشتن و آزمایش یک پیاده‌سازی استفاده می‌کند. دستورات CLI نیز از همین گردش‌کارها بهره می‌برند.

![جریان بررسی REA: ایجنت دربارهٔ هدف محلی سؤال می‌پرسد، REA آن را با ابزارهای تحلیل بررسی و ردیابی می‌کند و ایجنت از کد، ارجاعات و ناشناخته‌های بازگردانده‌شده برای توضیح، پیاده‌سازی و آزمایش استفاده می‌کند.](website/public/assets/figures/rea-investigation-flow.svg)

[نمایش تصویر در اندازهٔ کامل](website/public/assets/figures/rea-investigation-flow.svg).

<a id="current-status"></a>

## چه چیزهایی را می‌توان تحلیل کرد؟

REA به Node.js 22.x (>=22.19)، 24.x (>=24.11) یا 26+، به‌همراه npm نیاز دارد. ابزارهای اضافی و پشتیبانی سیستم میزبان به نوع هدف بستگی دارند:

| هدف                   | خروجی REA                                                                           | پیش‌نیازها و راهنما                                                                                                              |
| --------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| باینری‌های بومی        | شبه‌کد، اسمبلی، رشته‌ها، نمادها، فراخوانی‌ها و ارجاعات                                 | Hopper، Ghidra یا IDA؛ [تحلیل بومی](https://rea.tools/guides/native/)                                                           |
| ساختار ELF آفلاین      | بخش‌ها، سگمنت‌ها، نمادها و relocationهای اصلی و گزینه‌های احتمالی کاهش آسیب‌پذیری ایستا | pwntools تأمین‌شده توسط فراخواننده روی Linux x64؛ [تشخیص باینری](docs/binary-diagnostics.md)                                     |
| بایت‌کد EVM            | selectorهای dispatch، offsetهای بایتی، آرگومان‌های استنباط‌شده و قابلیت تغییر وضعیت   | دادهٔ خام/hex محلی؛ [راهنمای EVM آفلاین](docs/evm-bytecode.md)                                                                    |
| کرش‌های ثبت‌شدهٔ لینوکس  | یادداشت‌های خام، رجیسترها/سیگنال‌های تمام threadهای ثبت‌شده و گزینه‌های احتمالی نگاشت   | pwntools تأمین‌شده توسط فراخواننده؛ GDB/pwndbg اختیاری؛ [کرش‌های ثبت‌شده](docs/recorded-crashes.md)                                |
| JavaScript / Electron | ماژول‌ها، importها، source mapها، مسیرها، IPC و ارتباط افزونه‌های بومی                | Node.js و npm؛ [تحلیل برنامه](https://rea.tools/guides/javascript/)                                                             |
| وب‌سایت‌ها              | ساختار صفحه، اسکریپت‌ها، مشاهدات شبکه و اسکرین‌شات‌های درخواستی                        | مرورگر مبتنی بر Chrome؛ [تحلیل مرورگر](https://rea.tools/guides/browser/)                                                       |
| داده‌های ضبط‌شدهٔ شبکه   | درخواست‌ها، پاسخ‌ها، payloadهای آشکارشده و مکان آن‌ها در منبع                          | HAR؛ ابزار mitmdump در لینوکس برای ضبط‌های بومی mitmproxy؛ [راهنمای ضبط شبکه](docs/web-network-captures.md)                      |
| اسمبلی‌های .NET        | فراداده، دستورالعمل‌های CIL، وابستگی‌های بومی اعلام‌شده و مقایسهٔ buildها                | بررسی ایستا؛ [راهنمای کد مدیریت‌شده](docs/managed-code-analysis.md)                                                              |
| فایل‌های APK اندروید   | تعاریف Manifest، کلاس‌ها، متدهای دیکامپایل‌شده و ارجاعات                               | JADX بدون رابط گرافیکی و JDK کامل در Linux/macOS؛ [راهنمای اندروید](docs/android-analysis.md)                                   |
| Firmware              | ناحیه‌ها، نتایج استخراج و تحویل به ابزارهای تحلیل بومی                               | Binwalk / Unblob در لینوکس؛ [راهنمای Firmware](docs/firmware-analysis.md)                                                       |
| بسته‌ها و منابع        | فهرست فایل‌ها، digestها، فایل‌های plist، ساختار bundle اپل و منابع استخراج‌شده         | [راهنمای آرتیفکت و JavaScript](docs/javascript-artifact-reconstruction.md)، [برنامه‌های اپل](docs/apple-application-analysis.md) |
| رفتار فرایند          | خروجی ترمینال، تعاملات، وضعیت خروج، مشاهدات سیستم فایل و مقایسهٔ اجراها               | Linux/macOS با PTY بومی؛ [ضبط فرایند](docs/process-capture.md)                                                                  |

بررسی ایستای JavaScript و .NET فایل‌های ارائه‌شده را بدون اجرای برنامه می‌خواند. ضبط زمان اجرا، هدف انتخاب‌شده را با مجوزهای کاربری شما اجرا می‌کند یا با آن تعامل دارد؛ آثار این عملیات در راهنمای مربوط به هر نوع ضبط توضیح داده شده‌اند.

<a id="choosing-a-deep-analysis-provider"></a>

فرمت‌های بومی و پشتیبانی سیستم میزبان بر اساس ارائه‌دهنده متفاوت‌اند. [راه‌اندازی Hopper و Ghidra](docs/installation.md#hopper)، [راهنمای IDA](docs/ida-provider.md) و [پشتیبانی آزمایشی Ghidra در ویندوز](docs/windows-ghidra-p0.md) را ببینید. Ghidra همچنین از [تحلیل DOS شانزده‌بیتی](docs/ghidra-dos.md) پشتیبانی می‌کند. برای انتخاب ارائه‌دهنده، به [راهنمای CLI](docs/cli.md#choose-a-provider) مراجعه کنید. برای قابلیت‌هایی که پس از آخرین انتشار npm اضافه شده‌اند، [وضعیت انتشار](docs/installation.md#released-package-and-main) را بررسی کنید.

## نمونه‌های عملی

[![تصویرهایی از نمونه‌های پنینگ صدای DX-Ball، پل کلیپ‌بورد Notion و حلقهٔ گلوله‌های TH04](docs/assets/rea-showcases.png)](https://rea.tools/showcase/)

### DX-Ball: بازسازی محاسبهٔ موقعیت استریوی صدا

یک فراخوانی صوتی را تا تابع کمکی تبدیل موقعیت به pan دنبال کنید، دستورالعمل‌ها را بررسی کنید و شبه‌کد ناقص را به C تبدیل کنید. بازسازی حاصل، هر ۳٬۲۰۵ مورد آزمایش x86 اصلی را با موفقیت پشت سر می‌گذارد و هر ۶۳ بایت تابع کامپایل‌شده را دقیقاً بازتولید می‌کند.

[مطالعهٔ موردی](https://rea.tools/showcase/dx-ball/) · [مخزن بازسازی](https://github.com/N0zoM1z0/dx-ball)

### Notion: ردیابی پل کلیپ‌بورد Electron

API کلیپ‌بورد در renderer را پیدا کنید، مسیر آن را از preload و IPC تا فرایند اصلی دنبال کنید و قالب غنی کلیپ‌بورد را بررسی کنید.

[مطالعهٔ موردی](https://rea.tools/showcase/notion/)

### TH04: بازیابی محاسبهٔ حلقهٔ گلوله در DOS

دستورالعمل‌های ۱۶بیتی بازی اصلی PC-98 را بررسی کنید، محاسبات زاویهٔ ثابت و هدف‌گیری‌شده را بازیابی کنید و کد C++ بازسازی‌شده را با خروجی کامپایلر تاریخی مقایسه کنید.

[مطالعهٔ موردی](https://rea.tools/showcase/th04/) · [مخزن بازسازی](https://github.com/N0zoM1z0/th04)

اگر از REA برای بررسی موضوع جالبی استفاده کرده‌اید، خوشحال می‌شویم آن را به اشتراک بگذارید. یک [issue](https://github.com/morluto/rea/issues) یا [pull request](https://github.com/morluto/rea/pulls) ثبت کنید و هدف، پرسش خود، نقش REA و یافته‌هایتان را توضیح دهید.

## پرسش‌های متداول

<details><summary><strong>کدام ایجنت‌ها می‌توانند از REA استفاده کنند؟</strong></summary>

هر ایجنتی که از سرورهای MCP محلی پشتیبانی کند. فرایند setup، [ایجنت‌های پشتیبانی‌شده](docs/installation.md#supported-agents) را پیکربندی می‌کند؛ سایر کلاینت‌ها می‌توانند از [ثبت دستی MCP](docs/installation.md#mcp-registry) استفاده کنند.

</details>

<details><summary><strong>آیا به Hopper، Ghidra یا IDA نیاز دارم؟</strong></summary>

تحلیل عمیق بومی به یکی از آن‌ها نیاز دارد. بررسی ایستای JavaScript و .NET بدون موتور تحلیل بومی کار می‌کند. setup می‌تواند با تأیید شما Hopper را نصب کند؛ Ghidra و IDA از نصب‌های موجود شما استفاده می‌کنند. [راه‌اندازی ارائه‌دهنده](docs/installation.md#hopper) را ببینید.

</details>

<details><summary><strong>آیا باید ابتدا Hopper را اجرا کنم؟</strong></summary>

REA زمانی که عملیاتی به Hopper نیاز داشته باشد آن را اجرا می‌کند. در macOS، ممکن است هنگام نخستین اجرا پنجره‌ای برای انتخاب حالت آزمایشی یا فعال‌سازی مجوز نمایش داده شود. [راه‌اندازی Hopper و رفع اشکال](docs/installation.md#launcher-paths-and-troubleshooting) را ببینید.

</details>

<details><summary><strong>نصب skill از skills.sh چه کاری انجام می‌دهد؟</strong></summary>

این skill دستورالعمل‌های بررسی را برای ایجنت فراهم می‌کند. برای ثبت سرور MCP مربوط به REA و نصب دستورالعمل‌های متناظر، `npx rea-agents setup` را اجرا کنید و سپس ایجنت را مجدداً راه‌اندازی کنید. [نصب مستقل skill](docs/installation.md#skill-only-installation) را ببینید.

</details>

<details><summary><strong>REA چه نوع کدی برمی‌گرداند؟</strong></summary>

تحلیل بومی، شبه‌کد و اسمبلی برمی‌گرداند. تحلیل JavaScript/Electron ماژول‌ها و روابط میان آن‌ها را بازیابی می‌کند. ایجنت شما از این یافته‌ها برای نوشتن و آزمایش یک پیاده‌سازی استفاده می‌کند؛ [نمونه‌های عملی](#نمونههای-عملی) مثال‌های گام‌به‌گام ارائه می‌دهند.

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

اگر از ایجنت استفاده می‌کنید، [به‌روزرسانی راه‌اندازی](#بهروزرسانی-rea) را تکمیل و ایجنت را مجدداً اجرا کنید. همان کار را دوباره امتحان کنید. اگر مشکل ادامه داشت، یک [issue ثبت کنید](https://github.com/morluto/rea/issues) و نسخهٔ REA، نوع هدف، مراحل بازتولید و خروجی خطا را ذکر کنید.

</details>

## مستندات

از [راهنماهای عملی وب‌سایت](https://rea.tools/guides/) شروع کنید. برای گزینه‌های دقیق، پیش‌نیازها و قراردادهای خروجی:

- [نصب و راه‌اندازی](docs/installation.md): ثبت ایجنت، پیکربندی ارائه‌دهنده، به‌روزرسانی و حذف نصب.
- [آمادگی و رفع اشکال](docs/installation.md#check-readiness-for-your-task): عیب‌یابی یک ایجنت یا موتور تحلیل.
- [CLI و شواهد](docs/cli.md): دستورات، انتخاب ارائه‌دهنده، snapshotها، ورود/خروج داده و وضعیت‌های خروج.
- [قراردادهای MCP](docs/mcp-contracts.md) و [پرامپت‌های ایجنت](docs/mcp-prompts.md): نتایج ابزارها، نشست‌ها و بررسی‌های هدایت‌شده.
- [فهرست ابزارها](docs/mcp-contracts.md#generated-catalog): فهرست تولیدشده هنگام build از ابزارها، ارائه‌دهندگان و دستورات CLI.
- [نقشهٔ راه](docs/roadmap.md): برنامه‌های آینده و پیگیری قابلیت‌ها.

آسیب‌پذیری‌ها را از طریق [SECURITY.md](SECURITY.md) گزارش کنید.

## تاریخچهٔ ستاره‌ها

🎉 **۵۰٬۰۰۰ ستارهٔ GitHub — سپاسگزاریم!**

از همهٔ کسانی که از REA استفاده می‌کنند، خطاها را گزارش می‌دهند، قابلیت‌های جدید پیشنهاد می‌کنند، buildها را آزمایش می‌کنند و در بهبود پروژه مشارکت دارند سپاسگزاریم.

<a href="https://www.star-history.com/?repos=morluto%2Frea&amp;type=date"><picture><source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=morluto/rea&amp;type=date&amp;theme=dark&amp;legend=top-left" /><source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=morluto/rea&amp;type=date" /><img alt="تاریخچهٔ ستاره‌های GitHub پروژهٔ REA" src="https://api.star-history.com/chart?repos=morluto/rea&amp;type=date" /></picture></a>

## سلب مسئولیت

REA ابزارهایی برای پژوهش، تحلیل و بازسازی قانونی در حوزهٔ مهندسی معکوس فراهم می‌کند. مسئولیت دریافت مجوزهای لازم و رعایت قوانین مربوط بر عهدهٔ شماست. این پروژه استفادهٔ غیرقانونی یا بدون مجوز را تأیید نمی‌کند.

## مشارکت

از کمک شما به REA استقبال می‌کنیم! برای گزارش خطا یا پیشنهاد قابلیت، یک [issue باز کنید](https://github.com/morluto/rea/issues) یا برای بهبود کد و مستندات [pull request بفرستید](https://github.com/morluto/rea/pulls).

برای راه‌اندازی محیط توسعه و بررسی‌ها، [CONTRIBUTING.md](CONTRIBUTING.md)، برای مراحل اعتبارسنجی [آزمایش‌ها](docs/testing.md) و برای ساختار پروژه [نقشهٔ معماری](docs/architecture.mermaid) را ببینید.

## مجوز

[MIT](LICENSE)

</div>
