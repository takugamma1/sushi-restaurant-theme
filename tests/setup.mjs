import { register } from 'node:module';

// Route the theme's `@theme/*` import-map specifiers to test mocks (or the real
// asset file) so `assets/cart-fulfillment.js` can be imported under Node.
register('./theme-loader.mjs', import.meta.url);
