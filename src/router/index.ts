import { createRouter, createWebHashHistory } from 'vue-router'
import { invoke } from '@tauri-apps/api/core'
import { createWorkflowEditorRouteGuard } from '@/workflows/editorWindow'
import { isMainTaskOwner } from '@/utils/taskOwner'
import { isTauriRuntime } from '@/utils/appStore'
import { recordFeatureVisit } from '@/utils/logger'
import { useToastStore } from '@/stores/toast'
import { useWorkflowStore } from '@/stores/workflow'
import i18n from '@/i18n'

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', name: 'separate', component: () => import('@/views/SeparateView.vue') },
    { path: '/separate', redirect: { name: 'separate' } },
    { path: '/tasks', redirect: { name: 'results' } },
    { path: '/models', name: 'models', component: () => import('@/views/ModelsView.vue') },
    { path: '/workflows', name: 'workflows', component: () => import('@/views/WorkflowsView.vue') },
    { path: '/workflow-node-editor', name: 'workflow-node-editor', component: () => import('@/views/WorkflowNodeEditorView.vue') },
    { path: '/workflow-simple-editor', name: 'workflow-simple-editor', component: () => import('@/views/WorkflowSimpleEditorView.vue') },
    { path: '/results', name: 'results', component: () => import('@/views/ResultsView.vue') },
    { path: '/tools', name: 'tools', component: () => import('@/views/ToolsView.vue') },
    { path: '/debug', name: 'debug', component: () => import('@/views/DebugView.vue') },
    { path: '/projects', redirect: { name: 'results' } },
    { path: '/editor', name: 'editor', component: () => import('@/views/EditorView.vue') },
    { path: '/settings', name: 'settings', component: () => import('@/views/SettingsView.vue') },
  ],
})

router.beforeEach(createWorkflowEditorRouteGuard({
  isDesktopMainWindow: () => isTauriRuntime() && isMainTaskOwner(),
  openWindow: async (command, args) => {
    const result = await invoke(command, args)
    const workflow = useWorkflowStore()
    const id = args.payload.newWorkflow ? '__new__' : args.payload.workflowId
    workflow.recordEditorOpened(result, command === 'open_workflow_simple_editor_window' ? 'simple' : 'advanced', id)
    return result
  },
  onError: error => useToastStore().error(error instanceof Error ? error.message : i18n.global.t('workflows.editorWindowOpenFailed')),
}))

router.afterEach((to, from, failure) => {
  if (!failure && typeof to.name === 'string' && to.name !== from.name) recordFeatureVisit(to.name)
})

export default router
