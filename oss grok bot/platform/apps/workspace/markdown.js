import { marked } from '/vendor/marked.js';
import DOMPurify from '/vendor/purify.js';
export function markdown(text, context = {}) {
  const fragment = DOMPurify.sanitize(
    marked.parse(String(text ?? ''), { async: false, gfm: true, breaks: true }),
    {
      RETURN_DOM_FRAGMENT: true,
      ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|artifact):|[^a-z]|[a-z+.-]+(?:[^a-z+.: -]|$))/i,
      ALLOWED_TAGS: [
        'p',
        'br',
        'strong',
        'em',
        'del',
        'a',
        'pre',
        'code',
        'blockquote',
        'ul',
        'ol',
        'li',
        'table',
        'thead',
        'tbody',
        'tr',
        'th',
        'td',
        'h1',
        'h2',
        'h3',
        'h4',
        'hr',
      ],
      ALLOWED_ATTR: ['href', 'title'],
    },
  );
  for (const link of fragment.querySelectorAll('a')) {
    const value = link.getAttribute('href') ?? '';
    const artifact = value.match(/^artifact:\/\/([\da-f-]{36})\/?$/i);
    if (artifact) {
      const revisions = (context.revisions ?? []).filter(
        (revision) =>
          revision.id === artifact[1] ||
          (revision.artifactId === artifact[1] && revision.sourceRun === context.runId),
      );
      if (revisions.length === 1 && context.botId) {
        link.href = '#artifact-' + revisions[0].id;
        link.dataset.artifactRevision = revisions[0].id;
      } else link.removeAttribute('href');
    } else if (!/^(https?:|mailto:)/i.test(value)) link.removeAttribute('href');
    else {
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
    }
  }
  const holder = document.createElement('div');
  holder.append(fragment);
  return holder.innerHTML;
}
