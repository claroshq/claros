import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

/**
 * Vite configuration for the Claros dashboard SPA.
 *
 * Dev server proxy: forwards API calls to the Fastify backend so the
 * browser always operates on a single origin (no CORS needed).
 * Target defaults to http://localhost:3000, overridable via
 * VITE_API_URL environment variable (set in a .env.local file).
 *
 * Test configuration is included here (not in a separate vitest.config.ts)
 * so that the path alias "@/*" is declared exactly once and shared between
 * the build and the test runner. Two config files mean two alias declarations,
 * which creates a class of bug where the build resolves but tests do not.
 */

const apiTarget = process.env.VITE_API_URL ?? "http://localhost:3000";

export default defineConfig({
  plugins: [react(), tailwindcss()],

  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
    },
  },

  build: {
    outDir: "dist",
    emptyOutDir: true,
    // Never inline woff2 files as base64 data URLs.
    // When a font file is inlined, unicode-range has no effect: the bytes land
    // inside the render-blocking stylesheet and are downloaded unconditionally
    // by every visitor. Return false for woff2 to force file emission; return
    // undefined for everything else to preserve Vite's default threshold.
    assetsInlineLimit: (filePath) =>
      filePath.endsWith(".woff2") ? false : undefined,
  },

  server: {
    proxy: {
      "/auth": {
        target: apiTarget,
        changeOrigin: true,
      },
      "/v1": {
        target: apiTarget,
        changeOrigin: true,
      },
    },
  },

  test: {
    include: ["tests/**/*.{test,spec}.{ts,tsx}"],
    passWithNoTests: true,
  },
});
