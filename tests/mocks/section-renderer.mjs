// Records morphSection calls so tests can assert the drawer is updated with the
// non-destructive 'hydration' mode (a 'full' morph clobbers the open dialog —
// the original "works only after refresh" bug).
export const morphCalls = [];

export function morphSection(sectionId, html, mode = 'full') {
  morphCalls.push({ sectionId, html, mode });
}

export function resetMorphCalls() {
  morphCalls.length = 0;
}
