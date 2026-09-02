import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    env: {
      /**
       * One timezone for the whole suite.
       *
       * Times of day are read against the local clock, so a test about them
       * says nothing unless the clock is known. Amsterdam because that is
       * where this runs, and because it observes the two days a year that are
       * worth having tests for at all. CI runs in UTC, which has neither.
       */
      TZ: 'Europe/Amsterdam',
    },
  },
});
