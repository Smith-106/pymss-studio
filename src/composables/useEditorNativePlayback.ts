import { computed, onBeforeUnmount, watch } from 'vue'
import type { useEditorStore } from '@/stores/editor'
import { useEditorPlaybackStore } from '@/stores/editorPlayback'
import { hasEditorPlugins, pluginProjectSignature } from '@/utils/editorPlugins'
import { ensurePluginSession, pluginHostRequest, type PluginHostStatus } from '@/utils/pluginHost'

export function useEditorNativePlayback(editor: ReturnType<typeof useEditorStore>, followPlayhead: () => void) {
  const playback = useEditorPlaybackStore()
  const required = computed(() => hasEditorPlugins(editor.session))
  let activeProjectId: string | null = null
  let generation = 0
  let disposed = false
  let polling = false
  let timer: ReturnType<typeof setTimeout> | null = null

  function clearPoll() {
    if (timer) clearTimeout(timer)
    timer = null
  }

  function fail(id: number, cause: unknown) {
    clearPoll()
    playback.fail(id, cause instanceof Error ? cause.message : String(cause))
  }

  function applyStatus(result: PluginHostStatus, id: number, projectId: string, serial: number) {
    if (disposed || generation !== serial || playback.requestId !== id || editor.session?.id !== projectId) return
    if (result.projectId && result.projectId !== projectId) return
    if (result.error) { fail(id, new Error(result.error)); return }
    playback.setCurrentTime(result.position)
    playback.setMasterLevel(result.masterLevel || [0, 0])
    playback.setTrackLevels(result.levels || {})
    const master = result.masterLevel || [0, 0]
    playback.setLevel((master[0] + master[1]) / 2)
    if (result.playing) playback.finishPlay(id)
    else playback.finishPause(id)
    followPlayhead()
  }

  function schedulePoll() {
    clearPoll()
    if (disposed || !activeProjectId) return
    timer = setTimeout(async () => {
      if (polling || !activeProjectId || disposed) return
      polling = true
      const projectId = activeProjectId
      const serial = generation
      const id = playback.requestId
      try {
        const result = await pluginHostRequest<PluginHostStatus>({ op: 'status', projectId })
        applyStatus(result, id, projectId, serial)
      } catch (cause) {
        if (serial === generation && projectId === activeProjectId) fail(id, cause)
      } finally {
        polling = false
        if (playback.status !== 'error') schedulePoll()
      }
    }, 100)
  }

  async function play(position = playback.currentTime) {
    const project = editor.session
    if (!project || disposed) return false
    const serial = ++generation
    const id = playback.beginRequest('play', 'starting')
    try {
      await ensurePluginSession(project)
      if (serial !== generation || editor.session?.id !== project.id || disposed) return false
      activeProjectId = project.id
      const result = await pluginHostRequest<PluginHostStatus>({ op: 'play', projectId: project.id, position, loop: playback.loop })
      if (serial !== generation || disposed) return false
      applyStatus(result, id, project.id, serial)
      schedulePoll()
      return playback.status === 'playing'
    } catch (cause) {
      if (serial === generation && !disposed) fail(id, cause)
      return false
    }
  }

  function pause(reset = false) {
    if (disposed) {
      const id = playback.beginRequest('pause', 'paused')
      if (reset) playback.setCurrentTime(0)
      playback.finishPause(id)
      return true
    }
    const projectId = activeProjectId
    const serial = ++generation
    const id = playback.beginRequest('pause', 'pausing')
    clearPoll()
    if (!projectId) {
      if (reset) playback.setCurrentTime(0)
      playback.finishPause(id)
      return true
    }
    void (async () => {
      try {
        let result = await pluginHostRequest<PluginHostStatus>({ op: 'pause', projectId })
        if (reset && serial === generation) result = await pluginHostRequest<PluginHostStatus>({ op: 'seek', projectId, position: 0 })
        applyStatus(result, id, projectId, serial)
        if (serial === generation) schedulePoll()
      } catch (cause) {
        if (serial === generation && !disposed) fail(id, cause)
      }
    })()
    return true
  }

  function seek(position: number) {
    const project = editor.session
    if (!project) return
    const serial = ++generation
    const playing = playback.intent === 'play'
    const id = playback.beginRequest(playing ? 'play' : 'pause', playing ? 'starting' : 'paused')
    playback.setCurrentTime(position)
    void (async () => {
      try {
        await ensurePluginSession(project)
        if (serial !== generation || disposed || editor.session?.id !== project.id) return
        activeProjectId = project.id
        const result = await pluginHostRequest<PluginHostStatus>({ op: 'seek', projectId: project.id, position })
        applyStatus(result, id, project.id, serial)
        schedulePoll()
      } catch (cause) {
        if (serial === generation && !disposed) fail(id, cause)
      }
    })()
  }

  watch(() => editor.session && pluginProjectSignature(editor.session), async () => {
    const project = editor.session
    if (!project || project.id !== activeProjectId || !hasEditorPlugins(project)) return
    const serial = generation
    try {
      await ensurePluginSession(project)
    } catch (cause) {
      if (serial === generation && !disposed) {
        void pluginHostRequest({ op: 'pause', projectId: project.id }).catch(() => undefined)
        fail(playback.requestId, cause)
      }
    }
  })
  watch(() => playback.loop, loop => {
    if (activeProjectId && playback.intent === 'play') void play(playback.currentTime)
  })
  watch(() => editor.session, (project, oldProject) => {
    if (project?.id === oldProject?.id) return
    generation += 1
    clearPoll()
    activeProjectId = null
    if (oldProject) void (async () => {
      await editor.releasePluginSession(oldProject).catch(() => undefined)
    })()
  })
  watch(required, (value, previous) => {
    if (!value && previous) {
      pause()
      activeProjectId = null
      const projectId = editor.session?.id
      if (projectId && editor.session) void editor.releasePluginSession(editor.session).catch(() => undefined)
    }
  })
  onBeforeUnmount(() => {
    disposed = true
    generation += 1
    clearPoll()
    const project = editor.session
    activeProjectId = null
    if (project) void (async () => {
      await pluginHostRequest({ op: 'pause', projectId: project.id }).catch(() => undefined)
      await editor.releasePluginSession(project).catch(() => undefined)
    })()
  })

  return { required, play, pause, seek }
}
