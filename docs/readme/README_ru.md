<div align="center">

[English](../../README.md) · [简体中文](README_zh.md) · [繁體中文](README_zh-TW.md) · [日本語](README_ja.md) · [한국어](README_ko.md) · [Türkçe](README_tr.md) · **Русский** · [Tiếng Việt](README_vi.md) · [ไทย](README_th.md) · [Deutsch](README_de.md) · [Español](README_es.md) · [Français](README_fr.md) · [Українська](README_uk.md) · [Polski](README_pl.md) · [Português (Brasil)](README_pt-BR.md) · [العربية](README_ar.md) · [فارسی](README_fa.md) · [Bahasa Indonesia](README_id.md) · [Italiano](README_it.md)
· [Ελληνικά](README_el.md) · [മലയാളം](README_ml.md) · [Roman Urdu](README_ur-Latn.md) · [Română](README_ro.md) · [Български](README_bg.md)

# REA: Реверс-инжиниринг чего угодно

### Один MCP для реверс-инжиниринга бинарных файлов, приложений и поведения во время выполнения.

**Нашли интересную функцию? Разберитесь, как она работает, вплоть до двоичного кода.**

[![GitHub stars](https://img.shields.io/github/stars/morluto/rea?style=flat-square&logo=github)](https://github.com/morluto/rea/stargazers)
[![Monthly npm downloads](https://img.shields.io/npm/dm/rea-agents?style=flat-square&label=npm%20downloads)](https://www.npmjs.com/package/rea-agents)
[![MIT license](https://img.shields.io/badge/license-MIT-f4c430?style=flat-square)](../../LICENSE)
[![Join the REA Discord](https://img.shields.io/badge/Discord-5865F2?style=flat-square&logo=discord&logoColor=white)](https://discord.gg/GkcryMnJDM)
[![Follow REA on X](https://img.shields.io/badge/X-000000?style=flat-square&logo=x&logoColor=white)](https://x.com/reatools)
[![Supported platforms: macOS, Windows, and Linux](https://img.shields.io/badge/macOS%20%7C%20Windows%20%7C%20Linux-4493F8?style=flat-square)](../getting-started/installation.md)
[![skills.sh](https://skills.sh/b/morluto/rea?style=flat-square)](https://skills.sh/morluto/rea/reverse-engineer-anything)

**[Сайт](https://rea.tools/ru/) · [Руководства](https://rea.tools/ru/guides/) · [Примеры](https://rea.tools/ru/showcase/)**

<a href="https://discord.com/invite/GkcryMnJDM"><img alt="Присоединяйтесь к сообществу REA в Discord" src="https://img.shields.io/badge/Join%20us%20on%20Discord-5865F2?style=for-the-badge&logo=discord&logoColor=white" height="40"></a>

[Быстрый старт](#быстрый-старт) · [Примеры](#примеры) · [Как работает REA](#как-работает-rea) · [Что можно анализировать](#что-можно-анализировать) · [Создание RL-окружений](#build-rl-environments) · [Частые вопросы](#частые-вопросы) · [Документация](#документация)

<code>npx rea-agents setup</code>

</div>

> [!IMPORTANT]
> Официальные источники REA: [morluto/rea](https://github.com/morluto/rea), [rea.tools](https://rea.tools/), [rea-agents](https://www.npmjs.com/package/rea-agents) (npm).
> Используйте ссылки на установку и выпуски из этих официальных источников. Похожее название репозитория или скопированный README не подтверждают, что скачиваемый файл является официальным.

<div align="center">

<br />

<img src="../assets/rea-hopper-analysis.png" alt="REA запускает мост анализа внутри Hopper при исследовании нативного бинарного файла" width="1200" />

<br /><br />

<table aria-label="Сообщество REA">
<tr>
<td align="center" width="360">
  <a href="https://discord.gg/GkcryMnJDM">
    <img src="../assets/discord.svg" height="42" alt="Discord" /><br />
    <strong>Присоединяйтесь к сообществу реверс-инжиниринга</strong>
  </a><br />
  <sub>Discord · Вопросы и ответы · Обмен результатами</sub>
</td>
</tr>
</table>

<br />

</div>

---

Увидели в приложении функцию, которую хотите добавить в свой продукт? Попросите агента исследовать её с помощью REA. Он может изучить приложение без исходного кода, объяснить работу функции, показать подтверждающие данные и создать подходящую реализацию для вашего проекта.

REA подключает вашего агента к инструментам для исследования нативных бинарных файлов, приложений JavaScript и Electron, сборок .NET и сайтов. Те же инструменты доступны в терминале. Анализ выполняется локально, а результаты содержат данные и ограничения, на которых основан каждый вывод.

Настройка регистрирует REA у агента и устанавливает соответствующие инструкции. Нативный анализ использует установленный Hopper, Ghidra, IDA или Kuna; Hopper можно установить после одобрения. Статическому анализу JavaScript нативный движок не нужен.

## Быстрый старт

**[Быстрый старт · rea.tools](https://rea.tools/ru/get-started/)**

### Настройте агента (MCP)

Установите [Node.js и npm](../reference/supported-targets.md) и выполните команду в доверенном каталоге за пределами исследуемого проекта.

```bash
npx rea-agents setup
```

Выберите агентов, проверьте предлагаемые изменения и подтвердите их. Настройка добавляет MCP-сервер REA и соответствующие рабочие инструкции, сохраняя резервные копии существующих настроек. После этого перезапустите агента.

[установка и настройка](../getting-started/installation.md)

Задайте вопрос агенту:

```text
Исследуй, как работает поиск в приложении Notes, покажи подтверждающие данные и создай похожую функцию для моего проекта.
```

Замените Notes нужным приложением и укажите функцию, которую хотите понять.

### Используйте терминал (CLI)

Исследуйте распакованный каталог приложения JavaScript/Electron или файл ASAR:

```bash
npx -y rea-agents@latest analyze-javascript-application /absolute/path/to/app --json
```

Результат включает модули, импорты, границы Electron и подтверждающие данные. Замените путь своим, например `"D:/apps/example"` в Windows.

Для регулярного использования установите команду `rea`:

```bash
npm install --global rea-agents
rea --help
```

Для нативного анализа сначала настройте провайдер. Нативные команды, выбор провайдера, снимки и работу со скриптами описывает [руководство по CLI и Evidence](../getting-started/cli.md).

[Требования для Linux](../getting-started/installation.md#linux-owned-process-prerequisite)

### Обновите REA

Для CLI, установленного через `npm install --global` / `bun add --global`:

```bash
rea update
```

Если используете `npx`, обновите настройку агента командой:

```bash
npx rea-agents@latest setup
```

[Обновление и удаление](../getting-started/installation.md#diagnose-update-and-remove)

## Примеры

<a href="https://rea.tools/ru/showcase/">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../assets/rea-showcases-dark.svg" />
    <img alt="Иллюстрации примеров панорамирования звука в DX-Ball, моста буфера обмена Notion и кольца пуль в TH04" src="../assets/rea-showcases.svg" />
  </picture>
</a>

<table>
<tbody>
<tr><td>
<h3>DX-Ball: восстановление расчёта звуковой панорамы</h3>
<p>Проследите звуковой вызов до функции, преобразующей координату в значение панорамы, изучите инструкции и превратите неполный псевдокод в C. Восстановленная реализация проходит 3 205 тестов с исходным x86-кодом и воспроизводит все 63 байта скомпилированной функции.</p>
<p><a href="https://rea.tools/ru/showcase/dx-ball/">Прочитать исследование</a> · <a href="https://github.com/N0zoM1z0/dx-ball">Репозиторий реконструкции</a></p>
</td></tr>
<tr><td>
<h3>Notion: исследование моста буфера обмена Electron</h3>
<p>Найдите API буфера обмена в процессе рендеринга, проследите его через preload и IPC до основного процесса и изучите формат буфера обмена с форматированием.</p>
<p><a href="https://rea.tools/ru/showcase/notion/">Прочитать исследование</a></p>
</td></tr>
<tr><td>
<h3>TH04: восстановление расчёта кольца пуль в DOS</h3>
<p>Изучите 16-битные инструкции оригинальной игры для PC-98, восстановите расчёты фиксированных и прицельных углов и сравните восстановленный C++ с выводом компилятора того времени.</p>
<p><a href="https://rea.tools/ru/showcase/th04/">Прочитать исследование</a> · <a href="https://github.com/N0zoM1z0/th04">Репозиторий реконструкции</a></p>
</td></tr>
</tbody>
</table>

Если вы исследовали с REA что-то интересное, поделитесь результатом. Создайте [issue](https://github.com/morluto/rea/issues) или [pull request](https://github.com/morluto/rea/pulls) и укажите цель, ваш вопрос, как помог REA и что удалось узнать.

## Как работает REA

Агент вызывает REA через MCP, чтобы исследовать цель и проследить связанный код. REA возвращает результаты вместе с подтверждающими данными. Агент использует их для уточняющих вопросов, объяснения поведения или написания и тестирования реализации. Команды CLI используют те же рабочие процессы.

![Процесс исследования с REA: агент задаёт вопрос о локальной цели, REA исследует её инструментами анализа, а агент использует возвращённый код, ссылки и неизвестные сведения для объяснения, реализации и тестирования.](../../website/public/assets/figures/rea-investigation-flow.svg)

[Открыть рисунок в полном размере](../../website/public/assets/figures/rea-investigation-flow.svg).

<a id="current-status"></a>

## Что можно анализировать

Нативные бинарные файлы · JavaScript / Electron · Сайты · Сборки .NET · Android APK · Прошивки · Поведение процессов

[Поддерживаемые форматы и требования](../reference/supported-targets.md)

<a id="choosing-a-deep-analysis-provider"></a>

[Выбор средства анализа](../reference/supported-targets.md#choosing-a-deep-analysis-provider)

<a id="build-rl-environments"></a>

## Создание RL-окружений

Создайте локальную среду из записи веб-сеанса или настольного приложения Linux, чтобы агент мог отрабатывать задачу и проверять результат.

[Создание RL-окружений](https://rea.tools/guides/rl-environments/)

## Частые вопросы

<details>
<summary><strong>Какие агенты могут использовать REA?</strong></summary>

Любой агент с поддержкой локальных MCP-серверов. Настройка конфигурирует [поддерживаемых агентов](../getting-started/installation.md#supported-agents); другие клиенты могут использовать [ручную регистрацию MCP](../getting-started/installation.md#mcp-registry).

</details>

<details>
<summary><strong>Нужны ли мне Hopper, Ghidra, IDA или Kuna?</strong></summary>

Углублённый нативный анализ использует один из этих инструментов. Статическое исследование JavaScript и .NET работает без движка нативного анализа. Настройка может установить Hopper после подтверждения; Ghidra, IDA и Kuna используют существующие установки. См. [настройку провайдеров](../getting-started/installation.md#hopper).

</details>

<details>
<summary><strong>Нужно ли сначала запускать Hopper?</strong></summary>

REA запускает Hopper, когда он нужен для операции. В macOS при первом запуске может появиться диалог выбора деморежима или активации лицензии. См. [запуск Hopper и устранение неполадок](../getting-started/installation.md#launcher-paths-and-troubleshooting).

</details>

<details>
<summary><strong>Что даёт установка skill с skills.sh?</strong></summary>

Skill предоставляет агенту инструкции по исследованию. Используйте `npx rea-agents setup`, чтобы зарегистрировать MCP-сервер REA и установить соответствующие инструкции, затем перезапустите агента. См. [установку только skill](../getting-started/installation.md#skill-only-installation).

</details>

<details>
<summary><strong>Какой код возвращает REA?</strong></summary>

Нативный анализ возвращает псевдокод и ассемблер. Анализ JavaScript/Electron восстанавливает модули и их связи. Агент использует эти результаты, чтобы написать и протестировать реализацию; в [примерах](#примеры) показаны практические исследования.

</details>

<details>
<summary><strong>REA загружает моё приложение на сервер?</strong></summary>

REA анализирует цели локально. Ваш агент получает результаты инструментов, а у его поставщика моделей есть собственная политика обработки данных.

</details>

<details>
<summary><strong>Что делать, если я столкнулся с ошибкой?</strong></summary>

Сначала обновитесь: недавний релиз мог уже исправить ошибку.

Для CLI, установленного через npm:

```bash
rea update
```

Для настройки агента через `npx`:

```bash
npx rea-agents@latest setup
```

Если используете агента, завершите [обновление настройки](#обновите-rea) и перезапустите его. Повторите ту же задачу. Если проблема сохраняется, [откройте issue](https://github.com/morluto/rea/issues), указав версию REA, тип цели, шаги воспроизведения и вывод ошибки.

</details>

## Документация

Начните с [практических руководств](https://rea.tools/ru/guides/) на сайте. Точные параметры, требования и контракты результатов описаны здесь:

- [Установка и настройка](../getting-started/installation.md): регистрация агентов, настройка провайдеров, обновление и удаление.
- [Готовность и устранение неполадок](../getting-started/installation.md#check-readiness-for-your-task): диагностика конкретного агента или движка анализа.
- [CLI и Evidence](../getting-started/cli.md): команды, выбор провайдера, снимки, импорт/экспорт и коды завершения.
- [Контракты MCP](../reference/mcp-contracts.md) и [промпты агентов](../getting-started/mcp-prompts.md): результаты инструментов, сеансы и исследования с подсказками.
- [Каталог инструментов](../reference/mcp-contracts.md#generated-catalog): создаваемый при сборке перечень инструментов, провайдеров и команд CLI.

Сообщайте об уязвимостях согласно [SECURITY.md](../../SECURITY.md).

## Сообщество и поддержка

- **Discord** — Задавайте вопросы и делитесь находками в нашем сообществе: более 50 000 участников увлекаются обратной разработкой и создают собственные проекты! [![Discord](https://img.shields.io/badge/Join%20Discord-5865F2?style=flat-square&logo=discord&logoColor=white)](https://discord.gg/GkcryMnJDM)
- **Twitter / X** — Подпишитесь на [@reatools](https://x.com/reatools), чтобы следить за новостями.
- **Отзывы и идеи** — Нужна новая функция или поддержка формата файлов? Напишите нам в [GitHub](https://github.com/morluto/rea/issues) или [Discord](https://discord.gg/GkcryMnJDM).

## История звёзд

🎉 **400 000 звёзд на GitHub — спасибо!**

Спасибо всем, кто использует REA, сообщает об ошибках, предлагает новые функции, тестирует сборки и помогает с исправлениями.

<a href="https://rea.tools/ru/contributors/">
  <img src="https://contrib.rocks/image?repo=morluto/rea&amp;max=500&amp;columns=30" alt="Участники проекта REA" />
</a>

<a href="https://www.star-history.com/?repos=morluto%2Frea&amp;type=date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=morluto/rea&amp;type=date&amp;theme=dark&amp;legend=top-left" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=morluto/rea&amp;type=date" />
    <img alt="История звёзд REA на GitHub" src="https://api.star-history.com/chart?repos=morluto/rea&amp;type=date" />
  </picture>
</a>

## Участие в проекте

Будем рады вашей помощи с REA! [Откройте issue](https://github.com/morluto/rea/issues), чтобы сообщить об ошибке или предложить функцию, либо [отправьте pull request](https://github.com/morluto/rea/pulls) с улучшениями кода или документации.

Настройка среды разработки и проверки описаны в [CONTRIBUTING.md](../../CONTRIBUTING.md), направления проверки — в [руководстве по тестированию](../development/testing.md).

## Отказ от ответственности

Рекомендации по ответственному использованию приведены в [DISCLAIMER.md](../../DISCLAIMER.md).

REA предназначен для законных исследований, обучения, обеспечения совместимости, сохранения программного обеспечения и анализа программ, которыми вы владеете или которые вам разрешено изучать.

The project's position on illegal or unauthorized use covers all REA
versions, distribution channels, and platforms; each copy retains its
applicable licenses.

## Лицензия

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
