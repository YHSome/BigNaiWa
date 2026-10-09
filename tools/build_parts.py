#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
按贴图的真实轮廓生成碰撞箱数据（不是圆形）。

做法：把 alpha 轮廓用一组小圆去覆盖（网格切块 → 每块按不透明面积折算成一个圆），
再做合并、限个数，最后换算成「以 r 为单位」的偏移和半径，写出 assets/fruits/parts.js。

游戏里每个水果就挂 N 个小圆：
  · 球球碰撞 = 两两小圆求交（外圈先用包围圆粗筛）
  · 合成判定 = 任意一对小圆贴上就合
  · 撞墙     = 每个小圆各自贴墙，推力作用在刚体中心上
这样既严格贴着图片轮廓，又完全保留了原来 PBD 求解器的稳定性。

用法： python tools/build_parts.py [--grid 5] [--min-fill 0.30] [--max-parts 9]
输出： assets/fruits/parts.js  + 控制台贴合度报表（IoU）
"""
import argparse
import json
import math
import os
import numpy as np
from PIL import Image

OUT = os.path.join("v1", "assets", "fruits")
TIERS = ["grape", "cherry", "orange", "lemon", "kiwi",
         "tomato", "peach", "pineapple", "coconut", "halfmelon", "watermelon"]

CANVAS = 512
FILL = 0.92                      # 与 normalize_assets.py 保持一致
SCALE = CANVAS * FILL / 2.0      # 画布像素 → r 单位的换算系数


def find_sprite(i):
    p = os.path.join(OUT, "%02d-%s.png" % (i, TIERS[i - 1]))
    return p if os.path.exists(p) else None


def euclid_dt(mask):
    """到轮廓的欧氏距离（chamfer 3-4 近似，误差 ~4%）。
    圆半径直接取这个值就能保证整圆落在轮廓内，且不会像切比雪夫距离那样偏小 30%。"""
    INF = 1e9
    S2 = 1.41421356
    d = np.where(mask, INF, 0.0).astype(np.float32)
    h, w = mask.shape
    idx = np.arange(w, dtype=np.float32)

    def scan_fwd(row):
        tmp = np.minimum.accumulate(row - idx)
        return np.minimum(row, tmp + idx)

    def scan_bwd(row):
        tmp = np.minimum.accumulate((row + idx)[::-1])[::-1]
        return np.minimum(row, tmp - idx)

    for y in range(h):                       # 前向：上 → 下
        row = d[y]
        if y > 0:
            prev = d[y - 1]
            np.minimum(row, prev + 1.0, out=row)
            np.minimum(row[1:], prev[:-1] + S2, out=row[1:])
            np.minimum(row[:-1], prev[1:] + S2, out=row[:-1])
        d[y] = scan_fwd(row)
    for y in range(h - 1, -1, -1):           # 后向：下 → 上
        row = d[y]
        if y < h - 1:
            nxt = d[y + 1]
            np.minimum(row, nxt + 1.0, out=row)
            np.minimum(row[1:], nxt[:-1] + S2, out=row[1:])
            np.minimum(row[:-1], nxt[1:] + S2, out=row[:-1])
        d[y] = scan_bwd(row)
    return d


def grid_circles(mask, grid, min_fill, dt, min_radius=0.06):
    ys, xs = np.nonzero(mask)
    if len(xs) == 0:
        return []
    x0, x1, y0, y1 = xs.min(), xs.max(), ys.min(), ys.max()
    cw = (x1 - x0 + 1) / grid
    ch = (y1 - y0 + 1) / grid
    min_r = min_radius * SCALE
    out = []
    for gy in range(grid):
        for gx in range(grid):
            xa = int(x0 + gx * cw); xb = int(math.ceil(x0 + (gx + 1) * cw))
            ya = int(y0 + gy * ch); yb = int(math.ceil(y0 + (gy + 1) * ch))
            sub = mask[ya:yb, xa:xb]
            if sub.size == 0 or sub.mean() < min_fill:
                continue
            # 圆心想放在格子里“离轮廓最远”的点上，这样半径最饱满
            sub_dt = dt[ya:yb, xa:xb].copy()
            sub_dt[~sub] = 0
            iy, ix = np.unravel_index(np.argmax(sub_dt), sub_dt.shape)
            cx = xa + ix
            cy = ya + iy
            area = sub.mean() * sub.size
            r_area = math.sqrt(area / math.pi)
            r = min(r_area, float(dt[cy, cx]))     # 保证落在轮廓内
            if r < min_r:
                continue
            out.append([float(cx), float(cy), float(r), area])
    return out


def merge_closest(circles):
    """把圆心最近的一对圆按面积守恒合成一个圆"""
    a, b = 0, 1
    best = None
    for i in range(len(circles)):
        for j in range(i + 1, len(circles)):
            d = math.hypot(circles[i][0] - circles[j][0], circles[i][1] - circles[j][1])
            if best is None or d < best:
                best = d
                a, b = i, j
    ca, cb = circles[a], circles[b]
    area = ca[3] + cb[3]
    cx = (ca[0] * ca[3] + cb[0] * cb[3]) / area
    cy = (ca[1] * ca[3] + cb[1] * cb[3]) / area
    r = math.sqrt(area / math.pi)
    merged = [cx, cy, r, area]
    out = [c for k, c in enumerate(circles) if k not in (a, b)]
    out.append(merged)
    return out


def circles_mask(circles, shape):
    """把圆集合画成布尔掩码，用来算贴合度"""
    h, w = shape
    yy, xx = np.mgrid[0:h, 0:w]
    m = np.zeros((h, w), bool)
    for cx, cy, r, _ in circles:
        m |= ((xx - cx) ** 2 + (yy - cy) ** 2) <= r * r
    return m


def disk_mask(shape, cx, cy, r):
    h, w = shape
    y0 = max(0, int(cy - r)); y1 = min(h, int(cy + r) + 2)
    x0 = max(0, int(cx - r)); x1 = min(w, int(cx + r) + 2)
    if y0 >= y1 or x0 >= x1:
        return None, (0, 0)
    yy, xx = np.mgrid[y0:y1, x0:x1]
    d = ((xx - cx) ** 2 + (yy - cy) ** 2) <= r * r
    return d, (y0, x0)


def fill_gaps(mask, dt, circles, budget, min_r, target=0.97):
    """贪心铺圆：每次在「还没被覆盖、且离轮廓最远」的地方放一个内接圆。
    覆盖率够了就提前收工，形状简单的水果自然用更少的圆（省碰撞开销）。"""
    covered = circles_mask(circles, mask.shape)
    total = int(mask.sum())
    placed = int((covered & mask).sum())
    while budget > 0 and placed < target * total:
        gap = mask & ~covered
        if not gap.any():
            break
        gap_dt = np.where(gap, dt, 0)
        iy, ix = np.unravel_index(np.argmax(gap_dt), gap_dt.shape)
        r = float(dt[iy, ix])
        if r < min_r:
            break
        circles.append([float(ix), float(iy), r, math.pi * r * r])
        d, (y0, x0) = disk_mask(mask.shape, ix, iy, r)
        if d is not None:
            sub = covered[y0:y0 + d.shape[0], x0:x0 + d.shape[1]]
            placed += int((d & ~sub).sum())
            sub |= d
        budget -= 1
    return circles


def build(i, grid, min_fill, max_parts):
    path = find_sprite(i)
    im = Image.open(path).convert("RGBA")
    alpha = np.asarray(im)[:, :, 3]
    mask = alpha > 128

    dt = euclid_dt(mask)
    circles = []
    if grid > 0:
        circles = grid_circles(mask, grid, min_fill, dt)
        if len(circles) > max_parts:
            circles = sorted(circles, key=lambda c: -c[3])[:max_parts]
    # 贪心铺圆：每次在“还没被覆盖、且离轮廓最远”的地方放一个内接圆
    circles = fill_gaps(mask, dt, circles, max(0, max_parts - len(circles)),
                        min_r=0.03 * SCALE)

    cover = circles_mask(circles, mask.shape)
    inter = (cover & mask).sum()
    union = (cover | mask).sum()
    iou = inter / union if union else 0.0
    cover_recall = inter / mask.sum() if mask.sum() else 0.0
    bulge = (cover & ~mask).sum() / cover.sum() if cover.sum() else 0.0

    parts = []
    rb = 0.0
    for cx, cy, r, _ in circles:
        ox = (cx - CANVAS / 2) / SCALE
        oy = (cy - CANVAS / 2) / SCALE
        s = r / SCALE
        parts.append([round(ox, 3), round(oy, 3), round(s, 3)])
        rb = max(rb, math.hypot(ox, oy) + s)

    return {
        "parts": parts,
        "rb": round(rb, 3),
        "iou": iou,
        "recall": cover_recall,
        "bulge": bulge,
        "count": len(parts),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--grid", type=int, default=5)
    ap.add_argument("--min-fill", type=float, default=0.30)
    ap.add_argument("--max-parts", type=int, default=9)
    ap.add_argument("--preview", action="store_true", help="导出贴合度对照图 _parts_preview.png")
    args = ap.parse_args()

    data = []
    print("网格 %dx%d  最小填充 %.2f  最多 %d 个圆\n" % (args.grid, args.grid, args.min_fill, args.max_parts))
    print("%-4s %-11s %5s %7s %7s %7s   %s" % ("tier", "name", "circles", "IoU", "覆盖率", "超出率", "rb"))
    for i in range(1, 12):
        r = build(i, args.grid, args.min_fill, args.max_parts)
        data.append({"parts": r["parts"], "rb": r["rb"]})
        print("%-4d %-11s %5d %7.3f %6.1f%% %6.1f%%   %.3f"
              % (i - 1, TIERS[i - 1], r["count"], r["iou"], r["recall"] * 100,
                 r["bulge"] * 100, r["rb"]))

    js = ("/* 自动生成，请勿手改 —— 由 tools/build_parts.py 生成\n"
          "   parts: [ox, oy, s]，单位是「以 r 为 1」；rb: 碰撞包围圆半径（同样以 r 为单位） */\n"
          "window.SUIKA_PARTS = " + json.dumps(data, separators=(",", ":")) + ";\n")
    dst = os.path.join(OUT, "parts.js")
    with open(dst, "w", encoding="utf-8") as f:
        f.write(js)
    print("\n已写出 %s （%.1f KB）" % (dst, os.path.getsize(dst) / 1024))

    if args.preview:
        make_preview(data)


def make_preview(data, cell=150):
    from PIL import ImageDraw
    sheet = Image.new("RGB", (cell * 6, cell * 2 * 2 + 20), (255, 255, 255))
    for i in range(1, 12):
        im = Image.open(find_sprite(i)).convert("RGBA")
        alpha = np.asarray(im)[:, :, 3]
        mask = alpha > 128
        circles = []
        for ox, oy, s in data[i - 1]["parts"]:
            circles.append((ox * SCALE + CANVAS / 2, oy * SCALE + CANVAS / 2, s * SCALE, 0))
        cover = circles_mask(circles, mask.shape)
        vis = np.zeros((CANVAS, CANVAS, 3), np.uint8)
        vis[..., 0] = np.where(mask, 255, 0)          # 轮廓=红
        vis[..., 1] = np.where(cover, 255, 0)         # 碰撞箱=绿
        vis[..., 2] = np.where(mask & cover, 255, 0)  # 重合=黄
        tile = Image.fromarray(vis).resize((cell, cell), Image.LANCZOS)
        c, r = (i - 1) % 6, (i - 1) // 6
        sheet.paste(tile, (c * cell, r * cell * 2 + r * 20))
    sheet.save("_parts_preview.png")
    print("已导出 _parts_preview.png（红=图片轮廓 绿=碰撞箱 黄=重合）")


if __name__ == "__main__":
    main()


