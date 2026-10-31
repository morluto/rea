import RFB from '/novnc/core/rfb.js';
const params = new URLSearchParams(location.search),
  status = document.querySelector('#status');
const rfb = new RFB(
  document.querySelector('#screen'),
  `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/viewer?ticket=${encodeURIComponent(params.get('ticket'))}`,
);
rfb.viewOnly = params.get('mode') !== 'control';
rfb.scaleViewport = true;
rfb.resizeSession = false;
rfb.addEventListener(
  'connect',
  () => (status.textContent = rfb.viewOnly ? 'Live · watching only' : 'Live · human control'),
);
rfb.addEventListener(
  'disconnect',
  () =>
    (status.textContent =
      'Disconnected. Reopen the viewer. Human control remains held until explicit handback.'),
);
rfb.addEventListener(
  'securityfailure',
  () => (status.textContent = 'Viewer authentication failed. Reopen through the Computer panel.'),
);
