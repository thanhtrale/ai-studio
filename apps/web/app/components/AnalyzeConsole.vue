<script setup lang="ts">
/**
 * The requirements console: two sources, a run, and what came out of it.
 *
 * The same three columns as the generate consoles -- inputs on the left, the
 * work in the middle, what the machine is doing on the right -- because it is
 * the same kind of wait. A run is four model passes and a round trip to another
 * application, and a spinner cannot tell any of those apart, nor any of them
 * from a hang.
 *
 * The ticket is read and shown *before* Analyze is pressed. Importing the wrong
 * export is the likeliest mistake here, and finding out after four passes is
 * the worst possible time to find out.
 */
import { computed, ref, watchEffect } from 'vue';

import type { ArmSummary } from '@ai-studio/arm-contract';

import type { AnalysisResult, NormalisedTicket } from '#shared/analysis';
import { readFigmaLinks } from '#shared/figma-link';

import JobTimeline from './JobTimeline.vue';
import Markdown from './Markdown.vue';
import VramChart from './VramChart.vue';
import UiAlert from './ui/Alert.vue';
import UiBadge from './ui/Badge.vue';
import UiButton from './ui/Button.vue';
import UiCard from './ui/Card.vue';
import UiField from './ui/Field.vue';
import UiInput from './ui/Input.vue';
import UiSectionTitle from './ui/SectionTitle.vue';
import UiSelect from './ui/Select.vue';
import UiTextarea from './ui/Textarea.vue';

const props = defineProps<{ arms: ArmSummary[] }>();

const blockName = ref('');
const designLinks = ref('');
const pasted = ref('');
const armId = ref('');

const ticket = ref<NormalisedTicket | null>(null);
const ticketDetail = ref('');
const ticketFailure = ref('');
const reading = ref(false);

const failure = ref('');
const running = ref(false);
const result = ref<AnalysisResult | null>(null);
type Tab = 'requirements' | 'gaps' | 'authoring' | 'model';
const tab = ref<Tab>('requirements');

const { job, machine, armVram, capacityGib, available, elapsedSeconds, watch: follow } = useJobTelemetry();

/** Only arms that can actually answer a chat. Modality alone would offer more. */
const candidates = computed(() => props.arms.filter((arm) => arm.capabilities.includes('text.generate')));

const armOptions = computed(() =>
  candidates.value.map((arm) => ({ value: arm.id, label: arm.name || arm.id })),
);

const chosenArm = computed(
  () => candidates.value.find((arm) => arm.id === armId.value) ?? candidates.value[0] ?? null,
);

// The select would otherwise render blank until a choice is made, while the
// submit quietly used the first arm -- two different answers to "which model".
watchEffect(() => {
  const first = candidates.value[0];
  if (first && !candidates.value.some((arm) => arm.id === armId.value)) armId.value = first.id;
});

/**
 * What the server will make of what has been typed, recomputed as it is typed.
 *
 * The same function the route uses, so the console cannot accept a link the
 * server then refuses. That matters more here than it would elsewhere: a run is
 * minutes, and a link rejected at the end of one is a link that could have been
 * rejected before it started.
 *
 * Silent on an empty field. Nothing has gone wrong yet.
 */
const links = computed(() =>
  designLinks.value.trim() ? readFigmaLinks(designLinks.value) : { references: [], problems: [] },
);

const ready = computed(
  () =>
    Boolean(blockName.value.trim() && ticket.value) &&
    links.value.references.length > 0 &&
    links.value.problems.length === 0 &&
    candidates.value.length > 0,
);

async function readTicket(file?: File): Promise<void> {
  ticketFailure.value = '';
  reading.value = true;
  try {
    let answer: { ticket: NormalisedTicket; detail: string };
    if (file) {
      const form = new FormData();
      form.append('file', file);
      answer = await $fetch('/api/analyze/ticket', { method: 'POST', body: form });
    } else {
      answer = await $fetch('/api/analyze/ticket', { method: 'POST', body: { text: pasted.value } });
    }
    ticket.value = answer.ticket;
    ticketDetail.value = answer.detail;
  } catch (error) {
    ticket.value = null;
    ticketFailure.value = messageOf(error);
  } finally {
    reading.value = false;
  }
}

function onFile(event: Event): void {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (file) void readTicket(file);
}

/** The server's own message, which says what to do; the status line does not. */
function messageOf(error: unknown): string {
  const data = (error as { data?: { data?: { message?: string }; message?: string } })?.data;
  return data?.data?.message ?? data?.message ?? (error as Error)?.message ?? 'something went wrong';
}

function newAnalysisId(): string {
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const tail = Math.random().toString(36).slice(2, 10);
  return `analysis-${stamp}-${tail}`;
}

async function analyse(): Promise<void> {
  if (!ready.value || !ticket.value) return;

  failure.value = '';
  result.value = null;
  running.value = true;

  // Chosen here rather than received, so progress can be polled while the
  // request that started it is still open.
  //
  // An analysis reports its steps from this application rather than from the
  // supervisor -- same shape, own route -- so the source has to be named. The
  // supervisor has never heard of an analysis id.
  const analysisId = newAnalysisId();
  follow(analysisId, 'analysis');

  try {
    result.value = await $fetch<AnalysisResult>('/api/analyze', {
      method: 'POST',
      body: {
        analysisId,
        blockName: blockName.value.trim(),
        designLinks: designLinks.value,
        ticket: ticket.value,
        armId: chosenArm.value?.id,
      },
    });
    tab.value = 'requirements';
  } catch (error) {
    failure.value = messageOf(error);
  } finally {
    running.value = false;
  }
}

/**
 * What is on screen, and what Copy puts on the clipboard.
 *
 * The source in both cases, never the rendering: a report is copied in order to
 * be pasted into a ticket or a pull request, both of which render markdown
 * themselves, and HTML would arrive there as noise.
 */
const artifact = computed(() => {
  const current = result.value;
  if (!current) return '';
  if (tab.value === 'requirements') return current.markdown;
  if (tab.value === 'gaps') return current.gapsMarkdown;
  if (tab.value === 'authoring') return current.authoringMarkdown;
  return JSON.stringify(current.model, null, 2);
});

/** Three of the four are documents. The fourth is a file to paste into a repo. */
const prose = computed(() => tab.value !== 'model');

const modelFile = computed(() => {
  const name = result.value?.record.blockName ?? 'block';
  return `_${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}.json`;
});

const tabs = computed(() => [
  { key: 'requirements' as const, label: 'Requirements' },
  { key: 'gaps' as const, label: 'Gaps' },
  { key: 'authoring' as const, label: 'Authoring' },
  { key: 'model' as const, label: modelFile.value },
]);

const copied = ref(false);
async function copy(): Promise<void> {
  try {
    await navigator.clipboard.writeText(artifact.value);
    copied.value = true;
    setTimeout(() => (copied.value = false), 1500);
  } catch {
    // A denied clipboard is not worth an error banner; the text is on screen.
  }
}
</script>

<template>
  <div class="flex h-full overflow-hidden">
    <!-- Inputs -->
    <aside class="w-80 shrink-0 space-y-5 overflow-y-auto border-r border-white/10 p-5">
      <UiSectionTitle title="Sources" />

      <UiField label="Block name" for="block" required hint="The EDS block this specifies, e.g. featured-story-card">
        <UiInput id="block" v-model="blockName" placeholder="featured-story-card" />
      </UiField>

      <div class="space-y-2">
        <UiField
          label="Figma frames"
          for="design"
          required
          hint="One link per frame — desktop, tablet, mobile. Notes around a link are fine. The first is the primary view, and they must all be in one file."
        >
          <UiTextarea
            id="design"
            v-model="designLinks"
            :rows="3"
            placeholder="https://www.figma.com/design/…?node-id=123-456"
          />
        </UiField>

        <!-- What was recognised, before the button is pressed rather than four
             minutes after it. -->
        <ul v-if="links.references.length" class="space-y-0.5 text-xs text-slate-400">
          <li
            v-for="(reference, at) in links.references"
            :key="reference.nodeId"
            class="flex items-baseline gap-2"
          >
            <span class="w-14 shrink-0 text-slate-500">{{ at === 0 ? 'primary' : 'view ' + (at + 1) }}</span>
            <code class="text-slate-300">{{ reference.nodeId }}</code>
            <span v-if="reference.fileName" class="truncate">{{ reference.fileName }}</span>
          </li>
        </ul>
        <p v-for="problem in links.problems" :key="problem" class="text-xs text-rose-300">{{ problem }}</p>
      </div>

      <div class="space-y-2">
        <UiField label="Ticket" for="ticket-file" required hint="Jira exports Word, XML or Print. XML carries the most.">
          <input
            id="ticket-file"
            type="file"
            class="w-full cursor-pointer rounded border border-white/15 bg-surface-raised p-2 text-sm text-slate-300 file:mr-3 file:cursor-pointer file:rounded file:border-0 file:bg-white/10 file:px-3 file:py-1 file:text-slate-100"
            @change="onFile"
          >
        </UiField>

        <UiTextarea v-model="pasted" :rows="3" placeholder="…or paste the ticket here" />
        <UiButton size="sm" :disabled="reading || !pasted.trim()" @click="readTicket()">
          {{ reading ? 'Reading…' : 'Read pasted text' }}
        </UiButton>
      </div>

      <UiAlert v-if="ticketFailure" tone="error">{{ ticketFailure }}</UiAlert>

      <UiCard v-if="ticket" class="p-3">
        <div class="space-y-2 text-sm">
          <div class="flex items-center justify-between gap-2">
            <span class="font-medium text-slate-100">{{ ticket.key ?? 'Ticket' }}</span>
            <UiBadge tone="ok">{{ ticket.format }}</UiBadge>
          </div>
          <p v-if="ticket.summary" class="text-slate-300">{{ ticket.summary }}</p>
          <p class="text-xs text-slate-400">Read as {{ ticketDetail }}.</p>
          <ul class="space-y-0.5 text-xs text-slate-400">
            <li>{{ ticket.passages.length }} passage{{ ticket.passages.length === 1 ? '' : 's' }}</li>
            <li v-if="ticket.comments.length">
              {{ ticket.comments.length }} comment{{ ticket.comments.length === 1 ? '' : 's' }} — read as part of the ticket
            </li>
            <li v-if="ticket.attachments.length">
              {{ ticket.attachments.length }} attachment{{ ticket.attachments.length === 1 ? '' : 's' }} — named, not read
            </li>
          </ul>
        </div>
      </UiCard>

      <UiSectionTitle title="Model" />

      <UiAlert v-if="candidates.length === 0" tone="warn">
        No discovered arm declares <code>text.generate</code>. The analysis needs one that can answer a chat.
      </UiAlert>

      <UiField v-else label="Arm" for="arm" hint="Any arm that speaks text.generate. Swapping it changes nothing else.">
        <UiSelect id="arm" v-model="armId" :options="armOptions" />
      </UiField>

      <UiButton variant="primary" class="w-full" :disabled="!ready || running" @click="analyse">
        {{ running ? 'Analysing…' : 'Analyze' }}
      </UiButton>

      <p class="text-xs text-slate-500">
        The design is the source of truth. Where the ticket disagrees, the requirement follows the design
        and the disagreement is reported as a gap.
      </p>
    </aside>

    <!-- The work -->
    <section class="min-w-0 flex-1 overflow-y-auto p-6">
      <UiAlert v-if="failure" tone="error" title="The analysis stopped">{{ failure }}</UiAlert>

      <div v-if="!result && !running && !failure" class="mx-auto max-w-lg space-y-3 pt-16 text-center">
        <p class="text-2xl text-indigo-400">&#9671;</p>
        <h2 class="text-base font-semibold text-slate-200">Nothing analysed yet</h2>
        <p class="text-sm text-slate-400">
          Point this at a Figma frame and the ticket that describes it. It reads each on its own, then
          reports what they disagree about and proposes a Universal Editor model for the block.
        </p>
        <p class="text-xs text-slate-500">
          The Figma desktop app must be running with its local MCP server enabled, and the file open.
          Give it every breakpoint and it reports what changes between them — which is the part a
          ticket most often leaves out.
        </p>
      </div>

      <div v-if="result" class="space-y-4">
        <header class="flex flex-wrap items-center gap-3">
          <h2 class="text-lg font-semibold">{{ result.record.blockName }}</h2>
          <UiBadge tone="ok">{{ result.requirements.length }} requirements</UiBadge>
          <UiBadge :tone="result.gaps.length ? 'warn' : 'neutral'">{{ result.gaps.length }} gaps</UiBadge>
          <UiBadge v-if="result.inferences.length" tone="neutral">
            {{ result.inferences.length }} inferences
          </UiBadge>
        </header>

        <div class="flex items-center gap-2">
          <UiButton
            v-for="entry in tabs"
            :key="entry.key"
            size="sm"
            :active="tab === entry.key"
            @click="tab = entry.key"
          >
            {{ entry.label }}
          </UiButton>
          <UiButton size="sm" variant="ghost" class="ml-auto" @click="copy">
            {{ copied ? 'Copied' : 'Copy' }}
          </UiButton>
        </div>

        <Markdown
          v-if="prose"
          :source="artifact"
          class="rounded border border-white/10 bg-surface-raised p-6"
        />
        <pre
          v-else
          class="overflow-x-auto rounded border border-white/10 bg-surface-raised p-4 text-xs leading-relaxed text-slate-200"
        ><code>{{ artifact }}</code></pre>
      </div>
    </section>

    <!-- What the machine is doing -->
    <aside class="w-80 shrink-0 space-y-5 overflow-y-auto border-l border-white/10 p-5">
      <VramChart
        :machine="machine"
        :arm="armVram"
        :capacity-gib="capacityGib"
        :available="available"
      />
      <JobTimeline :job="job" :elapsed-seconds="elapsedSeconds" />
    </aside>
  </div>
</template>
