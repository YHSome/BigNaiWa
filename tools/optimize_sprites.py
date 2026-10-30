#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
把 assets/fruits/*.png 压成 WebP，顺便按每级水果的实际显示尺寸裁到刚刚好。

为什么需要：
  原来是 11 张 512x512 的 PNG-32，合计 1.45 MB。手游在慢网/弱网下要好几秒，
  这几秒里玩家看到的是程序化兜底水果（一堆卡通脸），观感像"图挂了"。

怎么定尺寸：
  页面里画的是 box = 2r / ASSET_FILL，最大一级 r=124 → box≈270px，
  2 倍屏需要约 540px（所以最大那张保留 512）。
  小的几级根本没用到 512，按同样的公式给它够用的尺寸就行。

跑法：
  python tools/optimize_sprites.py            # 生成 webp，打印体积对比
  python tools/optimize_sprites.py --quality 85
"""
import argparse
import os
import re

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FRUIT_DIR = os.path.join(ROOT, "v1", "assets", "fruits")

ASSET_FILL = 0.92     # 必须和 game.js 里的 ASSET_FILL 一致
MAX_SIZE = 512        # 最大一级的画布边长
MIN_SIZE = 72         # 小水果也别小于这个


def target_size(radius):
    """按「2 倍屏下显示直径」给这个等级算一个够用的画布边长。"""
    box = (radius * 2) / ASSET_FILL          # 页面上实际占的画布边长
    need = int(box * 2 + 0.5)                # 2 倍屏
    need = max(MIN_SIZE, min(MAX_SIZE, need))
    return need + (-need % 4)                # 对齐到 4 的倍数，编码器更友好


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--quality", type=int, default=88, help="有损 WebP 质量，默认 88")
    ap.add_argument("--lossless", action="store_true", help="改用无损 WebP（更大但完全无差）")
    args = ap.parse_args()

    # 半径从 game.js 的 FRUITS 表里读，避免两边写死两套
    src_js = open(os.path.join(ROOT, "v1", "game.js"), encoding="utf-8").read()
    radii = [int(m) for m in re.findall(r"r:\s*(\d+)", src_js)][:11]
    if len(radii) != 11:
        print("没从 game.js 里解析出 11 个半径，退出（拿到 %d 个）" % len(radii))
        return

    files = sorted(f for f in os.listdir(FRUIT_DIR) if f.endswith(".png"))
    if len(files) != 11:
        print("assets/fruits 里不是 11 张 PNG，退出（拿到 %d 张）" % len(files))
        return

    before = sum(os.path.getsize(os.path.join(FRUIT_DIR, f)) for f in files)
    after = 0

    print("%-20s %-11s %-11s %s" % ("文件", "原始", "优化后", "尺寸"))
    print("-" * 62)
    for i, name in enumerate(files):
        src = os.path.join(FRUIT_DIR, name)
        dst = os.path.splitext(src)[0] + ".webp"
        im = Image.open(src).convert("RGBA")
        size = target_size(radii[i])
        if im.size != (size, size):
            im = im.resize((size, size), Image.LANCZOS)
        if args.lossless:
            im.save(dst, "WEBP", lossless=True, method=6, quality=100)
        else:
            im.save(dst, "WEBP", quality=args.quality, method=6, exact=True)
        a = os.path.getsize(src)
        b = os.path.getsize(dst)
        after += b
        print("%-20s %-11s %-11s %dx%d" % (name, "%.0f KB" % (a / 1024), "%.0f KB" % (b / 1024), size, size))

    print("-" * 62)
    print("合计 %.2f MB → %.2f MB  （省掉 %.0f%%）" % (before / 1048576, after / 1048576,
                                                100 * (1 - after / float(before))))
    if not args.lossless:
        print("质量参数：有损 q%d" % args.quality)
    else:
        print("质量参数：无损")


if __name__ == "__main__":
    main()
