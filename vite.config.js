import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      workbox: {
        // Minimal SW for now — precache only the app shell.
        // To add offline support later: add runtimeCaching rules here
        // for board images, Supabase API calls, and fonts.
        globPatterns: ['**/*.{js,css,html}'],
      },
      manifest: {
        name: 'Barn Board',
        short_name: 'Barn Board',
        description: 'Climbing route logger for the Barn Board',
        theme_color: '#0a0a0a',
        background_color: '#FFAB94',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
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
