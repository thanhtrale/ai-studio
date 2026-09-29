<script setup lang="ts">
/**
 * A rendered report.
 *
 * The analysis writes markdown and the console used to show it as source, in a
 * `<pre>`, which is the right way to display a file and the wrong way to
 * display a document. Headings, nesting and emphasis are how these reports
 * carry their structure — a gap's two readings sit *under* the gap — and in a
 * `<pre>` all of that is two spaces of indentation.
 *
 * `v-html` is safe here for a reason argued in `utils/markdown.ts`: every
 * character of the source is escaped before any rule runs, so nothing in a
 * ticket can become a tag. Read that file before changing this one.
 */
import { computed } from 'vue';

import { renderMarkdown } from '../utils/markdown';

const props = defineProps<{ source: string }>();

const html = computed(() => renderMarkdown(props.source));
</script>

<template>
  <!-- eslint-disable-next-line vue/no-v-html -- escaped in utils/markdown.ts -->
  <div class="report" v-html="html" />
</template>

<style scoped>
.report {
  color: #cbd5e1;
  font-size: 0.875rem;
  line-height: 1.65;
}

.report :deep(> *:first-child) {
  margin-top: 0;
}

.report :deep(h1) {
  color: #f1f5f9;
  font-size: 1.25rem;
  font-weight: 600;
  margin: 0 0 1rem;
}

.report :deep(h2) {
  color: #f1f5f9;
  font-size: 1rem;
  font-weight: 600;
  margin: 1.75rem 0 0.75rem;
  padding-top: 0.75rem;
  border-top: 1px solid rgb(255 255 255 / 0.08);
}

.report :deep(h3) {
  color: #e2e8f0;
  font-size: 0.9375rem;
  font-weight: 600;
  margin: 1.25rem 0 0.5rem;
}

.report :deep(p) {
  margin: 0.75rem 0;
}

.report :deep(ul) {
  margin: 0.5rem 0;
  padding-left: 1.25rem;
  list-style: disc;
}

/* A nested list is a gap's readings or a field's companion: subordinate to the
   line above it, and marked as such rather than merely indented. */
.report :deep(li ul) {
  margin: 0.25rem 0 0.5rem;
  color: #94a3b8;
  list-style: circle;
}

.report :deep(li) {
  margin: 0.25rem 0;
}

.report :deep(strong) {
  color: #f1f5f9;
  font-weight: 600;
}

.report :deep(em) {
  color: #94a3b8;
}

.report :deep(code) {
  background: rgb(255 255 255 / 0.08);
  border-radius: 0.25rem;
  padding: 0.0625rem 0.3125rem;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.8125rem;
  color: #c7d2fe;
}

.report :deep(blockquote) {
  margin: 0.75rem 0;
  padding: 0.5rem 0 0.5rem 0.875rem;
  border-left: 2px solid #6366f1;
  color: #94a3b8;
}

/* The evidence under a requirement. Present but never competing with it. */
.report :deep(sub) {
  display: inline-block;
  font-size: 0.75rem;
  vertical-align: baseline;
  opacity: 0.65;
}
</style>
