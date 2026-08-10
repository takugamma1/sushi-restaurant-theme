import { fetchConfig } from '@theme/utilities';
import { morphSection } from '@theme/section-renderer';

/**
 * Cart fulfillment: Доставка / Вземане от място (−10%),
 * Google Maps pin-drop address capture, checkout gating + prefill.
 *
 * State of record = cart attributes (rendered server-side into <cart-fulfillment> data attrs,
 * re-rendered on every section morph). localStorage keeps structured pieces for prefill.
 *
 * The map <dialog> is moved to <body> on first use so section morphs never destroy the map.
 */

const LS_KEY = 'mango_delivery_address';
const MODE_DELIVERY = 'Доставка';
const MODE_PICKUP = 'Вземане от място';

const VARNA = { lat: 43.2141, lng: 27.9147 };
// Bias search results to the Varna area
const VARNA_BOUNDS = { south: 43.1, west: 27.75, north: 43.35, east: 28.1 };

let mapsLoading = null;
let map = null;
let marker = null;
let geocoder = null;
let resolved = null; // { formatted, address1, city, zip, lat, lng }
let searchTimer = null;
let busy = false;

/* ── helpers ─────────────────────────────────────────── */

const root = () => document.querySelector('cart-fulfillment');

function getState() {
  const el = root();
  if (!el) return null;
  return {
    sectionId: el.dataset.sectionId,
    mode: el.dataset.mode || MODE_DELIVERY,
    address: el.dataset.address || '',
    zip: el.dataset.zip || '',
    mapsKey: el.dataset.mapsKey,
    discountCode: el.dataset.discountCode || 'PICKUP10',
    storefrontToken: el.dataset.storefrontToken || '',
  };
}

/**
 * The dialog is rendered inside the (morphing) drawer section. Keep exactly one
 * instance, attached to <body>, so morphs never kill the live map.
 */
function getDialog() {
  const all = Array.from(document.querySelectorAll('dialog.cf-map'));
  if (all.length === 0) return null;
  let bodyDialog = all.find((d) => d.parentElement === document.body);
  if (!bodyDialog) {
    bodyDialog = all[0];
    document.body.appendChild(bodyDialog);
  }
  all.forEach((d) => {
    if (d !== bodyDialog) d.remove();
  });
  return bodyDialog;
}

function savedAddress() {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) || 'null');
  } catch (_) {
    return null;
  }
}

function showError(message) {
  const el = root()?.querySelector('[data-cf-error]');
  if (!el) return;
  el.textContent = message;
  el.hidden = false;
}

async function updateCart({ attributes, discount }, sectionId) {
  const body = { sections: [sectionId] };
  if (attributes) body.attributes = attributes;
  if (discount !== undefined) body.discount = discount;

  const response = await fetch(Theme.routes.cart_update_url, fetchConfig('json', { body: JSON.stringify(body) }));
  if (!response.ok) throw new Error('cart_update_failed');
  const data = await response.json();

  const html = data.sections && data.sections[sectionId];
  // 'hydration' morphs only [data-hydration-key] targets (the drawer body), like the
  // theme's own cart code does — a 'full' morph of the header section clobbers the
  // open <dialog> (the server HTML has no `open` attribute) and freezes the drawer.
  if (html) morphSection(sectionId, html, 'hydration');
  return data;
}

/* ── Storefront API: put the address on the cart so checkout is prefilled ── */

function cartToken() {
  const match = document.cookie.match(/(?:^|;\s*)cart=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

/**
 * Sync the checkout with the drawer choice via the Storefront API:
 * - preselects the delivery method (PICK_UP / DELIVERY)
 * - prefills the shipping address for delivery orders
 */
async function syncBuyerIdentity({ method, address }) {
  const state = getState();
  if (!state?.storefrontToken) return;
  const token = cartToken();
  if (!token) return;

  const buyerIdentity = { countryCode: 'BG' };
  if (method) {
    buyerIdentity.preferences = { delivery: { deliveryMethod: [method] } };
  }
  if (address?.address1) {
    buyerIdentity.deliveryAddressPreferences = [
      {
        deliveryAddress: {
          address1: address.address1,
          city: address.city || '',
          zip: address.zip || '',
          country: 'Bulgaria',
        },
      },
    ];
  }

  try {
    await fetch(`${window.Shopify?.routes?.root || '/'}api/2025-07/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Storefront-Access-Token': state.storefrontToken,
      },
      body: JSON.stringify({
        query: `mutation cfBuyer($cartId: ID!, $buyerIdentity: CartBuyerIdentityInput!) {
          cartBuyerIdentityUpdate(cartId: $cartId, buyerIdentity: $buyerIdentity) {
            userErrors { field message }
          }
        }`,
        variables: {
          cartId: `gid://shopify/Cart/${token}`,
          buyerIdentity,
        },
      }),
    });
  } catch (_) {
    /* non-fatal: attributes still carry the address */
  }
}

/* ── mode switching ──────────────────────────────────── */

function existingDiscountCodes() {
  return Array.from(document.querySelectorAll('.cart-discount__pill'))
    .map((pill) => pill.dataset.discountCode)
    .filter(Boolean);
}

/** Paint the toggle immediately (optimistic) — the morph confirms it from server truth. */
function paintToggle(mode) {
  const el = root();
  if (!el) return;
  el.querySelectorAll('[data-cf-mode]').forEach((button) => {
    const active = button.dataset.cfMode === mode;
    button.classList.toggle('cart-fulfillment__option--active', active);
    button.setAttribute('aria-checked', String(active));
  });
}

async function setMode(mode) {
  const state = getState();
  if (!state || state.mode === mode || busy) return;
  busy = true;
  paintToggle(mode);
  root()?.setAttribute('aria-busy', 'true');

  const codes = existingDiscountCodes().filter((code) => code.toUpperCase() !== state.discountCode.toUpperCase());

  try {
    if (mode === MODE_PICKUP) {
      const data = await updateCart(
        {
          attributes: {
            'Получаване': MODE_PICKUP,
            'Адрес за доставка': '',
            'Пощенски код': '',
            'Координати': '',
          },
          discount: [...codes, state.discountCode].join(','),
        },
        state.sectionId
      );
      const applied = (data.discount_codes || []).some(
        (d) => d.code.toUpperCase() === state.discountCode.toUpperCase() && d.applicable
      );
      if (!applied) {
        showError('Отстъпката не се приложи — опитайте отново.');
      }
      syncBuyerIdentity({ method: 'PICK_UP' });
    } else {
      const saved = savedAddress();
      await updateCart(
        {
          attributes: {
            'Получаване': MODE_DELIVERY,
            'Адрес за доставка': saved ? saved.formatted : '',
            'Пощенски код': saved ? saved.zip : '',
            'Координати': saved ? `${saved.lat}, ${saved.lng}` : '',
          },
          discount: codes.join(','),
        },
        state.sectionId
      );
      if (saved) {
        syncBuyerIdentity({ method: 'SHIPPING', address: saved });
      } else {
        syncBuyerIdentity({ method: 'SHIPPING' });
        openMap();
      }
    }
  } catch (_) {
    paintToggle(state.mode); // revert the optimistic paint
    showError('Нещо се обърка — опитайте отново.');
  } finally {
    busy = false;
    root()?.removeAttribute('aria-busy');
  }
}

/* ── Google Maps ─────────────────────────────────────── */

function loadMaps(key) {
  if (window.google?.maps) return Promise.resolve();
  if (mapsLoading) return mapsLoading;
  mapsLoading = new Promise((resolve, reject) => {
    window.__cfMapsReady = () => resolve();
    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?key=${key}&language=bg&region=BG&callback=__cfMapsReady`;
    s.async = true;
    s.onerror = () => reject(new Error('maps_load_failed'));
    document.head.appendChild(s);
  });
  return mapsLoading;
}

async function openMap() {
  const state = getState();
  const dlg = getDialog();
  if (!state || !dlg) return;

  dlg.showModal();

  try {
    await loadMaps(state.mapsKey);
  } catch (_) {
    const loading = dlg.querySelector('.cf-map__loading');
    if (loading) loading.textContent = 'Картата не можа да се зареди. Проверете API ключа.';
    return;
  }

  const saved = savedAddress();
  const start = saved ? { lat: saved.lat, lng: saved.lng } : VARNA;
  const canvas = dlg.querySelector('#cf-map-canvas');

  if (!map || !canvas.contains(map.getDiv())) {
    canvas.querySelector('.cf-map__loading')?.remove();
    map = new google.maps.Map(canvas, {
      center: start,
      zoom: saved ? 17 : 13,
      disableDefaultUI: true,
      zoomControl: true,
      clickableIcons: false,
    });
    geocoder = new google.maps.Geocoder();
    marker = new google.maps.Marker({ map, position: start, draggable: true, title: 'Вашият адрес' });

    marker.addListener('dragend', () => resolvePosition(marker.getPosition()));
    map.addListener('click', (e) => {
      marker.setPosition(e.latLng);
      resolvePosition(e.latLng);
    });
  } else {
    map.setCenter(start);
    map.setZoom(saved ? 17 : 13);
    marker.setPosition(start);
  }

  if (saved) {
    resolved = saved;
    renderResolved();
  }
}

/* ── address search (Geocoding API — exact street results) ── */

function onSearchInput(input) {
  clearTimeout(searchTimer);
  const query = input.value.trim();
  if (query.length < 3) {
    renderSuggestions([]);
    return;
  }
  searchTimer = setTimeout(() => {
    if (!geocoder) return;
    geocoder.geocode(
      {
        address: query,
        region: 'bg',
        componentRestrictions: { country: 'BG' },
        bounds: VARNA_BOUNDS,
      },
      (results, status) => {
        if (status !== 'OK' || !results) {
          renderSuggestions([]);
          return;
        }
        renderSuggestions(results.slice(0, 5));
      }
    );
  }, 350);
}

function renderSuggestions(results) {
  const list = getDialog()?.querySelector('[data-cf-suggestions]');
  if (!list) return;
  list.innerHTML = '';
  list.hidden = results.length === 0;
  results.forEach((result) => {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cf-map__suggestion';
    btn.textContent = result.formatted_address;
    btn.addEventListener('click', () => {
      list.hidden = true;
      const location = result.geometry.location;
      map.panTo(location);
      map.setZoom(17);
      marker.setPosition(location);
      applyGeocode(result, location);
    });
    li.appendChild(btn);
    list.appendChild(li);
  });
}

function resolvePosition(latLng) {
  if (!geocoder) return;
  geocoder.geocode({ location: latLng }, (results, status) => {
    if (status !== 'OK' || !results?.[0]) return;
    applyGeocode(results[0], latLng);
  });
}

function applyGeocode(result, latLng) {
  const parts = {};
  (result.address_components || []).forEach((component) => {
    component.types.forEach((type) => (parts[type] = component.long_name));
  });

  const street = [parts.route, parts.street_number].filter(Boolean).join(' ');
  const lat = typeof latLng.lat === 'function' ? latLng.lat() : latLng.lat;
  const lng = typeof latLng.lng === 'function' ? latLng.lng() : latLng.lng;

  resolved = {
    formatted: result.formatted_address || street,
    address1: street || result.formatted_address || '',
    city: parts.locality || parts.postal_town || parts.administrative_area_level_1 || '',
    zip: parts.postal_code || '',
    lat: +lat.toFixed(6),
    lng: +lng.toFixed(6),
  };
  renderResolved();
}

function renderResolved() {
  const dlg = getDialog();
  const box = dlg?.querySelector('[data-cf-resolved]');
  const text = dlg?.querySelector('[data-cf-resolved-text]');
  const confirm = dlg?.querySelector('[data-cf-confirm]');
  if (!box || !text || !confirm || !resolved) return;

  box.hidden = false;
  text.textContent = resolved.zip
    ? `${resolved.formatted} · п.к. ${resolved.zip}`
    : `${resolved.formatted} (без пощенски код — преместете пина по-точно)`;
  confirm.disabled = false;
}

async function confirmAddress() {
  const state = getState();
  if (!state || !resolved || busy) return;
  busy = true;

  try {
    localStorage.setItem(LS_KEY, JSON.stringify(resolved));
  } catch (_) {}

  try {
    await updateCart(
      {
        attributes: {
          'Получаване': MODE_DELIVERY,
          'Адрес за доставка': resolved.formatted,
          'Пощенски код': resolved.zip,
          'Координати': `${resolved.lat}, ${resolved.lng}`,
        },
      },
      state.sectionId
    );
    syncBuyerIdentity({ method: 'SHIPPING', address: resolved });
    getDialog()?.close();
  } catch (_) {
    showError('Адресът не се записа — опитайте отново.');
  } finally {
    busy = false;
  }
}

function locateMe() {
  if (!navigator.geolocation || !map || !marker) return;
  navigator.geolocation.getCurrentPosition((position) => {
    const location = { lat: position.coords.latitude, lng: position.coords.longitude };
    map.panTo(location);
    map.setZoom(17);
    marker.setPosition(location);
    resolvePosition(new google.maps.LatLng(location));
  });
}

/* ── wiring (delegation survives morphs) ─────────────── */

document.addEventListener(
  'click',
  (event) => {
    const modeButton = event.target.closest('[data-cf-mode]');
    if (modeButton) {
      event.preventDefault();
      setMode(modeButton.dataset.cfMode);
      return;
    }
    if (event.target.closest('[data-cf-open-map]')) {
      event.preventDefault();
      openMap();
      return;
    }
    if (event.target.closest('[data-cf-map-close]')) {
      getDialog()?.close();
      return;
    }
    if (event.target.closest('[data-cf-confirm]')) {
      confirmAddress();
      return;
    }
    if (event.target.closest('[data-cf-locate]')) {
      locateMe();
      return;
    }

    // Blocked checkout (delivery without address): open the map instead.
    const blocked = event.target.closest('[data-cf-blocked]');
    if (blocked) {
      if (!getDialog()) return; // no fulfillment UI on this page — leave checkout alone
      event.preventDefault();
      event.stopPropagation();
      openMap();
      return;
    }

    // Unblocked checkout: ALWAYS sync method + address onto the cart first,
    // then continue to checkout. Guarantees prefill even for stale carts.
    const checkoutButton = event.target.closest('button#checkout, button[name="checkout"]');
    if (checkoutButton && root()) {
      event.preventDefault();
      event.stopPropagation();
      const state = getState();
      const pickup = state?.mode === MODE_PICKUP;
      const sync = syncBuyerIdentity({
        method: pickup ? 'PICK_UP' : 'SHIPPING',
        address: pickup ? null : savedAddress(),
      });
      // Never hang checkout on a slow network: 2.5s cap.
      Promise.race([sync, new Promise((resolve) => setTimeout(resolve, 2500))]).finally(() => {
        window.location.assign('/checkout');
      });
    }
  },
  { capture: true }
);

document.addEventListener('input', (event) => {
  if (event.target?.id === 'cf-map-search') onSearchInput(event.target);
});

// Prevent the search field from submitting anything on Enter.
document.addEventListener('keydown', (event) => {
  if (event.target?.id === 'cf-map-search' && event.key === 'Enter') event.preventDefault();
});

if (!customElements.get('cart-fulfillment')) {
  customElements.define('cart-fulfillment', class extends HTMLElement {});
}

// Move the dialog out of the morphing drawer as soon as the module loads.
getDialog();

// Background sync on load, so even express-pay paths see the drawer state.
{
  const state = getState();
  if (state) {
    const pickup = state.mode === MODE_PICKUP;
    syncBuyerIdentity({
      method: pickup ? 'PICK_UP' : 'SHIPPING',
      address: pickup ? null : savedAddress(),
    });
  }
}
