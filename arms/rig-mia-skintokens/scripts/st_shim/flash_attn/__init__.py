"""Gói GIẢ `flash_attn` cho SkinTokens trên Windows — chỉ `flash_attn_interface.flash_attn_func` (quy ước FA2:
q/k/v (B, L, H, D) → (B, L, H, D)), chạy bằng SDPA của PyTorch. Không có wheel flash-attn chính thức cho
Windows; các chỗ gọi khác trong SkinTokens đã có đường dự phòng riêng khi không có `flash_attn_interface` (FA3).
"""
__version__ = "0.0.0-sdpa-shim"
