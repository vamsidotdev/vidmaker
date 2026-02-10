<script setup lang="ts">
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

interface Clip extends StoredClip {
  url: string
}

interface CaptionCue {
  id: string
  start: number
  end: number
  text: string
}

interface OverlayItem {
  id: string
  kind: 'title' | 'sticker'
  text: string
  start: number
  duration: number
  x: number
  y: number
  size: number
  color: string
  bg: string
}

interface StoredProject {
  id: 'default'
  updatedAt: number
  clips: StoredClip[]
  captions: CaptionCue[]
  overlays: OverlayItem[]
  captionStyleId: CaptionStyleId
  captionPositionX: number
  captionPositionY: number
  captionSizePercent: number
  captionLetterCase: CaptionLetterCase
}

interface AsrChunk {
  text?: string
  timestamp?: [number, number]
}

interface AsrResult {
  text?: string
  chunks?: AsrChunk[]
}

type CaptionModel = (input: string, options: Record<string, unknown>) => Promise<AsrResult>
type CaptionStyleId = 'capcut' | 'minimal' | 'neon' | 'classic'
type CaptionLetterCase = 'original' | 'uppercase' | 'lowercase' | 'capitalize'

interface DragState {
  clipId: string
  mode: 'move' | 'trim-left' | 'trim-right'
  pointerStartX: number
  initialStart: number
  initialDuration: number
  initialSourceOffset: number
}

interface CaptionStyleConfig {
  label: string
  font: string
  fill: string
  stroke: string
  strokeWidth: number
  shadow: string
}

interface CaptionWindowCue extends CaptionCue {
  isActive: boolean
  activeProgress: number
}

const DB_NAME = 'vidmaker-db'
const DB_VERSION = 1
const FILES_STORE = 'files'
const PROJECTS_STORE = 'projects'
const PROJECT_KEY = 'default'
const IMAGE_DEFAULT_DURATION = 3
const PX_PER_SECOND = 60
const MIN_CLIP_DURATION = 0.2
const CAPTION_WINDOW_WORD_COUNT = 3
const CAPTION_HIGHLIGHT_COLOR = '#FACC15'
const CAPTION_JUMP_MAX_PX = 16
const CAPTION_SIZE_MIN = 50
const CAPTION_SIZE_MAX = 220

const filePicker = ref<HTMLInputElement | null>(null)
const currentTime = ref(0)
const isPlaying = ref(false)
const clips = ref<Clip[]>([])
const captions = ref<CaptionCue[]>([])
const overlays = ref<OverlayItem[]>([])
const selectedClipId = ref<string | null>(null)
const selectedOverlayId = ref<string | null>(null)
const captionStyleId = ref<CaptionStyleId>('capcut')
const captionPositionX = ref(50)
const captionPositionY = ref(88)
const captionSizePercent = ref(100)
const captionLetterCase = ref<CaptionLetterCase>('uppercase')
const statusMessage = ref('Import videos, photos and audio to start editing.')
const draftSavedAt = ref<number | null>(null)
const isExportingMp4 = ref(false)
const mp4Stage = ref<'idle' | 'load' | 'render' | 'convert'>('idle')
const exportProgress = ref(0)
const mp4Progress = ref(0)
const isGeneratingCaptions = ref(false)
const captionsProgress = ref(0)

const createdUrls = new Set<string>()
const visualVideoRefs = new Map<string, HTMLVideoElement>()
const audioRefs = new Map<string, HTMLAudioElement>()

let dbPromise: Promise<IDBDatabase> | null = null
let playbackRaf = 0
let playbackLastTimestamp = 0
let draftSaveTimeout: ReturnType<typeof setTimeout> | null = null
let captionsModel: CaptionModel | null = null
let hasRestoredDraft = false
const dragState = ref<DragState | null>(null)

const captionStyleOptions = [
  { label: 'CapCut Punch', value: 'capcut' },
  { label: 'Minimal', value: 'minimal' },
  { label: 'Neon', value: 'neon' },
  { label: 'Classic', value: 'classic' }
]

const captionLetterCaseOptions = [
  { label: 'UPPERCASE', value: 'uppercase' },
  { label: 'lowercase', value: 'lowercase' },
  { label: 'Capitalize', value: 'capitalize' },
  { label: 'Original', value: 'original' }
]

const captionStyleConfig: Record<CaptionStyleId, CaptionStyleConfig> = {
  capcut: {
    label: 'CapCut Punch',
    font: 'bold 56px sans-serif',
    fill: '#FFFFFF',
    stroke: 'rgba(0, 0, 0, 0.85)',
    strokeWidth: 12,
    shadow: '0 4px 10px rgba(0, 0, 0, 0.95)'
  },
  minimal: {
    label: 'Minimal',
    font: '500 44px sans-serif',
    fill: '#FAFAFA',
    stroke: 'rgba(0, 0, 0, 0.5)',
    strokeWidth: 8,
    shadow: 'none'
  },
  neon: {
    label: 'Neon',
    font: 'bold 56px sans-serif',
    fill: '#00F5FF',
    stroke: 'rgba(0, 0, 0, 0.95)',
    strokeWidth: 10,
    shadow: '0 0 12px rgba(0, 245, 255, 0.9)'
  },
  classic: {
    label: 'Classic',
    font: '600 52px serif',
    fill: '#FFF8DC',
    stroke: 'rgba(36, 24, 0, 0.85)',
    strokeWidth: 10,
    shadow: '0 3px 8px rgba(0, 0, 0, 0.7)'
  }
}

const visualClips = computed(() => clips.value
  .filter(clip => clip.kind === 'video' || clip.kind === 'image')
  .slice()
  .sort((a, b) => a.start - b.start))

const audioClips = computed(() => clips.value
  .filter(clip => clip.kind === 'audio')
  .slice()
  .sort((a, b) => a.start - b.start))

const activeOverlays = computed(() => overlays.value
  .filter(item => inRange(currentTime.value, item.start, item.duration))
  .slice()
  .sort((a, b) => a.start - b.start))

const projectDuration = computed(() => {
  const clipEnd = clips.value.length
    ? Math.max(...clips.value.map(clip => clip.start + clip.duration))
    : 0
  const overlayEnd = overlays.value.length
    ? Math.max(...overlays.value.map(item => item.start + item.duration))
    : 0
  return Math.max(clipEnd, overlayEnd)
})

const timelineWidth = computed(() => Math.max(900, Math.ceil(projectDuration.value * PX_PER_SECOND)))
const playbackPercent = computed(() => projectDuration.value ? (currentTime.value / projectDuration.value) * 100 : 0)
const activeVisualClip = computed(() => visualClips.value.find(clip => inRange(currentTime.value, clip.start, clip.duration)) ?? null)
const activeCaptionWindow = computed(() => getCaptionWindowForTime(currentTime.value))
const selectedClip = computed(() => selectedClipId.value ? clips.value.find(clip => clip.id === selectedClipId.value) ?? null : null)
const selectedOverlay = computed(() => selectedOverlayId.value ? overlays.value.find(item => item.id === selectedOverlayId.value) ?? null : null)

watch(
  [clips, captions, overlays, captionStyleId, captionPositionX, captionPositionY, captionSizePercent, captionLetterCase],
  () => {
    if (!hasRestoredDraft) {
      return
    }

    queueDraftSave()
  },
  { deep: true }
)

onMounted(async () => {
  await restoreDraft()
  syncPreviewMedia(true)
  window.addEventListener('pointermove', onPointerMove)
  window.addEventListener('pointerup', onPointerUp)
})

onBeforeUnmount(() => {
  stopPlayback()
  clearDraftSaveTimeout()
  createdUrls.forEach(url => URL.revokeObjectURL(url))
  createdUrls.clear()
  window.removeEventListener('pointermove', onPointerMove)
  window.removeEventListener('pointerup', onPointerUp)
})

function inRange(time: number, start: number, duration: number): boolean {
  return time >= start && time < start + duration
}

function toStepTime(value: number): number {
  return Math.round(value * 20) / 20
}

function clampPercent(value: number, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback
  }
  return Math.min(100, Math.max(0, value))
}

function clampCaptionSizePercent(value: number, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback
  }
  return Math.min(CAPTION_SIZE_MAX, Math.max(CAPTION_SIZE_MIN, Math.round(value)))
}

function parseCaptionLetterCase(value: unknown): CaptionLetterCase {
  if (value === 'original' || value === 'uppercase' || value === 'lowercase' || value === 'capitalize') {
    return value
  }
  return 'uppercase'
}

function getCaptionScaleFactor(): number {
  return clampCaptionSizePercent(captionSizePercent.value, 100) / 100
}

function scaleFontSize(font: string, scale: number): string {
  return font.replace(/(\d+(?:\.\d+)?)px/, (_, rawSize: string) => {
    const next = Math.max(10, Math.round(Number(rawSize) * scale))
    return `${next}px`
  })
}

function toCapitalizedWord(word: string): string {
  if (!word) {
    return word
  }
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
}

function applyCaptionLetterCase(text: string): string {
  if (captionLetterCase.value === 'original') {
    return text
  }
  if (captionLetterCase.value === 'uppercase') {
    return text.toUpperCase()
  }
  if (captionLetterCase.value === 'lowercase') {
    return text.toLowerCase()
  }
  return text.split(' ').map(toCapitalizedWord).join(' ')
}

function getCaptionTextTransform(): string {
  if (captionLetterCase.value === 'uppercase') {
    return 'uppercase'
  }
  if (captionLetterCase.value === 'lowercase') {
    return 'lowercase'
  }
  if (captionLetterCase.value === 'capitalize') {
    return 'capitalize'
  }
  return 'none'
}

function openPicker(): void {
  filePicker.value?.click()
}

function clearDraftSaveTimeout(): void {
  if (draftSaveTimeout) {
    clearTimeout(draftSaveTimeout)
    draftSaveTimeout = null
  }
}

function queueDraftSave(): void {
  clearDraftSaveTimeout()
  draftSaveTimeout = setTimeout(() => {
    void saveDraft()
  }, 320)
}

function createUrl(blob: Blob): string {
  const url = URL.createObjectURL(blob)
  createdUrls.add(url)
  return url
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
      request.onerror = () => reject(request.error)
    })
  }

  return dbPromise
}

async function putFile(record: StoredFileRecord): Promise<void> {
  const database = await openDatabase()
  await new Promise<void>((resolve, reject) => {
    const tx = database.transaction(FILES_STORE, 'readwrite')
    tx.objectStore(FILES_STORE).put(record)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

async function getFile(fileId: string): Promise<StoredFileRecord | null> {
  const database = await openDatabase()
  return await new Promise<StoredFileRecord | null>((resolve, reject) => {
    const tx = database.transaction(FILES_STORE, 'readonly')
    const request = tx.objectStore(FILES_STORE).get(fileId)
    request.onsuccess = () => resolve((request.result as StoredFileRecord | undefined) ?? null)
    request.onerror = () => reject(request.error)
  })
}

async function putProject(project: StoredProject): Promise<void> {
  const database = await openDatabase()
  await new Promise<void>((resolve, reject) => {
    const tx = database.transaction(PROJECTS_STORE, 'readwrite')
    tx.objectStore(PROJECTS_STORE).put(project)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

async function getProject(): Promise<StoredProject | null> {
  const database = await openDatabase()
  return await new Promise<StoredProject | null>((resolve, reject) => {
    const tx = database.transaction(PROJECTS_STORE, 'readonly')
    const request = tx.objectStore(PROJECTS_STORE).get(PROJECT_KEY)
    request.onsuccess = () => resolve((request.result as StoredProject | undefined) ?? null)
    request.onerror = () => reject(request.error)
  })
}

async function restoreDraft(): Promise<void> {
  if (!import.meta.client) {
    return
  }

  try {
    const project = await getProject()

    if (!project) {
      hasRestoredDraft = true
      return
    }

    const restored: Clip[] = []

    for (const storedClip of project.clips) {
      const fileRecord = await getFile(storedClip.fileId)
      if (!fileRecord) {
        continue
      }

      restored.push({
        ...storedClip,
        sourceOffset: Number.isFinite(storedClip.sourceOffset) ? storedClip.sourceOffset : 0,
        sourceDuration: Number.isFinite(storedClip.sourceDuration) ? storedClip.sourceDuration : storedClip.duration,
        muted: Boolean(storedClip.muted),
        previousVolume: Number.isFinite(storedClip.previousVolume) ? storedClip.previousVolume : 1,
        url: createUrl(fileRecord.blob)
      })
    }

    clips.value = restored
    captions.value = normalizeStoredCaptionCues(Array.isArray(project.captions) ? project.captions : [])
    overlays.value = Array.isArray(project.overlays) ? project.overlays : []
    captionStyleId.value = project.captionStyleId ?? 'capcut'
    captionPositionX.value = clampPercent(project.captionPositionX ?? 50, 50)
    captionPositionY.value = clampPercent(project.captionPositionY ?? 88, 88)
    captionSizePercent.value = clampCaptionSizePercent(project.captionSizePercent ?? 100, 100)
    captionLetterCase.value = parseCaptionLetterCase(project.captionLetterCase)
    draftSavedAt.value = project.updatedAt
    hasRestoredDraft = true
    statusMessage.value = restored.length || overlays.value.length
      ? 'Restored your last draft from local storage.'
      : 'Draft restored but no media files were available.'
  } catch (error) {
    hasRestoredDraft = true
    statusMessage.value = `Could not restore draft: ${String(error)}`
  }
}

async function saveDraft(): Promise<void> {
  if (!import.meta.client || !hasRestoredDraft) {
    return
  }

  const payload: StoredProject = {
    id: PROJECT_KEY,
    updatedAt: Date.now(),
    clips: clips.value.map(({ id, fileId, name, kind, start, duration, sourceOffset, sourceDuration, volume, muted, previousVolume }) => ({
      id,
      fileId,
      name,
      kind,
      start,
      duration,
      sourceOffset,
      sourceDuration,
      volume,
      muted,
      previousVolume
    })),
    captions: captions.value.map(caption => ({
      id: caption.id,
      start: caption.start,
      end: caption.end,
      text: caption.text
    })),
    overlays: overlays.value.map(item => ({
      id: item.id,
      kind: item.kind,
      text: item.text,
      start: item.start,
      duration: item.duration,
      x: item.x,
      y: item.y,
      size: item.size,
      color: item.color,
      bg: item.bg
    })),
    captionStyleId: captionStyleId.value,
    captionPositionX: clampPercent(captionPositionX.value, 50),
    captionPositionY: clampPercent(captionPositionY.value, 88),
    captionSizePercent: clampCaptionSizePercent(captionSizePercent.value, 100),
    captionLetterCase: parseCaptionLetterCase(captionLetterCase.value)
  }

  await putProject(payload)
  draftSavedAt.value = payload.updatedAt
}

async function getMediaDuration(url: string, kind: 'video' | 'audio'): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const element = kind === 'video' ? document.createElement('video') : document.createElement('audio')
    element.preload = 'metadata'
    element.src = url
    element.onloadedmetadata = () => {
      resolve(Number.isFinite(element.duration) ? element.duration : 0)
      element.removeAttribute('src')
      element.load()
    }
    element.onerror = () => {
      reject(new Error(`Unable to read ${kind} duration`))
      element.removeAttribute('src')
      element.load()
    }
  })
}

function getTrackEnd(kind: 'video' | 'image' | 'audio'): number {
  const selected = clips.value.filter((clip) => {
    if (kind === 'audio') {
      return clip.kind === 'audio'
    }

    return clip.kind === 'video' || clip.kind === 'image'
  })

  if (!selected.length) {
    return 0
  }

  return Math.max(...selected.map(clip => clip.start + clip.duration))
}

async function importMedia(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const selectedFiles = Array.from(input.files ?? [])

  if (!selectedFiles.length) {
    return
  }

  statusMessage.value = 'Importing media files...'

  for (const file of selectedFiles) {
    const fileId = crypto.randomUUID()
    const url = createUrl(file)
    let kind: Clip['kind'] | null = null
    let duration = 0

    if (file.type.startsWith('video/')) {
      kind = 'video'
      duration = await getMediaDuration(url, 'video')
    } else if (file.type.startsWith('image/')) {
      kind = 'image'
      duration = IMAGE_DEFAULT_DURATION
    } else if (file.type.startsWith('audio/')) {
      kind = 'audio'
      duration = await getMediaDuration(url, 'audio')
    }

    if (!kind) {
      continue
    }

    const safeDuration = Math.max(MIN_CLIP_DURATION, duration || IMAGE_DEFAULT_DURATION)

    await putFile({
      id: fileId,
      name: file.name,
      type: file.type,
      blob: file
    })

    clips.value.push({
      id: crypto.randomUUID(),
      fileId,
      name: file.name,
      kind,
      start: getTrackEnd(kind),
      duration: safeDuration,
      sourceDuration: safeDuration,
      sourceOffset: 0,
      volume: 1,
      muted: false,
      previousVolume: 1,
      url
    })
  }

  input.value = ''
  statusMessage.value = `Imported ${selectedFiles.length} file(s).`
  await saveDraft()
  syncPreviewMedia(true)
}

function setVisualVideoRef(id: string) {
  return (element: Element | ComponentPublicInstance | null): void => {
    if (element && '$el' in element) {
      return
    }

    if (element instanceof HTMLVideoElement) {
      visualVideoRefs.set(id, element)
    } else {
      visualVideoRefs.delete(id)
    }
  }
}

function setAudioRef(id: string) {
  return (element: Element | ComponentPublicInstance | null): void => {
    if (element && '$el' in element) {
      return
    }

    if (element instanceof HTMLAudioElement) {
      audioRefs.set(id, element)
    } else {
      audioRefs.delete(id)
    }
  }
}

function safePlay(element: HTMLMediaElement): void {
  const promise = element.play()
  if (promise) {
    promise.catch(() => {})
  }
}

function getOutputVolume(clip: Clip): number {
  if (clip.kind === 'video' && clip.muted) {
    return 0
  }

  return clip.volume
}

function syncPreviewMedia(forceSeek = false): void {
  const timelineTime = currentTime.value

  for (const clip of visualClips.value) {
    if (clip.kind !== 'video') {
      continue
    }

    const element = visualVideoRefs.get(clip.id)
    if (!element) {
      continue
    }

    element.volume = getOutputVolume(clip)

    if (inRange(timelineTime, clip.start, clip.duration)) {
      const localTime = timelineTime - clip.start + clip.sourceOffset

      if (forceSeek || Math.abs(element.currentTime - localTime) > 0.2) {
        element.currentTime = localTime
      }

      if (isPlaying.value) {
        safePlay(element)
      } else {
        element.pause()
      }
    } else {
      element.pause()
    }
  }

  for (const clip of audioClips.value) {
    const element = audioRefs.get(clip.id)
    if (!element) {
      continue
    }

    element.volume = getOutputVolume(clip)

    if (inRange(timelineTime, clip.start, clip.duration)) {
      const localTime = timelineTime - clip.start + clip.sourceOffset

      if (forceSeek || Math.abs(element.currentTime - localTime) > 0.2) {
        element.currentTime = localTime
      }

      if (isPlaying.value) {
        safePlay(element)
      } else {
        element.pause()
      }
    } else {
      element.pause()
    }
  }
}

function stopPlayback(): void {
  isPlaying.value = false
  playbackLastTimestamp = 0
  cancelAnimationFrame(playbackRaf)
  syncPreviewMedia(true)
}

function stepPlayback(timestamp: number): void {
  if (!isPlaying.value) {
    return
  }

  if (!playbackLastTimestamp) {
    playbackLastTimestamp = timestamp
  }

  const delta = (timestamp - playbackLastTimestamp) / 1000
  playbackLastTimestamp = timestamp
  currentTime.value = Math.min(projectDuration.value, currentTime.value + delta)

  if (currentTime.value >= projectDuration.value) {
    stopPlayback()
    return
  }

  syncPreviewMedia(false)
  playbackRaf = requestAnimationFrame(stepPlayback)
}

function togglePlayback(): void {
  if (!projectDuration.value) {
    return
  }

  if (isPlaying.value) {
    stopPlayback()
    return
  }

  isPlaying.value = true
  playbackLastTimestamp = 0
  syncPreviewMedia(true)
  playbackRaf = requestAnimationFrame(stepPlayback)
}

function seekTo(time: number): void {
  currentTime.value = Math.min(projectDuration.value, Math.max(0, time))
  syncPreviewMedia(true)
}

function seekBy(delta: number): void {
  seekTo(currentTime.value + delta)
}

function selectClip(id: string): void {
  selectedOverlayId.value = null
  selectedClipId.value = id
}

function selectOverlay(id: string): void {
  selectedClipId.value = null
  selectedOverlayId.value = id
}

function removeClip(clipId: string): void {
  if (selectedClipId.value === clipId) {
    selectedClipId.value = null
  }

  const index = clips.value.findIndex(clip => clip.id === clipId)
  if (index >= 0) {
    clips.value.splice(index, 1)
    statusMessage.value = 'Clip removed.'
  }

  syncPreviewMedia(true)
}

function removeOverlay(id: string): void {
  if (selectedOverlayId.value === id) {
    selectedOverlayId.value = null
  }

  const index = overlays.value.findIndex(item => item.id === id)
  if (index >= 0) {
    overlays.value.splice(index, 1)
    statusMessage.value = 'Overlay removed.'
  }
}

function updateSelectedClipField(field: 'start' | 'duration' | 'volume' | 'sourceOffset', value: string | number): void {
  if (!selectedClip.value) {
    return
  }

  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    return
  }

  if (field === 'start') {
    selectedClip.value.start = Math.max(0, parsed)
  } else if (field === 'duration') {
    const maxDuration = selectedClip.value.kind === 'image'
      ? Math.max(MIN_CLIP_DURATION, parsed)
      : Math.max(MIN_CLIP_DURATION, selectedClip.value.sourceDuration - selectedClip.value.sourceOffset)
    selectedClip.value.duration = Math.min(Math.max(MIN_CLIP_DURATION, parsed), maxDuration)
  } else if (field === 'sourceOffset') {
    if (selectedClip.value.kind === 'image') {
      selectedClip.value.sourceOffset = 0
      return
    }

    const nextOffset = Math.max(0, Math.min(parsed, selectedClip.value.sourceDuration - MIN_CLIP_DURATION))
    selectedClip.value.sourceOffset = nextOffset
    selectedClip.value.duration = Math.min(
      selectedClip.value.duration,
      Math.max(MIN_CLIP_DURATION, selectedClip.value.sourceDuration - selectedClip.value.sourceOffset)
    )
  } else {
    selectedClip.value.volume = Math.max(0, Math.min(2, parsed))
    if (selectedClip.value.kind === 'video') {
      selectedClip.value.muted = selectedClip.value.volume === 0
      if (selectedClip.value.volume > 0) {
        selectedClip.value.previousVolume = selectedClip.value.volume
      }
    }
  }

  syncPreviewMedia(true)
}

function toggleSelectedVideoMute(): void {
  if (!selectedClip.value || selectedClip.value.kind !== 'video') {
    return
  }

  if (selectedClip.value.muted) {
    selectedClip.value.muted = false
    if (selectedClip.value.volume <= 0) {
      selectedClip.value.volume = Math.max(0.1, selectedClip.value.previousVolume || 1)
    }
  } else {
    if (selectedClip.value.volume > 0) {
      selectedClip.value.previousVolume = selectedClip.value.volume
    }
    selectedClip.value.muted = true
  }

  syncPreviewMedia(true)
}

function updateSelectedOverlayField(field: keyof OverlayItem, value: string | number): void {
  if (!selectedOverlay.value) {
    return
  }

  if (field === 'text' || field === 'color' || field === 'bg') {
    selectedOverlay.value[field] = String(value)
    return
  }

  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    return
  }

  if (field === 'start') {
    selectedOverlay.value.start = Math.max(0, parsed)
  } else if (field === 'duration') {
    selectedOverlay.value.duration = Math.max(0.2, parsed)
  } else if (field === 'x' || field === 'y') {
    selectedOverlay.value[field] = Math.max(0, Math.min(100, parsed))
  } else if (field === 'size') {
    selectedOverlay.value.size = Math.max(16, Math.min(120, parsed))
  }
}

function startClipDrag(mode: DragState['mode'], clip: Clip, event: PointerEvent): void {
  if (event.button !== 0) {
    return
  }

  selectClip(clip.id)

  dragState.value = {
    clipId: clip.id,
    mode,
    pointerStartX: event.clientX,
    initialStart: clip.start,
    initialDuration: clip.duration,
    initialSourceOffset: clip.sourceOffset
  }
}

function onPointerMove(event: PointerEvent): void {
  if (!dragState.value) {
    return
  }

  const clip = clips.value.find(item => item.id === dragState.value?.clipId)
  if (!clip) {
    dragState.value = null
    return
  }

  const deltaSec = toStepTime((event.clientX - dragState.value.pointerStartX) / PX_PER_SECOND)

  if (dragState.value.mode === 'move') {
    clip.start = Math.max(0, toStepTime(dragState.value.initialStart + deltaSec))
    return
  }

  if (dragState.value.mode === 'trim-right') {
    const maxDur = clip.kind === 'image'
      ? 120
      : Math.max(MIN_CLIP_DURATION, clip.sourceDuration - clip.sourceOffset)
    clip.duration = Math.min(maxDur, Math.max(MIN_CLIP_DURATION, toStepTime(dragState.value.initialDuration + deltaSec)))
    return
  }

  if (clip.kind === 'image') {
    const nextStart = Math.max(0, toStepTime(dragState.value.initialStart + deltaSec))
    const startShift = nextStart - dragState.value.initialStart
    clip.start = nextStart
    clip.duration = Math.max(MIN_CLIP_DURATION, toStepTime(dragState.value.initialDuration - startShift))
    return
  }

  const nextOffset = Math.max(
    0,
    Math.min(
      dragState.value.initialSourceOffset + deltaSec,
      clip.sourceDuration - MIN_CLIP_DURATION
    )
  )
  const sourceDelta = nextOffset - dragState.value.initialSourceOffset
  clip.sourceOffset = toStepTime(nextOffset)
  clip.start = Math.max(0, toStepTime(dragState.value.initialStart + sourceDelta))
  clip.duration = Math.max(MIN_CLIP_DURATION, toStepTime(dragState.value.initialDuration - sourceDelta))
}

function onPointerUp(): void {
  if (!dragState.value) {
    return
  }

  dragState.value = null
  syncPreviewMedia(true)
}

function addTitle(): void {
  const item: OverlayItem = {
    id: crypto.randomUUID(),
    kind: 'title',
    text: 'Your title here',
    start: currentTime.value,
    duration: 2.5,
    x: 50,
    y: 20,
    size: 52,
    color: '#FFFFFF',
    bg: 'rgba(0,0,0,0.35)'
  }
  overlays.value.push(item)
  selectOverlay(item.id)
  statusMessage.value = 'Title overlay added.'
}

function addSticker(): void {
  const item: OverlayItem = {
    id: crypto.randomUUID(),
    kind: 'sticker',
    text: '🔥',
    start: currentTime.value,
    duration: 2.5,
    x: 78,
    y: 26,
    size: 72,
    color: '#FFFFFF',
    bg: 'transparent'
  }
  overlays.value.push(item)
  selectOverlay(item.id)
  statusMessage.value = 'Sticker overlay added.'
}

function formatTime(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds))
  const mins = Math.floor(whole / 60)
  const secs = whole % 60
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
}

function formatDateTime(timestamp: number | null): string {
  if (!timestamp) {
    return 'Not saved yet'
  }
  return new Date(timestamp).toLocaleString()
}

function getCaptionPreviewStyle(styleId: CaptionStyleId): Record<string, string> {
  const style = captionStyleConfig[styleId]
  const scale = getCaptionScaleFactor()
  return {
    color: style.fill,
    textShadow: style.shadow,
    WebkitTextStroke: `${Math.max(1, Math.floor((style.strokeWidth * scale) / 3))}px ${style.stroke}`,
    font: scaleFontSize(style.font, scale),
    textTransform: getCaptionTextTransform()
  }
}

function getCaptionPreviewPositionStyle(): Record<string, string> {
  return {
    left: `${captionPositionX.value}%`,
    top: `${captionPositionY.value}%`
  }
}

function getCaptionWindowForTime(time: number): CaptionWindowCue[] {
  const activeIndex = captions.value.findIndex(cue => inRange(time, cue.start, cue.end - cue.start))
  if (activeIndex < 0) {
    return []
  }

  const total = captions.value.length
  const start = Math.floor(activeIndex / CAPTION_WINDOW_WORD_COUNT) * CAPTION_WINDOW_WORD_COUNT
  const end = Math.min(total, start + CAPTION_WINDOW_WORD_COUNT)

  return captions.value.slice(start, end).map((cue, index) => ({
    ...cue,
    isActive: start + index === activeIndex,
    activeProgress: start + index === activeIndex
      ? Math.min(1, Math.max(0, (time - cue.start) / Math.max(0.001, cue.end - cue.start)))
      : 0
  }))
}

function getCaptionJumpOffset(progress: number): number {
  if (progress <= 0 || progress >= 1) {
    return 0
  }
  if (progress <= 0.22) {
    return CAPTION_JUMP_MAX_PX * (progress / 0.22)
  }
  if (progress <= 0.52) {
    return CAPTION_JUMP_MAX_PX * (1 - ((progress - 0.22) / 0.3))
  }
  if (progress <= 0.72) {
    return -3 * Math.sin(((progress - 0.52) / 0.2) * Math.PI)
  }
  return 0
}

function getCaptionPopScale(progress: number): number {
  if (progress <= 0 || progress >= 1) {
    return 1
  }
  if (progress <= 0.18) {
    return 1 + (0.22 * (progress / 0.18))
  }
  if (progress <= 0.42) {
    return 1.22 - (0.24 * ((progress - 0.18) / 0.24))
  }
  if (progress <= 0.62) {
    return 0.98 + (0.02 * ((progress - 0.42) / 0.2))
  }
  return 1
}

function getPreviewCaptionWordStyle(cue: CaptionWindowCue): Record<string, string> {
  const jumpOffset = cue.isActive ? getCaptionJumpOffset(cue.activeProgress) : 0
  const popScale = cue.isActive ? getCaptionPopScale(cue.activeProgress) : 1
  return {
    transform: `translateY(-${jumpOffset.toFixed(2)}px) scale(${popScale.toFixed(3)})`,
    textShadow: cue.isActive
      ? '0 0 12px rgba(250, 204, 21, 0.45), 0 2px 6px rgba(0, 0, 0, 0.9)'
      : '0 2px 6px rgba(0, 0, 0, 0.9)'
  }
}

function drawCaptionOnCanvas(
  context: CanvasRenderingContext2D,
  window: CaptionWindowCue[],
  width: number,
  height: number
): void {
  if (!window.length) {
    return
  }

  const style = captionStyleConfig[captionStyleId.value]
  const x = (clampPercent(captionPositionX.value, 50) / 100) * width
  const y = (clampPercent(captionPositionY.value, 88) / 100) * height
  context.textAlign = 'left'
  context.textBaseline = 'middle'
  const scale = getCaptionScaleFactor()
  context.font = scaleFontSize(style.font, scale)
  context.lineWidth = style.strokeWidth * scale
  context.strokeStyle = style.stroke
  const words = window.map(cue => applyCaptionLetterCase(cue.text))
  const spaceWidth = context.measureText(' ').width
  const widths = words.map(word => context.measureText(word).width)
  const totalTextWidth = widths.reduce((sum, size) => sum + size, 0) + (Math.max(0, words.length - 1) * spaceWidth)
  let cursorX = x - (totalTextWidth / 2)

  words.forEach((word, index) => {
    const cue = window[index]
    const wordWidth = widths[index] ?? 0
    const wordProgress = cue?.activeProgress ?? 0
    const wordY = y - getCaptionJumpOffset(wordProgress)
    const popScale = getCaptionPopScale(wordProgress)
    const wordCenterX = cursorX + (wordWidth / 2)
    context.fillStyle = cue?.isActive ? CAPTION_HIGHLIGHT_COLOR : style.fill
    context.save()
    context.translate(wordCenterX, wordY)
    context.scale(popScale, popScale)
    context.strokeText(word, -(wordWidth / 2), 0)
    context.fillText(word, -(wordWidth / 2), 0)
    context.restore()
    cursorX += wordWidth + spaceWidth
  })
}

function drawOverlayOnCanvas(
  context: CanvasRenderingContext2D,
  overlay: OverlayItem,
  width: number,
  height: number
): void {
  const x = (overlay.x / 100) * width
  const y = (overlay.y / 100) * height
  context.save()
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  context.font = `${overlay.kind === 'sticker' ? '700' : '600'} ${overlay.size}px sans-serif`
  context.fillStyle = overlay.color

  if (overlay.bg !== 'transparent') {
    const metrics = context.measureText(overlay.text)
    const padX = 24
    const padY = 14
    const boxW = Math.max(metrics.width + padX * 2, 40)
    const boxH = overlay.size + padY * 2
    context.fillStyle = overlay.bg
    context.fillRect(x - boxW / 2, y - boxH / 2, boxW, boxH)
    context.fillStyle = overlay.color
  }

  context.fillText(overlay.text, x, y + 4)
  context.restore()
}

function drawCover(
  context: CanvasRenderingContext2D,
  source: CanvasImageSource,
  width: number,
  height: number
): void {
  const sourceWidth = source instanceof HTMLVideoElement ? source.videoWidth : source instanceof HTMLImageElement ? source.naturalWidth : width
  const sourceHeight = source instanceof HTMLVideoElement ? source.videoHeight : source instanceof HTMLImageElement ? source.naturalHeight : height

  if (!sourceWidth || !sourceHeight) {
    return
  }

  const scale = Math.max(width / sourceWidth, height / sourceHeight)
  const drawWidth = sourceWidth * scale
  const drawHeight = sourceHeight * scale
  const dx = (width - drawWidth) / 2
  const dy = (height - drawHeight) / 2
  context.drawImage(source, dx, dy, drawWidth, drawHeight)
}

async function renderProjectToWebm(onProgress: (value: number) => void): Promise<Blob> {
  const width = 1080
  const height = 1920
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  const baseFrameCanvas = document.createElement('canvas')
  baseFrameCanvas.width = width
  baseFrameCanvas.height = height
  const baseFrameContext = baseFrameCanvas.getContext('2d')
  if (!context) {
    throw new Error('Canvas context is unavailable')
  }
  if (!baseFrameContext) {
    throw new Error('Base frame context is unavailable')
  }
  baseFrameContext.fillStyle = '#000000'
  baseFrameContext.fillRect(0, 0, width, height)

  const canvasStream = canvas.captureStream(30)
  const audioContext = new AudioContext()
  const destination = audioContext.createMediaStreamDestination()
  const exportVideoElements = new Map<string, HTMLVideoElement>()
  const exportAudioElements = new Map<string, HTMLAudioElement>()
  const exportImages = new Map<string, HTMLImageElement>()

  for (const clip of visualClips.value) {
    if (clip.kind === 'video') {
      const media = document.createElement('video')
      media.src = clip.url
      media.preload = 'auto'
      media.playsInline = true
      media.crossOrigin = 'anonymous'
      media.volume = getOutputVolume(clip)
      await media.play().catch(() => {})
      media.pause()
      media.currentTime = clip.sourceOffset
      const source = audioContext.createMediaElementSource(media)
      const gain = audioContext.createGain()
      gain.gain.value = getOutputVolume(clip)
      source.connect(gain).connect(destination)
      exportVideoElements.set(clip.id, media)
    } else {
      const image = new Image()
      image.src = clip.url
      await image.decode()
      exportImages.set(clip.id, image)
    }
  }

  for (const clip of audioClips.value) {
    const media = document.createElement('audio')
    media.src = clip.url
    media.preload = 'auto'
    media.volume = getOutputVolume(clip)
    await media.play().catch(() => {})
    media.pause()
    media.currentTime = clip.sourceOffset
    const source = audioContext.createMediaElementSource(media)
    const gain = audioContext.createGain()
    gain.gain.value = getOutputVolume(clip)
    source.connect(gain).connect(destination)
    exportAudioElements.set(clip.id, media)
  }

  const mixedStream = new MediaStream()
  canvasStream.getVideoTracks().forEach(track => mixedStream.addTrack(track))
  destination.stream.getAudioTracks().forEach(track => mixedStream.addTrack(track))

  const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
    ? 'video/webm;codecs=vp9,opus'
    : 'video/webm;codecs=vp8,opus'
  const recorder = new MediaRecorder(mixedStream, { mimeType })
  const chunks: BlobPart[] = []

  recorder.ondataavailable = (event: BlobEvent) => {
    if (event.data.size > 0) {
      chunks.push(event.data)
    }
  }

  const finished = new Promise<Blob>((resolve, reject) => {
    recorder.onstop = () => resolve(new Blob(chunks, { type: mimeType }))
    recorder.onerror = (event: Event) => reject(new Error(`Recorder failed: ${event.type}`))
  })

  recorder.start(200)
  await audioContext.resume()
  const start = performance.now()

  await new Promise<void>((resolve) => {
    const frame = async (): Promise<void> => {
      const elapsed = (performance.now() - start) / 1000

      if (elapsed >= projectDuration.value) {
        context.fillStyle = '#000000'
        context.fillRect(0, 0, width, height)
        recorder.stop()
        resolve()
        return
      }

      const visual = visualClips.value.find(clip => inRange(elapsed, clip.start, clip.duration)) ?? null
      const captionWindow = getCaptionWindowForTime(elapsed)
      const activeOverlayItems = overlays.value.filter(item => inRange(elapsed, item.start, item.duration))

      for (const clip of visualClips.value) {
        if (clip.kind !== 'video') {
          continue
        }

        const media = exportVideoElements.get(clip.id)
        if (!media) {
          continue
        }

        if (inRange(elapsed, clip.start, clip.duration)) {
          const local = elapsed - clip.start + clip.sourceOffset
          if (Math.abs(media.currentTime - local) > 0.3) {
            media.currentTime = local
          }
          await media.play().catch(() => {})
        } else {
          media.pause()
        }
      }

      for (const clip of audioClips.value) {
        const media = exportAudioElements.get(clip.id)
        if (!media) {
          continue
        }

        if (inRange(elapsed, clip.start, clip.duration)) {
          const local = elapsed - clip.start + clip.sourceOffset
          if (Math.abs(media.currentTime - local) > 0.3) {
            media.currentTime = local
          }
          await media.play().catch(() => {})
        } else {
          media.pause()
        }
      }

      if (!visual) {
        baseFrameContext.fillStyle = '#000000'
        baseFrameContext.fillRect(0, 0, width, height)
      }

      if (visual?.kind === 'video') {
        const media = exportVideoElements.get(visual.id)
        if (media && media.readyState >= 2) {
          drawCover(baseFrameContext, media, width, height)
        }
      } else if (visual?.kind === 'image') {
        const image = exportImages.get(visual.id)
        if (image) {
          drawCover(baseFrameContext, image, width, height)
        }
      }

      context.drawImage(baseFrameCanvas, 0, 0, width, height)

      for (const item of activeOverlayItems) {
        drawOverlayOnCanvas(context, item, width, height)
      }

      if (captionWindow.length) {
        drawCaptionOnCanvas(context, captionWindow, width, height)
      }

      onProgress(Math.min(99, Math.floor((elapsed / projectDuration.value) * 100)))
      requestAnimationFrame(() => {
        void frame()
      })
    }

    void frame()
  })

  const webmBlob = await finished
  await audioContext.close()
  return webmBlob
}

function downloadBlob(blob: Blob, name: string): void {
  const downloadUrl = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = downloadUrl
  link.download = name
  link.click()
  URL.revokeObjectURL(downloadUrl)
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(message))
        }, timeoutMs)
      })
    ])
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}

async function convertWebmToMp4(webmBlob: Blob): Promise<Blob> {
  if (webmBlob.size === 0) {
    throw new Error('Rendered video buffer is empty. Please add at least one playable clip and retry.')
  }

  const response = await withTimeout(
    fetch('/api/export-mp4', {
      method: 'POST',
      headers: {
        'content-type': 'video/webm'
      },
      body: webmBlob
    }),
    900000,
    'Timed out converting to MP4'
  )

  if (!response.ok) {
    const responseText = await response.text()

    try {
      const parsed = JSON.parse(responseText) as { statusMessage?: string, message?: string }
      throw new Error(parsed.statusMessage || parsed.message || `Export API failed: ${response.status}`)
    } catch {
      throw new Error(responseText || `Export API failed: ${response.status}`)
    }
  }

  const mp4ArrayBuffer = await response.arrayBuffer()
  return new Blob([mp4ArrayBuffer], { type: 'video/mp4' })
}

async function exportMp4(): Promise<void> {
  if (!import.meta.client || isExportingMp4.value || !projectDuration.value) {
    return
  }

  isExportingMp4.value = true
  mp4Stage.value = 'render'
  exportProgress.value = 0
  mp4Progress.value = 0
  statusMessage.value = 'Rendering timeline for MP4 conversion...'
  stopPlayback()

  try {
    const webmBlob = await renderProjectToWebm((value) => {
      exportProgress.value = value
    })
    exportProgress.value = 100
    mp4Stage.value = 'convert'
    statusMessage.value = 'Converting to MP4 with local ffmpeg...'
    const mp4Blob = await convertWebmToMp4(webmBlob)
    downloadBlob(mp4Blob, `vidmaker-export-${new Date().toISOString().replace(/[:.]/g, '-')}.mp4`)
    statusMessage.value = 'MP4 export complete.'
  } catch (error) {
    statusMessage.value = `MP4 export failed: ${String(error)}`
  } finally {
    mp4Stage.value = 'idle'
    isExportingMp4.value = false
  }
}

function normalizeCaptionText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function normalizeStoredCaptionCues(rawCues: CaptionCue[]): CaptionCue[] {
  const normalized: CaptionCue[] = []

  for (const cue of rawCues) {
    const text = normalizeCaptionText(cue.text)
    const safeStart = Number.isFinite(cue.start) ? Math.max(0, cue.start) : 0
    const safeEnd = Number.isFinite(cue.end) ? Math.max(safeStart + 0.2, cue.end) : safeStart + 2
    const words = text.split(' ').filter(Boolean)

    if (words.length <= 1) {
      if (!text) {
        continue
      }
      normalized.push({
        id: cue.id || crypto.randomUUID(),
        start: safeStart,
        end: safeEnd,
        text
      })
      continue
    }

    const cueDuration = Math.max(0.2, safeEnd - safeStart)
    const wordDuration = cueDuration / words.length
    words.forEach((word, index) => {
      const start = safeStart + (wordDuration * index)
      const end = index === words.length - 1
        ? safeEnd
        : Math.min(safeEnd, start + wordDuration)
      normalized.push({
        id: crypto.randomUUID(),
        start,
        end: Math.max(start + 0.08, end),
        text: word
      })
    })
  }

  return normalized
}

function buildCaptionCues(rawChunks: AsrChunk[], fallbackDuration: number): CaptionCue[] {
  const cues: CaptionCue[] = []
  let cursor = 0

  for (const chunk of rawChunks) {
    const text = normalizeCaptionText(chunk.text ?? '')
    if (!text) {
      continue
    }

    const [start, end] = Array.isArray(chunk.timestamp) ? chunk.timestamp : [cursor, cursor + 2]
    const safeStart = Number.isFinite(start) ? Math.max(0, start) : cursor
    const safeEnd = Number.isFinite(end) ? Math.max(safeStart + 0.2, end) : safeStart + 2

    const words = text.split(' ').filter(Boolean)
    if (!words.length) {
      cursor = safeEnd
      continue
    }

    const chunkDuration = Math.max(0.2, safeEnd - safeStart)
    const wordDuration = chunkDuration / words.length
    words.forEach((word, index) => {
      const start = safeStart + (wordDuration * index)
      const end = index === words.length - 1
        ? safeEnd
        : Math.min(safeEnd, start + wordDuration)
      cues.push({
        id: crypto.randomUUID(),
        start,
        end: Math.max(start + 0.08, end),
        text: word
      })
    })
    cursor = safeEnd
  }

  if (!cues.length) {
    cues.push({
      id: crypto.randomUUID(),
      start: 0,
      end: Math.max(2, fallbackDuration),
      text: 'No speech detected'
    })
  }

  return cues
}

async function ensureCaptionModel(): Promise<CaptionModel> {
  if (captionsModel) {
    return captionsModel
  }

  const { pipeline, env } = await import('@xenova/transformers')
  env.allowLocalModels = false
  env.useBrowserCache = true
  captionsModel = await pipeline(
    'automatic-speech-recognition',
    'Xenova/whisper-tiny.en',
    {
      progress_callback: (event: { progress?: number }) => {
        if (typeof event.progress === 'number') {
          captionsProgress.value = Math.min(100, Math.floor(event.progress * 100))
        }
      }
    }
  ) as CaptionModel
  return captionsModel
}

async function generateCaptions(): Promise<void> {
  if (!import.meta.client || isGeneratingCaptions.value) {
    return
  }

  const sourceClip = audioClips.value[0] ?? visualClips.value.find(clip => clip.kind === 'video')

  if (!sourceClip) {
    statusMessage.value = 'Add audio (or a video with audio) before generating captions.'
    return
  }

  const fileRecord = await getFile(sourceClip.fileId)
  if (!fileRecord) {
    statusMessage.value = 'Could not locate audio data for caption generation.'
    return
  }

  isGeneratingCaptions.value = true
  captionsProgress.value = 0
  statusMessage.value = 'Generating captions... this can take a bit on first run.'

  try {
    const model = await ensureCaptionModel()
    const audioUrl = URL.createObjectURL(fileRecord.blob)
    const result = await model(audioUrl, {
      chunk_length_s: 25,
      stride_length_s: 5,
      return_timestamps: true
    })
    URL.revokeObjectURL(audioUrl)

    const chunks = Array.isArray(result?.chunks)
      ? result.chunks
      : [{ text: String(result?.text ?? ''), timestamp: [0, sourceClip.duration] as [number, number] }]

    captions.value = buildCaptionCues(chunks, sourceClip.duration)
    captionsProgress.value = 100
    statusMessage.value = `Generated ${captions.value.length} caption cue(s).`
    await saveDraft()
  } catch (error) {
    statusMessage.value = `Caption generation failed: ${String(error)}`
  } finally {
    isGeneratingCaptions.value = false
  }
}
</script>

<template>
  <div class="editor-page">
    <header class="editor-header">
      <div>
        <h1>Vidmaker</h1>
        <p>Simple local iMovie-style editor for portrait videos (9:16).</p>
      </div>
      <div class="header-actions">
        <input
          ref="filePicker"
          type="file"
          accept="video/*,image/*,audio/*"
          multiple
          class="hidden"
          @change="importMedia"
        >
        <button
          class="btn btn-primary"
          @click="openPicker"
        >
          Import Media
        </button>
        <button
          class="btn"
          :disabled="isGeneratingCaptions"
          @click="generateCaptions"
        >
          {{ isGeneratingCaptions ? `Generating ${captionsProgress}%` : 'Generate Captions' }}
        </button>
        <button class="btn" @click="addTitle">
          + Title
        </button>
        <button class="btn" @click="addSticker">
          + Sticker
        </button>
        <button
          class="btn btn-success"
          :disabled="isExportingMp4 || !projectDuration"
          @click="exportMp4"
        >
          {{
            isExportingMp4
              ? (mp4Stage === 'render' ? `Rendering ${exportProgress}%` : 'Converting...')
              : 'Export MP4'
          }}
        </button>
      </div>
    </header>

    <div class="status-row">
      <span>{{ statusMessage }}</span>
      <span>Draft saved: {{ formatDateTime(draftSavedAt) }}</span>
    </div>

    <section class="editor-main">
      <article class="preview-panel">
        <div class="preview-toolbar">
          <label>
            Caption style
            <select
              :value="captionStyleId"
              @change="captionStyleId = (($event.target as HTMLSelectElement).value as CaptionStyleId)"
            >
              <option
                v-for="option in captionStyleOptions"
                :key="option.value"
                :value="option.value"
              >
                {{ option.label }}
              </option>
            </select>
          </label>
        </div>

        <div class="preview-canvas">
          <div class="preview-phone">
            <video
              v-for="clip in visualClips"
              v-show="activeVisualClip?.id === clip.id && clip.kind === 'video'"
              :key="clip.id"
              :ref="setVisualVideoRef(clip.id)"
              :src="clip.url"
              playsinline
              preload="metadata"
              class="preview-media"
            />
            <img
              v-for="clip in visualClips"
              v-show="activeVisualClip?.id === clip.id && clip.kind === 'image'"
              :key="`image-${clip.id}`"
              :src="clip.url"
              :alt="clip.name"
              class="preview-media"
            >

            <div
              v-for="item in activeOverlays"
              :key="item.id"
              class="overlay-item"
              :style="{
                left: `${item.x}%`,
                top: `${item.y}%`,
                fontSize: `${item.size}px`,
                color: item.color,
                background: item.bg
              }"
            >
              {{ item.text }}
            </div>

            <p v-if="!activeVisualClip" class="preview-empty">
              Import video or photos to preview in portrait mode.
            </p>
            <p
              v-if="activeCaptionWindow.length"
              class="preview-caption"
              :style="{ ...getCaptionPreviewStyle(captionStyleId), ...getCaptionPreviewPositionStyle() }"
            >
              <span
                v-for="cue in activeCaptionWindow"
                :key="cue.id"
                class="preview-caption-word"
                :class="{ active: cue.isActive }"
                :style="getPreviewCaptionWordStyle(cue)"
              >
                {{ cue.text }}
              </span>
            </p>
          </div>
        </div>

        <div class="transport">
          <button class="btn" @click="seekBy(-2)">
            -2s
          </button>
          <button class="btn btn-primary" @click="togglePlayback">
            {{ isPlaying ? 'Pause' : 'Play' }}
          </button>
          <button class="btn" @click="seekBy(2)">
            +2s
          </button>
          <input
            class="timeline-slider"
            type="range"
            :min="0"
            :max="projectDuration"
            :step="0.01"
            :value="currentTime"
            @input="seekTo(Number(($event.target as HTMLInputElement).value))"
          >
          <span>{{ formatTime(currentTime) }} / {{ formatTime(projectDuration) }}</span>
        </div>
      </article>

      <article class="inspector-panel">
        <h2>Inspector</h2>
        <p>Drag clip body to reorder in timeline. Drag handles to trim left/right.</p>

        <div v-if="selectedClip" class="inspector-form">
          <p><strong>{{ selectedClip.name }}</strong> ({{ selectedClip.kind }})</p>
          <label>
            Start (seconds)
            <input
              type="number"
              min="0"
              step="0.1"
              :value="selectedClip.start"
              @input="updateSelectedClipField('start', ($event.target as HTMLInputElement).value)"
            >
          </label>
          <label>
            Duration (seconds)
            <input
              type="number"
              min="0.2"
              step="0.1"
              :value="selectedClip.duration"
              @input="updateSelectedClipField('duration', ($event.target as HTMLInputElement).value)"
            >
          </label>
          <label v-if="selectedClip.kind !== 'image'">
            Trim start in source (seconds)
            <input
              type="number"
              min="0"
              step="0.1"
              :max="Math.max(0, selectedClip.sourceDuration - 0.2)"
              :value="selectedClip.sourceOffset"
              @input="updateSelectedClipField('sourceOffset', ($event.target as HTMLInputElement).value)"
            >
          </label>
          <label>
            Volume (0 - 2)
            <input
              type="number"
              min="0"
              max="2"
              step="0.1"
              :value="selectedClip.volume"
              @input="updateSelectedClipField('volume', ($event.target as HTMLInputElement).value)"
            >
          </label>
          <button
            v-if="selectedClip.kind === 'video'"
            class="btn"
            @click="toggleSelectedVideoMute"
          >
            {{ selectedClip.muted ? 'Unmute Video Clip' : 'Mute Video Clip' }}
          </button>
          <button class="btn btn-danger" @click="removeClip(selectedClip.id)">
            Remove Clip
          </button>
        </div>

        <div v-else-if="selectedOverlay" class="inspector-form">
          <p><strong>{{ selectedOverlay.kind === 'title' ? 'Title' : 'Sticker' }}</strong></p>
          <label>
            Text
            <input
              type="text"
              :value="selectedOverlay.text"
              @input="updateSelectedOverlayField('text', ($event.target as HTMLInputElement).value)"
            >
          </label>
          <label>
            Start (seconds)
            <input
              type="number"
              min="0"
              step="0.1"
              :value="selectedOverlay.start"
              @input="updateSelectedOverlayField('start', ($event.target as HTMLInputElement).value)"
            >
          </label>
          <label>
            Duration (seconds)
            <input
              type="number"
              min="0.2"
              step="0.1"
              :value="selectedOverlay.duration"
              @input="updateSelectedOverlayField('duration', ($event.target as HTMLInputElement).value)"
            >
          </label>
          <label>
            X (%)
            <input
              type="number"
              min="0"
              max="100"
              step="1"
              :value="selectedOverlay.x"
              @input="updateSelectedOverlayField('x', ($event.target as HTMLInputElement).value)"
            >
          </label>
          <label>
            Y (%)
            <input
              type="number"
              min="0"
              max="100"
              step="1"
              :value="selectedOverlay.y"
              @input="updateSelectedOverlayField('y', ($event.target as HTMLInputElement).value)"
            >
          </label>
          <label>
            Size
            <input
              type="number"
              min="16"
              max="120"
              step="1"
              :value="selectedOverlay.size"
              @input="updateSelectedOverlayField('size', ($event.target as HTMLInputElement).value)"
            >
          </label>
          <label>
            Color
            <input
              type="text"
              :value="selectedOverlay.color"
              @input="updateSelectedOverlayField('color', ($event.target as HTMLInputElement).value)"
            >
          </label>
          <label>
            Background
            <input
              type="text"
              :value="selectedOverlay.bg"
              @input="updateSelectedOverlayField('bg', ($event.target as HTMLInputElement).value)"
            >
          </label>
          <button class="btn btn-danger" @click="removeOverlay(selectedOverlay.id)">
            Remove Overlay
          </button>
        </div>

        <p v-else class="inspector-empty">
          Select a clip or overlay in timeline.
        </p>

        <div class="inspector-captions">
          <h3>Captions</h3>
          <p>{{ captions.length }} cue(s) • style: {{ captionStyleConfig[captionStyleId].label }}</p>
          <label>
            Caption size (%)
            <input
              type="number"
              :min="CAPTION_SIZE_MIN"
              :max="CAPTION_SIZE_MAX"
              step="5"
              :value="captionSizePercent"
              @input="captionSizePercent = clampCaptionSizePercent(Number(($event.target as HTMLInputElement).value), 100)"
            >
          </label>
          <label>
            Caption case
            <select
              :value="captionLetterCase"
              @change="captionLetterCase = parseCaptionLetterCase(($event.target as HTMLSelectElement).value)"
            >
              <option
                v-for="option in captionLetterCaseOptions"
                :key="option.value"
                :value="option.value"
              >
                {{ option.label }}
              </option>
            </select>
          </label>
          <label>
            Caption X (%)
            <input
              type="number"
              min="0"
              max="100"
              step="1"
              :value="captionPositionX"
              @input="captionPositionX = clampPercent(Number(($event.target as HTMLInputElement).value), 50)"
            >
          </label>
          <label>
            Caption Y (%)
            <input
              type="number"
              min="0"
              max="100"
              step="1"
              :value="captionPositionY"
              @input="captionPositionY = clampPercent(Number(($event.target as HTMLInputElement).value), 88)"
            >
          </label>
        </div>
      </article>
    </section>

    <section class="timeline-panel">
      <h2>Timeline</h2>
      <div class="timeline-scroll">
        <div class="timeline-inner" :style="{ width: `${timelineWidth}px` }">
          <div class="timeline-playhead" :style="{ left: `${(playbackPercent / 100) * timelineWidth}px` }" />

          <div class="timeline-track-row">
            <span class="track-label">Visual</span>
            <div class="track-content">
              <div
                v-for="clip in visualClips"
                :key="clip.id"
                class="clip-chip visual-chip"
                :class="{ selected: selectedClipId === clip.id }"
                :style="{ left: `${clip.start * PX_PER_SECOND}px`, width: `${Math.max(60, clip.duration * PX_PER_SECOND)}px` }"
                @click="selectClip(clip.id)"
                @pointerdown="startClipDrag('move', clip, $event)"
              >
                <span class="trim-handle left" @pointerdown.stop="startClipDrag('trim-left', clip, $event)" />
                <strong>{{ clip.kind === 'video' ? 'Video' : 'Photo' }}</strong>
                <small>{{ clip.name }}</small>
                <span class="trim-handle right" @pointerdown.stop="startClipDrag('trim-right', clip, $event)" />
              </div>
            </div>
          </div>

          <div class="timeline-track-row">
            <span class="track-label">Audio</span>
            <div class="track-content">
              <div
                v-for="clip in audioClips"
                :key="clip.id"
                class="clip-chip audio-chip"
                :class="{ selected: selectedClipId === clip.id }"
                :style="{ left: `${clip.start * PX_PER_SECOND}px`, width: `${Math.max(60, clip.duration * PX_PER_SECOND)}px` }"
                @click="selectClip(clip.id)"
                @pointerdown="startClipDrag('move', clip, $event)"
              >
                <span class="trim-handle left" @pointerdown.stop="startClipDrag('trim-left', clip, $event)" />
                <strong>Audio</strong>
                <small>{{ clip.name }}</small>
                <span class="trim-handle right" @pointerdown.stop="startClipDrag('trim-right', clip, $event)" />
              </div>
            </div>
          </div>

          <div class="timeline-track-row">
            <span class="track-label">Overlays</span>
            <div class="track-content">
              <div
                v-for="item in overlays"
                :key="item.id"
                class="clip-chip overlay-chip"
                :class="{ selected: selectedOverlayId === item.id }"
                :style="{ left: `${item.start * PX_PER_SECOND}px`, width: `${Math.max(60, item.duration * PX_PER_SECOND)}px` }"
                @click="selectOverlay(item.id)"
              >
                <strong>{{ item.kind === 'title' ? 'Title' : 'Sticker' }}</strong>
                <small>{{ item.text }}</small>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>

    <audio
      v-for="clip in audioClips"
      :key="`audio-${clip.id}`"
      :ref="setAudioRef(clip.id)"
      :src="clip.url"
      preload="metadata"
      class="hidden"
    />
  </div>
</template>
