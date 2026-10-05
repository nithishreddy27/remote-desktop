'use strict';

const $ = (sel) => document.querySelector(sel);

// ===========================================================================
// Settings

const CONFIG = window.RD_CONFIG || {};
const FALLBACK_ICE = [{ urls: 'stun:stun.l.google.com:19302' }];

const DEFAULT_SETTINGS = {
  serverUrl: CONFIG.serverUrl || 'ws://localhost:8080',
  iceServers: '', // extra ICE servers on top of the ones the server provides
  maxBitrateMbps: 8,
  maxFps: 30,
  name: '',
  hideFromCapture: true,
};

const settings = loadSettings();

// Apply the "hide from screen capture" preference as soon as the app loads.
rd.setContentProtection(settings.hideFromCapture);

function loadSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem('rd-settings') || '{}') };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

// Only values that differ from the defaults are stored, so changing a default
// (e.g. the server URL) in a new release reaches existing users too.
function saveSettings() {
  const changed = {};
  for (const [key, value] of Object.entries(settings)) {
    if (value !== DEFAULT_SETTINGS[key]) changed[key] = value;
  }
  try { localStorage.setItem('rd-settings', JSON.stringify(changed)); } catch { /* ignore */ }
}

function userIceServers() {
  try {
    const list = JSON.parse(settings.iceServers);
    if (Array.isArray(list)) return list;
  } catch { /* fall through */ }
  return [];
}

// ICE servers for a session: the server's (incl. short-lived TURN credentials)
// plus any the user configured.
function rtcConfig(serverIce) {
  const list = [...(Array.isArray(serverIce) ? serverIce : []), ...userIceServers()];
  return { iceServers: list.length ? list : FALLBACK_ICE };
}

// ===========================================================================
// Shared helpers

function openSignaling(handlers) {
  return new Promise((resolve, reject) => {
    let ws;
    try {
      ws = new WebSocket(settings.serverUrl);
    } catch {
      reject(new Error(`Invalid server URL: ${settings.serverUrl}`));
      return;
    }
    let opened = false;
    ws.onopen = () => { opened = true; resolve(ws); };
    ws.onerror = () => {
      if (!opened) reject(new Error(`Can't reach the server at ${settings.serverUrl}. Check Settings.`));
    };
    ws.onclose = () => { if (opened && handlers.close) handlers.close(); };
    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      const fn = handlers[msg.type];
      if (fn) fn(msg);
    };
  });
}

function wsSend(ws, msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function closeSocket(ws) {
  if (!ws) return;
  ws.onclose = null;
  ws.onmessage = null;
  try { ws.close(); } catch { /* ignore */ }
}

// Applies an incoming SDP/ICE message to a peer ({ pc, ws, pendingIce }).
async function applySignal(peer, data) {
  const pc = peer.pc;
  if (!pc || !data) return;
  if (data.sdp) {
    await pc.setRemoteDescription(data.sdp);
    for (const c of peer.pendingIce.splice(0)) await pc.addIceCandidate(c).catch(() => {});
    if (data.sdp.type === 'offer') {
      await pc.setLocalDescription(await pc.createAnswer());
      wsSend(peer.ws, { type: 'signal', data: { sdp: pc.localDescription } });
    }
  } else if (data.candidate) {
    if (pc.remoteDescription) await pc.addIceCandidate(data.candidate).catch(() => {});
    else peer.pendingIce.push(data.candidate);
  }
}

function notice(el, text, kind = '') {
  el.textContent = text || '';
  el.className = `notice ${kind}`.trim();
  el.hidden = !text;
}

const FAILED_MSG = 'Connection failed — the two computers could not reach each other directly. '
  + 'Add a TURN server in Settings to connect across restrictive networks.';

// ===========================================================================
// Host: share this screen

const host = {
  ws: null,
  stream: null,
  pc: null,
  dc: null,
  pendingIce: [],
  viewerName: '',
  expiresAt: 0,
  expiryTimer: null,
};

const hostEls = {
  idle: $('#host-idle'),
  waiting: $('#host-waiting'),
  connected: $('#host-connected'),
  footer: $('#host-footer'),
  code: $('#host-code'),
  statusText: $('#host-status-text'),
  expiry: $('#code-expiry'),
  viewerName: $('#viewer-name'),
  allowControl: $('#allow-control'),
  notice: $('#host-notice'),
  shareBtn: $('#share-btn'),
};

function setHostView(view, statusText) {
  hostEls.idle.hidden = view !== 'idle';
  hostEls.waiting.hidden = view !== 'waiting';
  hostEls.connected.hidden = view !== 'connected';
  hostEls.footer.hidden = view === 'idle';
  if (statusText) hostEls.statusText.textContent = statusText;
}

async function startSharing() {
  notice(hostEls.notice, '');
  hostEls.shareBtn.disabled = true;
  try {
    await startSharingInner();
  } finally {
    hostEls.shareBtn.disabled = false;
  }
}

async function startSharingInner() {
  let sources;
  try {
    sources = await rd.getSources();
  } catch (err) {
    notice(hostEls.notice, `Could not list screens: ${err.message}`, 'error');
    return;
  }
  if (!sources.length) {
    notice(hostEls.notice, 'No screens available. On macOS, allow Screen Recording for this app in System Settings.', 'error');
    return;
  }
  const source = sources.length === 1 ? sources[0] : await pickSource(sources);
  if (!source) return;

  try {
    const size = await rd.selectDisplay(source.displayId);
    host.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: source.id,
          maxWidth: size.width,
          maxHeight: size.height,
          maxFrameRate: Number(settings.maxFps),
        },
      },
    });
  } catch (err) {
    rd.stopSharing();
    notice(hostEls.notice, `Could not capture the screen: ${err.message}`, 'error');
    return;
  }
  host.stream.getVideoTracks()[0].onended = () => stopSharing('Screen capture ended.');

  try {
    host.ws = await openSignaling({
      code: (m) => showCode(m.code, m.expiresAt),
      'code-expired': () => wsSend(host.ws, { type: 'host' }),
      'join-request': onJoinRequest,
      'join-cancelled': () => setHostView('waiting', 'Waiting for someone to connect…'),
      paired: (m) => startHostPeer(m.iceServers).catch((err) => endHostSession(`Connection error: ${err.message}`)),
      signal: (m) => applySignal(host, m.data).catch((err) => console.error('[host] signal', err)),
      'peer-left': () => endHostSession('The viewer disconnected.'),
      error: (m) => notice(hostEls.notice, m.message, 'error'),
      close: () => {
        host.ws = null;
        // An established peer-to-peer session survives losing the server.
        if (!host.pc) stopSharing('Lost connection to the server.');
      },
    });
  } catch (err) {
    stopSharing();
    notice(hostEls.notice, err.message, 'error');
    return;
  }

  hostEls.code.textContent = '··· ··· ···';
  setHostView('waiting', 'Requesting a code…');
  wsSend(host.ws, { type: 'host' });

  const input = await rd.inputStatus();
  if (!input.available) {
    notice(hostEls.notice, `Remote control is unavailable on this computer, viewers will only be able to watch. ${input.error || ''}`, 'warn');
  }
}

function formatCode(code) {
  return code.replace(/(\d{3})(?=\d)/g, '$1 ');
}

function showCode(code, expiresAt) {
  hostEls.code.textContent = formatCode(code);
  host.expiresAt = expiresAt;
  setHostView('waiting', 'Waiting for someone to connect…');
  clearInterval(host.expiryTimer);
  const tick = () => {
    const s = Math.max(0, Math.round((host.expiresAt - Date.now()) / 1000));
    hostEls.expiry.textContent = `Code expires in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}. A new one is generated automatically.`;
  };
  tick();
  host.expiryTimer = setInterval(tick, 1000);
}

async function onJoinRequest(m) {
  setHostView('waiting', `${m.name} is asking to connect…`);
  const accept = await rd.confirmViewer(m.name);
  if (!host.ws) return;
  host.viewerName = m.name;
  wsSend(host.ws, { type: 'join-response', requestId: m.requestId, accept });
  if (!accept) setHostView('waiting', 'Waiting for someone to connect…');
}

async function startHostPeer(serverIce) {
  clearInterval(host.expiryTimer);
  setHostView('waiting', `Connecting to ${host.viewerName}…`);
  hostEls.expiry.textContent = '';

  const pc = new RTCPeerConnection(rtcConfig(serverIce));
  host.pc = pc;
  host.pendingIce = [];

  const track = host.stream.getVideoTracks()[0];
  track.contentHint = 'detail'; // favour sharp text over smooth motion
  const sender = pc.addTrack(track, host.stream);

  const dc = pc.createDataChannel('input', { ordered: true });
  host.dc = dc;
  dc.onmessage = (e) => onRemoteInput(e.data);
  dc.onopen = () => sendControlState();
  dc.onclose = () => rd.releaseInput();

  pc.onicecandidate = (e) => {
    if (e.candidate) wsSend(host.ws, { type: 'signal', data: { candidate: e.candidate } });
  };
  pc.onconnectionstatechange = () => {
    if (host.pc !== pc) return;
    if (pc.connectionState === 'connected') {
      hostEls.viewerName.textContent = host.viewerName;
      setHostView('connected');
    } else if (pc.connectionState === 'failed') {
      endHostSession(FAILED_MSG);
    }
  };

  await pc.setLocalDescription(await pc.createOffer());
  await tuneSender(sender);
  wsSend(host.ws, { type: 'signal', data: { sdp: pc.localDescription } });
}

async function tuneSender(sender) {
  try {
    const params = sender.getParameters();
    if (!params.encodings || !params.encodings.length) params.encodings = [{}];
    params.encodings[0].maxBitrate = Number(settings.maxBitrateMbps) * 1e6;
    params.encodings[0].maxFramerate = Number(settings.maxFps);
    params.degradationPreference = 'maintain-resolution';
    await sender.setParameters(params);
  } catch (err) {
    console.warn('[host] setParameters failed', err);
  }
}

function onRemoteInput(raw) {
  let m;
  try { m = JSON.parse(raw); } catch { return; }
  if (!m || typeof m.t !== 'string') return;
  if (m.t === 'hello') {
    rd.setRemotePlatform(String(m.platform));
    return;
  }
  if (!hostEls.allowControl.checked) return;
  rd.sendInput(m);
}

function sendControlState() {
  if (host.dc && host.dc.readyState === 'open') {
    host.dc.send(JSON.stringify({ t: 'control', allowed: hostEls.allowControl.checked }));
  }
}

function closeHostPeer() {
  if (host.dc) { host.dc.onclose = null; host.dc.close(); }
  if (host.pc) host.pc.close();
  host.dc = null;
  host.pc = null;
  rd.releaseInput();
}

// The viewer left (or was kicked): keep sharing and hand out a fresh code.
function endHostSession(reason) {
  closeHostPeer();
  if (!host.ws) {
    stopSharing(reason);
    return;
  }
  wsSend(host.ws, { type: 'leave' });
  if (reason) notice(hostEls.notice, reason);
  hostEls.code.textContent = '··· ··· ···';
  setHostView('waiting', 'Requesting a new code…');
  wsSend(host.ws, { type: 'host' });
}

function stopSharing(reason) {
  closeHostPeer();
  closeSocket(host.ws);
  host.ws = null;
  clearInterval(host.expiryTimer);
  if (host.stream) host.stream.getTracks().forEach((t) => t.stop());
  host.stream = null;
  rd.stopSharing();
  hostEls.allowControl.checked = true;
  setHostView('idle');
  notice(hostEls.notice, reason || '');
}

function pickSource(sources) {
  return new Promise((resolve) => {
    const modal = $('#picker-modal');
    const grid = $('#picker-grid');
    grid.replaceChildren();
    const done = (value) => {
      modal.hidden = true;
      $('#picker-cancel').onclick = null;
      resolve(value);
    };
    for (const s of sources) {
      const btn = document.createElement('button');
      btn.className = 'picker-item';
      const img = document.createElement('img');
      img.src = s.thumbnail;
      img.alt = '';
      const title = document.createElement('strong');
      title.textContent = s.name + (s.primary ? ' (main)' : '');
      const size = document.createElement('small');
      size.textContent = s.size;
      btn.append(img, title, size);
      btn.onclick = () => done(s);
      grid.append(btn);
    }
    $('#picker-cancel').onclick = () => done(null);
    modal.hidden = false;
    grid.firstChild.focus();
  });
}

hostEls.shareBtn.addEventListener('click', startSharing);
$('#stop-btn').addEventListener('click', () => stopSharing());
$('#kick-btn').addEventListener('click', () => endHostSession('You disconnected the viewer.'));
$('#copy-btn').addEventListener('click', async () => {
  const code = hostEls.code.textContent.replace(/\D/g, '');
  if (code.length !== 9) return;
  await navigator.clipboard.writeText(code).catch(() => {});
  const btn = $('#copy-btn');
  btn.textContent = 'Copied';
  setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
});
hostEls.allowControl.addEventListener('change', () => {
  if (!hostEls.allowControl.checked) rd.releaseInput();
  sendControlState();
});

// ===========================================================================
// Viewer: access a computer

const viewer = {
  ws: null,
  pc: null,
  dc: null,
  pendingIce: [],
  hostAllowsControl: true,
  statsTimer: null,
  lastBytes: 0,
  lastStatsAt: 0,
  fullscreen: false,
};

const viewerEls = {
  form: $('#connect-form'),
  name: $('#name-input'),
  code: $('#code-input'),
  connect: $('#connect-btn'),
  cancel: $('#cancel-btn'),
  status: $('#viewer-status'),
  statusText: $('#viewer-status-text'),
  notice: $('#viewer-notice'),
  session: $('#session'),
  surface: $('#surface'),
  video: $('#remote-video'),
  overlay: $('#overlay'),
  overlayText: $('#overlay-text'),
  stats: $('#stats'),
  controlToggle: $('#control-toggle'),
  viewOnly: $('#viewonly-badge'),
  toolbar: $('#toolbar'),
};

viewerEls.name.value = settings.name;

function setViewerBusy(text) {
  const busy = !!text;
  viewerEls.connect.disabled = busy;
  viewerEls.code.disabled = busy;
  viewerEls.name.disabled = busy;
  viewerEls.cancel.hidden = !busy;
  viewerEls.status.hidden = !busy;
  viewerEls.statusText.textContent = text || '';
}

async function connect() {
  const code = viewerEls.code.value.replace(/\D/g, '');
  if (code.length !== 9) {
    notice(viewerEls.notice, 'Enter the 9-digit access code shown on the other computer.', 'error');
    return;
  }
  const name = viewerEls.name.value.trim() || 'Someone';
  settings.name = viewerEls.name.value.trim();
  saveSettings();
  notice(viewerEls.notice, '');
  setViewerBusy('Contacting server…');

  let ws;
  try {
    ws = await openSignaling({
      waiting: () => setViewerBusy('Waiting for the other person to accept…'),
      accepted: (m) => startViewerPeer(m.iceServers),
      rejected: (m) => endViewerSession(m.reason, 'error'),
      signal: (m) => applySignal(viewer, m.data).catch((err) => endViewerSession(`Connection error: ${err.message}`, 'error')),
      'peer-left': () => endViewerSession('The other computer ended the session.'),
      error: (m) => endViewerSession(m.message, 'error'),
      close: () => {
        viewer.ws = null;
        if (!viewer.pc || viewer.pc.connectionState !== 'connected') {
          endViewerSession('Lost connection to the server.', 'error');
        }
      },
    });
  } catch (err) {
    endViewerSession(err.message, 'error');
    return;
  }
  // The user may have pressed Cancel while we were connecting.
  if (viewerEls.cancel.hidden) {
    closeSocket(ws);
    return;
  }
  viewer.ws = ws;
  wsSend(ws, { type: 'join', code, name });
}

function startViewerPeer(serverIce) {
  setViewerBusy('Connecting to the remote computer…');
  const pc = new RTCPeerConnection(rtcConfig(serverIce));
  viewer.pc = pc;
  viewer.pendingIce = [];
  viewer.hostAllowsControl = true;

  pc.ontrack = (e) => {
    // Render frames as soon as they arrive rather than buffering for smoothness.
    try { e.receiver.jitterBufferTarget = 0; } catch { /* unsupported */ }
    viewerEls.video.srcObject = e.streams[0] || new MediaStream([e.track]);
  };
  pc.ondatachannel = (e) => {
    viewer.dc = e.channel;
    e.channel.onopen = () => sendToHost({ t: 'hello', platform: rd.platform });
    e.channel.onmessage = onHostMessage;
  };
  pc.onicecandidate = (e) => {
    if (e.candidate) wsSend(viewer.ws, { type: 'signal', data: { candidate: e.candidate } });
  };
  pc.onconnectionstatechange = () => {
    if (viewer.pc !== pc) return;
    const state = pc.connectionState;
    if (state === 'connected') {
      viewerEls.overlay.hidden = true;
      enterSession();
    } else if (state === 'disconnected') {
      showOverlay('Connection interrupted, trying to reconnect…');
    } else if (state === 'failed') {
      endViewerSession(FAILED_MSG, 'error');
    }
  };
}

function onHostMessage(e) {
  let m;
  try { m = JSON.parse(e.data); } catch { return; }
  if (m.t === 'control') {
    viewer.hostAllowsControl = !!m.allowed;
    updateControlUi();
  }
}

function enterSession() {
  if (!viewerEls.session.hidden) return;
  setViewerBusy('');
  $('#home').hidden = true;
  $('#topbar').hidden = true;
  viewerEls.session.hidden = false;
  viewerEls.surface.focus();
  updateControlUi();
  viewer.lastBytes = 0;
  viewer.lastStatsAt = 0;
  viewer.statsTimer = setInterval(updateStats, 1000);
}

function endViewerSession(reason, kind = '') {
  if (viewer.dc && viewer.dc.readyState === 'open') sendToHost({ t: 'ra' });
  wsSend(viewer.ws, { type: 'leave' });
  closeSocket(viewer.ws);
  viewer.ws = null;
  if (viewer.pc) viewer.pc.close();
  viewer.pc = null;
  viewer.dc = null;
  clearInterval(viewer.statsTimer);
  viewerEls.video.srcObject = null;
  viewerEls.stats.textContent = '';
  if (viewer.fullscreen) toggleFullscreen();
  viewerEls.session.hidden = true;
  $('#home').hidden = false;
  $('#topbar').hidden = false;
  setViewerBusy('');
  notice(viewerEls.notice, reason || '', kind);
}

function showOverlay(text) {
  viewerEls.overlayText.textContent = text;
  viewerEls.overlay.hidden = false;
}

async function updateStats() {
  const pc = viewer.pc;
  if (!pc) return;
  const report = await pc.getStats();
  let inbound = null;
  let pair = null;
  const byId = new Map();
  report.forEach((s) => {
    byId.set(s.id, s);
    if (s.type === 'inbound-rtp' && s.kind === 'video') inbound = s;
    if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') pair = s;
  });
  const parts = [];
  if (inbound) {
    if (inbound.frameWidth) parts.push(`${inbound.frameWidth}×${inbound.frameHeight}`);
    if (inbound.framesPerSecond !== undefined) parts.push(`${Math.round(inbound.framesPerSecond)} fps`);
    const now = inbound.timestamp;
    if (viewer.lastStatsAt) {
      const mbps = ((inbound.bytesReceived - viewer.lastBytes) * 8) / ((now - viewer.lastStatsAt) * 1000);
      parts.push(`${mbps.toFixed(1)} Mbps`);
    }
    viewer.lastBytes = inbound.bytesReceived;
    viewer.lastStatsAt = now;
  }
  if (pair) {
    if (pair.currentRoundTripTime !== undefined) parts.push(`${Math.round(pair.currentRoundTripTime * 1000)} ms`);
    const local = byId.get(pair.localCandidateId);
    if (local) parts.push(local.candidateType === 'relay' ? 'Relayed' : 'Direct');
  }
  viewerEls.stats.textContent = parts.join(' · ');
}

// --- Viewer input capture ----------------------------------------------------

function sendToHost(msg) {
  if (viewer.dc && viewer.dc.readyState === 'open') viewer.dc.send(JSON.stringify(msg));
}

function inSession() {
  return !viewerEls.session.hidden && viewer.dc && viewer.dc.readyState === 'open';
}

function canControl() {
  return inSession() && viewerEls.controlToggle.checked && viewer.hostAllowsControl;
}

function updateControlUi() {
  viewerEls.viewOnly.hidden = viewer.hostAllowsControl;
  viewerEls.viewOnly.textContent = 'View only: control disabled by host';
  viewerEls.surface.classList.toggle('no-control', !canControl());
}

// Maps a mouse event to 0..1 coordinates within the visible video frame
// (the video is letterboxed with object-fit: contain).
function normalise(e, clamp) {
  const v = viewerEls.video;
  if (!v.videoWidth) return null;
  const r = v.getBoundingClientRect();
  const scale = Math.min(r.width / v.videoWidth, r.height / v.videoHeight);
  const w = v.videoWidth * scale;
  const h = v.videoHeight * scale;
  let x = (e.clientX - (r.left + (r.width - w) / 2)) / w;
  let y = (e.clientY - (r.top + (r.height - h) / 2)) / h;
  if (clamp) {
    x = Math.min(Math.max(x, 0), 1);
    y = Math.min(Math.max(y, 0), 1);
  } else if (x < 0 || x > 1 || y < 0 || y > 1) {
    return null;
  }
  return { x: +x.toFixed(5), y: +y.toFixed(5) };
}

let pendingMove = null;
let moveScheduled = false;
let buttonsDown = 0;

function flushMove() {
  moveScheduled = false;
  if (pendingMove) sendToHost({ t: 'mm', ...pendingMove });
  pendingMove = null;
}

window.addEventListener('mousemove', (e) => {
  if (viewer.fullscreen) peekToolbar(e.clientY);
  if (!canControl()) return;
  const insideSurface = viewerEls.surface.contains(e.target);
  if (!insideSurface && !buttonsDown) return;
  const p = normalise(e, buttonsDown > 0);
  if (!p) return;
  // Coalesce to one move per animation frame.
  pendingMove = p;
  if (!moveScheduled) {
    moveScheduled = true;
    requestAnimationFrame(flushMove);
  }
});

viewerEls.surface.addEventListener('mousedown', (e) => {
  viewerEls.surface.focus();
  closeKeysMenu();
  if (!canControl()) return;
  e.preventDefault();
  const p = normalise(e, true);
  if (!p) return;
  pendingMove = null;
  buttonsDown++;
  sendToHost({ t: 'md', b: e.button, ...p });
});

window.addEventListener('mouseup', (e) => {
  if (!buttonsDown) return;
  buttonsDown = Math.max(0, buttonsDown - 1);
  if (!canControl()) return;
  e.preventDefault();
  const p = normalise(e, true);
  sendToHost({ t: 'mu', b: e.button, ...(p || {}) });
});

viewerEls.surface.addEventListener('contextmenu', (e) => e.preventDefault());

// Wheel: accumulate into whole notches (100px ≈ one notch in Chromium).
const wheelAcc = { x: 0, y: 0 };
viewerEls.surface.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (!canControl()) return;
  const unit = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 800 : 1;
  wheelAcc.x += e.deltaX * unit;
  wheelAcc.y += e.deltaY * unit;
  const dx = Math.trunc(wheelAcc.x / 100);
  const dy = Math.trunc(wheelAcc.y / 100);
  if (dx || dy) {
    wheelAcc.x -= dx * 100;
    wheelAcc.y -= dy * 100;
    sendToHost({ t: 'wh', dx, dy });
  }
}, { passive: false });

function isLocalShortcut(e) {
  // Ctrl+Alt+Enter toggles full screen locally instead of going to the remote.
  return e.ctrlKey && e.altKey && e.code === 'Enter';
}

window.addEventListener('keydown', (e) => {
  if (viewerEls.session.hidden) return;
  if (isLocalShortcut(e)) {
    e.preventDefault();
    if (!e.repeat) toggleFullscreen();
    return;
  }
  if (e.target.closest && e.target.closest('.toolbar')) {
    if (e.code === 'Escape') closeKeysMenu();
    return;
  }
  e.preventDefault();
  if (canControl() && e.code) sendToHost({ t: 'kd', c: e.code });
}, true);

window.addEventListener('keyup', (e) => {
  if (viewerEls.session.hidden) return;
  if (e.target.closest && e.target.closest('.toolbar')) return;
  e.preventDefault();
  if (canControl() && e.code) sendToHost({ t: 'ku', c: e.code });
}, true);

// Losing focus means we'll miss key-up events, so tell the host to let go of everything.
window.addEventListener('blur', () => {
  buttonsDown = 0;
  if (inSession()) sendToHost({ t: 'ra' });
});

viewerEls.controlToggle.addEventListener('change', () => {
  if (!viewerEls.controlToggle.checked) sendToHost({ t: 'ra' });
  updateControlUi();
  viewerEls.surface.focus();
});

// --- Toolbar -----------------------------------------------------------------

function toggleFullscreen() {
  viewer.fullscreen = !viewer.fullscreen;
  rd.setFullscreen(viewer.fullscreen);
  viewerEls.session.classList.toggle('fullscreen', viewer.fullscreen);
  $('#fullscreen-btn').textContent = viewer.fullscreen ? 'Exit full screen' : 'Full screen';
  viewerEls.toolbar.classList.remove('peek');
  viewerEls.surface.focus();
}

function peekToolbar(y) {
  const tb = viewerEls.toolbar;
  if (y <= 4) tb.classList.add('peek');
  else if (y > tb.offsetHeight + 24 && $('#keys-menu').hidden) tb.classList.remove('peek');
}

function closeKeysMenu() {
  $('#keys-menu').hidden = true;
}

function sendCombo(combo) {
  if (!canControl()) return;
  const keys = combo.split('+');
  keys.forEach((c) => sendToHost({ t: 'kd', c }));
  keys.reverse().forEach((c) => sendToHost({ t: 'ku', c }));
}

$('#keys-btn').addEventListener('click', () => {
  $('#keys-menu').hidden = !$('#keys-menu').hidden;
});
$('#keys-menu').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-combo]');
  if (!btn) return;
  sendCombo(btn.dataset.combo);
  closeKeysMenu();
  viewerEls.surface.focus();
});
$('#fullscreen-btn').addEventListener('click', toggleFullscreen);
$('#disconnect-btn').addEventListener('click', () => endViewerSession('You disconnected.'));

// --- Connect form ------------------------------------------------------------

viewerEls.code.addEventListener('input', () => {
  const digits = viewerEls.code.value.replace(/\D/g, '').slice(0, 9);
  viewerEls.code.value = formatCode(digits);
});

viewerEls.form.addEventListener('submit', (e) => {
  e.preventDefault();
  connect();
});

viewerEls.cancel.addEventListener('click', () => endViewerSession(''));

// ===========================================================================
// Settings dialog

const settingsEls = {
  modal: $('#settings-modal'),
  form: $('#settings-form'),
  server: $('#set-server'),
  ice: $('#set-ice'),
  bitrate: $('#set-bitrate'),
  fps: $('#set-fps'),
  hideCapture: $('#set-hide-capture'),
  error: $('#settings-error'),
};

$('#settings-btn').addEventListener('click', () => {
  settingsEls.server.value = settings.serverUrl;
  settingsEls.ice.value = settings.iceServers;
  settingsEls.bitrate.value = settings.maxBitrateMbps;
  settingsEls.fps.value = String(settings.maxFps);
  settingsEls.hideCapture.checked = settings.hideFromCapture;
  notice(settingsEls.error, '');
  settingsEls.modal.hidden = false;
  settingsEls.server.focus();
});

$('#settings-cancel').addEventListener('click', () => { settingsEls.modal.hidden = true; });

$('#settings-reset').addEventListener('click', () => {
  settingsEls.server.value = DEFAULT_SETTINGS.serverUrl;
  settingsEls.ice.value = DEFAULT_SETTINGS.iceServers;
  settingsEls.bitrate.value = DEFAULT_SETTINGS.maxBitrateMbps;
  settingsEls.fps.value = String(DEFAULT_SETTINGS.maxFps);
  settingsEls.hideCapture.checked = DEFAULT_SETTINGS.hideFromCapture;
});

settingsEls.form.addEventListener('submit', (e) => {
  e.preventDefault();
  const url = settingsEls.server.value.trim();
  if (!/^wss?:\/\/.+/.test(url)) {
    notice(settingsEls.error, 'Server URL must start with ws:// or wss://', 'error');
    return;
  }
  try {
    const parsed = JSON.parse(settingsEls.ice.value.trim() || '[]');
    if (!Array.isArray(parsed)) throw new Error();
  } catch {
    notice(settingsEls.error, 'ICE servers must be a JSON array, e.g. [{"urls":"stun:stun.l.google.com:19302"}]', 'error');
    return;
  }
  settings.serverUrl = url;
  settings.iceServers = settingsEls.ice.value.trim();
  settings.maxBitrateMbps = Math.min(50, Math.max(1, Number(settingsEls.bitrate.value) || 8));
  settings.maxFps = Number(settingsEls.fps.value) || 30;
  settings.hideFromCapture = settingsEls.hideCapture.checked;
  rd.setContentProtection(settings.hideFromCapture);
  saveSettings();
  settingsEls.modal.hidden = true;
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !settingsEls.modal.hidden) settingsEls.modal.hidden = true;
});
