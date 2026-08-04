import { fetchFireList } from './api.js';
import { renderList } from './list.js';
import { openFire } from './detail.js';

const listEl = document.getElementById('archive-list');
const detailEl = document.getElementById('archive-detail');
const cardsEl = document.getElementById('archive-cards');
const listStatusEl = document.getElementById('archive-list-status');
const backBtn = document.getElementById('archive-back');

const detailElements = {
  mapContainerId: 'archive-map',
  dock: document.getElementById('archive-timebar'),
  slider: document.getElementById('archive-slider'),
  playBtn: document.getElementById('archive-play'),
  clockEl: document.getElementById('archive-clock'),
  summaryEl: document.getElementById('archive-summary'),
  statusEl: document.getElementById('archive-detail-status'),
};

let currentFire = null; // { destroy }

function showList() {
  currentFire?.destroy();
  currentFire = null;
  detailEl.hidden = true;
  listEl.hidden = false;
}

async function showDetail(id, { push = true } = {}) {
  currentFire?.destroy();
  currentFire = null;
  listEl.hidden = true;
  detailEl.hidden = false;
  detailElements.statusEl.textContent = 'Chargement du feu…';
  detailElements.summaryEl.innerHTML = '';

  if (push) history.pushState({ id }, '', `?id=${encodeURIComponent(id)}`);

  const result = await openFire(id, detailElements);
  if (result.notFound) {
    detailElements.statusEl.textContent = 'Ce feu est introuvable — il a peut-être été renommé depuis.';
    return;
  }
  currentFire = result;
  detailElements.statusEl.textContent = '';
}

backBtn.addEventListener('click', () => {
  history.pushState({}, '', location.pathname);
  showList();
});

addEventListener('popstate', () => {
  const id = new URLSearchParams(location.search).get('id');
  if (id) showDetail(id, { push: false });
  else showList();
});

async function init() {
  const id = new URLSearchParams(location.search).get('id');
  if (id) {
    await showDetail(id, { push: false });
    return;
  }
  try {
    const fires = await fetchFireList();
    renderList(cardsEl, fires, fireId => showDetail(fireId));
  } catch (error) {
    console.error('Liste des feux archivés indisponible', error);
    listStatusEl.textContent = 'Liste indisponible pour le moment — réessayez plus tard.';
  }
}

init();
