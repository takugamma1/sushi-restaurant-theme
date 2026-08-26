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
import { JSDOM } from 'jsdom';
import { morphCalls, resetMorphCalls } from './mocks/section-renderer.mjs';

const MODE_DELIVERY = 'Доставка';
const MODE_PICKUP = 'Вземане от място';
const SECTION_ID = 'sections--test__header';

/* ── environment ─────────────────────────────────────── */

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://example.test/' });
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

function renderFulfillment({ mode = MODE_DELIVERY, address = '', zip = '', pills = [] } = {}) {
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
        </cart-fulfillment>
        <button type="button" id="fake-checkout" name="checkout" data-cf-blocked>Към плащане</button>
      </div>
      <dialog id="cf-map-dialog" class="cf-map"><div id="cf-map-canvas"><div class="cf-map__loading"></div></div></dialog>
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
  window.localStorage.clear();
  document.body.innerHTML = '';
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
