class RestaurantHero extends HTMLElement {
  #idx = 0;
  #timer = null;
  #ac = null;

  connectedCallback() {
    const n = this.querySelectorAll('.rh__slide').length;
    if (n <= 1) return;

    this.#ac = new AbortController();
    const sig = this.#ac.signal;

    this.addEventListener('click', this.#onDot, { signal: sig });
    this.addEventListener('mouseenter', () => this.#stop(), { signal: sig });
    this.addEventListener('mouseleave', () => this.#play(), { signal: sig });

    document.addEventListener('shopify:section:load', (e) => {
      if (this.closest('.shopify-section') === e.target) {
        this.#ac?.abort();
        this.#idx = 0;
        this.connectedCallback();
      }
    }, { signal: sig });

    this.#play();
  }

  disconnectedCallback() {
    this.#stop();
    this.#ac?.abort();
    this.#ac = null;
  }

  #onDot = (e) => {
    const d = e.target.closest('[data-dot]');
    if (!d) return;
    const i = +d.dataset.dot;
    if (i === this.#idx) return;
    this.#go(i);
    this.#stop();
    this.#play();
  };

  #go(i) {
    const slides = this.querySelectorAll('.rh__slide');
    const dots = this.querySelectorAll('.rh__dot');
    if (!slides.length) return;

    slides[this.#idx]?.classList.remove('is-active');
    dots[this.#idx]?.classList.remove('is-active');

    this.#idx = i % slides.length;

    slides[this.#idx]?.classList.add('is-active');
    dots[this.#idx]?.classList.add('is-active');
  }

  #play() {
    if (this.#timer) return;
    const sec = this.dataset.autoplay;
    if (!sec) return;
    this.#timer = setInterval(() => {
      const n = this.querySelectorAll('.rh__slide').length;
      this.#go((this.#idx + 1) % n);
    }, +sec * 1000);
  }

  #stop() {
    clearInterval(this.#timer);
    this.#timer = null;
  }
}

if (!customElements.get('restaurant-hero')) {
  customElements.define('restaurant-hero', RestaurantHero);
}
