(function () {
  const OPEN_CART_FLAG = 'mango_open_cart_drawer';

  class RestaurantProductComponent extends HTMLElement {
    #ac = null;
    #productData = null;
    #selectedOptions = [];

    connectedCallback() {
      this.#ac = new AbortController();
      const sig = this.#ac.signal;

      const jsonEl = this.querySelector('script[data-product-json]');
      if (jsonEl) {
        try { this.#productData = JSON.parse(jsonEl.textContent); } catch (_) {}
      }

      const activeOptions = this.querySelectorAll('.rp__option-value--active');
      this.#selectedOptions = Array.from(activeOptions).map((el) => el.dataset.optionValue);

      this.addEventListener('click', this.#onClick, { signal: sig });
      this.addEventListener('input', this.#onInput, { signal: sig });

      this.#bindThumbs(sig);
    }

    disconnectedCallback() {
      this.#ac?.abort();
      this.#ac = null;
    }

    #bindThumbs(sig) {
      const mainImg = this.querySelector('#rp-main-image');
      this.querySelectorAll('.rp__thumb').forEach((btn) => {
        btn.addEventListener('click', () => {
          const src = btn.dataset.imageSrc;
          if (!src || !mainImg) return;
          this.querySelectorAll('.rp__thumb').forEach((t) => t.classList.remove('rp__thumb--active'));
          btn.classList.add('rp__thumb--active');
          mainImg.style.opacity = '0';
          setTimeout(() => {
            mainImg.src = src;
            mainImg.style.opacity = '1';
          }, 180);
        }, { signal: sig });
      });
    }

    #onClick = (e) => {
      const opt = e.target.closest('.rp__option-value');
      if (opt) {
        this.#selectOption(opt);
        return;
      }

      const dec = e.target.closest('[data-qty-decrement]');
      if (dec) { this.#adjustQty(-1); return; }

      const inc = e.target.closest('[data-qty-increment]');
      if (inc) { this.#adjustQty(1); return; }

      const add = e.target.closest('[data-rp-add-to-cart]');
      if (add && !add.disabled) {
        e.preventDefault();
        this.#addToCart(add);
      }
    };

    #onInput = (e) => {
      const input = e.target.closest('.rp__qty-input');
      if (!input) return;
      const v = Math.max(1, parseInt(input.value, 10) || 1);
      input.value = v;
    };

    #selectOption(btn) {
      const position = parseInt(btn.dataset.optionPosition, 10) || 1;
      const value = btn.dataset.optionValue;
      btn.parentElement.querySelectorAll('.rp__option-value').forEach((el) => {
        el.classList.remove('rp__option-value--active');
      });
      btn.classList.add('rp__option-value--active');
      this.#selectedOptions[position - 1] = value;
      this.#syncVariant();
    }

    #syncVariant() {
      if (!this.#productData) return;
      const match = this.#productData.variants.find((v) =>
        v.options.every((opt, i) => opt === this.#selectedOptions[i])
      );
      if (!match) return;

      const addBtn = this.querySelector('[data-rp-add-to-cart]');
      if (addBtn) {
        addBtn.dataset.variantId = match.id;
        addBtn.disabled = !match.available;
        const label = addBtn.querySelector('[data-cta-label-default]');
        if (label && !match.available) label.textContent = 'ИЗЧЕРПАН';
      }

      const priceEl = this.querySelector('.rp__price-row .rp__price:not(.rp__price--compare)');
      if (priceEl) priceEl.textContent = this.#formatMoney(match.price);

      if (match.featured_image) {
        const mainImg = this.querySelector('#rp-main-image');
        if (mainImg && mainImg.src !== match.featured_image) {
          mainImg.style.opacity = '0';
          setTimeout(() => {
            mainImg.src = match.featured_image;
            mainImg.style.opacity = '1';
          }, 180);
        }
      }
    }

    #formatMoney(cents) {
      const value = (cents / 100).toFixed(2);
      const currency = (window.Shopify && window.Shopify.currency && window.Shopify.currency.active) || '';
      return currency ? `${value} ${currency}` : value;
    }

    #adjustQty(delta) {
      const input = this.querySelector('.rp__qty-input');
      if (!input) return;
      const next = Math.max(1, (parseInt(input.value, 10) || 1) + delta);
      input.value = next;
    }

    async #addToCart(btn) {
      const id = btn.dataset.variantId;
      if (!id) return;

      const qtyInput = this.querySelector('.rp__qty-input');
      const quantity = Math.max(1, parseInt(qtyInput?.value, 10) || 1);
      const redirectUrl = btn.dataset.redirectUrl || '/pages/menu';

      this.#setLoading(btn, true);

      try {
        const res = await fetch('/cart/add.js', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/javascript' },
          body: JSON.stringify({ items: [{ id: +id, quantity }] }),
        });
        if (!res.ok) {
          throw new Error('cart_add_failed');
        }

        try { sessionStorage.setItem(OPEN_CART_FLAG, '1'); } catch (_) {}

        const sameMenuPage = this.#isSamePath(redirectUrl);
        if (sameMenuPage) {
          await this.#openDrawer();
          this.#setLoading(btn, false);
        } else {
          window.location.assign(redirectUrl);
        }
      } catch (_) {
        this.#setLoading(btn, false);
        this.#flashError(btn);
      }
    }

    #isSamePath(url) {
      try {
        const u = new URL(url, window.location.origin);
        return u.pathname === window.location.pathname;
      } catch (_) {
        return false;
      }
    }

    async #openDrawer() {
      const cart = await (await fetch('/cart.js')).json();
      document.dispatchEvent(new CustomEvent('cart:update', {
        bubbles: true,
        detail: { resource: cart, sourceId: 'restaurant-product', data: { source: 'product-form-component', itemCount: 1 } },
      }));
      const drawer = document.querySelector('cart-drawer-component');
      if (drawer && typeof drawer.open === 'function') drawer.open();
    }

    #setLoading(btn, isLoading) {
      btn.classList.toggle('rp__cta--loading', isLoading);
      btn.disabled = isLoading;
      const def = btn.querySelector('[data-cta-label-default]');
      const load = btn.querySelector('.rp__cta-label--loading');
      if (def) def.hidden = isLoading;
      if (load) load.hidden = !isLoading;
    }

    #flashError(btn) {
      btn.animate(
        [{ transform: 'translateX(0)' }, { transform: 'translateX(-6px)' }, { transform: 'translateX(6px)' }, { transform: 'translateX(0)' }],
        { duration: 320, easing: 'ease-in-out' }
      );
    }
  }

  if (!customElements.get('restaurant-product')) {
    customElements.define('restaurant-product', RestaurantProductComponent);
  }
})();
