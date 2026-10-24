<script setup lang="ts">
import { computed, nextTick, onMounted, onScopeDispose, ref, watch } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { useI18n } from 'vue-i18n'
import { AddOutline, ArrowDownOutline, ArrowUpOutline, CloseOutline, FolderOpenOutline, OpenOutline, OptionsOutline, RefreshOutline, SearchOutline, TrashOutline } from '@vicons/ionicons5'
import { useEditorStore } from '@/stores/editor'
import { useEditorPlaybackStore } from '@/stores/editorPlayback'
import type { EditorSession } from '@/types/editor'
import { clonePluginChain, pluginDescriptorCategory, pluginDescriptorFormat, pluginDescriptorLabels, pluginDescriptorVariant, pluginSlotMatchesDescriptor } from '@/utils/editorPlugins'
import { observePluginSession, openPluginEditor, pluginHostCapabilities, type PluginDescriptor, type PluginHostCapabilities, type PluginScanReport, type PluginScanStatus, type PluginScanBlacklistEntry, type UnavailablePlugin } from '@/utils/pluginHost'
import EditorPluginParameters from './EditorPluginParameters.vue'

const props = defineProps<{ session: EditorSession; selectedTrackId: string | null }>()
const { t, locale } = useI18n()
const editor = useEditorStore()
const playback = useEditorPlaybackStore()
const capabilities = ref<PluginHostCapabilities | null>(null)
const busy = ref(false)
const scanning = ref(false)
const scanStatus = ref<PluginScanStatus | null>(null)
const scanBlacklist = ref<PluginScanBlacklistEntry[]>([])
const scanActionPending = ref<'skip' | 'cancel' | null>(null)
const scanStopRequested = ref(false)
const scanFeedback = ref('')
const managerOpen = ref(false)
const managerCard = ref<{ $el: HTMLElement } | null>(null)
const manageButton = ref<{ $el: HTMLElement } | null>(null)
const reloadConfirmOpen = ref(false)
const targetMenuOpen = ref(false)
const librarySearch = ref('')
const catalogGroupBy = ref<'vendor' | 'category' | 'format'>('vendor')
const feedback = ref('')
const error = ref('')
const descriptors = ref<PluginDescriptor[]>([])
const scanReport = ref<PluginScanReport | null>(null)
const unavailablePlugins = ref<UnavailablePlugin[]>([])
const relocatingSlotId = ref<string | null>(null)
const selectedPluginId = ref<string | null>(null)
const target = ref<string>('master')
const directoryDraft = ref('')
const directories = ref<string[]>([])
const opened = ref<string[]>([])
const parameterSlotId = ref<string | null>(null)
// Only restore sources explicitly selected through the current workflow.
const STORAGE_KEY = 'pymss-plugin-library-directories-v1'
let scanGeneration = 0
let disposed = false
let scanSequence = 0
let blacklistGeneration = 0
type ActiveScan = { id: string; generation: number; project: EditorSession; controlled: boolean; timer: ReturnType<typeof setTimeout> | null }
let activeScan: ActiveScan | null = null
const canSkipScan = computed(() => scanning.value && scanStatus.value?.phase === 'scanning' && Boolean(scanStatus.value?.canSkip && scanStatus.value.currentPath) && !scanActionPending.value && !scanStopRequested.value)
const canStopScan = computed(() => scanning.value && !scanActionPending.value && !scanStopRequested.value && !['finished', 'cancelled'].includes(scanStatus.value?.phase || ''))
const scanPhaseLabel = computed(() => t(scanStatus.value?.phase === 'scanning' ? 'editor.plugins.scanPhaseScanning'
  : scanStatus.value?.phase === 'finished' ? 'editor.plugins.scanPhaseFinished'
  : scanStatus.value?.phase === 'cancelled' ? 'editor.plugins.scanPhaseCancelled' : 'editor.plugins.scanPhaseCollecting'))
const workflowStep = computed(() => !directories.value.length ? 1 : !scanReport.value ? 2 : 3)
const canChooseAudioUnits = computed(() => capabilities.value?.platform === 'macos' && capabilities.value.formats.includes('au'))
const targetOptions = computed(() => [
  { label: t('editor.plugins.masterOutput'), value: 'master' },
  ...props.session.tracks.map(track => ({ label: track.name, value: track.id })),
])
const targetLabel = computed(() => targetOptions.value.find(option => option.value === target.value)?.label || t('editor.plugins.masterOutput'))
const chain = computed(() => target.value === 'master'
  ? props.session.pluginChain || []
  : props.session.tracks.find(track => track.id === target.value)?.pluginChain || [])
const descriptorKey = (plugin: PluginDescriptor) => JSON.stringify([plugin.id, plugin.path])
const relocatingSlot = computed(() => chain.value.find(slot => slot.id === relocatingSlotId.value))
const operationError = computed(() => error.value || editor.pluginStateError || playback.error)
const categoryLabels = computed(() => ({
  eq: t('editor.plugins.categories.eq'), dynamics: t('editor.plugins.categories.dynamics'),
  pitch: t('editor.plugins.categories.pitch'), reverb: t('editor.plugins.categories.reverb'),
  delay: t('editor.plugins.categories.delay'), modulation: t('editor.plugins.categories.modulation'),
  distortion: t('editor.plugins.categories.distortion'), dither: t('editor.plugins.categories.dither'),
  instrument: t('editor.plugins.categories.instrument'), analyzer: t('editor.plugins.categories.analyzer'),
  mastering: t('editor.plugins.categories.mastering'), spatial: t('editor.plugins.categories.spatial'),
  ambience: t('editor.plugins.categories.ambience'), restoration: t('editor.plugins.categories.restoration'),
  offline: t('editor.plugins.categories.offline'), generator: t('editor.plugins.categories.generator'),
  tools: t('editor.plugins.categories.tools'), other: t('editor.plugins.categories.other'),
}))
const pluginOptions = computed(() => {
  const plugins = descriptors.value.filter(plugin => !relocatingSlot.value || pluginSlotMatchesDescriptor(relocatingSlot.value, plugin))
  const labels = pluginDescriptorLabels(plugins, Boolean(relocatingSlot.value))
  const query = librarySearch.value.trim().toLocaleLowerCase()
  return plugins.map((plugin, index) => {
    const variant = pluginDescriptorVariant(plugin)
    const category = pluginDescriptorCategory(plugin)
    const baseLabel = `${plugin.name} · ${variant}${plugin.vendor ? ` · ${plugin.vendor}` : ''}`
    return { label: labels[index], value: descriptorKey(plugin), plugin, variant, category,
      detail: labels[index].startsWith(`${baseLabel} · `) ? labels[index].slice(baseLabel.length + 3) : '',
      disabled: plugin.isInstrument === true || !capabilities.value?.formats.includes(pluginDescriptorFormat(plugin)) }
  })
    .filter(option => !query || `${option.label} ${pluginDescriptorFormat(option.plugin)} ${option.category} ${categoryLabels.value[option.category]} ${option.plugin.subCategories?.join(' ') || ''}`.toLocaleLowerCase().includes(query))
})
const catalogGroups = computed(() => {
  const groups = new Map<string, { key: string; label: string; unknown: boolean; plugins: typeof pluginOptions.value }>()
  const collator = new Intl.Collator(locale.value, { numeric: true, sensitivity: 'base' })
  for (const option of pluginOptions.value) {
    const vendor = option.plugin.vendor?.trim() || ''
    const key = catalogGroupBy.value === 'vendor' ? `vendor:${vendor.toLowerCase()}`
      : catalogGroupBy.value === 'category' ? `category:${option.category}` : `format:${option.variant}`
    const label = catalogGroupBy.value === 'vendor' ? vendor || t('editor.plugins.unknownVendor')
      : catalogGroupBy.value === 'category' ? categoryLabels.value[option.category] : option.variant
    const unknown = catalogGroupBy.value === 'vendor' ? !vendor : catalogGroupBy.value === 'category' && option.category === 'other'
    if (!groups.has(key)) groups.set(key, { key, label, unknown, plugins: [] })
    groups.get(key)!.plugins.push(option)
  }
  for (const group of groups.values()) group.plugins.sort((a, b) => collator.compare(a.plugin.name, b.plugin.name) || collator.compare(a.variant, b.variant) || collator.compare(a.plugin.path, b.plugin.path))
  return [...groups.values()].sort((a, b) => Number(a.unknown) - Number(b.unknown) || collator.compare(a.label, b.label))
})
const selectedDescriptor = computed(() => descriptors.value.find(plugin => descriptorKey(plugin) === selectedPluginId.value))
const stopObservingSession = observePluginSession(host => {
  if (host?.project === props.session) { opened.value = [...host.openEditors]; unavailablePlugins.value = [...host.unavailablePlugins] }
  else { opened.value = []; unavailablePlugins.value = [] }
})
onScopeDispose(stopObservingSession)
watch(() => props.selectedTrackId, id => { target.value = id || 'master' }, { immediate: true })
watch(() => props.session, () => { managerOpen.value = false; reloadConfirmOpen.value = false; targetMenuOpen.value = false; opened.value = []; unavailablePlugins.value = []; error.value = ''; invalidateCatalog(); relocatingSlotId.value = null; parameterSlotId.value = null; target.value = props.selectedTrackId || 'master' })
watch(targetOptions, options => { if (!options.some(option => option.value === target.value)) target.value = 'master' })
watch(target, () => { reloadConfirmOpen.value = false; targetMenuOpen.value = false; relocatingSlotId.value = null; selectedPluginId.value = null; parameterSlotId.value = null; feedback.value = '' })
watch(directories, invalidateCatalog, { deep: true, flush: 'sync' })
watch(pluginOptions, options => { if (!options.some(option => option.value === selectedPluginId.value && !option.disabled)) selectedPluginId.value = null })
onMounted(async () => {
  window.addEventListener('resize', recenterManager)
  capabilities.value = await pluginHostCapabilities()
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]')
    if (Array.isArray(stored)) directories.value = [...new Set(stored.filter((path): path is string => typeof path === 'string' && Boolean(path.trim()) && (path !== 'au:system' || canChooseAudioUnits.value)))]
  } catch { /* An invalid preference must not prevent opening the inspector. */ }
  if (capabilities.value?.scanControl) await refreshBlacklist()
})
onScopeDispose(() => window.removeEventListener('resize', recenterManager))
onScopeDispose(() => { disposed = true; cancelActiveScan(); scanGeneration++; blacklistGeneration++ })

function invalidateCatalog() {
  cancelActiveScan()
  scanGeneration++
  error.value = ''
  scanReport.value = null
  descriptors.value = []
  selectedPluginId.value = null
  librarySearch.value = ''
  feedback.value = ''
  scanFeedback.value = ''
}
function directoryLabel(path: string) {
  return path === 'au:system' ? t('editor.plugins.systemAudioUnits') : path.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) || path
}
function scanItemName(path: string, name?: string | null) {
  return path === 'au:system' ? directoryLabel(path) : name || directoryLabel(path)
}

function openManager(slotId?: string) {
  if (slotId) parameterSlotId.value = slotId
  managerOpen.value = true
  if (capabilities.value?.scanControl) void refreshBlacklist()
}
function focusManager() {
  const element = managerCard.value?.$el
  if (managerOpen.value && element && !element.contains(document.activeElement)) element.focus({ preventScroll: true })
}
function recenterManager() {
  const element = managerCard.value?.$el
  if (!managerOpen.value || !element) return
  element.style.top = ''
  element.style.left = ''
}
function onManagerKeyCapture(event: KeyboardEvent) {
  if (event.key !== 'Escape' || event.defaultPrevented) return
  if (!targetMenuOpen.value && !reloadConfirmOpen.value) return
  targetMenuOpen.value = false
  reloadConfirmOpen.value = false
  event.preventDefault()
  event.stopPropagation()
}
function onManagerKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape' || event.defaultPrevented) return
  const element = event.target instanceof Element ? event.target : null
  if (element?.closest('[data-plugin-confirm-trigger][aria-expanded="true"]')) {
    reloadConfirmOpen.value = false
    return
  }
  closeManager()
}
function guardConfirmationKeys(event: KeyboardEvent) {
  event.stopPropagation()
  if (event.key === 'Escape') {
    event.preventDefault()
    reloadConfirmOpen.value = false
  }
}
function closeManager() {
  const restoreFocus = managerCard.value?.$el.contains(document.activeElement)
  reloadConfirmOpen.value = false
  targetMenuOpen.value = false
  managerOpen.value = false
  if (restoreFocus) void nextTick(() => manageButton.value?.$el.focus({ preventScroll: true }))
}

async function run(action: () => void | Promise<void>) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  const project = props.session
  try { await action() }
  catch (cause) { if (props.session === project) error.value = cause instanceof Error ? cause.message : String(cause) }
  finally { busy.value = false }
}
function saveDirectories() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(directories.value)) }
  catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause) }
}
function addDirectory() {
  const path = directoryDraft.value.trim()
  if (!path) return
  if (!directories.value.includes(path)) directories.value.push(path)
  directoryDraft.value = ''
  saveDirectories()
}
function removeDirectory(index: number) {
  if (busy.value) return
  directories.value.splice(index, 1)
  saveDirectories()
}
async function browseDirectory() {
  if (busy.value) return
  const project = props.session
  let chosen = false
  await run(async () => {
    const path = await invoke<string | null>('pick_input_folder')
    if (path && !disposed) { directoryDraft.value = path; addDirectory(); chosen = true }
  })
  if (chosen && !disposed && props.session === project) await scan()
}
async function chooseAudioUnits() {
  if (busy.value || !canChooseAudioUnits.value) return
  if (!directories.value.includes('au:system')) directories.value.push('au:system')
  saveDirectories()
  await scan()
}
function isCurrentScan(scan: ActiveScan) {
  return !disposed && activeScan === scan && scan.generation === scanGeneration && props.session === scan.project
}
function clearScanPoll(scan: ActiveScan) {
  if (scan.timer) clearTimeout(scan.timer)
  scan.timer = null
}
function cancelActiveScan() {
  const scan = activeScan
  if (!scan) return
  clearScanPoll(scan)
  activeScan = null
  busy.value = false
  scanning.value = false
  scanStatus.value = null
  scanActionPending.value = null
  scanStopRequested.value = false
  if (scan.controlled) void invoke('plugin_host_cancel_scan', { scanId: scan.id }).catch(() => undefined)
}
async function pollScanStatus(scan: ActiveScan) {
  if (!isCurrentScan(scan)) return
  try {
    const status = await invoke<PluginScanStatus | null>('plugin_host_scan_status', { scanId: scan.id })
    if (!isCurrentScan(scan)) return
    if (status?.scanId === scan.id) scanStatus.value = status
  } catch (cause) {
    if (isCurrentScan(scan)) {
      scanStatus.value = null
      error.value = cause instanceof Error ? cause.message : String(cause)
    }
  } finally {
    if (isCurrentScan(scan) && !['finished', 'cancelled'].includes(scanStatus.value?.phase || '')) {
      scan.timer = setTimeout(() => { scan.timer = null; void pollScanStatus(scan) }, 400)
    }
  }
}
async function refreshBlacklist(project = props.session, generation = scanGeneration) {
  if (!capabilities.value?.scanControl || disposed) return
  const refresh = ++blacklistGeneration
  try {
    const entries = await invoke<PluginScanBlacklistEntry[]>('plugin_host_scan_blacklist')
    if (!disposed && props.session === project && scanGeneration === generation && refresh === blacklistGeneration) scanBlacklist.value = entries
  } catch (cause) {
    if (!disposed && props.session === project && scanGeneration === generation && refresh === blacklistGeneration) error.value = cause instanceof Error ? cause.message : String(cause)
  }
}
async function skipCurrentScanPlugin() {
  const scan = activeScan
  const status = scanStatus.value
  if (!scan?.controlled || !isCurrentScan(scan) || !canSkipScan.value || !status?.currentPath) return
  const path = status.currentPath
  const name = scanItemName(path, status.currentName)
  scanActionPending.value = 'skip'
  try {
    const result = await invoke<{ skipped: boolean }>('plugin_host_skip_scan', { scanId: scan.id, path })
    if (!isCurrentScan(scan)) return
    scanFeedback.value = t(result.skipped ? 'editor.plugins.scanPluginSkipped' : 'editor.plugins.scanPluginAlreadyFinished', { name })
    if (result.skipped) void refreshBlacklist(scan.project, scan.generation)
  } catch (cause) {
    if (isCurrentScan(scan)) error.value = cause instanceof Error ? cause.message : String(cause)
  } finally { if (isCurrentScan(scan)) scanActionPending.value = null }
}
async function stopScan() {
  const scan = activeScan
  if (!scan?.controlled || !isCurrentScan(scan) || !canStopScan.value) return
  scanActionPending.value = 'cancel'
  scanStopRequested.value = true
  try {
    const result = await invoke<{ cancelled: boolean }>('plugin_host_cancel_scan', { scanId: scan.id })
    if (!isCurrentScan(scan)) return
    if (!result.cancelled) scanStopRequested.value = false
    scanFeedback.value = t(result.cancelled ? 'editor.plugins.scanStopping' : 'editor.plugins.scanPhaseFinished')
  } catch (cause) {
    if (isCurrentScan(scan)) {
      scanStopRequested.value = false
      error.value = cause instanceof Error ? cause.message : String(cause)
    }
  } finally { if (isCurrentScan(scan)) scanActionPending.value = null }
}
async function removeBlacklistedPlugin(path: string) {
  if (busy.value || !capabilities.value?.scanControl) return
  await run(async () => {
    const project = props.session
    const generation = scanGeneration
    await invoke('plugin_host_remove_scan_blacklist', { path })
    if (disposed || props.session !== project || scanGeneration !== generation) return
    // A list fetched before removal completed must not put the removed entry back.
    blacklistGeneration++
    scanBlacklist.value = scanBlacklist.value.filter(entry => entry.path !== path)
    scanFeedback.value = t('editor.plugins.scanBlacklistRemoved')
  })
}
async function scan(force = false) {
  if (busy.value || disposed || !directories.value.length) return
  const current: ActiveScan = { id: `plugin_scan_${Date.now().toString(36)}_${++scanSequence}_${crypto.randomUUID()}`,
    generation: ++scanGeneration, project: props.session, controlled: capabilities.value?.scanControl === true, timer: null }
  activeScan = current
  busy.value = true
  scanning.value = true
  scanStatus.value = null
  scanActionPending.value = null
  scanStopRequested.value = false
  error.value = ''
  scanFeedback.value = ''
  // Start observation before invoking the long-running scan; control commands use independent IPC calls.
  if (current.controlled) void pollScanStatus(current)
  try {
    const report = await invoke<PluginScanReport>('plugin_host_scan_report', { paths: [...directories.value], force,
      ...(current.controlled ? { scanId: current.id } : {}) })
    if (!isCurrentScan(current)) return
    scanReport.value = report
    descriptors.value = report.plugins
    if (!descriptors.value.some(plugin => descriptorKey(plugin) === selectedPluginId.value)) selectedPluginId.value = null
    if (current.controlled) {
      if (report.blacklisted?.length) scanBlacklist.value = [...new Map([...scanBlacklist.value, ...report.blacklisted].map(entry => [entry.path, entry])).values()]
      void refreshBlacklist(current.project, current.generation)
    }
  } catch (cause) {
    if (isCurrentScan(current)) error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    if (activeScan === current) {
      clearScanPoll(current)
      activeScan = null
      busy.value = false
      scanning.value = false
      scanActionPending.value = null
      scanStatus.value = null
    }
  }
}
async function mutate(change: (slots: typeof chain.value) => void, recovery = false) {
  await run(async () => {
    const project = props.session
    const trackId = target.value === 'master' ? null : target.value
    await editor.capturePluginState(project, true, recovery)
    if (props.session !== project) return
    const track = trackId ? props.session.tracks.find(track => track.id === trackId) : null
    if (trackId && !track) return
    const currentChain = track ? track.pluginChain : props.session.pluginChain
    const slots = clonePluginChain(currentChain) || []
    change(slots)
    if (JSON.stringify(slots) === JSON.stringify(currentChain || [])) return
    editor.setPluginChain(trackId, slots)
  })
}
function beginRelocation(slotId: string) {
  relocatingSlotId.value = slotId
  selectedPluginId.value = null
  librarySearch.value = ''
}
async function relocatePlugin() {
  const plugin = descriptors.value.find(value => descriptorKey(value) === selectedPluginId.value)
  const slot = relocatingSlot.value
  if (!plugin || !slot) return
  if (!pluginSlotMatchesDescriptor(slot, plugin)) { error.value = t('editor.plugins.relocationMismatch'); return }
  await mutate(slots => {
    const current = slots.find(value => value.id === slot.id)
    if (!current || !pluginSlotMatchesDescriptor(current, plugin)) throw new Error(t('editor.plugins.relocationMismatch'))
    current.path = plugin.path
    relocatingSlotId.value = null
    selectedPluginId.value = null
  }, true)
}
async function addPlugin() {
  const plugin = descriptors.value.find(value => descriptorKey(value) === selectedPluginId.value)
  if (!plugin || plugin.isInstrument === true || !capabilities.value?.formats.includes(pluginDescriptorFormat(plugin))) return
  const project = props.session
  const trackId = target.value === 'master' ? null : target.value
  const destination = targetLabel.value
  const slotId = `plugin_${crypto.randomUUID()}`
  await mutate(slots => slots.push({ id: slotId, format: pluginDescriptorFormat(plugin), pluginId: plugin.id,
    name: plugin.name, path: plugin.path, bypassed: false,
    ...(plugin.auVersion ? { auVersion: plugin.auVersion } : {}),
    ...(plugin.isShellChild ? { isShellChild: true } : {}) }))
  const slots = trackId ? project.tracks.find(track => track.id === trackId)?.pluginChain : project.pluginChain
  if (props.session === project && slots?.some(slot => slot.id === slotId)) feedback.value = t('editor.plugins.addedToTarget', { name: plugin.name, target: destination })
}
function setPluginBypassed(slotId: string, bypassed: boolean) {
  return mutate(slots => {
    const slot = slots.find(slot => slot.id === slotId)
    if (slot) slot.bypassed = bypassed
  }, bypassed)
}
function removePlugin(slotId: string) {
  return mutate(slots => {
    const index = slots.findIndex(slot => slot.id === slotId)
    if (index >= 0) slots.splice(index, 1)
  }, true)
}
function movePlugin(slotId: string, offset: number) {
  return mutate(slots => {
    const index = slots.findIndex(slot => slot.id === slotId)
    if (index < 0) return
    const destination = index + offset
    if (destination < 0 || destination >= slots.length) return
    const [slot] = slots.splice(index, 1)
    slots.splice(destination, 0, slot)
  })
}
async function toggleEditor(slotId: string) {
  await run(async () => {
    const project = props.session
    const open = !opened.value.includes(slotId)
    await openPluginEditor(project, slotId, open)
    if (props.session !== project) return
    opened.value = open ? [...opened.value, slotId] : opened.value.filter(id => id !== slotId)
    if (!open) {
      await editor.capturePluginState(project, true)
      if (props.session === project) editor.scheduleSave()
    }
  })
}
</script>

<template>
  <section v-if="capabilities?.enabled" class="plugin-panel" :aria-busy="busy">
    <n-button ref="manageButton" size="small" block secondary :type="operationError ? 'warning' : 'default'" aria-haspopup="dialog" :aria-expanded="managerOpen" :title="operationError ? t('editor.plugins.attentionRequired') : t('editor.plugins.manage')" @click="openManager()"><template #icon><n-icon :component="OptionsOutline" /></template>{{ t('editor.plugins.title') }}</n-button>
  </section>

  <n-modal v-if="capabilities?.enabled" v-model:show="managerOpen" draggable
    :show-mask="false" :mask-closable="false" :trap-focus="false" :block-scroll="false"
    :auto-focus="false" :close-on-esc="false" transform-origin="center" @after-enter="focusManager">
    <template #default="{ draggableClass }">
      <n-card ref="managerCard" class="plugin-manager n-modal" :header-class="draggableClass" content-class="plugin-manager__content" footer-class="plugin-manager__error" :bordered="false" closable tabindex="-1"
        role="dialog" :aria-modal="false" :aria-label="t('editor.plugins.managerTitle')"
        @close="closeManager" @keydown.capture="onManagerKeyCapture" @keydown.stop="onManagerKeydown"
        @pointerdown.stop @click.stop @dblclick.stop @contextmenu.stop @wheel.stop>
        <template #header>
          <div class="plugin-manager__heading">
            <strong>{{ t('editor.plugins.managerTitle') }}</strong>
            <span>{{ targetLabel }} · {{ t('editor.plugins.chainCount', { count: chain.length }) }}</span>
          </div>
        </template>
        <template #header-extra><span class="plugin-manager__badge">{{ t('editor.plugins.experimental') }}</span></template>
        <ol class="plugin-manager__steps" :aria-label="t('editor.plugins.usageSteps')">
          <li v-for="(label, index) in [t('editor.plugins.stepChoose'), t('editor.plugins.stepScan'), t('editor.plugins.stepAdd')]" :key="label" :aria-current="workflowStep === index + 1 ? 'step' : undefined" :class="{ 'plugin-manager__step--done': workflowStep > index + 1 }"><span>{{ index + 1 }}</span>{{ label }}</li>
        </ol>
        <div class="plugin-manager__body" :aria-busy="busy">
          <section class="plugin-manager__library" :class="{ 'plugin-manager__library--scan-controls': capabilities.scanControl }" :aria-label="t('editor.plugins.library')">
            <div class="plugin-manager__section-heading">
              <div><strong>{{ t('editor.plugins.library') }}</strong><span v-if="scanReport" class="plugin-manager__library-count">{{ descriptors.length }}</span></div>
              <n-button v-if="directories.length" size="small" secondary :loading="scanning" :disabled="busy" @click="scan()"><template #icon><n-icon :component="RefreshOutline" /></template>{{ t('editor.plugins.scan') }}</n-button>
            </div>
            <div class="plugin-manager__sources" :class="{ 'plugin-manager__sources--empty': !directories.length }">
              <div class="plugin-manager__source-toolbar">
                <span v-if="directories.length">{{ t('editor.plugins.customDirectoryCount', { count: directories.length }) }}</span>
                <strong v-else>{{ t('editor.plugins.chooseDirectoryFirst') }}</strong>
                <n-button size="small" :type="directories.length ? 'default' : 'primary'" :disabled="busy" @click="browseDirectory"><template #icon><n-icon :component="FolderOpenOutline" /></template>{{ directories.length ? t('editor.plugins.addDirectory') : t('editor.plugins.chooseDirectory') }}</n-button>
              </div>
              <p v-if="!directories.length" class="plugin-panel__hint">{{ t('editor.plugins.chooseDirectoryHint') }}</p>
              <div v-if="directories.length" class="plugin-manager__directories">
                <div v-for="(path, index) in directories" :key="path" class="plugin-panel__directory">
                  <span :title="path"><strong>{{ directoryLabel(path) }}</strong><small v-if="path !== 'au:system'">{{ path }}</small><small v-else class="plugin-manager__au-source-hint">{{ t('editor.plugins.scanAudioUnitsHint') }}</small></span>
                  <n-button size="tiny" quaternary :disabled="busy" :aria-label="t('editor.plugins.removeDirectory')" @click="removeDirectory(index)"><template #icon><n-icon :component="CloseOutline" /></template></n-button>
                </div>
              </div>
              <n-button v-if="canChooseAudioUnits && !directories.includes('au:system')" size="small" text :disabled="busy" @click="chooseAudioUnits">{{ t('editor.plugins.chooseAudioUnits') }}</n-button>
            </div>
            <div v-if="scanning && capabilities.scanControl" class="plugin-manager__scan-progress" :aria-label="t('editor.plugins.scanProgress')">
              <div class="plugin-manager__scan-progress-heading"><strong role="status">{{ scanPhaseLabel }}</strong><span>{{ t('editor.plugins.scanCompletedCount', { completed: scanStatus?.completed || 0, total: scanStatus?.total || 0 }) }}</span></div>
              <div v-if="scanStatus?.currentPath" class="plugin-manager__scan-current" :title="scanStatus.currentPath"><strong>{{ scanItemName(scanStatus.currentPath, scanStatus.currentName) }}</strong><small>{{ scanStatus.currentPath }}</small></div>
              <span v-if="scanStatus?.currentPath" class="plugin-panel__hint">{{ t('editor.plugins.scanElapsed', { seconds: Math.floor(scanStatus.elapsedMs / 1000) }) }}</span>
              <p class="plugin-panel__hint">{{ t('editor.plugins.scanTimeoutHint') }}</p>
              <p class="plugin-panel__hint">{{ t(scanStatus?.currentPath === 'au:system' ? 'editor.plugins.scanAudioUnitsHint' : 'editor.plugins.scanPackageHint') }}</p>
              <div class="plugin-manager__scan-control-actions">
                <n-button size="small" secondary type="warning" :disabled="!canSkipScan" :loading="scanActionPending === 'skip'" @click="skipCurrentScanPlugin">{{ t('editor.plugins.skipScanPlugin') }}</n-button>
                <n-button size="small" secondary :disabled="!canStopScan" :loading="scanActionPending === 'cancel'" @click="stopScan">{{ t('editor.plugins.stopScan') }}</n-button>
              </div>
            </div>
            <p v-if="scanFeedback" class="plugin-manager__feedback" role="status">{{ scanFeedback }}</p>
            <p v-if="scanReport?.cancelled" class="plugin-panel__hint" role="status">{{ t('editor.plugins.scanCancelledHint') }}</p>
            <details v-if="capabilities.scanControl" class="plugin-manager__blacklist">
              <summary>{{ t('editor.plugins.scanBlacklistTitle', { count: scanBlacklist.length }) }}</summary>
              <p class="plugin-panel__hint">{{ t('editor.plugins.scanBlacklistHint') }}</p>
              <p v-if="!scanBlacklist.length" class="plugin-panel__hint">{{ t('editor.plugins.scanBlacklistEmpty') }}</p>
              <div v-else class="plugin-manager__blacklist-list">
                <div v-for="entry in scanBlacklist" :key="entry.path" class="plugin-manager__blacklist-entry">
                  <span :title="entry.path"><strong>{{ scanItemName(entry.path, entry.name) }}</strong><small>{{ entry.path }}</small><small>{{ t(entry.reason === 'timeout' ? 'editor.plugins.scanBlacklistTimeout' : 'editor.plugins.scanBlacklistManual') }}</small></span>
                  <n-button size="tiny" secondary :disabled="busy" :aria-label="t('editor.plugins.removeScanBlacklistNamed', { name: scanItemName(entry.path, entry.name) })" @click="removeBlacklistedPlugin(entry.path)">{{ t('editor.plugins.removeScanBlacklist') }}</n-button>
                </div>
              </div>
            </details>
            <div v-if="scanReport?.failures.length" class="plugin-panel__scan-failures" role="status">
              <div class="plugin-manager__scan-actions"><strong>{{ t('editor.plugins.scanFailures', { count: scanReport.failures.length }) }}</strong><n-button size="tiny" :disabled="busy" @click="scan(true)">{{ t('editor.plugins.retryScan') }}</n-button></div>
              <details><summary>{{ t('editor.plugins.scanFailureDetails') }}</summary><p v-for="failure in scanReport.failures" :key="failure.path" :title="failure.path"><span>{{ failure.path }}</span>{{ failure.message }}</p></details>
            </div>
            <div v-if="relocatingSlot" class="plugin-manager__relocation"><p>{{ t('editor.plugins.relocationHint', { name: relocatingSlot.name || relocatingSlot.pluginId }) }}</p><n-button size="tiny" :disabled="busy" @click="relocatingSlotId = null; selectedPluginId = null">{{ t('common.cancel') }}</n-button></div>
            <n-input v-if="descriptors.length" v-model:value="librarySearch" clearable :placeholder="t('editor.plugins.searchLibrary')" :disabled="busy"><template #prefix><n-icon :component="SearchOutline" /></template></n-input>
            <div v-if="descriptors.length" class="plugin-manager__group-controls">
              <span>{{ t('editor.plugins.groupBy') }}</span>
              <n-radio-group v-model:value="catalogGroupBy" size="small" :disabled="busy" :aria-label="t('editor.plugins.groupBy')">
                <n-radio-button value="vendor">{{ t('editor.plugins.groupVendor') }}</n-radio-button>
                <n-radio-button value="category">{{ t('editor.plugins.groupCategory') }}</n-radio-button>
                <n-radio-button value="format">{{ t('editor.plugins.groupFormat') }}</n-radio-button>
              </n-radio-group>
            </div>
            <div class="plugin-manager__catalog" :aria-label="t('editor.plugins.selectPlugin')" :aria-busy="busy">
              <section v-for="group in catalogGroups" :key="group.key" class="plugin-manager__group" :aria-label="group.label">
              <div class="plugin-manager__group-heading"><strong>{{ group.label }}</strong><span>{{ group.plugins.length }}</span></div>
              <button v-for="option in group.plugins" :key="option.value" type="button" class="plugin-manager__plugin" :class="{ 'plugin-manager__plugin--selected': selectedPluginId === option.value }" :disabled="busy || option.disabled" :aria-pressed="selectedPluginId === option.value" :aria-label="option.label" :title="option.label" @click="selectedPluginId = option.value">
                <span class="plugin-manager__plugin-icon"><n-icon :component="OptionsOutline" :size="19" /></span>
                <span class="plugin-manager__plugin-info"><strong>{{ option.plugin.name }}</strong><small>{{ catalogGroupBy === 'vendor' ? categoryLabels[option.category] : option.plugin.vendor || t('editor.plugins.unknownVendor') }}<template v-if="option.disabled"> · {{ t('editor.plugins.unsupportedPlugin') }}</template></small><small v-if="option.detail" class="plugin-manager__plugin-identity">{{ option.detail }}</small></span>
                <span class="plugin-manager__format">{{ option.variant }}</span>
              </button>
              </section>
              <div v-if="!pluginOptions.length" class="plugin-manager__empty plugin-manager__empty--library">
                <n-icon :component="SearchOutline" :size="26" />
                <strong>{{ scanning ? t('editor.plugins.recognizing') : !directories.length ? t('editor.plugins.noDirectorySelected') : librarySearch.trim() ? t('editor.plugins.noPluginMatches') : scanReport ? t('editor.plugins.noPluginsFound') : t('editor.plugins.scanToDiscover') }}</strong>
                <p>{{ !directories.length ? t('editor.plugins.supportedFormats', { formats: capabilities.formats.map(format => format.toUpperCase()).join(' / ') }) : librarySearch.trim() ? t('editor.plugins.adjustSearch') : t('editor.plugins.checkLocations') }}</p>
              </div>
            </div>
            <div v-if="scanReport && descriptors.length" class="plugin-manager__library-footer">
              <span class="plugin-panel__hint" role="status">{{ t('editor.plugins.scanSummary', { scanned: scanReport.scanned, cached: scanReport.cached, found: scanReport.plugins.length }) }}</span>
              <div class="plugin-manager__add-row">
                <div class="plugin-manager__selection"><strong>{{ selectedDescriptor?.name || t('editor.plugins.selectPlugin') }}</strong><span :title="selectedDescriptor?.path">{{ selectedDescriptor?.path || t('editor.plugins.selectionHint') }}</span></div>
                <n-button v-if="relocatingSlot" type="primary" :disabled="busy || !selectedPluginId" @click="relocatePlugin">{{ t('editor.plugins.applyLocation') }}</n-button>
                <n-button v-else class="plugin-manager__add-button" type="primary" :disabled="busy || !selectedPluginId" @click="addPlugin"><template #icon><n-icon :component="AddOutline" /></template>{{ t('editor.plugins.addPlugin', { name: targetLabel }) }}</n-button>
              </div>
            </div>
          </section>

          <section class="plugin-manager__chain" :aria-label="t('editor.plugins.chainTitle')">
            <div class="plugin-manager__section-heading">
              <strong>{{ t('editor.plugins.chainTitle') }}</strong>
              <span>{{ t('editor.plugins.chainCount', { count: chain.length }) }}</span>
            </div>
            <label class="plugin-manager__target-label">{{ t('editor.plugins.destination') }}</label>
            <n-select v-model:value="target" v-model:show="targetMenuOpen" :options="targetOptions" :disabled="busy" :to="managerCard?.$el" :aria-label="t('editor.plugins.target')" />
            <p v-if="chain.length" class="plugin-panel__hint">{{ t('editor.plugins.editingHint') }}</p>
            <p v-if="feedback" class="plugin-manager__feedback" role="status">{{ feedback }}</p>
            <div v-if="!chain.length" class="plugin-manager__empty">
              <n-icon :component="OptionsOutline" :size="28" />
              <strong>{{ t('editor.plugins.emptyChain') }}</strong>
              <p>{{ t('editor.plugins.emptyChainHint') }}</p>
            </div>
            <div class="plugin-manager__slots">
            <div v-for="(slot, index) in chain" :key="slot.id" class="plugin-panel__slot" :class="{ 'plugin-panel__slot--bypassed': slot.bypassed }">
              <div class="plugin-manager__slot-heading">
                <span class="plugin-manager__slot-number">{{ index + 1 }}</span>
                <strong :title="slot.path">{{ slot.name || slot.pluginId }}</strong>
                <span class="plugin-manager__format">{{ pluginDescriptorVariant({ ...slot, id: slot.pluginId }) }}</span>
                <n-checkbox :checked="slot.bypassed" :disabled="busy" :title="t('editor.plugins.bypassHint')" @update:checked="(value: boolean) => setPluginBypassed(slot.id, value)">{{ t('editor.plugins.bypass') }}</n-checkbox>
              </div>
              <div class="plugin-manager__slot-actions">
                <n-button size="small" secondary :type="opened.includes(slot.id) ? 'primary' : 'default'" :disabled="busy || !capabilities.nativeEditor || !(capabilities.nativeEditorFormats || ['vst3']).includes(slot.format)" @click="toggleEditor(slot.id)"><template #icon><n-icon :component="OpenOutline" /></template>{{ opened.includes(slot.id) ? t('editor.plugins.closeEditor') : t('editor.plugins.openEditor') }}</n-button>
                <n-button size="small" quaternary :type="parameterSlotId === slot.id ? 'primary' : 'default'" :aria-expanded="parameterSlotId === slot.id" :disabled="busy || !capabilities.formats.includes(slot.format) || unavailablePlugins.some(item => item.slotId === slot.id)" @click="parameterSlotId = parameterSlotId === slot.id ? null : slot.id">{{ t('editor.plugins.parameters') }}</n-button>
                <div class="plugin-manager__slot-tools">
                  <n-button size="small" quaternary :disabled="busy || index === 0" :title="t('editor.plugins.moveUp')" :aria-label="t('editor.plugins.moveUp')" @click="movePlugin(slot.id, -1)"><template #icon><n-icon :component="ArrowUpOutline" /></template></n-button>
                  <n-button size="small" quaternary :disabled="busy || index === chain.length - 1" :title="t('editor.plugins.moveDown')" :aria-label="t('editor.plugins.moveDown')" @click="movePlugin(slot.id, 1)"><template #icon><n-icon :component="ArrowDownOutline" /></template></n-button>
                  <n-button v-if="slot.format !== 'au'" size="small" quaternary :disabled="busy || !capabilities.formats.includes(slot.format)" :title="t('editor.plugins.relocate')" :aria-label="t('editor.plugins.relocate')" @click="beginRelocation(slot.id)"><template #icon><n-icon :component="FolderOpenOutline" /></template></n-button>
                  <n-button size="small" quaternary type="error" :disabled="busy" :title="t('editor.plugins.remove')" :aria-label="t('editor.plugins.remove')" @click="removePlugin(slot.id)"><template #icon><n-icon :component="TrashOutline" /></template></n-button>
                </div>
              </div>
              <p v-if="unavailablePlugins.some(item => item.slotId === slot.id)" class="plugin-panel__warning">{{ t('editor.plugins.unavailableBypassed') }} {{ unavailablePlugins.find(item => item.slotId === slot.id)?.message }}</p>
              <EditorPluginParameters v-if="parameterSlotId === slot.id" :session="session" :slot-id="slot.id" :disabled="busy || unavailablePlugins.some(item => item.slotId === slot.id)" />
            </div>
            </div>
          </section>
        </div>
        <template v-if="operationError" #footer>
          <n-alert type="error" :show-icon="false">
            {{ operationError }}
            <p class="plugin-panel__hint">{{ t('editor.plugins.recoveryHint') }}</p>
            <n-button v-if="editor.pluginStateError" size="small" :disabled="busy" @click="run(async () => { await editor.retryPluginStateSave() })">{{ t('editor.plugins.retrySave') }}</n-button>
            <n-popconfirm v-if="editor.pluginStateUnavailable" v-model:show="reloadConfirmOpen" :to="managerCard?.$el"
              :positive-text="t('common.confirm')" :negative-text="t('common.cancel')"
              :positive-button-props="{ onKeydown: guardConfirmationKeys }" :negative-button-props="{ onKeydown: guardConfirmationKeys }"
              @positive-click="run(async () => { await editor.restoreSavedPluginSession() })">
              <template #trigger><n-button size="small" data-plugin-confirm-trigger :aria-expanded="reloadConfirmOpen" :disabled="busy">{{ t('editor.plugins.reloadPlugins') }}</n-button></template>
              {{ t('editor.plugins.reloadWarning') }}
            </n-popconfirm>
          </n-alert>
        </template>
      </n-card>
    </template>
  </n-modal>
</template>

<style scoped>
.plugin-panel { min-width: 0; padding: 12px 14px; border-bottom: 1px solid var(--outline); }
.plugin-panel__hint, .plugin-panel__warning { margin: 0; color: var(--on-surface-muted); font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; }
.plugin-panel__warning { color: var(--warning, var(--on-surface-muted)); }
.plugin-manager { width: min(1080px, calc(100vw - 40px)); height: min(640px, calc(100dvh - 120px)); max-height: calc(100dvh - 120px); margin: 96px auto 24px; align-self: flex-start; min-width: 0; border: 1px solid var(--outline-strong); box-shadow: var(--shadow-soft); }
.plugin-manager :deep(.n-card-header) { padding: 15px 20px; border-bottom: 1px solid var(--outline); }
.plugin-manager :deep(.plugin-manager__content) { display: flex; flex-direction: column; padding: 0; min-height: 0; overflow: hidden; }
.plugin-manager :deep(.plugin-manager__error) { padding: 12px 20px; max-height: 25dvh; overflow: auto; border-top: 1px solid var(--outline); }
.plugin-manager__heading { display: grid; gap: 3px; }
.plugin-manager__heading > strong { font-size: 16px; font-weight: 600; }
.plugin-manager__heading > span { font-size: 12px; font-weight: 400; color: var(--on-surface-muted); }
.plugin-manager__badge { padding: 3px 7px; border-radius: 4px; background: var(--surface-2); font-size: 11px; color: var(--on-surface-muted); }
.plugin-manager__steps { display: flex; gap: 24px; flex-shrink: 0; margin: 0; padding: 12px 20px; border-bottom: 1px solid var(--outline); list-style: none; }
.plugin-manager__steps > li { display: flex; align-items: center; gap: 7px; font-size: 12px; color: var(--on-surface-muted); }
.plugin-manager__steps > li > span { display: grid; place-items: center; width: 21px; height: 21px; border: 1px solid var(--outline-strong); border-radius: 50%; font-variant-numeric: tabular-nums; }
.plugin-manager__steps > li[aria-current="step"] { color: var(--primary); font-weight: 600; }
.plugin-manager__steps > li[aria-current="step"] > span, .plugin-manager__step--done > span { background: var(--primary-soft); border-color: var(--primary-border); color: var(--primary); }
.plugin-manager__body { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); flex: 1; min-height: 0; overflow: hidden; }
.plugin-manager__chain, .plugin-manager__library { display: flex; flex-direction: column; align-items: stretch; gap: 12px; min-width: 0; min-height: 0; padding: 18px 20px; overflow: hidden; }
.plugin-manager__library--scan-controls { overflow-y: auto; }
.plugin-manager__library--scan-controls > * { flex-shrink: 0; }
.plugin-manager__library--scan-controls .plugin-manager__catalog { min-height: 120px; }
.plugin-manager__scan-progress { display: grid; gap: 7px; padding: 10px; border: 1px solid var(--outline); border-radius: 6px; background: var(--surface-2); }
.plugin-manager__scan-progress-heading { display: flex; gap: 8px; align-items: center; justify-content: space-between; font-size: 12px; }
.plugin-manager__scan-progress-heading > span { color: var(--on-surface-muted); font-variant-numeric: tabular-nums; }
.plugin-manager__scan-current, .plugin-manager__blacklist-entry > span { display: grid; gap: 3px; min-width: 0; }
.plugin-manager__scan-current > *, .plugin-manager__blacklist-entry > span > * { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 12px; }
.plugin-manager__scan-current > small, .plugin-manager__blacklist-entry small { color: var(--on-surface-muted); font-size: 11px; }
.plugin-manager__scan-control-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.plugin-manager__blacklist { font-size: 12px; }
.plugin-manager__blacklist > summary { cursor: pointer; color: var(--on-surface-muted); }
.plugin-manager__blacklist > p, .plugin-manager__blacklist-list { margin-top: 8px; }
.plugin-manager__blacklist-list { display: grid; gap: 9px; max-height: 110px; overflow: auto; }
.plugin-manager__blacklist-entry { display: flex; gap: 8px; align-items: center; }
.plugin-manager__blacklist-entry > span { flex: 1; }
.plugin-manager__chain { background: color-mix(in srgb, var(--surface-2) 24%, transparent); border-left: 1px solid var(--outline); }
.plugin-manager__target-label { margin-bottom: -6px; color: var(--on-surface-muted); font-size: 11px; }
.plugin-manager__feedback { margin: 0; padding: 8px 10px; border-radius: 5px; background: var(--primary-softer); color: var(--primary-strong); font-size: 12px; line-height: 1.6; }
.plugin-manager__section-heading, .plugin-manager__slot-heading { display: flex; align-items: center; gap: 8px; min-width: 0; }
.plugin-manager__section-heading { justify-content: space-between; min-height: 28px; flex-shrink: 0; }
.plugin-manager__section-heading > div { display: flex; align-items: center; gap: 8px; }
.plugin-manager__section-heading strong { font-size: 13px; font-weight: 600; color: var(--on-surface-heading); }
.plugin-manager__section-heading > span, .plugin-manager__format, .plugin-manager__slot-number { color: var(--on-surface-muted); font-size: 11px; font-variant-numeric: tabular-nums; }
.plugin-manager__library-count { color: var(--on-surface-muted); font-size: 11px; font-variant-numeric: tabular-nums; }
.plugin-manager__empty { display: flex; flex: 1; flex-direction: column; align-items: center; justify-content: center; gap: 10px; padding: 16px; min-height: 0; text-align: center; color: var(--on-surface-muted); }
.plugin-manager__empty > .n-icon { margin-bottom: 3px; color: var(--primary); }
.plugin-manager__empty > strong { color: var(--on-surface); font-size: 13px; font-weight: 500; }
.plugin-manager__empty > p { max-width: 270px; margin: 0; font-size: 12px; line-height: 1.7; text-wrap: pretty; }
.plugin-manager__slots { display: grid; align-content: start; gap: 10px; min-height: 0; overflow: auto; }
.plugin-panel__slot { display: grid; gap: 12px; min-width: 0; padding: 12px; border: 1px solid var(--outline-strong); border-radius: 8px; background: var(--surface-1); }
.plugin-panel__slot--bypassed { border-style: dashed; }
.plugin-panel__slot--bypassed .plugin-manager__slot-heading > strong { color: var(--on-surface-muted); }
.plugin-manager__slot-number { display: grid; place-items: center; width: 23px; height: 23px; border-radius: 5px; background: var(--surface-2); flex-shrink: 0; }
.plugin-manager__slot-heading > strong { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
.plugin-manager__slot-heading :deep(.n-checkbox__label) { padding-right: 0; font-size: 11px; }
.plugin-manager__format { flex-shrink: 0; padding: 2px 5px; border-radius: 4px; background: var(--surface-2); font-size: 10px; line-height: 1.5; }
.plugin-manager__slot-actions { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.plugin-manager__slot-tools { display: flex; align-items: center; gap: 2px; margin-left: auto; }
.plugin-manager__slot-tools :deep(.n-button) { width: 27px; padding: 0; }
.plugin-panel__slot :deep(.plugin-parameters) { padding-top: 12px; border-top: 1px solid var(--outline); }
.plugin-manager__sources { display: grid; gap: 8px; flex-shrink: 0; padding-bottom: 12px; border-bottom: 1px solid var(--outline); }
.plugin-manager__sources--empty { padding: 12px; border: 1px solid var(--primary-border); border-radius: 7px; background: var(--primary-softer); }
.plugin-manager__source-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.plugin-manager__source-toolbar > strong { font-size: 12px; font-weight: 500; }
.plugin-manager__source-toolbar > span { color: var(--on-surface-muted); font-size: 11px; }
.plugin-manager__directories { display: grid; gap: 4px; max-height: 72px; overflow: auto; }
.plugin-panel__directory { display: flex; align-items: center; gap: 8px; min-width: 0; }
.plugin-panel__directory > span { display: grid; flex: 1; min-width: 0; line-height: 1.6; }
.plugin-panel__directory strong, .plugin-panel__directory small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.plugin-panel__directory strong { font-size: 12px; font-weight: 500; }
.plugin-panel__directory small { color: var(--on-surface-muted); font-size: 11px; }
.plugin-panel__directory .plugin-manager__au-source-hint { white-space: normal; }
.plugin-manager__scan-actions { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; }
.plugin-panel__scan-failures { flex-shrink: 0; max-height: 90px; overflow: auto; padding: 8px; border-radius: 6px; background: color-mix(in srgb, var(--warning) 9%, transparent); color: var(--on-surface-muted); font-size: 12px; overflow-wrap: anywhere; }
.plugin-panel__scan-failures summary { cursor: pointer; margin-top: 6px; }
.plugin-panel__scan-failures p { margin: 8px 0 0; }
.plugin-panel__scan-failures span { display: block; font-weight: 600; }
.plugin-manager__relocation { display: flex; align-items: flex-start; gap: 8px; padding: 9px; border-radius: 6px; background: var(--primary-softer); }
.plugin-manager__relocation > p { margin: 0; flex: 1; font-size: 12px; line-height: 1.6; }
.plugin-manager__catalog { flex: 1; min-height: 0; overflow: auto; }
.plugin-manager__group-controls { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-shrink: 0; }
.plugin-manager__group-controls > span { font-size: 11px; color: var(--on-surface-muted); }
.plugin-manager__group { padding-top: 2px; }
.plugin-manager__group + .plugin-manager__group { margin-top: 10px; }
.plugin-manager__group-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 5px 10px 8px; color: var(--on-surface-muted); }
.plugin-manager__group-heading > strong { min-width: 0; font-size: 11px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.plugin-manager__group-heading > span { font-size: 10px; font-variant-numeric: tabular-nums; }
.plugin-manager__plugin { display: flex; align-items: center; gap: 10px; width: 100%; min-width: 0; margin: 0 0 4px; padding: 10px; border: 1px solid transparent; border-radius: 6px; background: transparent; color: var(--on-surface); text-align: left; cursor: pointer; transition: background 120ms, border-color 120ms; }
.plugin-manager__plugin:hover:not(:disabled) { background: var(--surface-2); }
.plugin-manager__plugin--selected, .plugin-manager__plugin--selected:hover:not(:disabled) { background: var(--primary-softer); border-color: var(--primary-border); }
.plugin-manager__plugin:disabled { cursor: default; opacity: .5; }
.plugin-manager__plugin-icon { display: grid; place-items: center; width: 32px; height: 32px; border-radius: 6px; background: var(--surface-2); flex-shrink: 0; color: var(--on-surface-muted); }
.plugin-manager__plugin--selected .plugin-manager__plugin-icon { color: var(--primary); background: var(--primary-soft); }
.plugin-manager__plugin-info { display: grid; gap: 3px; min-width: 0; flex: 1; }
.plugin-manager__plugin-info > strong { font-size: 13px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.plugin-manager__plugin-info > small { color: var(--on-surface-muted); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.plugin-manager__plugin-info > .plugin-manager__plugin-identity { white-space: normal; overflow-wrap: anywhere; line-height: 1.5; }
.plugin-manager__empty--library { min-height: 100%; padding: 12px; }
.plugin-manager__plugin:focus-visible { outline: 2px solid var(--primary); outline-offset: -2px; }
.plugin-manager__library-footer { display: grid; flex-shrink: 0; gap: 10px; padding-top: 12px; border-top: 1px solid var(--outline); }
.plugin-manager__library-footer > .plugin-panel__hint { font-size: 11px; }
.plugin-manager__add-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-width: 0; }
.plugin-manager__selection { display: grid; gap: 3px; min-width: 0; }
.plugin-manager__selection > strong { font-size: 12px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.plugin-manager__selection > span { font-size: 11px; color: var(--on-surface-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
@media (max-width: 760px) {
  .plugin-manager { width: calc(100vw - 24px); }
  .plugin-manager__body { grid-template-columns: minmax(0, 1fr); overflow: auto; }
  .plugin-manager__chain { border-left: 0; border-top: 1px solid var(--outline); min-height: 300px; }
  .plugin-manager__slots { max-height: 300px; }
  .plugin-manager__library { min-height: 400px; }
}
@media (prefers-reduced-motion: reduce) { .plugin-manager__plugin { transition: none; } }
</style>
