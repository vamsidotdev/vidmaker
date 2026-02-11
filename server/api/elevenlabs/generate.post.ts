import type { H3Event } from 'h3'

interface GenerateBody {
  voiceId?: string
  text?: string
  modelId?: string
  outputFormat?: string
  languageCode?: string
  seed?: number
  previousText?: string
  nextText?: string
  voiceSettings?: {
    stability?: number
    similarityBoost?: number
    style?: number
    useSpeakerBoost?: boolean
    speed?: number
  }
}

export default defineEventHandler(async (event) => {
  const apiKey = requireApiKey(event)
  const body = await readBody<GenerateBody>(event)
  const voiceId = body.voiceId?.trim()
  const text = body.text?.trim()

  if (!voiceId) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Missing ElevenLabs voiceId.'
    })
  }
  if (!text) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Missing ElevenLabs text.'
    })
  }

  const payload = removeUndefined({
    text,
    model_id: body.modelId?.trim() || 'eleven_multilingual_v2',
    output_format: body.outputFormat?.trim() || 'mp3_44100_128',
    language_code: body.languageCode?.trim() || undefined,
    seed: Number.isFinite(body.seed) ? body.seed : undefined,
    previous_text: body.previousText?.trim() || undefined,
    next_text: body.nextText?.trim() || undefined,
    voice_settings: removeUndefined({
      stability: normalizeBetween(body.voiceSettings?.stability, 0.5),
      similarity_boost: normalizeBetween(body.voiceSettings?.similarityBoost, 0.75),
      style: normalizeBetween(body.voiceSettings?.style, 0),
      use_speaker_boost: typeof body.voiceSettings?.useSpeakerBoost === 'boolean'
        ? body.voiceSettings.useSpeakerBoost
        : true,
      speed: normalizeSpeed(body.voiceSettings?.speed, 1)
    })
  })

  const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`, {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
      'accept': 'audio/mpeg',
      'content-type': 'application/json'
    },
    body: JSON.stringify(payload)
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw createError({
      statusCode: response.status,
      statusMessage: errorText || 'ElevenLabs speech generation failed.'
    })
  }

  const audioBuffer = Buffer.from(await response.arrayBuffer())
  const contentType = response.headers.get('content-type') ?? 'audio/mpeg'
  const historyItemId = response.headers.get('history-item-id') ?? response.headers.get('x-history-item-id')

  setHeader(event, 'content-type', contentType)
  if (historyItemId) {
    setHeader(event, 'x-elevenlabs-history-item-id', historyItemId)
  }
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

function normalizeBetween(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback
  }
  return Math.min(1, Math.max(0, Number(value)))
}

function normalizeSpeed(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback
  }
  return Math.min(2, Math.max(0.7, Number(value)))
}

function removeUndefined<T extends Record<string, unknown>>(input: T): T {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined)
  ) as T
}
