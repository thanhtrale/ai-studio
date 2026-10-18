# mesh-char3d-tools

The CPU work between the 3D character pipeline's steps, as an arm that holds
no GPU:

| Task | Script | What it does |
| --- | --- | --- |
| `split` | `split_sheet.py` | cuts each three-view sheet on its white columns into front/left/back, keeps their vertical placement, and cross-checks them: width front vs back within 5%, the three heights within 3% |
| `reproject` | `reproject.py` | projects the input views' colours back onto a Pixal3D atlas: camera fit by silhouette IoU, DIS optical flow (≤ 15 px), hair desaturated and darkened, UV island edges bled |
| `render` | `render.py` | Blender Workbench check renders — 8 texture angles (flat light), 4 clay, face close-ups, detail shots; for a rig, each clip's frames with stretch and `handInBody` |

There is no code here. It is the `rig-mia-skintokens` package started with
`--role tools` on that arm's `.venv` (the same bpy, trimesh, embree and
OpenCV), so install that arm first; its README covers both. Declaring
`gpu: none` is the point: a render after a mesh, or a split after a sheet,
does not evict the arm that just ran.

## Job schema

| Task | Fields |
| --- | --- |
| `split` | `sheets` (PNGs under `inputDir`, up to 8), `outDir` (under `outputDir`) |
| `reproject` | `glb`, `views` (`{front, left?, back?, right?}`, the cut-outs Pixal3D saved), `outPath` (`.glb`), `options` (`flow`, `hairChroma`, `hairLum`) |
| `render` | `glb`, `outDir`, `mode` (`turntable` or `anim`), `options` (`res`, `frames`, `faceFromTop`, `faceScale`) |

The report's `result` is the script's own `done` event, with absolute paths
under `outputDir`.
