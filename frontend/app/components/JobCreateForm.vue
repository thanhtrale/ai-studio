<template>
  <form class="space-y-6 rounded-xl border border-white/10 bg-white/5 p-5" @submit.prevent="onSubmit">
    <div class="space-y-1.5">
      <label class="block text-sm font-medium" for="job-type">Loại job</label>
      <select
        id="job-type"
        v-model="typeId"
        class="w-full rounded-lg border border-white/15 bg-ink-950 px-3 py-2 text-sm outline-none focus:border-white/40"
      >
        <option v-for="option in JOB_TYPES" :key="option.id" :value="option.id">
          {{ option.label }}{{ armAvailable(option.armId) ? '' : ' — arm chưa cài' }}
        </option>
      </select>
      <p class="text-xs text-ink-500">Arm: <code>{{ spec.armId }}</code></p>
    </div>

    <div v-for="group in GROUPS" :key="group.key" class="space-y-3">
      <h3 v-if="fieldsIn(group.key).length || group.key === 'frame'" class="text-xs uppercase tracking-wider text-ink-500">
        {{ group.label }}
      </h3>

      <FrameControls v-if="group.key === 'frame'" :spec="spec" :references="chosen" :values="values" />

      <div v-if="fieldsIn(group.key).length" :class="group.key === 'prompt' ? 'space-y-3' : 'grid gap-4 sm:grid-cols-3'">
        <JobFieldInput
          v-for="field in fieldsIn(group.key)"
          :key="field.name"
          :field="field"
          :model="values[field.name]"
          @update:model="values[field.name] = $event"
        />
      </div>
    </div>

    <fieldset v-if="spec.references" class="space-y-3">
      <legend class="text-xs uppercase tracking-wider text-ink-500">
        {{ spec.references.label }} (tối đa {{ spec.references.max }})
      </legend>
      <p v-if="spec.references.help" class="text-xs text-ink-500">{{ spec.references.help }}</p>

      <div class="flex flex-wrap items-center gap-3">
        <label
          class="cursor-pointer rounded-lg border border-white/15 px-3 py-2 text-sm hover:bg-white/10"
          :class="{ 'pointer-events-none opacity-40': refs.uploading.value || atReferenceLimit }"
        >
          {{ refs.uploading.value ? 'Đang tải lên…' : 'Tải ảnh lên' }}
          <input type="file" accept="image/*" class="hidden" @change="onPickReference" />
        </label>
        <button type="button" class="rounded-lg border border-white/15 px-3 py-2 text-sm hover:bg-white/10" @click="refs.refresh">
          Ảnh đã dùng
        </button>
      </div>

      <p v-if="refs.error.value" class="text-sm text-red-300">{{ refs.error.value }}</p>

      <ol v-if="chosen.length" class="flex flex-wrap gap-3">
        <li v-for="(item, index) in chosen" :key="item.storagePath" class="relative">
          <img :src="item.downloadUrl" :alt="item.name" class="h-20 w-20 rounded-lg object-cover" />
          <span class="absolute left-1 top-1 rounded bg-ink-950/80 px-1.5 text-xs">{{ index + 1 }}</span>
          <button
            type="button"
            class="absolute right-1 top-1 rounded bg-ink-950/80 px-1.5 text-xs hover:text-red-300"
            @click="chosen.splice(index, 1)"
          >
            ×
          </button>
        </li>
      </ol>

      <div v-if="refs.items.value.length" class="flex flex-wrap gap-2">
        <button
          v-for="item in refs.items.value"
          :key="item.storagePath"
          type="button"
          class="rounded border border-white/15 p-0.5 hover:border-white/40 disabled:opacity-30"
          :disabled="atReferenceLimit"
          :title="item.name"
          @click="chosen.push(item)"
        >
          <img :src="item.downloadUrl" :alt="item.name" class="h-14 w-14 rounded object-cover" />
        </button>
      </div>
    </fieldset>

    <p v-if="error" class="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
      {{ error }}
    </p>

    <div class="flex flex-wrap items-center gap-3">
      <button
        type="submit"
        class="rounded-lg bg-white px-4 py-2 text-sm font-medium text-ink-950 hover:bg-ink-200 disabled:opacity-40"
        :disabled="busy || !promptFilled"
      >
        {{ busy ? 'Đang gửi…' : 'Tạo job' }}
      </button>
      <span v-if="!workerOnline" class="text-sm text-amber-300">
        Worker offline — job nằm chờ tới khi bật máy local.
      </span>
      <span v-else-if="!armAvailable(spec.armId)" class="text-sm text-amber-300">
        Worker không thấy arm này; job sẽ lỗi khi chạy.
      </span>
    </div>
  </form>
</template>

<script setup lang="ts">
import {
  JOB_TYPES,
  coerceJobValues,
  defaultJobValues,
  jobTypeById,
  type CloudJobReference,
  type JobField,
} from '@ai-studio/cloud-contract';

const props = defineProps<{
  workerOnline: boolean;
  workerArms: string[];
  submit: (input: {
    typeId: string;
    armId: string;
    values: Record<string, unknown>;
    references: CloudJobReference[];
  }) => Promise<string>;
}>();

const GROUPS = [
  { key: 'prompt', label: 'Nội dung' },
  { key: 'frame', label: 'Khung hình' },
  { key: 'sampling', label: 'Lấy mẫu' },
] as const;

const refs = useReferenceLibrary();

const typeId = ref(JOB_TYPES[0]!.id);
const spec = computed(() => jobTypeById(typeId.value) ?? JOB_TYPES[0]!);
const values = reactive<Record<string, unknown>>(defaultJobValues(spec.value));
const chosen = ref<CloudJobReference[]>([]);
const busy = ref(false);
const error = ref<string | null>(null);

// Field names differ between arms, so a switch starts from that arm's defaults
// rather than carrying over values that no longer mean anything.
watch(typeId, () => {
  for (const key of Object.keys(values)) delete values[key];
  Object.assign(values, defaultJobValues(spec.value));
  chosen.value = chosen.value.slice(0, spec.value.references?.max ?? 0);
});

const promptFilled = computed(() => String(values['prompt'] ?? '').trim().length > 0);
const atReferenceLimit = computed(() => chosen.value.length >= (spec.value.references?.max ?? 0));

function fieldsIn(group: string): JobField[] {
  return spec.value.fields.filter(
    (field) => !field.derived && (field.group ?? 'sampling') === group,
  );
}

function armAvailable(armId: string): boolean {
  return !props.workerOnline || props.workerArms.includes(armId);
}

async function onPickReference(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (file) {
    const uploaded = await refs.upload(file);
    if (uploaded && !atReferenceLimit.value) chosen.value.push(uploaded);
  }
  input.value = '';
}

async function onSubmit() {
  busy.value = true;
  error.value = null;
  try {
    await props.submit({
      typeId: spec.value.id,
      armId: spec.value.armId,
      values: coerceJobValues(spec.value, { ...values }),
      references: [...chosen.value],
    });
    values['prompt'] = '';
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    busy.value = false;
  }
}
</script>
