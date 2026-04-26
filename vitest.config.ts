/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    testTimeout: 10_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: './coverage',
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/**/*.{test,spec}.{ts,tsx}',
        'src/**/*.stories.tsx',
        'src/**/*.d.ts',
        'src/test/**',
        'src/main.tsx',
        'src/**/index.tsx',
        'src/modules/registry.ts',
      ],
      // Hard floor for the line metric. Actual coverage today sits well
      // above this (87 %), so the gate catches regressions without
      // demanding net-new tests for routine UI changes. Bump the
      // threshold once we land a concerted push to lift the absolute
      // number — flipping it on now would just drift the bar below
      // current reality on any small PR.
      thresholds: {
        lines: 70,
      },
    },
  },
});
