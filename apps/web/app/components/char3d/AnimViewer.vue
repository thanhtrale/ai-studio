<script setup lang="ts">
/**
 * ONE rigged character (its rest-pose GLB) playing ONE Mixamo clip loaded
 * separately (a skeleton-and-clip GLB from `rig/mixamo-lib`). Pure UI: it
 * fetches the two URLs it is given and nothing else.
 *
 * Retargeting is by bone name with a change of rest frame (the rig arm's
 * `cliplib.py`, checked against the clip Blender bound itself):
 *
 *   rotation  q = rest_char · rest_clip⁻¹ · q_clip
 *   Hips      loc = rest_clip⁻¹ · (T − T_rest_clip); in place keeps loc.y and the first frame's x/z;
 *             T_char = T_rest_char + rest_char · loc
 *
 * Position tracks of every other bone are dropped, which keeps the
 * character's own bone lengths.
 *
 * **Arm space** (Mixamo's "Character Arm-Space"; `arm_space` in the rig arm's
 * rig.py) is computed on the CHARACTER's skeleton after retargeting: on each
 * frame the arm direction d is turned towards its rest-pose horizontal by
 * deg·|d·up|. A Python copy of exactly this path matched rig.py's Blender clip
 * to 0.03° (r108 Walk, 30°).
 *
 * **Head clearance.** Arm space does NOT get a hand out of a big chibi head
 * (74 clips: 13.6% of frames at 0°, 14.8% at 60°) -- the forearm folds the
 * hand up to the face, and chibi heads and hair are big. On each frame a hand
 * point (the Hand joint, the fingertip, mid-forearm) is "in the head" when it
 * is closer than `HEAD_MARGIN`·H to the real head surface (a hash grid over the
 * Head bone's vertices) OR inside the ellipsoid core at 0.8 of its radii (the
 * bounding ellipsoid alone misses the cheeks and chin -- a wave in front of the
 * cheek read as outside, r108 Wave). Then the arm turns about the shoulder,
 * AWAY from the head's centre, by the smallest angle that clears it (2° steps,
 * at most 70°), smoothed over time (max over ±3 frames, then a Gaussian of σ 2)
 * so it does not jitter.
 *
 * **Body clearance** (= `TorsoClearance` in rig.py, same constants). A fixed
 * arm-space angle cannot undo hands on hips, arms round the back or body turns
 * on a big chibi torso (r44 → r45: 74 → 58 of 240 frames). The torso is a
 * RADIUS profile about the spine Hips → Neck (extended `TORSO_EXT`·H below
 * Hips): slices u × angle sectors θ in the segment's bone frame, R = the
 * largest rest-pose radius of a torso vertex. A hand point (24 hand vertices,
 * the Hand joint, mid-forearm) is inside when r < R + `TORSO_CLEAR`·H; then
 * the arm is RAISED about the shoulder along the torso's sideways direction on
 * that shoulder's side -- not along the hand, which twisted the arm a full
 * turn in Walk -- by the smallest angle, angle and axis smoothed over time.
 * It runs before head clearance. On r44 (rig.py): 74 → 0 of 240 frames, stretch
 * unchanged.
 *
 * three.js is imported inside `onMounted`, as `ModelViewer.vue` does: the page
 * renders on the server first, where there is no WebGL.
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';

import UiButton from '../ui/Button.vue';

const props = defineProps<{ modelUrl?: string; clipUrl?: string; height?: string }>();

const host = ref<HTMLDivElement | null>(null);
const status = ref('');
const error = ref('');
const playing = ref(true);
const inPlace = ref(true);
/** How far the arms are pushed away from the body, in degrees. 30 is the rig step's default. */
const armSpace = ref(30);
/** Turn an arm out of the head when the hand goes into it (see the top of the file). */
const headClear = ref(true);
const HEAD_MARGIN = 0.025;
/** The largest angle each arm was turned by in this clip -- shown beside Head clearance. */
const clearInfo = ref('');
/** Turn an arm out of the torso when the hand sinks into it (see the top of the file). */
const bodyClear = ref(true);
const bodyInfo = ref('');
const TORSO_BONES = ['Hips', 'Spine', 'Spine1', 'Spine2'];
const TORSO_CLEAR = 0.006;
const TORSO_U_BINS = 6;
const TORSO_A_BINS = 24;
const TORSO_EXT = 0.2;
const TORSO_MAX_DEG = 70;
const skeleton = ref(false);
const speed = ref(1);
const time = ref(0);
const duration = ref(0);
const fps = 30;

let T: any = null;
let renderer: any,
  scene: any,
  camera: any,
  controls: any,
  clock: any,
  raf = 0,
  ro: ResizeObserver | null = null;
let charRoot: any = null,
  mixer: any = null,
  action: any = null,
  skelHelper: any = null;
let dstRest = new Map<string, { q: any; p: any }>();
let clipSrc: { clip: any; rest: Map<string, { q: any; p: any }> } | null = null;
let token = 0;
/** The head ellipsoid in the Head bone's local frame (at rest), and the fingertip in each Hand bone's. */
let headShape: {
  bone: any;
  c: any;
  r: any;
  H: number;
  cell: number;
  grid: Map<string, number[]>;
  pts: Float32Array;
} | null = null;
const tipLocal = new Map<string, any>();
/** The torso profile (R[u·A + θ]) and 24 hand vertices per side in the Hand bone's local frame. */
let torsoShape: { R: Float32Array; rows: number; H: number; hands: Map<string, any[]> } | null = null;

async function three(): Promise<any> {
  if (T) return T;
  const [core, gltf, orbit, room] = await Promise.all([
    import('three'),
    import('three/examples/jsm/loaders/GLTFLoader.js'),
    import('three/examples/jsm/controls/OrbitControls.js'),
    import('three/examples/jsm/environments/RoomEnvironment.js'),
  ]);
  T = {
    ...core,
    GLTFLoader: gltf.GLTFLoader,
    OrbitControls: orbit.OrbitControls,
    RoomEnvironment: room.RoomEnvironment,
  };
  return T;
}

function restOf(root: any): Map<string, { q: any; p: any }> {
  const m = new Map<string, { q: any; p: any }>();
  root.traverse((o: any) => m.set(o.name, { q: o.quaternion.clone(), p: o.position.clone() }));
  return m;
}

function retarget(): any {
  if (!clipSrc) return null;
  const { clip, rest } = clipSrc;
  const tracks: any[] = [];
  for (const tr of clip.tracks) {
    const dot = tr.name.lastIndexOf('.');
    const node = tr.name.slice(0, dot);
    const prop = tr.name.slice(dot + 1);
    const d = dstRest.get(node);
    const s = rest.get(node);
    if (!d || !s || !/^mixamorig/.test(node)) continue;
    const n = tr.times.length;
    if (prop === 'quaternion') {
      const k = d.q.clone().multiply(s.q.clone().invert());
      const v = new Float32Array(n * 4);
      const q = new T.Quaternion();
      for (let i = 0; i < n; i++) {
        q.fromArray(tr.values, i * 4).premultiply(k);
        q.toArray(v, i * 4);
      }
      tracks.push(new T.QuaternionKeyframeTrack(tr.name, tr.times, v));
    } else if (prop === 'position' && /Hips$/.test(node)) {
      const sInv = s.q.clone().invert();
      const v = new Float32Array(n * 3);
      const loc = new T.Vector3();
      let x0 = 0,
        z0 = 0;
      for (let i = 0; i < n; i++) {
        loc
          .fromArray(tr.values, i * 3)
          .sub(s.p)
          .applyQuaternion(sInv);
        if (i === 0) {
          x0 = loc.x;
          z0 = loc.z;
        }
        if (inPlace.value) {
          loc.x = x0;
          loc.z = z0;
        }
        loc.applyQuaternion(d.q).add(d.p);
        loc.toArray(v, i * 3);
      }
      tracks.push(new T.VectorKeyframeTrack(tr.name, tr.times, v));
    }
  }
  return new T.AnimationClip(clip.name, clip.duration, tracks);
}

/** Arm space on the character's skeleton. Rewrites only the LeftArm/RightArm rotation tracks. */
function withArmSpace(clip: any, deg: number): any {
  if (!deg || !charRoot) return clip;
  const up = new T.Vector3(0, 1, 0);
  const wp = (o: any) => o.getWorldPosition(new T.Vector3());
  resetPose();
  charRoot.updateMatrixWorld(true);
  const sides: { arm: any; fore: any; tr: any; lat: any; out: Float32Array }[] = [];
  for (const side of ['Left', 'Right']) {
    const arm = charRoot.getObjectByName(`mixamorig${side}Arm`);
    const fore = charRoot.getObjectByName(`mixamorig${side}ForeArm`);
    const tr = clip.tracks.find((t: any) => t.name === `mixamorig${side}Arm.quaternion`);
    if (!arm || !fore || !tr) continue;
    const lat = wp(fore).sub(wp(arm));
    lat.addScaledVector(up, -lat.dot(up)).normalize();
    sides.push({ arm, fore, tr, lat, out: new Float32Array(tr.values) });
  }
  if (!sides.length) return clip;
  const m = new T.AnimationMixer(charRoot);
  const act = m.clipAction(clip);
  act.play();
  const rad = (deg * Math.PI) / 180;
  const R = new T.Quaternion();
  for (const s of sides) {
    // The two arms are independent (one does not move the other), so each side gets a pass at its own key times.
    for (let i = 0; i < s.tr.times.length; i++) {
      act.time = s.tr.times[i];
      m.update(0);
      charRoot.updateMatrixWorld(true);
      const d = wp(s.fore).sub(wp(s.arm)).normalize();
      const axis = new T.Vector3().crossVectors(d, s.lat);
      const a = rad * Math.abs(d.dot(up));
      if (axis.length() < 1e-4 || a < 1e-5) continue;
      R.setFromAxisAngle(axis.normalize(), a);
      const wq = s.arm.getWorldQuaternion(new T.Quaternion());
      const pq = s.arm.parent.getWorldQuaternion(new T.Quaternion()).invert();
      pq.multiply(R.clone().multiply(wq)).toArray(s.out, i * 4);
    }
  }
  m.stopAllAction();
  m.uncacheRoot(charRoot);
  resetPose();
  const tracks = clip.tracks.map((t: any) => {
    const s = sides.find((x) => x.tr === t);
    return s ? new T.QuaternionKeyframeTrack(t.name, t.times, s.out) : t;
  });
  return new T.AnimationClip(clip.name, clip.duration, tracks);
}

/** The head ellipsoid and the fingertips from the rest-pose mesh (vertices whose heaviest bone is Head / Hand). */
function measureBody(): void {
  headShape = null;
  torsoShape = null;
  tipLocal.clear();
  if (!charRoot) return;
  resetPose();
  charRoot.updateMatrixWorld(true);
  const box = new T.Box3().setFromObject(charRoot);
  const H = box.max.y - box.min.y;
  let mesh: any = null;
  charRoot.traverse((o: any) => {
    if (o.isSkinnedMesh && (!mesh || o.geometry.attributes.position.count > mesh.geometry.attributes.position.count))
      mesh = o;
  });
  if (!mesh) return;
  const bones: any[] = mesh.skeleton.bones;
  const want = new Map<number, string>();
  bones.forEach((b, i) => {
    if (/Head$/.test(b.name)) want.set(i, 'Head');
    const m = /(Left|Right)Hand$/.exec(b.name);
    if (m) want.set(i, m[1] + 'Hand');
    if (TORSO_BONES.some((t) => b.name === `mixamorig${t}`)) want.set(i, 'Torso');
  });
  const si = mesh.geometry.attributes.skinIndex;
  const sw = mesh.geometry.attributes.skinWeight;
  const n = mesh.geometry.attributes.position.count;
  const pts: Record<string, any[]> = {};
  const v = new T.Vector3();
  for (let i = 0; i < n; i++) {
    let best = -1;
    let bw = 0;
    for (let k = 0; k < 4; k++) {
      const w = sw.getComponent(i, k);
      if (w > bw) {
        bw = w;
        best = si.getComponent(i, k);
      }
    }
    const tag = want.get(best);
    if (!tag || ((tag === 'Head' || tag === 'Torso') && i % 5)) continue;
    mesh.getVertexPosition(i, v);
    const list = (pts[tag] ||= []);
    list.push(v.clone().applyMatrix4(mesh.matrixWorld));
  }
  const headBone = bones.find((b) => /Head$/.test(b.name));
  if (headBone && pts.Head?.length) {
    const inv = headBone.matrixWorld.clone().invert();
    const lb = new T.Box3();
    const cell = (HEAD_MARGIN * H) / headBone.getWorldScale(new T.Vector3()).x;
    const flat = new Float32Array(pts.Head.length * 3);
    const grid = new Map<string, number[]>();
    pts.Head.forEach((p, i) => {
      const l = p.clone().applyMatrix4(inv);
      lb.expandByPoint(l);
      l.toArray(flat, i * 3);
      const k = `${Math.floor(l.x / cell)},${Math.floor(l.y / cell)},${Math.floor(l.z / cell)}`;
      const b = grid.get(k);
      if (b) b.push(i);
      else grid.set(k, [i]);
    });
    headShape = {
      bone: headBone,
      c: lb.getCenter(new T.Vector3()),
      r: lb.getSize(new T.Vector3()).multiplyScalar(0.5),
      H,
      cell,
      grid,
      pts: flat,
    };
  }
  for (const side of ['Left', 'Right']) {
    const hb = bones.find((b) => b.name === `mixamorig${side}Hand`);
    const ps = pts[side + 'Hand'];
    if (!hb || !ps?.length) continue;
    const hp = hb.getWorldPosition(new T.Vector3());
    let far = ps[0];
    for (const p of ps) if (p.distanceToSquared(hp) > far.distanceToSquared(hp)) far = p;
    tipLocal.set(side, far.clone().applyMatrix4(hb.matrixWorld.clone().invert()));
  }
  const chain = torsoChain();
  if (chain && pts.Torso?.length) {
    const rows = chain.pts.length * TORSO_U_BINS;
    const R = new Float32Array(rows * TORSO_A_BINS);
    for (const p of pts.Torso) {
      const c = torsoCoords(p, chain, H);
      if (!c) continue;
      const k = torsoBin(c, rows);
      R[k] = Math.max(R[k]!, c[2]);
    }
    const hands = new Map<string, any[]>();
    for (const side of ['Left', 'Right']) {
      const hb = bones.find((b) => b.name === `mixamorig${side}Hand`);
      const ps = pts[side + 'Hand'];
      if (!hb || !ps?.length) continue;
      const inv = hb.matrixWorld.clone().invert();
      // 24 vertices spread evenly by index -- enough to cover a fist (rig.py samples at random with seed 0; they need not match vertex for vertex).
      const step = Math.max(1, Math.floor(ps.length / 24));
      hands.set(
        side,
        ps
          .filter((_, i) => i % step === 0)
          .slice(0, 24)
          .map((p) => p.clone().applyMatrix4(inv)),
      );
    }
    torsoShape = { R, rows, H, hands };
  }
}

/** The current spine (heads of Hips, Spine, Spine1, Spine2, Neck) and the world X/Z axes of the four torso bones. */
function torsoChain(): { pts: any[]; ax: { x: any; z: any }[] } | null {
  if (!charRoot) return null;
  const pts: any[] = [];
  const ax: { x: any; z: any }[] = [];
  for (const n of [...TORSO_BONES, 'Neck']) {
    const b = charRoot.getObjectByName(`mixamorig${n}`);
    if (!b) return null;
    pts.push(b.getWorldPosition(new T.Vector3()));
    if (n !== 'Neck')
      ax.push({
        x: new T.Vector3().setFromMatrixColumn(b.matrixWorld, 0).normalize(),
        z: new T.Vector3().setFromMatrixColumn(b.matrixWorld, 2).normalize(),
      });
  }
  return { pts, ax };
}

/** (u, θ, r) of a point p about the spine -- as `TorsoProfile._coords` in rig.py. */
function torsoCoords(
  p: any,
  chain: { pts: any[]; ax: { x: any; z: any }[] },
  H: number,
): [number, number, number] | null {
  const d0 = chain.pts[1].clone().sub(chain.pts[0]).normalize();
  const pts = [chain.pts[0].clone().addScaledVector(d0, -TORSO_EXT * H), ...chain.pts];
  const ax = [chain.ax[0]!, ...chain.ax];
  let best: { dist: number; k: number; t: number; q: any; d: any } | null = null;
  for (let k = 0; k < pts.length - 1; k++) {
    const ab = pts[k + 1].clone().sub(pts[k]);
    const L2 = ab.lengthSq();
    if (L2 < 1e-12) continue;
    const t = Math.max(0, Math.min(1, p.clone().sub(pts[k]).dot(ab) / L2));
    const q = pts[k].clone().addScaledVector(ab, t);
    const dist = p.distanceTo(q);
    if (!best || dist < best.dist) best = { dist, k, t, q, d: ab.normalize() };
  }
  if (!best) return null;
  const { k, t, q, d } = best;
  let e1 = ax[k]!.x.clone().addScaledVector(d, -ax[k]!.x.dot(d));
  if (e1.length() < 1e-6) e1 = ax[k]!.z.clone().addScaledVector(d, -ax[k]!.z.dot(d));
  e1.normalize();
  const e2 = new T.Vector3().crossVectors(d, e1);
  const w = p.clone().sub(q);
  let ang = Math.atan2(w.dot(e2), w.dot(e1));
  if (ang < 0) ang += 2 * Math.PI;
  return [k + t, ang, best.dist];
}

function torsoBin(c: [number, number, number], rows: number): number {
  const ui = Math.min(Math.floor(c[0] * TORSO_U_BINS), rows - 1);
  const ai = Math.floor((c[1] / (2 * Math.PI)) * TORSO_A_BINS) % TORSO_A_BINS;
  return ui * TORSO_A_BINS + ai;
}

/** Max over ±3 frames, then a Gaussian of σ 2 frames: the needed angle, smoothed over time. */
function smoothNeed(need: Float32Array): Float32Array {
  const N = need.length;
  const mx = new Float32Array(N);
  for (let i = 0; i < N; i++)
    for (let k = Math.max(0, i - 3); k <= Math.min(N - 1, i + 3); k++) mx[i] = Math.max(mx[i]!, need[k]!);
  const sm = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    let a = 0;
    let w = 0;
    for (let k = Math.max(0, i - 6); k <= Math.min(N - 1, i + 6); k++) {
      const g = Math.exp(-((k - i) ** 2) / 8);
      a += g * mx[k]!;
      w += g;
    }
    sm[i] = a / w;
  }
  return sm;
}

/** Body clearance (see the top of the file). Rewrites only the LeftArm/RightArm rotation tracks. */
function withTorsoClearance(clip: any): any {
  bodyInfo.value = '';
  if (!torsoShape || !charRoot) return clip;
  const ts = torsoShape;
  const info: string[] = [];
  const m = new T.AnimationMixer(charRoot);
  const act = m.clipAction(clip);
  act.play();
  const wp = (o: any) => o.getWorldPosition(new T.Vector3());
  const inside = (p: any, chain: any) => {
    const c = torsoCoords(p, chain, ts.H);
    if (!c) return false;
    const R = ts.R[torsoBin(c, ts.rows)]!;
    return R > 0 && c[2] < R + TORSO_CLEAR * ts.H;
  };
  const axisPoint = (p: any, chain: any) => {
    let best = Infinity;
    let out = chain.pts[0];
    for (let k = 0; k < chain.pts.length - 1; k++) {
      const a = chain.pts[k];
      const ab = chain.pts[k + 1].clone().sub(a);
      const t = Math.max(0, Math.min(1, p.clone().sub(a).dot(ab) / Math.max(ab.lengthSq(), 1e-12)));
      const q = a.clone().addScaledVector(ab, t);
      if (p.distanceTo(q) < best) {
        best = p.distanceTo(q);
        out = q;
      }
    }
    return out;
  };
  const out = new Map<any, Float32Array>();
  const R = new T.Quaternion();
  for (const side of ['Left', 'Right']) {
    const arm = charRoot.getObjectByName(`mixamorig${side}Arm`);
    const fore = charRoot.getObjectByName(`mixamorig${side}ForeArm`);
    const hand = charRoot.getObjectByName(`mixamorig${side}Hand`);
    const tr = clip.tracks.find((t: any) => t.name === `mixamorig${side}Arm.quaternion`);
    const local = ts.hands.get(side) ?? [];
    if (!arm || !fore || !hand || !tr) continue;
    const N = tr.times.length;
    const need = new Float32Array(N);
    const axes: any[] = [];
    const worldQ: any[] = [];
    const parentQ: any[] = [];
    for (let i = 0; i < N; i++) {
      act.time = tr.times[i];
      m.update(0);
      charRoot.updateMatrixWorld(true);
      const chain = torsoChain();
      const sh = wp(arm);
      const hp = wp(hand);
      const pts = [
        hp,
        wp(fore).add(hp).multiplyScalar(0.5),
        ...local.map((l) => l.clone().applyMatrix4(hand.matrixWorld)),
      ];
      // The push is along the torso's SIDEWAYS direction on this shoulder's side (raising the arm, as rig.py) -- not
      // along the hand: that turns as the hand goes from the hip round the back, and the arm sweeps a full twist (Walk r46).
      let axis = new T.Vector3();
      if (chain) {
        const spine = chain.pts[3].clone().sub(chain.pts[2]);
        const lat = sh.clone().sub(axisPoint(sh, chain));
        lat.addScaledVector(spine, -lat.dot(spine) / Math.max(spine.lengthSq(), 1e-12));
        axis = new T.Vector3().crossVectors(hp.clone().sub(sh), lat);
      }
      axes.push(axis.lengthSq() > 1e-12 ? axis.normalize() : null);
      worldQ.push(arm.getWorldQuaternion(new T.Quaternion()));
      parentQ.push(arm.parent.getWorldQuaternion(new T.Quaternion()));
      if (!chain || !axes[i] || !pts.some((p) => inside(p, chain))) continue;
      need[i] = TORSO_MAX_DEG;
      for (let d = 2; d <= TORSO_MAX_DEG; d += 2) {
        R.setFromAxisAngle(axes[i], (d * Math.PI) / 180);
        if (!pts.some((p) => inside(p.clone().sub(sh).applyQuaternion(R).add(sh), chain))) {
          need[i] = d;
          break;
        }
      }
    }
    const sm = smoothNeed(need);
    if (!sm.some((x) => x > 0.5)) continue;
    let peak = 0;
    let moved = 0;
    for (const x of sm) {
      peak = Math.max(peak, x);
      if (x >= 0.5) moved++;
    }
    info.push(`${side[0]} ≤${Math.round(peak)}° on ${Math.round((moved / N) * 100)}%`);
    // The axis is smoothed over time too (Gaussian σ 2, weighted by the needed angle) -- as rig.py's `smooth_axes`.
    const sax: any[] = [];
    for (let i = 0; i < N; i++) {
      const acc = new T.Vector3();
      for (let k = Math.max(0, i - 6); k <= Math.min(N - 1, i + 6); k++)
        if (axes[k]) acc.addScaledVector(axes[k], Math.exp(-((k - i) ** 2) / 8) * Math.max(need[k]!, 1));
      sax.push(acc.lengthSq() > 1e-18 ? acc.normalize() : null);
    }
    const vals = new Float32Array(tr.values);
    for (let i = 0; i < N; i++) {
      if (sm[i]! < 0.5 || !sax[i]) continue;
      R.setFromAxisAngle(sax[i], (sm[i]! * Math.PI) / 180);
      parentQ[i]
        .clone()
        .invert()
        .multiply(R.clone().multiply(worldQ[i]))
        .toArray(vals, i * 4);
    }
    out.set(tr, vals);
  }
  m.stopAllAction();
  m.uncacheRoot(charRoot);
  resetPose();
  bodyInfo.value = info.join(' · ');
  if (!out.size) return clip;
  const tracks = clip.tracks.map((t: any) =>
    out.has(t) ? new T.QuaternionKeyframeTrack(t.name, t.times, out.get(t)) : t,
  );
  return new T.AnimationClip(clip.name, clip.duration, tracks);
}

/** Head clearance (see the top of the file). Rewrites only the LeftArm/RightArm rotation tracks. */
function withHeadClearance(clip: any): any {
  clearInfo.value = '';
  if (!headShape || !charRoot) return clip;
  const hs = headShape;
  const info: string[] = [];
  const m = new T.AnimationMixer(charRoot);
  const act = m.clipAction(clip);
  act.play();
  const wp = (o: any) => o.getWorldPosition(new T.Vector3());
  const core = hs.r.clone().multiplyScalar(0.8);
  const c2 = hs.cell * hs.cell;
  const near = (l: any) => {
    const ix = Math.floor(l.x / hs.cell);
    const iy = Math.floor(l.y / hs.cell);
    const iz = Math.floor(l.z / hs.cell);
    for (let a = -1; a <= 1; a++)
      for (let b = -1; b <= 1; b++)
        for (let c = -1; c <= 1; c++) {
          const ids = hs.grid.get(`${ix + a},${iy + b},${iz + c}`);
          if (!ids) continue;
          for (const j of ids) {
            const dx = hs.pts[j * 3]! - l.x;
            const dy = hs.pts[j * 3 + 1]! - l.y;
            const dz = hs.pts[j * 3 + 2]! - l.z;
            if (dx * dx + dy * dy + dz * dz < c2) return true;
          }
        }
    return false;
  };
  const inside = (pts: any[], inv: any) =>
    pts.some((p) => {
      const l = p.clone().applyMatrix4(inv);
      const e = l.clone().sub(hs.c);
      return (e.x / core.x) ** 2 + (e.y / core.y) ** 2 + (e.z / core.z) ** 2 < 1 || near(l);
    });
  const out = new Map<any, Float32Array>();
  const R = new T.Quaternion();
  for (const side of ['Left', 'Right']) {
    const arm = charRoot.getObjectByName(`mixamorig${side}Arm`);
    const fore = charRoot.getObjectByName(`mixamorig${side}ForeArm`);
    const hand = charRoot.getObjectByName(`mixamorig${side}Hand`);
    const tr = clip.tracks.find((t: any) => t.name === `mixamorig${side}Arm.quaternion`);
    const tip = tipLocal.get(side);
    if (!arm || !fore || !hand || !tr) continue;
    const N = tr.times.length;
    const need = new Float32Array(N);
    const axes: any[] = [];
    const worldQ: any[] = [];
    const parentQ: any[] = [];
    for (let i = 0; i < N; i++) {
      act.time = tr.times[i];
      m.update(0);
      charRoot.updateMatrixWorld(true);
      const sh = wp(arm);
      const hp = wp(hand);
      const pts = [hp, wp(fore).add(hp).multiplyScalar(0.5)];
      if (tip) pts.push(tip.clone().applyMatrix4(hand.matrixWorld));
      const inv = hs.bone.matrixWorld.clone().invert();
      const cen = hs.c.clone().applyMatrix4(hs.bone.matrixWorld);
      const axis = new T.Vector3().crossVectors(hp.clone().sub(sh), cen.sub(sh));
      axes.push(axis.lengthSq() > 1e-12 ? axis.normalize() : null);
      worldQ.push(arm.getWorldQuaternion(new T.Quaternion()));
      parentQ.push(arm.parent.getWorldQuaternion(new T.Quaternion()));
      if (!axes[i] || !inside(pts, inv)) continue;
      need[i] = 70;
      for (let d = 2; d <= 70; d += 2) {
        R.setFromAxisAngle(axes[i], (-d * Math.PI) / 180);
        if (
          !inside(
            pts.map((p) => p.clone().sub(sh).applyQuaternion(R).add(sh)),
            inv,
          )
        ) {
          need[i] = d;
          break;
        }
      }
    }
    // smoothing: max over ±3 frames, then a Gaussian of σ 2 frames
    const mx = new Float32Array(N);
    for (let i = 0; i < N; i++)
      for (let k = Math.max(0, i - 3); k <= Math.min(N - 1, i + 3); k++) mx[i] = Math.max(mx[i]!, need[k]!);
    const sm = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      let a = 0;
      let w = 0;
      for (let k = Math.max(0, i - 6); k <= Math.min(N - 1, i + 6); k++) {
        const g = Math.exp(-((k - i) ** 2) / 8);
        a += g * mx[k]!;
        w += g;
      }
      sm[i] = a / w;
    }
    if (!sm.some((x) => x > 0.5)) continue;
    let peak = 0;
    let moved = 0;
    for (const x of sm) {
      peak = Math.max(peak, x);
      if (x >= 0.5) moved++;
    }
    info.push(`${side[0]} ≤${Math.round(peak)}° on ${Math.round((moved / N) * 100)}%`);
    const vals = new Float32Array(tr.values);
    let lastAxis: any = null;
    for (let i = 0; i < N; i++) {
      lastAxis = axes[i] ?? lastAxis;
      if (sm[i]! < 0.5 || !lastAxis) continue;
      R.setFromAxisAngle(lastAxis, (-sm[i]! * Math.PI) / 180);
      parentQ[i]
        .clone()
        .invert()
        .multiply(R.clone().multiply(worldQ[i]))
        .toArray(vals, i * 4);
    }
    out.set(tr, vals);
  }
  m.stopAllAction();
  m.uncacheRoot(charRoot);
  resetPose();
  clearInfo.value = info.join(' · ');
  if (!out.size) return clip;
  const tracks = clip.tracks.map((t: any) =>
    out.has(t) ? new T.QuaternionKeyframeTrack(t.name, t.times, out.get(t)) : t,
  );
  return new T.AnimationClip(clip.name, clip.duration, tracks);
}

function resetPose(): void {
  if (!charRoot) return;
  charRoot.traverse((o: any) => {
    const r = dstRest.get(o.name);
    if (r) {
      o.quaternion.copy(r.q);
      o.position.copy(r.p);
    }
  });
}

function applyClip(): void {
  if (mixer) {
    mixer.stopAllAction();
    if (action) mixer.uncacheClip(action.getClip());
  }
  action = null;
  resetPose();
  duration.value = 0;
  time.value = 0;
  if (!charRoot || !clipSrc) return;
  const raw = retarget();
  if (!raw) return;
  const spaced = withArmSpace(raw, armSpace.value);
  const cleared = bodyClear.value ? withTorsoClearance(spaced) : spaced;
  const clip = headClear.value ? withHeadClearance(cleared) : cleared;
  mixer ||= new T.AnimationMixer(charRoot);
  mixer.timeScale = speed.value;
  action = mixer.clipAction(clip);
  action.play();
  action.paused = !playing.value;
  duration.value = clip.duration;
}

function frame(): void {
  if (!charRoot) return;
  const box = new T.Box3().setFromObject(charRoot);
  const c = box.getCenter(new T.Vector3());
  const s = box.getSize(new T.Vector3());
  controls.target.copy(c);
  camera.position.set(c.x + s.y * 0.55, c.y + s.y * 0.15, c.z + s.y * 1.7);
  camera.near = s.y / 100;
  camera.far = s.y * 100;
  camera.updateProjectionMatrix();
  controls.update();
}

async function loadModel(): Promise<void> {
  const my = ++token;
  error.value = '';
  if (charRoot) {
    scene.remove(charRoot);
    if (skelHelper) scene.remove(skelHelper);
    charRoot.traverse((o: any) => {
      o.geometry?.dispose?.();
      for (const m of [o.material].flat())
        if (m) {
          for (const k in m) m[k]?.isTexture && m[k].dispose();
          m.dispose?.();
        }
    });
    charRoot = null;
    mixer = null;
    action = null;
  }
  if (!props.modelUrl) return;
  status.value = 'Loading character…';
  try {
    const g = await new T.GLTFLoader().loadAsync(props.modelUrl);
    if (my !== token) return;
    charRoot = g.scene;
    // Standing on the grid: the bounding box's bottom at y = 0.
    const box = new T.Box3().setFromObject(charRoot);
    charRoot.position.y -= box.min.y;
    dstRest = restOf(charRoot);
    scene.add(charRoot);
    measureBody();
    skelHelper = new T.SkeletonHelper(charRoot);
    skelHelper.visible = skeleton.value;
    scene.add(skelHelper);
    frame();
    applyClip();
  } catch (e: any) {
    error.value = `Model: ${e?.message ?? e}`;
  } finally {
    if (my === token) status.value = '';
  }
}

async function loadClip(): Promise<void> {
  clipSrc = null;
  if (!props.clipUrl) {
    applyClip();
    return;
  }
  const url = props.clipUrl;
  status.value = 'Loading clip…';
  try {
    const g = await new T.GLTFLoader().loadAsync(url);
    if (url !== props.clipUrl) return;
    if (!g.animations.length) throw new Error('clip file has no animation');
    clipSrc = { clip: g.animations[0], rest: restOf(g.scene) };
    applyClip();
  } catch (e: any) {
    error.value = `Clip: ${e?.message ?? e}`;
  } finally {
    status.value = '';
  }
}

function loop(): void {
  raf = requestAnimationFrame(loop);
  const dt = clock.getDelta();
  if (mixer && action && !action.paused) {
    mixer.update(dt);
    time.value = action.time;
  }
  controls.update();
  renderer.render(scene, camera);
}

function seek(e: Event): void {
  if (!action) return;
  playing.value = false;
  action.paused = true;
  action.time = Number((e.target as HTMLInputElement).value);
  mixer.update(0);
  time.value = action.time;
}

function toggle(): void {
  playing.value = !playing.value;
  if (action) action.paused = !playing.value;
}

watch(speed, (v) => mixer && (mixer.timeScale = v));
watch([inPlace, armSpace, headClear, bodyClear], () => {
  const t = action?.time ?? 0;
  applyClip();
  if (action) {
    action.time = t;
    mixer.update(0);
  }
});
watch(skeleton, (v) => skelHelper && (skelHelper.visible = v));
watch(
  () => props.modelUrl,
  () => T && loadModel(),
);
watch(
  () => props.clipUrl,
  () => T && loadClip(),
);

onMounted(async () => {
  try {
    status.value = 'Loading viewer…';
    await three();
  } catch (e: any) {
    error.value = `three.js failed to load: ${e?.message ?? e}`;
    return;
  }
  const el = host.value!;
  renderer = new T.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = T.SRGBColorSpace;
  el.appendChild(renderer.domElement);
  scene = new T.Scene();
  scene.background = new T.Color(0x17181c);
  const pm = new T.PMREMGenerator(renderer);
  scene.environment = pm.fromScene(new T.RoomEnvironment(), 0.04).texture;
  scene.add(new T.HemisphereLight(0xffffff, 0xb0b8c8, 0.6));
  const sun = new T.DirectionalLight(0xffffff, 1.2);
  sun.position.set(1, 3, 2);
  scene.add(sun);
  const grid = new T.GridHelper(4, 20, 0x3c414c, 0x272a31);
  scene.add(grid);
  camera = new T.PerspectiveCamera(35, 1, 0.01, 1000);
  controls = new T.OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  clock = new T.Clock();
  const fit = () => {
    const w = el.clientWidth;
    const h = el.clientHeight;
    renderer.setSize(w, h);
    camera.aspect = w / Math.max(h, 1);
    camera.updateProjectionMatrix();
  };
  ro = new ResizeObserver(fit);
  ro.observe(el);
  fit();
  status.value = '';
  loop();
  await loadModel();
  await loadClip();
});

onBeforeUnmount(() => {
  cancelAnimationFrame(raf);
  ro?.disconnect();
  token++;
  if (charRoot) charRoot.traverse((o: any) => o.geometry?.dispose?.());
  renderer?.dispose();
});

const fmt = (s: number) => `${s.toFixed(2)}s · f${Math.round(s * fps)}`;
</script>

<template>
  <div class="flex min-h-0 flex-col gap-2">
    <div
      ref="host"
      class="relative min-h-0 flex-1 overflow-hidden rounded border border-white/10 bg-[#17181c]"
      :style="{ height }"
    >
      <p v-if="status" class="absolute left-2 top-2 rounded bg-black/60 px-2 py-1 text-xs text-slate-300">
        {{ status }}
      </p>
      <p v-if="!modelUrl && !status" class="absolute inset-0 flex items-center justify-center text-sm text-slate-500">
        Pick a saved character
      </p>
      <p v-if="error" class="absolute inset-x-2 bottom-2 rounded bg-black/70 p-2 text-sm text-rose-300">{{ error }}</p>
    </div>
    <div class="flex flex-wrap items-center gap-2 text-sm text-slate-300">
      <UiButton size="sm" :disabled="!duration" :title="playing ? 'Pause' : 'Play'" @click="toggle">
        {{ playing ? 'Pause' : 'Play' }}
      </UiButton>
      <input
        type="range"
        class="min-w-32 flex-1 accent-indigo-500"
        min="0"
        :max="duration || 1"
        step="0.001"
        :value="time"
        :disabled="!duration"
        aria-label="Timeline"
        @input="seek"
      />
      <span class="w-32 text-xs tabular-nums text-slate-400">{{
        duration ? `${fmt(time)} / ${duration.toFixed(2)}s` : '—'
      }}</span>
      <select
        v-model.number="speed"
        class="rounded border border-white/15 bg-surface-raised px-2 py-1 text-xs"
        title="Playback speed"
        aria-label="Playback speed"
      >
        <option v-for="s in [0.25, 0.5, 1, 1.5, 2]" :key="s" :value="s">{{ s }}×</option>
      </select>
      <UiButton
        size="sm"
        :active="inPlace"
        :title="
          inPlace ? 'In place (root motion locked) — click for root motion' : 'Root motion — click to lock in place'
        "
        @click="inPlace = !inPlace"
      >
        In place
      </UiButton>
      <UiButton
        size="sm"
        :active="skeleton"
        :title="skeleton ? 'Hide skeleton' : 'Show skeleton'"
        @click="skeleton = !skeleton"
      >
        Skeleton
      </UiButton>
    </div>
    <div class="flex flex-wrap items-center gap-4 text-xs text-slate-400">
      <label
        class="flex items-center gap-1"
        title="Arm space — push the arms away from the body, in degrees. 30° is the rig step's default."
      >
        Arm space
        <input
          v-model.lazy.number="armSpace"
          type="range"
          min="0"
          max="60"
          step="5"
          class="w-24 accent-indigo-500"
          aria-label="Arm space"
        />
        <span class="w-8 tabular-nums text-slate-200">{{ armSpace }}°</span>
      </label>
      <label
        class="flex items-center gap-1"
        title="Turn an arm away from the torso on frames where the hand would sink into it (hands on hips, behind the back, body turns)"
      >
        <input v-model="bodyClear" type="checkbox" class="accent-indigo-500" />
        Body clearance
        <span
          v-if="bodyClear && bodyInfo"
          class="tabular-nums text-slate-300"
          title="Largest arm rotation applied, and the share of frames touched"
        >
          {{ bodyInfo }}
        </span>
      </label>
      <label
        class="flex items-center gap-1"
        title="Turn an arm away from the head on frames where the hand would go inside it (big chibi heads)"
      >
        <input v-model="headClear" type="checkbox" class="accent-indigo-500" />
        Head clearance
        <span
          v-if="headClear && clearInfo"
          class="tabular-nums text-slate-300"
          title="Largest arm rotation applied, and the share of frames touched"
        >
          {{ clearInfo }}
        </span>
      </label>
    </div>
  </div>
</template>
