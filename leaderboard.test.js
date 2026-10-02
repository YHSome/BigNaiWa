/* ============================================================
 *  排行榜规则自检（无浏览器，vm 桩件 + 假的 TinyWebDB）
 *  运行：node leaderboard.test.js
 *
 *  覆盖：
 *    1. 老格式记录（没有回放）一律不算数
 *    2. 时间戳拨到未来的记录被无视（老榜就是这么被打穿的）
 *    3. 同一份回放重复提交只算一条
 *    4. 分数排序 + 「验出来是假的」沉底
 *    5. 真提交走的是带回放的 value
 *    6. 验证队列：跑得出来的 → ✅，跑不出来的 → ❌
 *    7. 本地存档：一局打完就存、指纹去重、封顶 10 局、
 *       验证结论回写（没通过的也照样留着，可以重放）
 * ============================================================ */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const root = __dirname;

/* ---------- 桩件 ---------- */
function makeCtx() {
  const g = { addColorStop() {} };
  return {
    setTransform() {}, save() {}, restore() {}, scale() {}, rotate() {}, translate() {},
    clearRect() {}, fillRect() {}, beginPath() {}, closePath() {}, moveTo() {}, lineTo() {},
    arc() {}, ellipse() {}, clip() {}, stroke() {}, fill() {}, setLineDash() {}, drawImage() {},
    createLinearGradient: () => g, createRadialGradient: () => g,
    measureText: () => ({ width: 10 }), fillText() {}, strokeText() {},
    globalAlpha: 1, fillStyle: '', strokeStyle: '', lineWidth: 1,
    font: '', textAlign: '', textBaseline: '', lineCap: ''
  };
}
const listeners = new Map();
function makeEl(id) {
  const el = {
    id, style: {}, textContent: '', value: '', hidden: false, width: 680, height: 160,
    _c: new Set(), children: [],
    classList: {
      add: c => el._c.add(c), remove: c => el._c.delete(c), contains: c => el._c.has(c)
    },
    getContext: () => el._ctx || (el._ctx = makeCtx()),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 420, height: 700 }),
    addEventListener(t, fn) {
      if (!listeners.has(el)) listeners.set(el, {});
      listeners.get(el)[t] = fn;
    },
    appendChild(c) { el.children.push(c); return c; },
    querySelector() { return { textContent: '', classList: { add() {}, remove() {} } }; },
    setAttribute() {}, focus() {}, blur() {}, select() {}, offsetWidth: 100
  };
  /* 真浏览器里 className / textContent 和内部子节点是联动的，桩件要自己同步：
     设成空字符串的 textContent 会把子节点全清掉（DOM 规范如此）。 */
  let _text = '';
  Object.defineProperty(el, 'className', {
    get() { return Array.from(el._c).join(' '); },
    set(v) { el._c = new Set(String(v).split(/\s+/).filter(Boolean)); },
    configurable: true
  });
  Object.defineProperty(el, 'textContent', {
    get() { return _text; },
    set(v) { _text = String(v); if (_text === '') el.children.length = 0; },
    configurable: true
  });
  return el;
}
const els = {};
['game', 'stage', 'overlay', 'score', 'best', 'finalScore', 'finalBest', 'next', 'chain',
 'soundBtn', 'resetBtn', 'restartBtn', 'boardList', 'boardModal', 'submitMsg', 'nickInput',
 'myNameLabel', 'submitBtn', 'submitBox', 'boardBtn', 'boardBtn2', 'boardClose',
 'boardRefresh', 'editNameBtn'].forEach(id => els[id] = makeEl(id));

/* ---------- 假的 TinyWebDB ---------- */
const db = {};
const fetchLog = [];
function fakeFetch(url, opts) {
  const params = opts && opts.body ? opts.body : new URLSearchParams();
  const obj = {};
  for (const [k, v] of params) obj[k] = v;
  fetchLog.push(obj);

  if (obj.action === 'update') { db[obj.tag] = obj.value; }
  const out = {};
  if (obj.action === 'search') {
    for (const k in db) if (k.indexOf(obj.tag) === 0) out[k] = db[k];
  }
  return Promise.resolve({
    ok: true, status: 200,
    text: () => Promise.resolve(JSON.stringify(out))
  });
}

const sandbox = {
  console, Math, Date, JSON, Object, Array, Number, String, Boolean, Error, isNaN,
  Promise, URLSearchParams, setTimeout, clearTimeout, isFinite, parseInt, parseFloat,
  performance: { now: () => Date.now() },
  requestAnimationFrame(fn) { return 1; },
  fetch: fakeFetch,
  document: {
    readyState: 'complete', activeElement: null,
    getElementById: id => els[id] || null,
    addEventListener() {}, createElement: id => makeEl(id || 'tmp')
  },
  localStorage: {
    _d: {},
    getItem(k) { return Object.prototype.hasOwnProperty.call(this._d, k) ? this._d[k] : null; },
    setItem(k, v) { this._d[k] = String(v); }
  },
  addEventListener() {}, navigator: {},
  Image: class { set src(v) { if (this.onload) this.onload(); } get src() { return ''; } }
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

function load(f) {
  vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), sandbox, { filename: f });
}
load('assets/fruits/parts.js');
load('sim.js');
load('game.js');
load('leaderboard.js');

const Sim = sandbox.SUIKA_SIM;
const Board = sandbox.DanaiwaBoard;

let pass = true;
function check(name, ok, detail) {
  console.log((ok ? '  [OK] ' : '  [NG] ') + name + (detail ? '  -- ' + detail : ''));
  if (!ok) pass = false;
}

/* ---------- 打几局，拿到真实回放 ---------- */
function playGame(seed) {
  const sim = Sim.create(seed);
  let n = 0;
  for (let i = 0; i < 60 * 400 && !sim.state.over; i++) {
    if (sim.state.ready) {
      sim.moveAim(70 + ((n * 97) % 280));
      sim.tryDrop();
      n++;
    }
    sim.update();
  }
  if (!sim.state.over) throw new Error('这一局没打完');
  return sim.replay();
}

console.log('[0] 打三局拿真实回放（每局几秒）');
const g1 = playGame(1001);
const g2 = playGame(2002);
const g3 = playGame(3003);
const now = Date.now();
console.log('      ' + [g1, g2, g3].map(g => g.score + '分/' + g.inputs.length + '投').join('，'));

const enc1 = Sim.encode(g1), enc2 = Sim.encode(g2), enc3 = Sim.encode(g3);

/* ---------- 构造数据 ---------- */
db['dnw2_honest1'] = JSON.stringify({ n: '老实人甲', s: g1.score, t: now, r: enc1 });
db['dnw2_honest2'] = JSON.stringify({ n: '老实人乙', s: g2.score, t: now - 5000, r: enc2 });
/* 作弊 A：JSON 里的分数比回放算出来的高 —— 应该在「对不上」这关被丢掉 */
db['dnw2_mismatch'] = JSON.stringify({ n: '假分数', s: g1.score + 8000, t: now, r: enc1 });
/* 作弊 B：回放和分数自洽（都写 g3+8000），但重跑模拟根本打不出这个分 —— 只能靠验证抓住 */
db['dnw2_fake'] = JSON.stringify({
  n: '我是榜一',
  s: g3.score + 8000,
  t: now,
  r: Sim.encode({ v: 2, seed: g3.seed, end: g3.end, score: g3.score + 8000, inputs: g3.inputs })
});
/* 老格式：直接写个数字，没有回放 */
db['dnw2_legacy']  = JSON.stringify({ n: '老版刷分', s: 99999999, t: now });
/* 时间戳拨到未来：老榜的 pin 手法 */
db['dnw2_future']  = JSON.stringify({ n: '未来人', s: 99999999, t: now + 10 * 365 * 86400000, r: enc2 });
/* 同一份回放再提交一次（更早的时间戳）→ 该被去重掉 */
db['dnw2_dup']     = JSON.stringify({ n: '复制怪', s: g1.score, t: now - 90000, r: enc1 });

console.log('[1] 读榜 + 过滤规则');
let meta = null;
Board.fetchTop()
  .then(res => { meta = res; return Board.refresh(null); })
  .then(list => run(list))
  .catch(e => { console.log('  [NG] 读榜抛异常：' + (e && e.stack || e)); process.exit(1); });

function run(list) {
  const names = list.map(r => r.name);
  const d = meta.dropped;
  console.log('      入榜：' + names.join('、'));
  console.log('      丢弃：时间戳 ' + d.time + ' / 无回放 ' + d.noreplay +
    ' / 分数对不上 ' + d.mismatch + ' / 重复 ' + d.dup + ' / 分数不合法 ' + d.score);

  check('带回放的两条老实成绩进榜',
    names.indexOf('老实人甲') >= 0 && names.indexOf('老实人乙') >= 0);
  check('老格式记录（没有回放）被丢掉', names.indexOf('老版刷分') < 0 && d.noreplay === 1,
    'noreplay=' + d.noreplay);
  check('真回放 + 假分数（s 和回放对不上）被丢掉',
    names.indexOf('假分数') < 0 && d.mismatch === 1, 'mismatch=' + d.mismatch);
  check('时间戳在未来的记录被丢掉', names.indexOf('未来人') < 0 && d.time === 1,
    't 拨到 10 年后照样不算，time=' + d.time);
  check('同一份回放只留一条', names.filter(n => n === '老实人甲').length === 1 && d.dup === 1,
    '提交了 2 次 → 入榜 ' + names.filter(n => n === '老实人甲').length + ' 条，dup=' + d.dup);
  check('重复的那条不算新纪录', !list.some(r => r.name === '复制怪'));
  check('作弊记录先按分数排在最前',
    list.length > 0 && list[0].name === '我是榜一',
    list.length > 0 ? ('声称 ' + list[0].score + ' 分') : '榜是空的');

  /* ---------- 提交：value 里必须有回放 ---------- */
  console.log('[2] 提交格式');
  const before = Object.keys(db).length;
  return Board.submitScore('测试提交', g1).then(() => {
    const tags = Object.keys(db);
    const added = tags.filter(t => db[t] && db[t].indexOf('测试提交') >= 0);
    check('真的写进去了', added.length > 0, '写入 ' + (tags.length - before) + ' 条');
    const rec = added.length ? JSON.parse(db[added[0]]) : {};
    check('value 里带整局回放', typeof rec.r === 'string' && rec.r.indexOf('v2;') === 0,
      'r 长度 ' + (rec.r ? rec.r.length : 0) + ' 字符');
    check('分数写的是回放算出来的那个', rec.s === g1.score, 's=' + rec.s);

    /* ---------- 验证队列 ---------- */
    console.log('[3] 验证（Worker 不可用时走主线程兜底）');
    return waitForVerify(list);
  });
}

function waitForVerify(list, tries) {
  tries = tries || 0;
  const pending = list.filter(r => r.status === 'pending').length;
  if (pending > 0 && tries < 400) {
    return new Promise(r => setTimeout(r, 100)).then(() => waitForVerify(list, tries + 1));
  }
  const byName = {};
  list.forEach(r => byName[r.name] = r);
  console.log('      ' + list.map(r => r.name + '=' + r.status).join('，'));

  check('验证队列跑完了', pending === 0, '还剩 ' + pending + ' 条待验');
  check('老实成绩验出来是 ✅',
    byName['老实人甲'] && byName['老实人甲'].status === 'ok',
    byName['老实人甲'] && byName['老实人甲'].reason);
  check('声称 8000 分的假成绩验出来是 ❌',
    byName['我是榜一'] && byName['我是榜一'].status === 'bad',
    byName['我是榜一'] && byName['我是榜一'].reason);

  /* 沉底发生在渲染阶段（paintRows 的 sortedRows），所以去看 DOM */
  const dom = els.boardList.children
    .filter(c => c.classList && c.classList.contains('board-row'))
    .map(c => (c.children[1] && c.children[1].textContent) || '');
  const first = dom[0], last = dom[dom.length - 1];
  check('验出来的假成绩被排到榜底', last === '我是榜一',
    '渲染顺序：' + dom.join('、'));
  check('榜首是验过的真成绩', first === '老实人乙' || first === '老实人甲', '第一行 = ' + first);

  const fakeRow = els.boardList.children
    .filter(c => c.classList && c.classList.contains('board-row'))
    .filter(c => c.children[1] && c.children[1].textContent === '我是榜一')[0];
  check('假成绩那行标了 ❌ 并划掉',
    !!fakeRow && fakeRow.classList.contains('is-fake') &&
    !!fakeRow.children[3] && fakeRow.children[3].textContent === '❌',
    fakeRow ? ('badge=' + fakeRow.children[3].textContent) : '没找到那行');

  /* ---------- 榜上每行的 ▶ ---------- */
  console.log('[3b] 榜单行的重放按钮');
  const rowEls = els.boardList.children
    .filter(c => c.classList && c.classList.contains('board-row'));
  const withPlay = rowEls.filter(c => c.children
    .some(ch => ch.classList && ch.classList.contains('board-play')));
  check('榜上每一行都带▶（进了榜就一定有回放）',
    rowEls.length > 0 && withPlay.length === rowEls.length,
    withPlay.length + '/' + rowEls.length + ' 行有▶');

  const fakeBtn = fakeRow && fakeRow.children
    .filter(ch => ch.classList && ch.classList.contains('board-play'))[0];
  check('❌ 那行也有▶，而且更该能点', !!fakeBtn);
  if (fakeBtn) {
    const handler = listeners.get(fakeBtn) && listeners.get(fakeBtn).click;
    const DNW = sandbox.__DNW__;
    const live = DNW.sim.state;
    if (handler) handler({ stopPropagation() { } });
    check('点❌那行的▶能真的开播（没通过校验照样能看）',
      DNW.mode === 'play' && DNW.state !== live, 'mode=' + DNW.mode);
    DNW.stopReplay();
    check('看完能退出，state 切回自己那局', DNW.mode === 'game' && DNW.state === live,
      'mode=' + DNW.mode);
  }

  /* ---------- [4] 本地存档（重放按钮的数据源） ---------- */
  return testSaves().then(function () {
    console.log(pass ? '\n排行榜规则自检通过' : '\n排行榜规则自检未通过');
    process.exit(pass ? 0 : 1);
  }, function (e) {
    console.log('  [NG] 存档自检抛异常：' + (e && e.stack || e));
    process.exit(1);
  });
}

/* ---------- [4] 本地存档 ---------- */
function synth(seed, score) {
  return { v: 2, seed: seed, end: 3600, score: score, inputs: [] };
}
function findSave(score) {
  const list = Board.saves();
  for (let i = 0; i < list.length; i++) {
    if (Number(list[i].score) === Number(score)) return list[i];
  }
  return null;
}

function testSaves() {
  console.log('[4] 本地存档（重放按钮的数据源）');
  const start = Board.saveCount();

  Board.onGameOver(500, synth(424242, 500));
  check('一局打完就落一条存档（和提交成不成无关）',
    Board.saveCount() === start + 1, start + ' → ' + Board.saveCount());

  const raw = JSON.parse(sandbox.localStorage._d['danaiwa.saves.v1'] || '[]');
  check('存的是能重放的回放字符串',
    raw.length > 0 && typeof raw[0].r === 'string' && !!Sim.decode(raw[0].r),
    raw.length ? ('r = ' + raw[0].r.slice(0, 22) + '…') : '存档是空的');

  Board.onGameOver(999999, synth(424242, 999999));
  check('同一份回放只留一条（指纹去掉了分数段，换分数也没用）',
    Board.saveCount() === start + 1, '存档数 = ' + Board.saveCount());

  for (let i = 0; i < 14; i++) Board.onGameOver(1000 + i, synth(7000 + i, 1000 + i));
  check('最多留 10 局', Board.saveCount() === 10, '存档数 = ' + Board.saveCount());
  check('最新的排在最前', Board.saveAt(0) && Board.saveAt(0).score === 1013,
    Board.saveAt(0) ? ('第一条 = ' + Board.saveAt(0).score + ' 分') : '空');

  /* 真实的两局：一局验过、一局验不过 —— 结论要能写回存档 */
  Board.onGameOver(g1.score, g1);
  Board.onGameOver(g3.score + 8000, {
    v: 2, seed: g3.seed, end: g3.end, score: g3.score + 8000, inputs: g3.inputs
  });
  check('新局挤掉最旧的，真局照样进得来',
    Board.saveCount() === 10 && !!findSave(g1.score) && !findSave(1000),
    'g1 在=' + !!findSave(g1.score) + '，最旧的 1000 在=' + !!findSave(1000));

  /* 重读一次榜 → 验证结论要回写到同一份存档上 */
  return Board.refresh(null).then(function () {
    const okSave = findSave(g1.score);
    check('通过验证的存档被标成 ✅', !!okSave && okSave.status === 'ok',
      okSave ? ('status=' + okSave.status + (okSave.reason ? '（' + okSave.reason + '）' : '')) : '没这条存档');

    const badSave = findSave(g3.score + 8000);
    check('没通过验证的存档被标成 ❌，而且照样留着',
      !!badSave && badSave.status === 'bad',
      badSave ? ('status=' + badSave.status + '，' + badSave.reason) : '没这条存档');

    check('存档里的回放始终能解析（= 随时能重放）',
      Board.saves().every(s => !!Sim.decode(s.r)),
      Board.saveCount() + ' 条全部可解析');
  });
}
