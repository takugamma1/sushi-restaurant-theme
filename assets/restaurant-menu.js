class RestaurantMenuComponent extends HTMLElement {
  #abortController = null;

  connectedCallback() {
    this.#abortController = new AbortController();
    this.addEventListener('click', this.#handleClick, { signal: this.#abortController.signal });

    document.addEventListener('shopify:section:load', this.#onSectionLoad, { signal: this.#abortController.signal });
  }

  disconnectedCallback() {
    this.#abortController?.abort();
    this.#abortController = null;
  }

  #onSectionLoad = (event) => {
    if (this.closest('.shopify-section') === event.target) {
      this.#abortController?.abort();
      this.connectedCallback();
    }
  };

  #handleClick = async (event) => {
    const item = event.target.closest('[data-restaurant-add-to-cart]');
    if (!item) return;

    const variantId = item.dataset.variantId;
    if (!variantId) return;

    item.style.opacity = '0.6';
    item.style.pointerEvents = 'none';

    try {
      const response = await fetch('/cart/add.js', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: [{ id: parseInt(variantId, 10), quantity: 1 }] }),
      });

      if (!response.ok) {
        const error = await response.json();
        console.warn('[restaurant-menu] Cart add failed:', error.description || error.message);
        return;
      }

      const cartResponse = await fetch('/cart.js');
      const cart = await cartResponse.json();

      document.dispatchEvent(
        new CustomEvent('cart:update', {
          bubbles: true,
          detail: {
            resource: cart,
            sourceId: 'restaurant-menu',
            data: {
              source: 'product-form-component',
              itemCount: 1,
            },
          },
        })
      );
    } catch (err) {
      console.warn('[restaurant-menu] Network error:', err);
    } finally {
      item.style.opacity = '';
      item.style.pointerEvents = '';
    }
  };
}

if (!customElements.get('restaurant-menu-component')) {
  customElements.define('restaurant-menu-component', RestaurantMenuComponent);
}
