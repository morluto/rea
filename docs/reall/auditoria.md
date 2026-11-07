# Auditoría de Reall y prioridades de mejora

Fecha de revisión: 28 de octubre de 2026 (Argentina).
Base revisada: `9060c93cbc87c867d116c675e143eb12b322b31b`.

## Conclusión

El aporte del fork está definido: convertir las herramientas de REA en un
flujo de producto con proyectos, modelos, costos, permisos e interfaz bilingüe.
La base permite una demostración honesta. Para llegar a un público menos técnico,
la siguiente inversión debería concentrarse en instalación, interpretación de
resultados y recuperación ante errores, antes que en agregar más proveedores.

«Más accesible» es una meta razonable. «Sin conocimientos técnicos», «verificado
automáticamente» o «clona cualquier app» no describen lo que hoy se puede garantizar.

## Alcance y validación

Esta revisión cubre el diferencial del fork: `studio/`, README, integración con
el motor, scripts de inicio, almacenamiento, permisos, costos y configuración
visible de CI. Se comparó `src/`, `tests/` y `scripts/` contra la base upstream
`0cd7ef456`: no hay diferencias en esos directorios.

Comprobaciones ejecutadas en esta revisión:

- `cd studio && npm run typecheck`: aprobado en todos los paquetes.
- `cd studio && npm test`: 24 pruebas aprobadas en 4 archivos; incluye REA real
  con un modelo simulado. No mide la calidad de un proveedor de IA real.
- `cd studio && npm audit --omit=dev --json`: 0 vulnerabilidades reportadas en
  dependencias de producción en el momento de la consulta. No es una auditoría
  completa de seguridad ni cubre las dependencias de desarrollo o el árbol raíz.
- Reproducción aislada con dos instancias de `StudioStore` sobre una base temporal:
  la recuperación del segundo store cambió un trabajo `running` a `failed`.
  No se iniciaron comandos del modelo ni se tocaron proyectos del usuario.
- `npm run docs:check`: no pasó la paridad de enlaces entre el README raíz y
  las 22 traducciones heredadas. Se reprodujo el mismo incumplimiento sobre el
  README anterior (`9060c93cb`) en una carpeta temporal. No es un fallo nuevo
  de ejecución ni se oculta como check aprobado.
- Lectura de flujos y configuración de CI; las observaciones de rendimiento
  son inferencias del código, no resultados de una prueba de carga.

Para preparar el video, `npm run studio` compiló los paquetes y la web e inició
el servidor. Se capturaron Inicio, Configuración, Crear proyecto y Consumo con
el navegador; no se generó código con una API comercial para esa presentación.
También se verificaron los destinos locales de los enlaces de la documentación.
Las pruebas de navegador de funcionalidades de turnos anteriores no se presentan
como nuevas pruebas de esta auditoría. No se repitió toda la batería de REA
upstream. No se certificó Docker, el arranque
en una Mac limpia, los proveedores comerciales ni la reconstrucción nativa/Android.

## Hallazgos

### 1. Alta: «Completado» puede confundirse con «verificado»

**Observado en código:** [`pipeline.ts`](../../studio/packages/agent/src/pipeline.ts)
marca `succeeded` cuando termina el bucle de fases sin excepción o cancelación.
La existencia del informe es opcional. No hay una condición estructurada que
exija pruebas aprobadas. [`Locale.tsx`](../../studio/apps/web/components/Locale.tsx)
muestra ese estado como «Completado».

**Impacto:** una persona sin contexto técnico puede interpretar que la salida
funciona, aunque el informe describa pruebas fallidas o pendientes.

**Propuesta:** separar «ejecución terminada» de «resultado verificado», mostrar
pruebas aprobadas/fallidas/no ejecutadas y bloquear la etiqueta «verificado» si
no existe evidencia estructurada. No resolverlo solo cambiando el prompt.

### 2. Alta: una segunda instancia puede alterar trabajos de la primera

**Observado y reproducido en almacenamiento:**
[`worker/src/index.ts`](../../studio/apps/worker/src/index.ts) llama
`failInterruptedJobs()` al iniciar. Ese método en
[`store.ts`](../../studio/packages/core/src/store.ts) marca todos los trabajos
`running` y `waiting_approval` como fallidos, sin identificar al worker dueño.
La reproducción con dos stores cambió 1 trabajo activo a `failed`.

**Impacto:** iniciar Reall dos veces con el mismo `STUDIO_HOME` puede declarar
fallido un trabajo que otro proceso todavía ejecuta. La documentación ya pide
no iniciar dos workers, pero la interfaz no evita ese error.

**Propuesta:** introducir propiedad y exclusión del worker por estado, con
identidad de proceso verificable y recuperación de trabajos solo cuando su dueño
ya no esté vivo. Validar reinicios, cierre, segunda instancia y recuperación.

### 3. Alta: la automatización heredada no valida explícitamente Studio

**Observado en configuración:** no hay referencias a `studio/` en los workflows
revisados. El `package.json` raíz no registra estos workspaces; Studio tiene su
propio manifiesto. `.oxlintrc.json` y `.oxfmtrc.json` excluyen Studio. Sus pruebas
sí existen, pero se ejecutan mediante los comandos dentro de esa carpeta.

**Impacto:** un resultado satisfactorio de los checks de REA no demuestra que la
interfaz, el worker y el agente de Reall pasen sus verificaciones.

**Propuesta:** CI propia de Studio con instalación fijada, build del motor,
typecheck, tests y build web. Incorporar al repositorio las pruebas de navegador
reproducibles de creación de proyecto, permisos, actividad, costos y exportación.
Separar además la validación documental del fork de la paridad de traducciones
de upstream: el checker actual compara todos los enlaces del README principal
contra cada traducción de REA. Esa suposición dejó de cumplirse al incorporar
contenido propio de Reall. Los documentos originales se conservaron; no se
modificaron los scripts de REA para esconder el fallo.

### 4. Media: el primer uso exige demasiadas decisiones técnicas

**Observado:** [`studio.mjs`](../../studio/scripts/studio.mjs) compila y arranca
web y worker. No es un instalador ni un diagnóstico de dependencias por objetivo.
La guía pide terminal, dos instalaciones npm y herramientas externas según el caso.

**Propuesta:** asistente de preparación que verifique Node, carpeta escribible,
conexión del modelo y herramienta requerida para el objetivo, con mensajes de
recuperación concretos. Luego un paquete instalable y una forma visible de saber
qué versión está corriendo. Validar desde cero en macOS, Windows y Linux.

### 5. Media: evidencia disponible no equivale a explicación accesible

**Observado:** [`prompts.ts`](../../studio/packages/agent/src/prompts.ts) pide
citas y separación entre observaciones y decisiones. La UI de
[`JobView.tsx`](../../studio/apps/web/components/JobView.tsx) ofrece eventos,
argumentos, archivos e informe. Las referencias de evidencia aparecen como IDs;
no hay un recorrido estructurado afirmación → evidencia → prueba → resultado.

**Propuesta:** una vista «Qué aprendimos» con hechos observados, inferencias,
desconocidos y enlaces navegables. Para cada acción: qué hará, por qué, qué datos
usará y qué cambió. Explicar las acciones y la evidencia no requiere exponer
razonamientos internos privados del modelo ni inventar motivos que no registró.

### 6. Media: permisos amplios necesitan alcance y resultado visibles

**Observado:** [`JobWizard.tsx`](../../studio/apps/web/components/JobWizard.tsx)
exige elegir modo, sin preselección. El modo completo habilita comandos y
herramientas destructivas y omite revisión de especificación. El ejecutor usa
los permisos del usuario; las reglas de carpetas de las herramientas de archivos
no convierten los comandos de shell en un sandbox.

**Propuesta:** mostrar el modo elegido durante toda la ejecución y resumir los
cambios realizados. Ofrecer más adelante un perfil intermedio: automatizar build
y tests, manteniendo revisión de especificación o acciones fuera del proyecto.
Un aislamiento real por ejecución sería una función adicional, no una propiedad
actual. Mantener la elección explícita del usuario.

### 7. Media: consumo recalculado por cada cliente conectado

**Observado:** [`usageSnapshot`](../../studio/apps/web/lib/usage.ts) carga todos
los trabajos, suma totales y consulta eventos. Cada conexión SSE en
[`usage/events`](../../studio/apps/web/app/api/usage/events/route.ts) repite ese
cálculo cada dos segundos. No se midió una degradación con carga.

**Propuesta:** medir con historiales representativos; si el costo crece,
agregar acumulados incrementales y compartir snapshots entre clientes. Conservar
los tokens sin tarifa como desconocidos y distinguir estimación de facturación.

### 8. Media: identidad pública y mensajes todavía mezclan capas

**Observado:** el README original abría con la marca, instalación npm y casos de
REA; la explicación de Reall estaba debajo. El manifiesto raíz y workflows de
release mantienen nombres y destinos de upstream. Algunos errores del backend
continúan en inglés aunque se elija español.

**Corregido en esta entrega:** README centrado en el fork, autoría explícita,
instrucciones de Reall y referencia upstream plegada; guía breve y textos de anuncio.
La licencia y atribución original se conservan.

**Pendiente:** separar la política de releases de Reall de la de REA y revisar los
workflows heredados antes de habilitar publicación. No reutilizar el paquete
`rea-agents` como si fuera una distribución nueva propia. Centralizar códigos de
error y traducciones orientadas a acciones. Esto no confirma que haya ocurrido
una publicación incorrecta ni una filtración de datos.

## Prioridades de mejora

| Orden | Entrega propuesta                                     | Criterio de aceptación                                                                                        |
| ----- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 1     | Estados de resultado y vista de verificación          | Una ejecución con pruebas fallidas no se muestra como verificada; cada resultado cita su evidencia.           |
| 2     | CI de Studio y propiedad del worker                   | Los cambios del fork corren checks propios; una segunda instancia no altera el trabajo de la primera.         |
| 3     | Primer proyecto guiado con objetivo de ejemplo propio | Una persona nueva completa una tarea pequeña con instrucciones y resultados esperados, sin usar datos reales. |
| 4     | Preflight e información de versión                    | Antes de gastar tokens se detectan dependencias faltantes; el usuario sabe qué checkout/versión está usando.  |
| 5     | «Qué aprendimos» y aprobaciones explicadas            | Cada afirmación distingue observación, inferencia y desconocido; cada permiso describe alcance y efecto.      |
| 6     | Paquete instalable y documentación grabada            | Arranque probado en máquinas limpias y demo reproducible de una función completa, con errores incluidos.      |
| 7     | Historial eficiente y costos comprensibles            | Rendimiento medido con volumen; se informa qué costos están incluidos y cuándo se actualizó la tarifa.        |

Una buena prueba de producto: observar a tres personas que no conozcan REA al
crear su primer proyecto. Medir dónde se detienen, qué creen que significa
«completado» y si pueden encontrar la evidencia de una afirmación. No se realizó
esa prueba de usuarios en esta auditoría.
