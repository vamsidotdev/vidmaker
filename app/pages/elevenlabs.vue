<script setup lang="ts">
interface ElevenLabsVoice {
  voice_id: string
  name: string
  category?: string
}

interface ElevenLabsHistoryItem {
  history_item_id: string
  text?: string
  voice_name?: string
  voice_id?: string
  model_id?: string
  date_unix?: number
  character_count_change_from?: number
  character_count_change_to?: number
  settings?: {
    stability?: number
    similarity_boost?: number
    style?: number
    use_speaker_boost?: boolean
    speed?: number
  }
  voice_settings?: {
    stability?: number
    similarity_boost?: number
    style?: number
    use_speaker_boost?: boolean
    speed?: number
  }
  request?: {
    model_id?: string
    voice_settings?: {
      stability?: number
      similarity_boost?: number
      style?: number
      use_speaker_boost?: boolean
      speed?: number
    }
  }
}

interface ElevenLabsGeneratePayload {
  voiceId: string
  text: string
  modelId: string
  outputFormat: string
  languageCode?: string
  seed?: number
  previousText?: string
  nextText?: string
  voiceSettings: {
    stability: number
    similarityBoost: number
    style: number
    useSpeakerBoost: boolean
    speed: number
  }
}

interface StoredElevenLabsSettings {
  voiceId: string
  modelId: string
  outputFormat: string
  languageOverrideEnabled: boolean
  languageCode: string
  seed: string
  previousText: string
  nextText: string
  stability: number
  similarityBoost: number
  style: number
  useSpeakerBoost: boolean
  speed: number
}

interface BufferJsonPayload {
  type: 'Buffer'
  data: number[]
}

interface StoredFileRecord {
  id: string
  name: string
  type: string
  blob: Blob
}

interface StoredClip {
  id: string
  fileId: string
  name: string
  kind: 'video' | 'image' | 'audio'
  start: number
  duration: number
  sourceOffset: number
  sourceDuration: number
  volume: number
  muted: boolean
  previousVolume: number
}

interface StoredProject {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  clips: StoredClip[]
  captions: unknown[]
  overlays: unknown[]
  captionStyleId: string
  captionPositionX: number
  captionPositionY: number
  captionSizePercent: number
  captionLetterCase: string
}

interface ProjectCard {
  id: string
  name: string
  createdAt: number
  updatedAt: number
}

interface SavedGeneratedAudioItem {
  id: string
  fileId: string
  name: string
  description: string
  liked: boolean
  createdAt: number
  voiceId: string
  voiceName: string
  modelId: string
  source: 'generated' | 'history'
  historyItemId?: string
}

const SETTINGS_STORAGE_KEY = 'vidmaker-elevenlabs-settings-v1'
const SAVED_AUDIO_STORAGE_KEY = 'vidmaker-elevenlabs-audio-library-v1'
const DB_NAME = 'vidmaker-db'
const DB_VERSION = 1
const FILES_STORE = 'files'
const PROJECTS_STORE = 'projects'
const voiceId = ref('')
const modelId = ref('eleven_multilingual_v2')
const outputFormat = ref('mp3_44100_128')
const languageOverrideEnabled = ref(false)
const languageCode = ref('')
const seed = ref('')
const previousText = ref('')
const nextText = ref('')
const stability = ref(0.5)
const similarityBoost = ref(0.75)
const style = ref(0)
const useSpeakerBoost = ref(true)
const speed = ref(1)
const text = ref('')
const statusMessage = ref('Generating with ElevenLabs API key from environment.')
const voices = ref<ElevenLabsVoice[]>([])
const historyItems = ref<ElevenLabsHistoryItem[]>([])
const projects = ref<ProjectCard[]>([])
const savedAudioItems = ref<SavedGeneratedAudioItem[]>([])
const generatedAudioUrl = ref<string | null>(null)
const generatedAudioMime = ref('audio/mpeg')
const activeHistoryItemId = ref<string | null>(null)
const activeHistoryAudioUrl = ref<string | null>(null)
const isLoadingVoices = ref(false)
const isLoadingHistory = ref(false)
const isGenerating = ref(false)
const isLoadingHistoryAudio = ref(false)
const isSavingAudio = ref(false)
const isImportingAudio = ref(false)
const historySearchText = ref('')
const historyVoiceFilter = ref('')
const historyDateFilter = ref<'all' | '24h' | '7d' | '30d' | '90d'>('all')
const generatedAudioDescription = ref('')
const generatedAudioLiked = ref(false)
const projectTargetByAudio = reactive<Record<string, string>>({})

const historyAudioByItem = new Map<string, string>()
let dbPromise: Promise<IDBDatabase> | null = null

const canGenerate = computed(() => Boolean(voiceId.value.trim()) && Boolean(text.value.trim()))
const groupedVoices = computed(() => {
  const grouped = new Map<string, ElevenLabsVoice[]>()
  voices.value.forEach((voice) => {
    const category = (voice.category || 'default').trim() || 'default'
    const list = grouped.get(category) ?? []
    list.push(voice)
    grouped.set(category, list)
  })

  return Array.from(grouped.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([category, items]) => ({
      category,
      items: items.slice().sort((a, b) => a.name.localeCompare(b.name))
    }))
})
const historyVoiceFilterOptions = computed(() => {
  const options = new Map<string, string>()
  historyItems.value.forEach((item) => {
    const value = (item.voice_id || '').trim()
    if (!value) {
      return
    }
    const label = item.voice_name?.trim() || value
    if (!options.has(value)) {
      options.set(value, label)
    }
  })

  return Array.from(options.entries())
    .sort((a, b) => a[1].localeCompare(b[1]))
    .map(([value, label]) => ({ value, label }))
})
const filteredHistoryItems = computed(() => {
  const query = historySearchText.value.trim().toLowerCase()
  const selectedVoice = historyVoiceFilter.value.trim()
  const nowUnix = Math.floor(Date.now() / 1000)
  const minDateUnix = getMinDateUnix(historyDateFilter.value, nowUnix)

  return historyItems.value.filter((item) => {
    if (selectedVoice && item.voice_id !== selectedVoice) {
      return false
    }
    if (typeof minDateUnix === 'number') {
      if (!Number.isFinite(item.date_unix) || Number(item.date_unix) < minDateUnix) {
        return false
      }
    }
    if (!query) {
      return true
    }

    const searchable = [
      item.text ?? '',
      item.voice_name ?? '',
      item.voice_id ?? '',
      item.model_id ?? ''
    ]
      .join(' ')
      .toLowerCase()
    return searchable.includes(query)
  })
})

const persistedSettings = computed<StoredElevenLabsSettings>(() => ({
  voiceId: voiceId.value,
  modelId: modelId.value,
  outputFormat: outputFormat.value,
  languageOverrideEnabled: languageOverrideEnabled.value,
  languageCode: languageCode.value,
  seed: seed.value,
  previousText: previousText.value,
  nextText: nextText.value,
  stability: stability.value,
  similarityBoost: similarityBoost.value,
  style: style.value,
  useSpeakerBoost: useSpeakerBoost.value,
  speed: speed.value
}))

watch(
  persistedSettings,
  (settings) => {
    if (!import.meta.client) {
      return
    }
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings))
  },
  { deep: true }
)

watch(
  savedAudioItems,
  (items) => {
    if (!import.meta.client) {
      return
    }
    localStorage.setItem(SAVED_AUDIO_STORAGE_KEY, JSON.stringify(items))
  },
  { deep: true }
)

onMounted(async () => {
  loadPersistedSettings()
  loadSavedAudioLibrary()
  await Promise.all([loadVoices(), loadHistory(), loadProjects()])
})

onBeforeUnmount(() => {
  if (generatedAudioUrl.value) {
    URL.revokeObjectURL(generatedAudioUrl.value)
    generatedAudioUrl.value = null
  }
  historyAudioByItem.forEach((url) => {
    URL.revokeObjectURL(url)
  })
  historyAudioByItem.clear()
})

function loadPersistedSettings(): void {
  if (!import.meta.client) {
    return
  }

  const raw = localStorage.getItem(SETTINGS_STORAGE_KEY)
  if (!raw) {
    return
  }

  try {
    const parsed = JSON.parse(raw) as Partial<StoredElevenLabsSettings>
    voiceId.value = typeof parsed.voiceId === 'string' ? parsed.voiceId : ''
    modelId.value = typeof parsed.modelId === 'string' ? parsed.modelId : 'eleven_multilingual_v2'
    outputFormat.value = typeof parsed.outputFormat === 'string' ? parsed.outputFormat : 'mp3_44100_128'
    languageOverrideEnabled.value = typeof parsed.languageOverrideEnabled === 'boolean'
      ? parsed.languageOverrideEnabled
      : Boolean(parsed.languageCode?.trim())
    languageCode.value = typeof parsed.languageCode === 'string' ? parsed.languageCode : ''
    seed.value = typeof parsed.seed === 'string' ? parsed.seed : ''
    previousText.value = typeof parsed.previousText === 'string' ? parsed.previousText : ''
    nextText.value = typeof parsed.nextText === 'string' ? parsed.nextText : ''
    stability.value = normalizeBetween(parsed.stability, 0.5)
    similarityBoost.value = normalizeBetween(parsed.similarityBoost, 0.75)
    style.value = normalizeBetween(parsed.style, 0)
    useSpeakerBoost.value = typeof parsed.useSpeakerBoost === 'boolean' ? parsed.useSpeakerBoost : true
    speed.value = normalizeSpeed(parsed.speed, 1)
  } catch {
    statusMessage.value = 'Saved ElevenLabs settings could not be parsed. Using defaults.'
  }
}

function loadSavedAudioLibrary(): void {
  if (!import.meta.client) {
    return
  }
  const raw = localStorage.getItem(SAVED_AUDIO_STORAGE_KEY)
  if (!raw) {
    return
  }

  try {
    const parsed = JSON.parse(raw) as SavedGeneratedAudioItem[]
    if (!Array.isArray(parsed)) {
      return
    }
    savedAudioItems.value = parsed
      .filter(item => item && typeof item.id === 'string' && typeof item.fileId === 'string')
      .map((item): SavedGeneratedAudioItem => ({
        ...item,
        description: typeof item.description === 'string' ? item.description : '',
        liked: Boolean(item.liked),
        createdAt: Number.isFinite(item.createdAt) ? item.createdAt : Date.now(),
        voiceId: typeof item.voiceId === 'string' ? item.voiceId : '',
        voiceName: typeof item.voiceName === 'string' ? item.voiceName : '',
        modelId: typeof item.modelId === 'string' ? item.modelId : '',
        source: item.source === 'history' ? 'history' : 'generated'
      }))
      .sort((a, b) => b.createdAt - a.createdAt)

    savedAudioItems.value.forEach((item) => {
      if (projects.value[0]) {
        projectTargetByAudio[item.id] = projects.value[0].id
      }
    })
  } catch {
    statusMessage.value = 'Saved audio library could not be parsed.'
  }
}

function normalizeBetween(value: unknown, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback
  }
  return Math.min(1, Math.max(0, Number(value)))
}

function normalizeSpeed(value: unknown, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback
  }
  return Math.min(2, Math.max(0.7, Number(value)))
}

async function openDatabase(): Promise<IDBDatabase> {
  if (!import.meta.client) {
    throw new Error('IndexedDB is only available in the browser')
  }

  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION)

      request.onupgradeneeded = () => {
        const database = request.result
        if (!database.objectStoreNames.contains(FILES_STORE)) {
          database.createObjectStore(FILES_STORE, { keyPath: 'id' })
        }
        if (!database.objectStoreNames.contains(PROJECTS_STORE)) {
          database.createObjectStore(PROJECTS_STORE, { keyPath: 'id' })
        }
      }

      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error('Could not open IndexedDB'))
    })
  }

  return await dbPromise
}

async function putFile(record: StoredFileRecord): Promise<void> {
  const database = await openDatabase()
  await new Promise<void>((resolve, reject) => {
    const tx = database.transaction(FILES_STORE, 'readwrite')
    tx.objectStore(FILES_STORE).put(record)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('Could not save file'))
    tx.onabort = () => reject(tx.error ?? new Error('File save aborted'))
  })
}

async function getFile(fileId: string): Promise<StoredFileRecord | null> {
  const database = await openDatabase()
  return await new Promise<StoredFileRecord | null>((resolve, reject) => {
    const tx = database.transaction(FILES_STORE, 'readonly')
    const request = tx.objectStore(FILES_STORE).get(fileId)
    request.onsuccess = () => {
      resolve(request.result ? request.result as StoredFileRecord : null)
    }
    request.onerror = () => reject(request.error ?? new Error('Could not load file'))
  })
}

async function listProjects(): Promise<ProjectCard[]> {
  const database = await openDatabase()
  return await new Promise<ProjectCard[]>((resolve, reject) => {
    const tx = database.transaction(PROJECTS_STORE, 'readonly')
    const request = tx.objectStore(PROJECTS_STORE).getAll()
    request.onsuccess = () => {
      const result = Array.isArray(request.result) ? request.result as StoredProject[] : []
      resolve(result.map(project => ({
        id: project.id,
        name: project.name ?? 'Untitled Project',
        createdAt: Number.isFinite(project.createdAt) ? project.createdAt : project.updatedAt,
        updatedAt: project.updatedAt
      })))
    }
    request.onerror = () => reject(request.error ?? new Error('Could not list projects'))
  })
}

async function getProject(projectId: string): Promise<StoredProject | null> {
  const database = await openDatabase()
  return await new Promise<StoredProject | null>((resolve, reject) => {
    const tx = database.transaction(PROJECTS_STORE, 'readonly')
    const request = tx.objectStore(PROJECTS_STORE).get(projectId)
    request.onsuccess = () => resolve(request.result ? request.result as StoredProject : null)
    request.onerror = () => reject(request.error ?? new Error('Could not load project'))
  })
}

async function putProject(project: StoredProject): Promise<void> {
  const database = await openDatabase()
  await new Promise<void>((resolve, reject) => {
    const tx = database.transaction(PROJECTS_STORE, 'readwrite')
    tx.objectStore(PROJECTS_STORE).put(project)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('Could not save project'))
    tx.onabort = () => reject(tx.error ?? new Error('Project save aborted'))
  })
}

async function loadProjects(): Promise<void> {
  try {
    projects.value = (await listProjects()).sort((a, b) => b.updatedAt - a.updatedAt)
    savedAudioItems.value.forEach((item) => {
      if (!projectTargetByAudio[item.id] && projects.value[0]) {
        projectTargetByAudio[item.id] = projects.value[0].id
      }
    })
  } catch (error) {
    statusMessage.value = `Could not load projects for import: ${String(error)}`
  }
}

async function loadVoices(): Promise<void> {
  isLoadingVoices.value = true
  try {
    const response = await $fetch<{ voices?: ElevenLabsVoice[] }>('/api/elevenlabs/voices')
    voices.value = Array.isArray(response.voices) ? response.voices : []
    if (!voiceId.value && voices.value.length) {
      const firstVoice = voices.value[0]
      if (firstVoice) {
        voiceId.value = firstVoice.voice_id
      }
    }
    statusMessage.value = voices.value.length
      ? `Loaded ${voices.value.length} voice(s).`
      : 'No voices returned for this account.'
  } catch (error) {
    statusMessage.value = `Could not load voices: ${String(error)}`
  } finally {
    isLoadingVoices.value = false
  }
}

async function loadHistory(): Promise<void> {
  isLoadingHistory.value = true
  try {
    const response = await $fetch<{ history?: ElevenLabsHistoryItem[] }>('/api/elevenlabs/history')
    historyItems.value = Array.isArray(response.history)
      ? response.history
      : []
    statusMessage.value = historyItems.value.length
      ? `Loaded ${historyItems.value.length} generation history item(s).`
      : 'No generation history found yet.'
  } catch (error) {
    statusMessage.value = `Could not load history: ${String(error)}`
  } finally {
    isLoadingHistory.value = false
  }
}

function buildPayload(): ElevenLabsGeneratePayload {
  const parsedSeed = Number(seed.value)
  const payload: ElevenLabsGeneratePayload = {
    voiceId: voiceId.value.trim(),
    text: text.value.trim(),
    modelId: modelId.value.trim() || 'eleven_multilingual_v2',
    outputFormat: outputFormat.value.trim() || 'mp3_44100_128',
    voiceSettings: {
      stability: normalizeBetween(stability.value, 0.5),
      similarityBoost: normalizeBetween(similarityBoost.value, 0.75),
      style: normalizeBetween(style.value, 0),
      useSpeakerBoost: useSpeakerBoost.value,
      speed: normalizeSpeed(speed.value, 1)
    }
  }

  if (languageOverrideEnabled.value && languageCode.value.trim()) {
    payload.languageCode = languageCode.value.trim()
  }
  if (Number.isFinite(parsedSeed)) {
    payload.seed = parsedSeed
  }
  if (previousText.value.trim()) {
    payload.previousText = previousText.value.trim()
  }
  if (nextText.value.trim()) {
    payload.nextText = nextText.value.trim()
  }
  return payload
}

function resetVoiceSettings(): void {
  speed.value = 1
  stability.value = 0.5
  similarityBoost.value = 0.75
  style.value = 0
  useSpeakerBoost.value = true
  languageOverrideEnabled.value = false
  languageCode.value = ''
}

function asSliderValue(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : '0.00'
}

async function generateSpeech(): Promise<void> {
  if (!canGenerate.value) {
    statusMessage.value = 'Voice and text are required.'
    return
  }

  isGenerating.value = true
  statusMessage.value = 'Generating speech with ElevenLabs...'
  try {
    const response = await $fetch.raw('/api/elevenlabs/generate', {
      method: 'POST',
      body: buildPayload(),
      responseType: 'blob'
    })

    if (generatedAudioUrl.value) {
      URL.revokeObjectURL(generatedAudioUrl.value)
    }
    generatedAudioMime.value = response.headers.get('content-type') ?? 'audio/mpeg'
    generatedAudioUrl.value = URL.createObjectURL(toAudioBlob(response._data, generatedAudioMime.value))
    statusMessage.value = 'Speech generated successfully.'
    await loadHistory()
  } catch (error) {
    statusMessage.value = `Speech generation failed: ${String(error)}`
  } finally {
    isGenerating.value = false
  }
}

function downloadBlobUrl(url: string, filename: string): void {
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
}

function downloadGeneratedAudio(): void {
  if (!generatedAudioUrl.value) {
    return
  }

  const extension = generatedAudioMime.value.includes('wav') ? 'wav' : 'mp3'
  downloadBlobUrl(generatedAudioUrl.value, `elevenlabs-${Date.now()}.${extension}`)
}

async function saveGeneratedAudioToLibrary(): Promise<void> {
  if (!generatedAudioUrl.value) {
    statusMessage.value = 'Generate audio first before saving.'
    return
  }

  isSavingAudio.value = true
  try {
    const response = await fetch(generatedAudioUrl.value)
    const blob = await response.blob()
    await saveAudioToLibrary(blob, {
      description: generatedAudioDescription.value.trim(),
      liked: generatedAudioLiked.value,
      source: 'generated',
      voiceId: voiceId.value.trim(),
      voiceName: getVoiceNameById(voiceId.value.trim()),
      modelId: modelId.value.trim(),
      historyItemId: undefined
    })
    generatedAudioDescription.value = ''
    generatedAudioLiked.value = false
    statusMessage.value = 'Saved generated audio to library.'
  } catch (error) {
    statusMessage.value = `Could not save generated audio: ${String(error)}`
  } finally {
    isSavingAudio.value = false
  }
}

async function saveHistoryItemToLibrary(item: ElevenLabsHistoryItem): Promise<void> {
  isSavingAudio.value = true
  try {
    const url = await ensureHistoryAudioUrl(item.history_item_id)
    const response = await fetch(url)
    const blob = await response.blob()
    await saveAudioToLibrary(blob, {
      description: String(item.text ?? '').trim(),
      liked: false,
      source: 'history',
      voiceId: String(item.voice_id ?? '').trim(),
      voiceName: String(item.voice_name ?? '').trim(),
      modelId: String(item.model_id ?? '').trim(),
      historyItemId: item.history_item_id
    })
    statusMessage.value = `Saved history item ${item.history_item_id} to library.`
  } catch (error) {
    statusMessage.value = `Could not save history item: ${String(error)}`
  } finally {
    isSavingAudio.value = false
  }
}

async function saveAudioToLibrary(
  blob: Blob,
  input: {
    description: string
    liked: boolean
    source: 'generated' | 'history'
    voiceId: string
    voiceName: string
    modelId: string
    historyItemId?: string
  }
): Promise<void> {
  const createdAt = Date.now()
  const fileId = crypto.randomUUID()
  const name = `elevenlabs-${createdAt}.mp3`
  await putFile({
    id: fileId,
    name,
    type: blob.type || 'audio/mpeg',
    blob
  })

  const item: SavedGeneratedAudioItem = {
    id: crypto.randomUUID(),
    fileId,
    name,
    description: input.description,
    liked: input.liked,
    createdAt,
    voiceId: input.voiceId,
    voiceName: input.voiceName,
    modelId: input.modelId,
    source: input.source,
    historyItemId: input.historyItemId
  }
  savedAudioItems.value = [item, ...savedAudioItems.value]
  if (projects.value[0]) {
    projectTargetByAudio[item.id] = projects.value[0].id
  }
}

function toggleSavedAudioLike(itemId: string): void {
  savedAudioItems.value = savedAudioItems.value.map(item => (item.id === itemId
    ? { ...item, liked: !item.liked }
    : item))
}

function updateSavedAudioDescription(itemId: string, description: string): void {
  savedAudioItems.value = savedAudioItems.value.map(item => (item.id === itemId
    ? { ...item, description }
    : item))
}

async function importSavedAudioToProject(item: SavedGeneratedAudioItem): Promise<void> {
  const targetProjectId = projectTargetByAudio[item.id]
  if (!targetProjectId) {
    statusMessage.value = 'Select a target project first.'
    return
  }

  isImportingAudio.value = true
  try {
    const [project, fileRecord] = await Promise.all([
      getProject(targetProjectId),
      getFile(item.fileId)
    ])
    if (!project) {
      statusMessage.value = 'Could not find the selected project.'
      return
    }
    if (!fileRecord) {
      statusMessage.value = 'Could not find saved audio blob.'
      return
    }

    const duration = await getAudioDuration(fileRecord.blob)
    const clips = Array.isArray(project.clips) ? project.clips : []
    const start = getAudioTrackEnd(clips)
    const clip: StoredClip = {
      id: crypto.randomUUID(),
      fileId: item.fileId,
      name: item.description.trim() || item.name,
      kind: 'audio',
      start,
      duration,
      sourceOffset: 0,
      sourceDuration: duration,
      volume: 1,
      muted: false,
      previousVolume: 1
    }

    const nextProject: StoredProject = {
      ...project,
      updatedAt: Date.now(),
      clips: [...clips, clip]
    }
    await putProject(nextProject)
    statusMessage.value = `Imported audio into project "${project.name}".`
    await loadProjects()
  } catch (error) {
    statusMessage.value = `Could not import audio to project: ${String(error)}`
  } finally {
    isImportingAudio.value = false
  }
}

async function getAudioDuration(blob: Blob): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const element = document.createElement('audio')
    const url = URL.createObjectURL(blob)
    element.preload = 'metadata'
    element.src = url
    element.onloadedmetadata = () => {
      const duration = Number.isFinite(element.duration) ? Math.max(0.2, element.duration) : 3
      URL.revokeObjectURL(url)
      element.removeAttribute('src')
      element.load()
      resolve(duration)
    }
    element.onerror = () => {
      URL.revokeObjectURL(url)
      element.removeAttribute('src')
      element.load()
      reject(new Error('Unable to read saved audio duration'))
    }
  })
}

function getAudioTrackEnd(clips: StoredClip[]): number {
  const audioClips = clips.filter(clip => clip.kind === 'audio')
  if (!audioClips.length) {
    return 0
  }
  return Math.max(...audioClips.map(clip => clip.start + clip.duration))
}

function getVoiceNameById(id: string): string {
  const voice = voices.value.find(item => item.voice_id === id)
  return voice?.name ?? id
}

async function ensureHistoryAudioUrl(itemId: string): Promise<string> {
  const existing = historyAudioByItem.get(itemId)
  if (existing) {
    return existing
  }

  const response = await $fetch.raw(`/api/elevenlabs/history-audio/${encodeURIComponent(itemId)}`, {
    responseType: 'blob'
  })
  const contentType = response.headers.get('content-type') ?? 'audio/mpeg'
  const url = URL.createObjectURL(toAudioBlob(response._data, contentType))
  historyAudioByItem.set(itemId, url)
  return url
}

async function playHistoryItem(itemId: string): Promise<void> {
  isLoadingHistoryAudio.value = true
  try {
    const url = await ensureHistoryAudioUrl(itemId)
    activeHistoryItemId.value = itemId
    activeHistoryAudioUrl.value = url
  } catch (error) {
    statusMessage.value = `Could not load history audio: ${String(error)}`
  } finally {
    isLoadingHistoryAudio.value = false
  }
}

async function downloadHistoryItem(itemId: string): Promise<void> {
  isLoadingHistoryAudio.value = true
  try {
    const url = await ensureHistoryAudioUrl(itemId)
    downloadBlobUrl(url, `elevenlabs-history-${itemId}.mp3`)
  } catch (error) {
    statusMessage.value = `Could not download history audio: ${String(error)}`
  } finally {
    isLoadingHistoryAudio.value = false
  }
}

function formatHistoryDate(unixSeconds?: number): string {
  if (!Number.isFinite(unixSeconds)) {
    return 'Unknown date'
  }
  return new Date(Number(unixSeconds) * 1000).toLocaleString()
}

function formatCharacterCount(item: ElevenLabsHistoryItem): string {
  const from = item.character_count_change_from
  const to = item.character_count_change_to
  if (Number.isFinite(from) && Number.isFinite(to)) {
    return String(Math.max(0, Number(to) - Number(from)))
  }
  return 'n/a'
}

function getMinDateUnix(filter: 'all' | '24h' | '7d' | '30d' | '90d', nowUnix: number): number | null {
  if (filter === '24h') {
    return nowUnix - (24 * 60 * 60)
  }
  if (filter === '7d') {
    return nowUnix - (7 * 24 * 60 * 60)
  }
  if (filter === '30d') {
    return nowUnix - (30 * 24 * 60 * 60)
  }
  if (filter === '90d') {
    return nowUnix - (90 * 24 * 60 * 60)
  }
  return null
}

function reuseHistoryItem(item: ElevenLabsHistoryItem): void {
  if (item.text?.trim()) {
    text.value = item.text.trim()
  }
  if (item.voice_id?.trim()) {
    voiceId.value = item.voice_id.trim()
  }
  const modelFromHistory = item.model_id || item.request?.model_id
  if (modelFromHistory?.trim()) {
    modelId.value = modelFromHistory.trim()
  }

  const settings = getHistoryVoiceSettings(item)
  if (settings) {
    if (Number.isFinite(settings.stability)) {
      stability.value = normalizeBetween(settings.stability, stability.value)
    }
    if (Number.isFinite(settings.similarity_boost)) {
      similarityBoost.value = normalizeBetween(settings.similarity_boost, similarityBoost.value)
    }
    if (Number.isFinite(settings.style)) {
      style.value = normalizeBetween(settings.style, style.value)
    }
    if (typeof settings.use_speaker_boost === 'boolean') {
      useSpeakerBoost.value = settings.use_speaker_boost
    }
    if (Number.isFinite(settings.speed)) {
      speed.value = normalizeSpeed(settings.speed, speed.value)
    }
  }

  statusMessage.value = `Loaded history item ${item.history_item_id} into generation form.`
}

function getHistoryVoiceSettings(item: ElevenLabsHistoryItem): ElevenLabsHistoryItem['voice_settings'] | null {
  if (item.voice_settings) {
    return item.voice_settings
  }
  if (item.settings) {
    return item.settings
  }
  if (item.request?.voice_settings) {
    return item.request.voice_settings
  }
  return null
}

function toAudioBlob(data: unknown, mimeType: string): Blob {
  if (data instanceof Blob) {
    return data
  }
  if (data instanceof ArrayBuffer) {
    return new Blob([data], { type: mimeType })
  }
  if (ArrayBuffer.isView(data)) {
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    const arrayBuffer = bytes.slice().buffer
    return new Blob([arrayBuffer], { type: mimeType })
  }
  if (isBufferJsonPayload(data)) {
    return new Blob([new Uint8Array(data.data)], { type: mimeType })
  }
  throw new Error('Unexpected audio response payload.')
}

function isBufferJsonPayload(value: unknown): value is BufferJsonPayload {
  if (!value || typeof value !== 'object') {
    return false
  }
  const candidate = value as Partial<BufferJsonPayload>
  return candidate.type === 'Buffer' && Array.isArray(candidate.data)
}
</script>

<template>
  <div class="editor-page elevenlabs-page">
    <header class="editor-header">
      <div>
        <h1>ElevenLabs Speech Generation</h1>
        <p>Generate speech with all your ElevenLabs settings and view full generation history.</p>
      </div>
      <div class="header-actions">
        <NuxtLink class="btn" to="/">
          Back to Projects
        </NuxtLink>
      </div>
    </header>

    <nav class="projects-tabs" aria-label="Projects screens">
      <NuxtLink class="projects-tab" to="/">
        Projects
      </NuxtLink>
      <span class="projects-tab is-active">ElevenLabs Speech</span>
    </nav>

    <section class="status-row">
      <span>{{ statusMessage }}</span>
      <span>History items: {{ filteredHistoryItems.length }} / {{ historyItems.length }}</span>
    </section>

    <section class="elevenlabs-layout">
      <article class="inspector-panel">
        <h2>Generate Speech</h2>
        <p>Use text first, then pick voice/model and tuning settings.</p>

        <div class="inspector-form">
          <label>
            Text
            <textarea
              v-model="text"
              rows="6"
              placeholder="Type text to synthesize..."
            />
          </label>
          <div class="elevenlabs-inline-actions">
            <button class="btn" :disabled="isLoadingVoices" @click="loadVoices">
              {{ isLoadingVoices ? 'Loading Voices...' : 'Load Voices' }}
            </button>
            <button class="btn" :disabled="isLoadingHistory" @click="loadHistory">
              {{ isLoadingHistory ? 'Loading History...' : 'Refresh History' }}
            </button>
          </div>
          <div class="elevenlabs-inline-actions">
            <button class="btn btn-primary" :disabled="!canGenerate || isGenerating" @click="generateSpeech">
              {{ isGenerating ? 'Generating...' : 'Generate Speech' }}
            </button>
            <button class="btn" :disabled="!generatedAudioUrl" @click="downloadGeneratedAudio">
              Download Latest Audio
            </button>
            <button class="btn" :disabled="!generatedAudioUrl || isSavingAudio" @click="saveGeneratedAudioToLibrary">
              {{ isSavingAudio ? 'Saving...' : 'Save To Library' }}
            </button>
          </div>
          <div class="voice-bottom-row">
            <label class="switch-row">
              <span>Like this generated audio</span>
              <input v-model="generatedAudioLiked" type="checkbox">
            </label>
            <label class="library-description-field">
              Description
              <input
                v-model="generatedAudioDescription"
                type="text"
                placeholder="Add a description before saving"
              >
            </label>
          </div>
          <audio v-if="generatedAudioUrl" class="elevenlabs-audio" :src="generatedAudioUrl" controls />

          <label>
            Voice
            <select v-model="voiceId">
              <option value="">
                Select a voice
              </option>
              <optgroup
                v-for="group in groupedVoices"
                :key="group.category"
                :label="`${group.category} (${group.items.length})`"
              >
                <option
                  v-for="voice in group.items"
                  :key="voice.voice_id"
                  :value="voice.voice_id"
                >
                  {{ voice.name }}
                </option>
              </optgroup>
            </select>
          </label>
          <div class="voice-slider-group">
            <div class="voice-slider-title-row">
              <strong>Speed</strong>
              <small>{{ asSliderValue(speed) }}</small>
            </div>
            <div class="voice-slider-label-row">
              <span>Slower</span>
              <span>Faster</span>
            </div>
            <input
              v-model.number="speed"
              class="voice-slider-input"
              type="range"
              min="0.7"
              max="2"
              step="0.01"
            >
          </div>
          <div class="voice-slider-group">
            <div class="voice-slider-title-row">
              <strong>Stability</strong>
              <small>{{ asSliderValue(stability) }}</small>
            </div>
            <div class="voice-slider-label-row">
              <span>More variable</span>
              <span>More stable</span>
            </div>
            <input
              v-model.number="stability"
              class="voice-slider-input"
              type="range"
              min="0"
              max="1"
              step="0.01"
            >
          </div>
          <div class="voice-slider-group">
            <div class="voice-slider-title-row">
              <strong>Similarity</strong>
              <small>{{ asSliderValue(similarityBoost) }}</small>
            </div>
            <div class="voice-slider-label-row">
              <span>Low</span>
              <span>High</span>
            </div>
            <input
              v-model.number="similarityBoost"
              class="voice-slider-input"
              type="range"
              min="0"
              max="1"
              step="0.01"
            >
          </div>
          <div class="voice-slider-group">
            <div class="voice-slider-title-row">
              <strong>Style Exaggeration</strong>
              <small>{{ asSliderValue(style) }}</small>
            </div>
            <div class="voice-slider-label-row">
              <span>None</span>
              <span>Exaggerated</span>
            </div>
            <input
              v-model.number="style"
              class="voice-slider-input"
              type="range"
              min="0"
              max="1"
              step="0.01"
            >
          </div>
          <label class="switch-row">
            <span>Language Override</span>
            <input v-model="languageOverrideEnabled" type="checkbox">
          </label>
          <label v-if="languageOverrideEnabled">
            Language Code
            <input
              v-model="languageCode"
              type="text"
              placeholder="en"
            >
          </label>
          <div class="voice-bottom-row">
            <label class="switch-row">
              <span>Speaker Boost</span>
              <input v-model="useSpeakerBoost" type="checkbox">
            </label>
          </div>
          <label>
            Voice ID (manual override)
            <input
              v-model="voiceId"
              type="text"
              placeholder="Voice ID"
            >
          </label>
          <label>
            Model ID
            <input
              v-model="modelId"
              type="text"
              placeholder="eleven_multilingual_v2"
            >
          </label>
          <label>
            Output Format
            <input
              v-model="outputFormat"
              type="text"
              placeholder="mp3_44100_128"
            >
          </label>
          <label>
            Seed (optional)
            <input
              v-model="seed"
              type="number"
              placeholder="123"
            >
          </label>
          <label>
            Previous Text (optional)
            <textarea
              v-model="previousText"
              rows="2"
              placeholder="Context before this generation"
            />
          </label>
          <label>
            Next Text (optional)
            <textarea
              v-model="nextText"
              rows="2"
              placeholder="Context after this generation"
            />
          </label>
          <div class="voice-reset-row">
            <button class="btn" type="button" @click="resetVoiceSettings">
              Reset values
            </button>
          </div>
        </div>
      </article>

      <article class="inspector-panel">
        <h2>Generation History</h2>
        <p>All available history items from your ElevenLabs account are listed here.</p>
        <div class="elevenlabs-history-filters">
          <label>
            Search
            <input
              v-model="historySearchText"
              type="text"
              placeholder="Search text, voice, model..."
            >
          </label>
          <label>
            Voice
            <select v-model="historyVoiceFilter">
              <option value="">
                All voices
              </option>
              <option
                v-for="option in historyVoiceFilterOptions"
                :key="option.value"
                :value="option.value"
              >
                {{ option.label }}
              </option>
            </select>
          </label>
          <label>
            Date range
            <select v-model="historyDateFilter">
              <option value="all">
                All time
              </option>
              <option value="24h">
                Last 24 hours
              </option>
              <option value="7d">
                Last 7 days
              </option>
              <option value="30d">
                Last 30 days
              </option>
              <option value="90d">
                Last 90 days
              </option>
            </select>
          </label>
        </div>

        <div v-if="filteredHistoryItems.length" class="elevenlabs-history-list">
          <div v-for="item in filteredHistoryItems" :key="item.history_item_id" class="elevenlabs-history-item">
            <p class="elevenlabs-history-text">
              {{ item.text || 'No text available' }}
            </p>
            <p class="elevenlabs-history-meta">
              {{ formatHistoryDate(item.date_unix) }} • voice: {{ item.voice_name || item.voice_id || 'n/a' }} • model: {{ item.model_id || 'n/a' }} • chars: {{ formatCharacterCount(item) }}
            </p>
            <div class="elevenlabs-inline-actions">
              <button class="btn" :disabled="isLoadingHistoryAudio" @click="playHistoryItem(item.history_item_id)">
                {{ activeHistoryItemId === item.history_item_id ? 'Reload Audio' : 'Play Audio' }}
              </button>
              <button class="btn" :disabled="isLoadingHistoryAudio" @click="downloadHistoryItem(item.history_item_id)">
                Download
              </button>
              <button class="btn" :disabled="isSavingAudio" @click="saveHistoryItemToLibrary(item)">
                Save To Library
              </button>
              <button class="btn" @click="reuseHistoryItem(item)">
                Reuse In Generator
              </button>
            </div>
            <audio
              v-if="activeHistoryItemId === item.history_item_id && activeHistoryAudioUrl"
              class="elevenlabs-audio"
              :src="activeHistoryAudioUrl"
              controls
            />
          </div>
        </div>
        <p v-else class="projects-empty">
          No history matches the current filters.
        </p>
      </article>

      <article class="inspector-panel elevenlabs-library-panel">
        <h2>Saved Audio Library</h2>
        <p>Attach like/description and import these audios into any project.</p>
        <div v-if="savedAudioItems.length" class="elevenlabs-library-list">
          <div v-for="item in savedAudioItems" :key="item.id" class="elevenlabs-library-item">
            <p class="elevenlabs-history-meta">
              {{ formatHistoryDate(Math.floor(item.createdAt / 1000)) }} • {{ item.voiceName || item.voiceId || 'Unknown voice' }} • {{ item.modelId || 'Unknown model' }}
            </p>
            <label class="library-description-field">
              Description
              <input
                :value="item.description"
                type="text"
                placeholder="Add description"
                @input="updateSavedAudioDescription(item.id, ($event.target as HTMLInputElement).value)"
              >
            </label>
            <div class="voice-bottom-row">
              <label class="switch-row">
                <span>Liked</span>
                <input :checked="item.liked" type="checkbox" @change="toggleSavedAudioLike(item.id)">
              </label>
              <label>
                Import to project
                <select v-model="projectTargetByAudio[item.id]">
                  <option value="">
                    Select project
                  </option>
                  <option v-for="project in projects" :key="project.id" :value="project.id">
                    {{ project.name }}
                  </option>
                </select>
              </label>
              <button class="btn" :disabled="isImportingAudio" @click="importSavedAudioToProject(item)">
                {{ isImportingAudio ? 'Importing...' : 'Import Audio' }}
              </button>
            </div>
          </div>
        </div>
        <p v-else class="projects-empty">
          No saved audios yet. Save generated or history audio to build your library.
        </p>
      </article>
    </section>
  </div>
</template>
