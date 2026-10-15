// Runs in the meeting page's own JavaScript world (registered by the background
// worker for world MAIN at document_start, before the page asks for a mic), so
// it sees the page's own mic requests. It records the label of each mic the
// page opens on <html data-meeting-capture-mic> and announces changes with a
// `meeting-capture:mic` event; the content script relays it so the recording
// captures the same mic the meeting uses. Labels, unlike device ids, are the
// same in every origin.
(() => {
  const media = navigator.mediaDevices;
  if (!media?.getUserMedia || media.getUserMedia.meetingCaptureHook) return;
  const original = media.getUserMedia.bind(media);
  const hooked = (constraints) => {
    const request = original(constraints);
    request.then(
      (stream) => {
        const label = stream.getAudioTracks()[0]?.label;
        if (!label) return;
        document.documentElement.dataset.meetingCaptureMic = label;
        document.dispatchEvent(new CustomEvent('meeting-capture:mic'));
      },
      () => {},
    );
    return request;
  };
  hooked.meetingCaptureHook = true;
  media.getUserMedia = hooked;
})();
