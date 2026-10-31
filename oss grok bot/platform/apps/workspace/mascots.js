export const mascotShapes = [
  ['circle', 'Circle'],
  ['squircle', 'Rounded square'],
  ['star', 'Star'],
  ['hex', 'Hexagon'],
  ['square', 'Square'],
  ['blob', 'Blob'],
  ['diamond', 'Diamond'],
  ['drop', 'Drop'],
];
const states = new Set(['idle', 'working', 'waiting', 'queued']);
const escape = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
export function mascot(bot = {}, size = 'small', decorative = false) {
  const state = states.has(bot.activity?.state) ? bot.activity.state : 'idle',
    color = /^#[\da-f]{6}$/i.test(bot.color ?? '') ? bot.color : '#a9bca6';
  const seed = [...(bot.id ?? bot.name ?? 'Bot')].reduce((n, c) => n + c.charCodeAt(0), 0);
  const shape = mascotShapes.some(([id]) => id === bot.shape)
    ? bot.shape
    : mascotShapes[seed % mascotShapes.length][0];
  const motions = new Set([
    'looking',
    'thinking',
    'writing',
    'reading',
    'celebrating',
    'attention',
    'coding',
  ]);
  const motion = motions.has(bot.activity?.motion) ? bot.activity.motion : 'looking';
  return `<span class="mascot mascot-${size} mascot-${state} motion-${motion} mascot-shape-${shape} mascot-variant-${seed % 3}" data-mascot-key="${escape(bot.id ?? bot.name ?? 'Bot')}:${size}:${decorative}" data-mascot-state="${state}" data-mascot-motion="${motion}" style="--orb-color:${color};--blink-delay:-${seed % 7}s;--idle-delay:${(seed % 5) * 0.3}s" ${decorative ? 'aria-hidden="true"' : `role="img" aria-label="${escape(bot.name ?? 'Bot')}: ${escape(bot.activity?.label ?? 'Idle')}"`}><span class="orb-sparkles"></span><span class="orb-pencil"></span><span class="orb-notes"></span><span class="orb-shadow"></span><span class="orb-travel"><span class="orb-body"></span><span class="orb-roll"><span class="orb-seam"></span><span class="orb-mark"></span><span class="orb-face"><i class="orb-eye"></i><i class="orb-eye"></i><i class="orb-mouth"></i></span><span class="orb-cheek"></span></span></span></span>`;
}
export function renderMascotContainer(container, html) {
  const retained = new Map(
    [...container.querySelectorAll('[data-mascot-key]')].map((element) => [
      element.dataset.mascotKey,
      element,
    ]),
  );
  container.innerHTML = html;
  for (const next of container.querySelectorAll('[data-mascot-key]')) {
    const previous = retained.get(next.dataset.mascotKey);
    if (!previous) continue;
    for (const attribute of [...previous.attributes])
      if (!next.hasAttribute(attribute.name)) previous.removeAttribute(attribute.name);
    for (const attribute of next.attributes)
      if (previous.getAttribute(attribute.name) !== attribute.value)
        previous.setAttribute(attribute.name, attribute.value);
    next.replaceWith(previous);
  }
}
export const wordmark = () =>
  `<span class="workshop-mark" aria-hidden="true"><img class="orbit-mark orbit-mark-dark" src="/orbit-mark-dark.png" alt=""><img class="orbit-mark orbit-mark-light" src="/orbit-mark-light.png" alt=""></span><span>Orbit</span>`;
