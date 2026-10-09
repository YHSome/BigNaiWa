#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
把 src/ 里 1..11 的原始图统一成游戏用的素材：
  · 统一尺寸 512x512、统一 PNG(RGBA)、透明背景
  · 主体按“最长边 = 92% 画布”等比缩放并居中
  · 自动抠底：从四边向内区域生长 + 饱和度/亮度闸门（浅底防漏、深底反向）
  · 去噪：丢掉零碎小岛（星星/灰尘）、填掉主体内部的小孔
输出：assets/fruits/NN-<tier>.png

区域生长的思路：背景从画面四边开始，一像素一像素往内吃，
只有“和已经判为背景的邻居颜色足够接近（< tol）”的像素才会被吃进来；
再加一道闸门 —— 浅底图里饱和度高的像素永远不算背景，深底图里亮度高的像素永远不算背景。
这样即使主体边缘很羽化，也只会停在主体外沿，不会整块漏进去。
"""
import os
import numpy as np
from PIL import Image, ImageFilter
from collections import deque

SRC = "src"
OUT = os.path.join("v1", "assets", "fruits")
SIZE = 512            # 输出画布边长
FILL = 0.92           # 主体最长边占画布比例
MAX_ITER = 4000

TIERS = ["grape", "cherry", "orange", "lemon", "kiwi",
         "tomato", "peach", "pineapple", "coconut", "halfmelon", "watermelon"]

# 每张图的抠底参数：tol = 相邻像素色差阈值
#   浅色背景 → 用饱和度闸门 sat_max（更高饱和度的像素不许当背景）
#   深色背景 → 用亮度闸门   lum_min（更亮的像素不许当背景）
CFG = {
    1:  dict(tol=10, sat_max=0.10),
    2:  dict(tol=10, sat_max=0.10),
    3:  dict(tol=10, sat_max=0.10),
    4:  dict(tol=10, sat_max=0.10),
    5:  dict(tol=10, sat_max=0.10),   # 自带 alpha，走另一条路
    6:  dict(tol=10, sat_max=0.10),
    7:  dict(tol=10, sat_max=0.10),
    8:  dict(tol=10, sat_max=0.10),
    # 9 号翅膀是“接近白但不是纯白”（223~241），背景是纯白 253~255，
    # 所以再加一道亮度地板闸门，把翅膀保住，否则会剩一圈碎渣
    9:  dict(tol=10, sat_max=0.10, val_min=246),
    10: dict(tol=10, sat_max=0.10),
    11: dict(tol=10, lum_min=0.62),
}


def find_src(i):
    for ext in ("png", "jpg", "jpeg", "webp", "bmp", "gif"):
        p = os.path.join(SRC, "%d.%s" % (i, ext))
        if os.path.exists(p):
            return p
    return None


def sh(a, dy, dx):
    """平移数组，空出来的边用边缘像素填充（不环绕）"""
    out = np.empty_like(a)
    if dy > 0:
        out[:dy] = a[0]; out[dy:] = a[:-dy]
    elif dy < 0:
        out[dy:] = a[-1]; out[:dy] = a[-dy:]
    else:
        out[:] = a
    if dx > 0:
        tmp = out.copy()
        out[:, :dx] = tmp[:, 0:1]; out[:, dx:] = tmp[:, :-dx]
    elif dx < 0:
        tmp = out.copy()
        out[:, dx:] = tmp[:, -1:]; out[:, :dx] = tmp[:, -dx:]
    return out


def region_grow_bg(rgb, tol=10, sat_max=None, lum_min=None, val_min=None):
    """从四边向内区域生长求背景（True = 背景）

    tol     : 相邻像素色差阈值（能不能跨过羽化边缘）
    sat_max : 闸门——饱和度高于它的像素永不算背景（浅底图防漏）
    lum_min : 闸门——亮度高于它的像素永不算背景（深底图防漏）
    val_min : 闸门——最暗通道低于它的像素永不算背景
              （保住“接近白但非纯白”的细节，例如白翅膀）
    """
    h, w, _ = rgb.shape
    r = rgb.astype(np.int16)
    f = r.astype(np.float32) / 255.0
    mx = f.max(axis=2)
    mn = f.min(axis=2)
    sat = np.where(mx > 1e-6, (mx - mn) / np.maximum(mx, 1e-6), 0.0)
    lum = 0.299 * f[:, :, 0] + 0.587 * f[:, :, 1] + 0.114 * f[:, :, 2]

    guard = np.ones((h, w), bool)
    if sat_max is not None:
        guard &= (sat < sat_max)
    if lum_min is not None:
        guard &= (lum < lum_min)
    if val_min is not None:
        guard &= (r.min(axis=2) >= val_min)

    bg = np.zeros((h, w), bool)
    bg[0, :] = True; bg[-1, :] = True; bg[:, 0] = True; bg[:, -1] = True
    bg &= guard

    close = []
    for dy, dx in ((-1, 0), (1, 0), (0, -1), (0, 1)):
        nb = sh(r, dy, dx)
        close.append(np.abs(r - nb).max(axis=2) < tol)

    for _ in range(MAX_ITER):
        new = np.zeros((h, w), bool)
        for k, (dy, dx) in enumerate(((-1, 0), (1, 0), (0, -1), (0, 1))):
            new |= sh(bg, dy, dx) & (~bg) & close[k] & guard
        if not new.any():
            break
        bg |= new
    return bg


def label(mask):
    """连通域标记：返回 (标签图, 面积表)，标签 0 = 背景"""
    h, w = mask.shape
    lab = np.zeros((h, w), np.int32)
    areas = [0]
    ys, xs = np.nonzero(mask)
    n = 0
    for sy, sx in zip(ys.tolist(), xs.tolist()):
        if lab[sy, sx]:
            continue
        n += 1
        q = deque([(sy, sx)])
        lab[sy, sx] = n
        cnt = 0
        while q:
            y, x = q.popleft()
            cnt += 1
            if y > 0 and mask[y - 1, x] and not lab[y - 1, x]:
                lab[y - 1, x] = n; q.append((y - 1, x))
            if y + 1 < h and mask[y + 1, x] and not lab[y + 1, x]:
                lab[y + 1, x] = n; q.append((y + 1, x))
            if x > 0 and mask[y, x - 1] and not lab[y, x - 1]:
                lab[y, x - 1] = n; q.append((y, x - 1))
            if x + 1 < w and mask[y, x + 1] and not lab[y, x + 1]:
                lab[y, x + 1] = n; q.append((y, x + 1))
        areas.append(cnt)
    return lab, np.array(areas)


def subject_mask(alpha):
    """去噪：丢掉零碎小岛（噪点/星星），填掉主体内部的小孔"""
    m = alpha > 0.5

    # 1) 只保留够大的前景连通域
    lab, areas = label(m)
    if len(areas) > 1:
        big = areas[1:].max()
        keep = areas >= max(64, big * 0.02)
        keep[0] = False
        if keep.sum() > 1:                      # 至少留最大的一块
            m = keep[lab]

    # 2) 填掉被主体包住的小孔（< 0.4% 画面）
    bgm = ~m
    lab2, areas2 = label(bgm)
    if len(areas2) > 1:
        limit = m.size * 0.004
        hole = (areas2 < limit) & (areas2 > 0)
        hole[0] = False
        # 只有不接触画布边界的小孔才算“孔”
        border_lab = set(np.unique(np.concatenate([lab2[0, :], lab2[-1, :], lab2[:, 0], lab2[:, -1]])))
        for t in list(border_lab):
            if t < len(hole):
                hole[t] = False
        m = m | hole[lab2]
    return m


def bake_rim(canvas, rim_px=7, alpha=0.5, color=(122, 78, 30)):
    """在主体底下垫一圈柔和的深色投影边，让浅色角色在奶油色棋盘上也能分清
    （烘进素材，运行时零开销；缩放时自动跟着水果大小变粗细）"""
    a = np.asarray(canvas).astype(np.float32)[:, :, 3] / 255.0
    m = a > 0.5
    d = m.copy()
    dirs = ((-1, 0), (1, 0), (0, -1), (0, 1), (-1, -1), (-1, 1), (1, -1), (1, 1))
    for _ in range(rim_px):
        e = d.copy()
        for dy, dx in dirs:
            e |= sh(d, dy, dx)
        d = e
    rim = np.asarray(Image.fromarray((d * 255).astype(np.uint8))
                     .filter(ImageFilter.GaussianBlur(rim_px * 0.6))).astype(np.float32) / 255.0
    rim = np.clip(rim * alpha, 0, 1)

    layer = np.zeros((canvas.size[1], canvas.size[0], 4), np.uint8)
    layer[:, :, 0] = color[0]
    layer[:, :, 1] = color[1]
    layer[:, :, 2] = color[2]
    layer[:, :, 3] = (rim * 255).astype(np.uint8)
    return Image.alpha_composite(Image.fromarray(layer, "RGBA"), canvas)


def process(i):
    path = find_src(i)
    if not path:
        raise RuntimeError("缺少第 %d 张" % i)

    im = Image.open(path).convert("RGBA")
    arr = np.asarray(im).astype(np.float32)
    rgb = arr[:, :, :3]
    a0 = arr[:, :, 3]
    has_alpha = a0.min() < 250 and (a0 < 128).mean() > 0.02

    if has_alpha:
        a = a0 / 255.0
        mode = "已有透明通道"
    else:
        bg = region_grow_bg(rgb.astype(np.uint8), **CFG[i])
        a = subject_mask(~bg).astype(np.float32)
        mode = "自动抠底"

    # 羽化边缘（只影响 1~2 像素）
    a = np.asarray(Image.fromarray((a * 255).astype(np.uint8))
                   .filter(ImageFilter.GaussianBlur(0.8))).astype(np.float32) / 255.0
    a[a < 0.06] = 0.0
    if a.max() <= 0:
        raise RuntimeError("抠底失败：整幅图都变透明了")

    out = arr.copy()
    out[:, :, 3] = np.clip(a * 255.0, 0, 255)
    im2 = Image.fromarray(out.astype(np.uint8), "RGBA")

    bbox = im2.split()[3].point(lambda v: 255 if v > 12 else 0).getbbox()
    if bbox is None:
        raise RuntimeError("抠底失败：找不到主体")
    subject = im2.crop(bbox)
    sw, shh = subject.size

    # 等比缩放到统一画布并居中（长边 = 92% 画布）
    target = int(round(SIZE * FILL))
    k = target / max(sw, shh)
    nw, nh = max(1, int(round(sw * k))), max(1, int(round(shh * k)))
    subject = subject.resize((nw, nh), Image.LANCZOS)
    canvas = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    canvas.paste(subject, ((SIZE - nw) // 2, (SIZE - nh) // 2), subject)
    canvas = bake_rim(canvas)

    name = "%02d-%s.png" % (i, TIERS[i - 1])
    dst = os.path.join(OUT, name)
    canvas.save(dst, "PNG", optimize=True)

    px = np.asarray(canvas).astype(np.float32)
    solid = px[:, :, 3] > 200
    mean = px[:, :, :3][solid].mean(axis=0) if solid.any() else np.array([200., 200., 200.])
    hexc = "#%02x%02x%02x" % tuple(int(v) for v in mean)

    print("%-16s %-12s -> %-22s %dx%d  主体 %3dx%-3d  %s  %5.1f%%  %6.1f KB"
          % (os.path.basename(path), mode, name, SIZE, SIZE, nw, nh, hexc,
             solid.mean() * 100, os.path.getsize(dst) / 1024))
    return hexc


def main():
    os.makedirs(OUT, exist_ok=True)
    print("画布 %dx%d  主体占长边 %.0f%%\n" % (SIZE, SIZE, FILL * 100))
    colors = [process(i) for i in range(1, 12)]
    print("\n各级主体平均色（可写进 FRUITS 的 c1/c2，用于粒子和飘分文字）:")
    for i, c in enumerate(colors):
        print("  tier %2d  %-10s %s" % (i, TIERS[i], c))


if __name__ == "__main__":
    main()
