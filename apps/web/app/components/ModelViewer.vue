<script setup lang="ts">
/**
 * A GLB on a turntable, drawn the way a three.js page would draw it.
 *
 * Deliberately the same loader and the same `MeshStandardMaterial` a site would
 * use, rather than a viewer with its own renderer: the question this answers is
 * "will this file look right on the web", and a nicer viewer would answer a
 * different one.
 *
 * A rigged GLB plays its clips through an `AnimationMixer`, as a page would:
 * the first one called Idle, or the first one there is, starts on load.
 *
 * three.js is imported inside `onMounted`. The page renders on the server first,
 * where there is no WebGL, and the library would otherwise pay for half a
 * megabyte of renderer on every page that never shows a mesh.
 */
import type * as THREE from 'three';
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';

import { formatBytes, formatCount } from '#shared/library';

import UiButton from './ui/Button.vue';

type Shading = 'original' | 'clay' | 'normals' | 'wireframe';

const props = withDefaults(
  defineProps<{
    src: string;
    /** Bytes on disk, shown beside the counts when known. */
    bytes?: number;
    /** Compact chrome for a thumbnail-sized slot: no toolbar, still orbitable. */
    compact?: boolean;
    autoRotate?: boolean;
  }>(),
  { bytes: undefined, compact: false, autoRotate: true },
);

const emit = defineEmits<{ stats: [MeshStats] }>();

interface MeshStats {
  vertices: number;
  faces: number;
  /** Bounding box edges in the file's own units, before the viewer scales it. */
  size: [number, number, number];
  textured: boolean;
}

const host = ref<HTMLDivElement | null>(null);
const status = ref<'loading' | 'ready' | 'failed'>('loading');
const failure = ref<string | null>(null);
const stats = shallowRef<MeshStats | null>(null);
const shading = ref<Shading>('original');
const rotating = ref(props.autoRotate);
const grid = ref(true);
/** Clip names in the file, in its own order; empty for a static mesh. */
const clips = ref<string[]>([]);
const clip = ref<string | null>(null);
const playing = ref(true);

const SHADINGS: { value: Shading; label: string }[] = [
  { value: 'original', label: 'Material' },
  { value: 'clay', label: 'Clay' },
  { value: 'normals', label: 'Normals' },
  { value: 'wireframe', label: 'Wire' },
];

/**
 * Everything three.js owns, kept out of Vue's reactivity on purpose: a
 * reactive proxy around a scene graph makes every frame walk it for nothing.
 */
let viewer: {
  dispose: () => void;
  load: (url: string) => Promise<void>;
  setShading: (mode: Shading) => void;
  setRotating: (on: boolean) => void;
  setGrid: (on: boolean) => void;
  resetView: () => void;
  snapshot: () => string;
  play: (name: string | null) => void;
  setPlaying: (on: boolean) => void;
} | null = null;

async function createViewer(container: HTMLDivElement): Promise<NonNullable<typeof viewer>> {
  const three = await import('three');
  const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
  const { OrbitControls } = await import('three/examples/jsm/controls/OrbitControls.js');
  const { RoomEnvironment } = await import('three/examples/jsm/environments/RoomEnvironment.js');

  const renderer = new three.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = three.SRGBColorSpace;
  renderer.toneMapping = three.ACESFilmicToneMapping;
  container.appendChild(renderer.domElement);
  renderer.domElement.style.display = 'block';

  const scene = new three.Scene();
  scene.background = new three.Color(0x0b0d12);
  // An image-based environment rather than a rig of point lights: it is what
  // gives a PBR material something to reflect, and it is the setup most
  // three.js product pages ship with.
  const pmrem = new three.PMREMGenerator(renderer);
  const environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = environment;

  const key = new three.DirectionalLight(0xffffff, 1.2);
  key.position.set(3, 5, 4);
  scene.add(key, new three.HemisphereLight(0xffffff, 0x222233, 0.4));

  const camera = new three.PerspectiveCamera(35, 1, 0.01, 100);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.autoRotateSpeed = 1.5;
  controls.autoRotate = rotating.value;

  const helper = new three.GridHelper(4, 20, 0x334155, 0x1e293b);
  scene.add(helper);

  const clay = new three.MeshStandardMaterial({ color: 0xb8b2a7, roughness: 0.85, metalness: 0 });
  const normals = new three.MeshNormalMaterial();
  const wire = new three.MeshBasicMaterial({ color: 0x818cf8, wireframe: true });
  const originals = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
  let model: THREE.Object3D | null = null;
  let mixer: THREE.AnimationMixer | null = null;
  let animations: THREE.AnimationClip[] = [];
  let action: THREE.AnimationAction | null = null;
  const clock = new three.Clock();
  let home = { position: new three.Vector3(2, 1.4, 2.6), target: new three.Vector3() };

  function resize(): void {
    const width = container.clientWidth || 1;
    const height = container.clientHeight || 1;
    renderer.setSize(width, height, false);
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }
  const observer = new ResizeObserver(resize);
  observer.observe(container);
  resize();

  let frame = 0;
  function tick(): void {
    frame = requestAnimationFrame(tick);
    const delta = clock.getDelta();
    if (mixer && playing.value) mixer.update(delta);
    controls.update();
    renderer.render(scene, camera);
  }
  tick();

  function apply(mode: Shading): void {
    for (const [mesh, original] of originals) {
      mesh.material = mode === 'clay' ? clay : mode === 'normals' ? normals : mode === 'wireframe' ? wire : original;
    }
  }

  function disposeModel(): void {
    mixer?.stopAllAction();
    mixer = null;
    action = null;
    animations = [];
    if (!model) return;
    scene.remove(model);
    model.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.geometry.dispose();
      const materials = originals.get(mesh) ?? mesh.material;
      for (const material of Array.isArray(materials) ? materials : [materials]) {
        for (const value of Object.values(material)) {
          if (value instanceof three.Texture) value.dispose();
        }
        material.dispose();
      }
    });
    originals.clear();
    model = null;
  }

  function play(name: string | null): void {
    if (!mixer) return;
    const next = animations.find((one) => one.name === name);
    if (!next) return;
    const nextAction = mixer.clipAction(next);
    nextAction.reset().play();
    // A short blend rather than a cut, as a game would switch states.
    if (action && action !== nextAction) action.crossFadeTo(nextAction, 0.25, false);
    action = nextAction;
  }

  return {
    play,
    setPlaying(on: boolean): void {
      if (on) clock.getDelta();
    },
    async load(url: string): Promise<void> {
      const gltf = await new GLTFLoader().loadAsync(url);
      disposeModel();
      model = gltf.scene;

      let vertices = 0;
      let faces = 0;
      let textured = false;
      model.traverse((node) => {
        const mesh = node as THREE.Mesh;
        if (!mesh.isMesh) return;
        // A skinned mesh moves outside the box it was bound in; culling by
        // that box would make a raised arm vanish at the edge of the frame.
        if ((mesh as THREE.SkinnedMesh).isSkinnedMesh) mesh.frustumCulled = false;
        const geometry = mesh.geometry;
        vertices += geometry.attributes['position']?.count ?? 0;
        faces += (geometry.index ? geometry.index.count : (geometry.attributes['position']?.count ?? 0)) / 3;
        // A mesh with neither normals nor UVs -- what a surface-net extraction
        // writes -- shades flat black-ish without normals, so make them.
        if (!geometry.attributes['normal']) geometry.computeVertexNormals();
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const material of materials) {
          if ((material as THREE.MeshStandardMaterial).map) textured = true;
        }
        // A bare mesh arrives with glTF's default material, a flat white that
        // reads as overexposed under the environment. Clay is closer to what
        // an untextured asset means.
        if (!textured && !geometry.attributes['color']) {
          const standard = mesh.material as THREE.MeshStandardMaterial;
          if (standard.isMeshStandardMaterial && !standard.map) {
            standard.color.set(0xb8b2a7);
            standard.roughness = 0.85;
            standard.metalness = 0;
          }
        }
        originals.set(mesh, mesh.material);
      });

      // Frame it: centred on the grid, sitting on it, scaled to a unit-ish
      // size so the camera, grid and orbit limits mean the same for every file.
      const box = new three.Box3().setFromObject(model);
      const size = box.getSize(new three.Vector3());
      const center = box.getCenter(new three.Vector3());
      const longest = Math.max(size.x, size.y, size.z) || 1;
      const scale = 2 / longest;
      model.scale.setScalar(scale);
      model.position.set(-center.x * scale, -box.min.y * scale, -center.z * scale);
      scene.add(model);
      helper.position.y = 0;

      const height = size.y * scale;
      home = {
        target: new three.Vector3(0, height / 2, 0),
        position: new three.Vector3(2.2, height / 2 + 1.1, 2.9),
      };
      camera.position.copy(home.position);
      controls.target.copy(home.target);
      controls.update();

      apply(shading.value);
      animations = gltf.animations;
      mixer = animations.length ? new three.AnimationMixer(model) : null;
      clips.value = animations.map((one) => one.name);
      const first = clips.value.find((name) => /idle/i.test(name)) ?? clips.value[0] ?? null;
      clip.value = first;
      play(first);
      stats.value = { vertices, faces: Math.round(faces), size: [size.x, size.y, size.z], textured };
      emit('stats', stats.value);
    },
    setShading: apply,
    setRotating(on: boolean): void {
      controls.autoRotate = on;
    },
    setGrid(on: boolean): void {
      helper.visible = on;
    },
    resetView(): void {
      camera.position.copy(home.position);
      controls.target.copy(home.target);
      controls.update();
    },
    snapshot(): string {
      renderer.render(scene, camera);
      return renderer.domElement.toDataURL('image/png');
    },
    dispose(): void {
      cancelAnimationFrame(frame);
      observer.disconnect();
      controls.dispose();
      disposeModel();
      clay.dispose();
      normals.dispose();
      wire.dispose();
      environment.dispose();
      pmrem.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}

async function load(url: string): Promise<void> {
  if (!viewer) return;
  status.value = 'loading';
  failure.value = null;
  try {
    await viewer.load(url);
    status.value = 'ready';
  } catch (error) {
    status.value = 'failed';
    failure.value = error instanceof Error ? error.message : String(error);
  }
}

onMounted(async () => {
  if (!host.value) return;
  try {
    viewer = await createViewer(host.value);
  } catch (error) {
    status.value = 'failed';
    failure.value = `WebGL is not available: ${error instanceof Error ? error.message : String(error)}`;
    return;
  }
  await load(props.src);
});

onBeforeUnmount(() => {
  viewer?.dispose();
  viewer = null;
});

watch(
  () => props.src,
  (url) => void load(url),
);
watch(shading, (mode) => viewer?.setShading(mode));
watch(rotating, (on) => viewer?.setRotating(on));
watch(grid, (on) => viewer?.setGrid(on));
watch(clip, (name) => viewer?.play(name));
watch(playing, (on) => viewer?.setPlaying(on));

function resetView(): void {
  viewer?.resetView();
}

function download(): void {
  if (!viewer) return;
  const link = document.createElement('a');
  link.href = viewer.snapshot();
  link.download = 'model.png';
  link.click();
}
</script>

<template>
  <div class="relative flex h-full w-full flex-col overflow-hidden rounded-lg bg-[#0b0d12]">
    <div ref="host" class="min-h-0 flex-1" data-testid="model-viewer" />

    <div
      v-if="status !== 'ready'"
      class="pointer-events-none absolute inset-0 flex items-center justify-center p-4 text-center text-xs"
      :class="status === 'failed' ? 'text-rose-300' : 'text-slate-500'"
    >
      {{ status === 'failed' ? `Could not show this model: ${failure}` : 'Loading model…' }}
    </div>

    <template v-if="!compact">
      <div class="absolute left-2 top-2 flex flex-wrap gap-1">
        <UiButton
          v-for="option in SHADINGS"
          :key="option.value"
          size="sm"
          :active="shading === option.value"
          @click="shading = option.value"
        >
          {{ option.label }}
        </UiButton>
      </div>
      <div class="absolute right-2 top-2 flex flex-wrap gap-1">
        <UiButton size="sm" :active="rotating" @click="rotating = !rotating">Spin</UiButton>
        <UiButton size="sm" :active="grid" @click="grid = !grid">Grid</UiButton>
        <UiButton size="sm" @click="resetView">Reset</UiButton>
        <UiButton size="sm" title="Save what the viewer shows as a PNG" @click="download">PNG</UiButton>
      </div>
      <div v-if="clips.length" class="absolute bottom-2 right-2 flex items-center gap-1" data-testid="clips">
        <select
          v-model="clip"
          class="rounded border border-white/10 bg-black/70 px-2 py-1 text-xs text-slate-200"
          aria-label="Animation clip"
        >
          <option v-for="name in clips" :key="name" :value="name">{{ name }}</option>
        </select>
        <UiButton size="sm" :active="playing" @click="playing = !playing">{{ playing ? 'Pause' : 'Play' }}</UiButton>
      </div>
      <div
        v-if="stats"
        class="absolute bottom-2 left-2 rounded bg-black/60 px-2 py-1 font-mono text-[10px] text-slate-300"
      >
        {{ formatCount(stats.faces) }} faces · {{ formatCount(stats.vertices) }} verts
        <template v-if="bytes"> · {{ formatBytes(bytes) }}</template>
        · {{ stats.textured ? 'textured' : 'untextured' }}
        <template v-if="clips.length"> · {{ clips.length }} clip{{ clips.length === 1 ? '' : 's' }}</template>
      </div>
    </template>
  </div>
</template>
