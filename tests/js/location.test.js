import assert from 'node:assert/strict';
import test from 'node:test';

import { createLocationController } from '../../js/ui/location.js';


function harness({ geolocation, permissions } = {}) {
  const button = {
    classList: { toggle() {} },
    attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; },
    addEventListener() {},
    title: '',
  };
  const status = {
    hidden: true,
    textContent: '',
    classList: { toggle() {} },
  };
  const mapCalls = [];
  const map = {
    getZoom: () => 5,
    flyTo(options) { mapCalls.push(options); },
  };
  const controller = createLocationController({
    map, geolocation, permissions, elements: { button, status },
  });
  return { button, controller, mapCalls, status };
}

test('la localisation zoome sur une position valide', () => {
  let success;
  let options;
  const { controller, mapCalls } = harness({
    geolocation: {
      getCurrentPosition(onSuccess, _onError, requestOptions) {
        success = onSuccess;
        options = requestOptions;
      },
    },
  });

  controller.locate();
  assert.equal(options.enableHighAccuracy, false);
  assert.equal(options.timeout, 20000);
  success({ coords: { latitude: 44.84, longitude: -0.58 } });
  assert.deepEqual(mapCalls, [{
    center: [-0.58, 44.84], zoom: 11, duration: 850, essential: true,
  }]);
});

test('un refus de permission est signalé et bloque les demandes suivantes', () => {
  let requests = 0;
  const { controller, status } = harness({
    geolocation: {
      getCurrentPosition(_success, error) {
        requests++;
        error({ code: 1 });
      },
    },
  });

  controller.locate();
  controller.locate();
  assert.equal(requests, 1);
  assert.match(status.textContent, /refusé|rechazado/);
  assert.equal(status.hidden, false);
});

test('un navigateur sans geolocalisation explique la limitation', () => {
  const { controller, status } = harness();
  controller.locate();
  assert.match(status.textContent, /n’est pas disponible|no está disponible/);
});

test('une position indisponible explique le réglage système à vérifier', () => {
  const { controller, status } = harness({
    geolocation: {
      getCurrentPosition(_success, error) { error({ code: 2 }); },
    },
  });

  controller.locate();
  assert.match(status.textContent, /Services de localisation/);
});

test('l’état de permission est suivi sans demander la position', async () => {
  let queried;
  const permissionStatus = {
    state: 'denied',
    addEventListener() {},
  };
  const { controller, button } = harness({
    geolocation: { getCurrentPosition() { throw new Error('ne doit pas être appelé'); } },
    permissions: {
      query(descriptor) {
        queried = descriptor;
        return Promise.resolve(permissionStatus);
      },
    },
  });

  await controller.checkPermission();
  assert.deepEqual(queried, { name: 'geolocation' });
  assert.match(button.title, /refusée|rechazada/);
});
