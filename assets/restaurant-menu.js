class RestaurantMenuComponent extends HTMLElement {
  #ac = null;

  connectedCallback() {
    this.#ac = new AbortController();
    const sig = this.#ac.signal;

    this.addEventListener('click', this.#onClick, { signal: sig });

    document.addEventListener('shopify:section:load', (e) => {
      if (this.closest('.shopify-section') === e.target) {
        this.#ac?.abort();
        this.connectedCallback();
      }
    }, { signal: sig });
  }

  disconnectedCallback() {
    this.#ac?.abort();
    this.#ac = null;
  }

  #onClick = (e) => {
    const tab = e.target.closest('[data-tab]');
    if (tab) {
      this.#switchTab(+tab.dataset.tab);
      return;
    }

    const item = e.target.closest('[data-restaurant-add-to-cart]');
    if (item) {
      this.#addToCart(item);
    }
  };

  #switchTab(idx) {
    this.querySelectorAll('.rm-tab').forEach((t, i) => {
      t.classList.toggle('rm-tab--active', i === idx);
    });
    this.querySelectorAll('.rm-panel').forEach((p, i) => {
      p.classList.toggle('rm-panel--active', i === idx);
    });
  }

  async #addToCart(item) {
    const id = item.dataset.variantId;
    if (!id) return;

    item.style.opacity = '0.5';
    item.style.pointerEvents = 'none';

    try {
      const res = await fetch('/cart/add.js', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: [{ id: +id, quantity: 1 }] }),
      });

      if (!res.ok) return;

      const cart = await (await fetch('/cart.js')).json();
      document.dispatchEvent(new CustomEvent('cart:update', {
        bubbles: true,
        detail: { resource: cart, sourceId: 'restaurant-menu', data: { source: 'product-form-component', itemCount: 1 } },
      }));
    } catch (_) {}
    finally {
      item.style.opacity = '';
      item.style.pointerEvents = '';
    }
  }
}

if (!customElements.get('restaurant-menu-component')) {
  customElements.define('restaurant-menu-component', RestaurantMenuComponent);
}
