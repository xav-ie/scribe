// Requests microphone permission from a real extension page (which CAN prompt),
// so the offscreen document can later open the mic without a prompt.

const grant = document.querySelector('#grant') as HTMLButtonElement;
const state = document.querySelector('#state') as HTMLDivElement;

grant.addEventListener('click', async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    // We only needed the grant; release the device immediately.
    for (const t of stream.getTracks()) t.stop();
    state.textContent = '✓ Microphone access granted. You can close this tab.';
    state.className = 'ok';
  } catch (error) {
    state.textContent = `✗ ${error instanceof Error ? error.message : String(error)} — check Chrome's site/OS mic settings.`;
    state.className = 'err';
  }
});
