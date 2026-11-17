const featureCatalog = [
  { title: 'Binarios y código nativo', text: 'Inventario, símbolos, funciones, llamadas y evidencia de análisis.', tags: 'binario native ghidra ida', link: 'rea' },
  { title: 'Android y paquetes', text: 'Inspección estática de APK, manifiestos, recursos y firmas.', tags: 'android apk package', link: 'rea' },
  { title: 'Web, JavaScript y Electron', text: 'Módulos, rutas, bundles, capturas web y aplicaciones empaquetadas.', tags: 'web javascript electron', link: 'rea' },
  { title: 'Aplicaciones Apple y .NET', text: 'Recursos, metadatos, símbolos y límites de componentes.', tags: 'apple swift dotnet managed', link: 'rea' },
  { title: 'Firmware y formatos', text: 'Regiones, archivos, metadatos y estructuras de formatos compatibles.', tags: 'firmware archive format', link: 'rea' },
  { title: 'Observación en ejecución', text: 'Flujos declarados de runtime, procesos, navegador y dispositivos.', tags: 'runtime process browser adb', link: 'rea' },
  { title: 'Evidencia y sesiones', text: 'Conserva procedencia, cobertura, resultados parciales y desconocidos.', tags: 'evidence sessions report', link: 'rea' },
  { title: 'Proveedores y configuración', text: 'Consulta disponibilidad y prepara la configuración local de REA.', tags: 'provider setup configuration', link: 'reaInstall' },
];

const toast = document.getElementById('toast');
let toastTimer;

function showToast(message) {
  toast.textContent = message;
  toast.classList.add('visible');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove('visible'), 3200);
}

function renderFeatures(query = '') {
  const normalizedQuery = query.trim().toLocaleLowerCase('es');
  const matches = featureCatalog.filter((feature) =>
    `${feature.title} ${feature.text} ${feature.tags}`.toLocaleLowerCase('es').includes(normalizedQuery),
  );
  const grid = document.getElementById('featureGrid');
  grid.replaceChildren();

  if (matches.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = 'No hay capacidades que coincidan con esa búsqueda.';
    grid.append(empty);
    return;
  }

  for (const feature of matches) {
    const card = document.createElement('article');
    card.className = 'feature-card';
    const title = document.createElement('h2');
    title.textContent = feature.title;
    const description = document.createElement('p');
    description.textContent = feature.text;
    const button = document.createElement('button');
    button.className = 'text-button';
    button.type = 'button';
    button.dataset.link = feature.link;
    button.textContent = 'Abrir recursos de REA →';
    card.append(title, description, button);
    grid.append(card);
  }
}

function showPage(name) {
  const pageNames = {
    home: 'Inicio',
    features: 'Capacidades de REA',
    connections: 'Conexiones',
  };
  if (!Object.hasOwn(pageNames, name)) return;

  document.querySelectorAll('.page').forEach((page) => {
    const active = page.id === `page-${name}`;
    page.hidden = !active;
    page.classList.toggle('active', active);
  });
  document.querySelectorAll('.nav-item').forEach((button) => {
    const active = button.dataset.page === name;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  document.getElementById('currentSection').textContent = pageNames[name];
}

document.addEventListener('click', async (event) => {
  const pageButton = event.target.closest('[data-page]');
  if (pageButton) {
    showPage(pageButton.dataset.page);
    return;
  }

  const linkButton = event.target.closest('[data-link]');
  if (!linkButton) return;
  try {
    await window.reaHub.openLink(linkButton.dataset.link);
  } catch (error) {
    showToast(`No se pudo abrir el enlace: ${error.message}`);
  }
});

document.getElementById('featureSearch').addEventListener('input', (event) => {
  renderFeatures(event.target.value);
});

renderFeatures();
