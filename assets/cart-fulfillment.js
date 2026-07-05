import { fetchConfig } from '@theme/utilities';
import { morphSection } from '@theme/section-renderer';

/**
 * Cart fulfillment: Доставка / Вземане от място (−10%),
 * Google Maps pin-drop address capture, checkout prefill.
 *
 * State of record = cart attributes (rendered server-side into <cart-fulfillment> data attrs).
 * localStorage keeps the structured address pieces for checkout prefill.
 */

const LS_KEY = 'mango_delivery_address';
const MODE_DELIVERY = 'Доставка';
const MODE_PICKUP = 'Вземане от място';

const VARNA = { lat: 43.2141, lng: 27.9147 };

let mapsLoading = null;
let map = null;
let marker = null;
let geocoder = null;
let resolved = null; // { formatted, address1, city, zip, lat, lng }

/* ── helpers ─────────────────────────────────────────── */

const root = () => document.querySelector('cart-fulfillment');
const dialog = () => document.getElementById('cf-map-dialog');

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
  };
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

function existingDiscountCodes() {
  return Array.from(document.querySelectorAll('.cart-discount__pill'))
    .map((pill) => pill.dataset.discountCode)
    .filter(Boolean);
}

/**
 * One round-trip: update cart attributes (+ discount codes) and morph the drawer section.
 */
async function updateCart({ attributes, discount }, sectionId) {
  const body = { sections: [sectionId] };
  if (attributes) body.attributes = attributes;
  if (discount !== undefined) body.discount = discount;

  const response = await fetch(Theme.routes.cart_update_url, fetchConfig('json', { body: JSON.stringify(body) }));
  if (!response.ok) throw new Error('cart_update_failed');
  const data = await response.json();

  const html = data.sections && data.sections[sectionId];
  if (html) morphSection(sectionId, html);
  return data;
}

/* ── mode switching ──────────────────────────────────── */

async function setMode(mode) {
  const state = getState();
  if (!state || state.mode === mode) return;

  const codes = existingDiscountCodes().filter((code) => code !== state.discountCode);

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
        showError('Отстъпката PICKUP10 не е активна — създайте я в Shopify Admin → Discounts.');
      }
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
      if (!saved) openMap();
    }
  } catch (_) {
    showError('Нещо се обърка — опитайте отново.');
  }
}

/* ── Google Maps ─────────────────────────────────────── */

function loadMaps(key) {
  if (window.google?.maps) return Promise.resolve();
  if (mapsLoading) return mapsLoading;
  mapsLoading = new Promise((resolve, reject) => {
    window.__cfMapsReady = () => resolve();
    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?key=${key}&libraries=places&language=bg&region=BG&callback=__cfMapsReady`;
    s.async = true;
    s.onerror = () => reject(new Error('maps_load_failed'));
    document.head.appendChild(s);
  });
  return mapsLoading;
}

async function openMap() {
  const state = getState();
  const dlg = dialog();
  if (!state || !dlg) return;

  dlg.showModal();

  try {
    await loadMaps(state.mapsKey);
  } catch (_) {
    dlg.querySelector('.cf-map__loading').textContent = 'Картата не можа да се зареди.';
    return;
  }

  const saved = savedAddress();
  const start = saved ? { lat: saved.lat, lng: saved.lng } : VARNA;

  if (!map) {
    const canvas = document.getElementById('cf-map-canvas');
    canvas.querySelector('.cf-map__loading')?.remove();

    map = new google.maps.Map(canvas, {
      center: start,
      zoom: saved ? 17 : 13,
      disableDefaultUI: true,
      zoomControl: true,
      clickableIcons: false,
    });
    geocoder = new google.maps.Geocoder();
    marker = new google.maps.Marker({
      map,
      position: start,
      draggable: true,
      title: 'Вашият адрес',
    });

    marker.addListener('dragend', () => resolvePosition(marker.getPosition()));
    map.addListener('click', (e) => {
      marker.setPosition(e.latLng);
      resolvePosition(e.latLng);
    });

    const input = document.getElementById('cf-map-search');
    const autocomplete = new google.maps.places.Autocomplete(input, {
      componentRestrictions: { country: 'bg' },
      fields: ['geometry', 'formatted_address', 'address_components'],
    });
    autocomplete.addListener('place_changed', () => {
      const place = autocomplete.getPlace();
      if (!place.geometry) return;
      map.panTo(place.geometry.location);
      map.setZoom(17);
      marker.setPosition(place.geometry.location);
      applyGeocode(place, place.geometry.location);
    });
  } else {
    map.setCenter(start);
    map.setZoom(saved ? 17 : 13);
    marker.setPosition(start);
  }

  if (saved) {
    resolved = saved;
    renderResolved();
  } else if (state.address) {
    // Cart attribute exists but localStorage is gone — re-resolve current pin.
    resolvePosition(marker.getPosition());
  }
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
  resolved = {
    formatted: result.formatted_address || street,
    address1: street || result.formatted_address || '',
    city: parts.locality || parts.postal_town || parts.administrative_area_level_1 || '',
    zip: parts.postal_code || '',
    lat: +(typeof latLng.lat === 'function' ? latLng.lat() : latLng.lat).toFixed(6),
    lng: +(typeof latLng.lng === 'function' ? latLng.lng() : latLng.lng).toFixed(6),
  };
  renderResolved();
}

function renderResolved() {
  const box = dialog()?.querySelector('[data-cf-resolved]');
  const text = dialog()?.querySelector('[data-cf-resolved-text]');
  const confirm = dialog()?.querySelector('[data-cf-confirm]');
  if (!box || !text || !confirm) return;

  box.hidden = false;
  text.textContent = resolved.zip
    ? `${resolved.formatted} · п.к. ${resolved.zip}`
    : `${resolved.formatted} (без пощенски код — преместете пина по-точно)`;
  confirm.disabled = false;
}

async function confirmAddress() {
  const state = getState();
  if (!state || !resolved) return;

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
    dialog()?.close();
  } catch (_) {
    showError('Адресът не се записа — опитайте отново.');
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

/* ── checkout interception + prefill ─────────────────── */

function onCheckoutClick(event) {
  const button = event.target.closest('button#checkout, button[name="checkout"]');
  if (!button) return;

  const state = getState();
  if (!state) return; // fulfillment UI not on this page — leave checkout alone

  if (state.mode === MODE_PICKUP) return; // discount already on the cart

  const saved = savedAddress();
  if (!state.address && !saved) {
    // Delivery without an address: open the map instead of checking out.
    event.preventDefault();
    event.stopPropagation();
    openMap();
    return;
  }

  if (saved && saved.address1) {
    // Redirect with prefilled shipping address (attributes are already on the cart).
    event.preventDefault();
    event.stopPropagation();
    const params = new URLSearchParams({
      'checkout[shipping_address][address1]': saved.address1,
      'checkout[shipping_address][city]': saved.city || '',
      'checkout[shipping_address][zip]': saved.zip || '',
      'checkout[shipping_address][country]': 'Bulgaria',
    });
    window.location.assign(`/checkout?${params.toString()}`);
  }
  // else: no structured pieces — let the normal submit proceed (address is on the order via attributes).
}

/* ── wiring (event delegation survives section morphs) ── */

document.addEventListener(
  'click',
  (event) => {
    const modeButton = event.target.closest('[data-cf-mode]');
    if (modeButton) {
      setMode(modeButton.dataset.cfMode);
      return;
    }
    if (event.target.closest('[data-cf-open-map]')) return openMap();
    if (event.target.closest('[data-cf-map-close]')) return dialog()?.close();
    if (event.target.closest('[data-cf-confirm]')) return confirmAddress();
    if (event.target.closest('[data-cf-locate]')) return locateMe();
    onCheckoutClick(event);
  },
  { capture: true }
);

if (!customElements.get('cart-fulfillment')) {
  customElements.define('cart-fulfillment', class extends HTMLElement {});
}
