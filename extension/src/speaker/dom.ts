// Small DOM helpers shared by the platform adapters.

// Document Picture-in-Picture isn't in TypeScript's DOM lib yet.
export interface DocumentPictureInPictureEvent extends Event {
  readonly window: Window;
}
interface DocumentPictureInPicture {
  readonly window: Window | null;
  addEventListener(
    type: 'enter',
    listener: (e: DocumentPictureInPictureEvent) => void,
  ): void;
  removeEventListener(
    type: 'enter',
    listener: (e: DocumentPictureInPictureEvent) => void,
  ): void;
}
declare global {
  var documentPictureInPicture: DocumentPictureInPicture | undefined;
}

// When the tab loses focus Meet and Zoom can pop the call out into a Document
// Picture-in-Picture window, moving the tiles and controls into that window's
// own document. Adapters search the page plus that window while it's open.
export function meetingDocuments(): Document[] {
  const pip = globalThis.documentPictureInPicture?.window?.document;
  return pip ? [document, pip] : [document];
}

export function queryAll<E extends Element>(selector: string): E[] {
  return meetingDocuments().flatMap((d) => [
    ...d.querySelectorAll<E>(selector),
  ]);
}

// Nodes in the picture-in-picture window belong to its own realm, where
// `instanceof HTMLElement` is false, so check the shape and use that window's
// getComputedStyle.
export function isVisible(el: Element | null): el is HTMLElement {
  if (!el || !('offsetParent' in el)) return false;
  const view = el.ownerDocument.defaultView ?? globalThis;
  const style = view.getComputedStyle(el);
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

/**
 * Probe the page, any same-origin iframes (the meeting UI may live in one) and
 * an open picture-in-picture window.
 */
export function domProbe(): DomProbe {
  const iframes = [...document.querySelectorAll('iframe')];
  const documents = [probeDocument(document, 'top')];
  const pip = globalThis.documentPictureInPicture?.window?.document;
  if (pip) documents.push(probeDocument(pip, 'pip'));
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
