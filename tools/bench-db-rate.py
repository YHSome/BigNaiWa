#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
排行榜后端「读写频率」探测：持续串行 → 并发阶梯 → 尖峰，看吞吐上限与被限速的迹象。

· 每个 worker 用一条自己的 keep-alive 连接（等价于浏览器复用连接）
· 只写 benchr_ 前缀，跑完删除，并复查真实榜单没被污染
· 统计：成功/失败、状态码分布、限速类响应、吞吐（次/秒）、延迟分位
· 用法（任意目录）： python tools/bench-db-rate.py   （约 40 秒、~210 次写 + ~180 次读，跑完自动清理）
"""
import http.client
import json
import os
import re
import ssl
import statistics
import threading
import time
import urllib.parse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
src = open(os.path.join(ROOT, "v1", "leaderboard.js"), encoding="utf-8").read()


def grab(name):
    m = re.search(r"var %s = _x\((.*?)\);" % name, src, re.S)
    return "".join(re.findall(r"'([0-9a-fA-F]+)'", m.group(1)))


KEY = [int(x) for x in re.search(r"_k = \[([0-9,\s]+)\]", src).group(1).split(",")]
dec = lambda h: "".join(chr(int(h[i:i + 2], 16) ^ KEY[(i >> 1) & 3]) for i in range(0, len(h), 2))
API, USER, SECRET, PREFIX = dec(grab("API")), dec(grab("USER")), dec(grab("SECRET")), dec(grab("PREFIX"))
u = urllib.parse.urlparse(API)
HOST, PATH = u.hostname, u.path
CTX = ssl.create_default_context()

STAMP = int(time.time())
TAGS = []
lock = threading.Lock()
LIMIT_HINTS = ("too many", "busy", "throttle", "denied", "exceed", "flood", "rate limit")
LIMIT_STATUS = (429, 500, 502, 503, 504)

print("端点：%s%s" % (HOST, PATH))


def call(params, conn, timeout=15):
    """返回 (耗时ms, status, body前120字, 错误描述)"""
    payload = urllib.parse.urlencode(dict({"user": USER, "secret": SECRET}, **params))
    t0 = time.perf_counter()
    try:
        conn.request("POST", PATH, body=payload,
                     headers={"Content-Type": "application/x-www-form-urlencoded"})
        r = conn.getresponse()
        raw = r.read()
        ms = (time.perf_counter() - t0) * 1000
        body = raw.decode("utf-8", "replace")
        err = None
        if r.status >= 400:
            err = "HTTP %d" % r.status
        return ms, r.status, body, err
    except Exception as e:                                  # noqa: BLE001
        return (time.perf_counter() - t0) * 1000, 0, "", repr(e)


def new_conn():
    return http.client.HTTPSConnection(HOST, 443, timeout=20, context=CTX)


def summarize(name, lat, fails, bodies, wall):
    if not lat:
        print("  %-24s 没有完成的请求" % name)
        return
    ok = len(lat) - fails
    print("  %-24s 完成 %-3d 成功 %-3d 失败 %-2d | 吞吐 %5.2f 次/秒 | 平均 %5.0f ms | p50 %5.0f | p95 %5.0f"
          % (name, len(lat), ok, fails, len(lat) / wall,
             statistics.fmean(lat), statistics.median(lat), sorted(lat)[int(0.95 * (len(lat) - 1))]))
    if fails:
        uniq = {}
        for b in bodies:
            uniq[b] = uniq.get(b, 0) + 1
        for b, c in sorted(uniq.items(), key=lambda kv: -kv[1])[:3]:
            print("      失败样本 x%d: %s" % (c, b))


# ---------- 1. 串行持续写 / 读（各 8 秒，尽力而为） ----------
def sustained(kind, seconds=8):
    conn = new_conn()
    lat, fails, bodies = [], 0, []
    seq = 0
    deadline = time.time() + seconds
    while time.time() < deadline:
        seq += 1
        if kind == "write":
            tag = "benchr_%d_w%d" % (STAMP, seq)
            with lock:
                TAGS.append(tag)
            params = {"action": "update", "tag": tag,
                      "value": json.dumps({"n": "bench", "s": seq, "t": int(time.time() * 1000)})}
        else:
            params = {"action": "search", "no": "1", "count": "100", "tag": PREFIX, "type": "both"}
        ms, status, body, err = call(params, conn)
        lat.append(ms)
        low = body.lower()
        if err or status in LIMIT_STATUS or any(h in low for h in LIMIT_HINTS):
            fails += 1
            bodies.append(body or err or "?")
    conn.close()
    return lat, fails, bodies, seconds


print("\n[1] 串行持续写 8 秒")
t = time.time()
w1, f1, b1, s1 = sustained("write", 8)
summarize("写 update", w1, f1, b1, time.time() - t)

print("\n[2] 串行持续读 8 秒（每次读 1 页 100 条）")
t = time.time()
r1, rf1, rb1, s1 = sustained("read", 8)
summarize("读 search", r1, rf1, rb1, time.time() - t)


# ---------- 3. 并发阶梯：2 / 4 / 8 个并发，各 4 秒 ----------
def concurrent_writes(workers, seconds=4):
    lat, fails, bodies = [], 0, []

    def worker():
        nonlocal fails
        conn = new_conn()
        n = 0
        deadline = time.time() + seconds
        while time.time() < deadline:
            n += 1
            tag = "benchr_%d_c%d_%d_%d" % (STAMP, workers, threading.get_ident() % 1000, n)
            with lock:
                TAGS.append(tag)
            ms, status, body, err = call({"action": "update", "tag": tag,
                                          "value": json.dumps({"n": "bench", "s": n,
                                                               "t": int(time.time() * 1000)})}, conn)
            with lock:
                lat.append(ms)
                if err or status in LIMIT_STATUS or any(h in body.lower() for h in LIMIT_HINTS):
                    fails += 1
                    bodies.append(body or err or "?")
        conn.close()

    ths = [threading.Thread(target=worker) for _ in range(workers)]
    t0 = time.time()
    for th in ths:
        th.start()
    for th in ths:
        th.join()
    return lat, fails, bodies, time.time() - t0


for w in (2, 4, 8):
    print("\n[3] 并发写 %d 个线程 × 4 秒" % w)
    lat, fails, bodies, wall = concurrent_writes(w, 4)
    summarize("并发写 x%d" % w, lat, fails, bodies, wall)


# ---------- 4. 尖峰：16 个并发一次性打满 ----------
def burst(n=16):
    lat, fails, bodies = [], 0, []
    barrier = threading.Barrier(n)

    def worker(i):
        nonlocal fails
        conn = new_conn()
        tag = "benchr_%d_b%d" % (STAMP, i)
        with lock:
            TAGS.append(tag)
        barrier.wait()
        ms, status, body, err = call({"action": "update", "tag": tag,
                                      "value": json.dumps({"n": "bench", "s": i,
                                                           "t": int(time.time() * 1000)})}, conn)
        conn.close()
        with lock:
            lat.append(ms)
            if err or status in LIMIT_STATUS or any(h in body.lower() for h in LIMIT_HINTS):
                fails += 1
                bodies.append(body or err or "?")

    ths = [threading.Thread(target=worker, args=(i,)) for i in range(n)]
    t0 = time.time()
    for th in ths:
        th.start()
    for th in ths:
        th.join()
    return lat, fails, bodies, time.time() - t0


print("\n[4] 尖峰：16 个并发同时写")
lat, fails, bodies, wall = burst(16)
summarize("尖峰 x16", lat, fails, bodies, wall)



# ---------- 4.5 读并发阶梯（只读，不写数据） ----------
def read_concurrency(n, seconds=3):
    lat, fails = [], []
    ths = [threading.Thread(target=read_worker, args=(seconds, lat, fails)) for _ in range(n)]
    t0 = time.time()
    for t in ths:
        t.start()
    for t in ths:
        t.join()
    return lat, fails, time.time() - t0


def read_worker(seconds, lat, fails):
    conn = http.client.HTTPSConnection(HOST, 443, timeout=20, context=CTX)
    deadline = time.time() + seconds
    while time.time() < deadline:
        payload = urllib.parse.urlencode({"user": USER, "secret": SECRET,
                                          "action": "search", "no": "1", "count": "100",
                                          "tag": PREFIX, "type": "both"})
        t0 = time.perf_counter()
        err = None
        try:
            conn.request("POST", PATH, body=payload,
                         headers={"Content-Type": "application/x-www-form-urlencoded"})
            r = conn.getresponse()
            body = r.read()
            if r.status >= 400:
                err = "HTTP %d" % r.status
        except Exception as e:                             # noqa: BLE001
            err = repr(e)
            conn.close()
            conn = http.client.HTTPSConnection(HOST, 443, timeout=20, context=CTX)
            body = b""
        ms = (time.perf_counter() - t0) * 1000
        with lock:
            lat.append(ms)
            if err:
                fails.append(err)
    conn.close()




print("\n[4.5] 读榜并发阶梯（每次 count=100）")
for n in (4, 8, 16):
    lat, fails, wall = read_concurrency(n, 3)
    summarize("并发读 x%d" % n, lat, len(fails), fails, wall)

# ---------- 5. 清理 + 复查 ----------
print("\n[5] 清理 %d 条测试记录" % len(TAGS))
conn = new_conn()
okc = 0
for tag in TAGS:
    ms, status, body, err = call({"action": "delete", "tag": tag}, conn)
    if not err:
        okc += 1
conn.close()
print("  已删除 %d / %d" % (okc, len(TAGS)))

conn = new_conn()
ms, status, body, err = call({"action": "search", "no": "1", "count": "100",
                              "tag": PREFIX, "type": "both"}, conn)
conn.close()
try:
    obj = json.loads(body) if body.strip().startswith("{") else {}
    bad = [k for k in obj if "bench" in str(k)]
    print("  复查真实榜单：%d 条，含 bench 的：%s" % (len(obj), bad if bad else "无 ✅"))
except Exception as e:                                     # noqa: BLE001
    print("  复查解析失败：", e, "｜样本:", body[:80])
