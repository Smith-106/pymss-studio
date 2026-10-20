<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { locationLabel, logClock, logRecordRenderKeys, normalizeLogEntries, sourceLabel, type LogEntry, type LogRecord } from '@/utils/logRecord'

const props = withDefaults(defineProps<{ lines: readonly LogEntry[]; compact?: boolean; embedded?: boolean }>(), { compact: false, embedded: false })
const { t } = useI18n()
const records = computed(() => normalizeLogEntries(props.lines))
const recordKeys = computed(() => logRecordRenderKeys(records.value))
function recordContext(record: LogRecord) {
  const { taskId, nodeId, jobId, requestId, location, context } = record
  return JSON.stringify({ taskId, nodeId, jobId, requestId, location, ...context }, null, 2)
}
function hasDetails(record: LogRecord) {
  return Boolean(record.detail || locationLabel(record) || record.taskId || record.nodeId || record.jobId || record.requestId || Object.keys(record.context).length)
}
function logSource(record: LogRecord) {
  return record.source === 'third_party' ? t('debug.logSourceExternal') : sourceLabel(record.source)
}
function guardLogKeys(event: KeyboardEvent) {
  if (event.key !== 'Escape' && event.key !== 'Tab') event.stopPropagation()
}
</script>

<template>
  <div v-if="lines.length" class="log-console" :class="{ 'log-console--compact': compact, 'log-console--embedded': embedded }" role="region" :aria-label="t('tasks.logs')" tabindex="0" @wheel.stop @pointerdown.stop @dblclick.stop @contextmenu.stop @keydown="guardLogKeys">
    <div v-for="(record, index) in records" :key="recordKeys[index]" class="log-line" :class="['log-line--' + (record.level || 'unclassified'), 'log-source--' + record.source]">
      <div class="log-line-meta">
        <span v-if="!compact" class="log-line-number">{{ String(index + 1).padStart(3, '0') }}</span>
        <time v-if="record.timestamp" class="log-line-time" :datetime="record.timestamp">{{ logClock(record.timestamp) }}</time>
        <span class="log-level-badge" :class="{ 'log-line-level': !compact }">{{ record.level?.toUpperCase() || t('debug.logUnclassified') }}</span>
        <span class="log-source-badge">{{ logSource(record) }}</span>
        <span v-if="record.logger && !compact" class="log-line-logger" :title="record.logger">{{ record.logger }}</span>
      </div>
      <span class="log-line-text">{{ record.message }}</span>
      <details v-if="hasDetails(record)" class="log-line-detail" @click.stop>
        <summary>{{ t('debug.logDetails') }}</summary>
        <pre v-if="record.detail" class="log-line-exception">{{ record.detail }}</pre>
        <pre>{{ recordContext(record) }}</pre>
      </details>
    </div>
  </div>
  <div v-else class="log-empty">{{ t('tasks.noLogs') }}</div>
</template>

<style scoped>
.log-console {
  min-width: 0;
  user-select: text;
  max-height: min(62vh, 520px);
  overflow: auto;
  display: grid;
  gap: 2px;
  padding: 12px;
  border-radius: 12px;
  background: #0b1020;
  color: #c9d6ec;
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.55;
  scrollbar-width: thin;
  scrollbar-color: color-mix(in srgb, #94a3b8 46%, transparent) transparent;
}

.log-console::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}

.log-console::-webkit-scrollbar-track {
  background: transparent;
}

.log-console::-webkit-scrollbar-thumb {
  border: 2px solid #0b1020;
  border-radius: 999px;
  background: color-mix(in srgb, #94a3b8 44%, transparent);
  background-clip: padding-box;
}

.log-console::-webkit-scrollbar-thumb:hover {
  background: color-mix(in srgb, #94a3b8 64%, transparent);
  background-clip: padding-box;
}

.log-console::-webkit-scrollbar-corner {
  background: transparent;
}

.log-line {
  min-width: 0;
  padding: 7px 8px;
  border-radius: 5px;
  border-left: 2px solid transparent;
  color: #d8e2f1;
}

.log-line--trace,
.log-line--debug { --log-level-color: #a0adc1; }
.log-line--unclassified { --log-level-color: #a0adc1; }
.log-source--studio { --log-source-color: #8cbdff; }
.log-source--worker { --log-source-color: #75dce0; }
.log-source--pymss { --log-source-color: #c5a6ff; }
.log-source--third_party { --log-source-color: #f7bc80; }
.log-source--unknown { --log-source-color: #a0adc1; }

.log-line--info {
  --log-level-color: #9dceff;
}

.log-line--warn {
  --log-level-color: #f4d08b;
  background: color-mix(in srgb, var(--log-level-color) 8%, transparent);
  box-shadow: inset 2px 0 0 color-mix(in srgb, var(--log-level-color) 65%, transparent);
}

.log-line--error,
.log-line--fatal {
  --log-level-color: #f3aab8;
  background: color-mix(in srgb, var(--log-level-color) 9%, transparent);
  box-shadow: inset 2px 0 0 color-mix(in srgb, var(--log-level-color) 70%, transparent);
}

.log-line-number {
  color: #73839c;
  text-align: right;
  user-select: none;
}

.log-line-meta { display: flex; align-items: center; flex-wrap: wrap; gap: 7px; margin-bottom: 4px; font-size: 10px; }
.log-line-time { color: #94a3b8; font-variant-numeric: tabular-nums; }
.log-line-logger { min-width: 0; max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #94a3b8; }
.log-level-badge,
.log-source-badge {
  align-self: start;
  padding: 0 5px;
  border-radius: 4px;
  color: var(--log-level-color, #c9d6ec);
  background: color-mix(in srgb, var(--log-level-color, #c9d6ec) 12%, transparent);
  font-size: 10px;
  font-weight: 600;
  line-height: 18px;
  text-align: center;
  user-select: none;
}
.log-source-badge { color: var(--log-source-color); background: color-mix(in srgb, var(--log-source-color) 12%, transparent); }

.log-line-text {
  display: block;
  min-width: 0;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
.log-line-detail { margin-top: 5px; font-size: 11px; }
.log-line-detail summary { width: fit-content; color: #91a2b8; cursor: pointer; }
.log-line-detail pre { margin: 6px 0 0; padding: 8px; border-radius: 4px; background: #111825; color: #9ba8bc; max-height: 300px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; font-weight: 400; line-height: 1.65; }
.log-line-detail .log-line-exception { color: #c4a3ad; }

.log-empty {
  padding: 18px;
  color: var(--on-surface-muted);
  text-align: center;
}

.log-console--compact { display: block; max-height: 200px; padding: 6px; border-radius: 6px; font-size: 11px; }
.log-console--compact .log-line { padding: 5px 4px; }
.log-console--compact .log-line-meta { gap: 4px; margin-bottom: 2px; font-size: 9px; }
.log-console--embedded { max-height: none; overflow: visible; }
</style>
