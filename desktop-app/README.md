# Centro REA

REA Hub es un prototipo local de escritorio para Windows que agrupa accesos a REA, Claude y GitHub Copilot.

Esta versión no ejecuta herramientas de REA, no lee archivos del equipo, no modifica configuraciones de otros clientes y no combina conversaciones. Los límites de cuenta y uso siguen dependiendo de Anthropic y GitHub. REA es un servidor MCP/herramientas, no un modelo de IA.

Centro REA desactiva la aceleración gráfica para reducir su propio uso de memoria de video. Esto no establece un tope duro para Windows ni limita el uso de GPU de Claude, Copilot u otras aplicaciones.

## Ejecutar desde el código

Necesita Node.js y npm:

```powershell
npm install
npm start
```

## Crear la aplicación independiente

```powershell
npm run dist
```

El ejecutable portable se crea en `dist/`. No está firmado con un certificado de editor.

## Conectar REA a Claude Desktop

La app abre la guía oficial, pero no escribe la configuración. La conexión real se hace con `rea setup --client claude_desktop --dry-run`; revisa el plan y aprueba los cambios antes de ejecutar el setup. La CLI de REA requiere Node.js 24.22.1 o posterior.
