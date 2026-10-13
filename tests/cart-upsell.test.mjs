/**
 * Behavioral tests for assets/cart-upsell.js (one-tap cake add in the drawer).
 *
 * Same harness as cart-fulfillment.test.mjs: the real module runs in jsdom with
 * fetch mocked, imported BEFORE any upsell markup exists (first visit, empty
 * cart) — the card only ever arrives through a section morph, so everything
 * must be event delegation.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { morphCalls, resetMorphCalls } from './mocks/section-renderer.mjs';

const SECTION_ID = 'sections--test__header';
const VARIANT = 55595363041609;

/* ── environment ─────────────────────────────────────── */

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://example.test/pages/menu' });
const { window } = dom;

for (const key of ['document', 'HTMLElement', 'customElements', 'Node', 'MouseEvent', 'CustomEvent']) {
  Object.defineProperty(globalThis, key, { value: window[key], writable: true, configurable: true });
}
globalThis.window = window;
globalThis.Theme = { routes: { cart_add_url: '/cart/add.js', cart_url: '/cart' } };

let fetchCalls = [];
let fetchResponder; // set per test
globalThis.fetch = (url, config) => {
  fetchCalls.push({ url: String(url), config });
  return fetchResponder(url, config);
};

const addResponse = () => ({
  ok: true,
  json: async () => ({ items: [{ id: VARIANT, quantity: 1 }], sections: { [SECTION_ID]: '<div>updated section html</div>' } }),
});
const cartResponse = () => ({ ok: true, json: async () => ({ item_count: 3 }) });
const respondOk = (url) => Promise.resolve(String(url).includes('/cart/add') ? addResponse() : cartResponse());

const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

// Import the real module ONCE, before any upsell markup exists.
await import('../assets/cart-upsell.js');

/* ── fixture (mirrors snippets/cart-upsell.liquid) ──── */

function renderUpsell() {
  document.body.innerHTML = `
    <div id="shopify-section-${SECTION_ID}">
      <cart-items-component data-section-id="${SECTION_ID}">
        <div data-hydration-key="cart-drawer-inner">
          <div class="cart-upsell" data-cart-upsell data-section-id="${SECTION_ID}" data-variant-id="${VARIANT}">
            <button type="button" class="cart-upsell__add" data-cart-upsell-add data-order-action>Добави</button>
            <p class="cart-upsell__error" data-cart-upsell-error hidden>Не успяхме да добавим</p>
          </div>
        </div>
      </cart-items-component>
    </div>`;
}

const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
const addButton = () => document.querySelector('[data-cart-upsell-add]');
const addCalls = () => fetchCalls.filter((c) => c.url === '/cart/add.js');

beforeEach(() => {
  fetchCalls = [];
  fetchResponder = respondOk;
  resetMorphCalls();
  document.body.innerHTML = '';
});

/* ── tests ───────────────────────────────────────────── */

test('first visit: the add button works on markup injected after the module loaded', async () => {
  renderUpsell();
  click(addButton());
  await flush();

  assert.equal(addCalls().length, 1, 'one add request');
  const { config } = addCalls()[0];
  assert.equal(config.method, 'POST');
  const body = JSON.parse(config.body);
  assert.deepEqual(body.items, [{ id: VARIANT, quantity: 1 }], 'adds exactly one piece of the cake');
  assert.equal(body.sections, SECTION_ID, 'asks for the drawer section so it can be re-rendered');
});

test('open drawer is re-rendered with the hydration morph and the theme is told the new count', async () => {
  const events = [];
  const listener = (event) => events.push(event);
  document.addEventListener('cart:update', listener);
  try {
    renderUpsell();
    click(addButton());
    await flush();

    assert.deepEqual(morphCalls, [{ sectionId: SECTION_ID, html: '<div>updated section html</div>', mode: 'hydration' }]);
    assert.equal(events.length, 1, 'one cart:update event');
    assert.equal(events[0].detail.data.itemCount, 3, 'absolute count from the fresh cart');
    assert.equal(
      events[0].target.tagName.toLowerCase(),
      'cart-items-component',
      'dispatched from the cart-items-component so it skips its own full morph (which would clobber the open drawer)'
    );
  } finally {
    document.removeEventListener('cart:update', listener);
  }
});

test('double tap adds the cake once', async () => {
  renderUpsell();
  click(addButton());
  click(addButton());
  await flush();

  assert.equal(addCalls().length, 1);
});

test('failed add shows the inline error, re-enables the button and leaves the drawer alone', async () => {
  fetchResponder = () => Promise.resolve({ ok: false, json: async () => ({}) });
  renderUpsell();
  click(addButton());
  await flush();

  assert.equal(document.querySelector('[data-cart-upsell-error]').hidden, false, 'error is visible');
  assert.equal(addButton().disabled, false, 'customer can retry');
  assert.equal(document.querySelector('[data-cart-upsell]').getAttribute('aria-busy'), null);
  assert.equal(morphCalls.length, 0);

  // …and the retry goes through.
  fetchResponder = respondOk;
  click(addButton());
  await flush();
  assert.equal(addCalls().length, 2);
  assert.equal(document.querySelector('[data-cart-upsell-error]').hidden, true, 'error cleared on retry');
});
