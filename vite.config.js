import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      workbox: {
        globPatterns: ['**/*.{js,css,html,jpg,png,woff2}'],
        globIgnores: [
          '**/Barn_Set_01_V4*.jpg',
          '**/Barn_Set_01_V7*.jpg',
          '**/Barn_Board_Reset_02_C.jpg',
          '**/Barn_Board_Reset_03_fake.jpg',
          '**/Barn_Set_01_V3A.JPG',
          '**/debug_detection.jpg',
          '**/Archive/**',
          // Route-video shrinker (~775 KB). Only needed the moment someone picks a
          // video, so it's fetched then, not precached for every user. (Named by
          // chunkFileNames below; Vite's default name for it is just "index".)
          '**/mediabunny-*.js',
        ],
        maximumFileSizeToCacheInBytes: 1 * 1024 * 1024, // 1 MiB — covers optimized images (max 843 KB)
        clientsClaim: true,
        skipWaiting: true,
      },
      manifest: {
        name: 'Barn Board',
        short_name: 'Barn Board',
        description: 'Climbing route logger for the Barn Board',
        theme_color: '#0a0a0a',
        background_color: '#FFAB94',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/?v=5',
        icons: [
          { src: '/icon-192.png?v=2', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png?v=2', sizes: '512x512', type: 'image/png' },
          { src: '/icon-512.png?v=2', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
    }),
  ],
  build: {
    rollupOptions: {
      output: {
        // Give the two upload libraries recognisable file names (their default is
        // "index-<hash>.js", same as the app entry, which can't be targeted by the
        // service worker's globIgnores). Chunking itself is unchanged.
        chunkFileNames: (chunk) => {
          const hasModule = (pkg) => chunk.moduleIds.some((id) => id.includes(`/node_modules/${pkg}/`));
          if (hasModule('mediabunny')) return 'assets/mediabunny-[hash].js';
          if (hasModule('tus-js-client')) return 'assets/tus-[hash].js';
          return 'assets/[name]-[hash].js';
        },
      },
    },
  },
  server: {
    host: true,
    port: parseInt(process.env.PORT || '5173'),
  },
})
