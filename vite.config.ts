import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// GATEWAY_PORT from @mimi-os/protocol, hardcoded: vite's own resolver doesn't see the workspace package's "development" condition
const GATEWAY = "http://127.0.0.1:46464";

export default defineConfig({
    root: ".",
    // the dev server and Tauri's devUrl serve the pult under /app/; the desktop build passes --base ./
    base: "/app/",
    plugins: [react()],
    build: {
        outDir: "dist",
        emptyOutDir: true,
    },
    server: {
        port: 5273,
        watch: { ignored: ["**/tauri/**"] },
        // nothing may frame the pult (it holds the device key) to clickjack an approval
        headers: { "content-security-policy": "frame-ancestors 'none'" },
        // the dev server owns the page; every /api call is proxied to the real gateway, so
        // the React app talks to live agents instead of a mock
        proxy: {
            "/api": { target: GATEWAY, changeOrigin: true },
            // the secure channel: binary WebSocket, both the session and pairing upgrades
            "/channel": { target: GATEWAY, ws: true },
        },
    },
});
