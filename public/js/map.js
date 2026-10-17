// Leaflet maps (served from our own server; map tiles from OpenStreetMap).
let loading = null;

export function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  if (!loading) {
    loading = new Promise((resolve, reject) => {
      const css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = '/vendor/leaflet/leaflet.css';
      document.head.append(css);
      const s = document.createElement('script');
      s.src = '/vendor/leaflet/leaflet.js';
      s.onload = () => resolve(window.L);
      s.onerror = () => { loading = null; reject(new Error('The map could not load.')); };
      document.head.append(s);
    });
  }
  return loading;
}

export async function makeMap(el, { lat = 30.3753, lng = 69.3451, zoom = 5 } = {}) {
  const L = await loadLeaflet();
  const map = L.map(el, { zoomControl: true, attributionControl: true }).setView([lat, lng], zoom);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    // OpenStreetMap refuses tiles to requests that don't say which site they come from; send only
    // the site's address (the rest of the app sends nothing to other sites)
    referrerPolicy: 'strict-origin-when-cross-origin',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);
  setTimeout(() => map.invalidateSize(), 50);
  return { L, map };
}

/** Distance in metres between two points (same formula as the server). */
export function distanceM(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const rad = (d) => (d * Math.PI) / 180;
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lng2 - lng1) / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}
