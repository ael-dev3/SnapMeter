import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), cloudflare()],
  build: {
    // Vite derives these from modules that actually enter each environment,
    // so dependency additions cannot silently bypass redistribution notices.
    // The post-build verifier combines and validates both emitted artifacts.
    license: { fileName: ".vite/third-party-licenses.md" }
  }
});
