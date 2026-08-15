import { t } from '../i18n.js';


const DEFAULT_OPTIONS = Object.freeze({
  // Sur macOS, le mode haute précision échoue souvent alors que la position
  // réseau reste disponible. À l’échelle de la carte, cette précision suffit.
  enableHighAccuracy: false,
  maximumAge: 60000,
  timeout: 20000,
});
const LOCATION_ZOOM = 11;

function validCoordinates(coords) {
  return Number.isFinite(coords?.latitude)
    && Number.isFinite(coords?.longitude)
    && coords.latitude >= -90 && coords.latitude <= 90
    && coords.longitude >= -180 && coords.longitude <= 180;
}

export function createLocationController({
  map,
  geolocation = globalThis.navigator?.geolocation,
  permissions = globalThis.navigator?.permissions,
  elements,
  trackUsage = () => {},
}) {
  const { button, status } = elements;
  let permission = null;
  let permissionStatus = null;
  let requesting = false;

  function render(message = '', error = false) {
    button.classList.toggle('locating', requesting);
    button.setAttribute('aria-busy', String(requesting));
    button.title = t(requesting
      ? 'location.loading'
      : permission === 'denied' ? 'location.title.denied' : 'location.title');
    status.textContent = message;
    status.hidden = !message;
    status.classList.toggle('error', error);
  }

  function updatePermission() {
    permission = permissionStatus?.state || null;
    render();
  }

  async function checkPermission() {
    if (!permissions?.query) return null;
    try {
      permissionStatus = await permissions.query({ name: 'geolocation' });
      permissionStatus.addEventListener?.('change', updatePermission);
      updatePermission();
      return permission;
    } catch (_) {
      // Safari et certains moteurs refusent la requête Permissions :
      // getCurrentPosition reste la source de vérité au clic.
      return null;
    }
  }

  function showError(key) {
    permission = key === 'location.denied' ? 'denied' : permission;
    render(t(key), true);
  }

  function finish() {
    requesting = false;
    render();
  }

  function onSuccess(position) {
    const coords = position?.coords;
    if (!validCoordinates(coords)) {
      finish();
      showError('location.invalid');
      return;
    }
    const { latitude, longitude } = coords;
    permission = 'granted';
    finish();
    map.flyTo({
      center: [longitude, latitude],
      zoom: Math.max(map.getZoom(), LOCATION_ZOOM),
      duration: 850,
      essential: true,
    });
    trackUsage('location-use');
  }

  function onError(error) {
    finish();
    if (error?.code === 1) {
      permission = 'denied';
      showError('location.denied');
    } else if (error?.code === 3) {
      showError('location.timeout');
    } else {
      showError('location.system');
    }
  }

  function locate() {
    if (requesting) return;
    if (!geolocation) {
      showError('location.unsupported');
      return;
    }
    if (permission === 'denied') {
      showError('location.denied');
      return;
    }
    requesting = true;
    render(t('location.loading'));
    try {
      geolocation.getCurrentPosition(onSuccess, onError, DEFAULT_OPTIONS);
    } catch (_) {
      finish();
      showError('location.system');
    }
  }

  function destroy() {
    permissionStatus?.removeEventListener?.('change', updatePermission);
  }

  render();
  button.addEventListener('click', locate);
  return Object.freeze({ checkPermission, destroy, locate });
}
