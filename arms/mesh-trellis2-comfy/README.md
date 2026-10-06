# mesh-trellis2-comfy

TRELLIS.2 image-to-textured-mesh on [ComfyUI], as a resident arm. One
photograph in, a GLB with baked PBR maps out — base colour, metallic,
roughness, and optionally a normal map and ambient occlusion — which three.js
loads as a `MeshStandardMaterial` with no code of its own.

It is the textured sibling of `mesh-hunyuan3d-comfy`, built the same way: a
small Python process with no dependencies of its own that keeps a ComfyUI
child warm, builds the graph, and turns the child's log into the timeline.

## No runtime of its own

Like the Hunyuan3D arm, this one runs on the `image-qwen-edit-comfy` arm's
interpreter and ComfyUI checkout (`fb2315f1`), which has TRELLIS.2 natively —
`comfy/ldm/trellis2`, `comfy_extras/nodes_trellis2.py` and the mesh
post-processing nodes the bake needs. Install that arm first.

## Weights

From [Comfy-Org/TRELLIS.2] (MIT, repackaged from `microsoft/TRELLIS.2-4B`),
relative to managed storage:

| Parameter        | Default                                                   | Size |
| ---------------- | --------------------------------------------------------- | ---- |
| `diffusionModel` | `models/trellis2/trellis_2_bf16.safetensors`              | 10.3 GB |
| `clipVision`     | `models/trellis2/dino_v3_vit_l.safetensors`               | 1.2 GB |
| `shapeVae`       | `models/trellis2/trellis_2_shape_vae_bf16.safetensors`    | 1.1 GB |
| `textureVae`     | `models/trellis2/trellis_2_texture_vae_bf16.safetensors`  | 0.9 GB |
| `bgModel`        | `models/birefnet/birefnet.safetensors`                    | 0.4 GB |

`trellis_2_int8_convrot.safetensors` (5.3 GB) is downloaded alongside: the
same transformer quantised, which stays resident on a 16 GiB card where bf16
is partly streamed. The 3D console offers both as a start parameter.

The one transformer file holds all three flow models — structure, shape and
texture — and the stage nodes switch between them, so there is one load, not
three.

## The graph

Translated from Comfy-Org's template `3d_pixal3d_trellis2_image_to_model` with
its switch on TRELLIS.2, keeping its sampling exactly: the CFG intervals and
rescales, shift 5 on the structure pass, the step counts and seeds.

```
LoadImage ─ RemoveBackground ─ ImageCropToMask (1024², edge to edge, black)
                                       │
CLIPVisionLoader (DINOv3) ─ Trellis2Conditioning
                                       │
structure  EmptyTrellis2LatentStructure ─ KSampler 12 ─ VaeDecodeStructureTrellis2
shape 512  Trellis2ShapeStage ─ KSampler 20
refine     Trellis2UpsampleStage (1024|1536) ─ KSampler 12 ─ VaeDecodeShapeTrellis
texture    Trellis2TextureStage ─ KSampler 12 (unguided) ─ VaeDecodeTextureTrellis
                                       │
mesh       RemeshMesh 768 ─ DecimateMesh ─ MeshSmoothNormals ─ UnwrapMesh
bake       BakeTextureFromVoxel ─ [BakeNormalMapFromMesh] [BakeAmbientOcclusion]
           ApplyTextureToMesh ─ MeshSmoothNormals ─ SaveGLB
                                       │
then, in the arm                 maps re-encoded as WebP (EXT_texture_webp)
```

Departures from the template, all about the output being fit for a page:

- **Face count and texture size are the job's.** The template's 700K faces and
  4096 maps make a file a browser struggles with. The defaults here are 100K
  and 2048.
- **No preview, info or switch nodes.** They show things at the canvas and
  change nothing in the result.
- **No orientation fix.** `VaeDecodeShapeTrellis` already turns TRELLIS.2's
  Z-up frame into glTF's Y-up.

Normals and occlusion are baked from the dense remesh onto the decimated mesh,
which is what keeps detail the decimation threw away.

## Texture compression

`SaveGLB` embeds the maps as PNG, which is most of the file: on the test
chair, 9.3 MB of a 13.7 MB GLB. With `compressTextures` (the default) the arm
re-encodes them as WebP once the GLB is in the library — quality 90, 95 for the
normal map — and declares `EXT_texture_webp` required, which three.js's
`GLTFLoader` reads with nothing extra shipped. The same chair's maps went to
1.7 MB and the file to 6.1 MB. A map WebP would make larger stays PNG.

`webp.py` rewrites the binary chunk view by view in the original order, so
accessors are untouched. Pillow comes from the shared venv, not from this arm.
If the re-encode fails, the uncompressed GLB is kept and the timeline says so.

## Job schema

| Field              | Default | |
| ------------------ | ------- | - |
| `outPath`          | —       | must end in `.glb`, under `outputDir` |
| `refImages`        | —       | exactly one path, under `inputDir` |
| `seed`, `batch`    | −1, 1   | one seed and one file per mesh, batch ≤ 8 |
| `structureSteps`, `shapeSteps`, `refineSteps`, `textureSteps` | 12, 20, 12, 12 | |
| `cfgScale`         | 7.5     | the shape passes; the texture pass is unguided |
| `shapeResolution`  | 1024    | 1024 or 1536 |
| `targetFaces`      | 100000  | 1000 to 2,000,000 — never raw: the texture is baked onto it |
| `textureSize`      | 2048    | 512, 1024, 2048, 4096 |
| `bakeNormals`, `bakeOcclusion` | true | |
| `compressTextures` | true    | WebP maps, see above |
| `removeBackground` | true    | off: the image's own alpha is the mask |

The report lists each mesh with `vertices`, `faces` and `textured`, read back
from the GLB, and `texture_bytes_before`/`texture_bytes_after` when compressed.

## Progress

Two sources, because each knows something the other does not:

- **ComfyUI's websocket** (`comfyws.py`, a stdlib RFC 6455 client): every
  prompt is queued with the arm's `client_id`, so `executing` names each node
  as it starts, `progress` counts any node's own steps and `progress_text`
  carries a node's own line ("faces: 7.33M → 50K"). Each named node in
  `graph.NODE_LABELS` becomes a step on the timeline, and each node that counts
  steps gets its own meter -- four samplers are four bars, not one bar refilled
  four times.
- **The console log**: the only place model loads are described.

While the socket is up, the log's tqdm bar is ignored. If it drops, the arm
reconnects and falls back to that bar; completion is always decided by
`/history`, never by the socket.

## Tests

```powershell
..\image-qwen-edit-comfy\.venv\Scripts\python.exe -m pytest
..\image-qwen-edit-comfy\.venv\Scripts\python.exe -m ruff check .
```

[ComfyUI]: https://github.com/comfyanonymous/ComfyUI
[Comfy-Org/TRELLIS.2]: https://huggingface.co/Comfy-Org/TRELLIS.2
