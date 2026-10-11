import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    preact(),
    // Acá se configura la app instalable (PWA) y la caché para trabajar sin señal
    VitePWA({
      registerType: 'prompt',
      injectRegister: false,
      includeAssets: ['fonts/manrope.woff', 'icon.svg'],
      manifest: {
        name: 'Cobros',
        short_name: 'Cobros',
        description: 'Gestión de préstamos y cobros diarios',
        lang: 'es-CO',
        theme_color: '#000000',
        background_color: '#000000',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        icons: [
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }
        ]
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,woff}'],
        navigateFallback: '/index.html',
        cleanupOutdatedCaches: true,
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.hostname.endsWith('.supabase.co') && url.pathname.startsWith('/rest/'),
            handler: 'NetworkFirst',
            options: { cacheName: 'api', networkTimeoutSeconds: 6, expiration: { maxEntries: 120, maxAgeSeconds: 86400 } }
          }
        ]
      }
    })
  ],
  build: {
    target: 'es2019',
    cssCodeSplit: true,
    rollupOptions: {
      output: {
        // Separa las librerías para que el cobrador no descargue código del admin
        manualChunks: {
          gsap: ['gsap'],
          supabase: ['@supabase/supabase-js']
        }
      }
    }
  }
});
