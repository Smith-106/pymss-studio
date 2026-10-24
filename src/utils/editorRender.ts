import { invoke } from '@tauri-apps/api/core'
import i18n from '../i18n'
import { clipsForTrack } from './editorClips'
import { createPreviewChunkReader, PREVIEW_CHUNK_SECONDS, scheduleEditorClipGain, type PreviewChunkReader } from './editorAudio'
import { applyEditorTrackEffects, createEditorEffectNodes } from './editorEffects'
import type { EditorClip, EditorSession, EditorSource, EditorTrack, EditorTrackEffects } from '../types/editor'

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
export const hasEditorEffects = (effects?: EditorTrackEffects) => Boolean(effects && [effects.clarity, effects.compressor, effects.reverb, effects.delay].some(value => value > 0))
const MAX_RENDER_MEMORY_BYTES = 512 * 1024 * 1024

function effectTail(effects?: EditorTrackEffects) {
  let tail = effects?.compressor ? .01 : 0
  if (effects?.reverb) tail = Math.max(tail, 1.35)
  if (effects?.delay) {
    const feedback = clamp(effects.delay, 0, 1) * .52
    tail = Math.max(tail, clamp(effects.delayTime, .05, 1.2) * Math.ceil(Math.log(1e-5) / Math.log(feedback)))
  }
  return tail
}

function renderFrames(source: EditorSource, track: EditorTrack, clip: EditorClip, sampleRate: number) {
  const frames = Math.ceil((clip.duration + effectTail(track.effects)) * sampleRate)
  // Include decoded inputs, stereo output, a second native-buffer allocation
  // and working space before asking the browser to allocate the full render.
  const channels = source.channels === 1 ? 1 : 2
  const estimatedBytes = frames * 4 * (channels + 2) * 2 + 16 * 1024 * 1024
  if (!Number.isSafeInteger(frames) || frames <= 0 || estimatedBytes > MAX_RENDER_MEMORY_BYTES) {
    throw new Error(String(i18n.global.t('editor.exportEffectsTooLarge', { name: source.name })))
  }
  return frames
}

/** Render with the native preview graph, preserving its filter, compressor and stereo reverb. */
export async function renderEditorClip(
  ctx: OfflineAudioContext, source: EditorSource, track: EditorTrack, clip: EditorClip,
  readChunk: PreviewChunkReader, signal: AbortSignal, onProgress: (ratio: number) => void = () => {},
) {
  const effects = createEditorEffectNodes(ctx)
  const volume = ctx.createGain(), splitter = ctx.createChannelSplitter(2)
  const left = ctx.createGain(), right = ctx.createGain()
  volume.gain.value = clamp(track.volume, 0, 2)
  const pan = clamp(track.pan, -1, 1)
  left.gain.value = pan <= 0 ? 1 : 1 - pan
  right.gain.value = pan >= 0 ? 1 : 1 + pan
  volume.connect(splitter)
  splitter.connect(left, 0)
  splitter.connect(right, source.channels === 1 ? 0 : 1)
  left.connect(effects.balanceMerger, 0, 0)
  right.connect(effects.balanceMerger, 0, 1)
  applyEditorTrackEffects(effects, track.effects, ctx)
  effects.effectOutputGain.connect(ctx.destination)
  const nodes: Array<{ source: AudioBufferSourceNode; gain: GainNode }> = []
  const localClip = { ...clip, start: 0 }
  const offsetFrames = Math.round(clip.offset * ctx.sampleRate)
  const durationFrames = Math.round((clip.start + clip.duration) * ctx.sampleRate) - Math.round(clip.start * ctx.sampleRate)
  const chunkFrames = PREVIEW_CHUNK_SECONDS * ctx.sampleRate
  const first = Math.floor(offsetFrames / chunkFrames)
  const last = Math.ceil((offsetFrames + durationFrames) / chunkFrames)
  let decodedFrames = 0
  try {
    // Bound the native decoder concurrency and reuse the exact preview decoder.
    for (let index = first; index < last; index += 4) {
      signal.throwIfAborted()
      const chunks = await Promise.all(Array.from({ length: Math.min(4, last - index) }, async (_, i) => ({
        index: index + i, buffer: await readChunk(source, index + i, signal),
      })))
      signal.throwIfAborted()
      for (const chunk of chunks) {
        if (!chunk.buffer) continue
        const chunkStart = chunk.index * chunkFrames
        const from = Math.max(offsetFrames, chunkStart)
        const until = Math.min(offsetFrames + durationFrames, chunkStart + chunk.buffer.length)
        if (until <= from) continue
        const node = ctx.createBufferSource(), gain = ctx.createGain()
        node.buffer = chunk.buffer
        node.connect(gain); gain.connect(volume)
        const start = (from - offsetFrames) / ctx.sampleRate
        const length = (until - from) / ctx.sampleRate
        scheduleEditorClipGain(gain.gain, localClip, start, start + length, 0)
        node.start(start, (from - chunkStart) / ctx.sampleRate, length)
        nodes.push({ source: node, gain })
        decodedFrames += until - from
      }
      onProgress(.7 * Math.min(1, (index + 4 - first) / Math.max(1, last - first)))
    }
    if (!decodedFrames) throw new Error('Audio source contains no renderable samples')
    signal.throwIfAborted()
    const rendered = await ctx.startRendering()
    signal.throwIfAborted()
    onProgress(1)
    return rendered
  } finally {
    for (const node of nodes) { node.source.disconnect(); node.gain.disconnect() }
    volume.disconnect(); splitter.disconnect(); left.disconnect(); right.disconnect()
    for (const node of Object.values(effects)) {
      if (typeof node === 'object' && node && 'disconnect' in node) node.disconnect()
    }
  }
}

function base64(bytes: Uint8Array) {
  let text = ''
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    text += String.fromCharCode(...bytes.subarray(offset, offset + 8192))
  }
  return btoa(text)
}

type RenderedAudio = { path: string; duration: number; sampleRate: number; channels: number }

async function writeRenderedAudio(buffer: AudioBuffer, projectId: string, taskId: string, clipIndex: number, signal: AbortSignal) {
  const chunkFrames = 65536
  let result: RenderedAudio | null = null
  for (let start = 0; start < buffer.length; start += chunkFrames) {
    signal.throwIfAborted()
    const frames = Math.min(chunkFrames, buffer.length - start)
    const data = new Uint8Array(frames * buffer.numberOfChannels * 4), view = new DataView(data.buffer)
    for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
      const samples = buffer.getChannelData(channel)
      for (let frame = 0; frame < frames; frame++) {
        view.setFloat32((frame * buffer.numberOfChannels + channel) * 4, samples[start + frame], true)
      }
    }
    result = await invoke<RenderedAudio | null>('append_editor_export_render_chunk', {
      projectId, taskId, clipIndex, sampleRate: buffer.sampleRate, channels: buffer.numberOfChannels,
      frames: buffer.length, offset: start * buffer.numberOfChannels * 4, dataBase64: base64(data),
    })
  }
  signal.throwIfAborted()
  if (!result) throw new Error('Rendered audio is incomplete')
  return result
}

export async function prepareEditorExportEffects(session: EditorSession, taskId: string, signal: AbortSignal, onProgress: (ratio: number, current: string) => void) {
  const sources = new Map(session.sources.map(source => [source.id, source]))
  const solo = session.tracks.some(track => track.solo)
  const audible = session.tracks.filter(track => !track.muted && (!solo || track.solo) && track.volume > 0)
  const items = audible.flatMap(track => clipsForTrack(track, sources).filter(clip => !clip.muted && clip.volume > 0 && clip.duration > 0).map(clip => ({ track, clip })))
  const toRender = items.filter(item => hasEditorEffects(item.track.effects))
  if (!toRender.length) return { session, sourceSampleRate: undefined }
  const sourceSampleRate = Math.min(48000, Math.max(...items.map(({ clip }) => sources.get(clip.assetId)?.sampleRate || 0))) || undefined
  const probe = new AudioContext()
  const sampleRate = probe.sampleRate
  await probe.close()
  signal.throwIfAborted()
  const planned = toRender.map(({ track, clip }) => {
    const source = sources.get(clip.assetId)
    if (!source || source.missing) throw new Error('Audio source is unavailable')
    return { track, clip, source, frames: renderFrames(source, track, clip, sampleRate) }
  })
  const prepared = JSON.parse(JSON.stringify(session)) as EditorSession
  const renderedClips = new Map<string, EditorClip>()
  for (let index = 0; index < toRender.length; index++) {
    signal.throwIfAborted()
    const { track, clip, source, frames } = planned[index]!
    const ctx = new OfflineAudioContext(2, frames, sampleRate)
    const buffer = await renderEditorClip(ctx, source, track, clip, createPreviewChunkReader(ctx), signal,
      ratio => onProgress((index + ratio * .9) / toRender.length, source.name))
    const rendered = await writeRenderedAudio(buffer, session.id, taskId, index, signal)
    const id = `export_render_${index}`
    prepared.sources.push({ ...source, ...rendered, id, missing: false })
    renderedClips.set(`${track.id}:${clip.id}`, { ...clip, assetId: id, offset: 0, duration: rendered.duration, volume: 1, fadeIn: 0, fadeOut: 0 })
    onProgress((index + 1) / toRender.length, source.name)
  }
  for (const track of prepared.tracks) {
    if (!toRender.some(item => item.track.id === track.id)) continue
    track.clips = clipsForTrack(track, sources).map(clip => renderedClips.get(`${track.id}:${clip.id}`) || clip)
    track.volume = 1; track.pan = 0; track.effects = undefined
  }
  return { session: prepared, sourceSampleRate }
}
