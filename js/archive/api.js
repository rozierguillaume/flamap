import { json } from '../data/client.js';

const BASE = 'https://api.flamap.fr';

export const fetchFireList = () => json(`${BASE}/fires`);

// `json()` lève sur toute réponse non ok ; on ne distingue le 404 (feu
// introuvable, cas normal) du reste (réseau, 5xx) que pour l'affichage.
export async function fetchFireDetail(id) {
  try {
    return await json(`${BASE}/fires/${encodeURIComponent(id)}`);
  } catch (error) {
    if (String(error.message).startsWith('404')) return null;
    throw error;
  }
}
