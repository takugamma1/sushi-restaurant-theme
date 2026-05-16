(function () {
  class RestaurantGalleryComponent extends HTMLElement {
    #observer = null;

    connectedCallback() {
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const mobile = window.matchMedia('(max-width: 749px)').matches;
      const baseStagger = parseInt(this.dataset.stagger, 10) || 80;
      const stagger = mobile ? Math.min(40, baseStagger / 2) : baseStagger;

      const cells = this.querySelectorAll('.rg__cell');
      cells.forEach((cell, i) => {
        cell.style.setProperty('--rg-delay', `${i * stagger}ms`);
      });

      if (reduced || typeof IntersectionObserver === 'undefined') {
        cells.forEach((c) => c.classList.add('is-visible'));
        return;
      }

      this.#observer = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            // Re-stagger from the FIRST entering cell so a fresh scroll-in
            // doesn't inherit a huge delay from earlier cells.
            if (entry.isIntersecting) {
              entry.target.classList.add('is-visible');
            } else {
              entry.target.classList.remove('is-visible');
            }
          });
        },
        {
          threshold: 0.12,
          rootMargin: mobile ? '0px 0px -8% 0px' : '0px 0px -12% 0px',
        }
      );

      cells.forEach((cell) => this.#observer.observe(cell));
    }

    disconnectedCallback() {
      this.#observer?.disconnect();
      this.#observer = null;
    }
  }

  if (!customElements.get('restaurant-gallery')) {
    customElements.define('restaurant-gallery', RestaurantGalleryComponent);
  }
})();
