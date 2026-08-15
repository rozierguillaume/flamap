import { getLang, t } from '../i18n.js';

const API = 'https://api.flamap.fr/notifications/v1';
const STORE = 'flamap-notifications';
const read = () => JSON.parse(localStorage.getItem(STORE) || '{"areas":[]}');
const save = value => localStorage.setItem(STORE, JSON.stringify(value));
const bytes = value => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));

export function createNotificationsController({ button, panel, close, map }) {
  const form = panel.querySelector('form');
  const address = panel.querySelector('[name=address]');
  const results = panel.querySelector('.notify-results');
  const areas = panel.querySelector('.notify-areas');
  const empty = panel.querySelector('.notify-empty');
  const add = panel.querySelector('.notify-add');
  const list = panel.querySelector('.notify-list');
  const searchStep = panel.querySelector('.notify-search-step');
  const radiusStep = panel.querySelector('.notify-radius-step');
  const state = panel.querySelector('.notify-state');
  let chosen = null, radius = 15, timer = null;
  const circle = () => {
    if (!chosen || !map.isStyleLoaded()) return;
    const coordinates = Array.from({length: 65}, (_, index) => {
      const angle = index * Math.PI * 2 / 64, d = radius / 111;
      return [chosen.lon + d * Math.cos(angle) / Math.cos(chosen.lat * Math.PI / 180), chosen.lat + d * Math.sin(angle)];
    });
    const data = {type: 'Feature', geometry: {type: 'Polygon', coordinates: [coordinates]}};
    if (map.getSource('notification-radius')) map.getSource('notification-radius').setData(data);
    else { map.addSource('notification-radius', {type: 'geojson', data}); map.addLayer({id: 'notification-radius-fill', type: 'fill', source: 'notification-radius', paint: {'fill-color': '#ff7426', 'fill-opacity': .16}}); map.addLayer({id: 'notification-radius-line', type: 'line', source: 'notification-radius', paint: {'line-color': '#ff9b4a', 'line-width': 2}}); }
  };

  const render = () => {
    const data = read();
    empty.hidden = data.areas.length > 0;
    areas.replaceChildren(...data.areas.map((area, index) => {
      const item = document.createElement('li');
      const label = document.createElement('span'); label.textContent = area.label; item.append(label);
      const select = document.createElement('select'); [5, 15, 30, 50].forEach(value => { const option = new Option(`${value} km`, value, false, value === area.radius_km); select.add(option); });
      select.onchange = () => { area.radius_km = Number(select.value); save(data); sync(); };
      item.append(select);
      const remove = document.createElement('button');
      remove.type = 'button'; remove.textContent = '×'; remove.ariaLabel = t('common.close');
      remove.onclick = () => { data.areas.splice(index, 1); save(data); sync(); render(); };
      item.append(remove); return item;
    }));
  };
  const message = key => { state.textContent = t(key); };
  async function sync() {
    const data = read();
    if (!data.token || !data.areas.length) return;
    await fetch(`${API}/subscriptions/${data.token}`, { method: 'PATCH', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({locale: getLang(), areas: data.areas}) });
  }
  async function enable() {
    if (!chosen) return message('notifications.choose');
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return message('notifications.unsupported');
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return message('notifications.denied');
    const registration = await navigator.serviceWorker.ready;
    const key = await fetch(`${API}/vapid-public-key`).then(response => response.json());
    const subscription = await registration.pushManager.getSubscription() || await registration.pushManager.subscribe({userVisibleOnly: true, applicationServerKey: bytes(key.public_key)});
    const data = read();
    data.areas.push({...chosen, radius_km: radius}); chosen = null;
    const response = await fetch(`${API}/subscriptions`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({subscription: subscription.toJSON(), locale: getLang(), areas: data.areas})});
    if (!response.ok) throw new Error('subscription');
    data.token = (await response.json()).manage_token; save(data); render(); message('notifications.enabled');
  }
  async function search() {
    results.replaceChildren(); if (address.value.trim().length < 3) return;
    try {
      const url = new URL('https://data.geopf.fr/geocodage/search/'); url.searchParams.set('q', address.value); url.searchParams.set('limit', '5');
      const geojson = await fetch(url).then(response => response.json());
      geojson.features.forEach(feature => {
        const option = document.createElement('button'); option.type = 'button'; option.role = 'option'; option.innerHTML = `<strong>${feature.properties.name || feature.properties.label}</strong><span>${feature.properties.context || ''}</span>`;
        option.onclick = () => { const [lon, lat] = feature.geometry.coordinates; chosen = {lon, lat, label: feature.properties.label}; map.flyTo({center: [lon, lat], zoom: 11}); panel.querySelector('.notify-picked').textContent = feature.properties.label; searchStep.hidden = true; radiusStep.hidden = false; circle(); message('notifications.selected'); };
        results.append(option);
      });
    } catch { message('notifications.searchError'); }
  }
  form.addEventListener('submit', event => event.preventDefault());
  address.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(search, 250); });
  panel.querySelectorAll('[data-radius]').forEach(button => button.onclick = () => { radius = Number(button.dataset.radius); panel.querySelectorAll('[data-radius]').forEach(item => item.setAttribute('aria-pressed', String(item === button))); circle(); });
  panel.querySelector('.notify-enable').onclick = () => enable().catch(() => message('notifications.error'));
  add.onclick = () => { list.hidden = true; form.hidden = false; searchStep.hidden = false; radiusStep.hidden = true; address.value = ''; results.replaceChildren(); address.focus(); };
  button.onclick = () => {
    document.getElementById('updates-panel').classList.remove('open');
    document.getElementById('updates-btn').setAttribute('aria-expanded', 'false');
    panel.hidden = false; list.hidden = false; form.hidden = true; render();
  };
  close.onclick = () => { panel.hidden = true; button.focus(); };
  navigator.serviceWorker?.register('/sw.js'); render();
  return { close: () => { panel.hidden = true; } };
}
