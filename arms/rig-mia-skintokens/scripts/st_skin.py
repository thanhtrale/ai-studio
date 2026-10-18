"""
Trọng số skin bằng SkinTokens / TokenRig (VAST-AI, MIT) cho khung xương CHO SẴN — chạy trong venv riêng
`skintokens-venv` (transformers ≥ 4.57; MIA cần 4.46). `rig.py` gọi file này khi `weights: "skintokens"`.

    python st_skin.py <in.npz> <out.npz>

in.npz:  vertices (N,3), faces (F,3), joints (J,3) đầu xương, parents (J,) −1 ở gốc, names (J,) "mixamorig:*"
out.npz: skin (N,J) theo đúng thứ tự đỉnh + tên xương vào, cùng vài số đo.

Chế độ "use_skeleton" của TokenRig: khung xương vào được mã hoá thành token làm tiền tố, model chỉ sinh phần
token TRỌNG SỐ. Tên xương `mixamorig:*` khớp `configs/skeleton/mixamo.yaml` của repo → thứ tự chuẩn.

Windows: không có flash-attn → `st_env` (gói giả gọi SDPA + transformers sang "sdpa").
"""

from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

_PROTO = sys.stdout
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
sys.stdout = sys.stderr
T0 = time.time()
HERE = Path(__file__).resolve().parent


def emit(event: str, **kw) -> None:
    row = {"event": event, "ms": int((time.time() - T0) * 1000)}
    row.update(kw)
    _PROTO.write(json.dumps(row, ensure_ascii=False) + "\n")
    _PROTO.flush()


def main() -> int:
    import numpy as np

    src, dst = sys.argv[1], sys.argv[2]
    repo = Path(os.environ.get("SKINTOKENS_DIR") or HERE.parent / "vendor" / "SkinTokens")  # ai-studio: arm-local
    sys.path.insert(0, str(HERE))
    import st_env  # noqa: F401  (phải trước code SkinTokens)

    os.chdir(repo)
    sys.path.insert(0, str(repo))
    import torch
    from src.data.dataset import RigDataset
    from src.model.spec import ModelInput
    from src.rig_package.info.asset import Asset
    from src.server.spec import get_model
    from src.data.transform import Transform
    from src.tokenizer.parse import get_tokenizer
    from src.tokenizer.spec import TokenizeInput

    d = np.load(src, allow_pickle=True)
    V = np.asarray(d["vertices"], np.float32)
    F = np.asarray(d["faces"], np.int64)
    J = np.asarray(d["joints"], np.float32)
    parents = np.asarray(d["parents"], np.int64)
    names = [str(x) for x in d["names"]]

    t = time.time()
    model = get_model("experiments/articulation_xl_quantization_256_token_4/grpo_1400.ckpt", hf_path=None)
    tokenizer = get_tokenizer(**model.tokenizer_config)
    transform = Transform.parse(**model.transform_config["predict_transform"])
    emit("loaded", loadMs=int((time.time() - t) * 1000))

    t = time.time()
    asset = Asset.from_data(vertices=V, faces=F, joints=J, parents=parents, joint_names=names, cls="articulation")
    transform.apply(asset=asset)
    tokens = tokenizer.tokenize(input=TokenizeInput(joints=asset.joints, parents=asset.parents, cls=asset.cls,
                                                    joint_names=asset.joint_names))
    ds = RigDataset(data=[], transform=transform, process_fn=model._process_fn, tokenizer=tokenizer)
    batch = ds.collate_fn([ModelInput(asset=asset, tokens=tokens)])
    batch = {k: v.to("cuda") if isinstance(v, torch.Tensor) else v for k, v in batch.items()}
    gk = dict(model.generate_kwargs if hasattr(model, "generate_kwargs") and model.generate_kwargs else {})
    batch["generate_kwargs"] = dict(max_length=2048, top_k=5, top_p=0.95, temperature=1.0, repetition_penalty=1.0,
                                    num_return_sequences=1, num_beams=int(os.environ.get("ST_BEAMS") or 1), do_sample=True)
    mask = batch["skeleton_mask"][0] == 1
    sk = batch["skeleton_tokens"][0][mask].cpu().numpy()
    torch.manual_seed(int(os.environ.get("ST_SEED") or 0))
    preds = model.predict_step(batch, skeleton_tokens=[sk], make_asset=True)["results"]
    out = preds[0].asset
    emit("step", stage="predict", ms_phase=int((time.time() - t) * 1000),
         peakVramMiB=int(torch.cuda.max_memory_allocated() // 2**20))

    skin = np.asarray(out.skin, np.float32)
    on = list(out.joint_names) if out.joint_names is not None else names
    if skin.shape[0] != len(V):
        # Đỉnh bị đổi (trim/gộp): chép về đỉnh vào theo lân cận gần nhất, trong hệ ĐÃ CHUẨN HOÁ của asset.
        from scipy.spatial import cKDTree

        ref = asset.vertices
        _, ii = cKDTree(np.asarray(out.vertices)).query(ref, k=1)
        skin = skin[ii]
    col = [on.index(n) if n in on else -1 for n in names]
    S = np.zeros((len(V), len(names)), np.float32)
    for j, c in enumerate(col):
        if c >= 0:
            S[:, j] = skin[:, c]
    S /= np.maximum(S.sum(1, keepdims=True), 1e-9)
    np.savez_compressed(dst, skin=S, names=np.array(names), outNames=np.array(on), missing=np.array([n for n, c in zip(names, col) if c < 0]))
    emit("done", path=dst, verts=len(V), joints=len(names), outJoints=len(on),
         missing=[n for n, c in zip(names, col) if c < 0], peakVramMiB=int(torch.cuda.max_memory_allocated() // 2**20))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:
        import traceback

        traceback.print_exc()
        emit("error", message=f"{type(e).__name__}: {e}")
        sys.exit(1)
