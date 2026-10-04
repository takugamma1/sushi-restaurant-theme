/**
 * Behavioral tests for assets/cart-fulfillment.js (delivery / pickup toggle).
 *
 * They run the real module in a jsdom document with fetch mocked — no store,
 * no network, no orders. The module is imported BEFORE any fulfillment markup
 * exists (exactly like a first visit with an empty cart), and the markup is
 * injected afterwards the way a section morph delivers it. That ordering IS
 * the regression under test: the toggle must work without a page refresh.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM, VirtualConsole } from 'jsdom';
import { morphCalls, resetMorphCalls } from './mocks/section-renderer.mjs';

const MODE_DELIVERY = 'Доставка';
const MODE_PICKUP = 'Вземане от място';
const SECTION_ID = 'sections--test__header';

/* ── environment ─────────────────────────────────────── */

// jsdom cannot navigate; it reports attempts as "not implemented" errors. Collect
// them so tests can assert "went to checkout" vs "stayed in the drawer".
let navigationAttempts = 0;
const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', (error) => {
  if (/navigation/i.test(String(error?.message))) navigationAttempts++;
});
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://example.test/', virtualConsole });
const { window } = dom;

for (const key of ['document', 'HTMLElement', 'HTMLTemplateElement', 'customElements', 'Node', 'MouseEvent', 'CustomEvent', 'localStorage']) {
  Object.defineProperty(globalThis, key, { value: window[key], writable: true, configurable: true });
}
globalThis.window = window;
globalThis.Theme = { routes: { cart_update_url: '/cart/update.js' } };

let fetchCalls = [];
let fetchResponder; // set per test
globalThis.fetch = (url, config) => {
  fetchCalls.push({ url: String(url), config });
  return fetchResponder(url, config);
};

const okCartResponse = (extra = {}) => ({
  ok: true,
  json: async () => ({
    sections: { [SECTION_ID]: '<div>updated section html</div>' },
    discount_codes: [{ code: 'PICKUP10', applicable: true }],
    ...extra,
  }),
});

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

// Import the real module ONCE, before any fulfillment markup exists — the
// first-visit scenario. All wiring must be event delegation for this to pass.
await import('../assets/cart-fulfillment.js');

/* ── fixture (mirrors snippets/cart-fulfillment.liquid) ── */

function renderFulfillment({ mode = MODE_DELIVERY, address = '', zip = '', phone = '', pills = [], blockedReason = '' } = {}) {
  const activeDelivery = mode !== MODE_PICKUP ? ' cart-fulfillment__option--active' : '';
  const activePickup = mode === MODE_PICKUP ? ' cart-fulfillment__option--active' : '';
  document.body.innerHTML = `
    <div id="shopify-section-${SECTION_ID}">
      <div data-hydration-key="cart-drawer-inner">
        ${pills.map((code) => `<span class="cart-discount__pill" data-discount-code="${code}"></span>`).join('')}
        <cart-fulfillment
          data-section-id="${SECTION_ID}"
          data-mode="${mode}"
          data-address="${address}"
          data-zip="${zip}"
          data-phone="${phone}"
          data-maps-key="test-key"
          data-discount-code="PICKUP10"
          data-storefront-token=""
        >
          <div class="cart-fulfillment__toggle" role="radiogroup">
            <button type="button" class="cart-fulfillment__option${activeDelivery}" data-cf-mode="${MODE_DELIVERY}" role="radio" aria-checked="${mode !== MODE_PICKUP}">
              <span>${MODE_DELIVERY}</span>
            </button>
            <button type="button" class="cart-fulfillment__option${activePickup}" data-cf-mode="${MODE_PICKUP}" role="radio" aria-checked="${mode === MODE_PICKUP}">
              <span>${MODE_PICKUP}</span>
            </button>
          </div>
          <div data-cf-body></div>
          <p class="cart-fulfillment__error" data-cf-error hidden></p>
          <div class="cart-sticks" data-cf-sticks>
            <div class="cart-sticks__row">
              ${[1, 2, 3, 4].map((n) => `<button type="button" class="cart-sticks__option" data-sticks-value="${n}" aria-pressed="false">${n}</button>`).join('')}
              <input class="cart-sticks__custom" type="number" data-sticks-custom value="">
            </div>
            <p class="cart-fulfillment__error" data-sticks-error hidden></p>
          </div>
          <div class="cart-phone" data-cf-phone-box>
            <input id="cf-phone" class="cart-phone__input" type="tel" value="${phone}" data-cf-phone>
            <p class="cart-fulfillment__error" data-phone-error hidden></p>
          </div>
        </cart-fulfillment>
        <button type="button" id="fake-checkout" name="checkout" data-cf-blocked data-cf-blocked-reason="${blockedReason}">Към плащане</button>
      </div>
      <dialog id="cf-map-dialog" class="cf-map">
        <button type="button" data-cf-locate>Използвай моето местоположение</button>
        <input id="cf-map-search" type="text">
        <ul data-cf-suggestions hidden></ul>
        <input id="cf-addr-details" type="text" data-cf-details>
        <p data-cf-addr-status hidden></p>
        <button type="button" data-cf-confirm>Потвърди адреса</button>
      </dialog>
    </div>`;
}

function click(el) {
  el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
}

const button = (mode) => document.querySelector(`[data-cf-mode="${mode}"]`);
const isActive = (mode) => button(mode).classList.contains('cart-fulfillment__option--active');

beforeEach(() => {
  fetchCalls = [];
  fetchResponder = () => Promise.resolve(okCartResponse());
  resetMorphCalls();
  navigationAttempts = 0;
  window.localStorage.clear();
  document.body.innerHTML = '';
  delete globalThis.navigator.geolocation;
});

/* ── tests ───────────────────────────────────────────── */

test('first visit: toggle works on markup injected after the module loaded (no refresh needed)', async () => {
  renderFulfillment(); // injected later, as a section morph would
  click(button(MODE_PICKUP));
  await flush();

  assert.equal(fetchCalls.length, 1, 'one cart update request');
  const body = JSON.parse(fetchCalls[0].config.body);
  assert.equal(body.attributes['Получаване'], MODE_PICKUP);
  assert.deepEqual(body.sections, [SECTION_ID]);
  assert.ok(body.discount.split(',').includes('PICKUP10'), 'applies the pickup discount');
});

test('clicking pickup paints the toggle optimistically and clears busy state after', async () => {
  renderFulfillment();
  let release;
  fetchResponder = () => new Promise((resolve) => (release = () => resolve(okCartResponse())));

  click(button(MODE_PICKUP));
  // Instant feedback, before the network responds:
  assert.equal(isActive(MODE_PICKUP), true);
  assert.equal(isActive(MODE_DELIVERY), false);
  assert.equal(button(MODE_PICKUP).getAttribute('aria-checked'), 'true');
  assert.equal(document.querySelector('cart-fulfillment').getAttribute('aria-busy'), 'true');

  release();
  await flush();
  assert.equal(document.querySelector('cart-fulfillment').hasAttribute('aria-busy'), false);
});

test('drawer is updated with a hydration morph, never a full section morph', async () => {
  renderFulfillment();
  click(button(MODE_PICKUP));
  await flush();

  assert.equal(morphCalls.length, 1);
  assert.equal(morphCalls[0].sectionId, SECTION_ID);
  assert.equal(morphCalls[0].mode, 'hydration', 'a full morph clobbers the open drawer dialog');
});

test('switching back to delivery keeps other discount codes and drops PICKUP10', async () => {
  renderFulfillment({ mode: MODE_PICKUP, pills: ['WELCOME', 'PICKUP10'] });
  window.localStorage.setItem(
    'mango_delivery_address',
    JSON.stringify({ formatted: 'ул. Тест 1, Варна', address1: 'ул. Тест 1', city: 'Варна', zip: '9000', lat: 43.2, lng: 27.9 })
  );

  click(button(MODE_DELIVERY));
  await flush();

  const body = JSON.parse(fetchCalls[0].config.body);
  assert.equal(body.attributes['Получаване'], MODE_DELIVERY);
  assert.equal(body.attributes['Адрес за доставка'], 'ул. Тест 1, Варна');
  assert.equal(body.attributes['Пощенски код'], '9000');
  assert.equal(body.discount, 'WELCOME');
});

test('a second click while a request is in flight is ignored (no double submit)', async () => {
  renderFulfillment();
  let release;
  fetchResponder = () => new Promise((resolve) => (release = () => resolve(okCartResponse())));

  click(button(MODE_PICKUP));
  click(button(MODE_DELIVERY)); // busy — must be ignored
  assert.equal(fetchCalls.length, 1);

  release();
  await flush();
  assert.equal(fetchCalls.length, 1);
});

test('combo-only cart: pickup keeps working and explains the discount exclusion', async () => {
  renderFulfillment();
  // Shopify accepts the code but nothing qualifies (PICKUP10 excludes the combos).
  fetchResponder = () => Promise.resolve(okCartResponse({ discount_codes: [{ code: 'PICKUP10', applicable: false }] }));

  click(button(MODE_PICKUP));
  await flush();

  assert.equal(isActive(MODE_PICKUP), true, 'pickup mode still switches');
  const error = document.querySelector('[data-cf-error]');
  assert.equal(error.hidden, false);
  assert.ok(error.textContent.includes('Вечеря за двама'), 'message explains the combo exclusion');
});

test('failed cart update reverts the optimistic paint and shows an error', async () => {
  renderFulfillment();
  fetchResponder = () => Promise.resolve({ ok: false, json: async () => ({}) });

  click(button(MODE_PICKUP));
  await flush();

  assert.equal(isActive(MODE_DELIVERY), true, 'reverted to the server-known mode');
  assert.equal(isActive(MODE_PICKUP), false);
  const error = document.querySelector('[data-cf-error]');
  assert.equal(error.hidden, false);
  assert.ok(error.textContent.length > 0);
  assert.equal(document.querySelector('cart-fulfillment').hasAttribute('aria-busy'), false);
});

test('choosing delivery with no saved address opens the map dialog', async () => {
  renderFulfillment({ mode: MODE_PICKUP });
  const dialog = document.querySelector('dialog.cf-map');
  let opened = 0;
  dialog.showModal = () => opened++;

  click(button(MODE_DELIVERY));
  await flush();

  assert.equal(opened, 1, 'map dialog opened so the user can drop a pin');
  const body = JSON.parse(fetchCalls[0].config.body);
  assert.equal(body.attributes['Адрес за доставка'], '', 'no address is invented');
});

test('chopsticks: quick pick saves the count as a cart attribute with instant feedback', async () => {
  renderFulfillment();
  click(document.querySelector('[data-sticks-value="3"]'));
  assert.equal(document.querySelector('[data-sticks-value="3"]').classList.contains('cart-sticks__option--active'), true);
  assert.equal(document.querySelector('[data-sticks-value="3"]').getAttribute('aria-pressed'), 'true');
  await flush();

  assert.equal(fetchCalls.length, 1);
  const body = JSON.parse(fetchCalls[0].config.body);
  assert.equal(body.attributes['Клечки'], '3');
  assert.equal(morphCalls[0].mode, 'hydration');
});

test('chopsticks: typed custom count saves on change and highlights the input', async () => {
  renderFulfillment();
  const custom = document.querySelector('[data-sticks-custom]');
  custom.value = '7';
  custom.dispatchEvent(new window.Event('change', { bubbles: true }));
  await flush();

  const body = JSON.parse(fetchCalls[0].config.body);
  assert.equal(body.attributes['Клечки'], '7');
  assert.equal(custom.classList.contains('cart-sticks__custom--active'), true);
  assert.equal(document.querySelector('[data-sticks-value="4"]').classList.contains('cart-sticks__option--active'), false);
});

test('chopsticks: invalid count is rejected with a message and no request', async () => {
  renderFulfillment();
  const custom = document.querySelector('[data-sticks-custom]');
  custom.value = '250';
  custom.dispatchEvent(new window.Event('change', { bubbles: true }));
  await flush();

  assert.equal(fetchCalls.length, 0);
  assert.equal(document.querySelector('[data-sticks-error]').hidden, false);
});

test('delivery checkout blocked for missing chopsticks prompts for the count, not the map', async () => {
  renderFulfillment({ blockedReason: 'sticks' });
  const dialog = document.querySelector('dialog.cf-map');
  let opened = 0;
  dialog.showModal = () => opened++;

  click(document.querySelector('#fake-checkout'));
  await flush();

  assert.equal(opened, 0, 'map must not open');
  const error = document.querySelector('[data-sticks-error]');
  assert.equal(error.hidden, false);
  assert.ok(error.textContent.includes('клечки'));
  assert.equal(fetchCalls.length, 0);
});

test('blocked checkout button opens the map instead of navigating', async () => {
  renderFulfillment();
  const dialog = document.querySelector('dialog.cf-map');
  let opened = 0;
  dialog.showModal = () => opened++;

  click(document.querySelector('#fake-checkout'));
  await flush();

  assert.equal(opened, 1);
  assert.equal(fetchCalls.length, 0, 'no cart mutation from a blocked checkout click');
});

/* ── contact phone ───────────────────────────────────── */

function typePhone(value) {
  const input = document.querySelector('[data-cf-phone]');
  input.value = value;
  input.dispatchEvent(new window.Event('change', { bubbles: true }));
  return input;
}

test('phone: a valid number is normalized and saved as the Телефон cart attribute', async () => {
  renderFulfillment();
  const input = typePhone('0888 123-456');
  await flush();

  assert.equal(fetchCalls.length, 1);
  const body = JSON.parse(fetchCalls[0].config.body);
  assert.equal(body.attributes['Телефон'], '0888123456');
  assert.equal(input.classList.contains('cart-phone__input--ok'), true);
  assert.equal(document.querySelector('[data-phone-error]').hidden, true);
  assert.equal(window.localStorage.getItem('mango_contact_phone'), '0888123456', 'remembered for the next order');
});

test('phone: international format is kept with its plus prefix', async () => {
  renderFulfillment();
  typePhone('+359 88 812 3456');
  await flush();
  assert.equal(JSON.parse(fetchCalls[0].config.body).attributes['Телефон'], '+359888123456');
});

test('phone: an implausible number is rejected with a message and no request', async () => {
  renderFulfillment();
  const input = typePhone('12345');
  await flush();

  assert.equal(fetchCalls.length, 0);
  assert.equal(document.querySelector('[data-phone-error]').hidden, false);
  assert.equal(input.classList.contains('cart-phone__input--error'), true);
});

test('phone: re-committing the already saved number makes no request', async () => {
  renderFulfillment({ phone: '0888123456' });
  typePhone('0888 123 456');
  await flush();
  assert.equal(fetchCalls.length, 0);
});

test('checkout blocked for a missing phone asks for it and stays in the drawer', async () => {
  renderFulfillment({ blockedReason: 'phone' });
  click(document.querySelector('#fake-checkout'));
  await flush();

  assert.equal(fetchCalls.length, 0);
  assert.equal(navigationAttempts, 0, 'must not reach checkout without a phone');
  assert.equal(document.querySelector('[data-phone-error]').hidden, false);
});

test('checkout blocked for phone: a typed valid number is saved and checkout continues in one click', async () => {
  renderFulfillment({ blockedReason: 'phone' });
  document.querySelector('[data-cf-phone]').value = '0888123456'; // typed, not yet committed
  click(document.querySelector('#fake-checkout'));
  await flush();

  assert.equal(fetchCalls.length, 1, 'phone saved exactly once');
  assert.equal(JSON.parse(fetchCalls[0].config.body).attributes['Телефон'], '0888123456');
  assert.equal(navigationAttempts, 1, 'continued to checkout');
});

test('checkout blocked for phone: a failed save keeps the customer in the drawer', async () => {
  renderFulfillment({ blockedReason: 'phone' });
  fetchResponder = () => Promise.resolve({ ok: false, json: async () => ({}) });
  document.querySelector('[data-cf-phone]').value = '0888123456';
  click(document.querySelector('#fake-checkout'));
  await flush();

  assert.equal(navigationAttempts, 0);
  assert.equal(document.querySelector('[data-phone-error]').hidden, false);
});

/* ── delivery address dialog (OpenStreetMap lookup, no Google) ── */

const photonFeature = (props, lng, lat) => ({
  type: 'Feature',
  properties: props,
  geometry: { type: 'Point', coordinates: [lng, lat] },
});

const TSAR = photonFeature(
  { type: 'house', name: 'Орбита', street: 'бул. Цар Освободител', housenumber: '25', district: 'Център', city: 'Варна', postcode: '9000' },
  27.92112,
  43.20932
);
const TSAR_SHOP = photonFeature(
  { type: 'house', name: 'Carrefour', street: 'бул. Цар Освободител', housenumber: '25', district: 'Център', city: 'Варна', postcode: '9000' },
  27.92091,
  43.20947
);
const KOLAROV = photonFeature({ type: 'street', name: 'Д-р Николай Коларов', district: 'кв. Бриз', postcode: '4010' }, 27.947056, 43.220108);

/** Route the fetch mock: address lookups get `lookup`, cart updates succeed. */
function routeFetch({ search, reverse, nominatim } = {}) {
  fetchResponder = (url) => {
    const u = String(url);
    const reply = (value) =>
      value instanceof Error ? Promise.reject(value) : Promise.resolve({ ok: true, json: async () => value });
    if (u.startsWith('https://photon.komoot.io/api/')) return reply(search ?? { features: [] });
    if (u.startsWith('https://photon.komoot.io/reverse')) return reply(reverse ?? { features: [] });
    if (u.startsWith('https://nominatim.openstreetmap.org/')) return reply(nominatim ?? {});
    return Promise.resolve(okCartResponse());
  };
}

/** Open the dialog (moved to <body> by the module) and return its controls. */
function openAddress() {
  const dialog = document.querySelector('dialog.cf-map');
  dialog.showModal = () => {};
  dialog.close = () => dialog.setAttribute('data-closed', '');
  click(button(MODE_DELIVERY)); // no-op when already delivery; keeps focus on the dialog path
  click(document.querySelector('#fake-checkout')); // blocked w/o address -> opens the dialog
  return {
    dialog,
    street: dialog.querySelector('#cf-map-search'),
    details: dialog.querySelector('[data-cf-details]'),
    status: dialog.querySelector('[data-cf-addr-status]'),
    suggestions: () => Array.from(dialog.querySelectorAll('[data-cf-suggestions] button')),
    confirm: () => click(dialog.querySelector('[data-cf-confirm]')),
  };
}

async function typeStreet(input, value) {
  input.value = value;
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 360)); // past the 300ms debounce
  await flush();
}

const cartUpdates = () => fetchCalls.filter((c) => c.url === '/cart/update.js').map((c) => JSON.parse(c.config.body));
const lookups = () => fetchCalls.filter((c) => c.url.startsWith('https://'));

test('address: typing searches OpenStreetMap inside the delivery area and lists deduplicated suggestions', async () => {
  renderFulfillment();
  routeFetch({ search: { features: [TSAR, TSAR_SHOP, KOLAROV] } });
  const ui = openAddress();
  await typeStreet(ui.street, 'Цар Освободител 25');

  assert.equal(lookups().length, 1);
  const url = new URL(lookups()[0].url);
  assert.equal(url.origin, 'https://photon.komoot.io');
  assert.equal(url.searchParams.get('bbox'), '27.6,43.05,28.2,43.45');
  const labels = ui.suggestions().map((b) => b.textContent);
  assert.equal(labels[0], 'бул. Цар Освободител 25, Център, Варна');
  assert.equal(labels[1], 'Д-р Николай Коларов, кв. Бриз, Варна', 'two shops at one address collapse into one row');
  assert.ok(labels[2].includes('Адресът ми не е в списъка'), 'manual escape row is always offered');
  assert.equal(labels.length, 3);
});

test('address: picking a suggestion + details saves address, postcode and coordinates on the cart', async () => {
  renderFulfillment();
  routeFetch({ search: { features: [TSAR] } });
  const ui = openAddress();
  await typeStreet(ui.street, 'Цар Освободител');
  click(ui.suggestions()[0]);

  assert.equal(ui.street.value, 'бул. Цар Освободител');
  assert.equal(ui.details.value, '25', 'house number is prefilled into the details field');
  ui.details.value = '25, вх. Б, ап. 4';
  ui.confirm();
  await flush();

  const [update] = cartUpdates();
  assert.equal(update.attributes['Получаване'], MODE_DELIVERY);
  assert.equal(update.attributes['Адрес за доставка'], 'бул. Цар Освободител 25, вх. Б, ап. 4, Център, Варна');
  assert.equal(update.attributes['Пощенски код'], '9000');
  assert.equal(update.attributes['Координати'], '43.20932, 27.92112');
  assert.equal(ui.dialog.hasAttribute('data-closed'), true);
  const saved = JSON.parse(window.localStorage.getItem('mango_delivery_address'));
  assert.equal(saved.address1, 'бул. Цар Освободител 25, вх. Б, ап. 4');
  assert.equal(saved.city, 'Варна');
});

test('address: an implausible OpenStreetMap postcode is dropped', async () => {
  renderFulfillment();
  routeFetch({ search: { features: [KOLAROV] } });
  const ui = openAddress();
  await typeStreet(ui.street, 'Николай Коларов');
  click(ui.suggestions()[0]);
  ui.details.value = '1';
  ui.confirm();
  await flush();

  const [update] = cartUpdates();
  assert.equal(update.attributes['Адрес за доставка'], 'Д-р Николай Коларов 1, кв. Бриз, Варна');
  assert.equal(update.attributes['Пощенски код'], '', '4010 is not a Varna postcode');
});

test('address: a typed street that was not chosen from the suggestions is rejected', async () => {
  renderFulfillment();
  routeFetch({ search: { features: [TSAR] } });
  const ui = openAddress();
  await typeStreet(ui.street, 'Цар Освободител');
  ui.details.value = '25';
  ui.confirm();
  await flush();

  assert.equal(cartUpdates().length, 0);
  assert.equal(ui.status.hidden, false);
  assert.ok(ui.status.textContent.includes('предложенията'));
});

test('address: number / entrance details are required', async () => {
  renderFulfillment();
  routeFetch({ search: { features: [KOLAROV] } });
  const ui = openAddress();
  await typeStreet(ui.street, 'Николай Коларов');
  click(ui.suggestions()[0]);
  ui.confirm();
  await flush();

  assert.equal(cartUpdates().length, 0);
  assert.ok(ui.status.textContent.includes('номер'));
});

test('address: "not in the list" row keeps exactly what the customer typed (no coordinates)', async () => {
  renderFulfillment();
  routeFetch({ search: { features: [TSAR] } });
  const ui = openAddress();
  await typeStreet(ui.street, 'ул. Нова 7');
  click(ui.suggestions().at(-1));
  ui.confirm();
  await flush();

  const [update] = cartUpdates();
  assert.equal(update.attributes['Адрес за доставка'], 'ул. Нова 7, Варна');
  assert.equal(update.attributes['Координати'], '');
});

test('address: when the lookup service is down the order is still possible with a typed address', async () => {
  renderFulfillment();
  routeFetch({ search: new Error('network down') });
  const ui = openAddress();
  await typeStreet(ui.street, 'ул. Битоля');
  assert.equal(ui.status.hidden, false, 'customer is told the search is unavailable');
  ui.details.value = '12, ет. 2';
  ui.confirm();
  await flush();

  const [update] = cartUpdates();
  assert.equal(update.attributes['Адрес за доставка'], 'ул. Битоля 12, ет. 2, Варна');
  assert.equal(update.attributes['Координати'], '');
});

function mockGeolocation(result) {
  Object.defineProperty(globalThis.navigator, 'geolocation', {
    configurable: true,
    value: {
      getCurrentPosition: (ok, fail) =>
        result.error ? fail(result.error) : ok({ coords: { latitude: result.lat, longitude: result.lng } }),
    },
  });
}

test('current location: fills the street from reverse lookup and keeps the exact GPS position', async () => {
  renderFulfillment();
  routeFetch({ reverse: { features: [TSAR] } });
  mockGeolocation({ lat: 43.2101234, lng: 27.9209876 });
  const ui = openAddress();
  click(ui.dialog.querySelector('[data-cf-locate]'));
  await flush();

  assert.equal(ui.street.value, 'бул. Цар Освободител');
  assert.equal(ui.details.value, '25');
  ui.confirm();
  await flush();
  const [update] = cartUpdates();
  assert.equal(update.attributes['Координати'], '43.210123, 27.920988', 'GPS position, not the matched building');
});

test('current location: falls back to Nominatim when Photon does not know the street', async () => {
  renderFulfillment();
  routeFetch({
    reverse: { features: [] },
    nominatim: { address: { road: 'ул. Георги Китов', house_number: '3', city: 'Варна', postcode: '9005' } },
  });
  mockGeolocation({ lat: 43.2255, lng: 27.937 });
  const ui = openAddress();
  click(ui.dialog.querySelector('[data-cf-locate]'));
  await flush();

  assert.equal(ui.street.value, 'ул. Георги Китов');
  assert.equal(ui.details.value, '3');
});

test('current location: outside the delivery area is refused and nothing is filled', async () => {
  renderFulfillment();
  routeFetch();
  mockGeolocation({ lat: 42.6977, lng: 23.3219 }); // Sofia
  const ui = openAddress();
  click(ui.dialog.querySelector('[data-cf-locate]'));
  await flush();

  assert.equal(lookups().length, 0);
  assert.equal(ui.street.value, '');
  assert.ok(ui.status.textContent.includes('извън зоната'));
});

test('current location: a denied permission explains what to do', async () => {
  renderFulfillment();
  routeFetch();
  mockGeolocation({ error: { code: 1 } });
  const ui = openAddress();
  click(ui.dialog.querySelector('[data-cf-locate]'));
  await flush();

  assert.ok(ui.status.textContent.includes('Разрешете достъп'));
});
