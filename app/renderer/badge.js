const textEl = document.getElementById('text');

window.badge.onStatus((info) => {
  const status = (info && info.status) || 'your screen is being shared';
  textEl.innerHTML = '<b>scsh</b> — ' + status.replace(/</g, '&lt;');
});

document.getElementById('show').addEventListener('click', () => window.badge.show());
document.getElementById('stop').addEventListener('click', () => window.badge.stop());
