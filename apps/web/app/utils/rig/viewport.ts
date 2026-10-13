/**
 * The rig editor's 3D view: the mesh, the skeleton drawn over it, and every
 * pointer interaction -- picking, dragging joints, the transform gizmo, the
 * weight brush, posing.
 *
 * A plain class around three.js rather than a Vue component: a scene graph
 * must stay out of Vue's reactivity (a proxy around it makes every frame walk
 * it), and keeping it apart leaves the component to layout and state. The
 * component owns the truth -- bones, history -- and tells the viewport what to
 * show; the viewport reports what the person did through callbacks.
 *
 * Mouse, as in the 3D tools people already know:
 *
 * - Skeleton: click a joint to select it; drag a joint to move it in the view
 *   plane, or drag the gizmo's arrows/rings to constrain to an axis. Drag on
 *   empty space orbits, right-drag pans, wheel zooms.
 * - Weights: drag on the mesh paints the selected bone; Ctrl inverts
 *   (add <-> subtract), Shift smooths. Drag off the mesh -- or Alt+drag
 *   anywhere -- orbits.
 * - Pose: click a joint, turn it with the rotate gizmo; nothing is recorded.
 *
 * three.js is imported when the view is created: the page renders on the
 * server first, and the library would otherwise ship half a megabyte of
 * renderer to every page.
 */

import type * as THREE from 'three';

import type { Vec3 } from '#shared/generate';

import type { InfluenceBuffers } from './draft';
import { INFLUENCES } from './draft';
import { applyDab, SpatialGrid, type PaintContext, type StrokeRecord } from './paint';
import {
  type Bone,
  type End,
  type Handle,
  handlePosition,
  handles as listHandles,
  mirrorIndex,
  mirrorPlane,
  moveJoint,
  reflect,
  rotateSubtree,
  type Skeleton,
} from './skeleton';
import { adjacency, boneColour, type Brush, dominantBone, groupMembers, heat, weightOf, weldGroups } from './weights';

export type EditorMode = 'skeleton' | 'weights' | 'pose';
export type Tool = 'move' | 'rotate';
export type Shading = 'material' | 'clay' | 'xray';
export type WeightView = 'selected' | 'dominant' | 'off';
export type ViewPreset = 'front' | 'back' | 'left' | 'right' | 'top' | 'perspective';
export type PosePreset = 'rest' | 'arms-down' | 'arms-forward' | 'squat' | 'twist';

export interface ViewportCallbacks {
  /** A handle was clicked, or empty space (null). */
  select: (handle: Handle | null) => void;
  /** Bones while a drag is under way; nothing is committed yet. */
  preview: (bones: Bone[]) => void;
  /** A drag finished: what it was, and what it is now. */
  commit: (before: Bone[], after: Bone[], label: string) => void;
  /** A paint stroke finished, with the before-images of what it touched. */
  stroke: (record: StrokeRecord, label: string) => void;
  /** What is under the pointer, for the status bar. */
  hover: (text: string | null) => void;
}

interface Settings {
  mode: EditorMode;
  tool: Tool;
  mirror: boolean;
  withChildren: boolean;
  shading: Shading;
  weightView: WeightView;
  brush: Brush;
  frontOnly: boolean;
  showBones: boolean;
  showMesh: boolean;
  selected: Handle | null;
}

export interface RigViewport {
  load: (meshUrl: string, skeleton: Skeleton, bones: Bone[], weights: InfluenceBuffers) => Promise<void>;
  setBones: (bones: Bone[]) => void;
  set: (patch: Partial<Settings>) => void;
  /** Recolour after weights changed from outside -- an undo, a whole-mesh tool. */
  weightsChanged: () => void;
  frame: (target: 'all' | 'selected') => void;
  view: (preset: ViewPreset) => void;
  pose: (preset: PosePreset) => void;
  /** The mesh's rest positions, for tools that read the surface (centring a joint). */
  positions: () => Float32Array | null;
  /** The brush's paint context, for whole-mesh tools that reuse its adjacency. */
  paintContext: () => PaintContext | null;
  dispose: () => void;
}

const COLOURS = {
  bone: 0x8ea0c4,
  boneSelected: 0xffa94d,
  boneMirror: 0xd8c3a0,
  handle: 0xe2e8f0,
  handleSelected: 0xff8c1a,
  tail: 0x94a3b8,
  background: 0x0b0d12,
} as const;

export async function createRigViewport(container: HTMLElement, callbacks: ViewportCallbacks): Promise<RigViewport> {
  const three = await import('three');
  const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
  const { OrbitControls } = await import('three/examples/jsm/controls/OrbitControls.js');
  const { TransformControls } = await import('three/examples/jsm/controls/TransformControls.js');
  const { RoomEnvironment } = await import('three/examples/jsm/environments/RoomEnvironment.js');

  const settings: Settings = {
    mode: 'skeleton',
    tool: 'move',
    mirror: true,
    withChildren: false,
    shading: 'xray',
    weightView: 'selected',
    brush: { mode: 'add', radius: 0.06, strength: 0.5, value: 0.5, falloff: 1 },
    frontOnly: true,
    showBones: true,
    showMesh: true,
    selected: null,
  };

  // --- Renderer, scene, camera ---------------------------------------------
  const renderer = new three.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = three.SRGBColorSpace;
  renderer.toneMapping = three.ACESFilmicToneMapping;
  renderer.domElement.style.display = 'block';
  renderer.domElement.style.touchAction = 'none';
  container.appendChild(renderer.domElement);

  const scene = new three.Scene();
  scene.background = new three.Color(COLOURS.background);
  const pmrem = new three.PMREMGenerator(renderer);
  const environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = environment;
  const key = new three.DirectionalLight(0xffffff, 1.1);
  key.position.set(2, 4, 5);
  scene.add(key, new three.HemisphereLight(0xffffff, 0x222233, 0.5));

  /** The skeleton, drawn after the mesh and through it. */
  const overlay = new three.Scene();

  const camera = new three.PerspectiveCamera(35, 1, 0.01, 100);
  const orbit = new OrbitControls(camera, renderer.domElement);
  orbit.enableDamping = true;
  orbit.dampingFactor = 0.15;
  orbit.mouseButtons = { LEFT: three.MOUSE.ROTATE, MIDDLE: three.MOUSE.DOLLY, RIGHT: three.MOUSE.PAN };

  const gizmo = new TransformControls(camera, renderer.domElement);
  gizmo.setSpace('world');
  gizmo.setSize(0.8);
  const gizmoHelper = gizmo.getHelper();
  overlay.add(gizmoHelper);
  /** What the gizmo moves: a stand-in at the selected joint, or a bone when posing. */
  const proxy = new three.Object3D();
  overlay.add(proxy);

  const grid = new three.GridHelper(4, 40, 0x334155, 0x1e293b);
  scene.add(grid);

  // --- Mesh state -----------------------------------------------------------
  let skinned: THREE.SkinnedMesh | null = null;
  /** The same geometry, unskinned and never drawn: raycast against the rest pose. */
  let pick: THREE.Mesh | null = null;
  let original: THREE.Material | THREE.Material[] | null = null;
  let threeBones: THREE.Bone[] = [];
  let skeletonModel: Skeleton | null = null;
  let bones: Bone[] = [];
  let weights: InfluenceBuffers | null = null;
  let colours: THREE.BufferAttribute | null = null;
  let context: PaintContext | null = null;
  let height = 2;
  let bounds = new three.Box3();

  const clay = new three.MeshStandardMaterial({ color: 0xb8b2a7, roughness: 0.85, metalness: 0 });
  const xray = new three.MeshStandardMaterial({
    color: 0x9aa4b8,
    roughness: 0.9,
    metalness: 0,
    transparent: true,
    opacity: 0.28,
    depthWrite: false,
  });
  const painted = new three.MeshLambertMaterial({ vertexColors: true });
  const pickMaterial = new three.MeshBasicMaterial({ side: three.DoubleSide });

  // --- Skeleton visuals -----------------------------------------------------
  /** Blender's octahedral bone, along +y from 0 to 1. */
  const boneGeometry = (() => {
    const w = 0.1;
    const points = [
      [0, 0, 0],
      [w, 0.1, w],
      [w, 0.1, -w],
      [-w, 0.1, -w],
      [-w, 0.1, w],
      [0, 1, 0],
    ];
    const faces = [0, 2, 1, 0, 3, 2, 0, 4, 3, 0, 1, 4, 5, 1, 2, 5, 2, 3, 5, 3, 4, 5, 4, 1];
    const geometry = new three.BufferGeometry();
    geometry.setAttribute('position', new three.Float32BufferAttribute(points.flat(), 3));
    geometry.setIndex(faces);
    geometry.computeVertexNormals();
    return geometry;
  })();
  const sphereGeometry = new three.SphereGeometry(1, 16, 12);
  const boneGroup = new three.Group();
  overlay.add(boneGroup);
  let boneMeshes: { solid: THREE.Mesh; edges: THREE.LineSegments }[] = [];
  let handleMeshes: { mesh: THREE.Mesh; handle: Handle }[] = [];

  function overlayMaterial(colour: number, opacity = 1): THREE.MeshBasicMaterial {
    return new three.MeshBasicMaterial({ color: colour, depthTest: false, transparent: true, opacity });
  }

  function clearSkeletonVisuals(): void {
    for (const { solid, edges } of boneMeshes) {
      (solid.material as THREE.Material).dispose();
      (edges.material as THREE.Material).dispose();
      edges.geometry.dispose();
    }
    for (const { mesh } of handleMeshes) (mesh.material as THREE.Material).dispose();
    boneGroup.clear();
    boneMeshes = [];
    handleMeshes = [];
  }

  function buildSkeletonVisuals(): void {
    clearSkeletonVisuals();
    if (!skeletonModel) return;
    const edgesGeometry = new three.EdgesGeometry(boneGeometry);
    boneMeshes = bones.map(() => {
      const solid = new three.Mesh(boneGeometry, overlayMaterial(COLOURS.bone, 0.55));
      const edges = new three.LineSegments(
        edgesGeometry.clone(),
        new three.LineBasicMaterial({ color: 0x0f172a, depthTest: false, transparent: true }),
      );
      solid.renderOrder = 10;
      edges.renderOrder = 11;
      boneGroup.add(solid, edges);
      return { solid, edges };
    });
    edgesGeometry.dispose();
    handleMeshes = listHandles(skeletonModel).map((handle) => {
      const mesh = new three.Mesh(
        sphereGeometry,
        overlayMaterial(handle.end === 'head' ? COLOURS.handle : COLOURS.tail),
      );
      mesh.renderOrder = 12;
      boneGroup.add(mesh);
      return { mesh, handle };
    });
    updateSkeletonVisuals();
  }

  const up = new three.Vector3(0, 1, 0);
  const tmpA = new three.Vector3();
  const tmpB = new three.Vector3();

  /** Where each bone's head and tail are drawn: at rest, or as posed. */
  function drawnEnds(index: number): [THREE.Vector3, THREE.Vector3] {
    const bone = bones[index]!;
    if (settings.mode === 'pose' && threeBones[index]) {
      const posed = threeBones[index];
      const head = posed.getWorldPosition(new three.Vector3());
      const offset = new three.Vector3(...bone.tail).sub(new three.Vector3(...bone.head));
      const tail = offset.applyQuaternion(posed.getWorldQuaternion(new three.Quaternion())).add(head);
      return [head, tail];
    }
    return [new three.Vector3(...bone.head), new three.Vector3(...bone.tail)];
  }

  function updateSkeletonVisuals(): void {
    const selectedBone = settings.selected?.bone ?? -1;
    const mirrored = selectedBone >= 0 && settings.mirror ? mirrorIndex(bones, selectedBone) : -1;
    const handleSize = height * 0.009;
    boneMeshes.forEach(({ solid, edges }, index) => {
      const [head, tail] = drawnEnds(index);
      const direction = tmpA.copy(tail).sub(head);
      const length = Math.max(direction.length(), 1e-6);
      for (const object of [solid, edges]) {
        object.position.copy(head);
        object.quaternion.setFromUnitVectors(up, direction.clone().normalize());
        object.scale.set(length, length, length);
        object.visible = settings.showBones;
      }
      const colour =
        index === selectedBone ? COLOURS.boneSelected : index === mirrored ? COLOURS.boneMirror : COLOURS.bone;
      (solid.material as THREE.MeshBasicMaterial).color.setHex(colour);
    });
    for (const { mesh, handle } of handleMeshes) {
      const [head, tail] = drawnEnds(handle.bone);
      mesh.position.copy(handle.end === 'head' ? head : tail);
      mesh.scale.setScalar(handleSize * (handle.end === 'head' ? 1 : 0.8));
      const selected = settings.selected?.bone === handle.bone && settings.selected.end === handle.end;
      (mesh.material as THREE.MeshBasicMaterial).color.setHex(
        selected ? COLOURS.handleSelected : handle.end === 'head' ? COLOURS.handle : COLOURS.tail,
      );
      mesh.visible = settings.showBones && (settings.mode !== 'pose' || handle.end === 'head');
    }
  }

  // --- Skinning -------------------------------------------------------------
  /** Rest pose from the current bones: positions relative to the parent's head, no rotation. */
  function rebuildThreeSkeleton(): void {
    if (!skinned || !skeletonModel) return;
    threeBones = bones.map((bone) => {
      const object = new three.Bone();
      object.name = bone.name;
      return object;
    });
    bones.forEach((bone, index) => {
      const object = threeBones[index]!;
      const parentHead = bone.parent >= 0 ? bones[bone.parent]!.head : ([0, 0, 0] as Vec3);
      object.position.set(bone.head[0] - parentHead[0], bone.head[1] - parentHead[1], bone.head[2] - parentHead[2]);
      if (bone.parent >= 0) threeBones[bone.parent]!.add(object);
    });
    const roots = threeBones.filter((_, index) => bones[index]!.parent < 0);
    for (const child of [...skinned.children]) skinned.remove(child);
    skinned.add(...roots);
    skinned.updateMatrixWorld(true);
    skinned.bind(new three.Skeleton(threeBones), skinned.matrixWorld);
  }

  // --- Colours for the weight views -------------------------------------------
  function recolour(vertices?: Iterable<number>): void {
    if (!colours || !weights) return;
    const array = colours.array as Float32Array;
    const bone = settings.selected?.bone ?? -1;
    const count = array.length / 3;
    const paint = (v: number): void => {
      let rgb: [number, number, number];
      if (settings.weightView === 'dominant') {
        const owner = dominantBone(weights!, v);
        // Shaded by how much the owner holds: a muddy blend reads darker.
        const shade = 0.4 + 0.6 * weightOf(weights!, v, owner);
        const base = boneColour(owner);
        rgb = [base[0] * shade, base[1] * shade, base[2] * shade];
      } else {
        rgb = bone >= 0 ? heat(weightOf(weights!, v, bone)) : [0.2, 0.22, 0.3];
      }
      array[v * 3] = rgb[0];
      array[v * 3 + 1] = rgb[1];
      array[v * 3 + 2] = rgb[2];
    };
    if (vertices) {
      for (const v of vertices) {
        for (const member of context?.members.get(v) ?? [v]) paint(member);
      }
    } else {
      for (let v = 0; v < count; v++) paint(v);
    }
    colours.needsUpdate = true;
  }

  function applyShading(): void {
    if (!skinned) return;
    const showWeights = settings.weightView !== 'off' && (settings.mode === 'weights' || settings.weightView === 'dominant');
    skinned.material = showWeights
      ? painted
      : settings.shading === 'clay'
        ? clay
        : settings.shading === 'xray'
          ? xray
          : (original ?? clay);
    skinned.visible = settings.showMesh;
  }

  // --- Picking --------------------------------------------------------------
  const raycaster = new three.Raycaster();
  const pointer = new three.Vector2();

  function setPointer(event: PointerEvent): void {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
  }

  /** The joint under the pointer: the nearest handle in screen space, within a few pixels. */
  function pickHandle(event: PointerEvent): Handle | null {
    const rect = renderer.domElement.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    let best: Handle | null = null;
    let bestDistance = 12;
    for (const { mesh, handle } of handleMeshes) {
      if (!mesh.visible) continue;
      const projected = mesh.position.clone().project(camera);
      if (projected.z > 1) continue;
      const sx = ((projected.x + 1) / 2) * rect.width;
      const sy = ((1 - projected.y) / 2) * rect.height;
      const d = Math.hypot(sx - x, sy - y);
      if (d < bestDistance) {
        bestDistance = d;
        best = handle;
      }
    }
    if (best) return best;
    // Then the bone bodies: a click on a bone picks its head.
    const hits = raycaster.intersectObjects(
      boneMeshes.map(({ solid }) => solid).filter((solid) => solid.visible),
      false,
    );
    const hit = hits[0];
    if (!hit) return null;
    const index = boneMeshes.findIndex(({ solid }) => solid === hit.object);
    return index >= 0 ? { bone: index, end: 'head' } : null;
  }

  function pickSurface(): THREE.Intersection | null {
    if (!pick) return null;
    return raycaster.intersectObject(pick, false)[0] ?? null;
  }

  // --- Brush cursor -------------------------------------------------------------
  const cursor = (() => {
    const points: THREE.Vector3[] = [];
    for (let i = 0; i <= 64; i++) {
      const a = (i / 64) * Math.PI * 2;
      points.push(new three.Vector3(Math.cos(a), Math.sin(a), 0));
    }
    const line = new three.Line(
      new three.BufferGeometry().setFromPoints(points),
      new three.LineBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true, opacity: 0.9 }),
    );
    line.renderOrder = 20;
    line.visible = false;
    overlay.add(line);
    return line;
  })();

  function placeCursor(hit: THREE.Intersection | null): void {
    cursor.visible = settings.mode === 'weights' && hit !== null;
    if (!hit) return;
    cursor.position.copy(hit.point);
    const normal = hit.face?.normal ?? new three.Vector3(0, 0, 1);
    cursor.quaternion.setFromUnitVectors(new three.Vector3(0, 0, 1), normal);
    cursor.scale.setScalar(settings.brush.radius);
  }

  // --- Interaction state ------------------------------------------------------
  let drag: { handle: Handle; before: Bone[]; plane: THREE.Plane; offset: THREE.Vector3 } | null = null;
  let gizmoStart: { before: Bone[]; position: THREE.Vector3; quaternion: THREE.Quaternion } | null = null;
  let stroke: { record: StrokeRecord; last: THREE.Vector3 | null; invert: boolean; smooth: boolean } | null = null;
  let downAt: { x: number; y: number } | null = null;

  function attachGizmo(): void {
    gizmo.detach();
    const selected = settings.selected;
    if (!selected || !settings.showBones) return;
    if (settings.mode === 'skeleton') {
      if (settings.tool === 'rotate' && selected.end === 'tail') return;
      proxy.position.set(...handlePosition(bones, selected));
      proxy.quaternion.identity();
      gizmo.setMode(settings.tool === 'rotate' ? 'rotate' : 'translate');
      gizmo.setSpace('world');
      gizmo.attach(proxy);
    } else if (settings.mode === 'pose' && threeBones[selected.bone]) {
      gizmo.setMode('rotate');
      gizmo.setSpace('local');
      gizmo.attach(threeBones[selected.bone]!);
    }
  }

  /** Bones as they would be with `handle` at `to`, mirrored if asked. */
  function moved(before: Bone[], handle: Handle, to: Vec3): Bone[] {
    if (!skeletonModel) return before;
    return moveJoint(skeletonModel, before, handle, to, settings);
  }

  function rotated(before: Bone[], bone: number, q: THREE.Quaternion): Bone[] {
    if (!skeletonModel) return before;
    let out = rotateSubtree(skeletonModel, before, bone, [q.x, q.y, q.z, q.w]);
    if (settings.mirror) {
      const other = mirrorIndex(before, bone);
      if (other >= 0) {
        // The mirror of a rotation across the x = c plane: (x, -y, -z, w).
        out = rotateSubtree(skeletonModel, out, other, [q.x, -q.y, -q.z, q.w]);
      }
    }
    return out;
  }

  gizmo.addEventListener('dragging-changed', (event) => {
    orbit.enabled = !(event as unknown as { value: boolean }).value;
  });
  gizmo.addEventListener('mouseDown', () => {
    gizmoStart = { before: bones, position: proxy.position.clone(), quaternion: proxy.quaternion.clone() };
  });
  gizmo.addEventListener('objectChange', () => {
    if (settings.mode === 'pose') {
      updateSkeletonVisuals();
      return;
    }
    const selected = settings.selected;
    if (!gizmoStart || !selected) return;
    const next =
      settings.tool === 'rotate'
        ? rotated(gizmoStart.before, selected.bone, proxy.quaternion.clone())
        : moved(gizmoStart.before, selected, proxy.position.toArray() as Vec3);
    bones = next;
    updateSkeletonVisuals();
    callbacks.preview(next);
  });
  gizmo.addEventListener('mouseUp', () => {
    if (settings.mode === 'skeleton' && gizmoStart && bones !== gizmoStart.before) {
      callbacks.commit(gizmoStart.before, bones, settings.tool === 'rotate' ? 'Rotate bones' : 'Move joint');
      proxy.quaternion.identity();
    }
    gizmoStart = null;
  });

  function paintAt(hit: THREE.Intersection): void {
    if (!context || !stroke || !settings.selected) return;
    const point = hit.point;
    const spacing = settings.brush.radius * 0.25;
    if (stroke.last && stroke.last.distanceTo(point) < spacing) return;
    stroke.last = point.clone();
    const brush: Brush = {
      ...settings.brush,
      mode: stroke.smooth
        ? 'smooth'
        : stroke.invert
          ? settings.brush.mode === 'add'
            ? 'subtract'
            : settings.brush.mode === 'subtract'
              ? 'add'
              : settings.brush.mode
          : settings.brush.mode,
    };
    const view = settings.frontOnly
      ? (camera.getWorldDirection(new three.Vector3()).toArray() as Vec3)
      : undefined;
    const bone = settings.selected.bone;
    const touched = applyDab(context, { centre: point.toArray() as Vec3, bone, brush, view }, stroke.record);
    if (settings.mirror) {
      const other = mirrorIndex(bones, bone);
      const centre = reflect(point.toArray() as Vec3, mirrorPlane(bones));
      touched.push(...applyDab(context, { centre, bone: other >= 0 ? other : bone, brush, view }, stroke.record));
    }
    if (touched.length && skinned) {
      (skinned.geometry.getAttribute('skinWeight') as THREE.BufferAttribute).needsUpdate = true;
      (skinned.geometry.getAttribute('skinIndex') as THREE.BufferAttribute).needsUpdate = true;
      recolour(touched);
    }
  }

  function onPointerDown(event: PointerEvent): void {
    if (event.button !== 0 || gizmo.dragging || (gizmo.object && gizmo.axis !== null)) return;
    setPointer(event);
    downAt = { x: event.clientX, y: event.clientY };

    if (settings.mode === 'weights') {
      if (event.altKey) return;
      // Bones are drawn over the mesh: a click on one picks it to paint, as in Blender.
      const handle = settings.showBones ? pickHandle(event) : null;
      if (handle) {
        settings.selected = { bone: handle.bone, end: 'head' };
        callbacks.select(settings.selected);
        updateSkeletonVisuals();
        recolour();
        return;
      }
      if (!settings.selected) return;
      const hit = pickSurface();
      if (!hit) return;
      orbit.enabled = false;
      renderer.domElement.setPointerCapture(event.pointerId);
      stroke = { record: new Map(), last: null, invert: event.ctrlKey || event.metaKey, smooth: event.shiftKey };
      paintAt(hit);
      return;
    }

    const handle = pickHandle(event);
    if (!handle) return;
    orbit.enabled = false;
    renderer.domElement.setPointerCapture(event.pointerId);
    if (settings.selected?.bone !== handle.bone || settings.selected.end !== handle.end) {
      settings.selected = handle;
      callbacks.select(handle);
      updateSkeletonVisuals();
      attachGizmo();
    }
    if (settings.mode === 'skeleton') {
      // Grab and drag in the view plane through the joint.
      const at = new three.Vector3(...handlePosition(bones, handle));
      const normal = camera.getWorldDirection(new three.Vector3());
      const plane = new three.Plane().setFromNormalAndCoplanarPoint(normal, at);
      const hit = raycaster.ray.intersectPlane(plane, new three.Vector3());
      drag = { handle, before: bones, plane, offset: hit ? at.clone().sub(hit) : new three.Vector3() };
    }
  }

  function onPointerMove(event: PointerEvent): void {
    setPointer(event);
    if (drag) {
      const hit = raycaster.ray.intersectPlane(drag.plane, new three.Vector3());
      if (!hit) return;
      const to = hit.add(drag.offset).toArray() as Vec3;
      bones = moved(drag.before, drag.handle, to);
      updateSkeletonVisuals();
      if (gizmo.object === proxy) proxy.position.set(...handlePosition(bones, drag.handle));
      callbacks.preview(bones);
      return;
    }
    if (settings.mode === 'weights') {
      const hit = pickSurface();
      placeCursor(hit);
      if (stroke && hit) paintAt(hit);
      if (hit && !stroke && settings.selected && weights) {
        const v = nearestVertex(hit);
        callbacks.hover(
          v >= 0 ? `vertex ${v} · ${bones[settings.selected.bone]!.name.replace('mixamorig:', '')} ${(weightOf(weights, v, settings.selected.bone) * 100).toFixed(0)}%` : null,
        );
      }
      return;
    }
    const handle = pickHandle(event);
    callbacks.hover(handle ? `${bones[handle.bone]!.name.replace('mixamorig:', '')} · ${handle.end}` : null);
    renderer.domElement.style.cursor = handle ? 'grab' : '';
  }

  function onPointerUp(event: PointerEvent): void {
    if (renderer.domElement.hasPointerCapture(event.pointerId)) {
      renderer.domElement.releasePointerCapture(event.pointerId);
    }
    if (drag) {
      if (bones !== drag.before) callbacks.commit(drag.before, bones, 'Move joint');
      drag = null;
    }
    if (stroke) {
      if (stroke.record.size) callbacks.stroke(stroke.record, stroke.smooth ? 'Smooth weights' : 'Paint weights');
      stroke = null;
    }
    orbit.enabled = true;
    // A click on nothing -- not a drag -- clears the selection.
    if (
      event.button === 0 &&
      downAt &&
      Math.hypot(event.clientX - downAt.x, event.clientY - downAt.y) < 4 &&
      settings.mode !== 'weights' &&
      !gizmo.dragging
    ) {
      setPointer(event);
      if (!pickHandle(event) && gizmo.axis === null) {
        settings.selected = null;
        callbacks.select(null);
        updateSkeletonVisuals();
        attachGizmo();
      }
    }
    downAt = null;
  }

  function nearestVertex(hit: THREE.Intersection): number {
    const face = hit.face;
    if (!face || !pick) return -1;
    const position = pick.geometry.getAttribute('position');
    let best = -1;
    let bestDistance = Infinity;
    for (const v of [face.a, face.b, face.c]) {
      tmpB.fromBufferAttribute(position, v);
      const d = tmpB.distanceTo(hit.point);
      if (d < bestDistance) {
        bestDistance = d;
        best = v;
      }
    }
    return best;
  }

  const dom = renderer.domElement;
  // Capture, so a stroke or a joint drag turns orbiting off before the orbit
  // controls -- listening on the same element -- start a rotation.
  dom.addEventListener('pointerdown', onPointerDown, { capture: true });
  dom.addEventListener('pointermove', onPointerMove);
  dom.addEventListener('pointerup', onPointerUp);
  dom.addEventListener('pointerleave', () => {
    cursor.visible = false;
    callbacks.hover(null);
  });
  dom.addEventListener('contextmenu', (event) => event.preventDefault());

  // --- Loop -------------------------------------------------------------------
  function resize(): void {
    const width = container.clientWidth || 1;
    const heightPx = container.clientHeight || 1;
    renderer.setSize(width, heightPx, false);
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    camera.aspect = width / heightPx;
    camera.updateProjectionMatrix();
  }
  const observer = new ResizeObserver(resize);
  observer.observe(container);
  resize();

  let frameId = 0;
  function tick(): void {
    frameId = requestAnimationFrame(tick);
    orbit.update();
    if (settings.mode === 'pose') updateSkeletonVisuals();
    renderer.autoClear = true;
    renderer.render(scene, camera);
    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.render(overlay, camera);
  }
  tick();

  // --- Views ------------------------------------------------------------------
  function frameBox(box: THREE.Box3, direction: THREE.Vector3): void {
    const centre = box.getCenter(new three.Vector3());
    const size = box.getSize(new three.Vector3());
    const radius = Math.max(size.x, size.y, size.z) * 0.6 || 0.1;
    const distance = radius / Math.sin(three.MathUtils.degToRad(camera.fov / 2));
    camera.position.copy(centre).add(direction.clone().normalize().multiplyScalar(distance));
    orbit.target.copy(centre);
    camera.near = distance / 100;
    camera.far = distance * 100;
    camera.updateProjectionMatrix();
    orbit.update();
  }

  function currentDirection(): THREE.Vector3 {
    return camera.position.clone().sub(orbit.target);
  }

  function resetPose(): void {
    for (const bone of threeBones) bone.quaternion.identity();
    skinned?.updateMatrixWorld(true);
  }

  function setMode(mode: EditorMode): void {
    const leavingPose = settings.mode === 'pose' && mode !== 'pose';
    settings.mode = mode;
    if (mode === 'pose') rebuildThreeSkeleton();
    if (leavingPose) resetPose();
    cursor.visible = false;
    renderer.domElement.style.cursor = mode === 'weights' ? 'crosshair' : '';
    orbit.mouseButtons = { LEFT: three.MOUSE.ROTATE, MIDDLE: three.MOUSE.DOLLY, RIGHT: three.MOUSE.PAN };
    applyShading();
    recolour();
    updateSkeletonVisuals();
    attachGizmo();
  }

  return {
    async load(meshUrl, model, startBones, startWeights) {
      const gltf = await new GLTFLoader().loadAsync(meshUrl);
      let source: THREE.Mesh | null = null;
      gltf.scene.traverse((node) => {
        if (!source && (node as THREE.Mesh).isMesh) source = node as THREE.Mesh;
      });
      if (!source) throw new Error('the draft has no mesh');
      const mesh = source as THREE.Mesh;
      const geometry = mesh.geometry.clone();
      const count = geometry.getAttribute('position').count;
      if (count * INFLUENCES !== startWeights.values.length) {
        throw new Error(`the mesh has ${count} vertices and the weights ${startWeights.values.length / INFLUENCES}`);
      }
      if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
      // The weights the brush writes are the buffers the GPU reads.
      geometry.setAttribute('skinIndex', new three.BufferAttribute(startWeights.indices, INFLUENCES));
      geometry.setAttribute('skinWeight', new three.BufferAttribute(startWeights.values, INFLUENCES));
      colours = new three.BufferAttribute(new Float32Array(count * 3), 3);
      geometry.setAttribute('color', colours);

      original = mesh.material;
      skinned = new three.SkinnedMesh(geometry, clay);
      skinned.frustumCulled = false;
      scene.add(skinned);
      pick = new three.Mesh(geometry, pickMaterial);

      skeletonModel = model;
      bones = startBones;
      weights = startWeights;
      rebuildThreeSkeleton();

      const positions = geometry.getAttribute('position').array as Float32Array;
      const normals = geometry.getAttribute('normal').array as Float32Array;
      const group = weldGroups(positions);
      const members = groupMembers(group);
      const index = geometry.index ? (geometry.index.array as ArrayLike<number>) : Array.from({ length: count }, (_, i) => i);
      geometry.computeBoundingBox();
      bounds = geometry.boundingBox!.clone();
      height = bounds.max.y - bounds.min.y || 2;
      context = {
        weights: startWeights,
        positions,
        normals,
        grid: new SpatialGrid(positions, height * 0.02, members.keys()),
        members,
        graph: adjacency(index, group),
        parents: model.bones.map((bone) => bone.parent),
      };
      settings.brush = { ...settings.brush, radius: height * 0.03 };
      grid.position.y = bounds.min.y;

      buildSkeletonVisuals();
      applyShading();
      recolour();
      frameBox(bounds, new three.Vector3(0, 0.15, 1));
    },

    setBones(next) {
      bones = next;
      updateSkeletonVisuals();
      if (settings.selected && gizmo.object === proxy && !gizmo.dragging) {
        proxy.position.set(...handlePosition(bones, settings.selected));
      }
    },

    set(patch) {
      const before = { ...settings };
      Object.assign(settings, patch);
      if (patch.mode !== undefined && patch.mode !== before.mode) {
        settings.mode = before.mode;
        setMode(patch.mode);
      }
      if (patch.shading !== undefined || patch.showMesh !== undefined || patch.weightView !== undefined) applyShading();
      if (patch.weightView !== undefined || (patch.selected !== undefined && settings.mode === 'weights')) recolour();
      if (patch.selected !== undefined || patch.tool !== undefined || patch.showBones !== undefined) {
        updateSkeletonVisuals();
        attachGizmo();
      }
      if (patch.mirror !== undefined) updateSkeletonVisuals();
      if (patch.brush) cursor.scale.setScalar(settings.brush.radius);
    },

    weightsChanged() {
      if (!skinned) return;
      (skinned.geometry.getAttribute('skinWeight') as THREE.BufferAttribute).needsUpdate = true;
      (skinned.geometry.getAttribute('skinIndex') as THREE.BufferAttribute).needsUpdate = true;
      recolour();
    },

    frame(target) {
      if (target === 'selected' && settings.selected) {
        const at = new three.Vector3(...handlePosition(bones, settings.selected));
        const box = new three.Box3().setFromCenterAndSize(at, new three.Vector3(1, 1, 1).multiplyScalar(height * 0.25));
        frameBox(box, currentDirection());
      } else {
        frameBox(bounds, currentDirection());
      }
    },

    view(preset) {
      const directions: Record<ViewPreset, THREE.Vector3> = {
        front: new three.Vector3(0, 0, 1),
        back: new three.Vector3(0, 0, -1),
        // The character's left is +x: its left side is seen from +x.
        left: new three.Vector3(1, 0, 0),
        right: new three.Vector3(-1, 0, 0),
        top: new three.Vector3(0, 1, 0.0001),
        perspective: new three.Vector3(0.8, 0.35, 1),
      };
      frameBox(bounds, directions[preset]);
    },

    pose(preset) {
      if (settings.mode !== 'pose') setMode('pose');
      resetPose();
      const turn = (name: string, axis: [number, number, number], degrees: number): void => {
        const index = bones.findIndex((bone) => bone.name === `mixamorig:${name}`);
        const bone = threeBones[index];
        if (!bone) return;
        bone.quaternion.setFromAxisAngle(new three.Vector3(...axis), three.MathUtils.degToRad(degrees));
      };
      if (preset === 'arms-down') {
        turn('LeftArm', [0, 0, 1], -65);
        turn('RightArm', [0, 0, 1], 65);
      } else if (preset === 'arms-forward') {
        turn('LeftArm', [0, 1, 0], -80);
        turn('RightArm', [0, 1, 0], 80);
        turn('LeftForeArm', [0, 1, 0], -40);
        turn('RightForeArm', [0, 1, 0], 40);
      } else if (preset === 'squat') {
        turn('LeftUpLeg', [1, 0, 0], -80);
        turn('RightUpLeg', [1, 0, 0], -80);
        turn('LeftLeg', [1, 0, 0], 100);
        turn('RightLeg', [1, 0, 0], 100);
        turn('Spine', [1, 0, 0], 20);
      } else if (preset === 'twist') {
        turn('Spine1', [0, 1, 0], 25);
        turn('Spine2', [0, 1, 0], 20);
        turn('Neck', [0, 1, 0], 20);
        turn('LeftForeArm', [1, 0, 0], 60);
        turn('RightForeArm', [1, 0, 0], 60);
      }
      skinned?.updateMatrixWorld(true);
      updateSkeletonVisuals();
    },

    positions() {
      return (pick?.geometry.getAttribute('position').array as Float32Array | undefined) ?? null;
    },

    paintContext() {
      return context;
    },

    dispose() {
      cancelAnimationFrame(frameId);
      observer.disconnect();
      dom.removeEventListener('pointerdown', onPointerDown, { capture: true });
      dom.removeEventListener('pointermove', onPointerMove);
      dom.removeEventListener('pointerup', onPointerUp);
      gizmo.detach();
      gizmo.dispose();
      orbit.dispose();
      clearSkeletonVisuals();
      boneGeometry.dispose();
      sphereGeometry.dispose();
      skinned?.geometry.dispose();
      for (const material of [clay, xray, painted, pickMaterial]) material.dispose();
      const originals = Array.isArray(original) ? original : original ? [original] : [];
      for (const material of originals) {
        for (const value of Object.values(material)) if (value instanceof three.Texture) value.dispose();
        material.dispose();
      }
      environment.dispose();
      pmrem.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}

export type { End, Handle };
