<script setup lang="ts">
/**
 * A number field as 3D tools have them: type a value, or drag on the label to
 * scrub it. Shift scrubs ten times finer, as in Blender.
 *
 * A scrub reports every step through `preview` and the end through `commit`,
 * so the viewport follows the drag live and the editor's undo history gets
 * one entry for the whole drag rather than one per pixel.
 */
import { ref, watch } from 'vue';

const props = withDefaults(
  defineProps<{
    modelValue: number;
    label: string;
    /** Tailwind text colour for the label: x red, y green, z blue, as every gizmo draws them. */
    tone?: string;
    /** Units per pixel of scrub. */
    speed?: number;
    digits?: number;
    min?: number;
    max?: number;
    disabled?: boolean;
  }>(),
  { tone: 'text-slate-400', speed: 0.002, digits: 3, min: -Infinity, max: Infinity, disabled: false },
);

const emit = defineEmits<{ preview: [number]; commit: [number] }>();

const text = ref(props.modelValue.toFixed(props.digits));
const editing = ref(false);
watch(
  () => props.modelValue,
  (value) => {
    if (!editing.value) text.value = value.toFixed(props.digits);
  },
);

const clamp = (value: number): number => Math.min(props.max, Math.max(props.min, value));

function commitText(): void {
  editing.value = false;
  const parsed = Number(text.value);
  if (Number.isFinite(parsed) && clamp(parsed) !== props.modelValue) emit('commit', clamp(parsed));
  else text.value = props.modelValue.toFixed(props.digits);
}

let scrub: { x: number; start: number; value: number } | null = null;

function onPointerDown(event: PointerEvent): void {
  if (props.disabled || event.button !== 0) return;
  (event.target as HTMLElement).setPointerCapture(event.pointerId);
  scrub = { x: event.clientX, start: props.modelValue, value: props.modelValue };
}

function onPointerMove(event: PointerEvent): void {
  if (!scrub) return;
  const step = props.speed * (event.shiftKey ? 0.1 : 1);
  scrub.value = clamp(scrub.start + (event.clientX - scrub.x) * step);
  text.value = scrub.value.toFixed(props.digits);
  emit('preview', scrub.value);
}

function onPointerUp(): void {
  if (!scrub) return;
  if (scrub.value !== scrub.start) emit('commit', scrub.value);
  scrub = null;
}
</script>

<template>
  <div
    class="flex h-7 min-w-0 items-stretch overflow-hidden rounded border border-white/10 bg-black/30 text-xs focus-within:border-indigo-400"
    :class="disabled ? 'opacity-40' : ''"
  >
    <span
      class="flex w-6 shrink-0 cursor-ew-resize select-none items-center justify-center bg-white/5 font-semibold"
      :class="tone"
      title="Drag to scrub · Shift for fine"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
    >
      {{ label }}
    </span>
    <input
      v-model="text"
      type="text"
      inputmode="decimal"
      :disabled="disabled"
      class="min-w-0 flex-1 bg-transparent px-1.5 font-mono text-slate-100 outline-none"
      @focus="editing = true"
      @blur="commitText"
      @keydown.enter="($event.target as HTMLInputElement).blur()"
      @keydown.escape="
        text = modelValue.toFixed(digits);
        editing = false;
        ($event.target as HTMLInputElement).blur();
      "
    />
  </div>
</template>
