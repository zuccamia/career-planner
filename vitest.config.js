// Vitest config for the browser-side .mjs modules. Uses `happy-dom` so
// modules that transitively touch browser globals (Worker, window,
// document) can load without crashing at import time — the tests
// themselves stay focused on pure logic, not real DOM interactions.
export default {
  test: {
    include: ['web/static/local/js/**/*.test.mjs'],
    environment: 'happy-dom',
  },
};
