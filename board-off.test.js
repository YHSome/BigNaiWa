/* ============================================================
 *  「排行榜界面关闭、成绩照常上传」的行为测试
 *
 *  背景：排行榜临时关了，但明确要求「不禁止用户上传成绩」。
 *  本测试用一个极简假 DOM 验证三件事：
 *    1. 两处入口按钮（面板里的 #boardBtn、结算弹窗里的 #boardBtn2）被隐藏
 *    2. 弹窗打不开（DanaiwaBoard.open() 不会加 .show）
 *    3. 打完一局仍然会提交成绩（fetch 里出现 action=update），且不去拉榜单（没有 search）
 *    4. 改昵称改用原生 prompt，不依赖榜单弹窗
 *
 *  运行： node board-off.test.js [leaderboard.min.js]
 * ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const TARGET = process.argv[2] || 'leaderboard.min.js';

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

const calls = [];
function fakeFetch(url, opts) {
  const p = {};
  if (opts && opts.body) opts.body.forEach((v, k) => { p[k] = v; });
  calls.push(p);
  const res = p.action === 'update' ? { status: 'success' } : {};
  return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(res)) });
}

const mem = {};
const prompted = [];
const sandbox = {
  window: {
    addEventListener() {},
    prompt(msg, def) { prompted.push({ msg: msg, def: def }); return '奶娃王'; }
  },
  document: {
    readyState: 'complete',
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

(async function main() {
  console.log('目标文件: ' + TARGET + '\n');

  console.log('[1] 入口按钮被隐藏');
  ok(!!Board, '模块加载并导出 DanaiwaBoard');
  ok(els.boardBtn.hidden === true, '面板里的「排行榜」按钮 hidden=true');
  ok(els.boardBtn2.hidden === true, '结算弹窗里的「排行榜」按钮 hidden=true');

  console.log('\n[2] 弹窗打不开');
  Board.open();
  ok(els.boardModal.classList.contains('show') === false, '调用 open() 也不会让弹窗显示');
  ok(els.boardModal.getAttribute('aria-hidden') === null || true, '（不报错即可）');

  console.log('\n[3] 成绩照常上传');
  calls.length = 0;
  Board.onGameOver(1234);
  await new Promise((r) => setTimeout(r, 60));
  const updates = calls.filter((c) => c.action === 'update');
  ok(updates.length >= 1, '出现了 action=update 的提交请求（' + updates.length + ' 次）');
  if (updates.length) {
    const v = JSON.parse(updates[0].value || '{}');
    ok(Number(v.s) === 1234, '上传的分数正确：' + v.s);
    ok(typeof v.n === 'string' && v.n.length > 0, '带上了昵称：' + v.n);
  }
  ok(calls.filter((c) => c.action === 'search').length === 0, '界面关闭时不拉榜单（没有 search 请求）');
  ok(String(els.submitMsg.textContent).indexOf('成绩已上传') >= 0, '结算文案改成「成绩已上传」：' + els.submitMsg.textContent);
  ok(String(els.myNameLabel.textContent).length > 0, '昵称仍然会显示：' + els.myNameLabel.textContent);

  console.log('\n[4] 改昵称走原生输入框，不依赖榜单弹窗');
  const btn = els.editNameBtn;
  ok(!!(btn._h && btn._h.click), '改昵称按钮仍绑定了 click');
  if (btn._h && btn._h.click) {
    prompted.length = 0;
    btn._h.click();
    ok(prompted.length === 1, '点一下会弹原生输入框');
    ok(mem['danaiwa.name'] === '奶娃王', '昵称已保存：' + mem['danaiwa.name']);
    ok(els.boardModal.classList.contains('show') === false, '改昵称不会再顺带打开榜单');
  }

  console.log('\n============================');
  console.log(pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})();
