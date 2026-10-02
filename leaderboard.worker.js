/* ============================================================
 *  排行榜验证 Worker
 *
 *  消息：  { id: 序号, replay: 'v2;...' }   ← 一份待验证的回放
 *  回复：  { id, ok, score, reason, ms }
 *
 *  为什么放在 Worker 里：重跑一局要几秒钟，放主线程会把页面卡死。
 *  Worker 里只需要 parts.js（碰撞形状）+ sim.js（模拟核心），
 *  不用 DOM、不用 game.js。
 * ============================================================ */
'use strict';

/* parts.js 写的是 window.SUIKA_PARTS，Worker 里没有 window，先补一个 */
if (typeof self !== 'undefined' && typeof window === 'undefined') self.window = self;

importScripts('assets/fruits/parts.js', 'sim.js');

const Sim = self.SUIKA_SIM;

/* 单条验证的兜底上限：超了就不算「失败」，算「验不动」，
   免得有人用超长对局把验证者挂死。 */
const DEADLINE_MS = 90 * 1000;

self.onmessage = function (e) {
  const msg = e.data || {};
  const t0 = Date.now();
  let out;

  try {
    out = Sim.verify(msg.replay);
  } catch (err) {
    out = { ok: false, score: 0, reason: '验证出错：' + (err && err.message) };
  }

  const ms = Date.now() - t0;
  if (ms > DEADLINE_MS) {
    out = { ok: false, score: out && out.score || 0, reason: '验证太慢（' + (ms / 1000).toFixed(0) + ' 秒），跳过' };
  }

  self.postMessage({
    id: msg.id,
    ok: !!out.ok,
    score: out.score || 0,
    reason: out.reason || '',
    ms: ms
  });
};
