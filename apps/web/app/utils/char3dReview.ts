/**
 * What a char3d run puts in front of a reviewer, in the order it should be
 * looked at -- the lightbox steps through this list with the arrow keys.
 *
 * A sheet run: each sheet, then the three views it was cut into. A mesh run:
 * the GLB itself, then the turntable, clay, the close-ups a face is judged on,
 * and the views Pixal3D was actually shown. A rig run: the animated GLB, the
 * rest pose, then each clip's sheet and frames with its stretch and
 * hand-in-body numbers -- the measures a rig review has to read.
 */
import type { Char3dJson, Char3dRun, Char3dSheetSet } from '#shared/char3d';
import { CHAR3D_VIEWS, SHEET_VIEWS } from '#shared/char3d';

export interface Char3dReviewItem {
  /** Unique within one run's list; what a thumbnail opens the lightbox at. */
  key: string;
  kind: 'image' | 'model';
  /** Relative to the character, as the run records it. */
  file: string;
  title: string;
  caption?: string;
  /** A finding the reviewer should not miss (a failed cross-check, a hand in the body). */
  warn?: boolean;
  bytes?: number;
  /** The sheet this item belongs to, on a sheet run: what "add to gallery" adds. */
  set?: number;
}

const pct = (value?: number): string => (value === undefined ? '—' : `${(value * 100).toFixed(1)}%`);

function sheetItems(set: Char3dSheetSet): Char3dReviewItem[] {
  const check = set.views
    ? `width ${pct(set.check.widthDiff)} · height ${pct(set.check.heightDiff)}`
    : `${set.check.segments} figures — cannot split`;
  const items: Char3dReviewItem[] = [
    {
      key: `sheet-${set.index}`,
      kind: 'image',
      file: set.sheet,
      title: `Sheet ${set.index}`,
      caption: `seed ${set.seed ?? '—'} · ${check}`,
      warn: !set.check.ok,
      set: set.index,
    },
  ];
  for (const view of SHEET_VIEWS) {
    const file = set.views?.[view];
    if (file) items.push({ key: `sheet-${set.index}-${view}`, kind: 'image', file, title: `Sheet ${set.index} · ${view}`, caption: check, set: set.index });
  }
  return items;
}

export function char3dReviewItems(run: Char3dRun): Char3dReviewItem[] {
  const outputs = run.outputs ?? {};
  if (run.status !== 'done') return [];

  if (run.step === 'ref') {
    const sets = (outputs['sets'] ?? []) as Char3dSheetSet[];
    if (sets.length) return sets.flatMap(sheetItems);
    const images = (outputs['images'] ?? []) as { view: string; file: string; seed?: number }[];
    return CHAR3D_VIEWS.flatMap((view) =>
      images
        .filter((image) => image.view === view)
        .map((image, index) => ({
          key: `${view}-${index}`,
          kind: 'image' as const,
          file: image.file,
          title: `${view} ${index}`,
          caption: `seed ${image.seed ?? '—'}`,
        })),
    );
  }

  const files = (outputs['renders']?.files ?? {}) as Char3dJson;
  const items: Char3dReviewItem[] = [];
  const image = (key: string, file: unknown, title: string, caption?: string, warn?: boolean): void => {
    if (typeof file === 'string' && file) items.push({ key, kind: 'image', file, title, ...(caption ? { caption } : {}), ...(warn ? { warn } : {}) });
  };

  if (run.step === 'mesh') {
    if (outputs['glb']) {
      items.push({
        key: 'model',
        kind: 'model',
        file: outputs['glb'],
        title: 'Mesh',
        caption: `seed ${outputs['seed'] ?? '—'} · ${outputs['faces']?.toLocaleString?.() ?? '?'} faces`,
        ...(outputs['bytes'] ? { bytes: outputs['bytes'] } : {}),
      });
    }
    image('face_front', files['face_front'], 'Face', 'Compare the eyes with the ORIGINAL reference');
    image('face_34', files['face_34'], 'Face 3/4');
    (Array.isArray(files['detail']) ? (files['detail'] as string[]) : []).forEach((file) =>
      image(`detail-${file}`, file, `Detail · ${file.split('/').pop()?.replace(/^detail_|\.png$/g, '').replace(/_/g, ' ')}`),
    );
    image('sheet_tex', files['sheet_tex'], 'Turntable — texture');
    (Array.isArray(files['tex']) ? (files['tex'] as string[]) : []).forEach((file) =>
      image(`tex-${file}`, file, `Texture · ${file.match(/(\d+)\.png$/)?.[1] ?? ''}°`),
    );
    image('sheet_clay', files['sheet_clay'], 'Clay — geometry only');
    image('basecolor', outputs['basecolor'], 'Base colour atlas');
    const views = (outputs['views'] ?? {}) as Record<string, string>;
    for (const view of CHAR3D_VIEWS) image(`view-${view}`, views[view], `Pixal3D input · ${view}`, 'The cut-out the model was shown');
    return items;
  }

  // rig
  if (outputs['glb']) items.push({ key: 'model', kind: 'model', file: outputs['glb'], title: 'Rig — animated', caption: `${outputs['bones'] ?? '?'} bones · ${(outputs['clips'] ?? []).length} clips` });
  if (outputs['rest']) items.push({ key: 'rest', kind: 'model', file: outputs['rest'], title: 'Rig — rest pose' });
  image('rest_bones', files['rest_bones'], 'Rest pose and skeleton');
  for (const [name, clip] of Object.entries((files['clips'] ?? {}) as Record<string, Char3dJson>)) {
    const label = name.replace(/_Armature$/, '');
    const worst = clip.stretchWorst;
    const hands = clip.handInBody;
    const parts = [
      worst ? `stretch p99 ${worst.p99} · max ${worst.max} · ${(worst.over2 * 100).toFixed(1)}% edges >2×` : '',
      hands?.of ? `hand in body ${hands.frames}/${hands.of}` : '',
    ].filter(Boolean);
    const warn = Boolean(hands?.frames) || (worst?.p99 ?? 0) > 2.5;
    image(`clip-${name}`, clip.sheet, `${label}`, parts.join(' · '), warn);
    (Array.isArray(clip.frames) ? (clip.frames as string[]) : []).forEach((file, index) => {
      const stretch = Array.isArray(clip.stretch) && clip.stretch.length === clip.frames.length ? clip.stretch[index] : null;
      image(`clip-${name}-${index}`, file, `${label} · frame ${index + 1}/${clip.frames.length}`, stretch ? `stretch p99 ${stretch.p99} · max ${stretch.max}` : undefined);
    });
  }
  return items;
}
