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

import JobTimeline from './JobTimeline.vue';
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
const designUrl = ref('');
const pasted = ref('');
const armId = ref('');

const ticket = ref<NormalisedTicket | null>(null);
const ticketDetail = ref('');
const ticketFailure = ref('');
const reading = ref(false);

const failure = ref('');
const running = ref(false);
const result = ref<AnalysisResult | null>(null);
const tab = ref<'requirements' | 'gaps' | 'model'>('requirements');

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

const ready = computed(
  () => Boolean(blockName.value.trim() && designUrl.value.trim() && ticket.value) && candidates.value.length > 0,
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
  const analysisId = newAnalysisId();
  follow(analysisId);

  try {
    result.value = await $fetch<AnalysisResult>('/api/analyze', {
      method: 'POST',
      body: {
        analysisId,
        blockName: blockName.value.trim(),
        designUrl: designUrl.value.trim(),
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

const artifact = computed(() => {
  const current = result.value;
  if (!current) return '';
  if (tab.value === 'requirements') return current.markdown;
  if (tab.value === 'gaps') {
    return JSON.stringify({ gaps: current.gaps, inferences: current.inferences }, null, 2);
  }
  return JSON.stringify(current.model, null, 2);
});

const modelFile = computed(() => {
  const name = result.value?.record.blockName ?? 'block';
  return `_${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}.json`;
});

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

      <UiField
        label="Figma node link"
        for="design"
        required
        hint="Select the block's frame in Figma and copy a link to it. A whole file is not a block."
      >
        <UiInput id="design" v-model="designUrl" placeholder="https://www.figma.com/design/…?node-id=123-456" />
      </UiField>

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
            v-for="entry in (['requirements', 'gaps', 'model'] as const)"
            :key="entry"
            size="sm"
            :active="tab === entry"
            @click="tab = entry"
          >
            {{ entry === 'model' ? modelFile : entry }}
          </UiButton>
          <UiButton size="sm" variant="ghost" class="ml-auto" @click="copy">
            {{ copied ? 'Copied' : 'Copy' }}
          </UiButton>
        </div>

        <pre class="overflow-x-auto rounded border border-white/10 bg-surface-raised p-4 text-xs leading-relaxed text-slate-200"><code>{{ artifact }}</code></pre>
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
