// @ts-check
import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";

// Set SITE to your GitHub Pages URL, e.g. https://<username>.github.io
// (the deploy workflow sets it automatically).
export default defineConfig({
  site: process.env.SITE || "https://example.github.io",
  integrations: [sitemap()],
});
