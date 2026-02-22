class RestaurantHeroCarousel extends HTMLElement {
  #current = 0;
  #timer = null;
  #abortController = null;

  get slides() {
    return this.querySelectorAll('[data-slide-index]');
  }

  get dots() {
    return this.querySelectorAll('[data-dot-index]');
  }

  get count() {
    return this.slides.length;
  }

  get autoplay() {
    return this.dataset.autoplay === 'true';
  }

  get interval() {
    return (parseInt(this.dataset.interval, 10) || 6) * 1000;
  }

  connectedCallback() {
    // #region agent log
    console.log('[HERO-DEBUG] connectedCallback', {count: this.count, slides: this.slides.length, dots: this.dots.length, autoplay: this.autoplay, interval: this.interval, children: this.children.length});
    // #endregion
    if (this.count <= 1) {
      // #region agent log
      console.warn('[HERO-DEBUG] EARLY EXIT: count <= 1, carousel will NOT initialize. count=', this.count);
      // #endregion
      return;
    }

    this.#abortController = new AbortController();

    this.addEventListener('click', this.#handleDotClick, {
      signal: this.#abortController.signal,
    });

    document.addEventListener('shopify:section:load', this.#onSectionLoad, {
      signal: this.#abortController.signal,
    });

    if (this.autoplay) this.#startAutoplay();

    this.addEventListener('mouseenter', this.#pauseAutoplay, {
      signal: this.#abortController.signal,
    });
    this.addEventListener('mouseleave', this.#resumeAutoplay, {
      signal: this.#abortController.signal,
    });
    // #region agent log
    console.log('[HERO-DEBUG] Carousel initialized successfully. Autoplay:', this.autoplay);
    // #endregion
  }

  disconnectedCallback() {
    this.#stopAutoplay();
    this.#abortController?.abort();
    this.#abortController = null;
  }

  #onSectionLoad = (event) => {
    if (this.closest('.shopify-section') === event.target) {
      this.#abortController?.abort();
      this.#current = 0;
      this.connectedCallback();
    }
  };

  #handleDotClick = (event) => {
    const dot = event.target.closest('[data-dot-index]');
    if (!dot) return;
    const index = parseInt(dot.dataset.dotIndex, 10);
    if (index === this.#current) return;
    // #region agent log
    console.log('[HERO-DEBUG] Dot clicked, going to slide', index);
    // #endregion
    this.#goTo(index);
    this.#restartAutoplay();
  };

  #goTo(index) {
    const slides = this.slides;
    const dots = this.dots;
    // #region agent log
    console.log('[HERO-DEBUG] goTo', {from: this.#current, to: index, slidesLen: slides.length, dotsLen: dots.length});
    // #endregion

    slides[this.#current]?.classList.remove('restaurant-hero__slide--active');
    dots[this.#current]?.classList.remove('restaurant-hero__dot--active');

    this.#current = index;

    slides[this.#current]?.classList.add('restaurant-hero__slide--active');
    dots[this.#current]?.classList.add('restaurant-hero__dot--active');
  }

  #next = () => {
    this.#goTo((this.#current + 1) % this.count);
  };

  #startAutoplay() {
    if (!this.autoplay || this.count <= 1) return;
    // #region agent log
    console.log('[HERO-DEBUG] Starting autoplay, interval:', this.interval, 'ms');
    // #endregion
    this.#timer = setInterval(this.#next, this.interval);
  }

  #stopAutoplay() {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  #pauseAutoplay = () => this.#stopAutoplay();

  #resumeAutoplay = () => {
    if (this.autoplay) this.#startAutoplay();
  };

  #restartAutoplay() {
    this.#stopAutoplay();
    this.#resumeAutoplay();
  }
}

// #region agent log
console.log('[HERO-DEBUG] Script loaded, alreadyDefined:', !!customElements.get('restaurant-hero-carousel'));
// #endregion
if (!customElements.get('restaurant-hero-carousel')) {
  customElements.define('restaurant-hero-carousel', RestaurantHeroCarousel);
}
