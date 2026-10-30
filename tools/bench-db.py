#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
探测排行榜后端（TinyWebDB 兼容接口）的读写速度。

· 端点与凭据直接从 v1/leaderboard.js 里解析（不另外保存一份，避免两边不一致）
· 只写以 bench_ 开头的临时 tag，真实榜单搜的是 dnw_ 前缀，不会被污染
· 跑完会把这些临时记录删掉

用法（任意目录）： python tools/bench-db.py
"""
import json
import os
import re
import statistics
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "v1", "leaderboard.js")

src = open(SRC, encoding="utf-8").read()


def grab(name):
    m = re.search(r"var %s = _x\((.*?)\);" % name, src, re.S)
    if not m:
        raise SystemExit("没在 leaderboard.js 里找到 %s" % name)
    return "".join(re.findall(r"'([0-9a-fA-F]+)'", m.group(1)))


KEY = [int(x) for x in re.search(r"_k = \[([0-9,\s]+)\]", src).group(1).split(",")]


def dec(h):
    out = []
    for i in range(0, len(h), 2):
        out.append(chr(int(h[i:i + 2], 16) ^ KEY[(i >> 1) & 3]))
    return "".join(out)


API = dec(grab("API"))
USER = dec(grab("USER"))
SECRET = dec(grab("SECRET"))
PREFIX = dec(grab("PREFIX"))

print("端点：", API)
print("用户：", USER, " 榜单 tag 前缀：", PREFIX)
print()

TAG_PREFIX = "bench_%d_" % int(time.time())
written = []


def post(params, timeout=20):
    body = {"user": USER, "secret": SECRET}
    body.update(params)
    data = urllib.parse.urlencode(body).encode()
    req = urllib.request.Request(API, data=data, method="POST")
    req.add_header("Content-Type", "application/x-www-form-urlencoded")
    t0 = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read().decode("utf-8", "replace")
        return (time.perf_counter() - t0) * 1000.0, raw, None
    except Exception as e:                                    # noqa: BLE001
        return (time.perf_counter() - t0) * 1000.0, "", repr(e)


def stats(xs, label):
    if not xs:
        print("  %-26s 无有效样本" % label)
        return
    xs_sorted = sorted(xs)
    p = lambda q: xs_sorted[min(len(xs_sorted) - 1, int(round(q * (len(xs_sorted) - 1))))]
    print("  %-26s n=%-3d  平均 %6.1f | p50 %6.1f | p90 %6.1f | p95 %6.1f | 最快 %6.1f | 最慢 %6.1f ms"
          % (label, len(xs), statistics.fmean(xs), p(0.5), p(0.9), p(0.95), xs_sorted[0], xs_sorted[-1]))


def run(seq):
    """串行跑一批，返回 (耗时列表, 失败数)"""
    times, fails = [], 0
    for fn in seq:
        ms, raw, err = fn()
        if err or not raw.strip():
            fails += 1
        times.append(ms)
    return times, fails


def bench_write(i):
    tag = "%s%d" % (TAG_PREFIX, i)
    value = json.dumps({"n": "bench", "s": 1000 + i, "t": int(time.time() * 1000)})
    return lambda: post({"action": "update", "tag": tag, "value": value})


def bench_get(i):
    tag = "%s%d" % (TAG_PREFIX, i - 1)
    return lambda: post({"action": "get", "tag": tag})


def bench_search_pages(pages):
    def call():
        total = 0.0
        err = None
        for page in range(pages):
            ms, raw, e = post({"action": "search", "no": str(1 + page * 100),
                               "count": "100", "tag": PREFIX, "type": "both"})
            total += ms
            if e and not err:
                err = e
        return total, "ok", err
    return call


# ---------- 0. 预热（把 DNS/TLS/连接统统建起来，别算进统计） ----------
ms, raw, err = post({"action": "search", "no": "1", "count": "1", "tag": PREFIX, "type": "both"})
print("[0] 预热：单次请求 %.0f ms %s" % (ms, ("失败 " + err) if err else "OK"))
if err:
    raise SystemExit("端点不通，先别测了：" + err)

N_W = 20
print("\n[1] 写入（update，串行 %d 次）" % N_W)
wt, wf = run([bench_write(i) for i in range(N_W)])
for i in range(N_W):
    written.append("%s%d" % (TAG_PREFIX, i))
stats(wt, "写 update")
print("  %-26s %d / %d" % ("失败", wf, N_W))

print("\n[2] 写入（update，4 并发 × 10 条）")
burst_tags = []
def burst(i):
    tag = "benchc_%d_%d" % (int(time.time()), i)
    burst_tags.append(tag)
    value = json.dumps({"n": "bench", "s": i, "t": int(time.time() * 1000)})
    return lambda: post({"action": "update", "tag": tag, "value": value})

t0 = time.perf_counter()
with ThreadPoolExecutor(max_workers=4) as ex:
    bres = list(ex.map(lambda f: f(), [burst(i) for i in range(10)]))
wall = (time.perf_counter() - t0) * 1000.0
bms = [r[0] for r in bres]
bf = sum(1 for r in bres if r[2] or not r[1].strip())
stats(bms, "并发写")
print("  %-26s %.0f ms（10 次，4 并发）→ %.1f 次/秒，失败 %d" % ("墙钟/吞吐", wall, 10 * 1000.0 / wall, bf))
written.extend(burst_tags)

print("\n[3] 读取（get 单条，串行 10 次）")
gt, gf = run([bench_get(i + 1) for i in range(10)])
stats(gt, "读 get")
print("  %-26s %d / %d" % ("失败", gf, 10))

print("\n[4] 读取（search 1 页，串行 10 次）")
st, sf = run([bench_search_pages(1) for _ in range(10)])
stats(st, "读 search×1")
print("  %-26s %d / %d" % ("失败", sf, 10))

print("\n[5] 读取（search 2 页 = 游戏里 fetchTop 的实际开销，串行 8 次）")
ft, ff = run([bench_search_pages(2) for _ in range(8)])
stats(ft, "读 search×2")
print("  %-26s %d / %d" % ("失败", ff, 8))

# ---------- 6. 清理测试数据 ----------
print("\n[6] 清理 %d 条 bench 测试记录" % len(written))
ok_cnt = 0
for tag in written:
    ms, raw, err = post({"action": "delete", "tag": tag})
    if not err:
        ok_cnt += 1
print("  已删除 %d / %d（delete 若不支持，这些 bench_ 记录也不会出现在 dnw_ 榜单里）" % (ok_cnt, len(written)))

# 复查：确认真实榜单里没有 bench 前缀的东西
ms, raw, err = post({"action": "search", "no": "1", "count": "100", "tag": PREFIX, "type": "both"})
if not err:
    try:
        obj = json.loads(raw) if raw.strip() else {}
        keys = [k for k in obj if isinstance(k, str)]
        print("\n[7] 复查真实榜单（%s 前缀）：取到 %d 条" % (PREFIX, len(keys)))
        bad = [k for k in keys if "bench" in k]
        print("  含 bench 的条目：", bad if bad else "无 ✅")
    except Exception as e:                                   # noqa: BLE001
        print("  复查解析失败：", e)
