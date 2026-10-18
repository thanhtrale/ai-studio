<script setup lang="ts">
/**
 * Score a finished run, after looking at its outputs.
 *
 * The review is the gate between steps: a `pass` puts the run in its step's
 * gallery (for a sheet run, the sheets that passed the cross-check), and only
 * the gallery is offered to the next step. A later retry or fail takes it out
 * again. The same `PATCH` an agent writes through, so a person and an agent
 * leave the same record.
 *
 * What to look at, per step, is in docs/char3d.md: the cross-check numbers for
 * a sheet; the Detail sheet and the face close-ups for a mesh, compared with
 * the ORIGINAL reference; `handInBody` and stretch per clip for a rig.
 */
import { reactive, ref, watch } from 'vue';

import type { Char3dReview, Char3dVerdict } from '#shared/char3d';

import UiAlert from '../ui/Alert.vue';
import UiButton from '../ui/Button.vue';
import UiField from '../ui/Field.vue';
import UiInput from '../ui/Input.vue';
import UiNumberInput from '../ui/NumberInput.vue';
import UiSelect from '../ui/Select.vue';
import UiTextarea from '../ui/Textarea.vue';

const props = defineProps<{ charId: string; runId: string; review?: Char3dReview | undefined }>();
const emit = defineEmits<{ saved: [] }>();

const VERDICTS: { value: Char3dVerdict; label: string }[] = [
  { value: 'pass', label: 'Pass — into the gallery' },
  { value: 'retry', label: 'Retry — run this step again' },
  { value: 'fail', label: 'Fail — the input is the problem' },
];

const form = reactive({ score: 0, verdict: 'retry' as Char3dVerdict, summary: '', issues: '', improve: '', next: '' });

function load(review: Char3dReview | undefined): void {
  form.score = review?.score ?? 0;
  form.verdict = review?.verdict ?? 'retry';
  form.summary = review?.summary ?? '';
  form.issues = review?.issues.join('\n') ?? '';
  form.improve = review?.improve.join('\n') ?? '';
  form.next = review?.next ?? '';
}
watch(() => props.review, load, { immediate: true });

const saving = ref(false);
const failure = ref<string | null>(null);
const lines = (text: string): string[] =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

async function save(): Promise<void> {
  saving.value = true;
  failure.value = null;
  try {
    await $fetch(`/api/char3d/${props.charId}/runs/${props.runId}`, {
      method: 'PATCH',
      body: {
        review: {
          by: 'user',
          score: form.score,
          verdict: form.verdict,
          // Criteria an agent wrote are kept; the form does not edit them.
          criteria: props.review?.criteria ?? [],
          summary: form.summary,
          issues: lines(form.issues),
          improve: lines(form.improve),
          next: form.next,
          ...(props.review?.picks ? { picks: props.review.picks } : {}),
        },
      },
    });
    emit('saved');
  } catch (error) {
    failure.value = describeFetchError(error);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <form class="space-y-3" @submit.prevent="save">
    <div class="flex flex-wrap gap-4">
      <div class="w-28">
        <UiField label="Score" for="review-score" hint="0–100">
          <UiNumberInput id="review-score" v-model="form.score" :min="0" :max="100" />
        </UiField>
      </div>
      <div class="min-w-64 flex-1">
        <UiField label="Verdict" for="review-verdict">
          <UiSelect id="review-verdict" v-model="form.verdict" :options="VERDICTS" />
        </UiField>
      </div>
    </div>
    <UiField label="Summary" for="review-summary">
      <UiTextarea id="review-summary" v-model="form.summary" :rows="2" />
    </UiField>
    <div class="flex flex-wrap gap-4">
      <div class="min-w-64 flex-1">
        <UiField label="Issues" for="review-issues" hint="One per line.">
          <UiTextarea id="review-issues" v-model="form.issues" :rows="3" />
        </UiField>
      </div>
      <div class="min-w-64 flex-1">
        <UiField label="To improve" for="review-improve" hint="One per line.">
          <UiTextarea id="review-improve" v-model="form.improve" :rows="3" />
        </UiField>
      </div>
    </div>
    <UiField label="Next" for="review-next" hint="The decision: what runs next, from what.">
      <UiInput id="review-next" v-model="form.next" />
    </UiField>
    <UiAlert v-if="failure" tone="error">{{ failure }}</UiAlert>
    <UiButton type="submit" variant="primary" :disabled="saving">{{ review ? 'Update review' : 'Save review' }}</UiButton>
  </form>
</template>
