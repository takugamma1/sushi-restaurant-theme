/**
 * ESM loader that resolves the theme's import-map specifiers (`@theme/...`),
 * which browsers resolve via the <script type="importmap"> in the layout.
 * Modules under test get mocks; anything else maps to the real asset file.
 */
const MOCKED = {
  '@theme/utilities': './mocks/utilities.mjs',
  '@theme/section-renderer': './mocks/section-renderer.mjs',
};

export function resolve(specifier, context, nextResolve) {
  if (specifier in MOCKED) {
    return { shortCircuit: true, url: new URL(MOCKED[specifier], import.meta.url).href };
  }
  if (specifier.startsWith('@theme/')) {
    const asset = specifier.replace('@theme/', '../assets/') + '.js';
    return { shortCircuit: true, url: new URL(asset, import.meta.url).href };
  }
  return nextResolve(specifier, context);
}
