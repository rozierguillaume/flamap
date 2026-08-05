import { json } from '../data/client.js';

// `api.flamap.fr` n'autorise en pratique le CORS que depuis https://flamap.fr :
// malgré ce qu'annonce docs/refactor/FRONT_ARCHIVE_INCENDIES.md §3, une
// origine localhost n'obtient aucun en-tête Access-Control-Allow-Origin et le
// navigateur bloque l'appel. En développement local, on sert donc deux feux
// d'exemple figés (js/archive/mock/) — même origine que la page, aucun souci
// de CORS — plutôt que de dépendre d'un serveur qui refuse la requête.
const LOCAL = ['localhost', '127.0.0.1'].includes(location.hostname);
const BASE = LOCAL ? '/js/archive/mock' : 'https://api.flamap.fr';

export const fetchFireList = () => json(LOCAL ? `${BASE}/fires.json` : `${BASE}/fires`);

// `json()` lève sur toute réponse non ok ; on ne distingue le 404 (feu
// introuvable, cas normal) du reste (réseau, 5xx) que pour l'affichage.
export async function fetchFireDetail(id) {
  try {
    const url = LOCAL ? `${BASE}/fire-${id}.json` : `${BASE}/fires/${encodeURIComponent(id)}`;
    return await json(url);
  } catch (error) {
    if (String(error.message).startsWith('404')) return null;
    throw error;
  }
}
