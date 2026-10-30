/* ============================================================
 *  leaderboard.js / leaderboard.min.js 行为测试
 *  用一个内存版 TinyWebDB 顶掉 fetch（模拟真机行为：按提交时间倒序返回、no 为行偏移），验证：
 *    · 榜单 = 最近 WINDOW 次提交，更早的成绩哪怕分再高也不出现
 *    · 窗口内按分数排名
 *    · 全程零删除、零写入，只有 search
 *    · 只会请求 SCAN_PAGES 页
 *    · 兼容老格式 tag（中段是毫秒十进制）
 *  运行： node leaderboard.test.js [leaderboard.min.js]
 * ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const TARGET = process.argv[2] || 'leaderboard.min.js';

let store = new Map();   // 插入顺序 = 提交顺序
let calls = [];

function fakeFetch(url, opts) {
  const p = {};
  (opts && opts.body).forEach((v, k) => { p[k] = v; });
  calls.push(p);

  const action = p.action, tag = p.tag;
  let res;

  if (action === 'update') {
    store.set(tag, p.value);
    res = { status: 'success' };
  } else if (action === 'delete') {
    store.delete(tag);
    res = { status: 'success' };
  } else if (action === 'get') {
    res = {};
    res[tag] = store.has(tag) ? store.get(tag) : 'null';
  } else if (action === 'search') {
    const no = parseInt(p.no || '1', 10);
    const cnt = parseInt(p.count || '100', 10);
    // 真机行为：最新提交排在最前，no 是 1 起的行偏移
    const keys = [...store.keys()].reverse().filter((k) => k.indexOf(tag) === 0);
    res = {};
    keys.slice(no - 1, no - 1 + cnt).forEach((k) => { res[k] = store.get(k); });
  } else {
    throw new Error('未知 action: ' + action + '（编码/解码对不上？）');
  }

  return Promise.resolve({
    ok: true, status: 200,
    text: () => Promise.resolve(JSON.stringify(res))
  });
}

const doc = {
  readyState: 'complete', activeElement: null,
  getElementById: () => null,
  createElement: () => ({ style: {}, classList: { add() {} }, appendChild() {} }),
  addEventListener() {}
};
const mem = {};
const sandbox = {
  window: { addEventListener() {} },
  document: doc,
  localStorage: {
    getItem: (k) => (k in mem ? mem[k] : null),
    setItem: (k, v) => { mem[k] = String(v); },
    removeItem: (k) => { delete mem[k]; }
  },
  fetch: fakeFetch,
  URLSearchParams, setTimeout, clearTimeout, console
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, 'v1', TARGET), 'utf8'), sandbox, { filename: TARGET });

const Board = sandbox.window.DanaiwaBoard;
if (!Board) { console.error('FAIL: 没有导出 DanaiwaBoard'); process.exit(1); }

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra ? '  → ' + extra : '')); }
}
function eq(a, b, label) { ok(a === b, label, 'got ' + JSON.stringify(a) + ' want ' + JSON.stringify(b)); }

const b36 = (n) => n.toString(36);
const T0 = 1790650000000;                 // 基准时间
function seed(name, score, i, opts) {
  opts = opts || {};
  const t = opts.t || (T0 + i * 1000);
  const mid = opts.rawMid || b36(t);
  const tag = 'dnw_' + mid + '_' + i.toString(36);
  const val = opts.noT ? JSON.stringify({ n: name, s: score })
                       : JSON.stringify({ n: name, s: score, t: t });
  store.set(tag, val);
  return tag;
}

(async function main() {
  console.log('目标文件: ' + TARGET + '\n');

  /* 最旧的 10 条给超大分数，最新的 20 条给普通分数 —— 高分的旧记录必须消失 */
  const oldTags = [];
  for (let i = 0; i < 10; i++) oldTags.push(seed('老古董' + i, 50000 + i, i));
  const newTags = [];
  for (let i = 0; i < 20; i++) newTags.push(seed('新玩家' + i, 1000 + i * 10, 10 + i));

  console.log('[1] 窗口 = 最近 20 次提交');
  const rows = await Board.fetchTop();
  eq(rows.length, 20, '榜单 20 条');
  ok(!rows.some((r) => r.score >= 50000), '早于窗口的 5 万分记录全都不出现');
  ok(rows.every((r) => r.name.indexOf('新玩家') === 0), '出现的全是最近这 20 条');
  eq(rows[0].score, 1190, '窗口内第一名 = 最新一批里分最高的 1190');
  eq(rows[19].score, 1000, '最后一名 = 1000');
  ok(rows.every((r, i) => i === 0 || rows[i - 1].score >= r.score), '窗口内按分数从高到低');

  console.log('\n[2] 全程只读，不做任何删除/写入');
  const acts = calls.map((c) => c.action);
  eq(acts.filter((a) => a === 'search').length, 2, '一共 2 次 search（SCAN_PAGES=2）');
  eq(acts.filter((a) => a === 'delete').length, 0, '0 次 delete');
  eq(acts.filter((a) => a === 'update').length, 0, '0 次 update');
  eq(acts.filter((a) => a === 'get').length, 0, '0 次 get');

  console.log('\n[3] 新提交会把老成绩挤出窗口');
  seed('刚来的', 7777, 999);
  const rows2 = await Board.fetchTop();
  eq(rows2.length, 20, '仍然是 20 条');
  ok(rows2.some((r) => r.name === '刚来的'), '新提交在榜上');
  ok(!rows2.some((r) => r.name === '新玩家0' && r.score === 1000), '最老的那条被挤出窗口');
  eq(rows2[0].name, '刚来的', '7777 分排到窗口内第一');

  console.log('\n[4] 兼容老格式 tag（中段是毫秒十进制，且记录里没有 t 字段）');
  store.clear();
  seed('旧格式', 456, 0, { rawMid: '1790656995859', noT: true });
  seed('新格式', 123, 1, { t: 1790656995859 + 60000 });
  const rows3 = await Board.fetchTop();
  eq(rows3.length, 2, '两条都在窗口里');
  eq(rows3[0].name, '旧格式', '时间戳解析出来了，排序没有乱（456 分排前）');

  console.log('\n[5] 空库');
  store.clear();
  const rows4 = await Board.fetchTop();
  eq(rows4.length, 0, '空库返回空数组，不报错');

  console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})();
