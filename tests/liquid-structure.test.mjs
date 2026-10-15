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
  assert.ok(snippet.includes('assign box_capacity = 12'), 'one box per 12 loose pieces');
  assert.ok(snippet.includes('loose_pieces | plus: 11 | divided_by: box_capacity'), 'rounds up: 13 pieces → 2 boxes');
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

test('cake upsell: card under the cart lines, hidden once the cake is in the cart, module loaded with the drawer', () => {
  const header = read('snippets/header-actions.liquid');
  const snippet = read('snippets/cart-upsell.liquid');

  const renderAt = header.indexOf("render 'cart-upsell', section_id: section.id");
  const itemsStart = header.indexOf('class="cart-drawer__items"');
  const summaryStart = header.indexOf('class="cart-drawer__summary"');
  assert.ok(renderAt !== -1, 'drawer renders the upsell card');
  assert.ok(renderAt > itemsStart && renderAt < summaryStart, 'card sits under the cart lines, above the fulfillment block');

  assert.ok(!/<script/.test(snippet), 'snippet has no script tag (morphed-in scripts never run)');
  const scriptAt = header.indexOf("'cart-upsell.js' | asset_url");
  const dialogEnd = header.indexOf('</dialog>');
  const drawerEnd = header.indexOf('</cart-drawer-component>');
  assert.ok(scriptAt > dialogEnd && scriptAt < drawerEnd, 'module loads with the drawer even when the cart is empty');

  assert.ok(snippet.includes('item.product.handle == cake_handle'), 'checks the cart for the cake');
  assert.ok(snippet.includes('cake_in_cart == false'), 'card is not rendered while the cake is in the cart');
  assert.ok(snippet.includes('cake.available'), 'card is inert when the cake is sold out / unpublished');
  assert.ok(snippet.includes('data-cart-upsell-add') && snippet.includes('data-order-action'), 'add button obeys the working-hours gate');
  for (const text of ['Опитайте парче', 'Try a piece', 'Попробуйте кусочек']) {
    assert.ok(snippet.includes(text), `upsell text present: ${text}`);
  }
});

test('cake promo popup: menu page only, × + add to cart, once per session, same product as the upsell', () => {
  const menu = read('sections/restaurant-menu.liquid');
  const popup = read('snippets/cake-promo-popup.liquid');
  const upsell = read('snippets/cart-upsell.liquid');

  const renderAt = menu.indexOf("render 'cake-promo-popup'");
  assert.ok(renderAt !== -1, 'menu section renders the popup');
  const guard = menu.lastIndexOf('{%- if is_menu_page -%}', renderAt);
  assert.ok(guard !== -1 && renderAt - guard < 80, 'popup is rendered only on the menu page (not the home preview)');

  const handle = (source) => source.match(/assign cake_handle = '([^']+)'/)?.[1];
  assert.ok(handle(popup), 'popup names the cake product');
  assert.equal(handle(popup), handle(upsell), 'popup and drawer upsell point at the same product');

  assert.ok(popup.includes('<dialog') && popup.includes('data-cake-promo-close'), 'popup has the × close button');
  assert.ok(popup.includes('data-cake-promo-add') && popup.includes('data-order-action'), 'add button obeys the working-hours gate');
  assert.ok(popup.includes('cake_in_cart == false'), 'not shown when the cake is already in the cart');
  assert.ok(popup.includes('mango_cake_promo_seen') && popup.includes('sessionStorage'), 'shown once per browser session');
  assert.ok(popup.includes("document.querySelector('dialog[open]')"), 'never stacks on another open dialog');
  for (const text of ['Само за ограничено време', 'Limited time only', 'Только ограниченное время']) {
    assert.ok(popup.includes(text), `popup text present: ${text}`);
  }
});

test('email promo popup: homepage only, native customer form, consent text, trilingual, remembers dismissal', () => {
  const layout = read('layout/theme.liquid');
  const popup = read('sections/email-promo-popup.liquid');

  const renderAt = layout.indexOf("{% section 'email-promo-popup' %}");
  assert.ok(renderAt !== -1, 'layout renders the popup section statically');
  const guard = layout.lastIndexOf("template.name == 'index'", renderAt);
  assert.ok(guard !== -1 && renderAt - guard < 80, 'popup is rendered only on the homepage template');

  assert.ok(popup.includes("form 'customer'"), 'emails go through the native customer form (→ Admin → Customers)');
  assert.ok(popup.includes('name="contact[email]"'), 'email input posts contact[email]');
  assert.ok(popup.includes('name="contact[tags]"') && popup.includes('promo-october-2026'), 'signups are tagged for segmentation');
  assert.ok(popup.includes('form.posted_successfully?'), 'success state after the Shopify redirect');
  assert.ok(popup.includes('data-email-promo-copy') && popup.includes('data-email-promo-code'), 'success state shows the code with a copy button');
  assert.ok(popup.includes('<dialog') && popup.includes('data-email-promo-close'), 'popup has the × close button');
  assert.ok(popup.includes('mango_email_promo_done') && popup.includes('mango_email_promo_until') && popup.includes('localStorage'), 'can remember subscribed / dismissed when days > 0');
  assert.ok(popup.includes('assign dismiss_days = section.settings.dismiss_days | default: 0'), 'default is 0 = open on every homepage visit');
  assert.ok(popup.includes('if (days > 0) {') && popup.includes('if (days <= 0) return;'), 'with 0 days nothing is remembered');
  assert.ok(/"id": "dismiss_days",[\s\S]*?"min": 0,[\s\S]*?"default": 0/.test(popup), 'schema allows 0 and defaults to it');
  assert.ok(popup.includes("document.querySelector('dialog[open]')"), 'never stacks on another open dialog');
  assert.ok(popup.includes('now_ts <= end_ts'), 'hides itself after the end date');
  for (const text of ['маркетинг съобщения', 'marketing messages', 'маркетинговые сообщения']) {
    assert.ok(popup.includes(text), `consent small print present: ${text}`);
  }
  for (const text of ['−10% за целия октомври', '−10% all October long', '−10% на весь октябрь']) {
    assert.ok(popup.includes(text), `popup title present: ${text}`);
  }
});
