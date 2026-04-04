import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      workbox: {
        globPatterns: ['**/*.{js,css,html}'],
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
        start_url: '/?v=3',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
    }),
  ],
  server: {
    host: true,
    port: parseInt(process.env.PORT || '5173'),
  },
})
