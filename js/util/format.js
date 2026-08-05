import { getLocale, getTimeZone, t } from '../i18n.js';

const DAY = 86400;

export const fmt = ts => new Date(ts * 1000).toLocaleString(getLocale(),
  { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
    timeZone: getTimeZone() });

export const fmtClock = ts => {
  const date = new Date(ts * 1000);
  const day = date.toLocaleDateString(getLocale(),
    { weekday: 'long', day: 'numeric', month: 'long', timeZone: getTimeZone() });
  const time = date.toLocaleTimeString(getLocale(),
    { hour: '2-digit', minute: '2-digit', timeZone: getTimeZone() });
  return t('format.clock', { day, time });
};

/* Le français écrit « 14h34 » et « 14h », l'espagnol « 14:34 » et « 14 » : la
 * séparation reste une convention de langue, pas de fuseau. */
export const fmtHourMinute = ts => new Date(ts * 1000)
  .toLocaleTimeString(getLocale(),
    { hour: '2-digit', minute: '2-digit', timeZone: getTimeZone() })
  .replace(':', t('format.time.separator'));

export const fmtHour = ts => new Date(ts * 1000)
  .toLocaleTimeString(getLocale(), { hour: '2-digit', timeZone: getTimeZone() })
  .replace(' h', 'h');

export const fmtWeekdayTime = ts => new Date(ts * 1000)
  .toLocaleString(getLocale(), { weekday: 'short', hour: '2-digit',
    minute: '2-digit', timeZone: getTimeZone() })
  .replace(':', t('format.time.separator'));

export const nf = (value, digits = 0) =>
  Number(value).toLocaleString(getLocale(), { maximumFractionDigits: digits });

/* Ancienneté relative au cran affiché, pas à l'heure murale : c'est ce que la
 * couleur du foyer raconte quand on remonte la frise. Une seule unité, la plus
 * grande atteinte : la précision de la donnée ne justifie pas « 5 h 12 », et
 * l'échelle de couleurs se lit de toute façon à l'heure près. */
export function ago(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  if (seconds < 90) return t('format.now');
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return t('format.ago.minutes', { n: minutes });
  const hours = Math.floor(seconds / 3600);
  if (hours < 24) return t('format.ago.hours', { n: hours });
  const days = Math.round(seconds / DAY);
  return t('format.ago.days', { n: days });
}

/* La confiance FIRMS est une classe pour VIIRS (l/n/h) et un pourcentage pour
 * MODIS : les deux formats arrivent dans le même champ. */
export function confidenceText(value) {
  const text = String(value ?? '').toLowerCase();
  const words = { l: 'low', low: 'low', n: 'nominal', nominal: 'nominal',
                  h: 'high', high: 'high' };
  if (words[text]) return t(`format.confidence.${words[text]}`);
  const number = Number(text);
  return Number.isFinite(number) && text !== ''
    ? t('format.confidence.percent', { n: number }) : '';
}
