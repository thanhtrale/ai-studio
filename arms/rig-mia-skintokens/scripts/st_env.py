"""Chuẩn bị môi trường chạy SkinTokens trên Windows (import TRƯỚC code SkinTokens):

- `flash_attn` giả (st_shim/) nếu không có bản thật;
- transformers: `flash_attention_2` → `sdpa` (FA2 của transformers đòi gói flash-attn thật).
"""
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
try:
    import flash_attn  # noqa: F401
except Exception:
    sys.path.insert(0, str(HERE / "st_shim"))


def patch_transformers() -> None:
    import transformers

    def wrap(fn):
        def inner(*a, **k):
            for key in ("attn_implementation", "_attn_implementation"):
                if k.get(key) == "flash_attention_2":
                    k[key] = "sdpa"
            return fn(*a, **k)
        return inner

    for cls in (transformers.AutoModelForCausalLM, transformers.AutoModel):
        cls.from_config = wrap(cls.from_config)
        cls.from_pretrained = wrap(cls.from_pretrained)


patch_transformers()
