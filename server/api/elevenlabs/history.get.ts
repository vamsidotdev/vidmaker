import type { H3Event } from 'h3'

interface ElevenLabsHistoryResponse {
  history?: unknown[]
  has_more?: boolean
  last_history_item_id?: string
}

export default defineEventHandler(async (event) => {
  const apiKey = requireApiKey(event)
  const history: unknown[] = []
  let startAfterHistoryItemId: string | undefined

  // Pull full history in pages so users can browse all generations.
  for (let page = 0; page < 20; page += 1) {
    const query = new URLSearchParams({ page_size: '100' })
    if (startAfterHistoryItemId) {
      query.set('start_after_history_item_id', startAfterHistoryItemId)
    }

    const response = await fetch(`https://api.elevenlabs.io/v1/history?${query.toString()}`, {
      headers: {
        'xi-api-key': apiKey,
        'accept': 'application/json'
      }
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw createError({
        statusCode: response.status,
        statusMessage: errorText || 'Failed to load ElevenLabs history.'
      })
    }

    const payload = await response.json() as ElevenLabsHistoryResponse
    if (Array.isArray(payload.history)) {
      history.push(...payload.history)
    }

    if (!payload.has_more || !payload.last_history_item_id) {
      break
    }
    startAfterHistoryItemId = payload.last_history_item_id
  }

  return { history }
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
