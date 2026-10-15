// Requests microphone permission from a real extension page (which CAN prompt),
// so the offscreen document can later open the mic without a prompt.

const grant = document.querySelector('#grant') as HTMLButtonElement;
const state = document.querySelector('#state') as HTMLDivElement;

function show(text: string, kind: '' | 'ok' | 'err' | 'pending'): void {
  state.textContent = text;
  state.className = kind;
}

// Reflect the current permission on load, so it's obvious whether a grant is
// even needed.
async function reflectCurrent(): Promise<void> {
  try {
    const status = await navigator.permissions.query({
      name: 'microphone' as PermissionName,
    });
    if (status.state === 'granted') {
      show(
        '✓ Microphone access already granted. You can close this tab.',
        'ok',
      );
    } else if (status.state === 'denied') {
      show(
        '✗ Microphone is blocked for this extension — fix it in chrome://settings/content/microphone, then retry.',
        'err',
      );
    }
  } catch {
    // permissions.query may not support "microphone" everywhere; ignore.
  }
}

grant.addEventListener('click', async () => {
  grant.disabled = true;
  show('Requesting microphone access… (approve the Chrome prompt)', 'pending');
  console.log('[micsetup] requesting getUserMedia({ audio: true })');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const label = stream.getAudioTracks()[0]?.label || 'default device';
    // We only needed the grant; release the device immediately.
    for (const track of stream.getTracks()) track.stop();
    console.log('[micsetup] granted:', label);
    show(
      `✓ Microphone access granted (${label}). You can close this tab.`,
      'ok',
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[micsetup] denied:', message);
    show(
      `✗ ${message} — check the Chrome address-bar mic icon and the OS mic permission for Chrome.`,
      'err',
    );
  } finally {
    grant.disabled = false;
  }
});

// Standalone page script (no imports/exports) — not an ES module, so top-level
// await isn't available; kick the check off as a floating promise instead.
// eslint-disable-next-line unicorn/prefer-top-level-await
reflectCurrent();
