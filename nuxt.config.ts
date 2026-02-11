// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  modules: [
    '@nuxt/eslint',
    '@nuxt/ui'
  ],

  devtools: {
    enabled: true
  },

  css: ['~/assets/css/main.css'],

  runtimeConfig: {
    elevenlabsApiKey: process.env.ELEVENLABS_API_KEY || ''
  },

  routeRules: {
    '/': { prerender: true },
    '/elevenlabs': { prerender: true }
  },

  devServer: {
    port: 1247
  },

  compatibilityDate: '2025-01-15',

  eslint: {
    config: {
      stylistic: {
        commaDangle: 'never',
        braceStyle: '1tbs'
      }
    }
  }
})
