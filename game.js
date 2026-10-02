/* ============================================================
 *  合成大奶娃 · Suika Game
 *  纯原生 HTML + CSS + JavaScript，无任何依赖。
 *
 *  物理：PBD（位置约束求解）—— 3 个子步 × 6 次迭代，
 *        静止堆叠稳定，不抖动。
 *  玩法：相同水果接触即合成高一级水果；顶到警戒线超时判负。
 *
 *  分工：模拟（物理 / 合成 / 计分 / 判负 / 随机）全在 sim.js，
 *        这个文件只负责渲染、音效、粒子和输入。
 *        这样「种子 + 每次投放」就能把一局原样重跑一遍，
 *        排行榜靠这个证明分数（见 leaderboard.js）。
 * ============================================================ */
(function () {
  'use strict';

  /* ---------------------------------------------------------
   *  模拟核心 sim.js
   *  物理、合成、计分、判负、投放节奏、出水果的随机，全在那一边；
   *  这边只剩画图、播声音、收输入。
   *  常量也从 sim 拿，避免两边各写一份、改了一边忘另一边。
   * ------------------------------------------------------- */
  const S = window.SUIKA_SIM;

  const W = S.W;                  // 逻辑宽度
  const H = S.H;                  // 逻辑高度
  const WALL = S.WALL;            // 左右墙厚
  const DROP_Y = S.DROP_Y;        // 待投放水果的高度
  const DANGER_Y = S.DANGER_Y;    // 警戒线
  const MAX_TIER = S.MAX_TIER;    // 最大那只（神奶蛙）的索引
  const ASSET_FILL = S.ASSET_FILL;// 贴图里主体占画布长边的比例，与生成脚本保持一致
  const FRUITS = S.FRUITS;
  /* 玩法数值也从 sim 拿：加分、发复活币、清场定格全发生在那一边，
     两边各写一份的话改了一边忘另一边，回放就对不上了。 */
  const MAX_BONUS = S.MAX_BONUS;     // 两只神奶蛙相撞的奖励分（自检要读）
  const REVIVE_STEP = S.REVIVE_STEP; // 每累计多少分发一枚复活币

  /* 每局一个随机种子。它会跟着回放一起上传，
     验证的人用同一个种子就能重放出完全一样的出球顺序。 */
  function newSeed() { return (Math.random() * 0x100000000) >>> 0 || 1; }
  const sim = S.create(newSeed());

  const BEST_KEY = 'danaiwa.best.v1';
  const MUTE_KEY = 'danaiwa.mute.v1';

  /* ---------------------------------------------------------
   *  DOM
   * ------------------------------------------------------- */

  const canvas    = document.getElementById('game');
  const ctx       = canvas.getContext('2d');
  const stage     = document.getElementById('stage');
  const scoreEl   = document.getElementById('score');
  const bestEl    = document.getElementById('best');
  const finalScoreEl = document.getElementById('finalScore');
  const finalBestEl  = document.getElementById('finalBest');
  const nextCanvas = document.getElementById('next');
  const nextCtx    = nextCanvas.getContext('2d');
  const chainCanvas = document.getElementById('chain');
  const chainCtx    = chainCanvas.getContext('2d');
  const soundBtn   = document.getElementById('soundBtn');
  const resetBtn   = document.getElementById('resetBtn');
  const restartBtn = document.getElementById('restartBtn');
  const overlayEl     = document.getElementById('overlay');
  const revivePromptEl = document.getElementById('revivePrompt');
  const overPanelEl    = document.getElementById('overPanel');
  const reviveScoreEl  = document.getElementById('reviveScore');
  const reviveLeftEl   = document.getElementById('reviveLeft');
  const reviveBtn      = document.getElementById('reviveBtn');
  const giveUpBtn      = document.getElementById('giveUpBtn');
  const reviveBadge    = document.getElementById('reviveBadge');
  const reviveCountEl  = document.getElementById('reviveCount');

  /* ---------------------------------------------------------
   *  工具
   * ------------------------------------------------------- */

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const rand  = (a, b) => a + Math.random() * (b - a);

  /* ---------------------------------------------------------
   *  音效（WebAudio，无外部资源）
   * ------------------------------------------------------- */

  const Sound = {
    ctx: null,
    muted: localStorage.getItem(MUTE_KEY) === '1',

    ensure() {
      if (this.ctx) return this.ctx;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      try { this.ctx = new AC(); } catch (e) { this.ctx = null; }
      return this.ctx;
    },

    tone(freq, freq2, dur, vol, type) {
      if (this.muted) return;
      const c = this.ensure();
      if (!c) return;
      if (c.state === 'suspended') c.resume();
      const t = c.currentTime;
      const osc = c.createOscillator();
      const gain = c.createGain();
      osc.type = type || 'sine';
      osc.frequency.setValueAtTime(freq, t);
      if (freq2 && freq2 !== freq) {
        osc.frequency.exponentialRampToValueAtTime(Math.max(20, freq2), t + dur);
      }
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(vol, t + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(gain);
      gain.connect(c.destination);
      osc.start(t);
      osc.stop(t + dur + 0.02);
    },

    merge(tier) {
      const base = 240 * Math.pow(1.1225, tier * 2);
      this.tone(base, base * 1.7, 0.2, 0.16, 'sine');
      this.tone(base * 2, base * 3, 0.12, 0.06, 'triangle');
    },

    drop()   { this.tone(180, 120, 0.08, 0.05, 'sine'); },
    over()   { this.tone(420, 90, 0.7, 0.16, 'sawtooth'); },
    bonus()  { [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => this.tone(f, f, 0.22, 0.12, 'triangle'), i * 90)); }
  };

  /* 手机上的轻微震动反馈（跟着静音开关走；不支持的浏览器自动忽略） */
  function haptic(ms) {
    if (Sound.muted) return;
    if (navigator.vibrate) {
      try { navigator.vibrate(ms); } catch (e) { /* 忽略 */ }
    }
  }

  /* ---------------------------------------------------------
   *  画布尺寸
   * ------------------------------------------------------- */

  const view = { scale: 1, dpr: 1 };

  function resizeCanvas() {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width  = Math.max(1, Math.round(rect.width  * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    view.dpr = dpr;
    view.scale = (rect.width * dpr) / W;
  }

  /* ---------------------------------------------------------
   *  游戏状态
   * ------------------------------------------------------- */

  /* 模拟状态是 sim 的（balls/score/tick/inputs/...），
     下面这几个只跟画面有关的字段挂在同一个对象上方便绘制 ——
     它们不进回放，replay() 只取 seed / end / score / inputs。

     `state` 是 let 而不是 const：看回放的时候它会指向**另一个**模拟实例，
     你手上这一局原样冻在 sim.state 里，退出回放再切回来。
     平时它恒等于 sim.state（同一个对象），所以老测试拿 __DNW__.state 不受影响。 */
  let state = sim.state;
  state.best = Number(localStorage.getItem(BEST_KEY) || 0);
  state.particles = [];
  state.floats = [];
  state.flash = 0;

  /* 'game' 正常玩；'play' 正在看回放 —— 输入全部让路，
     update() 只推进回放那一份模拟，你这一局一帧都不动。 */
  let mode = 'game';
  let player = null;          // Sim.makePlayer(...) 的句柄
  let playMeta = null;        // { source, index, title, claimed, status, reason }
  let playAcc = 0;            // 播放用的时间累加器
  let playSpeed = 1;          // 1 / 2 / 4
  let wasOverlay = false;     // 进回放前结束遮罩是不是开着
  let wasModal = false;       // 进回放前排行榜弹窗是不是开着

  /* 碰撞形状、刚体构造也都在 sim.js（贴图轮廓数据照旧来自 parts.js） */
  const shapeOf = sim.shapeOf;
  const makeBall = sim.makeBall;

  /* ---------------------------------------------------------
   *  物理 & 合成：全在 sim.js
   *  game.js 这边一点都不改模拟状态 —— 分数完全由 sim 决定，
   *  所以「种子 + 投放记录」就能把一局原样重跑出来。这里只留个句柄给老测试用。
   * ------------------------------------------------------- */
  const stepPhysics = sim.stepPhysics;

  /* ---------------------------------------------------------
   *  特效 & 计分
   * ------------------------------------------------------- */

  function burst(x, y, tier, n, speed) {
    const f = FRUITS[Math.min(tier, MAX_TIER)];
    const c1 = f.pc1 || f.c1;
    const c2 = f.pc2 || f.c2;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = rand(speed * 0.25, speed);
      state.particles.push({
        x, y,
        vx: Math.cos(a) * s,
        vy: Math.sin(a) * s - 70,
        r: rand(2, 5.5),
        life: 1,
        decay: rand(1.3, 2.4),
        color: Math.random() < 0.5 ? c1 : c2
      });
    }
    if (state.particles.length > 420) state.particles.splice(0, state.particles.length - 420);
  }

  /* 复活币胶囊：有币才显示，跨过 2000 分时弹一下。
     注意 0 枚时也要把文字刷成 ×0 —— 否则下次显示出来的是上一次的旧数字。
     回放时不显示：那是录像里那个人的币，不是你的。 */
  function paintRevives(pop) {
    if (!reviveBadge) return;
    if (reviveCountEl) reviveCountEl.textContent = '×' + state.revives;
    if (state.revives > 0 && mode === 'game') {
      reviveBadge.hidden = false;
      if (pop) {
        reviveBadge.classList.remove('pop');
        void reviveBadge.offsetWidth;
        reviveBadge.classList.add('pop');
      }
    } else {
      reviveBadge.hidden = true;
      reviveBadge.classList.remove('pop');
    }
  }

  /* 「+1 复活币」那一行大字飘分 + 音效。
     模拟那边只负责 state.revives++，观感全在这一层。 */
  function paintReviveGrant() {
    paintRevives(true);
    state.floats.push({ x: W / 2, y: 210, text: '+1 复活币', life: 1.4, big: true });
    Sound.merge(6);
  }

  /* 分数本身是 sim 加的（processMerges 里就已经 +n 了），
     这一边只负责把结果同步到界面上 —— 再加一次就会翻倍，
     而且那样 game.js 也就成了「改分数的地方」，回放就复现不了了。 */
  function paintScore(n, x, y, text) {
    /* 看回放时只飘字：不碰最高分、不改面板数字 ——
       看一局录像没道理把你自己的最高分抬上去，退出来还得改回去。 */
    if (mode !== 'play') {
      if (state.score > state.best) {
        state.best = state.score;
        localStorage.setItem(BEST_KEY, String(state.best));
        bestEl.textContent = state.best;
      }
      scoreEl.textContent = state.score;
      bump(scoreEl);
    }
    if (x !== undefined) {
      state.floats.push({ x, y, text: text || ('+' + n), life: 1 });
    }
  }

  /* 加 n 分：分数交给 sim（加分和发复活币都在那一边，回放要复现），
     再把界面刷出来。正常流程是 sim 自己发事件、pumpEvents 走 paintScore ——
     只有控制台和玩法自检会直接调这个，别在游戏流程里调，会加两次。 */
  function addScore(n, x, y, text) {
    sim.addScore(n);
    pumpEvents();          // 把刚才那次发币的事件当场吃掉（徽章 / 飘字 / 音效）
    paintScore(n, x, y, text);
    return state.score;
  }

  function bump(el) {
    el.classList.remove('bump');
    void el.offsetWidth;
    el.classList.add('bump');
  }

  /* ---------------------------------------------------------
   *  投放 & 控制
   * ------------------------------------------------------- */

  function aimLimit(tier) { return sim.aimLimit(tier); }

  function moveAim(x) { sim.moveAim(x); }

  function tryDrop() {
    if (!sim.tryDrop()) return;      // 冷却中 / 已结束，和以前一样什么都不做
    pumpEvents();                    // 投放音效、刷新「下一个」当帧就出
  }

  /* ---------------------------------------------------------
   *  事件分发
   *  sim 只把「发生了什么」写进队列（合成 / 奖励 / 发币 / 复活 / 判负），
   *  音效、粒子、飘分、结算弹窗这些只跟画面有关的东西留在这一层。
   * ------------------------------------------------------- */
  function pumpEvents() {
    const evs = sim.drainEvents();
    for (let i = 0; i < evs.length; i++) {
      const ev = evs[i];
      if (ev.type === 'drop') {
        Sound.drop();
        drawNext();
      } else if (ev.type === 'merge') {
        if (ev.ball) ev.ball.popAt = performance.now();   // 弹出动画用真实时间
        paintScore(ev.score, ev.x, ev.y, '+' + ev.score);
        burst(ev.x, ev.y, ev.tier, 8 + ev.tier * 2, 140 + ev.tier * 22);
        Sound.merge(ev.tier);
        haptic(6 + ev.tier);
        if (ev.tier === MAX_TIER) state.flash = 1;
      } else if (ev.type === 'bonus') {
        /* 两只神奶蛙一起炸掉：大字飘分 + 更猛的爆裂 + 更亮的闪。
           这里刻意**不给 addScore 传坐标** —— 普通飘字不要，
           下面单独给「大字 +500」和一行说明。 */
        paintScore(ev.score);
        burst(ev.x, ev.y, ev.tier, 90, 560);
        burst(ev.x, ev.y, Math.max(0, ev.tier - 2), 42, 340);
        Sound.bonus();
        haptic(70);
        state.flash = 1.4;                    // 比普通合成更亮的全屏闪
        state.floats.push({ x: ev.x, y: ev.y - 74, text: '两个神奶蛙 💥', life: 1.6 });
        state.floats.push({ x: ev.x, y: ev.y - 16, text: '+' + ev.score, life: 2.2, big: true });
        if (ev.revive) paintRevives(true);    // 顺手送的那一枚
      } else if (ev.type === 'reviveGrant') {
        if (mode === 'game') paintReviveGrant();
      } else if (ev.type === 'revive') {
        /* 回放里没人点按钮，闪一下让观众知道这儿救回来了 */
        if (mode === 'play') state.flash = 0.6;
      } else if (ev.type === 'over') {
        /* 回放里判负只意味着「播完了」：绝不能弹结算框，
           更不能走 DanaiwaBoard.onGameOver —— 那会把这份回放再提交一次。 */
        if (mode === 'game') gameOver();
      }
    }
  }

  /* 正式结算：弹结算窗 + 把成绩（连整局回放）交给排行榜 */
  function settle() {
    if (revivePromptEl) revivePromptEl.hidden = true;
    if (overPanelEl) overPanelEl.hidden = false;
    if (overlayEl) overlayEl.classList.add('show');
    /* 交给排行榜模块（没加载也不影响）：除了分数，把整局回放一起交出去 ——
       验证的人拿它原样重跑一遍，分数对得上才算数。 */
    if (window.DanaiwaBoard && window.DanaiwaBoard.onGameOver) {
      window.DanaiwaBoard.onGameOver(state.score, sim.replay());
    }
  }

  /* 越线那一屏：有复活币就先问一句 */
  function askRevive() {
    if (reviveScoreEl) reviveScoreEl.textContent = state.score;
    if (reviveLeftEl) reviveLeftEl.textContent = '还剩 ' + state.revives + ' 枚';
    if (revivePromptEl) revivePromptEl.hidden = false;
    if (overPanelEl) overPanelEl.hidden = true;
    if (overlayEl) overlayEl.classList.add('show');
  }

  function gameOver() {
    state.over = true;
    finalScoreEl.textContent = state.score;
    finalBestEl.textContent = state.best;
    Sound.over();
    if (state.revives > 0) { askRevive(); return; }
    settle();
  }

  /* 复活。规则全在 sim 里 —— 清哪几颗、扣几次、解除判负、把这个 tick
     记进回放，全都必须和重放时跑出来的完全一致；这一层只管把界面收起来。
     返回 false 表示当前不能复活（没次数 / 没判负）。 */
  function revive() {
    if (!sim.revive()) return false;
    state.flash = 0.6;               // 闪一下，让玩家知道救回来了
    if (revivePromptEl) revivePromptEl.hidden = true;
    if (overlayEl) overlayEl.classList.remove('show');
    paintRevives(false);
    Sound.ensure();
    return true;
  }

  function reset() {
    if (mode === 'play') return;          // 正在看回放，不许动你手上那局
    state.particles.length = 0;
    state.floats.length = 0;
    state.flash = 0;
    sim.reset(newSeed());            // 每局换新种子，回放就是靠它把整局拉回同一个起点
    overlayEl.classList.remove('show');
    if (revivePromptEl) revivePromptEl.hidden = true;
    if (overPanelEl) overPanelEl.hidden = false;
    paintRevives(false);
    scoreEl.textContent = '0';
    bestEl.textContent = state.best;
    drawNext();
    Sound.ensure();
  }

  /* ---------------------------------------------------------
   *  绘制
   * ------------------------------------------------------- */

  function drawFruit(c, x, y, r, tier, angle, scale, squashShape) {
    const f = FRUITS[tier];
    const s = scale === undefined ? 1 : scale;

    c.save();
    c.translate(x, y);
    /* 撞击挤压：沿法线压扁、垂直拉伸（世界坐标，先于水果自身旋转） */
    if (squashShape && squashShape.k > 0.004) {
      c.rotate(squashShape.a);
      c.scale(1 - squashShape.k, 1 + squashShape.k * 0.85);
      c.rotate(-squashShape.a);
    }
    if (s !== 1) c.scale(s, s);
    c.rotate(angle || 0);

    /* —— 贴图模式：主体直接画 PNG，画布边长按 ASSET_FILL 换算，保证视觉大小 = 物理直径 —— */
    if (f.img) {
      const box = (r * 2) / ASSET_FILL;
      c.drawImage(f.img, -box / 2, -box / 2, box, box);
      c.restore();
      return;
    }

    /* —— 兜底一：贴图还没到位时，先画一张极模糊的同形状缩略图 ——
       观感是「图正在慢慢变清晰」，而不是「图挂了」看到一堆卡通脸。
       这张缩略图是内联的 data URL（assets/fruits/blur.js，约 8KB），不走网络。 */
    if (blurImg && blurCfg && blurCfg.cols > 0) {
      const idx = tier < blurCfg.cols ? tier : blurCfg.cols - 1;
      const box = (r * 2) / ASSET_FILL;
      const cell = blurCfg.cell;
      c.imageSmoothingEnabled = true;
      if ('imageSmoothingQuality' in c) c.imageSmoothingQuality = 'high';
      c.drawImage(blurImg, idx * cell, 0, cell, cell, -box / 2, -box / 2, box, box);
      c.restore();
      return;
    }

    /* —— 兜底二：连缩略图都没有（blur.js 被拦了）才画程序化的圆形水果 —— */
    /* 主体 */
    const g = c.createRadialGradient(-r * 0.34, -r * 0.40, r * 0.12, 0, 0, r * 1.12);
    g.addColorStop(0, f.c1);
    g.addColorStop(1, f.c2);
    c.beginPath();
    c.arc(0, 0, r, 0, Math.PI * 2);
    c.fillStyle = g;
    c.fill();

    /* 半奶蛙 / 神奶蛙 的纹理 */
    if (tier === MAX_TIER) {
      c.save();
      c.beginPath();
      c.arc(0, 0, r, 0, Math.PI * 2);
      c.clip();
      c.strokeStyle = 'rgba(10,60,20,.30)';
      c.lineWidth = r * 0.13;
      for (let k = -2; k <= 2; k++) {
        c.beginPath();
        c.ellipse(k * r * 0.42, 0, r * 0.16, r * 1.05, 0, 0, Math.PI * 2);
        c.stroke();
      }
      c.restore();
    } else if (tier === MAX_TIER - 1) {
      c.save();
      c.beginPath();
      c.arc(0, 0, r, 0, Math.PI * 2);
      c.clip();
      c.strokeStyle = 'rgba(20,110,45,.85)';
      c.lineWidth = r * 0.16;
      c.beginPath();
      c.arc(0, 0, r * 0.93, 0, Math.PI * 2);
      c.stroke();
      c.restore();
    }

    /* 描边 */
    c.lineWidth = Math.max(1.4, r * 0.055);
    c.strokeStyle = f.line;
    c.beginPath();
    c.arc(0, 0, r - c.lineWidth * 0.5, 0, Math.PI * 2);
    c.stroke();

    /* 高光 */
    c.beginPath();
    c.ellipse(-r * 0.34, -r * 0.40, r * 0.30, r * 0.19, -0.7, 0, Math.PI * 2);
    c.fillStyle = 'rgba(255,255,255,.55)';
    c.fill();

    /* 表情 */
    if (r >= 20) {
      const eyeR = r * 0.135;
      const eyeX = r * 0.33;
      const eyeY = -r * 0.06;

      c.fillStyle = 'rgba(46,32,24,.88)';
      c.beginPath(); c.arc(-eyeX, eyeY, eyeR, 0, Math.PI * 2); c.fill();
      c.beginPath(); c.arc( eyeX, eyeY, eyeR, 0, Math.PI * 2); c.fill();

      c.fillStyle = 'rgba(255,255,255,.9)';
      c.beginPath(); c.arc(-eyeX - eyeR * 0.3, eyeY - eyeR * 0.35, eyeR * 0.34, 0, Math.PI * 2); c.fill();
      c.beginPath(); c.arc( eyeX - eyeR * 0.3, eyeY - eyeR * 0.35, eyeR * 0.34, 0, Math.PI * 2); c.fill();

      c.beginPath();
      c.arc(0, r * 0.08, r * 0.20, 0.18 * Math.PI, 0.82 * Math.PI);
      c.lineWidth = Math.max(1.2, r * 0.055);
      c.lineCap = 'round';
      c.strokeStyle = 'rgba(46,32,24,.72)';
      c.stroke();

      c.fillStyle = 'rgba(255,120,120,.30)';
      c.beginPath(); c.ellipse(-r * 0.56, r * 0.16, r * 0.16, r * 0.11, 0, 0, Math.PI * 2); c.fill();
      c.beginPath(); c.ellipse( r * 0.56, r * 0.16, r * 0.16, r * 0.11, 0, 0, Math.PI * 2); c.fill();
    } else {
      c.fillStyle = 'rgba(46,32,24,.85)';
      c.beginPath(); c.arc(-r * 0.3, -r * 0.06, r * 0.13, 0, Math.PI * 2); c.fill();
      c.beginPath(); c.arc( r * 0.3, -r * 0.06, r * 0.13, 0, Math.PI * 2); c.fill();
    }

    c.restore();
  }

  function drawBoard() {
    /* 背景 */
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#fffaf0');
    bg.addColorStop(0.55, '#fff2dc');
    bg.addColorStop(1, '#ffe7c6');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    /* 顶部投放区高光 */
    const top = ctx.createLinearGradient(0, 0, 0, 190);
    top.addColorStop(0, 'rgba(255,255,255,.85)');
    top.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = top;
    ctx.fillRect(0, 0, W, 190);

    /* 内壁阴影 */
    ctx.save();
    ctx.strokeStyle = 'rgba(196,150,100,.35)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(WALL, 0);
    ctx.lineTo(WALL, H - WALL);
    ctx.lineTo(W - WALL, H - WALL);
    ctx.lineTo(W - WALL, 0);
    ctx.stroke();
    ctx.restore();

    /* 警戒线 */
    const danger = state.danger;
    ctx.save();
    ctx.setLineDash([9, 9]);
    ctx.lineWidth = 2;
    ctx.strokeStyle = danger
      ? 'rgba(255,72,72,' + (0.55 + 0.45 * Math.abs(Math.sin(performance.now() / 140))) + ')'
      : 'rgba(226,152,120,.42)';
    ctx.beginPath();
    ctx.moveTo(WALL, DANGER_Y);
    ctx.lineTo(W - WALL, DANGER_Y);
    ctx.stroke();
    ctx.restore();
  }

  function drawBalls() {
    const now = performance.now();
    const balls = state.balls;
    const sorted = balls.slice().sort((a, b) => a.r - b.r);

    for (let i = 0; i < sorted.length; i++) {
      const b = sorted[i];
      if (b.dead) continue;

      /* 地面投影 */
      ctx.save();
      ctx.globalAlpha = 0.16;
      ctx.fillStyle = '#7a4a1e';
      ctx.beginPath();
      ctx.ellipse(b.x, H - WALL - 1, b.r * 0.86, Math.max(3, b.r * 0.17), 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      let scale = 1;
      if (b.popAt) {
        const t = (now - b.popAt) / 220;
        if (t < 1) scale = 1 + 0.28 * (1 - t);
        else b.popAt = 0;
      }
      const shape = b.sq > 0.004 ? { a: b.sqA, k: b.sq } : null;
      drawFruit(ctx, b.x, b.y, b.r, b.tier, b.angle, scale, shape);
    }
  }

  function drawAim() {
    if (mode !== 'game' || state.over) return;
    const tier = state.pending;
    const r = FRUITS[tier].r;
    const [lo, hi] = aimLimit(tier);
    const x = clamp(state.aimX, lo, hi);
    const bob = Math.sin(performance.now() / 320) * 2.5;
    const ready = state.ready;

    /* 只有能投的时候才画落点辅助线 */
    if (ready) {
      ctx.save();
      ctx.setLineDash([5, 8]);
      ctx.lineWidth = 1.6;
      ctx.strokeStyle = 'rgba(200,140,90,.45)';
      ctx.beginPath();
      ctx.moveTo(x, DROP_Y + r + 4);
      ctx.lineTo(x, H - WALL);
      ctx.stroke();
      ctx.restore();

      ctx.save();
      ctx.globalAlpha = 0.22;
      ctx.fillStyle = FRUITS[tier].c1;
      ctx.beginPath();
      ctx.arc(x, DROP_Y + bob, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    /* 冷却中也要画：淡一点表示“下一颗就是它、但还不能投”。
       不然这段时间棋盘上只剩右上角的“下一个”，很容易被当成当前这颗 */
    ctx.save();
    if (!ready) ctx.globalAlpha = 0.4;
    drawFruit(ctx, x, DROP_Y + bob, r, tier, 0, 1);
    ctx.restore();
  }

  function drawEffects(dt) {
    /* 粒子 */
    for (let i = state.particles.length - 1; i >= 0; i--) {
      const p = state.particles[i];
      p.vy += 1400 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= 0.99;
      p.life -= p.decay * dt;
      if (p.life <= 0) { state.particles.splice(i, 1); continue; }
      ctx.globalAlpha = Math.max(0, p.life) * 0.9;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r * p.life, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    /* 飘分 */
    ctx.textAlign = 'center';
    for (let i = state.floats.length - 1; i >= 0; i--) {
      const f = state.floats[i];
      const big = !!f.big;
      f.y -= (big ? 24 : 46) * dt;
      f.life -= dt * (big ? 0.55 : 1.05);
      if (f.life <= 0) { state.floats.splice(i, 1); continue; }
      ctx.globalAlpha = Math.min(1, f.life * 1.4);
      ctx.font = big
        ? '900 40px "PingFang SC", "Microsoft YaHei", system-ui, sans-serif'
        : '700 20px "PingFang SC", "Microsoft YaHei", system-ui, sans-serif';
      ctx.lineWidth = big ? 9 : 4;
      ctx.strokeStyle = 'rgba(255,255,255,.95)';
      ctx.strokeText(f.text, f.x, f.y);
      ctx.fillStyle = big ? '#e8342f' : '#f4623a';
      ctx.fillText(f.text, f.x, f.y);
    }
    ctx.globalAlpha = 1;

    /* 顶棚下一颗预览 */
    drawTopPreview();
  }

  function drawTopPreview() {
    /* 棋盘右上角永远显示「下一个」——当前那颗在准星位置上画着，别搞混 */
    const tier = state.next;
    const r = 15;
    const x = W - WALL - 30;
    const y = 32;

    ctx.save();
    ctx.globalAlpha = 0.9;
    ctx.font = '600 11px "PingFang SC", "Microsoft YaHei", system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(150,110,80,.85)';
    ctx.fillText('下一个', x - r - 10, y);
    ctx.restore();

    drawFruit(ctx, x, y, r, tier, 0, 1);
  }

  /* 面板中的“下一个” */
  function drawNext() {
    const w = nextCanvas.width;
    const h = nextCanvas.height;
    nextCtx.setTransform(1, 0, 0, 1, 0, 0);
    nextCtx.clearRect(0, 0, w, h);
    const tier = state.next;
    const r = FRUITS[tier].r;
    const k = (Math.min(w, h) * 0.42) / r;
    drawFruit(nextCtx, w / 2, h / 2, r * k, tier, 0, 1);
  }

  /* 面板中的“合成表” */
  function drawChain() {
    const cw = chainCanvas.width;
    const ch = chainCanvas.height;
    chainCtx.setTransform(1, 0, 0, 1, 0, 0);
    chainCtx.clearRect(0, 0, cw, ch);

    const slot = cw / FRUITS.length;
    const r = slot * 0.36;
    const cy = ch * 0.5;

    for (let i = 0; i < FRUITS.length; i++) {
      const x = slot * (i + 0.5);
      drawFruit(chainCtx, x, cy, r, i, 0, 1);
      if (i < FRUITS.length - 1) {
        chainCtx.save();
        chainCtx.globalAlpha = 0.45;
        chainCtx.fillStyle = '#b08a68';
        chainCtx.font = '600 ' + Math.round(ch * 0.2) + 'px system-ui, sans-serif';
        chainCtx.textAlign = 'center';
        chainCtx.textBaseline = 'middle';
        chainCtx.fillText('›', x + slot * 0.5, cy);
        chainCtx.restore();
      }
    }
  }

  /* ---------------------------------------------------------
   *  主循环
   * ------------------------------------------------------- */

  let last = performance.now();
  let acc = 0;
  const FIXED = 1 / 60;

  function frame(now) {
    let dt = (now - last) / 1000;
    last = now;
    if (dt > 0.25) dt = 0.25;      // 切后台回来不要瞬移
    acc += dt;

    let guard = 0;
    while (acc >= FIXED && guard < 5) {
      update(FIXED);
      acc -= FIXED;
      guard++;
    }
    if (guard >= 5) acc = 0;

    render(dt);
    requestAnimationFrame(frame);
  }

  function update(dt) {
    /* 看回放时这里只推进回放那一份模拟 —— 你手上这一局一帧都不动，
       退出回放接着玩就行，不用快照也不用恢复。 */
    if (mode === 'play') { updatePlayback(dt); return; }
    if (state.over) return;          // 结束后冻结棋盘（粒子特效仍在 render 里继续）

    sim.update(dt);
    pumpEvents();
    if (state.flash > 0) state.flash = Math.max(0, state.flash - dt * 2.2);
  }

  function render(dt) {
    ctx.setTransform(view.scale, 0, 0, view.scale, 0, 0);
    ctx.clearRect(0, 0, W, H);

    drawBoard();
    drawBalls();
    drawAim();
    /* 定格期间把特效的 dt 也压成 0，让它跟世界一起停住 */
    drawEffects(state.freeze > 0 ? 0 : dt);

    if (state.flash > 0) {
      ctx.save();
      ctx.globalAlpha = state.flash * 0.35;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
    }

    if (mode === 'play') paintHud();
  }

  /* ---------------------------------------------------------
   *  回放：把一局存档一帧一帧地播出来
   *
   *  数据来自 leaderboard.js 的本地存档 / 榜上记录；
   *  推进逻辑在 sim.js 的 makePlayer 里 —— 和判分用的是同一段代码，
   *  所以「你看到的」和「验出来的」永远是同一回事。
   *
   *  关键点：播放用的是**另一个**模拟实例。`state` 只是个指针，
   *  从它指向播放实例的那一刻起，你手上那一局（连同它的粒子、准星、
   *  冷却、分数）原封不动地留在 sim.state 里，一帧都没推进 ——
   *  退出回放切回来接着玩就行，不需要快照，也不需要恢复。
   * ------------------------------------------------------- */
  const hud = document.getElementById('replayHud');
  const hudBadge = document.getElementById('replayBadge');
  const hudTitle = document.getElementById('replayTitle');
  const hudScore = document.getElementById('replayScore');
  const hudClaimed = document.getElementById('replayClaimed');
  const hudBar = document.getElementById('replayBar');
  const hudNote = document.getElementById('replayNote');
  const btnPause = document.getElementById('replayPause');
  const btnSpeed = document.getElementById('replaySpeed');
  const btnPrev = document.getElementById('replayPrev');
  const btnNext = document.getElementById('replayNext');
  const btnStop = document.getElementById('replayStop');
  const btnClose = document.getElementById('replayClose');
  const boardModalEl = document.getElementById('boardModal');

  let playPaused = false;

  /* 渲染层那几个字段挂到播放实例上，和正式那一局互不相干 */
  function attachPlayFields(s) {
    s.particles = [];
    s.floats = [];
    s.flash = 0;
    s.best = state.best;
    s.aimX = W / 2;
    return s;
  }

  function showHud(on) { if (hud) hud.hidden = !on; }

  function bindHud() {
    if (!hud) return;
    if (btnStop) btnStop.addEventListener('click', stopReplay);
    if (btnClose) btnClose.addEventListener('click', stopReplay);
    if (btnPause) btnPause.addEventListener('click', togglePause);
    if (btnSpeed) btnSpeed.addEventListener('click', function () {
      setPlaySpeed(playSpeed === 1 ? 2 : playSpeed === 2 ? 4 : 1);
    });
    if (btnPrev) btnPrev.addEventListener('click', function () { stepSave(-1); });
    if (btnNext) btnNext.addEventListener('click', function () { stepSave(1); });
  }

  /* 开播。已经在播就直接换一局，不留黑帧。 */
  function playReplay(record, meta) {
    if (!record) return false;
    let p;
    try { p = S.makePlayer(record); } catch (e) { return false; }
    if (!p || p.error || !p.state) return false;

    if (mode !== 'play') {
      wasOverlay = overlayEl.classList.contains('show');
      wasModal = !!(boardModalEl && boardModalEl.classList.contains('show'));
      overlayEl.classList.remove('show');
      /* 复活币胶囊是「你这一局」的，看录像时先收起来，退出来再刷 */
      if (reviveBadge) reviveBadge.hidden = true;
      if (wasModal && window.DanaiwaBoard && window.DanaiwaBoard.close) window.DanaiwaBoard.close();
      mode = 'play';
      showHud(true);
    }

    attachPlayFields(p.state);
    player = p;
    playMeta = meta || {};
    playAcc = 0;
    playPaused = false;
    state = p.state;
    drawNext();
    paintHud();
    return true;
  }

  function stopReplay() {
    if (mode !== 'play') return false;
    mode = 'game';
    player = null;
    playMeta = null;
    playPaused = false;
    playAcc = 0;
    state = sim.state;                 // 切回你手上这一局（一帧都没动过）
    showHud(false);
    scoreEl.textContent = state.score;
    bestEl.textContent = state.best;
    drawNext();
    paintRevives(false);               // 复活币胶囊也切回你这一局
    if (wasOverlay) overlayEl.classList.add('show');
    if (wasModal && window.DanaiwaBoard && window.DanaiwaBoard.open) window.DanaiwaBoard.open();
    wasOverlay = false;
    wasModal = false;
    return true;
  }

  function togglePause() {
    if (mode !== 'play') return;
    playPaused = !playPaused;
    paintHud();
  }

  function setPlaySpeed(v) {
    playSpeed = (v === 2 || v === 4) ? v : 1;
    paintHud();
  }

  /* 存档列表里前后翻：上传页那个「◀ 上一局 / 下一局 ▶」就是它 */
  function stepSave(d) {
    const B = window.DanaiwaBoard;
    if (!B || !B.saves || !B.replaySave) return;
    const list = B.saves();
    if (!list || !list.length) return;
    let i = (playMeta && typeof playMeta.index === 'number') ? playMeta.index : 0;
    i = (i + d + list.length) % list.length;
    B.replaySave(i);
  }

  function updatePlayback(dt) {
    if (!player) { stopReplay(); return; }
    if (playPaused) return;

    playAcc += dt * playSpeed;
    let guard = 0;
    while (playAcc >= FIXED && guard < 8) {
      playAcc -= FIXED;
      guard++;
      if (!player.step()) { playAcc = 0; break; }   // 播完了（或这份回放本身有毛病）
      pumpEvents();                                  // 合成音效 / 粒子 / 飘分
    }
    if (guard >= 8) playAcc = 0;                     // 卡了就跳过一点，别越拖越远
    if (state.flash > 0) state.flash = Math.max(0, state.flash - dt * 2.2 * playSpeed);
  }

  function paintHud() {
    if (!hud || mode !== 'play' || !player) return;
    const m = playMeta || {};
    const p = player;

    if (hudBadge) {
      hudBadge.textContent = m.status === 'ok' ? '✅ 已验证'
        : m.status === 'bad' ? '❌ 没通过'
          : m.status === 'pending' ? '⏳ 待验证' : '🎬 回放';
      hudBadge.className = 'replay-badge is-' + (m.status || 'none');
    }
    if (hudTitle) hudTitle.textContent = m.title || '存档回放';
    if (hudScore && hudScore.textContent !== String(p.score)) hudScore.textContent = p.score;
    if (hudClaimed) {
      const c = (m.claimed === undefined || m.claimed === null) ? null : Number(m.claimed);
      hudClaimed.textContent = (c !== null && isFinite(c) && c !== p.score)
        ? '（声称 ' + c + '）' : '';
    }
    if (hudBar) {
      const pct = p.end > 0 ? Math.min(100, (p.tick / p.end) * 100) : 0;
      hudBar.style.width = pct.toFixed(1) + '%';
    }
    if (btnSpeed) btnSpeed.textContent = playSpeed + '×';
    if (btnPause) btnPause.textContent = playPaused ? '▶ 继续' : '⏸ 暂停';
    const isSave = m.source === 'save';
    if (btnPrev) btnPrev.hidden = !isSave;
    if (btnNext) btnNext.hidden = !isSave;

    if (hudNote) {
      let note = p.done
        ? (p.error ? '这份回放播不下去：' + p.error
          : '回放结束 · ' + p.score + ' 分 · ' + p.tick + ' tick')
        : (playPaused ? '已暂停'
          : '播到 ' + p.tick + ' / ' + p.end + ' tick' + (playSpeed !== 1 ? '　·　' + playSpeed + '×' : ''));
      if (m.reason) note += '　·　' + m.reason;
      if (hudNote.textContent !== note) hudNote.textContent = note;
    }
  }

  /* ---------------------------------------------------------
   *  输入
   * ------------------------------------------------------- */

  function pointerToX(clientX) {
    const rect = canvas.getBoundingClientRect();
    return (clientX - rect.left) * (W / rect.width);
  }

  /* 触屏是「拖动瞄准、松手投放」——手指不会挡住落点，也方便微调；
     鼠标保持「移动瞄准、按下即投」的桌面手感。 */
  let touchAiming = false;

  stage.addEventListener('pointermove', (e) => {
    if (mode !== 'game' || state.over) return;
    if (e.pointerType === 'touch' && !touchAiming) return;
    moveAim(pointerToX(e.clientX));
  });

  stage.addEventListener('pointerdown', (e) => {
    if (mode !== 'game' || state.over) return;
    Sound.ensure();
    moveAim(pointerToX(e.clientX));
    if (e.pointerType === 'touch') {
      touchAiming = true;
      /* 手指滑出棋盘也能收到 pointerup */
      if (stage.setPointerCapture) {
        try { stage.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
      }
    } else {
      tryDrop();
    }
  });

  stage.addEventListener('pointerup', (e) => {
    if (e.pointerType !== 'touch') return;
    if (!touchAiming) return;
    touchAiming = false;
    if (mode !== 'game' || state.over) return;
    moveAim(pointerToX(e.clientX));
    tryDrop();
  });

  stage.addEventListener('pointercancel', () => { touchAiming = false; });

  stage.addEventListener('contextmenu', (e) => e.preventDefault());

  /* 在输入框里打字时不要抢按键 */
  function isTyping(e) {
    const t = e.target;
    if (!t) return false;
    const tag = (t.tagName || '').toLowerCase();
    return tag === 'input' || tag === 'textarea' || t.isContentEditable === true;
  }

  window.addEventListener('keydown', (e) => {
    if (isTyping(e)) return;

    /* —— 看回放的时候：Esc 退出，← → 调倍速，空格暂停，其余全让路 —— */
    if (mode === 'play') {
      if (e.ctrlKey || e.metaKey || e.altKey) return;    // 浏览器快捷键别拦（刷新、F12…）
      if (e.code === 'Escape') { stopReplay(); e.preventDefault(); }
      else if (e.code === 'ArrowLeft') { setPlaySpeed(playSpeed === 4 ? 2 : 1); e.preventDefault(); }
      else if (e.code === 'ArrowRight') { setPlaySpeed(playSpeed === 1 ? 2 : 4); e.preventDefault(); }
      else if (e.code === 'Space' || e.code === 'Enter') { togglePause(); e.preventDefault(); }
      return;
    }

    if (e.code === 'ArrowLeft' || e.code === 'KeyA') {
      state.aimX = clamp(state.aimX - 14, WALL, W);
      e.preventDefault();
    } else if (e.code === 'ArrowRight' || e.code === 'KeyD') {
      state.aimX = clamp(state.aimX + 14, WALL, W);
      e.preventDefault();
    } else if (e.code === 'Space' || e.code === 'Enter' || e.code === 'ArrowDown') {
      /* 空格/回车只在局内投放；结束后不再用它们重开（免得手快连着开新局） */
      if (!state.over) { tryDrop(); e.preventDefault(); }
    } else if (e.code === 'KeyR') {
      reset();
      e.preventDefault();
    }
  });

  /* 音效按钮里是 <span class="ico"> + <span class="lbl">，只改这两块文字 */
  function paintSoundBtn() {
    const ico = soundBtn.querySelector('.ico');
    const lbl = soundBtn.querySelector('.lbl');
    if (ico) ico.textContent = Sound.muted ? '🔇' : '🔊';
    if (lbl) lbl.textContent = Sound.muted ? '音效关' : '音效开';
    soundBtn.setAttribute('aria-pressed', String(!Sound.muted));
  }

  soundBtn.addEventListener('click', () => {
    Sound.muted = !Sound.muted;
    localStorage.setItem(MUTE_KEY, Sound.muted ? '1' : '0');
    paintSoundBtn();
    if (!Sound.muted) Sound.merge(1);
  });

  resetBtn.addEventListener('click', reset);
  restartBtn.addEventListener('click', reset);

  /* ---------------------------------------------------------
   *  素材加载
   * ------------------------------------------------------- */

  /* 贴图加载。三点很重要：
       1) 弱网下「一次没拉到」很常见，**不重试**的话玩家会一直看到兜底的程序化水果
          （一堆卡通脸），观感就是"图挂了"，所以失败要退避重试；
       2) 必须等 decode() 完成再拿去 drawImage，否则浏览器会画出还没解码完的半成品；
       3) 全部失败也不影响玩，只是回退成程序化水果。 */
  const SPRITE_RETRY = 3;      // 每个素材最多试几次

  let blurImg = null;          // 极模糊占位图（内联 data URL，秒到）
  const blurCfg = window.FRUIT_BLUR || null;

  function loadBlur() {
    if (!blurCfg || !blurCfg.src) return;
    const im = new Image();
    im.onload = () => { blurImg = im; };
    im.src = blurCfg.src;
  }

  function loadSprites() {
    let left = 0;

    function fetchOne(f, attempt) {
      const img = new Image();
      img.onload = () => {
        const ready = () => {
          f.img = img;
          if (--left === 0) refreshPreviews();
        };
        if (img.decode) img.decode().then(ready, ready);
        else ready();
      };
      img.onerror = () => {
        if (attempt < SPRITE_RETRY) {
          /* 退避 + 抖动，避免一批图同时重试又同时失败 */
          const wait = 600 * Math.pow(2.4, attempt - 1) + Math.random() * 300;
          setTimeout(() => fetchOne(f, attempt + 1), wait);
          return;
        }
        left--;
        if (window.console) console.warn('[danaiwa] 素材载入失败，已回退为程序化水果：' + f.file);
        if (left === 0) refreshPreviews();
      };
      /* 重试时换一个带参地址，绕开浏览器对上次失败结果的缓存 */
      img.src = attempt > 1 ? (f.file + '?retry=' + attempt) : f.file;
    }

    for (let i = 0; i < FRUITS.length; i++) {
      const f = FRUITS[i];
      if (!f.file) continue;
      left++;
      fetchOne(f, 1);
    }
    return left;
  }

  function refreshPreviews() {
    drawNext();
    drawChain();
  }

  /* ---------------------------------------------------------
   *  启动
   * ------------------------------------------------------- */

  function boot() {
    resizeCanvas();
    if (window.ResizeObserver) {
      new ResizeObserver(resizeCanvas).observe(stage);
    }
    window.addEventListener('resize', resizeCanvas);
    window.addEventListener('orientationchange', () => setTimeout(resizeCanvas, 120));

    paintSoundBtn();
    bindHud();

    /* 越线那一屏的两个按钮 */
    if (reviveBtn) reviveBtn.addEventListener('click', revive);
    if (giveUpBtn) giveUpBtn.addEventListener('click', settle);

    drawChain();
    reset();
    loadBlur();             // 占位图是内联的，几乎立刻可用
    loadSprites();          // 贴图异步到位，到了会自动重画预览
    requestAnimationFrame((t) => { last = t; requestAnimationFrame(frame); });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  /* 调试句柄（控制台可用）：__DNW__.state / .reset() / .drop() / .FRUITS / .render() /
     __DNW__.playReplay(record, meta) / .stopReplay() —— 后两个是「重放」按钮的入口。
     state 是 getter：看回放时它指向播放实例，退出来又指回你这一局，
     而 `sim.state`（你那一局）从头到尾是同一个对象，测试可以直接拿。
     revive / settle / gameOver / addScore 是玩法层的入口（复活系统自检用）。 */
  window.__DNW__ = {
    get state() { return state; },
    reset, tryDrop, stepPhysics, FRUITS, render, resizeCanvas, shapeOf, makeBall, sim,
    playReplay, stopReplay,
    revive, settle, gameOver, askRevive, paintRevives, addScore, pumpEvents, update,
    MAX_BONUS, REVIVE_STEP,
    blurReady: () => !!blurImg,
    get mode() { return mode; },
    get player() { return player; },
    get playSpeed() { return playSpeed; }
  };
})();
