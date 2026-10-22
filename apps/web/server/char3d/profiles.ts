import { char3dBody, type Char3dBody, type Char3dCharacter } from '#shared/char3d';

/**
 * What changes between a chibi and a game-model character, in one place. Every
 * step reads its defaults from here; a run's own config still wins, and the
 * defaults are written into run.json so a run says what it used.
 *
 * The chibi numbers are measured (docs/char3d.md). The game-model numbers come
 * from one character so far (jade-hanfu-girl, 2026-10-21) and are marked so.
 */
export interface BodyProfile {
  /** `{proportions}` in the sheet prompt. */
  sheet: string;
  /**
   * Where the fists should sit (`split_sheet.py` `pose.*.handY`, the widest
   * row between 15 % and 75 % of the height) for a ~45° A-pose.
   */
  handBand: readonly [number, number];
  /** render.py options for the mesh and rig check renders. */
  render: Record<string, number>;
  /** rig.py defaults. */
  rig: Record<string, unknown>;
}

/**
 * `chibi`: any reference -- a photo, a realistic or anime drawing -- comes out
 * a chibi figure. Drawn like a painted PVC figure because that is what meshes:
 * Pixal3D turns thin drawn strands into thin shredded cards (docs/char3d.md,
 * "Jagged hair starts in the ref"), and sculpted locks into solid ones.
 */
const CHIBI_SHEET =
  'Redraw the character as a cute chibi figure, whatever the style of <image1>: a big head about one third of the total height, a small short body, short arms and legs, large expressive eyes, while keeping the same face features, hairstyle, outfit design and colors as <image1>. Clean 3D figure style like a painted PVC chibi figurine: smooth solid shapes, the hair made of a few large sculpted locks, never thin strands or flyaway wisps.';

/**
 * `game`: adult proportions as a 3D anime game model. Without the explicit
 * "head about one seventh" the sheet drifted towards a big head; the "smooth
 * solid" clause is the chibi lesson (thin strands mesh as shredded cards).
 * jade-hanfu-girl r01/r02: head ~1/7, long legs, both sheets.
 */
const GAME_SHEET =
  'Realistic adult anime proportions like a high-quality 3D anime game character model (Arknights: Endfield or Genshin Impact style): the head about one seventh of the total height, a natural adult body, long legs, NOT chibi, keeping the same face features, hairstyle, outfit design and colors as <image1>. Clean 3D render look with smooth solid shapes, the hair made of solid sculpted masses, never thin strands or flyaway wisps.';

export const BODY_PROFILES: Record<Char3dBody, BodyProfile> = {
  chibi: {
    sheet: CHIBI_SHEET,
    // Rigs that worked: 0.565-0.587 (chibi-martial-girl r03/r20/r26/r40).
    handBand: [0.53, 0.61],
    // render.py's own default: the face centre 36 % down from the top.
    render: {},
    // rig.py's defaults: armSpace 30° keeps short arms out of a big body.
    rig: {},
  },
  game: {
    sheet: GAME_SHEET,
    // jade-hanfu-girl r01 0.47, r02 0.44, both ~40-45° and clear of the skirt. One character: widen when measured.
    handBand: [0.42, 0.5],
    // A head ~1/7 of the height puts the face centre ~8 % down (docs/char3d.md, "Check renders").
    render: { faceFromTop: 0.08 },
    // Mixamo clips are made for adult proportions: arm space exists for chibi bodies (r62-r63). Not yet measured here.
    rig: { armSpace: 0 },
  },
};

/** The reference's own proportions: characters made before `chibi` existed. */
export const KEEP_PROPORTIONS = 'Same face, same colors and exactly the same body proportions as <image1>.';

export const profileOf = (character: Pick<Char3dCharacter, 'chibi'>): BodyProfile => BODY_PROFILES[char3dBody(character)];

/** The sheet's `{proportions}`: the profile's, or the reference's own for a character with no profile. */
export const sheetProportions = (character: Pick<Char3dCharacter, 'chibi'>): string =>
  character.chibi === undefined ? KEEP_PROPORTIONS : profileOf(character).sheet;
