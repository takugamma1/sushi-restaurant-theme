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

test('cart updates from the fulfillment module use the hydration morph', () => {
  const js = read('assets/cart-fulfillment.js');
  assert.ok(js.includes("morphSection(sectionId, html, 'hydration')"), "a 'full' morph breaks the open drawer dialog");
});
