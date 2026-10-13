<script setup lang="ts">
/**
 * Review a detected rig before it is bound: move joints, repaint weights,
 * pose it to see how it bends -- then approve, and only then does Blender run.
 *
 * Full screen, laid out as 3D tools are: a toolbar across the top, the bone
 * outliner on the left, the viewport in the middle, properties on the right,
 * a status line along the bottom. Everything has a keyboard shortcut, and `?`
 * lists them.
 *
 * This component owns the truth -- the bones, the weights buffers, the undo
 * history -- and the viewport (`utils/rig/viewport.ts`) draws it and reports
 * what the pointer did. Nothing here is reactive that three.js reads every
 * frame: the bones are a shallow ref replaced wholesale, and the weights are
 * typed arrays the viewport and the GPU share.
 */
import { computed, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from 'vue';

import type { RigBoneEdits, Vec3 } from '#shared/generate';

import {
  draftUrl,
  encodeWeights,
  INFLUENCES,
  loadDraft,
  type InfluenceBuffers,
  type LoadedDraft,
} from '../../utils/rig/draft';
import { History } from '../../utils/rig/history';
import { cleanSmall, smoothBone, swapStroke, type StrokeRecord } from '../../utils/rig/paint';
import {
  add,
  type Bone,
  boneEdits,
  buildSkeleton,
  centreInSection,
  changedBones,
  cloneBones,
  connectedParent,
  distance,
  type Handle,
  jointAxis,
  length,
  mirrorBones,
  mirrorIndex,
  moveJoint,
  scale,
  type Skeleton,
} from '../../utils/rig/skeleton';
import {
  createRigViewport,
  type EditorMode,
  type PosePreset,
  type RigViewport,
  type Shading,
  type Tool,
  type ViewPreset,
  type WeightView,
} from '../../utils/rig/viewport';
import { type Brush, type BrushMode, cloneInfluences } from '../../utils/rig/weights';
import UiButton from '../ui/Button.vue';
import RigNumber from './RigNumber.vue';
import RigOutliner from './RigOutliner.vue';

const props = defineProps<{
  draftId: string;
  /** Shown in the title bar. */
  meshName: string;
  /** While the parent binds the approved rig. */
  busy?: boolean;
}>();

const emit = defineEmits<{
  /** Approved: the bones that moved. Edited weights are already saved to the draft. */
  approve: [RigBoneEdits];
  discard: [];
}>();

const host = ref<HTMLDivElement | null>(null);
const status = ref<'loading' | 'ready' | 'failed' | 'saving'>('loading');
const failure = ref<string | null>(null);

let viewport: RigViewport | null = null;
let draft: LoadedDraft | null = null;
let skeleton: Skeleton | null = null;
/** The weights as detected, for "Reset weights". */
let detectedWeights: InfluenceBuffers | null = null;

/** The skeleton as detected, gaps closed: what "moved" is measured against. */
const detected = shallowRef<Bone[]>([]);
const bones = shallowRef<Bone[]>([]);
const children = shallowRef<number[][]>([]);
const selected = ref<Handle | null>(null);
const hover = ref<string | null>(null);
const weightsEdited = ref(false);
const showHelp = ref(false);
const confirmingDiscard = ref(false);

const mode = ref<EditorMode>('skeleton');
const tool = ref<Tool>('move');
const mirror = ref(true);
const withChildren = ref(false);
const shading = ref<Shading>('xray');
const weightView = ref<WeightView>('selected');
const frontOnly = ref(true);
const showBones = ref(true);
const showMesh = ref(true);
const brush = reactive<Brush>({ mode: 'add', radius: 0.06, strength: 0.5, value: 0.5, falloff: 1 });
/** The body's height in the rig's frame; brush sizes are shown against it. */
const bodyHeight = ref(2);

const historyTick = ref(0);
const history = new History(300, () => historyTick.value++);
const canUndo = computed(() => (historyTick.value, history.canUndo));
const canRedo = computed(() => (historyTick.value, history.canRedo));
const undoLabel = computed(() => (historyTick.value, history.nextUndo));
const redoLabel = computed(() => (historyTick.value, history.nextRedo));

const MODES: { value: EditorMode; label: string; key: string }[] = [
  { value: 'skeleton', label: 'Skeleton', key: '1' },
  { value: 'weights', label: 'Weights', key: '2' },
  { value: 'pose', label: 'Pose test', key: '3' },
];
const BRUSH_MODES: { value: BrushMode; label: string; hint: string }[] = [
  { value: 'add', label: 'Add', hint: 'Raise the bone toward 100% (Ctrl to subtract)' },
  { value: 'subtract', label: 'Subtract', hint: 'Lower the bone toward 0% (Ctrl to add)' },
  { value: 'set', label: 'Set', hint: 'Move toward the value below' },
  { value: 'smooth', label: 'Smooth', hint: 'Even out with the neighbours (or hold Shift with any brush)' },
];
const POSES: { value: PosePreset; label: string }[] = [
  { value: 'arms-down', label: 'Arms down' },
  { value: 'arms-forward', label: 'Arms forward' },
  { value: 'squat', label: 'Squat' },
  { value: 'twist', label: 'Twist' },
];
const VIEWS: { value: ViewPreset; label: string; key: string }[] = [
  { value: 'front', label: 'Front', key: 'Num1' },
  { value: 'right', label: 'Side', key: 'Num3' },
  { value: 'top', label: 'Top', key: 'Num7' },
  { value: 'perspective', label: 'Persp', key: 'Num0' },
];
const SHORTCUTS: [string, string][] = [
  ['1 / 2 / 3', 'Skeleton · Weights · Pose test'],
  ['G / R', 'Move / Rotate tool (skeleton)'],
  ['Drag a joint', 'Move it in the view plane'],
  ['Drag gizmo', 'Move along one axis or turn about one'],
  ['X', 'Mirror left ↔ right'],
  ['C', 'Move with children'],
  ['Ctrl+Z / Ctrl+Shift+Z', 'Undo / Redo'],
  ['F / Home', 'Frame selected / everything'],
  ['Numpad 1 / 3 / 7 / 0', 'Front / Side / Top / Perspective'],
  ['Esc', 'Deselect'],
  ['Alt+H', 'Show or hide the mesh'],
  ['Drag on mesh', 'Paint (weights mode)'],
  ['Ctrl+drag / Shift+drag', 'Paint inverted / Smooth'],
  ['[ / ]', 'Brush smaller / larger'],
  ['Shift+[ / ]', 'Brush weaker / stronger'],
  ['Right-drag / Wheel', 'Pan / Zoom'],
  ['Alt+drag', 'Orbit, even over the mesh'],
  ['?', 'This list'],
];

const selectedBone = computed(() => (selected.value ? bones.value[selected.value.bone] ?? null : null));
const edited = computed(() => new Set(changedBones(detected.value, bones.value)));
const editedCount = computed(() => edited.value.size);
const hasEdits = computed(() => editedCount.value > 0 || weightsEdited.value);
const canEditTail = computed(() => {
  if (!selected.value || !skeleton) return false;
  return skeleton.connectedChild[selected.value.bone]! < 0;
});
const vertexCount = ref(0);
const connectedName = computed(() => {
  const child = selected.value && skeleton ? skeleton.connectedChild[selected.value.bone]! : -1;
  return child >= 0 ? short(bones.value[child]!.name) : '';
});
const parentName = computed(() => {
  const bone = selectedBone.value;
  return bone && bone.parent >= 0 ? short(bones.value[bone.parent]!.name) : '—';
});

function short(name: string): string {
  return name.replace('mixamorig:', '');
}

function unit(v: Vec3): Vec3 {
  return scale(v, 1 / (length(v) || 1));
}

// --- Loading -----------------------------------------------------------------

onMounted(async () => {
  window.addEventListener('keydown', onKeydown);
  document.body.style.overflow = 'hidden';
  if (!host.value) return;
  try {
    draft = await loadDraft(props.draftId);
    skeleton = buildSkeleton(draft.info);
    vertexCount.value = draft.info.vertexCount;
    detected.value = cloneBones(skeleton.bones);
    bones.value = cloneBones(skeleton.bones);
    children.value = skeleton.children;
    detectedWeights = cloneInfluences(draft.weights);
    viewport = await createRigViewport(host.value, {
      select: (handle) => (selected.value = handle),
      preview: (next) => (bones.value = next),
      commit: (before, after, label) => record(before, after, label),
      stroke: (strokeRecord, label) => recordStroke(strokeRecord, label),
      hover: (text) => (hover.value = text),
    });
    await viewport.load(draftUrl(props.draftId, 'mesh.glb'), skeleton, bones.value, draft.weights);
    const positions = viewport.positions();
    if (positions) {
      let low = Infinity;
      let high = -Infinity;
      for (let i = 1; i < positions.length; i += 3) {
        low = Math.min(low, positions[i]!);
        high = Math.max(high, positions[i]!);
      }
      bodyHeight.value = high - low || 2;
      brush.radius = Number((bodyHeight.value * 0.03).toFixed(3));
    }
    pushSettings();
    status.value = 'ready';
  } catch (error) {
    status.value = 'failed';
    failure.value = error instanceof Error ? error.message : String(error);
  }
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown);
  document.body.style.overflow = '';
  viewport?.dispose();
  viewport = null;
});

function pushSettings(): void {
  viewport?.set({
    mode: mode.value,
    tool: tool.value,
    mirror: mirror.value,
    withChildren: withChildren.value,
    shading: shading.value,
    weightView: weightView.value,
    brush: { ...brush },
    frontOnly: frontOnly.value,
    showBones: showBones.value,
    showMesh: showMesh.value,
    selected: selected.value,
  });
}

watch(mode, (value) => viewport?.set({ mode: value }));
watch(tool, (value) => viewport?.set({ tool: value }));
watch(mirror, (value) => viewport?.set({ mirror: value }));
watch(withChildren, (value) => viewport?.set({ withChildren: value }));
watch(shading, (value) => viewport?.set({ shading: value }));
watch(weightView, (value) => viewport?.set({ weightView: value }));
watch(frontOnly, (value) => viewport?.set({ frontOnly: value }));
watch(showBones, (value) => viewport?.set({ showBones: value }));
watch(showMesh, (value) => viewport?.set({ showMesh: value }));
watch(brush, (value) => viewport?.set({ brush: { ...value } }), { deep: true });
watch(selected, (value) => viewport?.set({ selected: value }));

function setView(preset: ViewPreset): void {
  viewport?.view(preset);
}

function frameSelected(): void {
  viewport?.frame(selected.value ? 'selected' : 'all');
}

function poseTo(preset: PosePreset): void {
  viewport?.pose(preset);
}

// --- Edits and history ---------------------------------------------------------

function applyBones(next: Bone[]): void {
  bones.value = next;
  viewport?.setBones(next);
}

/** One undoable change to the bones. */
function record(before: Bone[], after: Bone[], label: string): void {
  applyBones(after);
  if (changedBones(before, after).length === 0) return;
  history.push({ label, undo: () => applyBones(before), redo: () => applyBones(after) });
}

function recordStroke(strokeRecord: StrokeRecord, label: string): void {
  const context = viewport?.paintContext();
  if (!context || strokeRecord.size === 0) return;
  weightsEdited.value = true;
  const swap = (): void => {
    swapStroke(context.weights, strokeRecord, context.members);
    viewport?.weightsChanged();
  };
  history.push({ label, undo: swap, redo: swap });
}

function undo(): void {
  history.undo();
}

function redo(): void {
  history.redo();
}

/** A joint's position typed or scrubbed in the properties panel. */
function jointTo(end: 'head' | 'tail', axis: 0 | 1 | 2, value: number): Bone[] | null {
  if (!skeleton || !selected.value) return null;
  const bone = bones.value[selected.value.bone]!;
  const to = [...bone[end]] as Vec3;
  to[axis] = value;
  return moveJoint(skeleton, bones.value, { bone: selected.value.bone, end }, to, {
    mirror: mirror.value,
    withChildren: withChildren.value,
  });
}

/** Bones before a scrub started, so the whole scrub is one undo. */
let scrubBefore: Bone[] | null = null;

function previewJoint(end: 'head' | 'tail', axis: 0 | 1 | 2, value: number): void {
  if (!skeleton || !selected.value) return;
  scrubBefore ??= bones.value;
  const bone = scrubBefore[selected.value.bone]!;
  const to = [...bone[end]] as Vec3;
  to[axis] = value;
  const next = moveJoint(skeleton, scrubBefore, { bone: selected.value.bone, end }, to, {
    mirror: mirror.value,
    withChildren: withChildren.value,
  });
  bones.value = next;
  viewport?.setBones(next);
}

function commitJoint(end: 'head' | 'tail', axis: 0 | 1 | 2, value: number): void {
  const before = scrubBefore ?? bones.value;
  scrubBefore = null;
  bones.value = before;
  const after = jointTo(end, axis, value);
  if (after) record(before, after, `Set ${end} ${'XYZ'[axis]}`);
}

/** Put the selected joint in the middle of the mesh's cross-section. */
function centreJoint(): void {
  if (!skeleton || !selected.value || !viewport) return;
  const positions = viewport.positions();
  if (!positions) return;
  const handle = selected.value;
  const point = bones.value[handle.bone]![handle.end];
  // A connected joint is shared with the parent: average the two bones' axes.
  const parent = handle.end === 'head' ? connectedParent(skeleton, handle.bone) : -1;
  const own = unit(jointAxis(bones.value, handle));
  const axis = parent >= 0 ? add(own, unit(jointAxis(bones.value, { bone: parent, end: 'head' }))) : own;
  const centre = centreInSection(positions, point, axis, bodyHeight.value * 0.12, bodyHeight.value * 0.008);
  if (!centre) {
    hover.value = 'No mesh around this joint to centre it in';
    return;
  }
  const after = moveJoint(skeleton, bones.value, handle, centre, { mirror: mirror.value, withChildren: false });
  record(bones.value, after, 'Centre joint in mesh');
}

/** Copy the selected bone onto its counterpart on the other side. */
function mirrorSelected(): void {
  if (!selected.value) return;
  if (mirrorIndex(bones.value, selected.value.bone) < 0) return;
  record(bones.value, mirrorBones(bones.value, [selected.value.bone]), 'Mirror bone');
}

/** Every left-side bone copied to the right, or the reverse. */
function symmetrise(from: 'Left' | 'Right'): void {
  const sources = bones.value.flatMap((bone, index) => (bone.name.includes(from) ? [index] : []));
  record(bones.value, mirrorBones(bones.value, sources), `Symmetrise ${from} → ${from === 'Left' ? 'Right' : 'Left'}`);
}

function resetBone(): void {
  if (!selected.value) return;
  const index = selected.value.bone;
  const after = cloneBones(bones.value);
  after[index] = { ...detected.value[index]!, head: [...detected.value[index]!.head] as Vec3, tail: [...detected.value[index]!.tail] as Vec3 };
  record(bones.value, after, 'Reset bone');
}

function resetAllBones(): void {
  record(bones.value, cloneBones(detected.value), 'Reset all bones');
}

function wholeMesh(label: string, run: (strokeRecord: StrokeRecord) => number): void {
  const context = viewport?.paintContext();
  if (!context) return;
  const strokeRecord: StrokeRecord = new Map();
  const count = run(strokeRecord);
  viewport?.weightsChanged();
  hover.value = `${label}: ${count.toLocaleString()} vertices`;
  if (strokeRecord.size) recordStroke(strokeRecord, label);
}

function smoothSelectedBone(): void {
  const bone = selected.value?.bone;
  const context = viewport?.paintContext();
  if (bone === undefined || !context) return;
  wholeMesh(`Smooth ${short(bones.value[bone]!.name)}`, (r) => smoothBone(context, bone, 2, 0.5, r));
}

function cleanWeights(): void {
  const context = viewport?.paintContext();
  if (!context) return;
  wholeMesh('Clean weights under 5%', (r) => cleanSmall(context, 0.05, r));
}

function resetWeights(): void {
  const context = viewport?.paintContext();
  if (!context || !detectedWeights) return;
  const original = detectedWeights;
  const { weights } = context;
  wholeMesh('Reset weights', (r) => {
    for (const [leader, members] of context.members) {
      const base = leader * INFLUENCES;
      const end = base + INFLUENCES;
      const same = weights.values.subarray(base, end).every((value, s) => value === original.values[base + s]) &&
        weights.indices.subarray(base, end).every((index, s) => index === original.indices[base + s]);
      if (same) continue;
      // The before-image is what is there now, so undo puts the edits back.
      r.set(leader, { indices: weights.indices.slice(base, end), values: weights.values.slice(base, end) });
      for (const member of members) {
        const at = member * INFLUENCES;
        weights.indices.set(original.indices.subarray(at, at + INFLUENCES), at);
        weights.values.set(original.values.subarray(at, at + INFLUENCES), at);
      }
    }
    return r.size;
  });
}

// --- Keyboard ------------------------------------------------------------------

function onKeydown(event: KeyboardEvent): void {
  const target = event.target as HTMLElement | null;
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
  if (status.value !== 'ready') return;
  const ctrl = event.ctrlKey || event.metaKey;
  const key = event.key;

  if (ctrl && key.toLowerCase() === 'z') {
    event.preventDefault();
    if (event.shiftKey) redo();
    else undo();
    return;
  }
  if (ctrl && key.toLowerCase() === 'y') {
    event.preventDefault();
    redo();
    return;
  }
  if (ctrl) return;

  if (event.altKey && key.toLowerCase() === 'h') {
    event.preventDefault();
    showMesh.value = !showMesh.value;
    return;
  }

  const numpad: Record<string, ViewPreset> = { Numpad1: 'front', Numpad3: 'right', Numpad7: 'top', Numpad0: 'perspective' };
  if (numpad[event.code]) {
    event.preventDefault();
    viewport?.view(numpad[event.code]!);
    return;
  }

  switch (key) {
    case '1':
      mode.value = 'skeleton';
      break;
    case '2':
      mode.value = 'weights';
      break;
    case '3':
      mode.value = 'pose';
      break;
    case 'g':
    case 'G':
    case 'w':
      tool.value = 'move';
      break;
    case 'r':
    case 'R':
    case 'e':
      tool.value = 'rotate';
      break;
    case 'x':
    case 'X':
      mirror.value = !mirror.value;
      break;
    case 'c':
    case 'C':
      withChildren.value = !withChildren.value;
      break;
    case 'f':
    case 'F':
      viewport?.frame(selected.value ? 'selected' : 'all');
      break;
    case 'Home':
      viewport?.frame('all');
      break;
    case 'Escape':
      if (showHelp.value) showHelp.value = false;
      else if (confirmingDiscard.value) confirmingDiscard.value = false;
      else selected.value = null;
      break;
    case '[':
    case '{':
      if (event.shiftKey) brush.strength = Math.max(0.05, Number((brush.strength - 0.05).toFixed(2)));
      else brush.radius = Math.max(0.002, Number((brush.radius / 1.15).toFixed(4)));
      break;
    case ']':
    case '}':
      if (event.shiftKey) brush.strength = Math.min(1, Number((brush.strength + 0.05).toFixed(2)));
      else brush.radius = Math.min(bodyHeight.value * 0.3, Number((brush.radius * 1.15).toFixed(4)));
      break;
    case '?':
      showHelp.value = !showHelp.value;
      break;
    default:
      return;
  }
  event.preventDefault();
}

// --- Approve / discard -----------------------------------------------------------

async function approve(): Promise<void> {
  if (status.value !== 'ready' || !draft) return;
  status.value = 'saving';
  failure.value = null;
  try {
    if (weightsEdited.value) {
      await $fetch(`/api/rig/drafts/${encodeURIComponent(props.draftId)}/weights`, {
        method: 'PUT',
        body: encodeWeights(draft.weights),
        headers: { 'content-type': 'application/octet-stream' },
      });
    }
    emit('approve', boneEdits(detected.value, bones.value));
  } catch (error) {
    failure.value = describeFetchError(error);
  } finally {
    status.value = 'ready';
  }
}

function discard(): void {
  if (hasEdits.value && !confirmingDiscard.value) {
    confirmingDiscard.value = true;
    return;
  }
  emit('discard');
}

const AXES = [
  { axis: 0 as const, label: 'X', tone: 'text-rose-400' },
  { axis: 1 as const, label: 'Y', tone: 'text-emerald-400' },
  { axis: 2 as const, label: 'Z', tone: 'text-sky-400' },
];
</script>

<template>
  <div class="fixed inset-0 z-50 flex flex-col bg-[#0b0d12] text-slate-200" data-testid="rig-editor">
    <!-- Toolbar -->
    <header class="flex flex-wrap items-center gap-2 border-b border-white/10 bg-[#11141b] px-3 py-2 text-xs">
      <span class="mr-2 truncate text-sm font-medium text-slate-100" :title="meshName">Review rig · {{ meshName }}</span>

      <div class="flex overflow-hidden rounded border border-white/10" role="tablist" aria-label="Mode">
        <button
          v-for="option in MODES"
          :key="option.value"
          type="button"
          role="tab"
          :aria-selected="mode === option.value"
          class="px-3 py-1.5"
          :class="mode === option.value ? 'bg-indigo-500 text-white' : 'text-slate-300 hover:bg-white/5'"
          :title="`${option.label} (${option.key})`"
          :data-testid="`mode-${option.value}`"
          @click="mode = option.value"
        >
          {{ option.label }}
        </button>
      </div>

      <div v-if="mode === 'skeleton'" class="flex overflow-hidden rounded border border-white/10">
        <button
          type="button"
          class="px-2.5 py-1.5"
          :class="tool === 'move' ? 'bg-white/15 text-white' : 'text-slate-300 hover:bg-white/5'"
          title="Move joints (G)"
          @click="tool = 'move'"
        >
          ✥ Move
        </button>
        <button
          type="button"
          class="px-2.5 py-1.5"
          :class="tool === 'rotate' ? 'bg-white/15 text-white' : 'text-slate-300 hover:bg-white/5'"
          title="Rotate a bone and everything below it about its head (R)"
          @click="tool = 'rotate'"
        >
          ⟳ Rotate
        </button>
      </div>

      <UiButton size="sm" :active="mirror" title="Mirror edits to the other side (X)" @click="mirror = !mirror">
        ⇋ Mirror X
      </UiButton>
      <UiButton
        v-if="mode === 'skeleton'"
        size="sm"
        :active="withChildren"
        title="Moving a joint carries everything below it (C)"
        @click="withChildren = !withChildren"
      >
        With children
      </UiButton>

      <span class="mx-1 h-5 w-px bg-white/10" />
      <UiButton size="sm" :disabled="!canUndo" :title="undoLabel ? `Undo ${undoLabel} (Ctrl+Z)` : 'Nothing to undo'" @click="undo">
        ↶ Undo
      </UiButton>
      <UiButton size="sm" :disabled="!canRedo" :title="redoLabel ? `Redo ${redoLabel} (Ctrl+Shift+Z)` : 'Nothing to redo'" @click="redo">
        ↷ Redo
      </UiButton>

      <span class="mx-1 h-5 w-px bg-white/10" />
      <div class="flex overflow-hidden rounded border border-white/10">
        <button
          v-for="option in VIEWS"
          :key="option.value"
          type="button"
          class="px-2 py-1.5 text-slate-300 hover:bg-white/5"
          :title="`${option.label} view (${option.key})`"
          @click="setView(option.value)"
        >
          {{ option.label }}
        </button>
      </div>
      <select
        v-model="shading"
        class="rounded border border-white/10 bg-black/40 px-2 py-1.5 text-xs text-slate-200"
        aria-label="Shading"
        :disabled="mode === 'weights' && weightView !== 'off'"
      >
        <option value="xray">X-ray</option>
        <option value="clay">Clay</option>
        <option value="material">Material</option>
      </select>
      <UiButton size="sm" :active="showBones" title="Show bones" @click="showBones = !showBones">Bones</UiButton>
      <UiButton size="sm" :active="showMesh" title="Show mesh (Alt+H)" @click="showMesh = !showMesh">Mesh</UiButton>
      <UiButton size="sm" title="Keyboard shortcuts (?)" @click="showHelp = !showHelp">?</UiButton>

      <div class="ml-auto flex items-center gap-2">
        <span v-if="hasEdits" class="text-amber-300">
          {{ editedCount }} bone{{ editedCount === 1 ? '' : 's' }} moved<template v-if="weightsEdited"> · weights edited</template>
        </span>
        <template v-if="confirmingDiscard">
          <span class="text-rose-300">Discard your edits?</span>
          <UiButton size="sm" variant="danger" data-testid="confirm-discard" @click="emit('discard')">Discard</UiButton>
          <UiButton size="sm" @click="confirmingDiscard = false">Keep editing</UiButton>
        </template>
        <UiButton v-else size="sm" variant="ghost" :disabled="busy" data-testid="discard" @click="discard">Discard</UiButton>
        <UiButton
          size="sm"
          variant="primary"
          :disabled="status !== 'ready' || busy"
          data-testid="approve"
          title="Bind the rig as it is now, and add the clips"
          @click="approve"
        >
          {{ busy ? 'Rigging…' : status === 'saving' ? 'Saving…' : 'Approve & rig' }}
        </UiButton>
      </div>
    </header>

    <div class="flex min-h-0 flex-1">
      <!-- Outliner -->
      <aside class="flex w-56 shrink-0 flex-col border-r border-white/10 bg-[#0f1218]">
        <p class="border-b border-white/10 px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-slate-500">
          Bones · {{ bones.length }}
        </p>
        <RigOutliner
          class="min-h-0 flex-1"
          :bones="bones"
          :children="children"
          :selected="selected?.bone ?? null"
          :edited="edited"
          @select="(index) => (selected = { bone: index, end: 'head' })"
        />
      </aside>

      <!-- Viewport -->
      <main class="relative min-w-0 flex-1">
        <div ref="host" class="absolute inset-0" data-testid="rig-viewport" />
        <div
          v-if="status === 'loading' || status === 'failed'"
          class="pointer-events-none absolute inset-0 flex items-center justify-center p-6 text-center text-sm"
          :class="status === 'failed' ? 'text-rose-300' : 'text-slate-500'"
        >
          {{ status === 'failed' ? `Could not open the draft: ${failure}` : 'Loading the detected rig…' }}
        </div>
        <div
          v-if="mode === 'weights' && weightView === 'selected'"
          class="pointer-events-none absolute right-3 top-3 w-40 rounded bg-black/60 p-2 text-[10px] text-slate-300"
        >
          <div class="h-2 rounded" style="background: linear-gradient(90deg, #0d1259, #0000ff, #00ffff, #00ff00, #ffff00, #ff0000)" />
          <div class="mt-1 flex justify-between"><span>0%</span><span>50%</span><span>100%</span></div>
        </div>
        <div
          v-if="mode === 'weights' && !selected && status === 'ready'"
          class="pointer-events-none absolute left-1/2 top-3 -translate-x-1/2 rounded bg-amber-500/20 px-3 py-1 text-xs text-amber-200"
        >
          Pick a bone in the list to paint its weights
        </div>
        <div
          v-if="showHelp"
          class="absolute right-3 top-3 z-10 w-80 rounded-lg border border-white/10 bg-[#11141b]/95 p-3 text-xs shadow-xl"
          data-testid="shortcuts"
        >
          <div class="mb-2 flex items-center justify-between">
            <span class="font-medium text-slate-100">Shortcuts</span>
            <button type="button" class="text-slate-500 hover:text-slate-200" @click="showHelp = false">✕</button>
          </div>
          <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            <template v-for="[keys, what] in SHORTCUTS" :key="keys">
              <dt class="font-mono text-slate-400">{{ keys }}</dt>
              <dd class="text-slate-300">{{ what }}</dd>
            </template>
          </dl>
        </div>
      </main>

      <!-- Properties -->
      <aside class="w-72 shrink-0 space-y-4 overflow-y-auto border-l border-white/10 bg-[#0f1218] p-3 text-xs">
        <section v-if="selectedBone" class="space-y-2" data-testid="bone-properties">
          <h3 class="text-[11px] font-medium uppercase tracking-wide text-slate-500">Bone</h3>
          <p class="text-sm text-slate-100">{{ short(selectedBone.name) }}</p>
          <p class="text-slate-500">
            parent {{ parentName }} · length {{ distance(selectedBone.head, selectedBone.tail).toFixed(3) }}
            <template v-if="mirrorIndex(bones, selected!.bone) >= 0">
              · mirror {{ short(bones[mirrorIndex(bones, selected!.bone)]!.name) }}
            </template>
          </p>

          <div class="space-y-1">
            <p class="text-slate-400">Head</p>
            <div class="grid grid-cols-3 gap-1">
              <RigNumber
                v-for="{ axis, label, tone } in AXES"
                :key="`h${axis}`"
                :model-value="selectedBone.head[axis]"
                :label="label"
                :tone="tone"
                :disabled="mode !== 'skeleton'"
                @preview="(value) => previewJoint('head', axis, value)"
                @commit="(value) => commitJoint('head', axis, value)"
              />
            </div>
          </div>
          <div class="space-y-1">
            <p class="text-slate-400">
              Tail
              <span v-if="!canEditTail" class="text-slate-600">— is {{ connectedName }}'s head</span>
            </p>
            <div class="grid grid-cols-3 gap-1">
              <RigNumber
                v-for="{ axis, label, tone } in AXES"
                :key="`t${axis}`"
                :model-value="selectedBone.tail[axis]"
                :label="label"
                :tone="tone"
                :disabled="mode !== 'skeleton'"
                @preview="(value) => previewJoint('tail', axis, value)"
                @commit="(value) => commitJoint('tail', axis, value)"
              />
            </div>
          </div>

          <div v-if="mode === 'skeleton'" class="grid grid-cols-2 gap-1 pt-1">
            <UiButton size="sm" title="Move the joint to the middle of the mesh around it" @click="centreJoint">
              Centre in mesh
            </UiButton>
            <UiButton
              size="sm"
              :disabled="mirrorIndex(bones, selected!.bone) < 0"
              title="Copy this bone onto its counterpart on the other side"
              @click="mirrorSelected"
            >
              Copy to other side
            </UiButton>
            <UiButton size="sm" :disabled="!edited.has(selected!.bone)" @click="resetBone">Reset bone</UiButton>
            <UiButton size="sm" @click="frameSelected">Frame (F)</UiButton>
          </div>
        </section>
        <p v-else class="text-slate-500">
          Click a joint in the view, or a bone in the list. Drag a joint to move it; drag the gizmo's arrows to
          keep to one axis.
        </p>

        <section v-if="mode === 'skeleton'" class="space-y-2 border-t border-white/10 pt-3">
          <h3 class="text-[11px] font-medium uppercase tracking-wide text-slate-500">Skeleton</h3>
          <div class="grid grid-cols-2 gap-1">
            <UiButton size="sm" title="Copy every left bone onto the right" @click="symmetrise('Left')">Left → Right</UiButton>
            <UiButton size="sm" title="Copy every right bone onto the left" @click="symmetrise('Right')">Right → Left</UiButton>
          </div>
          <UiButton size="sm" class="w-full" :disabled="editedCount === 0" @click="resetAllBones">
            Reset all bones to detected
          </UiButton>
          <p class="text-slate-500">
            Joints sit inside the body, at the pivot: the elbow in the middle of the arm at the bend, the hip at
            the top of the thigh. Check from the side (Numpad 3) as well as the front.
          </p>
        </section>

        <section v-if="mode === 'weights'" class="space-y-3 border-t border-white/10 pt-3" data-testid="brush">
          <h3 class="text-[11px] font-medium uppercase tracking-wide text-slate-500">Brush</h3>
          <div class="grid grid-cols-4 overflow-hidden rounded border border-white/10">
            <button
              v-for="option in BRUSH_MODES"
              :key="option.value"
              type="button"
              class="py-1.5"
              :class="brush.mode === option.value ? 'bg-indigo-500 text-white' : 'text-slate-300 hover:bg-white/5'"
              :title="option.hint"
              @click="brush.mode = option.value"
            >
              {{ option.label }}
            </button>
          </div>
          <label class="block space-y-1">
            <span class="flex justify-between text-slate-400">
              <span>Radius <span class="text-slate-600">[ ]</span></span>
              <span class="font-mono text-slate-300" title="On a 1.8 m body">≈ {{ ((brush.radius / bodyHeight) * 180).toFixed(1) }} cm</span>
            </span>
            <input v-model.number="brush.radius" type="range" :min="bodyHeight * 0.003" :max="bodyHeight * 0.3" :step="bodyHeight * 0.001" class="w-full accent-indigo-500" />
          </label>
          <label class="block space-y-1">
            <span class="flex justify-between text-slate-400">
              <span>Strength <span class="text-slate-600">⇧[ ]</span></span>
              <span class="font-mono text-slate-300">{{ Math.round(brush.strength * 100) }}%</span>
            </span>
            <input v-model.number="brush.strength" type="range" min="0.02" max="1" step="0.01" class="w-full accent-indigo-500" />
          </label>
          <label v-if="brush.mode === 'set'" class="block space-y-1">
            <span class="flex justify-between text-slate-400">
              <span>Value</span>
              <span class="font-mono text-slate-300">{{ Math.round(brush.value * 100) }}%</span>
            </span>
            <input v-model.number="brush.value" type="range" min="0" max="1" step="0.01" class="w-full accent-indigo-500" />
          </label>
          <label class="block space-y-1">
            <span class="flex justify-between text-slate-400">
              <span>Falloff</span>
              <span class="font-mono text-slate-300">{{ brush.falloff >= 0.99 ? 'smooth' : brush.falloff <= 0.01 ? 'hard' : Math.round(brush.falloff * 100) + '%' }}</span>
            </span>
            <input v-model.number="brush.falloff" type="range" min="0" max="1" step="0.01" class="w-full accent-indigo-500" />
          </label>
          <label class="flex items-center gap-2 text-slate-300">
            <input v-model="frontOnly" type="checkbox" class="accent-indigo-500" />
            Front faces only
          </label>
          <p class="text-slate-500">
            Only what faces the camera is painted, so a stroke on the chest does not reach the back. Turn it off to
            paint through.
          </p>

          <h3 class="pt-2 text-[11px] font-medium uppercase tracking-wide text-slate-500">Display</h3>
          <div class="grid grid-cols-3 overflow-hidden rounded border border-white/10">
            <button
              v-for="option in [
                { value: 'selected', label: 'Bone' },
                { value: 'dominant', label: 'All bones' },
                { value: 'off', label: 'Off' },
              ] as const"
              :key="option.value"
              type="button"
              class="py-1.5"
              :class="weightView === option.value ? 'bg-white/15 text-white' : 'text-slate-300 hover:bg-white/5'"
              @click="weightView = option.value"
            >
              {{ option.label }}
            </button>
          </div>

          <h3 class="pt-2 text-[11px] font-medium uppercase tracking-wide text-slate-500">Tools</h3>
          <div class="grid grid-cols-2 gap-1">
            <UiButton size="sm" :disabled="!selected" title="Smooth everything this bone holds, twice" @click="smoothSelectedBone">
              Smooth bone
            </UiButton>
            <UiButton size="sm" title="Drop influences under 5% and renormalise" @click="cleanWeights">Clean &lt; 5%</UiButton>
            <UiButton size="sm" class="col-span-2" :disabled="!weightsEdited" @click="resetWeights">Reset weights to detected</UiButton>
          </div>
        </section>

        <section v-if="mode === 'pose'" class="space-y-2 border-t border-white/10 pt-3">
          <h3 class="text-[11px] font-medium uppercase tracking-wide text-slate-500">Pose test</h3>
          <p class="text-slate-500">
            Bend the rig to see how the skin follows. Pick a joint and turn it with the gizmo, or try a pose.
            Nothing here changes the rig.
          </p>
          <div class="grid grid-cols-2 gap-1">
            <UiButton v-for="option in POSES" :key="option.value" size="sm" @click="poseTo(option.value)">
              {{ option.label }}
            </UiButton>
          </div>
          <UiButton size="sm" class="w-full" @click="poseTo('rest')">Reset pose</UiButton>
          <p class="text-slate-500">
            Where the skin tears or a sleeve follows the wrong bone, go to Weights (2) and paint it.
          </p>
        </section>

        <p v-if="failure && status !== 'failed'" class="rounded bg-rose-500/10 p-2 text-rose-200">{{ failure }}</p>
      </aside>
    </div>

    <!-- Status line -->
    <footer class="flex items-center gap-4 border-t border-white/10 bg-[#11141b] px-3 py-1 text-[11px] text-slate-500">
      <span>{{ vertexCount ? vertexCount.toLocaleString() : '…' }} vertices · {{ bones.length }} bones</span>
      <span v-if="hover" class="text-slate-300">{{ hover }}</span>
      <span class="ml-auto">
        <template v-if="mode === 'skeleton'">Drag a joint · gizmo for one axis · G/R tools · X mirror</template>
        <template v-else-if="mode === 'weights'">Drag to paint · Ctrl invert · Shift smooth · [ ] size · Alt+drag orbit</template>
        <template v-else>Click a joint, turn it · presets on the right</template>
        · ? for all shortcuts
      </span>
    </footer>
  </div>
</template>
