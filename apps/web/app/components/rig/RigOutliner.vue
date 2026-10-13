<script setup lang="ts">
/**
 * The bone hierarchy as a tree, as an outliner shows it: click to select,
 * filter by name, collapse a branch. Bones that differ from what was detected
 * carry a dot, so a review can see at a glance what it has touched.
 */
import { computed, ref } from 'vue';

import type { Bone } from '../../utils/rig/skeleton';

const props = defineProps<{
  bones: Bone[];
  children: number[][];
  selected: number | null;
  edited: Set<number>;
}>();

const emit = defineEmits<{ select: [number] }>();

const filter = ref('');
const collapsed = ref(new Set<number>());

const label = (bone: Bone): string => bone.name.replace('mixamorig:', '');

interface Row {
  index: number;
  depth: number;
  hasChildren: boolean;
}

const rows = computed<Row[]>(() => {
  const query = filter.value.trim().toLowerCase();
  const out: Row[] = [];
  const walk = (index: number, depth: number): void => {
    const bone = props.bones[index]!;
    const kids = props.children[index] ?? [];
    if (!query || label(bone).toLowerCase().includes(query)) {
      out.push({ index, depth: query ? 0 : depth, hasChildren: kids.length > 0 });
    }
    if (query || !collapsed.value.has(index)) for (const child of kids) walk(child, depth + 1);
  };
  props.bones.forEach((bone, index) => {
    if (bone.parent < 0) walk(index, 0);
  });
  return out;
});

function toggle(index: number): void {
  const next = new Set(collapsed.value);
  if (next.has(index)) next.delete(index);
  else next.add(index);
  collapsed.value = next;
}
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <div class="border-b border-white/10 p-2">
      <input
        v-model="filter"
        type="search"
        placeholder="Filter bones"
        class="w-full rounded border border-white/10 bg-black/30 px-2 py-1 text-xs text-slate-100 outline-none focus:border-indigo-400"
        data-testid="outliner-filter"
      />
    </div>
    <ul class="min-h-0 flex-1 overflow-y-auto py-1 text-xs" role="tree" aria-label="Bones">
      <li
        v-for="row in rows"
        :key="row.index"
        role="treeitem"
        :aria-selected="row.index === selected"
        class="flex cursor-pointer items-center gap-1 py-0.5 pr-2 hover:bg-white/5"
        :class="row.index === selected ? 'bg-indigo-500/25 text-white' : 'text-slate-300'"
        :style="{ paddingLeft: `${8 + row.depth * 12}px` }"
        :data-testid="`bone-${label(bones[row.index]!)}`"
        @click="emit('select', row.index)"
      >
        <button
          v-if="row.hasChildren && !filter"
          type="button"
          class="w-3 text-slate-500 hover:text-slate-200"
          :aria-label="collapsed.has(row.index) ? 'Expand' : 'Collapse'"
          @click.stop="toggle(row.index)"
        >
          {{ collapsed.has(row.index) ? '▸' : '▾' }}
        </button>
        <span v-else class="w-3" />
        <span class="truncate">{{ label(bones[row.index]!) }}</span>
        <span v-if="edited.has(row.index)" class="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" title="Moved" />
      </li>
    </ul>
  </div>
</template>
