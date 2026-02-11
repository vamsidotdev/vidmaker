import type { H3Event } from 'h3'

export default defineEventHandler(async (event) => {
  const apiKey = requireApiKey(event)
  const response = await fetch('https://api.elevenlabs.io/v1/voices', {
    headers: {
      'xi-api-key': apiKey,
      'accept': 'application/json'
    }
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw createError({
      statusCode: response.status,
      statusMessage: errorText || 'Failed to load ElevenLabs voices.'
    })
  }

  return await response.json()
})

function requireApiKey(event: H3Event): string {
  const headerApiKey = getHeader(event, 'x-elevenlabs-api-key')?.trim()
  const configApiKey = String(useRuntimeConfig(event).elevenlabsApiKey || '').trim()
  const apiKey = headerApiKey || configApiKey

  if (!apiKey) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Missing ElevenLabs API key. Set ELEVENLABS_API_KEY in .env.'
    })
  }

  return apiKey
}
