// Small DOM helpers shared by the platform adapters.

export function isVisible(el: Element | null): el is HTMLElement {
  if (!(el instanceof HTMLElement)) return false;
  const style = getComputedStyle(el);
  if (
    style.display === 'none' ||
    style.visibility === 'hidden' ||
    style.opacity === '0'
  ) {
    return false;
  }
  // offsetParent is null for display:none and detached nodes — Meet/Zoom hide
  // the indicator/tile this way when not active.
  return el.offsetParent !== null || style.position === 'fixed';
}

/** A compact map of the meeting page, for re-tuning adapter selectors. */
export interface DomProbe {
  frames: { id: string; src: string }[];
  documents: {
    where: string;
    /** Class names that look speaker-related, with how often they occur. */
    classes: [string, number][];
    /** aria-labels mentioning the mic or audio (the mute button lives here). */
    aria: [string, number][];
    /** Short texts of name/footer-classed elements, with their selector. */
    names: string[];
  }[];
}

const PROBE_CLASS =
  /video|avatar|speaker|active|participant|name|tile|gallery|talk|audio|footer/i;
const PROBE_ARIA = /mute|microphone|audio|speak|talk/i;

function top(counts: Map<string, number>, n: number): [string, number][] {
  return [...counts].toSorted((a, b) => b[1] - a[1]).slice(0, n);
}

function probeDocument(
  doc: Document,
  where: string,
): DomProbe['documents'][number] {
  const classes = new Map<string, number>();
  const aria = new Map<string, number>();
  const names = new Set<string>();
  for (const el of doc.querySelectorAll('*')) {
    for (const c of el.classList) {
      if (PROBE_CLASS.test(c)) classes.set(c, (classes.get(c) ?? 0) + 1);
    }
    const label = el.getAttribute('aria-label');
    if (label && PROBE_ARIA.test(label))
      aria.set(label, (aria.get(label) ?? 0) + 1);
    const text = el.textContent?.trim() ?? '';
    if (
      names.size < 40 &&
      text &&
      text.length < 40 &&
      [...el.classList].some((c) => /name|footer/i.test(c))
    ) {
      names.add(
        `${el.tagName.toLowerCase()}.${[...el.classList].join('.')} => ${text}`,
      );
    }
  }
  return {
    where,
    classes: top(classes, 80),
    aria: top(aria, 30),
    names: [...names],
  };
}

/** Probe the page and any same-origin iframes (the meeting UI may live in one). */
export function domProbe(): DomProbe {
  const iframes = [...document.querySelectorAll('iframe')];
  const documents = [probeDocument(document, 'top')];
  for (const f of iframes) {
    try {
      if (f.contentDocument)
        documents.push(probeDocument(f.contentDocument, `iframe#${f.id}`));
    } catch {
      // Cross-origin: listed in frames, contents out of reach.
    }
  }
  return {
    frames: iframes.map((f) => ({ id: f.id, src: f.src.slice(0, 100) })),
    documents,
  };
}
