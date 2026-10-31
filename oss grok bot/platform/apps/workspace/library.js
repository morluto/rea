import { icon } from './icons.js';

const canPreviewImage = (revision) => revision?.inlineImage === true;
const imageURL = (botId, revisionId) =>
  `/api/bots/${encodeURIComponent(botId)}/artifacts/${encodeURIComponent(revisionId)}/image`;

function ageGroup(value, now) {
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  const created = new Date(value);
  if (!Number.isFinite(created.getTime())) return 'Unknown date';
  if (created >= day) return 'Today';
  const yesterday = new Date(day);
  yesterday.setDate(day.getDate() - 1);
  if (created >= yesterday) return 'Yesterday';
  const week = new Date(day);
  week.setDate(day.getDate() - 7);
  return created >= week ? 'This week' : 'Earlier';
}

// The host owns artifact identity, pin state and immutable revisions. This owner
// keeps only presentation coverage, never a second artifact store.
export function libraryUI(ctx) {
  let rendered = new WeakMap();
  let previewPopup = null,
    previewButton = null,
    previewTimer = null;
  const limits = new Map(),
    pending = new Set();
  function hidePreview() {
    clearTimeout(previewTimer);
    previewTimer = null;
    if (previewPopup?.matches(':popover-open')) previewPopup.hidePopover();
    previewButton?.removeAttribute('aria-describedby');
    previewButton = null;
  }
  function showPreview(button, artifact, revision) {
    hidePreview();
    if (!revision || !button.isConnected || document.querySelector('dialog[open]')) return;
    if (!previewPopup?.isConnected) {
      previewPopup = document.createElement('div');
      previewPopup.id = 'library-hover-preview';
      previewPopup.className = 'library-hover-preview';
      previewPopup.setAttribute('popover', 'manual');
      previewPopup.setAttribute('role', 'tooltip');
      document.querySelector('#app').append(previewPopup);
    }
    const { esc } = ctx;
    const author =
      ['bot', 'account'].includes(revision.publishedBy?.kind) &&
      typeof revision.publishedBy?.name === 'string'
        ? revision.publishedBy.name
        : 'Author unavailable';
    const created = new Date(revision.createdAt);
    const date = Number.isFinite(created.getTime())
      ? created.toLocaleString(undefined, {
          weekday: 'short',
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
        })
      : 'Date unavailable';
    previewPopup.innerHTML = `${canPreviewImage(revision) ? `<img src="${imageURL(revision.botId, revision.id)}" alt=""><p class="library-hover-unavailable" hidden>Image preview unavailable</p>` : `<div class="library-hover-file">${icon('library', 36)}</div>`}<div class="library-hover-metadata"><span class="muted">${canPreviewImage(revision) ? 'Image' : 'File'}</span><strong>${esc(artifact.name)}</strong><small>${esc(author)} &middot; ${esc(date)}</small></div>`;
    const image = previewPopup.querySelector('img');
    if (image) {
      const unavailable = previewPopup.querySelector('.library-hover-unavailable');
      image.onerror = () => {
        image.hidden = true;
        unavailable.hidden = false;
      };
    }
    previewPopup.showPopover();
    const bounds = button.getBoundingClientRect(),
      size = previewPopup.getBoundingClientRect();
    const left = Math.max(8, Math.min(bounds.left, innerWidth - size.width - 8));
    let top = bounds.top - size.height - 8;
    if (top < 8) top = Math.min(bounds.bottom + 8, innerHeight - size.height - 8);
    previewPopup.style.left = `${left}px`;
    previewPopup.style.top = `${Math.max(8, top)}px`;
    previewButton = button;
    button.setAttribute('aria-describedby', previewPopup.id);
  }
  document.addEventListener('pointerdown', hidePreview, true);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') hidePreview();
  });
  window.addEventListener('resize', hidePreview);
  document.addEventListener('scroll', hidePreview, true);
  function render(panel, overview, botId) {
    const { esc, action, api, refresh, upload, search, preview } = ctx;
    const revisions = new Map(overview.revisions.map((r) => [r.id, r]));
    const rows = overview.artifacts.map((artifact) => ({
      artifact,
      revision: revisions.get(artifact.currentRevisionId),
    }));
    const rank = (row) => Number(row.artifact.pinned) || 0;
    rows.sort(
      (a, b) =>
        rank(b) - rank(a) ||
        (b.revision?.createdAt ?? b.artifact.createdAt) -
          (a.revision?.createdAt ?? a.artifact.createdAt) ||
        a.artifact.id.localeCompare(b.artifact.id),
    );
    const limit = limits.get(botId) ?? 20,
      shown = rows.slice(0, limit),
      groups = new Map();
    const signature = JSON.stringify([
      botId,
      limit,
      new Date().toDateString(),
      rows.map(({ artifact: a, revision: r }) => [
        a.id,
        a.revision,
        a.name,
        a.pinned,
        a.currentRevisionId,
        r?.createdAt,
        r?.mediaType,
        r?.inlineImage,
        r?.attachable,
        r?.provenance,
        r?.publishedBy,
      ]),
    ]);
    if (panel.firstElementChild && rendered.get(panel) === signature) return;
    hidePreview();
    rendered.set(panel, signature);
    for (const row of shown) {
      const group = row.artifact.pinned
        ? 'Pinned'
        : ageGroup(row.revision?.createdAt ?? row.artifact.createdAt, Date.now());
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push(row);
    }
    panel.innerHTML = `<div class="library-tools"><button type="button" class="quiet" data-library-search aria-label="Search library">${icon('search', 16)}</button><button type="button" class="quiet" data-library-upload aria-label="Add a library file">${icon('plus', 17)}</button></div><div class="library-groups">${[...groups].map(([group, items]) => `<section><h3>${esc(group)}</h3><ul class="library-list" aria-label="${esc(group)}">${items.map(({ artifact: a, revision: r }) => `<li data-library-item="${a.id}"><button type="button" class="library-open" data-library-open="${a.id}" aria-label="${esc(a.name)}" ${r ? '' : 'disabled'}>${canPreviewImage(r) ? `<img src="${imageURL(botId, r.id)}" alt="" loading="lazy">` : icon('library', 18)}<span>${esc(a.name)}</span></button><details class="library-item-menu"><summary aria-label="More actions for ${esc(a.name)}">&hellip;</summary><div class="library-item-actions"><button type="button" data-library-pin="${a.id}" ${pending.has(a.id) ? 'disabled' : ''}>${a.pinned ? 'Unpin' : 'Pin'}</button><button type="button" data-library-versions="${a.id}" ${r ? '' : 'disabled'}>Versions &amp; details</button><button type="button" data-library-replace="${a.id}">New revision</button>${r ? `<a href="/api/bots/${botId}/artifacts/${r.id}/download">Download original</a>` : '<span role="status">Current revision unavailable</span>'}</div></details></li>`).join('')}</ul></section>`).join('') || '<p class="library-empty">Files and images will appear here.</p>'}</div>${shown.length < rows.length ? `<button type="button" class="quiet library-more" data-library-more>Show more <span class="muted">(${shown.length} of ${rows.length})</span></button>` : ''}`;
    panel.querySelector('[data-library-upload]').onclick = () => upload(undefined, botId);
    panel.querySelector('[data-library-search]').onclick = search;
    const artifact = (id) => overview.artifacts.find((a) => a.id === id);
    for (const button of panel.querySelectorAll('[data-library-open]')) {
      const a = artifact(button.dataset.libraryOpen),
        r = revisions.get(a.currentRevisionId);
      button.onmouseenter = () => {
        clearTimeout(previewTimer);
        previewTimer = setTimeout(() => showPreview(button, a, r), 400);
      };
      button.onfocus = () => showPreview(button, a, r);
      button.onmouseleave = button.onblur = hidePreview;
      button.onclick = action(() => {
        hidePreview();
        return canPreviewImage(r)
          ? imageGallery(r.id, { ...ctx, overview, botId })
          : preview(r.id, overview, botId);
      });
    }
    for (const button of panel.querySelectorAll('[data-library-pin]'))
      button.onclick = action(async () => {
        const a = artifact(button.dataset.libraryPin);
        if (pending.has(a.id)) return;
        pending.add(a.id);
        button.disabled = true;
        try {
          await api(`/bots/${botId}/artifacts/${a.id}/metadata`, {
            pinned: !a.pinned,
            revision: a.revision,
          });
        } finally {
          pending.delete(a.id);
          button.disabled = false;
        }
        await refresh();
      });
    for (const button of panel.querySelectorAll('[data-library-versions]'))
      button.onclick = action(() =>
        preview(artifact(button.dataset.libraryVersions).currentRevisionId, overview, botId),
      );
    for (const button of panel.querySelectorAll('[data-library-replace]'))
      button.onclick = () => upload(artifact(button.dataset.libraryReplace), botId);
    const more = panel.querySelector('[data-library-more]');
    if (more)
      more.onclick = () => {
        limits.set(botId, limit + 20);
        render(panel, overview, botId);
      };
  }
  return {
    render,
    reset() {
      hidePreview();
      previewPopup?.remove();
      previewPopup = null;
      limits.clear();
      pending.clear();
      rendered = new WeakMap();
    },
  };
}

function imageGallery(revisionId, { overview, botId, esc, modal }) {
  const current = new Set(overview.artifacts.map((a) => a.currentRevisionId));
  const images = overview.revisions.filter((r) => current.has(r.id) && canPreviewImage(r));
  let index = images.findIndex((r) => r.id === revisionId);
  if (index < 0) throw Error('The selected image revision is unavailable.');
  modal('Image preview', '<div id="image-gallery-content"></div>', null, undefined, {
    className: 'image-gallery',
  });
  const dialog = document.querySelector('#dialog'),
    content = dialog.querySelector('#image-gallery-content');
  function show(next) {
    index = Math.max(0, Math.min(images.length - 1, next));
    const r = images[index];
    dialog.setAttribute('aria-label', `Media ${index + 1} of ${images.length}`);
    content.innerHTML = `<a class="gallery-download" aria-label="Download media" title="Download media" href="/api/bots/${botId}/artifacts/${r.id}/download">&#8595;</a><div class="gallery-stage"><img class="gallery-image" src="${imageURL(botId, r.id)}" alt="${esc(r.name)}"><p class="gallery-error" hidden role="status">Image could not be displayed. Download the original to inspect it.</p></div><p class="gallery-caption">${esc(r.name)} &middot; ${index + 1} / ${images.length}</p><div class="gallery-thumbnails">${images.map((image, i) => `<button type="button" aria-label="View media ${i + 1} of ${images.length}" ${i === index ? 'aria-current="true"' : ''} data-gallery-index="${i}"><img src="${imageURL(botId, image.id)}" alt="" loading="lazy"></button>`).join('')}</div>`;
    content.querySelector('.gallery-image').onerror = () => {
      content.querySelector('.gallery-error').hidden = false;
    };
    for (const button of content.querySelectorAll('[data-gallery-index]'))
      button.onclick = () => {
        const nextIndex = Number(button.dataset.galleryIndex);
        show(nextIndex);
        content.querySelector(`[data-gallery-index="${nextIndex}"]`).focus();
      };
  }
  dialog.onkeydown = (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    show(
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? images.length - 1
          : index + (event.key === 'ArrowRight' ? 1 : -1),
    );
    content.querySelector(`[data-gallery-index="${index}"]`).focus();
  };
  show(index);
}
