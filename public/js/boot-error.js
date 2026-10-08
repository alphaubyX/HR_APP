// If a script fails to load (e.g. an old file on the server), say so instead of loading forever.
window.addEventListener('error', function (e) {
  var box = document.querySelector('#app .boot');
  if (!box) return;
  box.textContent = 'Broadwing HR could not start. A file on the server may be missing or out of date. Details: ' + (e.message || (e.target && e.target.src) || 'unknown error');
}, true);
