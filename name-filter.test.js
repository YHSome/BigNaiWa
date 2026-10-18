/* ============================================================
 *  排行榜：界面恢复 + 昵称屏蔽词 行为测试
 *
 *  需求：
 *    · 排行榜界面恢复（两处入口按钮都在、弹窗能打开）
 *    · 昵称含屏蔽词时，自动改成「默认用户」——提交时、改昵称时、
 *      以及榜单里已有的历史脏昵称，都要过滤
 *    · 正常昵称不受影响（例如「练习」里的「习」不该被误伤）
 *
 *  运行： node name-filter.test.js [leaderboard.min.js]
 * ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const TARGET = process.argv[2] || 'leaderboard.min.js';
const DEFAULT_NAME = '默认用户';

/* ---------- 极简 DOM ---------- */
function makeEl(id, tag) {
  const cls = new Set();
  const el = {
    id: id, tagName: String(tag || 'div').toUpperCase(),
    hidden: false, value: '', textContent: '', className: '',
    style: {}, children: [],
    classList: {
      add: (c) => cls.add(c),
      remove: (c) => cls.delete(c),
      contains: (c) => cls.has(c)
    },
    setAttribute() {}, removeAttribute() {}, getAttribute() { return null; },
    appendChild(c) { el.children.push(c); return c; },
    addEventListener(t, f) { (el._h || (el._h = {}))[t] = f; },
    focus() {}, blur() {}, select() {}
  };
  return el;
}

const IDS = ['boardBtn', 'boardBtn2', 'boardModal', 'boardClose', 'boardRefresh', 'boardList',
             'nickInput', 'submitBox', 'submitMsg', 'myNameLabel', 'submitBtn', 'editNameBtn'];
const els = {};
IDS.forEach((id) => { els[id] = makeEl(id); });

/* ---------- 假后端（内存版 TinyWebDB） ---------- */
const store = new Map();          // tag -> value JSON 字符串（插入顺序 = 提交顺序）
const calls = [];
function fakeFetch(url, opts) {
  const p = {};
  if (opts && opts.body) opts.body.forEach((v, k) => { p[k] = v; });
  calls.push(p);
  let res = {};
  if (p.action === 'update') {
    store.set(p.tag, p.value);
    res = { status: 'success' };
  } else if (p.action === 'delete') {
    store.delete(p.tag);
    res = { status: 'success' };
  } else if (p.action === 'search') {
    const keys = [...store.keys()].reverse();
    keys.forEach((k) => { res[k] = store.get(k); });
  }
  return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(res)) });
}

const mem = {};
const sandbox = {
  window: { addEventListener() {}, prompt() { return null; } },
  document: {
    readyState: 'complete', activeElement: null,
    getElementById: (id) => els[id] || null,
    createElement: (tag) => makeEl('', tag),
    addEventListener() {}
  },
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
let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra ? '  → ' + extra : '')); }
}
const savedName = () => mem['danaiwa.name'];

/* 从榜单 DOM 里收集所有昵称文字 */
function boardNames() {
  const out = [];
  (els.boardList.children || []).forEach((row) => {
    (row.children || []).forEach((c) => { if (c.className === 'board-name') out.push(c.textContent); });
  });
  return out;
}

(async function main() {
  console.log('目标文件: ' + TARGET + '\n');

  console.log('[1] 排行榜界面已恢复');
  ok(!!Board, '模块加载并导出 DanaiwaBoard');
  ok(els.boardBtn.hidden === false, '面板里的「排行榜」按钮可见');
  ok(els.boardBtn2.hidden === false, '结算弹窗里的「排行榜」按钮可见');
  Board.open();
  ok(els.boardModal.classList.contains('show') === true, 'open() 能打开弹窗');
  Board.close();
  ok(els.boardModal.classList.contains('show') === false, 'close() 能关掉');

  console.log('\n[2] 屏蔽词：一律变成「默认用户」');
  const banned = [
    ['习近', '用户给的例子 1'],
    ['习近平', '完整名字'],
    ['蒋介石', '用户给的例子 2'],
    ['习 近', '插空格'],
    ['习·近平', '插符号'],
    ['ＦＵＣＫ', '全角英文脏话'],
    ['傻 逼', '辱骂词插空格'],
    ['你妈', '辱骂词'],
    ['FUCK you', '英文脏话（大小写/空格）'],
    ['加微信123', '导流词']
  ];
  banned.forEach(([raw, why]) => {
    Board.setName(raw);
    ok(savedName() === DEFAULT_NAME, '「' + raw + '」（' + why + '）→ ' + savedName());
  });

  console.log('\n[3] 正常昵称不受影响');
  ['奶娃王', '练习', '葡萄子', '小明', 'jjs'].forEach((raw) => {
    Board.setName(raw);
    ok(savedName() === raw, '「' + raw + '」原样保留 → ' + savedName());
  });

  console.log('\n[4] 提交成绩时用的是清洗后的昵称');
  /* 绕过 setName，直接往本地塞一个脏昵称（模拟老数据 / 手改 localStorage） */
  mem['danaiwa.name'] = '蒋介石';
  calls.length = 0;
  Board.onGameOver(1234);
  await new Promise((r) => setTimeout(r, 80));
  const updates = calls.filter((c) => c.action === 'update');
  ok(updates.length >= 1, '仍然会上传成绩（' + updates.length + ' 次 update）');
  if (updates.length) {
    const v = JSON.parse(updates[0].value || '{}');
    ok(v.n === DEFAULT_NAME, '上传的昵称已被替换：' + v.n);
    ok(Number(v.s) === 1234, '分数没被动：' + v.s);
  }
  ok(String(els.myNameLabel.textContent) === DEFAULT_NAME, '界面上的昵称也显示为：' + els.myNameLabel.textContent);

  console.log('\n[5] 榜单里已有的脏昵称在展示时也被过滤');
  Board.setName('奶娃王');
  const key = 'dnw_test_' + Date.now().toString(36);
  store.set(key, JSON.stringify({ n: '蒋介石', s: 9999, t: Date.now() }));
  store.set(key + 'b', JSON.stringify({ n: '奶娃王', s: 8888, t: Date.now() + 1 }));
  Board.open();
  await new Promise((r) => setTimeout(r, 120));
  const names = boardNames();
  ok(names.indexOf('奶娃王') >= 0, '正常昵称照常显示：' + JSON.stringify(names));
  ok(names.indexOf('蒋介石') < 0, '脏昵称没有出现在榜单里');
  ok(names.indexOf(DEFAULT_NAME) >= 0, '脏昵称被显示成「默认用户」：' + JSON.stringify(names));

  console.log('\n============================');
  console.log(pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})();
