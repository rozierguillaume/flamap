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
// Incrémenté à chaque navigation : une réponse asynchrone qui revient après
// coup (retour/avant rapide, double clic) se reconnaît obsolète et se détruit
// sans toucher à l'affichage courant, au lieu d'écraser une carte plus récente.
let navToken = 0;

// Chargée une seule fois et mise en cache : la liste doit être prête même si
// on atterrit directement sur un lien `?id=…`, sinon un retour arrière la
// montre vide (elle n'avait jamais été demandée).
let fireListPromise = null;
function loadFireList() {
  if (fireListPromise) return fireListPromise;
  listStatusEl.textContent = '';
  listStatusEl.append(Object.assign(document.createElement('span'), { className: 'archive-loader' }),
    document.createTextNode('Chargement des feux…'));
  fireListPromise = fetchFireList().then(fires => {
    listStatusEl.textContent = '';
    renderList(cardsEl, fires, fireId => showDetail(fireId));
  }).catch(error => {
    console.error('Liste des feux archivés indisponible', error);
    listStatusEl.textContent = 'Liste indisponible pour le moment — réessayez plus tard.';
    fireListPromise = null; // un retour ultérieur sur la liste retentera l'appel
  });
  return fireListPromise;
}

function showList() {
  navToken++;
  currentFire?.destroy();
  currentFire = null;
  detailEl.hidden = true;
  listEl.hidden = false;
  loadFireList();
}

async function showDetail(id, { push = true } = {}) {
  const token = ++navToken;
  currentFire?.destroy();
  currentFire = null;
  listEl.hidden = true;
  detailEl.hidden = false;
  detailElements.statusEl.textContent = 'Chargement du feu…';
  detailElements.summaryEl.innerHTML = '';

  if (push) history.pushState({ id }, '', `?id=${encodeURIComponent(id)}`);

  let result;
  try {
    result = await openFire(id, detailElements);
  } catch (error) {
    console.error('Détail du feu indisponible', error);
    if (token === navToken) detailElements.statusEl.textContent = 'Détail indisponible pour le moment — réessayez plus tard.';
    return;
  }
  if (token !== navToken) {
    // une navigation plus récente a eu lieu pendant le chargement : cette
    // réponse est obsolète, on la détruit sans l'appliquer à l'affichage.
    result.destroy();
    return;
  }
  if (result.notFound) {
    detailElements.statusEl.textContent = 'Ce feu est introuvable — il a peut-être été renommé depuis.';
    return;
  }
  // openFire() a déjà mis à jour le statut lui-même (vidé s'il rejoue le feu,
  // ou message « pas assez de données » sinon) : ne pas l'écraser ici.
  currentFire = result;
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

function init() {
  // Toujours amorcée, même en démarrant sur un lien direct vers un feu : voir
  // loadFireList() ci-dessus.
  loadFireList();
  const id = new URLSearchParams(location.search).get('id');
  if (id) showDetail(id, { push: false });
}

init();
