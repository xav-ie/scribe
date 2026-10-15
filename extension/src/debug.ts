// Tiny debug helpers. Test/inspection APIs are attached to globalThis so you can
// call them from the DevTools console of each context:
//   - service worker  (chrome://extensions → your ext → "service worker" → Inspect): `scribe`
//   - meeting page     (the meeting tab's console; switch JS context to the
//     content script if needed): `speakerProbe`
// Console logging is gated on the popup's "debug" toggle.

let DEBUG = false;

export function setDebug(value: boolean): void {
  DEBUG = value;
}

export function dlog(...args: unknown[]): void {
  if (DEBUG) console.log(...args);
}

/** Attach a console-callable test API to the current context's global object. */
export function expose(name: string, api: Record<string, unknown>): void {
  (globalThis as unknown as Record<string, unknown>)[name] = api;
}
