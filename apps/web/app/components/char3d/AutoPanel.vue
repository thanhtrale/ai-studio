<script setup lang="ts">
/**
 * The autopilot on one character: start it, follow it, stop it.
 *
 * The local vision model writes the sheet prompt from the reference, then
 * reviews each sheet, mesh and rig and retries until one passes
 * (`server/char3d/autopilot.ts`). Every attempt is an ordinary run in the
 * sidebar with its review; this panel is the log of the decisions.
 */
import { computed, ref } from 'vue';

import {
  type Char3dAuto,
  CHAR3D_AUTO_DEFAULTS,
  CHAR3D_BODIES,
  type Char3dBody,
  type Char3dCharacter,
  char3dBody,
} from '#shared/char3d';

import UiBadge from '../ui/Badge.vue';
import UiButton from '../ui/Button.vue';
import UiCard from '../ui/Card.vue';
import UiField from '../ui/Field.vue';
import UiInput from '../ui/Input.vue';
import UiSelect from '../ui/Select.vue';

const props = defineProps<{ charId: string; character: Char3dCharacter; auto?: Char3dAuto }>();
const emit = defineEmits<{ refresh: []; open: [run: string] }>();

const STATUS_TONE = { running: 'accent', done: 'ok', failed: 'bad', stopped: 'warn', interrupted: 'warn' } as const;
const VERDICT_TONE = { pass: 'ok', retry: 'warn', fail: 'bad' } as const;
const STAGE_LABEL = { describe: 'Prompt', ref: 'Sheet', mesh: 'Mesh', rig: 'Rig' } as const;
const STOP_AFTER = [
  { value: 'rig', label: 'Rig (all the way)' },
  { value: 'mesh', label: 'Mesh' },
  { value: 'ref', label: 'Sheet' },
];

const running = computed(() => props.auto?.status === 'running');
const open = ref(!props.auto);
const body = ref<Char3dBody>(char3dBody({ chibi: props.character.chibi ?? CHAR3D_AUTO_DEFAULTS.chibi }));
const bodyHint = computed(() => CHAR3D_BODIES.find((option) => option.value === body.value)?.hint);
const passScore = ref(String(props.auto?.options.passScore ?? CHAR3D_AUTO_DEFAULTS.passScore));
const refTries = ref(String(props.auto?.options.refTries ?? CHAR3D_AUTO_DEFAULTS.refTries));
const meshTries = ref(String(props.auto?.options.meshTries ?? CHAR3D_AUTO_DEFAULTS.meshTries));
const stopAfter = ref<string>(props.auto?.options.stopAfter ?? 'rig');
const busy = ref(false);
const failure = ref<string | null>(null);

const events = computed(() => (props.auto?.events ?? []).slice().reverse());
const time = (at: number): string => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

async function start(): Promise<void> {
  busy.value = true;
  failure.value = null;
  try {
    await $fetch(`/api/char3d/${props.charId}/auto`, {
      method: 'POST',
      body: {
        chibi: body.value === 'chibi',
        passScore: Number(passScore.value),
        refTries: Number(refTries.value),
        meshTries: Number(meshTries.value),
        ...(stopAfter.value !== 'rig' ? { stopAfter: stopAfter.value } : {}),
      },
    });
    open.value = false;
    emit('refresh');
  } catch (error) {
    failure.value = describeFetchError(error);
  } finally {
    busy.value = false;
  }
}

async function stop(): Promise<void> {
  busy.value = true;
  try {
    await $fetch(`/api/char3d/${props.charId}/auto`, { method: 'DELETE' });
    emit('refresh');
  } catch (error) {
    failure.value = describeFetchError(error);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <UiCard>
    <div class="space-y-3 p-4">
      <div class="flex flex-wrap items-center gap-2">
        <p class="text-sm font-medium">Autopilot</p>
        <span class="text-xs text-slate-500">local AI writes the prompt, reviews and retries each step</span>
        <UiBadge v-if="auto" :tone="STATUS_TONE[auto.status]">{{ auto.status }}</UiBadge>
        <span v-if="running && auto?.stage" class="text-xs text-indigo-300">
          {{ STAGE_LABEL[auto.stage] }}{{ auto.stopRequested ? ' · stopping after this step' : '' }}
        </span>
        <span class="flex-1" />
        <UiButton v-if="running" size="sm" :disabled="busy || auto?.stopRequested" @click="stop">Stop</UiButton>
        <UiButton v-else size="sm" :variant="open ? 'ghost' : 'primary'" @click="open = !open">
          {{ open ? 'Close' : auto ? 'Run again' : 'Run autopilot' }}
        </UiButton>
      </div>

      <p v-if="auto?.error" class="text-xs text-rose-300">{{ auto.error }}</p>
      <p v-if="auto?.status === 'done' && auto.result" class="flex flex-wrap gap-2 text-xs text-emerald-300">
        <button v-for="(runId, step) in auto.result" :key="step" type="button" class="hover:underline" @click="emit('open', runId!)">
          {{ STAGE_LABEL[step] }} {{ runId }}
        </button>
      </p>

      <form v-if="open && !running" class="flex flex-wrap items-end gap-4 rounded border border-white/10 p-3" @submit.prevent="start">
        <div class="w-60">
          <UiField label="Body" for="auto-body" :hint="bodyHint"><UiSelect id="auto-body" v-model="body" :options="CHAR3D_BODIES" /></UiField>
        </div>
        <div class="w-24">
          <UiField label="Pass at" for="auto-pass"><UiInput id="auto-pass" v-model="passScore" /></UiField>
        </div>
        <div class="w-24">
          <UiField label="Sheet tries" for="auto-ref"><UiInput id="auto-ref" v-model="refTries" /></UiField>
        </div>
        <div class="w-24">
          <UiField label="Mesh tries" for="auto-mesh"><UiInput id="auto-mesh" v-model="meshTries" /></UiField>
        </div>
        <div class="w-44">
          <UiField label="Go as far as" for="auto-stop"><UiSelect id="auto-stop" v-model="stopAfter" :options="STOP_AFTER" /></UiField>
        </div>
        <UiButton type="submit" variant="primary" :disabled="busy">Start</UiButton>
        <p v-if="!character.traits" class="w-full text-xs text-slate-500">
          No traits yet: the local AI reads the reference first and writes them.
        </p>
        <p v-if="failure" class="w-full text-xs text-rose-300">{{ failure }}</p>
      </form>

      <ol v-if="events.length" class="max-h-64 space-y-1 overflow-y-auto text-xs">
        <li v-for="(event, index) in events" :key="index" class="flex gap-2">
          <span class="w-10 shrink-0 text-slate-500">{{ time(event.at) }}</span>
          <span class="w-12 shrink-0 text-slate-400">{{ STAGE_LABEL[event.stage] }}</span>
          <UiBadge v-if="event.verdict" :tone="VERDICT_TONE[event.verdict]">{{ event.score }}</UiBadge>
          <button
            v-if="event.run"
            type="button"
            class="min-w-0 flex-1 text-left text-slate-300 hover:text-slate-100"
            :title="event.text"
            @click="emit('open', event.run)"
          >
            {{ event.text }}
          </button>
          <span v-else class="min-w-0 flex-1 text-slate-300">{{ event.text }}</span>
        </li>
      </ol>
    </div>
  </UiCard>
</template>
