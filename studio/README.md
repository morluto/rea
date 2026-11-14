# Reall

**De la observación a la creación. / From observation to creation.**

Reall es una aplicación local para analizar, reconstruir y mejorar aplicaciones
con REA y el modelo que elijas. Construida por
[Artesia by Conra](https://artesia.ar). La interfaz está disponible en español e
inglés. Es un producto independiente basado en [REA](https://github.com/morluto/rea),
conservando su [licencia MIT](../LICENSE) y atribución a upstream.

El objetivo de este fork es hacer las funciones de REA más accesibles y
explicables para un público menos técnico. Para una introducción sin detalles
de implementación, leé la [guía breve](../docs/reall/guia.md). El
[README principal](../README.md) distingue el aporte de Reall del motor original.

REA aporta herramientas de análisis por MCP; no depende de Claude ni llama a un
LLM por sí mismo. Reall añade el agente, las conexiones a proveedores, los
proyectos, la interfaz y el seguimiento del consumo. El motor de upstream en
`src/`, `tests/` y `scripts/` permanece independiente.

## Inicio local

Usá **Node 24.22.1 y npm 11.16.0**, según `.nvmrc` y `packageManager` de la raíz.
Desde el checkout del repositorio:

```sh
npm ci
npm run build:cached
cd studio
npm ci
npm run studio
```

Abrí **http://127.0.0.1:4317**. El launcher compila los paquetes y la interfaz,
genera una sesión local y arranca web + worker. Para desarrollo con recarga:

```sh
npm run dev
```

Ambos comandos usan el mismo estado. No arranques dos workers sobre la misma
base de datos. El launcher debe permanecer abierto mientras haya ejecuciones.
Al actualizar el código, reinicialo para recargar también el worker.

## Tu primer proyecto

1. En **Configuración → Conexiones**, guardá la API key del proveedor. Para
   Ollama o un servidor local sin autenticación, dejá la clave vacía.
2. En **Crear proyecto**, elegí un modelo de tus conexiones guardadas. Las
   tarjetas muestran el ID, contexto y tarifas de entrada y salida en USD por
   millón de tokens. El resumen permite estimar el costo por llamada con la
   cantidad de tokens que esperás usar. También podés usar otro ID y configurar
   su tarifa. Un modelo nuevo debe pasar una
   prueba de conexión y uso de herramientas; esa prueba puede tener costo.
3. Elegí una carpeta local con el explorador o escribiendo su ruta absoluta.
   Reall crea una subcarpeta exclusiva para el proyecto. Cada ejecución guarda
   `input/`, `evidence/`, `notes/`, `spec/`, `output/` y `logs/` dentro de su ID;
   el código generado queda en **`<carpeta>/<proyecto>-<id>/<ejecución>/output/`**.
4. En **Nueva ejecución**, definí objetivo, acceso, alcance, mejoras y presupuesto.
   En Revisar, elegí **Autorizar toda la ejecución** para permitir comandos y
   herramientas durante todas las fases sin nuevas aprobaciones, o **Aprobar
   paso por paso** para decidir antes de cada comando y herramienta destructiva.
   La autorización completa incluye avanzar sin revisión de especificación;
   se aplica solo a esa ejecución. No hay una opción preseleccionada.
   El modelo elegido se conserva. Podés seleccionar explícitamente otro modelo
   guardado para especificación, construcción, verificación e informe.
5. Si elegiste revisar la especificación, aprobala o solicitá cambios. Seguí
   las cinco fases, aprobaciones y eventos en vivo, con los más recientes primero.
   Explorá archivos, comparalos con la ejecución anterior y descargá el ZIP y
   el informe `output/REPORT.md`. Un estado «Completado» indica que terminó el
   flujo; no garantiza que todas las pruebas hayan pasado.
6. **Consumo** muestra tokens, costo estimado, actividad de los últimos 14 días
   en UTC, ejecuciones recientes y estado del worker. Podés filtrar por proyecto
   o consultar el total. Se actualiza por SSE,
   después de cada llamada completada al modelo. No contiene datos de ejemplo.

Si necesitás agregar una conexión mientras creás un proyecto, entrá a
Configuración desde el formulario y volvé con **Continuar con mi proyecto**.
El borrador se conserva en esa pestaña, incluido el modelo elegido; se elimina
cuando se crea el proyecto.

La carpeta elegida pertenece a la máquina que ejecuta Reall. En un entorno en
la nube no es una carpeta de tu computadora; descargá el ZIP o montá un volumen.

## Modelos, costos y preferencias

Proveedores: **OpenAI, Anthropic, Google, OpenRouter, Ollama y endpoints
OpenAI-compatible** como LM Studio o vLLM, siempre que soporten tool calling.
La lista predeterminada incluye GPT-5, GPT-5 mini, GPT-4.1, Claude Sonnet 4.5,
Gemini 2.5 Pro/Flash y Qwen3 Coder local. No se cambia de modelo automáticamente.

El catálogo en [`packages/core/src/pricing.ts`](packages/core/src/pricing.ts)
contiene referencias de precios consultadas el 27/10/2026, con enlaces a sus
fuentes. Las tarifas se guardan junto con cada ejecución para que futuros
cambios no alteren su cálculo. Se consideran tokens en caché y el nivel de
contexto largo de Gemini cuando el proveedor informa esos datos.

Son estimaciones de tokens de texto, no una factura: no incluyen impuestos,
herramientas externas, almacenamiento de caché ni infraestructura local. Las
pruebas de conexión quedan fuera del consumo de ejecuciones. OpenRouter,
endpoints personalizados y modelos sin tarifa se muestran como desconocidos
hasta configurar sus precios; no se presupone que sean gratuitos. Algunos
proveedores pueden omitir estadísticas de uso.

Los presupuestos de tokens y USD se evalúan **al finalizar cada llamada**. La
última llamada puede superar el límite. Para un límite de facturación estricto,
configurá también el proveedor. Configuración permite elegir idioma, carpeta y
modelo predeterminados, pasos por fase, tokens y revisión de especificación.

## Objetivos y dependencias

| Objetivo              | Requisitos                                                                                                                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| JavaScript / Electron | Archivo, ASAR o carpeta local; análisis estático sin motor nativo.                                                                                                                                |
| Web                   | Chrome/Chromium instalado. `STUDIO_BROWSER_PATH` permite elegir el ejecutable.                                                                                                                    |
| Android               | JDK completo y el JAR JADX indicado en las [instrucciones de REA](../docs/installation.md). `REA_JADX_MCP_JAR` debe ser una ruta absoluta. Apktool es opcional para sus herramientas específicas. |
| Binarios nativos      | Tu instalación de Ghidra, Hopper o IDA, configurada según REA. Las capacidades dependen de la plataforma y del proveedor.                                                                         |

Para MFA, elegí **Ya inicié sesión en Chrome** y conectá un navegador con CDP
en loopback. Ejemplo en macOS, con un perfil separado de tu perfil habitual:

```sh
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 \
  --user-data-dir="$TMPDIR/reall-chrome"
```

Iniciá sesión manualmente y mantené esa ventana abierta. Reall no resuelve MFA
ni CAPTCHA. En Docker, el navegador del host no comparte el loopback del
contenedor; usá el modo host de Reall para esa modalidad. El acceso por cookies
acepta un array de cookies exportadas; no importa localStorage.

## Docker

La imagen incluye Chromium, JDK, Apktool, el JADX fijado por REA y toolchains
Rust/Go/Python/C++. Ghidra y los proveedores comerciales se aportan por separado;
consultá la instalación upstream para montarlos y configurar sus variables.

```sh
cd studio
mkdir -p generated
docker compose up --build
```

El puerto se publica únicamente en `127.0.0.1:4317`. La base de datos y la clave
maestra viven en el volumen `reall-state`; `./generated` se monta en
`/data/reall/projects`. Elegí esa ruta en la interfaz para recibir el código en
el host. Para otra carpeta o puerto:

```sh
REALL_CODE_DIR=/ruta/absoluta/a/mis-proyectos REALL_PORT=4318 docker compose up --build
```

Creá antes la carpeta; en Linux debe poder escribirla el usuario del contenedor
(UID 1000). Para Ollama en el host usá
`http://host.docker.internal:11434/api` como endpoint. El contenedor agrupa web y
worker y no aísla un trabajo de otro. No montes el socket de Docker.

## Datos y configuración de ejecución

| Variable                    | Comportamiento                                                                 |
| --------------------------- | ------------------------------------------------------------------------------ |
| `STUDIO_HOME`               | Estado local; por defecto `~/.rea-studio`.                                     |
| `STUDIO_PORT`               | Puerto web; por defecto `4317`.                                                |
| `STUDIO_HOST`               | Dirección de escucha; por defecto `127.0.0.1`.                                 |
| `STUDIO_BROWSER_PATH`       | Ejecutable Chrome/Chromium alternativo.                                        |
| `STUDIO_REA_BIN`            | Launcher REA alternativo; se prefiere el build de este fork.                   |
| `STUDIO_WORKER_CONCURRENCY` | Trabajos simultáneos; por defecto `1`.                                         |
| `STUDIO_MASTER_KEY`         | Clave maestra alternativa; formato explicado en `packages/core/src/crypto.ts`. |

Las API keys y las credenciales del objetivo se cifran con AES-256-GCM. La
clave maestra local tiene permisos `0600`. Al hacer backup, guardá juntos la
base de datos y `master.key`, además de las carpetas de proyectos elegidas.
Las migraciones conservan modelos y trabajos anteriores.

Reall es una aplicación local de un usuario. La sesión local, las comprobaciones
de host/origin y las aprobaciones no sustituyen un sistema de usuarios para
publicarla en Internet. Los comandos autorizados se ejecutan con los permisos
del usuario o contenedor. La evidencia puede contener datos del objetivo,
incluidos cuerpos de respuestas: tratá esos archivos y los ZIP como privados.
Usá objetivos propios o para los que tengas permiso.

## Desarrollo y verificación

```sh
cd studio
npm run typecheck
npm test
npm run build
```

Las pruebas incluyen cifrado, migración de datos anteriores, carpetas de
proyectos, presupuestos, tarifas/caché y un flujo con REA real y modelo simulado.
La validación del navegador cubre configuración, creación de proyecto, elección
de carpeta, las cinco pantallas, aprobación SSE, archivos, informe, ZIP y consumo.
Una prueba con un modelo simulado no verifica la calidad ni compatibilidad de
un proveedor real. Para una validación de reconstrucción completa, configurá tus
proveedores y ejecutá el build, tests y comparación de escenarios del proyecto
generado; revisá los desconocidos y obligaciones pendientes del informe.

La CLI existente continúa disponible:

```sh
node packages/agent/dist/cli.js --help
```

## English quick start

Reall is a local, single-user application for analyzing, rebuilding, and
improving apps with REA and your chosen model. Built by
[Artesia by Conra](https://artesia.ar), independently of upstream REA.

Use Node 24.22.1 / npm 11.16.0. From the repository root, run `npm ci` and
`npm run build:cached`; then run `npm ci` and `npm run studio` inside `studio/`.
Open **http://127.0.0.1:4317** and select **EN**. `npm run dev` starts development
mode with the same worker and state.

Save provider credentials in **Settings**, create a project, select a model
and output folder, and start a run. The wizard covers target, access, scope,
improvements, and review. Explicitly choose full authorization for that run
(commands, tools, and specification progression) or step-by-step approval.
Activity shows the newest events first. Review the specification and approve
actions when your chosen policy requires it. Inspect files and diffs, and
download the report and ZIP. A completed run does not certify that all tests passed. Your selected model persists;
changing the build model requires an explicit selection.

Model cards show exact IDs, context windows, and input/output prices. Use the
per-call estimator to compare costs for your expected token counts. If you
visit Settings to add a connection, your project draft and model choice are
preserved in the same tab until the project is created.

**Usage** reports provider token counts after each completed call, estimated
costs, and a 14-day UTC chart over SSE, with a filter for individual projects
or all projects. Reference rates are USD per million
text tokens; missing rates remain unknown. Budgets are checked after calls and
can be exceeded by the final call. Connection checks are billable and excluded
from run totals. Local compute, taxes, cache storage, and external services are
not included in the estimates.

The output folder belongs to the machine running Reall. Docker Compose mounts
`studio/generated` at `/data/reall/projects`; create that folder before running
`docker compose up --build` from `studio/`. Set `REALL_CODE_DIR` to use another
host directory. State is in a named volume; the HTTP port is loopback-only.

Chrome/Chromium is required for web targets. Android needs the matching JADX
JAR and a full JDK; native binaries need your own Ghidra/Hopper/IDA installation.
The image includes Chromium, JDK, JADX, Apktool and common build toolchains.
MFA uses an existing local Chrome session on a debugging port; use host mode
for a browser running on your desktop. Cookies are supported; localStorage
import is not currently supported.

Credentials are encrypted locally; back up the database together with its
master key. Generated commands use your user's permissions. Reall is not a
multi-user hosted service or a sandbox. Keep evidence and exports private and
only analyze targets you own or are authorized to inspect. Run `npm test`,
`npm run typecheck` and `npm run build` in `studio/` to verify the application.
