import assert from 'node:assert/strict'
import test, { after, afterEach } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createPinia, setActivePinia } from 'pinia'
import { createServer } from 'vite'
import { Window } from 'happy-dom'

const browser = new Window()
globalThis.window = browser
globalThis.document = browser.document
Object.defineProperty(globalThis, 'navigator', { value: { language: 'en' }, configurable: true })
const vite = await createServer({
  configFile: false,
  server: { watch: null, middlewareMode: true, hmr: false, preTransformRequests: false },
  appType: 'custom',
  optimizeDeps: { noDiscovery: true },
  resolve: { alias: { '@': fileURLToPath(new URL('../src', import.meta.url)) } },
})
after(() => vite.close())
const { useModelStore } = await vite.ssrLoadModule('/src/stores/model.ts')
const { useSettingsStore } = await vite.ssrLoadModule('/src/stores/settings.ts')
const { useUpdateStore } = await vite.ssrLoadModule('/src/stores/update.ts')
const { useAppStore } = await vite.ssrLoadModule('/src/stores/app.ts')
const stores = []
const clone = value => JSON.parse(JSON.stringify(value))
const waitForSave = () => new Promise(resolve => setTimeout(resolve, 170))
afterEach(async () => {
  await waitForSave()
  for (const store of stores.splice(0)) store.$dispose()
  Reflect.deleteProperty(globalThis, 'window')
})

function environment(initial = {}) {
  const state = {
    'app-settings': {
      themeMode: 'light', locale: 'en', startupOnboardingSeen: true,
      modelDir: 'D:/old-models', outputDir: 'D:/outputs', defaultDevice: 'cuda:0',
      proxyMode: 'custom', proxyUrl: 'http://127.0.0.1:7001',
    },
    'model-state': {},
    ...clone(initial),
  }
  const calls = []
  const writes = []
  let failWrites = false
  let confirmCalls = 0
  let callbackId = 0
  function activate(label, pinia) {
    if (pinia) setActivePinia(pinia)
    globalThis.window = {
      matchMedia: () => ({ matches: false, addEventListener() {} }),
      addEventListener() {}, removeEventListener() {},
      __TAURI_INTERNALS__: {
        metadata: { currentWindow: { label }, currentWebview: { label } },
        transformCallback() { return ++callbackId },
        async invoke(command, args) {
          calls.push({ label, command, args: args ? clone(args) : undefined })
          if (command === 'load_app_store') return clone(state[args.name] || {})
          if (command === 'save_app_store') {
            if (failWrites) throw new Error('store write failed')
            state[args.name] = clone(args.data)
            writes.push({ label, name: args.name, data: clone(args.data) })
            return null
          }
          if (command === 'get_app_paths') {
            return { dataRoot: 'D:/data', settingsDir: 'D:/data/settings', modelsDir: 'D:/old-models', outputsDir: 'D:/outputs' }
          }
          if (command === 'list_models') {
            return { models: [], categories: [], categoriesCn: [], modelDir: args.payload.modelDir }
          }
          if (command === 'get_model_storage_summary') return { models: [], modelDir: args.payload.modelDir }
          if (command === 'confirm_model_dir_migration_switch') {
            if (++confirmCalls > 1) throw new Error('migration task not found')
            return { accepted: true }
          }
          if (command === 'plugin:event|listen' || command === 'plugin:event|unlisten') return ++callbackId
          if (command === 'check_managed_update') {
            return {
              currentVersion: '0.0.12', version: '0.0.13', prerelease: false, distribution: 'portable',
              autoUpdateSupported: true, requiresManualInstall: false,
            }
          }
          if ([
            'plugin:webview|set_webview_zoom', 'update_proxy_settings',
            'cancel_model_dir_migration', 'remap_custom_model_paths',
          ].includes(command)) return null
          throw new Error(`Unexpected IPC command: ${command}`)
        },
      },
    }
  }
  function instance(label) {
    const pinia = createPinia()
    activate(label, pinia)
    const models = useModelStore(pinia)
    const settings = useSettingsStore(pinia)
    stores.push(models, settings)
    return { pinia, models, settings, activate: () => activate(label, pinia) }
  }
  return {
    state, calls, writes, instance, fail: value => { failWrites = value },
  }
}

const activeDownload = {
  taskId: 'download_a', model: 'Model', status: 'downloading', progress: 20,
  message: 'Downloading', completedFiles: 0, totalFiles: 1, updatedAt: 1, logs: [], seen: true,
}

test('secondary workflow and audio windows preserve active downloads without persisting cache', async () => {
  for (const label of ['workflow-simple-editor-a', 'workflow-node-editor-a', 'editor-a']) {
    const env = environment({ 'model-state': { downloadTasks: { Model: activeDownload } } })
    const child = env.instance(label)
    await child.models.initialize()
    await waitForSave()
    assert.equal(child.models.downloadTasks.Model.status, 'downloading')
    assert.equal(child.models.downloadStates.Model, 'downloading')
    assert.equal(env.state['model-state'].downloadTasks.Model.status, 'downloading')
    assert.equal(env.writes.length, 0)
  }
})

test('main-window restart still restores interrupted downloads and persists the recovery', async () => {
  const env = environment({ 'model-state': { downloadTasks: { Model: activeDownload } } })
  const main = env.instance('main')
  await main.models.initialize()
  await waitForSave()
  assert.equal(main.models.downloadTasks.Model.status, 'interrupted')
  assert.equal(env.state['model-state'].downloadTasks.Model.status, 'interrupted')
})

test('secondary-window download progress cannot overwrite newer main-window preferences', async () => {
  const env = environment({ 'model-state': { downloadTasks: { Model: activeDownload } } })
  const child = env.instance('workflow-simple-editor-a')
  await child.models.initialize()
  await waitForSave()
  const main = env.instance('main')
  await main.models.initialize()
  main.models.setModelFavorite('Model', true)
  await waitForSave()
  assert.equal(env.state['model-state'].modelPreferences.Model.favorite, true)
  const baseline = clone(env.state['model-state'])
  child.activate()
  child.models.handleWorkerEvent({ type: 'download_progress', taskId: 'download_a', payload: { model: 'Model', progress: 51 } })
  await waitForSave()
  assert.equal(child.models.downloadTasks.Model.progress, 51)
  assert.deepEqual(env.state['model-state'], baseline)
  assert.ok(env.writes.every(write => write.label === 'main'))
})

test('secondary settings hydration and device reconciliation leave current settings and backend proxy intact', async () => {
  const env = environment()
  const main = env.instance('main')
  await main.settings.initialize()
  await waitForSave()
  const child = env.instance('workflow-simple-editor-a')
  await child.settings.initialize()
  await waitForSave()
  main.activate()
  main.settings.proxyUrl = 'http://127.0.0.1:7002'
  await waitForSave()
  const baseline = clone(env.state['app-settings'])
  child.activate()
  child.settings.reconcileRuntimeDevice({ torchAvailable: true, torchBackend: 'cpu' })
  child.settings.developerMode = true
  await child.settings.markStartupOnboardingCompleted()
  await waitForSave()
  assert.equal(child.settings.defaultDevice, 'auto')
  assert.deepEqual(env.state['app-settings'], baseline)
  assert.ok(env.calls.filter(call => call.command === 'update_proxy_settings').every(call => call.label === 'main'))
  assert.ok(env.writes.every(write => write.label === 'main'))
})

test('only the main window confirms model migration and remaps registrations', async () => {
  const env = environment()
  const main = env.instance('main')
  await main.settings.initialize()
  await waitForSave()
  const child = env.instance('workflow-node-editor-a')
  await child.settings.initialize()
  await waitForSave()
  const payload = { sourceModelDir: 'D:/old-models', targetModelDir: 'D:/new-models' }
  const ready = { type: 'model_dir_migration_ready_to_switch', taskId: 'model_dir_migration_a', payload }
  main.activate()
  await main.settings.handleWorkerEvent(ready)
  await waitForSave()
  child.activate()
  await child.settings.handleWorkerEvent(ready)
  assert.equal(child.settings.modelDirMigrationState.status, 'ready_to_switch')
  await child.settings.handleWorkerEvent({ ...ready, type: 'model_dir_migration_done' })
  await waitForSave()
  assert.equal(child.settings.modelDirMigrationState.status, 'success')
  assert.equal(child.settings.modelDir, 'D:/new-models')
  assert.equal(env.state['app-settings'].modelDir, 'D:/new-models')
  main.activate()
  await main.settings.handleWorkerEvent({ ...ready, type: 'model_dir_migration_done' })
  await waitForSave()
  assert.equal(env.calls.filter(call => call.command === 'confirm_model_dir_migration_switch').length, 1)
  const sideEffects = env.calls.filter(call => ['confirm_model_dir_migration_switch', 'cancel_model_dir_migration', 'remap_custom_model_paths'].includes(call.command))
  assert.ok(sideEffects.every(call => call.label === 'main'))
  assert.equal(env.calls.filter(call => call.command === 'remap_custom_model_paths').length, 1)
})

test('secondary-window update checks stay idle and preserve newer main-window preferences', async () => {
  const env = environment()
  const main = env.instance('main')
  const mainUpdates = useUpdateStore(main.pinia)
  useAppStore(main.pinia).buildInfoUpdateSupported = true
  stores.push(mainUpdates)
  await mainUpdates.initialize()
  const child = env.instance('workflow-simple-editor-a')
  const childUpdates = useUpdateStore(child.pinia)
  useAppStore(child.pinia).buildInfoUpdateSupported = true
  stores.push(childUpdates)
  await childUpdates.initialize()
  const childCheck = childUpdates.checkForUpdates()
  main.activate()
  await mainUpdates.checkForUpdates()
  await mainUpdates.deferUntilNextLaunch()
  const baseline = clone(env.state['update-state'])
  assert.equal(baseline.deferredVersion, '0.0.13')
  child.activate()
  assert.equal(await childCheck, null)
  assert.equal(await childUpdates.checkForUpdates(true), null)
  await waitForSave()
  assert.equal(childUpdates.currentVersion, '')
  assert.equal(childUpdates.latestVersion, '')
  assert.equal(childUpdates.status, 'idle')
  assert.equal(env.calls.some(call => call.label === 'workflow-simple-editor-a' && (
    call.command === 'check_managed_update'
    || call.command === 'plugin:event|listen'
    || (call.command === 'load_app_store' && call.args.name === 'update-state')
  )), false)
  assert.deepEqual(env.state['update-state'], baseline)
  assert.ok(env.writes.every(write => write.label === 'main'))
})

for (const kind of ['model', 'settings']) {
  test(`${kind} debounced writes report a failure once and recover after successful persistence`, async () => {
    const env = environment()
    const main = env.instance('main')
    if (kind === 'model') await main.models.initialize()
    else await main.settings.initialize()
    await waitForSave()
    const warnings = []
    const originalWarn = console.warn
    console.warn = (...args) => { warnings.push(args) }
    try {
      const mutate = value => {
        if (kind === 'model') main.models.setModelNote('Model', value)
        else main.settings.outputDir = value
      }
      env.fail(true)
      mutate('first')
      await waitForSave()
      mutate('second')
      await waitForSave()
      assert.equal(warnings.length, 1)
      assert.match(String(warnings[0][1]), /store write failed/)
      env.fail(false)
      mutate('recovered')
      await waitForSave()
      env.fail(true)
      mutate('third')
      await waitForSave()
      assert.equal(warnings.length, 2)
    } finally {
      console.warn = originalWarn
    }
  })
}
