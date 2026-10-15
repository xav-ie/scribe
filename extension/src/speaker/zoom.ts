// Zoom web-client active-speaker adapter.
//
// Modeled on AWS Labs' amazon-transcribe-live-meeting-assistant zoom.js
// (selectors verified 2026-04). Zoom's classes are BEM-style and far more stable
// than Meet's: the active speaker's frame gets an `--active` modifier (or the
// speaker-view frame appears), which is a STATIC state we can poll. Which
// container applies depends on the user's layout (speaker / bar / gallery), so
// we check all three.
//
// ⚠️ TUNE ME if Zoom renames these: enable the popup "debug" toggle to log
// diagnostics from the page console.

import type { SpeakerAdapter, SpeakerDiagnostics } from './types';
import { isVisible } from './dom';

// The "this participant is the active speaker" frame, across the three layouts.
const ACTIVE_FRAMES: readonly string[] = [
  '.speaker-active-container__video-frame',
  '.speaker-bar-container__video-frame--active',
  '.gallery-video-container__video-frame--active',
];
const TILE = '.video-avatar__avatar';
const NAME_PRIMARY = '.video-avatar__avatar-footer span[role="none"]';
const NAME_FALLBACK = '.video-avatar__avatar-name';

function nameFrom(scope: Element): string | null {
  const avatar = scope.matches(TILE)
    ? scope
    : (scope.querySelector(TILE) ?? scope.closest(TILE));
  const root = avatar ?? scope;
  const primary = root
    .querySelector<HTMLElement>(NAME_PRIMARY)
    ?.textContent?.trim();
  if (primary) return primary;
  const fallback = root
    .querySelector<HTMLElement>(NAME_FALLBACK)
    ?.textContent?.trim();
  if (fallback) return fallback;
  return (
    root
      .querySelector<HTMLImageElement>('.video-avatar__avatar-img')
      ?.alt?.trim() || null
  );
}

function activeSpeaker(): string | null {
  for (const selector of ACTIVE_FRAMES) {
    for (const el of document.querySelectorAll(selector)) {
      if (isVisible(el)) {
        const name = nameFrom(el);
        if (name) return name;
      }
    }
  }
  return null;
}

export const zoomAdapter: SpeakerAdapter = {
  platform: 'zoom',
  matches: (host) => host.endsWith('zoom.us'),

  start(onSpeaker) {
    const id = setInterval(() => {
      const name = activeSpeaker();
      if (name) onSpeaker(name);
    }, 300);
    return () => clearInterval(id);
  },

  diagnose(): SpeakerDiagnostics {
    const tiles = [...document.querySelectorAll(TILE)].filter(isVisible);
    return {
      tiles: tiles.length,
      names: tiles.map((t) => nameFrom(t) ?? '?'),
      speaking: activeSpeaker(),
    };
  },
};
