<script setup lang="ts">
import { computed, onMounted, onScopeDispose, ref, watch } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { useI18n } from 'vue-i18n'
import { useEditorStore } from '@/stores/editor'
import { useEditorPlaybackStore } from '@/stores/editorPlayback'
import type { EditorSession } from '@/types/editor'
import { clonePluginChain, pluginDescriptorFormat, pluginDescriptorLabels, pluginSlotMatchesDescriptor } from '@/utils/editorPlugins'
import { observePluginSession, openPluginEditor, pluginHostCapabilities, type PluginDescriptor, type PluginHostCapabilities, type PluginScanReport, type UnavailablePlugin } from '@/utils/pluginHost'
import EditorPluginParameters from './EditorPluginParameters.vue'

const props = defineProps<{ session: EditorSession; selectedTrackId: string | null }>()
const { t } = useI18n()
const editor = useEditorStore()
const playback = useEditorPlaybackStore()
const capabilities = ref<PluginHostCapabilities | null>(null)
const busy = ref(false)
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
const STORAGE_KEY = 'pymss-vst-lab-search-paths'
const targetOptions = computed(() => [
  { label: t('editor.plugins.masterOutput'), value: 'master' },
  ...props.session.tracks.map(track => ({ label: track.name, value: track.id })),
])
const chain = computed(() => target.value === 'master'
  ? props.session.pluginChain || []
  : props.session.tracks.find(track => track.id === target.value)?.pluginChain || [])
const descriptorKey = (plugin: PluginDescriptor) => JSON.stringify([plugin.id, plugin.path])
const relocatingSlot = computed(() => chain.value.find(slot => slot.id === relocatingSlotId.value))
const operationError = computed(() => error.value || editor.pluginStateError || playback.error)
const pluginOptions = computed(() => {
  const plugins = descriptors.value.filter(plugin => !relocatingSlot.value || pluginSlotMatchesDescriptor(relocatingSlot.value, plugin))
  const labels = pluginDescriptorLabels(plugins, Boolean(relocatingSlot.value))
  return plugins.map((plugin, index) => ({ label: labels[index], value: descriptorKey(plugin),
    disabled: plugin.isInstrument === true || !capabilities.value?.formats.includes(pluginDescriptorFormat(plugin)) }))
})
const stopObservingSession = observePluginSession(host => {
  if (host?.project === props.session) { opened.value = [...host.openEditors]; unavailablePlugins.value = [...host.unavailablePlugins] }
  else { opened.value = []; unavailablePlugins.value = [] }
})
onScopeDispose(stopObservingSession)
watch(() => props.selectedTrackId, id => { target.value = id || 'master' }, { immediate: true })
watch(() => props.session, () => { opened.value = []; unavailablePlugins.value = []; error.value = ''; scanReport.value = null; descriptors.value = []; selectedPluginId.value = null; relocatingSlotId.value = null; parameterSlotId.value = null; target.value = props.selectedTrackId || 'master' })
watch(target, () => { relocatingSlotId.value = null; selectedPluginId.value = null; parameterSlotId.value = null })
onMounted(async () => {
  capabilities.value = await pluginHostCapabilities()
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]')
    if (Array.isArray(stored)) directories.value = stored.filter((path): path is string => typeof path === 'string')
  } catch { /* An invalid preference must not prevent opening the inspector. */ }
})

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
  directories.value.splice(index, 1)
  saveDirectories()
}
async function scan(force = false) {
  await run(async () => {
    const project = props.session
    const report = await invoke<PluginScanReport>('plugin_host_scan_report', { paths: [...directories.value], force })
    if (props.session !== project) return
    scanReport.value = report
    descriptors.value = report.plugins
    if (!descriptors.value.some(plugin => descriptorKey(plugin) === selectedPluginId.value)) selectedPluginId.value = null
  })
}
async function mutate(change: (slots: typeof chain.value) => void, recovery = false) {
  await run(async () => {
    const project = props.session
    const trackId = target.value === 'master' ? null : target.value
    await editor.capturePluginState(project, true, recovery)
    if (props.session !== project) return
    const currentChain = trackId ? props.session.tracks.find(track => track.id === trackId)?.pluginChain : props.session.pluginChain
    const slots = clonePluginChain(currentChain) || []
    change(slots)
    if (JSON.stringify(slots) === JSON.stringify(currentChain || [])) return
    editor.setPluginChain(trackId, slots)
  })
}
function beginRelocation(slotId: string) {
  relocatingSlotId.value = slotId
  selectedPluginId.value = null
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
  await mutate(slots => slots.push({ id: `plugin_${crypto.randomUUID()}`, format: pluginDescriptorFormat(plugin), pluginId: plugin.id,
    name: plugin.name, path: plugin.path, bypassed: false,
    ...(plugin.auVersion ? { auVersion: plugin.auVersion } : {}),
    ...(plugin.isShellChild ? { isShellChild: true } : {}) }))
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
    const open = !opened.value.includes(slotId)
    await openPluginEditor(props.session, slotId, open)
    opened.value = open ? [...opened.value, slotId] : opened.value.filter(id => id !== slotId)
    if (!open) {
      await editor.capturePluginState(props.session, true)
      editor.scheduleSave()
    }
  })
}
</script>

<template>
  <section v-if="capabilities?.enabled" class="plugin-panel" :aria-busy="busy">
    <div class="plugin-panel__heading"><strong>{{ t('editor.plugins.title') }}</strong>
      <n-tag size="small" :bordered="false">{{ t('editor.plugins.experimental') }}</n-tag></div>
    <p class="plugin-panel__hint">{{ t('editor.plugins.hint') }}</p>
    <n-select v-model:value="target" size="small" :options="targetOptions" :disabled="busy" :aria-label="t('editor.plugins.target')" />
    <div v-if="!chain.length" class="plugin-panel__empty">{{ t('editor.plugins.emptyChain') }}</div>
    <div v-for="(slot, index) in chain" :key="slot.id" class="plugin-panel__slot">
      <strong :title="slot.path">{{ slot.name || slot.pluginId }}</strong>
      <div class="plugin-panel__actions">
        <n-checkbox :checked="slot.bypassed" :disabled="busy" @update:checked="(value: boolean) => setPluginBypassed(slot.id, value)">{{ t('editor.plugins.bypass') }}</n-checkbox>
        <n-button size="tiny" :disabled="busy || !capabilities.nativeEditor || !(capabilities.nativeEditorFormats || ['vst3']).includes(slot.format)" @click="toggleEditor(slot.id)">{{ opened.includes(slot.id) ? t('editor.plugins.closeEditor') : t('editor.plugins.openEditor') }}</n-button>
        <n-button size="tiny" :disabled="busy || !capabilities.formats.includes(slot.format) || unavailablePlugins.some(item => item.slotId === slot.id)" @click="parameterSlotId = parameterSlotId === slot.id ? null : slot.id">{{ t('editor.plugins.parameters') }}</n-button>
        <n-button size="tiny" :disabled="busy || index === 0" :aria-label="t('editor.plugins.moveUp')" @click="movePlugin(slot.id, -1)">↑</n-button>
        <n-button size="tiny" :disabled="busy || index === chain.length - 1" :aria-label="t('editor.plugins.moveDown')" @click="movePlugin(slot.id, 1)">↓</n-button>
        <n-button v-if="slot.format !== 'au'" size="tiny" :disabled="busy || !capabilities.formats.includes(slot.format)" @click="beginRelocation(slot.id)">{{ t('editor.plugins.relocate') }}</n-button>
        <n-button size="tiny" :disabled="busy" @click="removePlugin(slot.id)">{{ t('editor.plugins.remove') }}</n-button>
      </div>
      <p v-if="unavailablePlugins.some(item => item.slotId === slot.id)" class="plugin-panel__warning">{{ t('editor.plugins.unavailableBypassed') }} {{ unavailablePlugins.find(item => item.slotId === slot.id)?.message }}</p>
      <EditorPluginParameters v-if="parameterSlotId === slot.id" :session="session" :slot-id="slot.id" :disabled="busy || unavailablePlugins.some(item => item.slotId === slot.id)" />
    </div>
    <details class="plugin-panel__library" open>
      <summary>{{ t('editor.plugins.library') }}</summary>
      <p class="plugin-panel__hint">{{ t('editor.plugins.defaultDirectories') }}</p>
      <div v-for="(path, index) in directories" :key="path" class="plugin-panel__directory"><span :title="path">{{ path }}</span>
        <n-button size="tiny" :disabled="busy" :aria-label="t('editor.plugins.removeDirectory')" @click="removeDirectory(index)">×</n-button></div>
      <n-input v-model:value="directoryDraft" size="small" :placeholder="t('editor.plugins.directory')" :disabled="busy" @keydown.enter="addDirectory" />
      <div class="plugin-panel__actions">
        <n-button size="small" :disabled="busy || !directoryDraft.trim()" @click="addDirectory">{{ t('editor.plugins.addDirectory') }}</n-button>
        <n-button size="small" :loading="busy" @click="scan()">{{ t('editor.plugins.scan') }}</n-button>
        <n-button v-if="scanReport?.failures.length" size="small" :disabled="busy" @click="scan(true)">{{ t('editor.plugins.retryScan') }}</n-button>
      </div>
      <p v-if="scanReport" class="plugin-panel__hint">{{ t('editor.plugins.scanSummary', { scanned: scanReport.scanned, cached: scanReport.cached, found: scanReport.plugins.length }) }}</p>
      <div v-if="scanReport?.failures.length" class="plugin-panel__scan-failures" role="status">
        <strong>{{ t('editor.plugins.scanFailures', { count: scanReport.failures.length }) }}</strong>
        <p v-for="failure in scanReport.failures" :key="failure.path" :title="failure.path"><span>{{ failure.path }}</span>{{ failure.message }}</p>
      </div>
      <p v-if="relocatingSlot" class="plugin-panel__hint">{{ t('editor.plugins.relocationHint', { name: relocatingSlot.name || relocatingSlot.pluginId }) }}</p>
      <n-select v-model:value="selectedPluginId" size="small" :options="pluginOptions" filterable clearable :disabled="busy" :placeholder="t('editor.plugins.selectPlugin')" />
      <template v-if="relocatingSlot">
        <n-button size="small" block :disabled="busy || !selectedPluginId" @click="relocatePlugin">{{ t('editor.plugins.applyLocation') }}</n-button>
        <n-button size="small" block :disabled="busy" @click="relocatingSlotId = null; selectedPluginId = null">{{ t('common.cancel') }}</n-button>
      </template>
      <n-button v-else size="small" block :disabled="busy || !selectedPluginId" @click="addPlugin">{{ t('editor.plugins.addPlugin') }}</n-button>
    </details>
    <n-alert v-if="operationError" type="error" :show-icon="false">
      {{ operationError }}
      <p class="plugin-panel__hint">{{ t('editor.plugins.recoveryHint') }}</p>
      <n-button v-if="editor.pluginStateError" size="small" :disabled="busy" @click="run(async () => { await editor.retryPluginStateSave() })">{{ t('editor.plugins.retrySave') }}</n-button>
      <n-popconfirm v-if="editor.pluginStateUnavailable" :positive-text="t('common.confirm')" :negative-text="t('common.cancel')" @positive-click="run(async () => { await editor.restoreSavedPluginSession() })">
        <template #trigger><n-button size="small" :disabled="busy">{{ t('editor.plugins.reloadPlugins') }}</n-button></template>
        {{ t('editor.plugins.reloadWarning') }}
      </n-popconfirm>
    </n-alert>
  </section>
</template>

<style scoped>
.plugin-panel { display: grid; grid-template-columns: minmax(0, 1fr); width: 100%; min-width: 0; max-width: 100%; box-sizing: border-box; gap: 10px; padding: 14px; border: 1px solid var(--outline); border-radius: 8px; }
.plugin-panel > *, .plugin-panel__library > * { min-width: 0; max-width: 100%; }
.plugin-panel__heading, .plugin-panel__directory { display: flex; gap: 8px; align-items: center; justify-content: space-between; }
.plugin-panel__hint, .plugin-panel__empty { margin: 0; font-size: 12px; color: var(--on-surface-muted); overflow-wrap: anywhere; }
.plugin-panel__slot { display: grid; gap: 7px; padding: 9px 0; border-bottom: 1px solid var(--outline); }
.plugin-panel__slot > strong, .plugin-panel__directory > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; font-size: 12px; }
.plugin-panel__actions { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.plugin-panel__library > :not(summary) { margin-top: 9px; }
.plugin-panel__library > summary { cursor: pointer; font-size: 12px; font-weight: 600; }
.plugin-panel__warning, .plugin-panel__scan-failures { margin: 0; font-size: 12px; color: var(--on-surface-muted); overflow-wrap: anywhere; }
.plugin-panel__scan-failures { max-height: 180px; overflow-y: auto; }
.plugin-panel__scan-failures p { margin: 8px 0 0; }
.plugin-panel__scan-failures span { display: block; font-weight: 600; }
</style>
