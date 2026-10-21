// Which meeting a tab is in, so a recording restarted in the same meeting can
// resume the session instead of starting a second one.

/**
 * The meeting's address as recorded with the session: origin and path only.
 * The query is dropped because Zoom's carries the meeting passcode.
 */
export function meetingUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const { origin, pathname } = new URL(url);
    return origin + pathname;
  } catch {
    return null;
  }
}

/**
 * What makes two recordings the same meeting. Zoom's web client moves between
 * pages of one meeting (/wc/<number>/join, /wc/<number>/start), so for Zoom it
 * is the meeting number; elsewhere the address.
 */
export function meetingKey(url: string | null): string | null {
  if (!url) return null;
  const { hostname, pathname } = new URL(url);
  const zoom = hostname.endsWith('zoom.us')
    ? /\/(\d{9,12})(?:\/|$)/.exec(pathname)?.[1]
    : undefined;
  return zoom ? `zoom:${zoom}` : url.replace(/\/$/, '');
}

// Tab titles that name the client, not the meeting.
const GENERIC_TITLE = /^(?:zoom(?: meeting| workplace)?|(?:google )?meet)$/i;
const MEET_CODE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/;

/**
 * The meeting's name from its tab title: Meet titles the tab "Meet - <name>"
 * (the calendar event's, or the meeting code without one). Null when the title
 * only names the client or the code.
 */
export function meetingTitle(tabTitle: string | undefined): string | null {
  const title = (tabTitle ?? '').replace(/^meet\s*[-–—:]\s*/i, '').trim();
  if (!title || GENERIC_TITLE.test(title) || MEET_CODE.test(title)) return null;
  return title;
}
