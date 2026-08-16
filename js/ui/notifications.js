import { getLang, t } from '../i18n.js';

const API = 'https://api.flamap.fr/notifications/v1';
const STORE = 'flamap-notifications';
const read = () => JSON.parse(localStorage.getItem(STORE) || '{"areas":[]}');
const save = value => localStorage.setItem(STORE, JSON.stringify(value));
const bytes = value => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));

export function createNotificationsController({ button, panel, close, map }) {
  const dock = panel.parentElement;
  const form = panel.querySelector('form');
  const address = panel.querySelector('[name=address]');
  const results = panel.querySelector('.notify-results');
  const areas = panel.querySelector('.notify-areas');
  const empty = panel.querySelector('.notify-empty');
  const add = panel.querySelector('.notify-add');
  const list = panel.querySelector('.notify-list');
  const choiceStep = panel.querySelector('.notify-choice-step');
  const searchStep = panel.querySelector('.notify-search-step');
  const mapStep = panel.querySelector('.notify-map-step');
  const radiusStep = panel.querySelector('.notify-radius-step');
  const state = panel.querySelector('.notify-state');
  let chosen = null, radius = 15, timer = null, pickingOnMap = false;
  const clearCircle = () => {
    if (!map.isStyleLoaded() || !map.getSource('notification-radius')) return;
    if (map.getLayer('notification-radius-line')) map.removeLayer('notification-radius-line');
    if (map.getLayer('notification-radius-fill')) map.removeLayer('notification-radius-fill');
    map.removeSource('notification-radius');
  };
  const showList = ({ clearSelection = false } = {}) => {
    pickingOnMap = false;
    if (clearSelection) { chosen = null; clearCircle(); }
    list.hidden = false; form.hidden = true; render();
  };
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
  const renderMarkers = () => {
    if (!map.isStyleLoaded()) return;
    const data = {
      type: 'FeatureCollection',
      features: read().areas.map((area, index) => ({
        type: 'Feature', properties: {index}, geometry: {type: 'Point', coordinates: [area.lon, area.lat]},
      })),
    };
    if (map.getSource('notification-centers')) {
      map.getSource('notification-centers').setData(data);
      return;
    }
    map.addSource('notification-centers', {type: 'geojson', data});
    map.addLayer({id: 'notification-center-ring', type: 'circle', source: 'notification-centers', paint: {
      'circle-radius': 9, 'circle-color': '#241710', 'circle-stroke-color': '#ffb06a', 'circle-stroke-width': 2,
    }});
    map.addLayer({id: 'notification-center-dot', type: 'circle', source: 'notification-centers', paint: {
      'circle-radius': 3, 'circle-color': '#ff7426', 'circle-stroke-color': '#fff4e9', 'circle-stroke-width': 1,
    }});
  };

  const render = () => {
    const data = read();
    renderMarkers();
    empty.hidden = data.areas.length > 0;
    areas.replaceChildren(...data.areas.map((area, index) => {
      const item = document.createElement('li');
      item.tabIndex = 0; item.ariaLabel = area.label;
      const focusArea = () => {
        chosen = area; radius = area.radius_km; circle();
        map.flyTo({center: [area.lon, area.lat], zoom: 11});
      };
      item.onclick = event => { if (!event.target.closest('select, button')) focusArea(); };
      item.onkeydown = event => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault(); focusArea();
      };
      const label = document.createElement('span'); label.className = 'notify-area-label'; label.textContent = area.label; item.append(label);
      const select = document.createElement('select'); [5, 15, 30, 50].forEach(value => { const option = new Option(`${value} km`, value, false, value === area.radius_km); select.add(option); });
      select.onclick = event => event.stopPropagation();
      select.onchange = () => { area.radius_km = Number(select.value); save(data); sync(); };
      item.append(select);
      const remove = document.createElement('button');
      remove.type = 'button'; remove.textContent = '×'; remove.ariaLabel = t('common.close');
      remove.onclick = event => { event.stopPropagation(); data.areas.splice(index, 1); save(data); sync(); render(); };
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
    data.token = (await response.json()).manage_token; save(data); showList({clearSelection: true}); message('notifications.enabled');
  }
  async function search() {
    results.replaceChildren(); if (address.value.trim().length < 3) return;
    try {
      const url = new URL('https://data.geopf.fr/geocodage/search/'); url.searchParams.set('q', address.value); url.searchParams.set('limit', '5');
      const geojson = await fetch(url).then(response => response.json());
      geojson.features.forEach(feature => {
        const option = document.createElement('button'); option.type = 'button'; option.role = 'option'; option.innerHTML = `<strong>${feature.properties.name || feature.properties.label}</strong><span>${feature.properties.context || ''}</span>`;
        option.onclick = () => selectAddress({lon: feature.geometry.coordinates[0], lat: feature.geometry.coordinates[1], label: feature.properties.label}, {fly: true});
        results.append(option);
      });
    } catch { message('notifications.searchError'); }
  }
  function selectAddress(next, { fly = false } = {}) {
    chosen = next; pickingOnMap = false;
    if (fly) map.flyTo({center: [chosen.lon, chosen.lat], zoom: 11});
    panel.querySelector('.notify-picked').textContent = chosen.label;
    choiceStep.hidden = true; searchStep.hidden = true; mapStep.hidden = true; radiusStep.hidden = false;
    circle(); message('notifications.selected');
  }
  form.addEventListener('submit', event => event.preventDefault());
  address.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(search, 250); });
  panel.querySelectorAll('[data-radius]').forEach(button => button.onclick = () => { radius = Number(button.dataset.radius); panel.querySelectorAll('[data-radius]').forEach(item => item.setAttribute('aria-pressed', String(item === button))); circle(); });
  panel.querySelector('.notify-enable').onclick = () => enable().catch(() => message('notifications.error'));
  panel.querySelector('.notify-search-choice').onclick = () => {
    pickingOnMap = false; choiceStep.hidden = true; searchStep.hidden = false; mapStep.hidden = true;
    address.focus();
  };
  panel.querySelector('.notify-map-choice').onclick = () => {
    pickingOnMap = true; choiceStep.hidden = true; searchStep.hidden = true; mapStep.hidden = false;
    map.getCanvas().style.cursor = 'crosshair';
  };
  add.onclick = () => {
    chosen = null; clearCircle(); list.hidden = true; form.hidden = false;
    choiceStep.hidden = false; searchStep.hidden = true; mapStep.hidden = true; radiusStep.hidden = true;
    address.value = ''; results.replaceChildren(); state.textContent = '';
  };
  button.onclick = () => {
    document.getElementById('updates-panel').classList.remove('open');
    document.getElementById('updates-btn').setAttribute('aria-expanded', 'false');
    dock.classList.add('notifications-open'); panel.hidden = false; showList();
  };
  close.onclick = () => { pickingOnMap = false; map.getCanvas().style.cursor = ''; dock.classList.remove('notifications-open'); panel.hidden = true; button.focus(); };
  map.on('style.load', () => { renderMarkers(); circle(); });
  navigator.serviceWorker?.register('/sw.js'); render();
  return {
    close: () => { pickingOnMap = false; map.getCanvas().style.cursor = ''; dock.classList.remove('notifications-open'); panel.hidden = true; },
    handleMapClick: event => {
      if (pickingOnMap) {
        const { lng, lat } = event.lngLat;
        selectAddress({lon: lng, lat, label: t('notifications.mapLocation', {lat: lat.toFixed(4), lon: lng.toFixed(4)})});
        map.getCanvas().style.cursor = '';
        return true;
      }
      if (!map.isStyleLoaded() || !map.getLayer('notification-center-dot')) return false;
      const hit = map.queryRenderedFeatures(event.point, {layers: ['notification-center-dot']})[0];
      const area = hit && read().areas[Number(hit.properties.index)];
      if (!area) return false;
      chosen = area; radius = area.radius_km; circle();
      return true;
    },
  };
}
