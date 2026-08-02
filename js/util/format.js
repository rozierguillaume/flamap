const DAY = 86400;

export const fmt = ts => new Date(ts * 1000).toLocaleString('fr-FR',
  { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' });

export const fmtClock = ts => {
  const date = new Date(ts * 1000);
  const day = date.toLocaleDateString('fr-FR',
    { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Europe/Paris' });
  const time = date.toLocaleTimeString('fr-FR',
    { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' });
  return `${day} à ${time}`;
};

export const nf = (value, digits = 0) =>
  Number(value).toLocaleString('fr-FR', { maximumFractionDigits: digits });

/* Ancienneté relative au cran affiché, pas à l'heure murale : c'est ce que la
 * couleur du foyer raconte quand on remonte la frise. */
export function ago(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  if (seconds < 90) return "à l'instant";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `il y a ${minutes} min`;
  const hours = Math.floor(seconds / 3600);
  if (hours < 24) {
    const rest = Math.round((seconds - hours * 3600) / 60);
    return `il y a ${hours} h${rest ? ' ' + String(rest).padStart(2, '0') : ''}`;
  }
  const days = Math.round(seconds / DAY);
  return `il y a ${days} jour${days > 1 ? 's' : ''}`;
}

/* La confiance FIRMS est une classe pour VIIRS (l/n/h) et un pourcentage pour
 * MODIS : les deux formats arrivent dans le même champ. */
export function confidenceText(value) {
  const text = String(value ?? '').toLowerCase();
  const words = { l: 'faible', low: 'faible', n: 'nominale', nominal: 'nominale',
                  h: 'haute', high: 'haute' };
  if (words[text]) return `confiance ${words[text]}`;
  const number = Number(text);
  return Number.isFinite(number) && text !== '' ? `confiance ${number} %` : '';
}
