# Reall en cinco minutos

Reall es el fork de [REA](https://github.com/morluto/rea) desarrollado por
Conra / [Artesia by Conra](https://artesia.ar). Añade una interfaz para organizar
el análisis de una aplicación y pedir una reconstrucción o mejora con IA.

La meta es que puedas seguir el trabajo y tomar decisiones sin conocer cada
herramienta interna. La instalación todavía requiere algunos pasos técnicos:
seguí la [guía de instalación](../../studio/README.md#inicio-local).

## Una primera tarea útil

Elegí una aplicación tuya y una función concreta. Por ejemplo:

> Quiero entender cómo funciona la búsqueda de mi aplicación de notas.
> Documentá qué busca y qué pasa si no encuentra resultados. Después proponé
> una implementación con pruebas para esos comportamientos.

Un alcance pequeño facilita reconocer si el resultado es correcto y controlar
el gasto. Prepará un objetivo de prueba sin datos personales ni credenciales
reales de clientes.

## Del objetivo al resultado

1. **Configuración:** agregá una conexión al proveedor de IA. Una API key es la
   clave que autoriza el uso de ese servicio. También se admiten servidores
   locales compatibles. Las claves se guardan cifradas en la máquina de Reall.
2. **Crear proyecto:** elegí un modelo y una carpeta. Las tarjetas muestran
   tarifas de entrada y salida; el cálculo previo es una estimación por llamada,
   no el precio cerrado del proyecto.
3. **Nueva ejecución:** indicá el objetivo, el acceso, qué parte querés estudiar
   y qué mejora esperás. Un proyecto puede tener varias ejecuciones.
4. **Permisos:** elegí autorizar toda esa ejecución o aprobar los comandos y
   herramientas destructivas paso por paso. La autorización completa también
   permite avanzar de la especificación a la construcción sin revisión.
5. **Actividad:** seguí las fases. La información más nueva aparece primero.
   En el modo con revisión, leé la especificación y aprobala o pedí cambios.
6. **Consumo:** mirá tokens y costos estimados del proyecto. Se actualizan
   después de cada llamada al modelo, no durante cada palabra generada.
7. **Archivos e informe:** explorá los resultados y descargá el ZIP. El código
   queda en la subcarpeta `output/` de la ejecución.

La carpeta elegida está en la máquina que ejecuta Reall. Si abrís una instancia
en un servidor remoto, los archivos no aparecen automáticamente en tu PC.

## Qué significa cada fase

| Fase           | Pregunta que intenta responder     | Qué revisar                                                |
| -------------- | ---------------------------------- | ---------------------------------------------------------- |
| Análisis       | ¿Cómo funciona lo observado?       | `notes/analysis.md` y archivos de `evidence/`.             |
| Especificación | ¿Qué vamos a construir?            | `spec/feature-spec.md`: alcance y comportamiento esperado. |
| Construcción   | ¿Cómo se implementa?               | Código generado en `output/`.                              |
| Verificación   | ¿Qué se probó y con qué resultado? | `spec/verification.md` y pruebas del proyecto.             |
| Informe        | ¿Qué se logró y qué falta?         | `output/REPORT.md`.                                        |

Estos son los archivos previstos por el flujo. Pueden estar incompletos o faltar
si una ejecución falla; tener un archivo no demuestra por sí solo que su
contenido sea correcto.

## Cómo leer un resultado sin confiar a ciegas

Buscá una afirmación concreta, por ejemplo: «la búsqueda ignora mayúsculas».
Revisá qué evidencia cita, si existe una prueba para ese comportamiento y qué
resultado tuvo. Si solo hay una explicación del modelo, tratala como una
conclusión pendiente de comprobar.

**Completado** significa que terminó el flujo. No significa automáticamente
«todos los tests pasaron», «es igual al original» ni «está listo para producción».
En la versión actual, interpretar parte de las evidencias todavía puede requerir
ayuda técnica. Hacer ese paso más claro es una prioridad del proyecto.

## Palabras que vas a encontrar

- **Fork:** una copia de un proyecto que se desarrolla de forma independiente,
  conservando su origen y su licencia.
- **Modelo:** el servicio o programa de IA que interpreta el objetivo y genera respuestas.
- **Token:** una unidad de texto que usan los modelos para medir procesamiento y facturación.
- **Evidencia:** un resultado observado o guardado por una herramienta. Ayuda a
  revisar una afirmación; no garantiza que su interpretación sea correcta.
- **Especificación:** la descripción de lo que se propone construir y comprobar.
- **Worker:** el proceso de Reall que ejecuta los trabajos. Tiene que estar activo.
- **MCP:** el mecanismo con el que el agente usa las herramientas de REA.
  No necesitás configurarlo manualmente para el flujo normal de Reall.

## Si algo no funciona

| Situación                             | Primer paso                                                                                                   |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Veo la interfaz anterior              | Detené el servidor, actualizá el checkout correcto y reiniciá con `npm run studio`.                           |
| El navegador no abre                  | Revisá que el comando haya terminado de compilar y que el puerto mostrado pertenezca a esa misma computadora. |
| El trabajo queda en cola              | Revisá el estado del worker y la terminal donde iniciaste Reall.                                              |
| Pide aprobación                       | Abrí la ejecución y revisá la acción pendiente. Los permisos se eligen al crear cada ejecución.               |
| El costo aparece desconocido          | Configurá la tarifa del modelo. Desconocido no significa gratis.                                              |
| Terminó pero el resultado no funciona | Revisá el informe y la verificación; reducí el alcance y repetí una tarea concreta.                           |

No inicies dos instancias de Reall sobre la misma base de datos. Para guardar una
copia de tu trabajo, preservá las carpetas de los proyectos y el estado de Reall
junto con su clave maestra; consultá la [referencia de datos](../../studio/README.md#datos-y-configuración-de-ejecución).
