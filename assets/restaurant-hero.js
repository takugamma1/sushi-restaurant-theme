class RestaurantHeroCarousel extends HTMLElement {
  #current = 0;
  #timer = null;
  #abortController = null;

  get slides() {
    return this.querySelectorAll('[data-slide-index]:not([data-slide-empty])');
  }

  get allSlides() {
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
    console.log('[HERO-DEBUG] connectedCallback', {count: this.count, allSlides: this.allSlides.length, dots: this.dots.length, autoplay: this.autoplay});
    // #endregion
    if (this.count <= 1) {
      // #region agent log
      console.warn('[HERO-DEBUG] EARLY EXIT: count <= 1, no carousel needed. count=', this.count);
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
    console.log('[HERO-DEBUG] Carousel initialized. Autoplay:', this.autoplay, 'Interval:', this.interval);
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
    this.#goTo(index);
    this.#restartAutoplay();
  };

  #goTo(index) {
    const slides = this.slides;
    const dots = this.dots;

    if (!slides.length) return;

    slides[this.#current]?.classList.remove('restaurant-hero__slide--active');
    dots[this.#current]?.classList.remove('restaurant-hero__dot--active');

    this.#current = index % slides.length;

    slides[this.#current]?.classList.add('restaurant-hero__slide--active');
    dots[this.#current]?.classList.add('restaurant-hero__dot--active');
  }

  #next = () => {
    this.#goTo((this.#current + 1) % this.count);
  };

  #startAutoplay() {
    if (!this.autoplay || this.count <= 1) return;
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
console.log('[HERO-DEBUG] Script loaded');
// #endregion
if (!customElements.get('restaurant-hero-carousel')) {
  customElements.define('restaurant-hero-carousel', RestaurantHeroCarousel);
}
