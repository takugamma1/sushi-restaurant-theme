import { fetchConfig } from '@theme/utilities';
import { morphSection } from '@theme/section-renderer';

/**
 * Cart drawer upsell (homemade biscuit cake): one-tap add from the drawer.
 *
 * The card is rendered server-side (snippets/cart-upsell.liquid) with every
 * drawer morph and is simply absent while the cake is in the cart, so this
 * module only has to add the line and re-render the open drawer.
 *
 * Everything is event delegation: the markup arrives later via section morphs
 * and scripts injected by a morph never run (same rule as cart-fulfillment.js).
 */

let busy = false;

async function addToCart(button) {
  const host = button.closest('[data-cart-upsell]');
  const variantId = Number(host?.dataset.variantId || button.dataset.variantId || 0);
  const sectionId = host?.dataset.sectionId || '';
  if (!host || !variantId || busy) return;

  busy = true;
  host.setAttribute('aria-busy', 'true');
  button.disabled = true;
  const error = host.querySelector('[data-cart-upsell-error]');
  if (error) error.hidden = true;

  try {
    const body = { items: [{ id: variantId, quantity: 1 }] };
    if (sectionId) {
      body.sections = sectionId;
      body.sections_url = window.location.pathname;
    }
    const response = await fetch(Theme.routes.cart_add_url, fetchConfig('json', { body: JSON.stringify(body) }));
    if (!response.ok) throw new Error('cart_add_failed');
    const data = await response.json();

    let cart = null;
    try {
      cart = await (await fetch(`${Theme.routes.cart_url}.js`)).json();
    } catch (_) {
      /* bubble falls back to a relative +1 below */
    }

    // The drawer is open while this runs: morph it non-destructively ourselves
    // (a 'full' morph clobbers the open <dialog>), then notify the rest of the
    // theme (cart bubble, packaging boxes) FROM the cart-items-component so it
    // skips its own full re-render — exactly what the quantity selector does.
    const html = sectionId && data.sections ? data.sections[sectionId] : null;
    if (html) morphSection(sectionId, html, 'hydration');

    const target = host.closest('cart-items-component') || document;
    target.dispatchEvent(
      new CustomEvent('cart:update', {
        bubbles: true,
        detail: {
          resource: cart,
          sourceId: 'cart-upsell',
          data: cart
            ? { source: 'cart-upsell', itemCount: cart.item_count }
            : { source: 'product-form-component', itemCount: 1 },
        },
      })
    );
  } catch (_) {
    if (error) error.hidden = false;
    button.disabled = false;
  } finally {
    busy = false;
    host.removeAttribute('aria-busy');
  }
}

document.addEventListener('click', (event) => {
  const target = event.target;
  const button = target && typeof target.closest === 'function' ? target.closest('[data-cart-upsell-add]') : null;
  if (!button) return;
  event.preventDefault();
  addToCart(button);
});
