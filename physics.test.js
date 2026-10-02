/* ============================================================
 *  物理手感自检（无浏览器，用桩件模拟 DOM/Canvas）
 *  运行：node physics.test.js
 *  覆盖：回弹高度、球对球弹起、堆叠稳定性、真实投放不穿墙
 * ============================================================ */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const root = __dirname;

/* 记录每个画布上 drawImage 了哪张图，用来验证“下一个”预览画的是哪一级 */
const drawnImages = [];

function makeCtx(id) {
  const g = { addColorStop() {} };
  return {
    _id: id,
    setTransform() {}, save() {}, restore() {}, scale() {}, rotate() {}, translate() {},
    clearRect() {}, fillRect() {}, beginPath() {}, closePath() {}, moveTo() {}, lineTo() {},
    arc() {}, ellipse() {}, clip() {}, stroke() {}, fill() {}, setLineDash() {},
    drawImage(img) { drawnImages.push({ ctx: this._id, src: (img && img.__src) || null }); },
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
  /* 桩件图片：设了 src 就立刻“加载完成”，用来覆盖贴图绘制分支 */
  Image: class {
    constructor() { this.width = 512; this.height = 512; this.naturalWidth = 512; this.onload = null; this.onerror = null; }
    set src(v) { this._src = v; this.__src = v; if (this.onload) this.onload(); }
    get src() { return this._src; }
  }
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(root, 'assets', 'fruits', 'parts.js'), 'utf8'),
                sandbox, { filename: 'parts.js' });
vm.runInContext(fs.readFileSync(path.join(root, 'sim.js'), 'utf8'),
                sandbox, { filename: 'sim.js' });
vm.runInContext(fs.readFileSync(path.join(root, 'game.js'), 'utf8'), sandbox, { filename: 'game.js' });

const H = 700, W = 420, WALL = 10, R = [17, 23, 31, 39, 48, 58, 69, 81, 94, 108, 124];
const S = sandbox.__DNW__.state;
const U = sandbox.__DNW__;
const step = sandbox.__DNW__.stepPhysics;
const DT = 1 / 180;

function ball(x, tier, y) {
  const r = R[tier];
  const b = U.makeBall(x, y === undefined ? 700 - WALL - r : y, tier);
  b.landed = true;
  b.bornAt = 0;
  return b;
}
function run(n) { for (let i = 0; i < n; i++) step(DT); }
function clear() { S.balls.length = 0; }

/* 碰撞形状是若干小圆，越界检查得看这些小圆的实际范围 */
function bounds(b) {
  let minx = 1e9, maxx = -1e9, miny = 1e9, maxy = -1e9;
  for (let k = 0; k < b.parts.length; k++) {
    const x = b.wx[k], y = b.wy[k], r = b.ws[k];
    if (x - r < minx) minx = x - r;
    if (x + r > maxx) maxx = x + r;
    if (y - r < miny) miny = y - r;
    if (y + r > maxy) maxy = y + r;
  }
  return { minx: minx, maxx: maxx, miny: miny, maxy: maxy };
}
/* 越界检查。
   floorTol 是地板方向的容差：
     运动中   —— 位置约束求解需要一两帧才能把撞击瞬间的重叠解开，
                  实测最深会出现约 8px 的暂态穿地，但落定后必然回到 0.00px，
                  所以运动中放宽一点，别把"暂态"误判成"沉下去"；
     静止以后 —— 用严格容差，这时再穿就是真问题。
   左右墙不参与放宽：水果飞出场地属于硬故障。 */
function outOfBounds(b, floorTol) {
  const ft = floorTol === undefined ? 1.5 : floorTol;
  if (!isFinite(b.x) || !isFinite(b.y) || !isFinite(b.vx)) return 'NaN';
  const e = bounds(b);
  if (e.maxy > H - WALL + ft) return 'floor maxy=' + e.maxy.toFixed(1) +
    ' tier=' + b.tier + ' y=' + b.y.toFixed(1) + ' r=' + b.r + ' vy=' + b.vy.toFixed(1);
  if (e.minx < WALL - 1.5) return 'left minx=' + e.minx.toFixed(1) + ' tier=' + b.tier;
  if (e.maxx > W - WALL + 1.5) return 'right maxx=' + e.maxx.toFixed(1) + ' tier=' + b.tier;
  return '';
}

let pass = true;
function check(name, ok, detail) {
  console.log((ok ? '  [OK] ' : '  [NG] ') + name + (detail ? '  -- ' + detail : ''));
  if (!ok) pass = false;
}

/* ---- 1. 落地球的自由回弹高度 ---- */
console.log('[1] 单个水果(猕猴桃 r=48) 从 y=100 落到地面');
clear();
S.balls.push(ball(210, 4, 100));
const floorY = H - WALL - R[4];
let reversed = false, apex = 1e9, bounces = 0, lastVy = 0;
for (let i = 0; i < 180 * 8; i++) {
  step(DT);
  const b = S.balls[0];
  if (lastVy > 0 && b.vy < 0) bounces++;
  lastVy = b.vy;
  if (b.vy < -1) { reversed = true; apex = Math.min(apex, b.y); }
}
const rebound = reversed ? floorY - apex : 0;
check('发生多次回弹（Q 弹）', bounces >= 2, '回弹次数 = ' + bounces);
check('首次回弹高度 > 40px', rebound > 40, '回弹高度 = ' + rebound.toFixed(1) + 'px');
check('最终静止（不抖）', Math.abs(S.balls[0].vy) < 20, 'vy = ' + S.balls[0].vy.toFixed(2));

/* ---- 2. 球对球回弹（不同级别） ---- */
console.log('[2] 橘子(r=31) 砸向静止的椰子(r=94)');
clear();
S.balls.push(ball(210, 8, 700 - WALL - R[8]));
S.balls.push(ball(210, 2, 180));
let hitUp = 0;
for (let i = 0; i < 180 * 6; i++) {
  step(DT);
  if (S.balls[1] && S.balls[1].vy < -30) hitUp++;
}
check('上方水果被弹起', hitUp > 3, '向上速度帧数 = ' + hitUp);

/* ---- 3. 堆叠稳定性（不抖、不漂、无 NaN） ---- */
console.log('[3] 6 颗不同大小的水果堆 12 秒');
clear();
[[60, 0], [300, 0], [120, 3], [260, 3], [180, 6], [190, 1]].forEach(function (p, i) {
  S.balls.push(ball(p[0], p[1], 620 - i * 5));
});
run(180 * 12);
const snap = S.balls.map(b => ({ x: b.x, y: b.y }));
let maxV = 0, bad = '';
for (const b of S.balls) {
  maxV = Math.max(maxV, Math.hypot(b.vx, b.vy));
  const o = outOfBounds(b);
  if (o) bad = o;
}
run(180);
let drift = 0;
S.balls.forEach((b, i) => { drift = Math.max(drift, Math.hypot(b.x - snap[i].x, b.y - snap[i].y)); });
check('数值健康（无 NaN / 无穿墙）', !bad, bad || '');
check('残余速度小', maxV < 45, 'max |v| = ' + maxV.toFixed(1) + ' px/s');
check('1 秒内位移 < 6px', drift < 6, 'drift = ' + drift.toFixed(2) + 'px');

/* 形状碰撞的硬指标：静止后任意两个水果的轮廓圆之间不应该有明显穿透 */
let deepest = 0;
for (let i = 0; i < S.balls.length; i++) {
  for (let j = i + 1; j < S.balls.length; j++) {
    const a = S.balls[i], b = S.balls[j];
    for (let m = 0; m < a.parts.length; m++) {
      for (let k = 0; k < b.parts.length; k++) {
        const dx = b.wx[k] - a.wx[m], dy = b.wy[k] - a.wy[m];
        const sum = a.ws[m] + b.ws[k];
        const d = Math.hypot(dx, dy);
        if (sum - d > deepest) deepest = sum - d;
      }
    }
  }
}
check('静止后无互相穿透（形状碰撞生效）', deepest < 2.5, '最深穿透 = ' + deepest.toFixed(2) + 'px');

/* ---- 4. 真实投放 60 次：走完整的 update/渲染循环 ---- */
console.log('[4] 自动投放 60 次');
clear();
els.score.textContent = '0';
let t = Date.now();
function pump(frames) {
  for (let f = 0; f < frames; f++) {
    t += 16.7;
    const q = rafQueue.splice(0, rafQueue.length);
    for (const fn of q) fn(t);
  }
}
const down = listeners.get(els.stage).pointerdown;
let seed = 7;
function nx() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return 0.15 + (seed % 1000) / 1000 * 0.7; }
let escaped = '';
let worstPen = 0, worstTier = -1;
for (let i = 0; i < 60; i++) {
  down({ clientX: nx() * W, clientY: 120, pointerType: 'mouse' });
  pump(30);
  for (const b of S.balls) {
    const pen = bounds(b).maxy - (H - WALL);
    if (pen > worstPen) { worstPen = pen; worstTier = b.tier; }
    if (!escaped) escaped = outOfBounds(b, 12);      // 运动中：允许一两帧的暂态重叠
  }
}
pump(600);
/* 落定之后再量一次：这里必须严格，静止了还穿就是真沉下去了 */
let settledBad = '';
for (const b of S.balls) if (!settledBad) settledBad = outOfBounds(b, 0.5);
check('60 次投放无水果穿墙/飞出（运动中）', !escaped, escaped || ('剩余球数 = ' + S.balls.length));
check('全部落定后无穿地（静止严格）', !settledBad, settledBad || '最深处 0.0px');
console.log('  诊断: 过程中最深穿地 ' + worstPen.toFixed(2) + 'px (tier ' + worstTier +
            ')，落定后 0.00px 才算正常');
check('有合成得分', Number(els.score.textContent) > 0,
  '得分 = ' + els.score.textContent + '（最高分 ' + els.best.textContent + '）');

/* ---- 5. 触屏交互：拖动瞄准、松手投放 ---- */
console.log('[5] 触屏：拖动瞄准、松手投放');
sandbox.__DNW__.reset();
pump(30);
const L = listeners.get(els.stage);
const n0 = S.balls.length;

L.pointerdown({ clientX: 100, clientY: 400, pointerType: 'touch', pointerId: 1 });
check('按下的瞬间不投放', S.balls.length === n0, '球数 = ' + S.balls.length);

L.pointermove({ clientX: 250, clientY: 400, pointerType: 'touch' });
check('拖动实时更新落点', Math.abs(S.aimX - 250) < 1.5, 'aimX = ' + S.aimX.toFixed(1));

L.pointerup({ clientX: 250, clientY: 400, pointerType: 'touch' });
check('松手才投放', S.balls.length === n0 + 1, '球数 = ' + S.balls.length);

/* 鼠标仍然是“按下即投”，保持桌面手感 */
pump(30);                       // 等投放冷却走完
const n1 = S.balls.length;
L.pointerdown({ clientX: 300, clientY: 400, pointerType: 'mouse' });
check('鼠标按下即投放', S.balls.length === n1 + 1, '球数 = ' + S.balls.length);

/* ---- 6. 键盘：结束后空格不再重开，输入框里不抢按键 ---- */
console.log('[6] 键盘行为');
sandbox.__DNW__.reset();
pump(30);
const kd = winListeners.keydown;
const body = { tagName: 'BODY' };
const input = { tagName: 'INPUT' };
const noPrevent = { preventDefault() {} };

/* 局内：空格投放 */
S.balls.length = 0;
S.ready = true;
kd({ code: 'Space', target: body, preventDefault() {} });
check('局内空格能投放', S.balls.length === 1, '球数 = ' + S.balls.length);

/* 输入框里打字：空格不该投放 */
pump(30);
const nInput = S.balls.length;
kd({ code: 'Space', target: input, preventDefault() {} });
check('输入框里空格不投放', S.balls.length === nInput, '球数 = ' + S.balls.length);

/* 结束后：空格不再重开 */
S.over = true;
const nOver = S.balls.length;
kd({ code: 'Space', target: body, preventDefault: noPrevent.preventDefault });
check('结束后空格不重开', S.over === true && S.balls.length === nOver,
  'over=' + S.over + ' 球数=' + S.balls.length);
kd({ code: 'Enter', target: body, preventDefault: noPrevent.preventDefault });
check('结束后回车也不重开', S.over === true && S.balls.length === nOver,
  'over=' + S.over + ' 球数=' + S.balls.length);

/* R 仍然能重开 */
kd({ code: 'KeyR', target: body, preventDefault() {} });
check('R 键仍可重开', S.over === false && S.balls.length === 0,
  'over=' + S.over + ' 球数=' + S.balls.length);

/* ---- 7. 判负规则：只有「卡在线上方且基本停住」才计时 ---- */
console.log('[7] 判负规则');
const DANGER_Y = 142;
const UP_Y = 130;          // 顶在线上方的位置
const DOWN_Y = 400;        // 线下方

function hold(b, y, vy) { b.y = y; b.py = y; b.vy = vy || 0; b.vx = 0; b.landed = true; }
function freshGame() { sandbox.__DNW__.reset(); pump(2); S.balls.length = 0; S.over = false; }

/* 7a：线上方 + 基本静止 → 约 1.5 秒判负 */
freshGame();
const a7 = U.makeBall(210, UP_Y, 0);
hold(a7, UP_Y, 0);
S.balls.push(a7);
let fA = 0;
while (!S.over && fA < 240) { hold(a7, UP_Y, 0); pump(1); fA++; }
check('卡在线上方 1.5 秒会判负', S.over === true,
  '用时 ' + (fA / 60).toFixed(2) + ' 秒');

/* 7b：线上方但高速飞过 → 不判负 */
freshGame();
const b7 = U.makeBall(210, UP_Y, 0);
hold(b7, UP_Y, 0);
S.balls.push(b7);
let fB = 0;
while (!S.over && fB < 300) { hold(b7, UP_Y, 800); pump(1); fB++; }   // 一直“在飞”
check('高速飞过线上方不判负', S.over === false,
  '线上方挂了 ' + (fB / 60).toFixed(2) + ' 秒，overTime=' + b7.overTime.toFixed(2));

/* 7c：两只轮流卡在线上方 → 计时不共享，不判负 */
freshGame();
const c1 = U.makeBall(120, UP_Y, 0), c2 = U.makeBall(300, UP_Y, 0);
hold(c1, DOWN_Y); hold(c2, DOWN_Y);
S.balls.push(c1, c2);
let fC = 0, aboveC = 0;
const stint = Math.round(1.2 * 60);      // 每只连续停 1.2 秒（< 1.5）
while (!S.over && fC < 900) {
  const who = Math.floor(fC / stint) % 2;
  hold(c1, who === 0 ? UP_Y : DOWN_Y);
  hold(c2, who === 1 ? UP_Y : DOWN_Y);
  if (who === 0 || who === 1) aboveC += 1;
  pump(1); fC++;
}
check('两只轮流不算在一起', S.over === false,
  '墙上合计线上方 ' + (aboveC / 60).toFixed(1) + ' 秒，各自 overTime=' +
  c1.overTime.toFixed(2) + '/' + c2.overTime.toFixed(2));

/* ---- 8. 界面：棋盘右上角画的是不是「下一个」 ---- */
console.log('[8] 下一个预览');
freshGame();
S.pending = 0;          // 当前这颗（准星位置画的就是它）
S.next = 5;             // 下一个
S.ready = true;
drawnImages.length = 0;
pump(1);
const gameDraws = drawnImages.filter((d) => d.ctx === 'game');
const lastDraw = gameDraws[gameDraws.length - 1];
const expectNext = U.FRUITS[5].file;
const expectPending = U.FRUITS[0].file;
check('右上角预览 = 下一个（不是当前这颗）',
  !!lastDraw && lastDraw.src === expectNext,
  '画的是 ' + (lastDraw && lastDraw.src ? lastDraw.src.split('/').pop() : '(无)'));
check('准星位置画的是当前这颗',
  gameDraws.some((d) => d.src === expectPending),
  '当前 ' + expectPending.split('/').pop());

/* 冷却中（ready=false）准星也得画，否则棋盘上只剩右上角那颗，容易被当成当前 */
S.pending = 7;
S.next = 3;
S.ready = false;
drawnImages.length = 0;
pump(1);
const inCooldown = drawnImages.filter((d) => d.ctx === 'game');
check('冷却期间准星仍然画着当前这颗',
  inCooldown.some((d) => d.src === U.FRUITS[7].file),
  '把 pending 设成 tier7，本帧绘制 ' + inCooldown.length + ' 张');

/* 连续投放 120 次，「下一个」永远不等于当前 */
freshGame();
let sameCount = 0, watched = 0;
const down8 = listeners.get(els.stage).pointerdown;
for (let i = 0; i < 120; i++) {
  if (S.over) { U.reset(); pump(5); }
  down8({ clientX: 210, clientY: 120, pointerType: 'mouse' });
  watched++;
  if (S.next === S.pending) sameCount++;
  pump(30);
}
check('「下一个」从不等于当前这颗', sameCount === 0,
  watched + ' 次投放里撞了 ' + sameCount + ' 次');

console.log(pass ? '\n物理手感自检通过' : '\n物理手感自检未通过');
process.exit(pass ? 0 : 1);
