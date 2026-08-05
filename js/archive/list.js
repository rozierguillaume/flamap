import { t } from '../i18n.js';
import { PSFDF_COLORS } from '../features/psfdf.js';
import { fmt, nf } from '../util/format.js';

// L'API renvoie déjà les feux du plus récent au plus ancien (voir doc §2) :
// aucun tri à refaire ici.
export function renderList(container, fires, onSelect) {
  container.innerHTML = '';
  if (!fires.length) {
    container.append(Object.assign(document.createElement('p'), {
      className: 'archive-status', textContent: t('archive.empty'),
    }));
    return;
  }
  for (const fire of fires) {
    const card = document.createElement('li');
    card.className = 'archive-card';
    const button = document.createElement('button');
    button.type = 'button';

    const title = document.createElement('strong');
    title.textContent = fire.commune || t('archive.commune.unknown');
    const sub = document.createElement('span');
    sub.className = 'archive-card-sub';
    sub.textContent = fire.departement || '';

    const badge = document.createElement('span');
    badge.className = 'archive-badge';
    badge.textContent = fire.status ? t(`status.${fire.status}`) : t('status.unknown');
    if (PSFDF_COLORS[fire.status]) badge.style.setProperty('--incident-color', PSFDF_COLORS[fire.status]);

    const dates = document.createElement('span');
    dates.className = 'archive-card-dates';
    dates.textContent = `${fmt(fire.first_ts)} → ${fmt(fire.last_ts)}`;

    const surface = document.createElement('span');
    surface.className = 'archive-card-surface';
    surface.textContent = Number.isFinite(fire.surface_max)
      ? `${nf(fire.surface_max)} ha` : '';

    button.append(title, sub, badge, dates, surface);
    button.addEventListener('click', () => onSelect(fire.id));
    card.append(button);
    container.append(card);
  }
}
