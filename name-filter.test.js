/* ============================================================
 *  排行榜：界面恢复 + 昵称屏蔽词（命中就不上榜） 行为测试
 *
 *  规则：
 *    · 排行榜界面正常（两处入口都在、弹窗能开关）
 *    · 昵称含屏蔽词（含"隔字"写法、繁体变体）→ **成绩不上榜**（一条都不写库），
 *      但分数留着，改好昵称后点「重试提交」还能补上榜
 *    · 榜单里已有的历史脏昵称，展示时显示成「默认用户」
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
const store = new Map();
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
    res = {};
    [...store.keys()].reverse().forEach((k) => { res[k] = store.get(k); });
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
const msg = () => String(els.submitMsg.textContent);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function boardNames() {
  const out = [];
  (els.boardList.children || []).forEach((row) => {
    (row.children || []).forEach((c) => { if (c.className === 'board-name') out.push(c.textContent); });
  });
  return out;
}

(async function main() {
  console.log('目标文件: ' + TARGET + '\n');

  console.log('[1] 排行榜界面正常');
  ok(!!Board, '模块加载并导出 DanaiwaBoard');
  ok(els.boardBtn.hidden === false, '面板里的「排行榜」按钮可见');
  ok(els.boardBtn2.hidden === false, '结算弹窗里的「排行榜」按钮可见');
  Board.open();
  ok(els.boardModal.classList.contains('show') === true, 'open() 能打开弹窗');
  Board.close();
  ok(els.boardModal.classList.contains('show') === false, 'close() 能关掉');

  console.log('\n[2] 屏蔽词识别（名字保留，惩罚在提交那一步）');
  const banned = [
    ['蒋介石', '用户给的例子 2'],
    ['蔣介石', '繁体'],
    ['蒋x介x石', '隔字：蒋…介…石'],
    ['蒋·介·石', '隔字：符号分隔'],
    ['习1近', '隔字：数字夹在中间'],
    ['習 近 平', '繁体 + 空格'],
    ['傻X逼', '隔字：辱骂词'],
    ['你！妈', '隔字：中文感叹号'],
    ['ＦＵＣＫ', '全角英文脏话'],
    ['加 微 信', '导流词插空格'],
    ['台 独', '敏感词插空格']
  ];
  banned.forEach(([raw, why]) => {
    Board.setName(raw);
    ok(savedName() === raw, '「' + raw + '」（' + why + '）识别为屏蔽词（名字保留）');
  });
  ok(msg().indexOf('不会上榜') >= 0, '给玩家的提示是「不会上榜」：' + msg());

  console.log('\n[2.5] 跨度超限不算命中（避免无限宽松）');
  Board.setName('习一二三四近');
  ok(savedName() === '习一二三四近', '「习一二三四近」隔了 5 个字，超出跨度上限 → 放行');

  console.log('\n[3] 正常昵称不受影响');
  ['奶娃王', '练习', '葡萄子', '小明', 'jjs', '柠檬精'].forEach((raw) => {
    Board.setName(raw);
    ok(savedName() === raw, '「' + raw + '」原样保留');
  });

  console.log('\n[4] 命中屏蔽词 → 本局不上榜');
  Board.setName('蒋介石');
  calls.length = 0;
  Board.onGameOver(1234);
  await wait(120);
  ok(calls.filter((c) => c.action === 'update').length === 0, '没有发出任何提交请求');
  ok(msg().indexOf('不上榜') >= 0, '提示「本局成绩不上榜」：' + msg());
  ok(els.submitBtn.hidden === false, '「重试提交」按钮出现（改好昵称还能补）');
  ok(store.size === 0, '后端库里没有任何新增记录（store.size=' + store.size + '）');

  console.log('\n[4.5] 改好昵称后点「重试提交」→ 补上榜');
  Board.setName('奶娃王');
  calls.length = 0;
  if (els.submitBtn._h && els.submitBtn._h.click) els.submitBtn._h.click();
  await wait(200);
  const fixed = calls.filter((c) => c.action === 'update');
  ok(fixed.length === 1, '补提交了一次（' + fixed.length + '）');
  if (fixed.length) {
    const v = JSON.parse(fixed[0].value || '{}');
    ok(v.n === '奶娃王', '用的是改好的昵称：' + v.n);
    ok(Number(v.s) === 1234, '补上的还是本局那 1234 分：' + v.s);
  }
  ok(store.size >= 1, '后端库里已经有一条记录（' + store.size + '）');

  console.log('\n[5] 榜单里已有的历史脏昵称，展示时显示「默认用户」');
  const key = 'dnw_test_' + Date.now().toString(36);
  store.set(key, JSON.stringify({ n: '蒋介石', s: 9999, t: Date.now() }));
  store.set(key + 'b', JSON.stringify({ n: '奶娃王', s: 8888, t: Date.now() + 1 }));
  Board.open();
  await wait(200);
  const names = boardNames();
  ok(names.indexOf('奶娃王') >= 0, '正常昵称照常显示：' + JSON.stringify(names));
  ok(names.indexOf('蒋介石') < 0, '脏昵称不出现在榜单里');
  ok(names.indexOf(DEFAULT_NAME) >= 0, '脏昵称显示成「默认用户」：' + JSON.stringify(names));

  console.log('\n============================');
  console.log(pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})();
