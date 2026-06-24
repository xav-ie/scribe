// Small DOM helper shared by the platform adapters.

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
