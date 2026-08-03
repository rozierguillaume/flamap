export const popEl = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};

export function popRoot(title, subtitle) {
  const root = popEl('div', 'pop');
  root.append(popEl('b', '', title));
  if (subtitle) root.append(popEl('span', 'sub', subtitle));
  return root;
}

export function popRow(root, text, cls = 'row') {
  if (text) root.append(popEl('div', cls, text));
  return root;
}

export function createPopupView({ map, maplibregl, dock }) {
  const state = { popup: null, timer: null, kind: null };

  function close() {
    // Le gestionnaire `close` de MapLibre fait le ménage du timer et de l'état.
    if (state.popup) state.popup.remove();
  }

  /* Le dock et le bandeau du haut sont posés sur la carte : MapLibre ne les
   * connaît pas et laisserait la fiche filer dessous, surtout sur téléphone. */
  function fit(popup) {
    const element = popup.getElement();
    if (!element) return;
    const view = map.getContainer().getBoundingClientRect();
    const dockRect = dock.getBoundingClientRect();
    const rect = element.getBoundingClientRect();
    const floor = Math.min(view.bottom, dockRect.top) - 10;
    const ceiling = view.top + 10;
    let dy = 0;
    if (rect.bottom > floor) dy = rect.bottom - floor;
    // Une fiche trop haute privilégie son en-tête.
    if (rect.top - dy < ceiling) dy = rect.top - ceiling;
    if (Math.abs(dy) > 2) map.panBy([0, dy], { duration: 240 });
  }

  function open(lngLat, content, kind, tick) {
    close();
    // L'ancrage reste figé pendant le recadrage, sinon la fiche saute.
    const anchor = map.project(lngLat).y > map.getContainer().clientHeight * .45
      ? 'bottom' : 'top';
    const popup = new maplibregl.Popup({ closeButton: true, maxWidth: '290px', anchor })
      .setLngLat(lngLat)
      .setDOMContent(content)
      .addTo(map);
    fit(popup);
    state.popup = popup;
    state.kind = kind;
    if (tick) {
      tick();
      state.timer = setInterval(tick, 1000);
    }
    popup.on('close', () => {
      if (state.popup !== popup) return;
      clearInterval(state.timer);
      state.popup = null; state.timer = null; state.kind = null;
    });
    return popup;
  }

  return Object.freeze({
    close,
    open,
    isCurrent: popup => state.popup === popup,
    isKind: kind => state.kind === kind,
  });
}
