#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
把 leaderboard.js 压成 leaderboard.min.js：
  · 字符串感知地去掉注释（行注释 + 块注释），不会误伤 'https://...' 里的 //
  · 去掉缩进与空行（本文件没有模板字符串/多行字符串，这样压是安全的）
  · 把内部实现用到的那几个标识符改名成短名
  · 把接口动作关键词（search/update/delete/get）编码成十六进制

注意：只做「安全子集」的压缩 —— 不做语法级重排。
"""
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "v1", "leaderboard.js")
DST = os.path.join(ROOT, "v1", "leaderboard.min.js")

# 只改这些自己写的标识符，别碰标准库方法
RENAME = [
    ("searchRecent", "_s"),
    ("stampOf", "_m"),
    ("_x", "_u"),
    ("_k", "_K"),
    ("API", "_p"),
    ("USER", "_n"),
    ("SECRET", "_w"),
]

# 接口动作关键词也编码掉，免得读代码的人一眼看出它在干什么
ACTIONS = ["search", "update", "delete", "get"]
KEY = [0x5A, 0x3C, 0x91, 0x27]

QUOTES = ("'", '"', "`")


def enc(s):
    b = s.encode("utf-8")
    return "".join("%02x" % (ch ^ KEY[i & 3]) for i, ch in enumerate(b))


def strip_comments(src):
    """字符串感知地剥掉 // 行注释与 /* */ 块注释。"""
    out = []
    i, n = 0, len(src)
    quote = None
    while i < n:
        c = src[i]
        if quote:
            out.append(c)
            if c == "\\" and i + 1 < n:
                out.append(src[i + 1])
                i += 2
                continue
            if c == quote:
                quote = None
            i += 1
            continue
        if c in QUOTES:
            quote = c
            out.append(c)
            i += 1
            continue
        if c == "/" and i + 1 < n and src[i + 1] == "/":
            while i < n and src[i] != "\n":
                i += 1
            continue
        if c == "/" and i + 1 < n and src[i + 1] == "*":
            j = src.find("*/", i + 2)
            i = n if j < 0 else j + 2
            continue
        out.append(c)
        i += 1
    return "".join(out)


def main():
    with open(SRC, encoding="utf-8") as f:
        src = f.read()

    before = len(src)

    # 1) 注释（字符串里的 // 不会被切）
    src = strip_comments(src)

    # 2) 空行 + 缩进
    out = []
    for ln in src.split("\n"):
        t = ln.strip()
        if not t:
            continue
        out.append(t)
    src = "\n".join(out)

    # 3) 连续空格压成一个（字符串里没有故意留双空格的）
    src = re.sub(r"[ \t]{2,}", " ", src)

    # 4) 动作关键词 -> 运行时解码
    for kw in ACTIONS:
        needle = "action: '%s'" % kw
        if needle in src:
            src = src.replace(needle, "action:_x('%s')" % enc(kw))

    # 4b) localStorage 的 key 也编码（保持值不变，只是不在源码里明文出现账号名）
    src = src.replace("const NAME_KEY = 'danaiwa.name';",
                      "const NAME_KEY = _x('%s');" % enc("danaiwa.name"))

    # 5) 标识符短名
    for a, b in RENAME:
        src = re.sub(r"\b%s\b" % re.escape(a), b, src)

    with open(DST, "w", encoding="utf-8", newline="\n") as f:
        f.write(src + "\n")

    after = os.path.getsize(DST)
    print("leaderboard.js     %d B" % before)
    print("leaderboard.min.js %d B  (压到 %.0f%%)" % (after, after * 100.0 / before))
    leak = []
    for kw in ("purgeOver", "cycleTick", "searchAll", "searchRecent", "CNT_TAG",
               "CYCLE", "stampOf",
               "SECRET", "USER", "API", "danaiwa", "wz5", "8847", "20000",
               "tinywebdb", "6f52518c", "榜首", "删除",
               "'search'", "'update'", "'delete'", "'get'"):
        if kw in src:
            leak.append(kw)
    print("明文残留: %s" % (", ".join(leak) if leak else "无"))


if __name__ == "__main__":
    main()
