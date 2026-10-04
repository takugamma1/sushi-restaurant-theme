import { fetchConfig } from '@theme/utilities';
import { morphSection } from '@theme/section-renderer';

/**
 * Cart fulfillment: Доставка / Вземане от място (−10%),
 * delivery address capture (OpenStreetMap lookup, no API key), checkout
 * gating + prefill.
 *
 * State of record = cart attributes (rendered server-side into <cart-fulfillment> data attrs,
 * re-rendered on every section morph). localStorage keeps structured pieces for prefill.
 *
 * The address <dialog> is moved to <body> on first use so section morphs never
 * wipe what the customer is typing.
 */

const LS_KEY = 'mango_delivery_address';
const MODE_DELIVERY = 'Доставка';
const MODE_PICKUP = 'Вземане от място';

// Address lookup: Photon (OpenStreetMap search-as-you-type, no key) with a
// Nominatim fallback for reverse lookups.
const PHOTON_URL = 'https://photon.komoot.io';
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org';
const VARNA = { lat: 43.2141, lng: 27.9147 };
// Delivery region (Varna and surroundings): search results are limited to it
// and a "current location" outside it is refused.
const AREA = { west: 27.6, south: 43.05, east: 28.2, north: 43.45 };
const DEFAULT_CITY = 'Варна';

let picked = null; // lookup result the customer chose: { street, housenumber, district, city, zip, lat, lng }
let lookupState = 'idle'; // 'idle' | 'ok' | 'empty' | 'failed' — outcome of the last search
let searchSeq = 0;
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
    phone: el.dataset.phone || '',
    discountCode: el.dataset.discountCode || 'PICKUP10',
    storefrontToken: el.dataset.storefrontToken || '',
  };
}

/**
 * The dialog is rendered inside the (morphing) drawer section. Keep exactly one
 * instance, attached to <body>, so morphs never reset the open address form.
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
 * - prefills the contact phone (dropped and retried if Shopify rejects it, so
 *   a bad number can never cost the customer their address prefill)
 */
async function syncBuyerIdentity({ method, address, phone }) {
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

  const e164 = phoneE164(phone ?? state.phone);
  if (e164) buyerIdentity.phone = e164;

  const send = (identity) =>
    fetch(`${window.Shopify?.routes?.root || '/'}api/2025-07/graphql.json`, {
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
          buyerIdentity: identity,
        },
      }),
    });

  try {
    const response = await send(buyerIdentity);
    if (buyerIdentity.phone) {
      const json = await response.json().catch(() => null);
      const errors = json?.data?.cartBuyerIdentityUpdate?.userErrors || [];
      if (errors.length > 0) {
        const { phone: _dropped, ...withoutPhone } = buyerIdentity;
        await send(withoutPhone);
      }
    }
  } catch (_) {
    /* non-fatal: attributes still carry the address and phone */
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
      const entry = (data.discount_codes || []).find(
        (d) => d.code.toUpperCase() === state.discountCode.toUpperCase()
      );
      if (!entry) {
        showError('Отстъпката не се приложи — опитайте отново.');
      } else if (!entry.applicable) {
        // Code accepted but nothing in the cart qualifies (e.g. combo-only cart:
        // PICKUP10 excludes „Вечеря за двама“). Inform, don't alarm.
        showError('Отстъпката −10% не важи за комбо предложенията „Вечеря за двама“ — прилага се само за останалите продукти.');
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
            'Координати': saved && saved.lat != null && saved.lng != null ? `${saved.lat}, ${saved.lng}` : '',
          },
          discount: codes.join(','),
        },
        state.sectionId
      );
      if (saved) {
        syncBuyerIdentity({ method: 'SHIPPING', address: saved });
      } else {
        syncBuyerIdentity({ method: 'SHIPPING' });
        openAddressDialog();
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

/* ── chopsticks / cutlery count ──────────────────────── */

const STICKS_ATTR = 'Клечки';

function paintSticks(value) {
  const el = root();
  if (!el) return;
  const str = String(value);
  el.querySelectorAll('[data-sticks-value]').forEach((button) => {
    const active = button.dataset.sticksValue === str;
    button.classList.toggle('cart-sticks__option--active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  const custom = el.querySelector('[data-sticks-custom]');
  if (custom) {
    const isCustom = Number(value) > 4;
    custom.classList.toggle('cart-sticks__custom--active', isCustom);
    if (!isCustom) custom.value = '';
  }
}

function showSticksError(message) {
  const el = root()?.querySelector('[data-sticks-error]');
  if (!el) return;
  el.textContent = message;
  el.hidden = false;
  const box = root()?.querySelector('[data-cf-sticks]');
  if (box && typeof box.scrollIntoView === 'function') box.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function setSticks(value) {
  const state = getState();
  if (!state || busy) return;
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n < 1 || n > 99) {
    showSticksError('Въведете брой между 1 и 99.');
    return;
  }
  busy = true;
  paintSticks(n);
  const err = root()?.querySelector('[data-sticks-error]');
  if (err) err.hidden = true;
  try {
    await updateCart({ attributes: { [STICKS_ATTR]: String(n) } }, state.sectionId);
  } catch (_) {
    showSticksError('Броят не се записа — опитайте отново.');
  } finally {
    busy = false;
  }
}

/* ── contact phone ───────────────────────────────────── */

const PHONE_ATTR = 'Телефон';
const LS_PHONE = 'mango_contact_phone';
let pendingPhone = null;

/** Compact form of a plausible phone number, or '' when it is not one. */
function normalizePhone(raw) {
  const trimmed = String(raw || '').trim();
  const international = trimmed.startsWith('+') || trimmed.startsWith('00');
  let digits = trimmed.replace(/\D/g, '');
  if (trimmed.startsWith('00')) digits = digits.slice(2);
  if (digits.length < 8 || digits.length > 15) return '';
  return international ? `+${digits}` : digits;
}

/** E.164 for checkout prefill; Bulgarian national numbers (0XXXXXXXXX) get +359. */
function phoneE164(phone) {
  if (!phone) return null;
  if (phone.startsWith('+')) return phone;
  if (/^0\d{9}$/.test(phone)) return `+359${phone.slice(1)}`;
  return null;
}

const phoneInput = () => root()?.querySelector('[data-cf-phone]');

function showPhoneError(message) {
  const el = root()?.querySelector('[data-phone-error]');
  if (el) {
    el.textContent = message;
    el.hidden = false;
  }
  const input = phoneInput();
  if (input) {
    input.classList.add('cart-phone__input--error');
    input.classList.remove('cart-phone__input--ok');
    if (typeof input.scrollIntoView === 'function') input.scrollIntoView({ behavior: 'smooth', block: 'center' });
    input.focus({ preventScroll: true });
  }
}

function clearPhoneError() {
  const el = root()?.querySelector('[data-phone-error]');
  if (el) el.hidden = true;
  phoneInput()?.classList.remove('cart-phone__input--error');
}

/**
 * Validate + save the phone as a cart attribute. Resolves true once the phone
 * is on the cart. Not gated by `busy`: dropping a phone save would strand the
 * customer on a blocked checkout button.
 */
function setPhone(raw) {
  const state = getState();
  if (!state) return Promise.resolve(false);
  const phone = normalizePhone(raw);
  if (!phone) {
    showPhoneError('Моля, въведете валиден телефонен номер.');
    return Promise.resolve(false);
  }
  clearPhoneError();
  phoneInput()?.classList.add('cart-phone__input--ok');
  if (state.phone === phone) return Promise.resolve(true);
  if (pendingPhone) return pendingPhone;

  pendingPhone = (async () => {
    try {
      await updateCart({ attributes: { [PHONE_ATTR]: phone } }, state.sectionId);
      try {
        localStorage.setItem(LS_PHONE, phone);
      } catch (_) {}
      return true;
    } catch (_) {
      showPhoneError('Телефонът не се записа — опитайте отново.');
      return false;
    } finally {
      pendingPhone = null;
    }
  })();
  return pendingPhone;
}

/** Make sure whatever is typed in the phone field is saved (or report why not). */
function commitPhone() {
  if (pendingPhone) return pendingPhone;
  return setPhone(phoneInput()?.value || '');
}

/* ── delivery address (OpenStreetMap lookup) ─────────── */

const addressField = (selector) => getDialog()?.querySelector(selector) || null;
const streetInput = () => addressField('#cf-map-search');
const detailsInput = () => addressField('[data-cf-details]');

function setAddressStatus(message, isError = false) {
  const el = addressField('[data-cf-addr-status]');
  if (!el) return;
  el.textContent = message || '';
  el.hidden = !message;
  el.classList.toggle('cf-addr__status--error', Boolean(message) && isError);
}

async function fetchJson(url, timeoutMs = 6000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error('lookup_failed');
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

const inArea = (lat, lng) => lat >= AREA.south && lat <= AREA.north && lng >= AREA.west && lng <= AREA.east;

// OpenStreetMap postcodes are patchy; only trust ones in the Varna region (9xxx).
const cleanZip = (zip) => (/^9\d{3}$/.test(String(zip || '')) ? String(zip) : '');

/** Photon feature -> address parts, or null when it is not usable as a street address. */
function fromPhoton(feature) {
  const p = feature?.properties || {};
  const [lng, lat] = feature?.geometry?.coordinates || [];
  const namedPlace = p.type === 'street' || p.type === 'district' || p.type === 'locality';
  const street = p.street || (namedPlace ? p.name : '') || '';
  if (!street || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return {
    street,
    housenumber: p.housenumber || '',
    district: p.district && p.district !== street ? p.district : '',
    city: p.city || p.town || p.village || DEFAULT_CITY,
    zip: cleanZip(p.postcode),
    lat: +lat.toFixed(6),
    lng: +lng.toFixed(6),
  };
}

function addressLabel(a) {
  const line = [a.street, a.housenumber].filter(Boolean).join(' ');
  return [line, a.district, a.city].filter(Boolean).join(', ');
}

function openAddressDialog() {
  const dlg = getDialog();
  if (!getState() || !dlg) return;

  const street = streetInput();
  const details = detailsInput();
  const saved = savedAddress();
  // Returning customer: start from the address they used last time.
  if (saved && street && !street.value) {
    street.value = saved.street || saved.address1 || '';
    if (details) details.value = saved.details || '';
    picked = street.value
      ? {
          street: street.value,
          housenumber: '',
          district: saved.district || '',
          city: saved.city || DEFAULT_CITY,
          zip: cleanZip(saved.zip),
          lat: saved.lat ?? null,
          lng: saved.lng ?? null,
        }
      : null;
  }
  renderSuggestions([]);
  setAddressStatus('');

  if (!dlg.open) dlg.showModal();
  const first = street?.value ? details : street;
  if (first && typeof first.focus === 'function') first.focus();
}

/* ── address search (suggestions as the customer types) ── */

function onSearchInput(input) {
  clearTimeout(searchTimer);
  picked = null; // editing the street invalidates the previous choice (and its coordinates)
  setAddressStatus('');
  const query = input.value.trim();
  if (query.length < 3) {
    searchSeq++;
    lookupState = 'idle';
    renderSuggestions([]);
    return;
  }
  searchTimer = setTimeout(() => searchAddress(query), 300);
}

async function searchAddress(query) {
  const seq = ++searchSeq;
  const params = new URLSearchParams({
    q: query,
    limit: '10',
    lang: 'default', // local (Bulgarian) names regardless of the browser language
    lat: String(VARNA.lat),
    lon: String(VARNA.lng),
    bbox: `${AREA.west},${AREA.south},${AREA.east},${AREA.north}`,
  });
  ['house', 'street', 'district', 'locality'].forEach((layer) => params.append('layer', layer));

  let results = [];
  let state = 'failed';
  try {
    const data = await fetchJson(`${PHOTON_URL}/api/?${params}`);
    const seen = new Set();
    for (const feature of data?.features || []) {
      const address = fromPhoton(feature);
      if (!address) continue;
      const label = addressLabel(address);
      if (seen.has(label)) continue; // several shops at one address -> one row
      seen.add(label);
      results.push(address);
      if (results.length === 6) break;
    }
    state = results.length > 0 ? 'ok' : 'empty';
  } catch (_) {
    results = [];
  }
  if (seq !== searchSeq) return; // a newer keystroke superseded this lookup

  lookupState = state;
  renderSuggestions(results, query);
  if (state === 'empty') {
    setAddressStatus('Не намерихме тази улица — ще запишем адреса така, както сте го въвели.');
  } else if (state === 'failed') {
    setAddressStatus('Търсенето на адреси не работи в момента — въведете адреса ръчно и ще го запишем.');
  }
}

function renderSuggestions(results, typed = '') {
  const list = addressField('[data-cf-suggestions]');
  if (!list) return;
  list.innerHTML = '';
  list.hidden = results.length === 0;
  const addRow = (text, onClick, extraClass = '') => {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `cf-map__suggestion${extraClass}`;
    btn.textContent = text;
    btn.addEventListener('click', onClick);
    li.appendChild(btn);
    list.appendChild(li);
  };
  results.forEach((address) => addRow(addressLabel(address), () => pickAddress(address)));
  // Never a dead end: the customer can keep exactly what they typed.
  if (results.length > 0 && typed) {
    addRow(
      `Адресът ми не е в списъка — използвай „${typed}“`,
      () =>
        pickAddress({ street: typed, housenumber: '', district: '', city: DEFAULT_CITY, zip: '', lat: null, lng: null }),
      ' cf-map__suggestion--manual'
    );
  }
}

/** Put a looked-up address into the form; the customer completes entrance/floor/apartment. */
function pickAddress(address, statusMessage = '') {
  picked = address;
  lookupState = 'ok';
  clearTimeout(searchTimer);
  searchSeq++;
  renderSuggestions([]);
  const street = streetInput();
  const details = detailsInput();
  if (street) street.value = address.street;
  if (details) {
    if (address.housenumber) details.value = address.housenumber;
    if (typeof details.focus === 'function') details.focus();
  }
  setAddressStatus(statusMessage);
}

/** Validate the form and build the address that goes on the order. */
function addressDraft() {
  const streetText = (streetInput()?.value || '').trim();
  const details = (detailsInput()?.value || '').trim();

  if (streetText.length < 3) return { error: 'Въведете улица или квартал.', focus: streetInput() };
  // A typed street must come from the suggestions — unless the lookup found
  // nothing or is down, in which case the order must still be possible.
  const manualAllowed = lookupState === 'empty' || lookupState === 'failed';
  if (!picked && !manualAllowed) {
    return { error: 'Изберете адреса от предложенията под полето.', focus: streetInput() };
  }
  if (!details && !/\d/.test(streetText)) {
    return { error: 'Добавете номер или блок, вход, етаж и апартамент.', focus: detailsInput() };
  }

  const source = picked || { district: '', city: DEFAULT_CITY, zip: '', lat: null, lng: null };
  const address1 = [streetText, details].filter(Boolean).join(' ');
  return {
    address: {
      formatted: [address1, source.district, source.city].filter(Boolean).join(', '),
      address1,
      street: streetText,
      details,
      district: source.district || '',
      city: source.city || DEFAULT_CITY,
      zip: source.zip || '',
      lat: source.lat ?? null,
      lng: source.lng ?? null,
    },
  };
}

async function confirmAddress() {
  const state = getState();
  if (!state || busy) return;
  const draft = addressDraft();
  if (draft.error) {
    setAddressStatus(draft.error, true);
    if (draft.focus && typeof draft.focus.focus === 'function') draft.focus.focus();
    return;
  }
  const address = draft.address;
  const hasCoords = address.lat !== null && address.lng !== null;
  busy = true;

  try {
    localStorage.setItem(LS_KEY, JSON.stringify(address));
  } catch (_) {}

  try {
    await updateCart(
      {
        attributes: {
          'Получаване': MODE_DELIVERY,
          'Адрес за доставка': address.formatted,
          'Пощенски код': address.zip,
          'Координати': hasCoords ? `${address.lat}, ${address.lng}` : '',
        },
      },
      state.sectionId
    );
    syncBuyerIdentity({ method: 'SHIPPING', address });
    const dlg = getDialog();
    if (dlg && typeof dlg.close === 'function') dlg.close();
  } catch (_) {
    setAddressStatus('Адресът не се записа — опитайте отново.', true);
  } finally {
    busy = false;
  }
}

/* ── current location ────────────────────────────────── */

/** Coordinates -> street address via Photon, then Nominatim. Null when neither knows the street. */
async function reverseLookup(lat, lng) {
  try {
    const data = await fetchJson(`${PHOTON_URL}/reverse?lat=${lat}&lon=${lng}&limit=1&lang=default`);
    const address = fromPhoton(data?.features?.[0]);
    if (address) return address;
  } catch (_) {}
  try {
    const data = await fetchJson(
      `${NOMINATIM_URL}/reverse?format=jsonv2&addressdetails=1&zoom=18&accept-language=bg&lat=${lat}&lon=${lng}`
    );
    const a = data?.address || {};
    const street = a.road || a.pedestrian || a.residential || a.neighbourhood || a.suburb || '';
    if (street) {
      return {
        street,
        housenumber: a.house_number || '',
        district: a.suburb && a.suburb !== street ? a.suburb : '',
        city: a.city || a.town || a.village || DEFAULT_CITY,
        zip: cleanZip(a.postcode),
        lat,
        lng,
      };
    }
  } catch (_) {}
  return null;
}

function locateMe() {
  if (typeof navigator === 'undefined' || !navigator.geolocation) {
    setAddressStatus('Браузърът не поддържа местоположение — въведете адреса ръчно.', true);
    return;
  }
  setAddressStatus('Определяме местоположението ви…');
  navigator.geolocation.getCurrentPosition(
    async (position) => {
      const lat = +position.coords.latitude.toFixed(6);
      const lng = +position.coords.longitude.toFixed(6);
      if (!inArea(lat, lng)) {
        setAddressStatus('Изглежда сте извън зоната ни за доставка (Варна и околността). Въведете адреса за доставка ръчно.', true);
        return;
      }
      const address = await reverseLookup(lat, lng);
      if (!address) {
        setAddressStatus('Не успяхме да разпознаем улицата — въведете я в полето по-долу.', true);
        const street = streetInput();
        if (street && typeof street.focus === 'function') street.focus();
        return;
      }
      // Keep the exact GPS position: it is more precise than the matched building.
      pickAddress({ ...address, lat, lng }, 'Проверете адреса и допълнете вход, етаж и апартамент.');
    },
    (error) => {
      setAddressStatus(
        error?.code === 1
          ? 'Разрешете достъп до местоположението или въведете адреса ръчно.'
          : 'Не успяхме да определим местоположението — въведете адреса ръчно.',
        true
      );
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
  );
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
      openAddressDialog();
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
    const sticksButton = event.target.closest('[data-sticks-value]');
    if (sticksButton) {
      event.preventDefault();
      setSticks(sticksButton.dataset.sticksValue);
      return;
    }

    // Blocked checkout (delivery without address / chopsticks count / phone):
    // prompt for whatever is missing instead of navigating.
    const blocked = event.target.closest('[data-cf-blocked]');
    if (blocked) {
      if (!root()) return; // no fulfillment UI on this page — leave checkout alone
      event.preventDefault();
      event.stopPropagation();
      if (blocked.dataset.cfBlockedReason === 'sticks') {
        showSticksError('Моля, изберете брой клечки/прибори преди поръчка.');
        return;
      }
      if (blocked.dataset.cfBlockedReason === 'phone') {
        // The phone is the last requirement: if a valid number is already
        // typed, save it and carry on to checkout in the same click.
        commitPhone().then((ok) => {
          if (ok) proceedToCheckout();
        });
        return;
      }
      if (getDialog()) openAddressDialog();
      return;
    }

    // Unblocked checkout: ALWAYS sync method + address onto the cart first,
    // then continue to checkout. Guarantees prefill even for stale carts.
    const checkoutButton = event.target.closest('button#checkout, button[name="checkout"]');
    if (checkoutButton && root()) {
      event.preventDefault();
      event.stopPropagation();
      proceedToCheckout();
    }
  },
  { capture: true }
);

/** Sync method + address + phone onto the cart, then go to checkout. */
function proceedToCheckout() {
  const state = getState();
  const pickup = state?.mode === MODE_PICKUP;
  const sync = syncBuyerIdentity({
    method: pickup ? 'PICK_UP' : 'SHIPPING',
    address: pickup ? null : savedAddress(),
    phone: normalizePhone(phoneInput()?.value || '') || state?.phone,
  });
  // Never hang checkout on a slow network: 2.5s cap.
  Promise.race([sync, new Promise((resolve) => setTimeout(resolve, 2500))]).finally(() => {
    window.location.assign('/checkout');
  });
}

document.addEventListener('input', (event) => {
  if (event.target?.id === 'cf-map-search') onSearchInput(event.target);
  if (event.target?.matches?.('[data-cf-phone]')) clearPhoneError();
  if (event.target?.matches?.('[data-cf-details]')) setAddressStatus('');
});

// Custom chopsticks count: save when the user commits a value.
document.addEventListener('change', (event) => {
  const target = event.target;
  if (target?.matches?.('[data-sticks-custom]') && target.value !== '') setSticks(target.value);
  // Contact phone: save when the user leaves the field.
  if (target?.matches?.('[data-cf-phone]') && target.value.trim() !== '') setPhone(target.value);
});

// Prevent the search field from submitting anything on Enter.
document.addEventListener('keydown', (event) => {
  if (event.target?.id === 'cf-map-search' && event.key === 'Enter') event.preventDefault();
  // Enter in the entrance/floor field confirms the address.
  if (event.target?.matches?.('[data-cf-details]') && event.key === 'Enter') {
    event.preventDefault();
    confirmAddress();
  }
  // Enter in the phone field saves it instead of submitting the cart form.
  if (event.target?.matches?.('[data-cf-phone]') && event.key === 'Enter') {
    event.preventDefault();
    commitPhone();
  }
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
    // Returning customer: put the remembered phone back on a fresh cart.
    if (!state.phone) {
      try {
        const remembered = localStorage.getItem(LS_PHONE);
        if (remembered) setPhone(remembered);
      } catch (_) {}
    }
  }
}
