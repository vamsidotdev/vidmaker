import type { H3Event } from 'h3'

export default defineEventHandler(async (event) => {
  const apiKey = requireApiKey(event)
  const historyItemId = getRouterParam(event, 'historyItemId')

  if (!historyItemId) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Missing history item id.'
    })
  }

  const response = await fetch(`https://api.elevenlabs.io/v1/history/${encodeURIComponent(historyItemId)}/audio`, {
    headers: {
      'xi-api-key': apiKey,
      'accept': 'audio/mpeg'
    }
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw createError({
      statusCode: response.status,
      statusMessage: errorText || 'Failed to load ElevenLabs history audio.'
    })
  }

  const audioBuffer = Buffer.from(await response.arrayBuffer())
  const contentType = response.headers.get('content-type') ?? 'audio/mpeg'
  setHeader(event, 'content-type', contentType)
  return audioBuffer
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
