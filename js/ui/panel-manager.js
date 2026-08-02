export function createPanelManager() {
  let active = null;

  function activate(name, closeOthers) {
    closeOthers();
    active = name;
  }

  function deactivate(name) {
    if (active === name) active = null;
  }

  function isActive(name) {
    return active === name;
  }

  return Object.freeze({ activate, deactivate, isActive });
}
