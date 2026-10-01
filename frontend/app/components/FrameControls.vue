<template>
  <div class="space-y-3">
    <div class="grid gap-4 sm:grid-cols-4">
      <label class="space-y-1.5 text-sm">
        <span class="block font-medium">Tỉ lệ</span>
        <select
          v-model="aspect"
          class="w-full rounded-lg border border-white/15 bg-ink-950 px-3 py-2 outline-none focus:border-white/40"
        >
          <option v-if="referenceRatio" :value="REFERENCE_ASPECT">
            theo ảnh ref — {{ referenceRatio.label }}
          </option>
          <option v-for="option in ASPECTS" :key="option" :value="option">{{ option }}</option>
        </select>
      </label>

      <label class="space-y-1.5 text-sm">
        <span class="block font-medium">Megapixel</span>
        <input
          v-model.number="megapixels"
          type="number"
          :min="spec.frame.minMegapixels"
          :max="spec.frame.maxMegapixels"
          step="any"
          class="w-full rounded-lg border border-white/15 bg-ink-950 px-3 py-2 outline-none focus:border-white/40"
        />
      </label>

      <label v-if="spec.duration" class="space-y-1.5 text-sm">
        <span class="block font-medium">Độ dài (giây)</span>
        <input
          v-model.number="seconds"
          type="number"
          :min="spec.duration.minSeconds"
          :max="spec.duration.maxSeconds"
          step="any"
          class="w-full rounded-lg border border-white/15 bg-ink-950 px-3 py-2 outline-none focus:border-white/40"
        />
      </label>

      <label v-if="spec.duration && spec.duration.fps === null" class="space-y-1.5 text-sm">
        <span class="block font-medium">FPS</span>
        <input
          v-model.number="fps"
          type="number"
          min="8"
          max="60"
          class="w-full rounded-lg border border-white/15 bg-ink-950 px-3 py-2 outline-none focus:border-white/40"
        />
      </label>
    </div>

    <div class="flex flex-wrap items-center gap-3">
      <p class="flex-1 rounded-lg border border-white/10 bg-ink-950 px-3 py-2 font-mono text-xs text-ink-200">
        {{ summary }}
      </p>
      <button
        v-if="spec.frame.native === 'h3'"
        type="button"
        class="rounded-lg border px-3 py-2 text-xs"
        :class="onNativeCanvas ? 'border-white/60 text-white' : 'border-white/15 text-ink-200 hover:bg-white/10'"
        :title="`${nativeCanvas.width}×${nativeCanvas.height}`"
        @click="exact = { ...nativeCanvas }"
      >
        Canvas gốc {{ nativeCanvas.width }}×{{ nativeCanvas.height }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import {
  ASPECTS,
  REFERENCE_ASPECT,
  aspectRatio,
  frameForRatio,
  h3Canvas,
  latentTokens,
  resolveDuration,
  resolveH3Duration,
  type Aspect,
} from '@ai-studio/frame-math';
import type { CloudJobReference, JobTypeSpec } from '@ai-studio/cloud-contract';

const props = defineProps<{
  spec: JobTypeSpec;
  references: CloudJobReference[];
  values: Record<string, unknown>;
}>();

const aspect = ref<string>(props.spec.frame.defaultAspect);
const megapixels = ref<number>(props.spec.frame.defaultMegapixels);
const seconds = ref<number>(props.spec.duration?.defaultSeconds ?? 0);
const fps = ref<number>(props.spec.duration?.fps ?? 24);

/**
 * A size that did not come from the pixel budget.
 *
 * The native canvas is not a megapixel figure, it is the frame the model was
 * trained at, so it has to sit outside the arithmetic. Touching any size
 * control drops it and hands the frame back to the budget.
 */
const exact = ref<{ width: number; height: number } | null>(null);
watch([aspect, megapixels], () => (exact.value = null), { flush: 'sync' });

/** The first reference's own shape, which for image-to-video is the right one. */
const referenceRatio = computed(() => {
  const first = props.references[0];
  if (!first?.width || !first.height) return null;
  return { ratio: first.width / first.height, label: `${first.width}×${first.height}` };
});

const ratio = computed(() =>
  aspect.value === REFERENCE_ASPECT
    ? (referenceRatio.value?.ratio ?? 1)
    : aspectRatio(aspect.value as Aspect),
);

const nativeCanvas = computed(() => h3Canvas(ratio.value));

const frame = computed(
  () => exact.value ?? frameForRatio(ratio.value, megapixels.value, props.spec.frame.multiple),
);

const onNativeCanvas = computed(
  () => frame.value.width === nativeCanvas.value.width && frame.value.height === nativeCanvas.value.height,
);

const duration = computed(() => {
  const spec = props.spec.duration;
  if (!spec) return null;
  return spec.grid === 'h3' ? resolveH3Duration(seconds.value) : resolveDuration(seconds.value, fps.value);
});

const summary = computed(() => {
  const { width, height } = frame.value;
  const parts = [`${width}×${height}`, `${((width * height) / 1_000_000).toFixed(2)} MP`];
  if (duration.value) {
    parts.push(`${duration.value.numFrames} khung`, `${duration.value.seconds.toFixed(2)}s`);
    parts.push(`${latentTokens(width, height, duration.value.numFrames).toLocaleString('vi-VN')} token`);
  }
  return parts.join(' · ');
});

// The arm is told width/height/numFrames, never an aspect. Writing them back
// here is what keeps the form's arithmetic and the payload the same thing.
watchEffect(() => {
  props.values['width'] = frame.value.width;
  props.values['height'] = frame.value.height;
  if (!duration.value) return;
  props.values['numFrames'] = duration.value.numFrames;
  if (props.spec.duration?.fps === null) props.values['frameRate'] = fps.value;
});

// A reference arriving after the shape was chosen is the common case: the
// picker comes second in the form.
watch(referenceRatio, (next) => {
  if (next && aspect.value !== REFERENCE_ASPECT) aspect.value = REFERENCE_ASPECT;
  if (!next && aspect.value === REFERENCE_ASPECT) aspect.value = props.spec.frame.defaultAspect;
});

watch(
  () => props.spec.id,
  () => {
    aspect.value = props.spec.frame.defaultAspect;
    megapixels.value = props.spec.frame.defaultMegapixels;
    seconds.value = props.spec.duration?.defaultSeconds ?? 0;
    fps.value = props.spec.duration?.fps ?? 24;
    exact.value = null;
  },
);
</script>
