/* ============================================================
 *  回放验证自检（无浏览器，用桩件模拟 DOM/Canvas）
 *  运行：node replay.test.js
 *
 *  覆盖：
 *    1. 真实打完一局 → 拿到回放 → 重跑一遍分数完全一致
 *    2. 编解码往返不丢信息
 *    3. 各种伪造手法全部被拒（改分数 / 改落点 / 改种子 / 截断 / 老格式 / 灌未来时间）
 *    4. 同一份回放跑两次结果一样（确定性）
 *    5. 播放器（存档的「重放」按钮用）：逐帧推进、不污染存档、
 *       声称分数是假的也照样能播完 —— 没通过校验的存档照样能看
 *    6. 回放外壳（game.js 的播放模式）：进得去、出得来、
 *       播放中动不了你手上那一局、播到判负也不会重复触发 onGameOver
 *    7. 用了复活币的局照样能验证：复活按 tick 记进回放，
 *       抹掉 / 多插一次都过不了
 * ============================================================ */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const root = __dirname;

function makeCtx(id) {
  const g = { addColorStop() {} };
  return {
    _id: id,
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
    id, style: {}, textContent: '', width: 680, height: 160, _c: new Set(),
    classList: { add: c => el._c.add(c), remove: c => el._c.delete(c), contains: c => el._c.has(c) },
    getContext: () => el._ctx || (el._ctx = makeCtx(id)),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 420, height: 700 }),
    addEventListener(t, fn) { if (!listeners.has(el)) listeners.set(el, {}); listeners.get(el)[t] = fn; },
    querySelector(sel) {
      if (!el._q) el._q = {};
      if (!el._q[sel]) el._q[sel] = { textContent: '', style: {}, classList: { add() {}, remove() {} } };
      return el._q[sel];
    },
    setAttribute() {}, offsetWidth: 100
  };
  return el;
}
const els = {};
['game', 'stage', 'overlay', 'score', 'best', 'finalScore', 'finalBest',
 'next', 'chain', 'soundBtn', 'resetBtn', 'restartBtn'].forEach(id => els[id] = makeEl(id));

const rafQueue = [];
const winListeners = {};
const sandbox = {
  console, Math, Date, JSON, Object, Array, Number, String, Boolean, Error, isNaN,
  performance: { now: () => Date.now() },
  requestAnimationFrame(fn) { rafQueue.push(fn); return 1; },
  setTimeout: fn => setTimeout(fn, 0), clearTimeout,
  document: {
    readyState: 'complete', getElementById: id => els[id] || null,
    addEventListener() {}, createElement: () => makeEl('tmp')
  },
  localStorage: { _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = String(v); } },
  addEventListener(t, fn) { winListeners[t] = fn; },
  navigator: {},
  Image: class {
    constructor() { this.width = 512; this.height = 512; this.onload = null; this.onerror = null; }
    set src(v) { this._src = v; if (this.onload) this.onload(); }
    get src() { return this._src; }
  }
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

function load(name) {
  vm.runInContext(fs.readFileSync(path.join(root, name), 'utf8'), sandbox, { filename: name });
}
load('assets/fruits/parts.js');
load('sim.js');
load('game.js');

const Sim = sandbox.SUIKA_SIM;
const U = sandbox.__DNW__;
const S = U.state;

/* 排行榜拿到的东西就在这里 */
const submitted = { score: 0, replay: null };
sandbox.DanaiwaBoard = {
  onGameOver(score, replay) { submitted.score = score; submitted.replay = replay; }
};

let pass = true;
function check(name, ok, detail) {
  console.log((ok ? '  [OK] ' : '  [NG] ') + name + (detail ? '  -- ' + detail : ''));
  if (!ok) pass = false;
}

let clock = Date.now();
function pump(frames) {
  for (let f = 0; f < frames; f++) {
    clock += 16.7;
    const q = rafQueue.splice(0, rafQueue.length);
    for (const fn of q) fn(clock);
  }
}

/* ---- 1. 老老实实打完一局 ---- */
console.log('[1] 打完一局，拿到回放');
const down = listeners.get(els.stage).pointerdown;
U.reset();
pump(5);

let seq = 0;
function aim() {                                  // 固定套路，保证这一步本身可复现
  seq++;
  const r = (seq * 0.6180339887) % 1;
  return 60 + r * 300;
}

let drops = 0;
for (let i = 0; i < 4000 && !submitted.replay; i++) {
  if (S.over) break;
  if (S.ready) {
    down({ clientX: aim(), clientY: 120, pointerType: 'mouse' });
    drops++;
  }
  pump(10);
}
pump(600);

check('真的打到判负（拿到回放）', !!submitted.replay, submitted.replay ? '' : '没触发 onGameOver');
if (!submitted.replay) { console.log('\n失败'); process.exit(1); }

const rep = submitted.replay;
console.log('      分数 ' + submitted.score + '，投放 ' + rep.inputs.length +
  ' 次，时长 ' + rep.end + ' tick（' + (rep.end / 60).toFixed(1) + ' 秒）');
check('分数来自模拟本身', rep.score === submitted.score && rep.score > 0, 'score=' + rep.score);
check('回放里记录了投放', rep.inputs.length === drops,
  '回放 ' + rep.inputs.length + ' 次 / 实际投 ' + drops + ' 次');
check('回放的 tick 数 = 模拟结束时的 tick', rep.end === S.tick,
  'end=' + rep.end + ' tick=' + S.tick);

/* ---- 2. 编解码往返 ---- */
console.log('[2] 编解码往返');
const enc = Sim.encode(rep);
console.log('      编码后 ' + enc.length + ' 字符');
const dec = Sim.decode(enc);
check('解出来和原来一样', JSON.stringify(dec) === JSON.stringify({
  v: 2, seed: rep.seed, end: rep.end, score: rep.score, inputs: rep.inputs,
  revives: rep.revives || []
}), '编码长度 ' + enc.length + ' 字符');

/* ---- 3. 重跑一遍：分数必须完全一致 ---- */
console.log('[3] 重放验证');
let t0 = Date.now();
const r1 = Sim.verify(enc);
const cost = Date.now() - t0;
check('回放能复现出同一个分数', r1.ok && r1.score === rep.score,
  r1.ok ? 'score=' + r1.score + '，验证耗时 ' + cost + ' ms' : '原因：' + r1.reason);

t0 = Date.now();
const r2 = Sim.verify(enc);
check('同一份回放跑两次结果一致', r2.ok && r2.score === r1.score && (Date.now() - t0) >= 0);

/* ---- 4. 伪造手法 ---- */
console.log('[4] 伪造全部要被拒');
function reject(label, payload, expectReason) {
  const r = Sim.verify(payload);
  check(label, !r.ok, r.ok ? '居然通过了！' : '已拒绝（' + r.reason + '）');
}

/* 4a 老排行榜那种：直接写个数字 */
reject('直接写分数（旧格式 {n,s,t}）',
  JSON.stringify({ n: '我是榜一', s: 99999999, t: Date.now() }));

/* 4b 声称的分数比重放算出来的大 */
reject('把回放里的分数改大',
  enc.replace(';' + rep.score + ';', ';99999999;'));

/* 4c 只改落点 */
{
  const parts = enc.split(';');
  const body = parts[4].split(',');
  const first = body[0].split(':');
  body[0] = first[0] + ':' + (parseInt(first[1], 36) + 7).toString(36);
  reject('篡改落点', parts.slice(0, 4).concat(body.join(',')).join(';'));
}

/* 4d 改种子（同样的操作，不同的出球顺序，分数对不上） */
reject('篡改随机种子', enc.replace('v2;' + rep.seed.toString(36) + ';', 'v2;deadbeef;'));

/* 4e 截断回放。
   注意这里分两件事：
   - 砍掉一半投放 → 一定被拒（球少了一半，分数和结束 tick 必然对不上）；
   - 只砍最后 3 次 → 60% 被拒，剩下 40% 会通过 —— 但那不是漏洞：被判负之前那
     几次投放本来就没起任何作用，剩下的这段仍然是一个真实能跑出来的对局，
     重跑出来的分数和声称的一模一样。关键性质是下面这条：截断**不可能**把分数顶高。 */
{
  const half = enc.split(',').slice(0, Math.max(1, Math.floor(rep.inputs.length / 2))).join(',');
  reject('截断回放（砍掉一半投放）', half);

  const cut = enc.split(',').slice(0, Math.max(1, rep.inputs.length - 3)).join(',');
  const r = Sim.verify(cut);
  check('截断不会把分数顶高', !r.ok || r.score <= rep.score,
    r.ok ? '通过了，但分数没变（' + r.score + '）—— 被删的投放本来就没起作用'
        : '已拒绝（' + r.reason + '）');
}

/* 4f 老排行榜的时间戳把戏：把 t 拨到未来就能永久霸占窗口。
   新规则里时间戳根本不参与验证 —— 照样得把分数跑出来，跑不出来就是不对。 */
reject('时间戳玩花招也救不了假分数', {
  v: 2, seed: rep.seed, end: rep.end, score: 99999999,
  t: Date.now() + 1e12, inputs: rep.inputs
});

/* 4g 冷却没走完就连投 */
{
  const tight = Object.assign({}, rep, {
    inputs: rep.inputs.map((it, i) => ({ t: Math.round(i * 3), x: it.x })).slice(0, 40),
    end: Math.round(rep.inputs.length * 3) + 60
  });
  reject('冷却没走完就连投', Sim.encode(tight));
}

/* ---- 5. 顺带确认老工具打不出东西来了 ---- */
console.log('[5] 旧攻击在新规则下');
check('没有回放就上不了榜', !Sim.verify(JSON.stringify({ n: 'x', s: 1, t: 1 })).ok);
check('空回放会被拒', !Sim.verify('').ok);
check('超长回放会被拒（防拖垮验证者）', !Sim.verify('v2;1;' + (Sim.MAX_TICKS + 1).toString(36) + ';1;').ok);

/* ---- 6. 播放器：存档的「重放」按钮就靠它 ---- */
console.log('[6] 播放器（存档回放）');

/* 6a 逐帧推进：每次 step 正好走 1 tick，播完的分数和 tick 就是回放声称的那个 */
{
  const p = Sim.makePlayer(enc);
  let steps = 0, jump = false, prev = p.tick;
  while (p.step()) {
    steps++;
    if (p.tick !== prev + 1) jump = true;
    prev = p.tick;
    if (steps > Sim.MAX_TICKS) break;
  }
  check('播放器能逐帧走完整局', p.done && !p.error, p.error || ('播了 ' + steps + ' 帧'));
  check('每次 step() 正好推进 1 tick', !jump, jump ? '有跳帧' : '共 ' + steps + ' 帧，每帧 +1');
  check('播完的分数 = 回放声称的分数', p.score === rep.score, p.score + ' vs ' + rep.score);
  check('播完的 tick = 回放声称的时长', p.tick === rep.end, p.tick + ' vs ' + rep.end);
}

/* 6b 播放不能污染存档：injectDrop 本来就不写 inputs，这里盯死 */
{
  const p = Sim.makePlayer(enc);
  while (p.step()) { /* 播完 */ }
  check('播放不写 inputs（存档播几遍都不会被自己改掉）',
    p.state.inputs.length === 0, 'inputs 长度 = ' + p.state.inputs.length);
}

/* 6c 也不许改动传进来的回放对象（上传页传进来的可能是同一个对象） */
{
  const rep2 = Sim.decode(enc);
  const snapshot = JSON.stringify(rep2);
  const p = Sim.makePlayer(rep2);
  while (p.step()) { /* 播完 */ }
  check('播放不改动传进来的回放对象',
    JSON.stringify(rep2) === snapshot, '前 ' + JSON.stringify(rep2).length + ' 字符未变');
}

/* 6d 没通过校验的照样能播 —— 这正是「没过校验也能看」要的性质。
   （「verify 判它不过」上面 4b 已经验过，这里只管播放器。） */
{
  const lied = { v: 2, seed: rep.seed, end: rep.end, score: 99999999, inputs: rep.inputs };
  const p = Sim.makePlayer(lied);
  while (p.step()) { /* 播完 */ }
  check('声称分数是假的也照样能播完，给出真实分数',
    p.done && !p.error && p.score === rep.score,
    '跑出 ' + p.score + ' 分，声称 ' + p.claimed + ' 分');
}

/* 6e 播两遍结果一致 */
{
  const a = Sim.makePlayer(enc), b = Sim.makePlayer(enc);
  while (a.step()) { /* 播完 */ }
  while (b.step()) { /* 播完 */ }
  check('同一份回放播两遍结果一致',
    a.score === b.score && a.tick === b.tick && a.consumed === b.consumed,
    a.score + '/' + a.tick + ' vs ' + b.score + '/' + b.tick);
}

/* 6f 坏回放：直接报错、done、step 返回 false（不会卡在那儿空转） */
{
  const bad = Sim.makePlayer('');
  check('空回放直接报错并且不动', bad.error === '回放格式不对' && bad.done && bad.step() === false,
    'error=' + bad.error);
  const bad2 = Sim.makePlayer(JSON.stringify({ n: 'x', s: 1, t: 1 }));
  check('老格式记录不能播', !!bad2.error && bad2.done, 'error=' + bad2.error);
}

/* ---- 7. 回放外壳：game.js 里的「播放模式」 ---- */
console.log('[7] 回放外壳（播放模式）');
{
  /* 先开一局新的，模拟「打到一半想去看别人的回放」 */
  U.reset();
  pump(5);
  const live = U.sim.state;
  const snap = {
    tick: live.tick, score: live.score, balls: live.balls.length,
    inputs: live.inputs.length, aimX: live.aimX
  };
  const sub0 = { score: submitted.score, replay: submitted.replay };

  check('外壳入口都在',
    typeof U.playReplay === 'function' && typeof U.stopReplay === 'function');

  const ok = U.playReplay(enc, {
    source: 'save', index: 0, title: '本地存档',
    claimed: rep.score, status: 'bad', reason: '分数对不上'
  });
  check('能开播', ok === true && U.mode === 'play', 'mode=' + U.mode);
  check('开播后 state 指向回放那一份模拟', U.state !== live);
  check('开播时把结算框收起来', !els.overlay.classList.contains('show'));

  /* 播放中乱按乱点，都必须打不到你手上这一局 ——
     tryDrop/moveAim 走的是 sim（live 那一份），护栏少一道就会污染存档前的那一局 */
  down({ clientX: 200, clientY: 80, pointerType: 'mouse' });
  listeners.get(els.stage).pointermove({ clientX: 350, clientY: 80, pointerType: 'mouse' });
  check('播放中按鼠标不会投进你那局', live.inputs.length === snap.inputs,
    'inputs ' + snap.inputs + ' → ' + live.inputs.length);
  check('播放中拖动不会动你那局的准星', live.aimX === snap.aimX,
    'aimX ' + snap.aimX + ' → ' + live.aimX);

  /* 4 倍速把整局看完（真事件自带 preventDefault，桩件里补一个） */
  const kd = winListeners.keydown;
  const key = (code) => ({ code, preventDefault() { } });
  kd(key('ArrowRight'));
  kd(key('ArrowRight'));
  check('→ 能调倍速', U.playSpeed === 4, 'playSpeed=' + U.playSpeed);

  kd(key('Space'));
  const pausedAt = U.player.tick;
  pump(12);
  check('空格能暂停', U.player.tick === pausedAt, 'tick=' + U.player.tick);
  kd(key('Space'));
  pump(40);
  check('再按一下继续走', U.player.tick > pausedAt, pausedAt + ' → ' + U.player.tick);

  /* 播到这局判负为止 —— 那一刻要是没拦住，就会再走一遍 onGameOver：
     弹结算框 + 把这局回放再提交一次 */
  pump(Math.ceil(rep.end / 4) + 240);
  check('整局能播完', !!(U.player && U.player.done),
    U.player ? (U.player.error || ('tick=' + U.player.tick + '/' + U.player.end)) : '播放器没了');
  check('播到判负不会自己弹结算框', !els.overlay.classList.contains('show'));
  check('更不会把这局回放再提交一次',
    submitted.replay === sub0.replay && submitted.score === sub0.score,
    'submitted 还是原来那条');

  check('播放全程你手上那一局一帧都没动',
    live.tick === snap.tick && live.score === snap.score &&
    live.balls.length === snap.balls && live.inputs.length === snap.inputs,
    'tick ' + snap.tick + '→' + live.tick +
    '，balls ' + snap.balls + '→' + live.balls.length +
    '，inputs ' + snap.inputs + '→' + live.inputs.length);

  kd(key('Escape'));
  check('Esc 能退出回放', U.mode === 'game' && U.state === live, 'mode=' + U.mode);

  /* 退出来游戏是活的：这一下得真投出去 */
  const before2 = live.inputs.length;
  down({ clientX: 210, clientY: 80, pointerType: 'mouse' });
  check('退出回放后又能正常投放', live.inputs.length === before2 + 1,
    'inputs ' + before2 + ' → ' + live.inputs.length);

  /* 结算页上点▶：遮罩要记得收起、退出来要记得还回去 */
  els.overlay.classList.add('show');
  const ok2 = U.playReplay(enc, { source: 'save', index: 0, title: '结算页' });
  check('结算页上也能开播（遮罩顺手收起来）',
    ok2 === true && !els.overlay.classList.contains('show'));
  U.stopReplay();
  check('退出回放把结算框还回来', els.overlay.classList.contains('show'));

  check('坏回放开不了播',
    U.playReplay('', {}) === false && U.mode === 'game', 'mode=' + U.mode);
}

/* ============================================================
 * [8] 用了复活币的局也必须能验证通过
 *
 *  复活是玩家的选择、会改掉棋盘（清掉线上的水果、解除判负），
 *  所以它必须像投放一样按 tick 记进回放 —— 不记，重放到第一次判负
 *  就停了，后面那些投放根本投不进去；多记，凭空多出来的清场就是作弊。
 *
 *  这里用固定种子 43 + 固定打法：这一路会**自然**打到 2042 分，
 *  正好跨过 2000 发一枚复活币 —— 分数是合并出来的，回放才能复现。
 * ============================================================ */
console.log('[8] 用了复活币的局照样能验证');
{
  const s = Sim.create(43);

  /* 傻瓜打法：有同级的就往它头上落（低处优先），否则找最平的地方，
     再加一点抖动免得每次都落在同一个点上。纯函数，回放里也会这么走。 */
  function botX(n) {
    const pend = s.state.pending;
    let hit = null, hitY = -Infinity;
    for (const b of s.state.balls) {
      if (b.dead) continue;
      if (b.tier === pend && b.y > hitY) { hit = b; hitY = b.y; }
    }
    let x;
    if (hit && hitY > 320) {
      x = Math.max(60, Math.min(360, hit.x));   // 先夹回场内，再抖
    } else {
      x = 210;
      let bh = Infinity;
      for (let c = 60; c <= 360; c += 15) {
        let h = 0;
        for (const b of s.state.balls) {
          if (b.dead) continue;
          if (Math.abs(b.x - c) < b.r + 8) h = Math.max(h, b.y - b.r);
        }
        if (h < bh) { bh = h; x = c; }
      }
    }
    return Math.max(60, Math.min(360, x + ((n * 0.6180339887) % 1 - 0.5) * 40));
  }

  function playToOver() {
    let n = 0;
    while (!s.state.over && n++ < 90000) {
      if (s.state.ready) { s.moveAim(botX(n)); s.tryDrop(); }
      s.update();
    }
    return s.state.over;
  }

  playToOver();
  const scoreAtOver = s.state.score;
  const overTick = s.state.tick;
  check('打到判负', overTick > 0, 'tick=' + overTick + ' 分数 ' + scoreAtOver);
  check('分数是合并出来的、自然跨过 2000 → 手上有一枚复活币',
    scoreAtOver >= 2000 && s.state.revives === 1,
    'score=' + scoreAtOver + ' revives=' + s.state.revives);

  check('判负后能用掉那枚币', s.revive() === true && !s.state.over && s.state.revives === 0,
    'over=' + s.state.over + ' revives=' + s.state.revives);
  check('没币了再调一次就没了', s.revive() === false, '');

  playToOver();
  const rep2 = s.replay();
  check('复活之后又接着打到判负', rep2.end > overTick && rep2.score > scoreAtOver,
    'tick ' + overTick + ' → ' + rep2.end + '，分数 ' + scoreAtOver + ' → ' + rep2.score);
  check('复活的 tick 记进了回放',
    rep2.revives.length === 1 && rep2.revives[0] === overTick,
    JSON.stringify(rep2.revives) + '（判负在 ' + overTick + '）');

  const enc2 = Sim.encode(rep2);
  const dec2 = Sim.decode(enc2);
  check('编解码把复活时刻原样带回来',
    JSON.stringify(dec2.revives) === JSON.stringify(rep2.revives) &&
    dec2.inputs.length === rep2.inputs.length,
    JSON.stringify(dec2.revives) + '，投放 ' + dec2.inputs.length + ' 次');

  const v = Sim.verify(enc2);
  check('带复活的回放能验证通过',
    v.ok === true && v.score === rep2.score,
    v.ok ? v.score + ' 分' : v.reason);

  /* 反过来两条：少记、多记都必须被拒 */
  const noRev = Sim.verify(Sim.encode({
    v: 2, seed: rep2.seed, end: rep2.end, score: rep2.score, inputs: rep2.inputs
  }));
  check('抹掉复活记录就对不上（所以非记不可）', noRev.ok === false, noRev.reason);

  const fakeRev = Sim.verify(Sim.encode({
    v: 2, seed: rep2.seed, end: rep2.end, score: rep2.score, inputs: rep2.inputs,
    revives: [rep2.revives[0], rep2.revives[0] + 1]
  }));
  check('凭空多插一次复活会被拒', fakeRev.ok === false, fakeRev.reason);

  /* 老记录（第 5 段之后什么都没有）照旧解得开：这局就算没复活过 */
  const old = Sim.decode(enc2.split(';').slice(0, 5).join(';'));
  check('没有复活段的老记录照样能解', !!old && old.revives.length === 0,
    'revives=' + JSON.stringify(old && old.revives));
}

console.log(pass ? '\n回放验证自检通过' : '\n回放验证自检未通过');
process.exit(pass ? 0 : 1);
