<div align="center">

[English](../../README.md) · [简体中文](README_zh.md) · [繁體中文](README_zh-TW.md) · [日本語](README_ja.md) · [한국어](README_ko.md) · [Türkçe](README_tr.md) · [Русский](README_ru.md) · [Tiếng Việt](README_vi.md) · [ไทย](README_th.md) · [Deutsch](README_de.md) · **Español** · [Français](README_fr.md) · [Українська](README_uk.md) · [Polski](README_pl.md) · [Português (Brasil)](README_pt-BR.md) · [العربية](README_ar.md) · [فارسی](README_fa.md) · [Bahasa Indonesia](README_id.md) · [Italiano](README_it.md)
· [Ελληνικά](README_el.md) · [മലയാളം](README_ml.md) · [Roman Urdu](README_ur-Latn.md) · [Română](README_ro.md) · [Български](README_bg.md)

# REA: Ingeniería inversa de cualquier cosa

### Un solo MCP para la ingeniería inversa de binarios, aplicaciones y comportamiento en ejecución.

**¿Ves una función que te gusta? Entiende cómo funciona, hasta el nivel binario.**

[![GitHub stars](https://img.shields.io/github/stars/morluto/rea?style=flat-square&logo=github)](https://github.com/morluto/rea/stargazers)
[![Monthly npm downloads](https://img.shields.io/npm/dm/rea-agents?style=flat-square&label=npm%20downloads)](https://www.npmjs.com/package/rea-agents)
[![MIT license](https://img.shields.io/badge/license-MIT-f4c430?style=flat-square)](../../LICENSE)
[![Join the REA Discord](https://img.shields.io/badge/Discord-5865F2?style=flat-square&logo=discord&logoColor=white)](https://discord.gg/GkcryMnJDM)
[![Follow REA on X](https://img.shields.io/badge/X-000000?style=flat-square&logo=x&logoColor=white)](https://x.com/reatools)
[![Supported platforms: macOS, Windows, and Linux](https://img.shields.io/badge/macOS%20%7C%20Windows%20%7C%20Linux-4493F8?style=flat-square)](../getting-started/installation.md)
[![skills.sh](https://skills.sh/b/morluto/rea?style=flat-square)](https://skills.sh/morluto/rea/reverse-engineer-anything)

**[Sitio web](https://rea.tools/es/) · [Guías](https://rea.tools/es/guides/) · [Casos prácticos](https://rea.tools/es/showcase/)**

<a href="https://discord.com/invite/GkcryMnJDM"><img alt="Únete a la comunidad de REA en Discord" src="https://img.shields.io/badge/Join%20us%20on%20Discord-5865F2?style=for-the-badge&logo=discord&logoColor=white" height="40"></a>

[Inicio rápido](#inicio-rápido) · [Casos prácticos](#casos-prácticos) · [Cómo funciona REA](#cómo-funciona-rea) · [Qué puedes analizar](#qué-puedes-analizar) · [Crear entornos de RL](#build-rl-environments) · [Preguntas frecuentes](#preguntas-frecuentes) · [Documentación](#documentación)

<code>npx rea-agents setup</code>

</div>

> [!IMPORTANT]
> Fuentes oficiales de REA: [morluto/rea](https://github.com/morluto/rea), [rea.tools](https://rea.tools/), [rea-agents](https://www.npmjs.com/package/rea-agents) (npm).
> Usa los enlaces de instalación y de versiones publicados en estas fuentes oficiales. Un nombre de repositorio parecido o un README copiado no demuestra que una descarga sea oficial.

<div align="center">

<br />

<img src="../assets/rea-hopper-analysis.png" alt="REA inicia su puente de análisis dentro de Hopper mientras inspecciona un binario nativo" width="1200" />

<br /><br />

<table aria-label="Comunidad REA">
<tr>
<td align="center" width="360">
  <a href="https://discord.gg/GkcryMnJDM">
    <img src="../assets/discord.svg" height="42" alt="Discord" /><br />
    <strong>Únete a la comunidad de ingeniería inversa</strong>
  </a><br />
  <sub>Discord · Preguntas y respuestas · Comparte tus resultados</sub>
</td>
</tr>
</table>

<br />

</div>

---

¿Has visto una función en una aplicación que quieres incorporar a tu producto? Pide a tu agente que la investigue con REA. Puede inspeccionar la aplicación sin su código fuente, explicar cómo funciona la función, mostrar las pruebas y crear una versión para tu proyecto.

REA conecta tu agente con herramientas para inspeccionar binarios nativos, aplicaciones JavaScript y Electron, ensamblados .NET y sitios web. También puedes usar las mismas herramientas desde la terminal. El análisis se ejecuta localmente y los resultados incluyen las pruebas y limitaciones que sustentan cada conclusión.

La configuración registra REA con tu agente e instala las instrucciones de trabajo correspondientes. El análisis nativo puede usar Hopper, Ghidra, IDA o Kuna ya instalados; la configuración puede instalar Hopper con tu aprobación. El análisis estático de JavaScript no requiere un motor de análisis nativo.

## Inicio rápido

**[Inicio rápido · rea.tools](https://rea.tools/es/get-started/)**

### Configura tu agente (MCP)

Con [Node.js y npm](../reference/supported-targets.md) instalados, ejecuta este comando desde un directorio de confianza fuera del proyecto que vas a analizar.

```bash
npx rea-agents setup
```

Elige tus agentes, revisa los cambios propuestos y apruébalos. La configuración añade el servidor MCP de REA y las instrucciones de trabajo correspondientes, con copias de seguridad de la configuración existente. Reinicia tu agente al terminar.

[instalación y configuración](../getting-started/installation.md)

Pregunta a tu agente:

```text
Investiga cómo funciona la búsqueda en la aplicación Notes, muéstrame las pruebas y crea una función similar para mi proyecto.
```

Sustituye Notes por la aplicación objetivo y especifica la función que quieres entender.

### Usa la terminal (CLI)

Inspecciona un directorio extraído de una aplicación JavaScript/Electron o un archivo ASAR:

```bash
npx -y rea-agents@latest analyze-javascript-application /absolute/path/to/app --json
```

El resultado incluye módulos, importaciones, límites de Electron y sus pruebas. Sustituye la ruta por la de tu objetivo, por ejemplo `"D:/apps/example"` en Windows.

Para instalar el comando `rea` y usarlo habitualmente:

```bash
npm install --global rea-agents
rea --help
```

Para el análisis nativo, configura primero un proveedor. Consulta la [guía de CLI y Evidence](../getting-started/cli.md) para los comandos nativos, la selección de proveedores, las instantáneas y el uso en scripts.

[Requisitos de Linux](../getting-started/installation.md#linux-owned-process-prerequisite)

### Actualiza REA

Para una CLI instalada mediante `npm install --global` / `bun add --global`:

```bash
rea update
```

Si usas `npx`, actualiza la configuración de tu agente con:

```bash
npx rea-agents@latest setup
```

[Actualización y desinstalación](../getting-started/installation.md#diagnose-update-and-remove)

## Casos prácticos

<a href="https://rea.tools/es/showcase/">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../assets/rea-showcases-dark.svg" />
    <img alt="Ilustraciones de los casos de panoramización de sonido de DX-Ball, el puente del portapapeles de Notion y el anillo de proyectiles de TH04" src="../assets/rea-showcases.svg" />
  </picture>
</a>

<table>
<tbody>
<tr><td>
<h3>DX-Ball: reconstruir un cálculo de panoramización de sonido</h3>
<p>Sigue una llamada de sonido hasta la función auxiliar que convierte la posición en panoramización, inspecciona las instrucciones y transforma el pseudocódigo incompleto en C. La reconstrucción supera 3.205 casos con el x86 original y reproduce los 63 bytes de la función compilada.</p>
<p><a href="https://rea.tools/es/showcase/dx-ball/">Lee el caso práctico</a> · <a href="https://github.com/N0zoM1z0/dx-ball">Repositorio de reconstrucción</a></p>
</td></tr>
<tr><td>
<h3>Notion: seguir el puente del portapapeles de Electron</h3>
<p>Encuentra la API del portapapeles del proceso de renderizado, síguela a través de preload e IPC hasta el proceso principal e inspecciona el formato enriquecido del portapapeles.</p>
<p><a href="https://rea.tools/es/showcase/notion/">Lee el caso práctico</a></p>
</td></tr>
<tr><td>
<h3>TH04: recuperar el cálculo de un anillo de proyectiles en DOS</h3>
<p>Inspecciona las instrucciones de 16 bits del juego original para PC-98, recupera los cálculos de ángulos fijos y dirigidos, y compara el C++ reconstruido con la salida del compilador de la época.</p>
<p><a href="https://rea.tools/es/showcase/th04/">Lee el caso práctico</a> · <a href="https://github.com/N0zoM1z0/th04">Repositorio de reconstrucción</a></p>
</td></tr>
</tbody>
</table>

Si has usado REA para investigar algo interesante, nos gustaría verlo. Comparte tu caso en una [issue](https://github.com/morluto/rea/issues) o una [pull request](https://github.com/morluto/rea/pulls), incluyendo el objetivo, tu pregunta, cómo te ayudó REA y qué encontraste.

## Cómo funciona REA

Tu agente llama a REA mediante MCP para inspeccionar el objetivo y seguir el código relevante. REA devuelve los hallazgos junto con sus pruebas. El agente los utiliza para hacer preguntas de seguimiento, explicar el comportamiento o escribir y probar una implementación. Los comandos de CLI usan los mismos flujos de trabajo.

![Flujo de investigación de REA: tu agente pregunta sobre un objetivo local, REA lo inspecciona y rastrea con herramientas de análisis, y el agente utiliza el código, las referencias y los aspectos desconocidos devueltos para explicar, implementar y probar.](../../website/public/assets/figures/rea-investigation-flow.svg)

[Abre la figura a tamaño completo](../../website/public/assets/figures/rea-investigation-flow.svg).

<a id="current-status"></a>

## Qué puedes analizar

Binarios nativos · JavaScript / Electron · Sitios web · Ensamblados .NET · APK de Android · Firmware · Comportamiento de procesos

[Formatos y requisitos](../reference/supported-targets.md)

<a id="choosing-a-deep-analysis-provider"></a>

[Elegir un proveedor](../reference/supported-targets.md#choosing-a-deep-analysis-provider)

<a id="build-rl-environments"></a>

## Crear entornos de RL

Crea un entorno local a partir de una sesión web grabada o de una aplicación de escritorio Linux para que un agente practique una tarea y compruebe el resultado.

[Crear entornos de RL](https://rea.tools/guides/rl-environments/)

## Preguntas frecuentes

<details>
<summary><strong>¿Qué agentes pueden usar REA?</strong></summary>

Cualquier agente que admita servidores MCP locales. La configuración prepara los [agentes compatibles](../getting-started/installation.md#supported-agents); otros clientes pueden usar el [registro manual de MCP](../getting-started/installation.md#mcp-registry).

</details>

<details>
<summary><strong>¿Necesito Hopper, Ghidra, IDA o Kuna?</strong></summary>

El análisis nativo en profundidad utiliza uno de ellos. La inspección estática de JavaScript y .NET funciona sin un motor de análisis nativo. La configuración puede instalar Hopper después de tu aprobación; Ghidra, IDA y Kuna usan las instalaciones que ya tienes. Consulta [configuración de proveedores](../getting-started/installation.md#hopper).

</details>

<details>
<summary><strong>¿Tengo que iniciar Hopper primero?</strong></summary>

REA inicia Hopper cuando una operación lo necesita. En macOS, puede aparecer un diálogo al iniciarlo por primera vez para elegir el modo de demostración o activar tu licencia. Consulta [inicio de Hopper y resolución de problemas](../getting-started/installation.md#launcher-paths-and-troubleshooting).

</details>

<details>
<summary><strong>¿Qué hace la instalación de la skill desde skills.sh?</strong></summary>

La skill proporciona instrucciones de investigación a tu agente. Usa `npx rea-agents setup` para registrar el servidor MCP de REA e instalar las instrucciones correspondientes; después reinicia tu agente. Consulta [instalación solo de la skill](../getting-started/installation.md#skill-only-installation).

</details>

<details>
<summary><strong>¿Qué código devuelve REA?</strong></summary>

El análisis nativo devuelve pseudocódigo y ensamblador. El análisis de JavaScript/Electron recupera módulos y sus relaciones. Tu agente utiliza estos hallazgos para escribir y probar una implementación; los [casos prácticos](#casos-prácticos) ofrecen ejemplos completos.

</details>

<details>
<summary><strong>¿REA sube mi aplicación?</strong></summary>

REA analiza los objetivos localmente. Tu agente recibe los resultados de las herramientas, y su proveedor de modelos tiene su propia política de datos.

</details>

<details>
<summary><strong>¿Qué debo hacer si encuentro un error?</strong></summary>

Actualiza primero; una versión reciente puede haber solucionado el problema.

Para una CLI instalada mediante npm:

```bash
rea update
```

Para configurar el agente mediante `npx`:

```bash
npx rea-agents@latest setup
```

Si usas un agente, completa la [actualización de la configuración](#actualiza-rea) y reinícialo. Repite la misma tarea. Si el problema continúa, [abre una issue](https://github.com/morluto/rea/issues) con tu versión de REA, el tipo de objetivo, los pasos para reproducirlo y la salida del error.

</details>

## Documentación

Empieza con las [guías prácticas](https://rea.tools/es/guides/) del sitio web. Para opciones exactas, requisitos y contratos de resultados:

- [Instalación y configuración](../getting-started/installation.md): registro de agentes, configuración de proveedores, actualizaciones y desinstalación.
- [Preparación y resolución de problemas](../getting-started/installation.md#check-readiness-for-your-task): diagnóstico de un agente o motor de análisis concreto.
- [CLI y Evidence](../getting-started/cli.md): comandos, selección de proveedores, instantáneas, importación/exportación y estados de salida.
- [Contratos de MCP](../reference/mcp-contracts.md) y [prompts para agentes](../getting-started/mcp-prompts.md): resultados de herramientas, sesiones e investigaciones guiadas.
- [Catálogo de herramientas](../reference/mcp-contracts.md#generated-catalog): inventario de herramientas, proveedores y comandos de CLI generado durante la compilación.

Informa de vulnerabilidades siguiendo [SECURITY.md](../../SECURITY.md).

## Comunidad y ayuda

- **Discord** — Haz preguntas y comparte lo que investigas con nuestra comunidad de más de 50.000 personas apasionadas por la ingeniería inversa y la creación de proyectos. [![Discord](https://img.shields.io/badge/Join%20Discord-5865F2?style=flat-square&logo=discord&logoColor=white)](https://discord.gg/GkcryMnJDM)
- **Twitter / X** — Sigue a [@reatools](https://x.com/reatools) para recibir novedades.
- **Ideas y sugerencias** — ¿Quieres una función o compatibilidad con otro formato? Cuéntanoslo en [GitHub](https://github.com/morluto/rea/issues) o [Discord](https://discord.gg/GkcryMnJDM).

## Historial de estrellas

🎉 **400.000 estrellas en GitHub: ¡gracias!**

Gracias a quienes usan REA, informan de errores, solicitan funciones, prueban compilaciones y contribuyen con correcciones.

<a href="https://rea.tools/es/contributors/">
  <img src="https://contrib.rocks/image?repo=morluto/rea&amp;max=500&amp;columns=30" alt="Colaboradores de REA" />
</a>

<a href="https://www.star-history.com/?repos=morluto%2Frea&amp;type=date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=morluto/rea&amp;type=date&amp;theme=dark&amp;legend=top-left" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=morluto/rea&amp;type=date" />
    <img alt="Historial de estrellas de REA en GitHub" src="https://api.star-history.com/chart?repos=morluto/rea&amp;type=date" />
  </picture>
</a>

## Contribuir

¡Nos encantaría que ayudaras con REA! [Abre una issue](https://github.com/morluto/rea/issues) para comunicar un error o proponer una función, o [envía una pull request](https://github.com/morluto/rea/pulls) para mejorar el código o la documentación.

Consulta [CONTRIBUTING.md](../../CONTRIBUTING.md) para preparar el entorno de desarrollo y las comprobaciones, la [guía de pruebas](../development/testing.md) para los procesos de verificación.

## Aviso legal

Consulta [DISCLAIMER.md](../../DISCLAIMER.md) para obtener orientación sobre el uso responsable.

REA está destinado a la investigación, la educación, la interoperabilidad, la preservación de software y el análisis de software propio o autorizado, dentro de la ley.

The project's position on illegal or unauthorized use covers all REA
versions, distribution channels, and platforms; each copy retains its
applicable licenses.

## Licencia

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
