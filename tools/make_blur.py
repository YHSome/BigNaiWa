#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
生成「极模糊缩略图」占位，产出 assets/fruits/blur.js。

用途：贴图还在加载（或者干脆失败了）的时候，别让玩家看到程序化兜底的卡通脸，
      而是画一张极模糊的同形状缩略图 —— 观感是「图正在慢慢变清晰」，不是「图挂了」。

做法：把 11 张贴图各缩到 32x32、再高斯模糊一次，横向拼成一张长条，
      整个长条编码成 WebP 后以 data URL 内联进 JS。
      —— 内联是为了**零额外请求**：占位图必须立刻能画出来，等网络就失去意义了。

跑法：
  python tools/make_blur.py
"""
import base64
import os
import re

from PIL import Image, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FRUIT_DIR = os.path.join(ROOT, "v1", "assets", "fruits")
OUT_JS = os.path.join(FRUIT_DIR, "blur.js")

CELL = 32           # 每格 32x32：再小上采样会明显发块，再大体积涨得快
BLUR = 1.6          # 生成时先模糊一下，放大后更接近"糊成一片"
QUALITY = 55        # 占位图不需要画质；实测 40~72 体积只差几百字节（开销在 alpha 边缘）


def main():
    src_js = open(os.path.join(ROOT, "v1", "game.js"), encoding="utf-8").read()
    files = re.findall(r"file:\s*'assets/fruits/([^']+)'", src_js)
    if len(files) != 11:
        print("从 game.js 里解析出 %d 个贴图，预期 11 个，退出" % len(files))
        return

    sheet = Image.new("RGBA", (CELL * len(files), CELL), (0, 0, 0, 0))
    total_src = 0
    for i, name in enumerate(files):
        path = os.path.join(FRUIT_DIR, name)
        total_src += os.path.getsize(path)
        im = Image.open(path).convert("RGBA")
        # 先缩到目标尺寸（这一步本身已经糊掉大半），再补一点高斯模糊
        tile = im.resize((CELL, CELL), Image.LANCZOS)
        a = tile.getchannel("A").filter(ImageFilter.GaussianBlur(BLUR * 0.6))
        rgb = tile.convert("RGB").filter(ImageFilter.GaussianBlur(BLUR))
        tile = Image.merge("RGBA", (*rgb.split(), a))
        sheet.paste(tile, (i * CELL, 0))

    # 直接编码到内存，比较几种格式的体积
    from io import BytesIO
    cands = {}
    for fmt, kw in (("WEBP", dict(quality=QUALITY, method=6, exact=True)),
                    ("WEBP", dict(lossless=True, method=6)),
                    ("PNG", dict(optimize=True))):
        b = BytesIO()
        sheet.save(b, fmt, **kw)
        cands["%s %s" % (fmt, kw.get("quality", "lossless") if fmt == "WEBP" else "opt")] = b.getvalue()
    best = min(cands, key=lambda k: len(cands[k]))
    print("%-22s %s" % ("候选编码", "体积"))
    for k in sorted(cands, key=lambda k: len(cands[k])):
        print("  %-20s %6d B %s" % (k, len(cands[k]), "← 采用" if k == best else ""))
    raw = cands[best]

    mime = "image/webp" if best.startswith("WEBP") else "image/png"
    data = base64.b64encode(raw).decode("ascii")

    js = (
        "/* 自动生成，别手改 —— 改缩略图请跑 tools/make_blur.py */\n"
        "/* 贴图还没到位时画的极模糊占位（内联 data URL，零额外请求） */\n"
        "window.FRUIT_BLUR = {\n"
        "  src: 'data:%s;base64,%s',\n"
        "  cell: %d,\n"
        "  cols: %d\n"
        "};\n" % (mime, data, CELL, len(files))
    )
    with open(OUT_JS, "w", encoding="utf-8", newline="\n") as f:
        f.write(js)

    print("-" * 46)
    print("长条尺寸 %dx%d，原始贴图合计 %.0f KB" % (sheet.size[0], sheet.size[1], total_src / 1024))
    print("内联后 blur.js = %.1f KB（data URL 部分 %.1f KB）" % (os.path.getsize(OUT_JS) / 1024, len(data) / 1024))


if __name__ == "__main__":
    main()
