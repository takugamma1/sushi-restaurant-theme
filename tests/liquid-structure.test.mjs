/**
 * Static regression checks on the Liquid structure of the cart drawer.
 *
 * Guards the "toggle only works after a refresh" bug: the fulfillment module
 * must load from the always-rendered drawer markup, never from the snippet
 * that only renders when the cart has items (scripts injected by a section
 * morph do not execute).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

test('cart-fulfillment snippet contains no script tag (morphed-in scripts never run)', () => {
  const snippet = read('snippets/cart-fulfillment.liquid');
  assert.ok(!/<script[^>]*asset_url/.test(snippet), 'move script loading to header-actions.liquid instead');
});

test('header-actions loads cart-fulfillment.js unconditionally with the drawer', () => {
  const header = read('snippets/header-actions.liquid');
  const scriptAt = header.indexOf("'cart-fulfillment.js' | asset_url");
  assert.ok(scriptAt !== -1, 'cart-fulfillment.js must be loaded from header-actions.liquid');

  // Must sit between the drawer dialog and the end of the drawer component —
  // i.e. outside the cart.empty? conditional, so it loads on first visit too.
  const dialogEnd = header.indexOf('</dialog>');
  const drawerEnd = header.indexOf('</cart-drawer-component>');
  assert.ok(dialogEnd !== -1 && drawerEnd !== -1, 'expected drawer markup present');
  assert.ok(scriptAt > dialogEnd && scriptAt < drawerEnd, 'script tag must be outside the cart.empty? branches');
});

test('menu page category tabs prefer the admin-set collection image', () => {
  const menu = read('sections/restaurant-menu.liquid');
  assert.ok(
    menu.includes('assign tab_image = tab_collection.featured_image'),
    'tab image must come from collection.featured_image (admin image first, product photo as fallback)'
  );
  assert.ok(
    !menu.includes('tab_collection.products.first.featured_image | default: tab_collection.image'),
    'first-product image must not take priority over the admin collection image'
  );
});

test('language switcher: dropdown by the order button, row in the drawer, nav stays clean', () => {
  assert.ok(
    read('snippets/header-row.liquid').includes("render 'language-switcher', context: 'dropdown'"),
    'actions column (next to the order CTA) must render the dropdown variant'
  );
  assert.ok(
    read('snippets/header-restaurant-drawer.liquid').includes("render 'language-switcher', context: 'drawer'"),
    'mobile drawer must render the row variant'
  );
  assert.ok(
    !read('snippets/header-restaurant-nav.liquid').includes('language-switcher'),
    'centered nav must not contain the switcher (menu items stay centered)'
  );
  assert.ok(
    read('sections/header.liquid').includes("render 'language-switcher', context: 'sticky'"),
    'header must render the mobile sticky floating language button'
  );
  const sw = read('snippets/language-switcher.liquid');
  assert.ok(sw.includes('localization.available_languages'), 'switcher lists published languages dynamically');
  assert.ok(sw.includes('remove_first: current_root'), 'switcher strips the current locale prefix from the path');
  assert.ok(sw.includes('lang-dd--sticky'), 'sticky variant exists');
});

test('chopsticks widget is rendered and gates delivery checkout server-side', () => {
  const snippet = read('snippets/cart-fulfillment.liquid');
  assert.ok(snippet.includes('data-cf-sticks'), 'fulfillment block renders the chopsticks widget');
  assert.ok(snippet.includes("cart.attributes['Клечки']"), 'widget reads the Клечки cart attribute');
  const summary = read('snippets/cart-summary.liquid');
  assert.ok(summary.includes("cart.attributes['Клечки'] == blank"), 'checkout is blocked when delivery has no chopsticks count');
  assert.ok(summary.includes('data-cf-blocked-reason'), 'blocked button carries the reason for the drawer JS');
});

test('contact phone is rendered and gates checkout for every order type', () => {
  const snippet = read('snippets/cart-fulfillment.liquid');
  assert.ok(snippet.includes('data-cf-phone'), 'fulfillment block renders the phone input');
  assert.ok(snippet.includes("cart.attributes['Телефон']"), 'input reads the Телефон cart attribute');
  const summary = read('snippets/cart-summary.liquid');
  assert.ok(summary.includes("cart.attributes['Телефон'] == blank"), 'checkout is blocked without a phone');
  const phoneGate = summary.indexOf("cart.attributes['Телефон'] == blank");
  const deliveryBlockEnd = summary.indexOf('endif', summary.indexOf("assign cf_blocked_reason = 'sticks'"));
  assert.ok(phoneGate > deliveryBlockEnd, 'phone gate sits outside the delivery-only block so pickup needs it too');
});

test('address capture has no Google Maps dependency (no API key, no billing)', () => {
  const snippet = read('snippets/cart-fulfillment.liquid');
  const js = read('assets/cart-fulfillment.js');
  for (const [name, source] of [['snippet', snippet], ['module', js]]) {
    assert.ok(!/googleapis|google\.maps|maps-key|AIza/.test(source), `${name} must not reference Google Maps`);
  }
  assert.ok(snippet.includes('data-cf-details'), 'dialog has the number / entrance / floor field');
  assert.ok(snippet.includes('data-cf-locate'), 'dialog has the current-location button');
  assert.ok(snippet.includes('OpenStreetMap'), 'OpenStreetMap attribution is shown');
});

test('delivery pause: both snippets use the same end time and the popup is trilingual', () => {
  const snippet = read('snippets/cart-fulfillment.liquid');
  const summary = read('snippets/cart-summary.liquid');
  const until = (source) => source.match(/assign delivery_paused_until = (\d+)/)?.[1];
  assert.ok(until(snippet), 'fulfillment snippet defines the pause end time');
  assert.equal(until(snippet), until(summary), 'drawer UI and checkout gate must agree on the end time');
  assert.ok(summary.includes("assign cf_blocked_reason = 'paused'"), 'checkout is gated server-side while paused');
  assert.ok(snippet.includes('cf-pause-dialog') && snippet.includes('data-cf-pause-pickup'), 'popup with a pickup call to action');
  for (const text of ['Доставката е временно недостъпна', 'Delivery is temporarily unavailable', 'Доставка временно недоступна']) {
    assert.ok(snippet.includes(text), `popup text present: ${text}`);
  }
});

test('packaging boxes: requirement computed in the drawer, box line locked in the cart list', () => {
  const snippet = read('snippets/cart-fulfillment.liquid');
  assert.ok(snippet.includes("all_products['opakovka']"), 'box product looked up by handle');
  assert.ok(snippet.includes('assign box_capacity = 8'), 'one box per 8 loose pieces');
  assert.ok(snippet.includes('data-box-required'), 'required count exposed to the JS');
  for (const h of ['setove', 'vecherya-za-dvama', 'poke', 'topli-predlozheniya']) {
    assert.ok(snippet.includes(`handles contains '${h}'`), `${h} counts as own packaging`);
  }
  const products = read('snippets/cart-products.liquid');
  assert.ok(products.includes("item.product.handle == 'opakovka'"), 'box line has no quantity/remove controls');
});

test('cart updates from the fulfillment module use the hydration morph', () => {
  const js = read('assets/cart-fulfillment.js');
  assert.ok(js.includes("morphSection(sectionId, html, 'hydration')"), "a 'full' morph breaks the open drawer dialog");
});
