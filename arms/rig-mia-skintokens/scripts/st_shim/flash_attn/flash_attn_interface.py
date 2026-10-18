import torch
import torch.nn.functional as F


def flash_attn_func(q, k, v, dropout_p=0.0, softmax_scale=None, causal=False, **_kw):
    q, k, v = (x.transpose(1, 2) for x in (q, k, v))  # (B, H, L, D)
    if q.shape[1] != k.shape[1]:
        r = q.shape[1] // k.shape[1]
        k, v = k.repeat_interleave(r, dim=1), v.repeat_interleave(r, dim=1)
    out = F.scaled_dot_product_attention(q, k, v, dropout_p=dropout_p, is_causal=causal, scale=softmax_scale)
    return out.transpose(1, 2).contiguous()
