import type { EditorPluginSlot, EditorSession } from '../types/editor'

export function clonePluginChain(chain?: EditorPluginSlot[]) {
  return chain?.map(slot => JSON.parse(JSON.stringify(slot)) as EditorPluginSlot)
}

/** AU component codes may contain colons, so consume fixed-width or #8hex fields. */
export function pluginAudioUnitVersion(id: string): 2 | 3 | null {
  const version = id.startsWith('au3:') ? 3 : id.startsWith('au:') ? 2 : null
  if (!version) return null
  let rest = id.slice(version === 3 ? 4 : 3)
  const codes: number[] = []
  for (let index = 0; index < 3; index++) {
    const encoded = /^#[0-9a-fA-F]{8}(?=:|$)/.test(rest)
    const field = rest.slice(0, encoded ? 9 : 4)
    if (!encoded && !/^[\x20-\x7e]{4}$/.test(field)) return null
    codes.push(encoded ? Number.parseInt(field.slice(1), 16) : [...field].reduce((value, character) => value * 256 + character.charCodeAt(0), 0))
    rest = rest.slice(field.length)
    if (index < 2) {
      if (!rest.startsWith(':')) return null
      rest = rest.slice(1)
    }
  }
  return !rest && [0x61756678, 0x61756d66, 0x61756d75].includes(codes[0]) ? version : null
}

type PluginDescriptorIdentity = { id: string; format?: string; auVersion?: 2 | 3; isShellChild?: boolean }
export function pluginDescriptorFormat(descriptor: PluginDescriptorIdentity) {
  return descriptor.format || (descriptor.id.startsWith('vst2:') ? 'vst2' : pluginAudioUnitVersion(descriptor.id) ? 'au' : 'vst3')
}

export function pluginDescriptorVariant(descriptor: PluginDescriptorIdentity) {
  const format = pluginDescriptorFormat(descriptor)
  if (format === 'au') {
    const version = pluginAudioUnitVersion(descriptor.id) || descriptor.auVersion
    return version ? `AUv${version}` : 'AU'
  }
  return format === 'vst2' && descriptor.isShellChild ? 'VST2 Shell' : format.toUpperCase()
}

/** Distinguish variants and same-name shell entries without hiding their full identities. */
export function pluginDescriptorLabels(descriptors: readonly (PluginDescriptorIdentity & { name: string; vendor?: string; path: string })[], includePath = false) {
  const count = (labels: readonly string[]) => {
    const counts = new Map<string, number>()
    for (const label of labels) counts.set(label, (counts.get(label) || 0) + 1)
    return counts
  }
  const base = descriptors.map(plugin => `${plugin.name} · ${pluginDescriptorVariant(plugin)}${plugin.vendor ? ` · ${plugin.vendor}` : ''}`)
  const baseCounts = count(base)
  const identified = base.map((label, index) => baseCounts.get(label)! > 1 ? `${label} · ${descriptors[index].id}` : label)
  const identityCounts = count(identified)
  return identified.map((label, index) => includePath || identityCounts.get(label)! > 1 ? `${label} · ${descriptors[index].path}` : label)
}

/** A saved opaque state may only be restored into the same format and plugin class. */
export function pluginSlotMatchesDescriptor(slot: EditorPluginSlot, descriptor: { id: string; classId: string; isInstrument: boolean | null; format?: string }) {
  const format = pluginDescriptorFormat(descriptor)
  return slot.format === format && descriptor.isInstrument !== true
    && (slot.pluginId === descriptor.id || (format !== 'au' && slot.pluginId === descriptor.classId))
    && (typeof slot.classId !== 'string' || slot.classId === descriptor.classId)
}

export function normalizePluginChain(value: unknown): EditorPluginSlot[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter(slot => slot && typeof slot === 'object' && !Array.isArray(slot))
    .map(slot => JSON.parse(JSON.stringify(slot)) as EditorPluginSlot)
}

export function projectPluginSlots(project: EditorSession) {
  return [...(project.pluginChain || []), ...project.tracks.flatMap(track => track.pluginChain || [])]
}

export function hasEditorPlugins(project: EditorSession | null | undefined) {
  return Boolean(project && projectPluginSlots(project).length)
}

export function pluginProjectVersion(project: EditorSession) {
  return hasEditorPlugins(project) ? 4 : 3
}

export function pluginProjectBlockReason(project: EditorSession, formats: readonly string[] = ['vst3', 'vst2', 'au'], builtinEffects = false): 'effects' | 'format' | null {
  if (!builtinEffects && project.tracks.some(track => ['reverb', 'delay', 'clarity', 'compressor'].some(key =>
    Number(track.effects?.[key as keyof NonNullable<typeof track.effects>] || 0) > 0))) return 'effects'
  if (projectPluginSlots(project).some(slot => !slot.bypassed && !formats.includes(slot.format))) return 'format'
  return null
}

export function applyPluginStates(project: EditorSession, states: Record<string, string>) {
  let changed = false
  for (const slot of projectPluginSlots(project)) {
    if (typeof states[slot.id] === 'string' && slot.state !== states[slot.id]) {
      slot.state = states[slot.id]
      changed = true
    }
  }
  return changed
}

/** Captured host state updates the host signature atomically; explicit history restores remain observable. */
export function pluginProjectSignature(project: EditorSession) {
  return JSON.stringify(project, (key, value) => ['peaks', 'channelPeaks', 'updatedAt'].includes(key) ? undefined : value)
}

export function neutralPluginRenderProject(project: EditorSession, render: { path: string; duration: number; sampleRate: number; channels: number }): EditorSession {
  const source = { id: 'plugin-render', role: 'stem' as const, name: project.name, ...render }
  return {
    ...project, masterVolume: 1, masterPan: 0, pluginChain: undefined, sources: [source],
    tracks: [{ id: 'plugin-render', sourceId: source.id, role: 'stem', name: project.name,
      volume: 1, pan: 0, muted: false, solo: false, fadeIn: 0, fadeOut: 0,
      clips: [{ id: 'plugin-render', assetId: source.id, start: 0, offset: 0, duration: render.duration,
        volume: 1, fadeIn: 0, fadeOut: 0, muted: false, locked: false }] }],
  }
}
