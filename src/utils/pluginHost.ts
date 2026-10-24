import { invoke } from '@tauri-apps/api/core'
import i18n from '@/i18n'
import type { EditorPluginSlot, EditorSession } from '@/types/editor'
import { pluginProjectBlockReason, pluginProjectSignature, projectPluginSlots } from './editorPlugins'

export type PluginHostCapabilities = { enabled: boolean; platform: string; formats: string[]; nativeEditor: boolean; nativeEditorFormats?: string[]; builtinEffects?: boolean; recording?: boolean; experimental: boolean; labBuild?: boolean; scanControl?: boolean }
export type PluginDescriptor = { id: string; classId: string; name: string; vendor: string; version: string; path: string; isInstrument: boolean | null; format?: string; auVersion?: 2 | 3; isShellChild?: boolean; category?: string; subCategories?: string[]; rawCategory?: number | null; componentType?: number; componentSubtype?: number; componentManufacturer?: number }
export type PluginParameter = { id: string; name: string; min: number; max: number; default: number; unit: string; taper: string; choices: string[] }
export type PluginParameters = Partial<PluginHostStatus> & { params: PluginParameter[]; values: Record<string, number> }
export type PluginScanBlacklistEntry = { path: string; name: string; reason: 'manual' | 'timeout'; addedAt: number }
export type PluginScanStatus = { scanId: string; phase: 'collecting' | 'scanning' | 'finished' | 'cancelled'; currentPath: string | null; currentName: string | null; elapsedMs: number; completed: number; total: number; canSkip: boolean }
export type PluginScanReport = { plugins: PluginDescriptor[]; failures: { path: string; message: string }[]; scanned: number; cached: number; blacklisted?: PluginScanBlacklistEntry[]; cancelled?: boolean }
export type UnavailablePlugin = { slotId: string; message: string }
export type PluginHostStatus = { projectId?: string; sessionId?: string; stateRevision?: number; openEditors?: string[]; unavailablePlugins?: UnavailablePlugin[]; position: number; playing: boolean; duration: number; levels?: Record<string, [number, number]>; masterLevel?: [number, number]; error?: string }
export type PluginSessionState = { project: EditorSession; sessionId: string; revision: number; dirty: boolean; error: string | null; openEditors: string[]; unavailablePlugins: UnavailablePlugin[]; unavailable: boolean; interactionRequired?: boolean }
export class PluginHostDialogPendingError extends Error {
  constructor() { super(String(i18n.global.t('editor.plugins.dialogPending'))); this.name = 'PluginHostDialogPendingError' }
}
type Session = PluginSessionState & { signature: string; capturedRevision: number; lastStatus: number; lastFallback: number }
let loaded: Session | null = null
let operationQueue: Promise<unknown> = Promise.resolve()
let capabilities: Promise<PluginHostCapabilities> | null = null
let monitor: ReturnType<typeof setTimeout> | null = null
let sessionSequence = 0
const listeners = new Set<(state: PluginSessionState | null) => void>()
const stateIntents = new WeakMap<EditorPluginSlot, { state: string | undefined; token: object }>()

function stateIntent(slot: EditorPluginSlot) {
  let intent = stateIntents.get(slot)
  if (!intent || intent.state !== slot.state) {
    intent = { state: slot.state, token: {} }
    stateIntents.set(slot, intent)
  }
  return intent
}

function enqueue<T>(action: () => Promise<T>) {
  const result = operationQueue.then(action)
  operationQueue = result.catch(() => undefined)
  return result
}
function publish() { for (const listener of listeners) listener(loaded) }
export function observePluginSession(listener: (state: PluginSessionState | null) => void) {
  listeners.add(listener)
  if (loaded) listener(loaded)
  scheduleMonitor()
  return () => { listeners.delete(listener); if (!listeners.size && monitor) { clearTimeout(monitor); monitor = null } }
}
export function currentPluginSession() { return loaded }

function scheduleMonitor() {
  if (monitor || !loaded || !listeners.size) return
  monitor = setTimeout(async () => {
    monitor = null
    const current = loaded
    if (!current || current.unavailable) return
    try {
      // The playback adapter already polls at 100 ms; an idle native editor still needs observation.
      if (Date.now() - current.lastStatus >= 750) await pluginHostRequest({ op: 'status', projectId: current.project.id })
      if (loaded === current && current.openEditors.length && !current.error && Date.now() - current.lastFallback >= 15000) {
        current.lastFallback = Date.now(); current.dirty = true; publish()
      }
    } catch { /* Playback and persistence expose the retained session error. */ }
    scheduleMonitor()
  }, 1000)
}

function observeResponse(request: Record<string, unknown>, value: unknown) {
  const current = loaded
  if (!current || request.projectId !== current.project.id || !value || typeof value !== 'object') return
  const response = value as Partial<PluginHostStatus>
  if (response.projectId && response.projectId !== current.project.id) return
  let changed = false
  if (current.interactionRequired) {
    current.interactionRequired = false; current.error = null; changed = true
  }
  if (typeof response.sessionId === 'string' && response.sessionId !== current.sessionId) {
    current.sessionId = response.sessionId; current.revision = 0; current.capturedRevision = -1; current.dirty = true; current.error = null; changed = true
  }
  if (Number.isSafeInteger(response.stateRevision) && Number(response.stateRevision) > current.revision) {
    current.revision = Number(response.stateRevision); current.dirty = true; changed = true
  }
  if (Array.isArray(response.openEditors)) {
    if (JSON.stringify(current.openEditors) !== JSON.stringify(response.openEditors)) changed = true
    current.openEditors = response.openEditors.filter((id): id is string => typeof id === 'string')
  }
  if (Array.isArray(response.unavailablePlugins)) {
    const unavailablePlugins = response.unavailablePlugins.filter(item => item && typeof item.slotId === 'string' && typeof item.message === 'string')
    if (JSON.stringify(current.unavailablePlugins) !== JSON.stringify(unavailablePlugins)) changed = true
    current.unavailablePlugins = unavailablePlugins
  }
  if (request.op === 'status') {
    current.lastStatus = Date.now()
    if (current.unavailable) { current.unavailable = false; changed = true }
  }
  if (changed) publish()
}

async function requestNow<T>(request: Record<string, unknown>): Promise<T> {
  const current = loaded
  try {
    const result = await invoke<T>('plugin_host_request', { request })
    observeResponse(request, result)
    return result
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    const interactionRequired = message.startsWith('PLUGIN_HOST_DIALOG_PENDING:')
    const failure = interactionRequired ? new PluginHostDialogPendingError() : cause
    if (interactionRequired && current && loaded === current && request.projectId === current.project.id) {
      current.interactionRequired = true; current.error = (failure as Error).message; current.dirty = true
      publish()
      throw failure
    }
    if (current && loaded === current && request.projectId === current.project.id && request.op !== 'unload' && request.op !== 'editor') {
      current.interactionRequired = false
      current.error = cause instanceof Error ? cause.message : String(cause)
      if (request.op === 'snapshot') current.dirty = true
      else { current.dirty = true; if (request.op === 'status') current.unavailable = true }
      publish()
    }
    throw failure
  }
}
export function pluginHostRequest<T = Record<string, unknown>>(request: Record<string, unknown>): Promise<T> {
  return enqueue(() => requestNow<T>(request))
}
export function pluginHostCapabilities() {
  capabilities ||= invoke<PluginHostCapabilities>('plugin_host_capabilities').catch(() => ({ enabled: false, platform: '', formats: [], nativeEditor: false, experimental: true }))
  return capabilities
}
export function assertPluginProjectSupported(project: EditorSession, formats?: readonly string[], builtinEffects = false) {
  const reason = pluginProjectBlockReason(project, formats, builtinEffects)
  if (reason) throw new Error(String(i18n.global.t(reason === 'effects' ? 'editor.plugins.effectsBlocked' : 'editor.plugins.formatBlocked')))
}

async function ensureNow(project: EditorSession) {
  const hostCapabilities = await pluginHostCapabilities()
  assertPluginProjectSupported(project, hostCapabilities.formats || ['vst3'], hostCapabilities.builtinEffects === true)
  if (!hostCapabilities.enabled) throw new Error(String(i18n.global.t('editor.plugins.unavailable')))
  if (loaded?.unavailable) throw new Error(String(i18n.global.t('editor.plugins.stateReloadRequired')))
  if (loaded && loaded.project !== project && (loaded.dirty || loaded.error)) throw new Error(loaded.error || String(i18n.global.t('editor.plugins.stateCaptureUnavailable')))
  const signature = pluginProjectSignature(project)
  if (loaded?.project === project && !loaded.unavailable && loaded.signature === signature) return
  const op = loaded?.project === project && !loaded.unavailable ? 'update' : 'load'
  const previousSlots = op === 'update' && loaded ? projectPluginSlots(JSON.parse(loaded.signature) as EditorSession) : []
  const stateRestoreSlotIds = projectPluginSlots(project).filter(slot => previousSlots.some(previous => previous.id === slot.id
    && previous.path === slot.path && previous.pluginId === slot.pluginId && previous.state !== slot.state)).map(slot => slot.id)
  const response = await requestNow<Partial<PluginHostStatus>>({ op, project: JSON.parse(JSON.stringify(project)), projectId: project.id,
    ...(stateRestoreSlotIds.length ? { stateRestoreSlotIds } : {}) })
  if (op === 'load' || !loaded || loaded.project !== project) {
    loaded = { project, sessionId: response.sessionId || `session-${++sessionSequence}`, revision: response.stateRevision || 0,
      capturedRevision: -1, dirty: true, error: null, signature, unavailable: false, unavailablePlugins: response.unavailablePlugins || [], openEditors: response.openEditors || [], lastStatus: 0, lastFallback: Date.now() }
    publish()
  } else { loaded.signature = signature; loaded.error = null }
  scheduleMonitor()
}
export function ensurePluginSession(project: EditorSession) { return enqueue(() => ensureNow(project)) }

export function snapshotPluginStates(project: EditorSession, options: { force?: boolean; recovery?: boolean } = {}) {
  return enqueue(async () => {
    let current = loaded
    try {
    if (!current || current.project.id !== project.id || (options.recovery && current.project !== project)) return false
    if (current.unavailable) await requestNow({ op: 'status', projectId: project.id })
    // Honor explicit history/state restoration before capturing; never replace it with an older controller.
    if (!options.recovery && pluginProjectSignature(current.project) !== current.signature) await ensureNow(current.project)
    current = loaded
    if (!current || current.project.id !== project.id) return false
    if (!options.force && !current.dirty && !current.error) return false
    // Recovery captures the surviving graph before a failing project is changed again.
    // Its signature identifies the controllers that actually own these state blobs.
    const hostProject = options.recovery ? JSON.parse(current.signature) as EditorSession : current.project
    const expected = new Map(projectPluginSlots(hostProject).map(slot => [slot.id, { ...slot }]))
    const response = await requestNow<Partial<PluginHostStatus> & { states: Record<string, string> }>({ op: 'snapshot', projectId: project.id })
    if (loaded !== current || (response.projectId && response.projectId !== project.id)
      || (response.sessionId && response.sessionId !== current.sessionId)) throw new Error(String(i18n.global.t('editor.plugins.stateCaptureSuperseded')))
    if (!response.states || typeof response.states !== 'object' || Array.isArray(response.states)
      || Object.values(response.states).some(state => typeof state !== 'string')
      || [...expected.values()].some(slot => !slot.bypassed && typeof response.states[slot.id] !== 'string')) {
      throw new Error(String(i18n.global.t('editor.plugins.stateCaptureUnavailable')))
    }
    let changed = false
    const apply = (target: EditorSession) => {
      for (const slot of projectPluginSlots(target)) {
        const before = expected.get(slot.id)
        const state = response.states[slot.id]
        if (before && before.format === slot.format && before.path === slot.path && before.pluginId === slot.pluginId && before.state === slot.state && typeof state === 'string' && state !== slot.state) {
          // A captured blob describes the same controller state intent. Explicit
          // history/preset writes are detected separately when a queued control starts.
          const intent = stateIntent(slot)
          slot.state = state; intent.state = state; changed = true
        }
      }
    }
    const signatureBefore = pluginProjectSignature(current.project)
    apply(current.project)
    if (project !== current.project) apply(project)
    if (options.recovery) { apply(hostProject); current.signature = pluginProjectSignature(hostProject) }
    else if (signatureBefore === current.signature) current.signature = pluginProjectSignature(current.project)
    current.capturedRevision = response.stateRevision ?? current.revision
    current.dirty = current.revision > current.capturedRevision
    current.error = null
    current.lastFallback = Date.now()
    publish()
    return changed
    } catch (cause) {
      if (current && loaded === current) {
        current.dirty = true
        current.error = cause instanceof Error ? cause.message : String(cause)
        publish()
      }
      throw cause
    }
  })
}

export function unloadPluginSession(projectId: string, options: { discardUnsaved?: boolean } = {}) {
  return enqueue(async () => {
    const current = loaded
    if (!current || current.project.id !== projectId) return
    if (!options.discardUnsaved && (current.dirty || current.error)) throw new Error(current.error || String(i18n.global.t('editor.plugins.stateCaptureUnavailable')))
    await requestNow({ op: 'unload', projectId, ...(options.discardUnsaved ? { discardUnsaved: true, expectedSessionId: current.sessionId } : {}) })
    if (loaded === current) { loaded = null; publish() }
    if (monitor) { clearTimeout(monitor); monitor = null }
  })
}

export async function openPluginEditor(project: EditorSession, slotId: string, open = true) {
  await ensurePluginSession(project)
  return enqueue(async () => {
    const result = await requestNow<{ open?: boolean }>({ op: 'editor', slotId, open, projectId: project.id })
    if (loaded?.project === project && result.open !== undefined) {
      loaded.openEditors = result.open ? [...new Set([...loaded.openEditors, slotId])] : loaded.openEditors.filter(id => id !== slotId)
      loaded.dirty = true; publish(); scheduleMonitor()
    }
    return result
  })
}

function parameterSlotIdentity(slot: EditorPluginSlot) {
  return JSON.stringify([slot.format, slot.pluginId, slot.path, slot.bypassed, slot.classId, slot.auVersion, slot.isShellChild])
}

function parameterTarget(project: EditorSession, slotId: string) {
  const slot = projectPluginSlots(project).find(slot => slot.id === slotId)
  const session = loaded?.project === project ? loaded : null
  return { projectId: project.id, identity: slot && parameterSlotIdentity(slot), state: slot?.state,
    stateIntent: slot && stateIntent(slot).token, owner: loaded, session, sessionId: session?.sessionId }
}

function requireParameterTarget(project: EditorSession, slotId: string, target: ReturnType<typeof parameterTarget>, checkSession: boolean) {
  const slot = projectPluginSlots(project).find(slot => slot.id === slotId)
  if (project.id !== target.projectId || !slot || parameterSlotIdentity(slot) !== target.identity
    || (slot.state !== target.state && stateIntent(slot).token !== target.stateIntent)
    || (checkSession && target.session && (loaded !== target.session || loaded.sessionId !== target.sessionId))
    || (checkSession && !target.session && loaded && loaded !== target.owner && loaded.project !== project)) {
    throw new Error(String(i18n.global.t('editor.plugins.stateCaptureSuperseded')))
  }
}

function requireParameterSession(project: EditorSession, slotId: string, session: Session | null, identity?: string) {
  const slot = projectPluginSlots(project).find(slot => slot.id === slotId)
  const currentIdentity = slot && JSON.stringify([parameterSlotIdentity(slot), slot.state])
  if (!session || loaded !== session || session.project !== project || !slot || (identity !== undefined && identity !== currentIdentity)) {
    throw new Error(String(i18n.global.t('editor.plugins.stateCaptureSuperseded')))
  }
  return currentIdentity!
}

/** Generic controls share the transport queue and only address the current graph. */
export function getPluginParameters(project: EditorSession, slotId: string) {
  const target = parameterTarget(project, slotId)
  return enqueue(async () => {
    requireParameterTarget(project, slotId, target, true)
    await ensureNow(project)
    requireParameterTarget(project, slotId, target, false)
    const current = loaded
    const identity = requireParameterSession(project, slotId, current)
    const sessionId = current!.sessionId
    const response = await requestNow<PluginParameters>({ op: 'parameters', slotId, projectId: project.id })
    requireParameterSession(project, slotId, current, identity)
    if ((response.projectId && response.projectId !== project.id) || (response.sessionId && response.sessionId !== sessionId)
      || !Array.isArray(response.params) || !response.values || typeof response.values !== 'object' || Array.isArray(response.values)) {
      throw new Error(String(i18n.global.t('editor.plugins.parametersUnavailable')))
    }
    return response
  })
}

export function setPluginParameter(project: EditorSession, slotId: string, paramId: string, value: number) {
  const target = parameterTarget(project, slotId)
  return enqueue(async () => {
    if (!paramId || !Number.isFinite(value)) throw new Error(String(i18n.global.t('editor.plugins.invalidParameter')))
    requireParameterTarget(project, slotId, target, true)
    await ensureNow(project)
    requireParameterTarget(project, slotId, target, false)
    const current = loaded
    const identity = requireParameterSession(project, slotId, current)
    const sessionId = current!.sessionId
    const response = await requestNow<Partial<PluginHostStatus> & { value?: number }>({ op: 'param', slotId, paramId, value, projectId: project.id })
    requireParameterSession(project, slotId, current, identity)
    if ((response.projectId && response.projectId !== project.id) || (response.sessionId && response.sessionId !== sessionId)) {
      throw new Error(String(i18n.global.t('editor.plugins.stateCaptureSuperseded')))
    }
    current!.dirty = true
    current!.error = null
    publish()
    scheduleMonitor()
    return response
  })
}

/** Explicit user recovery only: the caller has acknowledged uncaptured edits may be lost. */
export function reloadPluginSession(project: EditorSession) {
  return enqueue(async () => {
    const previous = loaded
    loaded = null
    try { await ensureNow(project) }
    catch (cause) {
      loaded = previous
      if (previous) { previous.unavailable = true; previous.error = cause instanceof Error ? cause.message : String(cause); publish() }
      throw cause
    }
  })
}
