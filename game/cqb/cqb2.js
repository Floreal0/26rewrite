/* CQB 二期 · 应用层:主菜单 / 小地图 / WebAudio 合成音效 / 事件泵
 * 引擎能力复用自 cqb1.js(window.CQB1 导出 + CQB_BOOT 延迟启动)
 */
(function () {
"use strict";

const $ = (id) => document.getElementById(id);
const ENG = () => window.CQB1;

/* ============================ 音频(WebAudio 合成) ============================ */
let AC = null, master = null, sfxPlayed = 0;

function ensureAudio() {
  if (!AC) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    AC = new Ctx();
    master = AC.createGain();
    master.gain.value = 0.4;
    master.connect(AC.destination);
  }
  if (AC.state === "suspended") AC.resume();
  return AC;
}

function tone({ f0 = 440, f1 = 0, type = "square", dur = 0.1, vol = 0.4, delay = 0 }) {
  if (!AC) return;
  const t0 = AC.currentTime + delay;
  const o = AC.createOscillator(), g = AC.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f0, t0);
  if (f1) o.frequency.exponentialRampToValueAtTime(Math.max(30, f1), t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.linearRampToValueAtTime(vol, t0 + 0.006);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g); g.connect(master);
  o.start(t0); o.stop(t0 + dur + 0.05);
}

function noiseBurst({ dur = 0.1, vol = 0.5, freq = 1500 }) {
  if (!AC) return;
  const t0 = AC.currentTime;
  const len = Math.max(1, Math.floor(AC.sampleRate * dur));
  const buf = AC.createBuffer(1, len, AC.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const src = AC.createBufferSource(); src.buffer = buf;
  const flt = AC.createBiquadFilter(); flt.type = "lowpass"; flt.frequency.value = freq;
  const g = AC.createGain(); g.gain.value = vol;
  src.connect(flt); flt.connect(g); g.connect(master);
  src.start(t0);
}

const SFX = {
  shotRifle(a) { noiseBurst({ dur:.09, vol:.5*a, freq:1600 });
                 tone({ f0:170, f1:60, type:"square", dur:.07, vol:.22*a }); },
  shotPistol(a){ noiseBurst({ dur:.07, vol:.45*a, freq:2400 });
                 tone({ f0:330, f1:90, type:"square", dur:.05, vol:.26*a }); },
  knife(a)     { noiseBurst({ dur:.06, vol:.28*a, freq:5000 }); },
  reload()     { tone({ f0:900, type:"square", dur:.04, vol:.2 });
                 tone({ f0:700, type:"square", dur:.04, vol:.2, delay:.16 }); },
  hurt()       { tone({ f0:210, f1:80, type:"sawtooth", dur:.14, vol:.32 }); },
  death(a)     { tone({ f0:150, f1:40, type:"sawtooth", dur:.4, vol:.38*a }); },
  win()        { [523,659,784,1046].forEach((f,i)=>tone({ f0:f, type:"square",
                                     dur:.14, vol:.3, delay:i*.13 })); },
};

/* 事件泵:引擎事件 → 音效(按距离衰减) */
function pumpEvents() {
  if (!window.CQB_DRAIN_EVENTS) return;
  const D = window.__CQB_DEBUG || {};
  const p = D.player;
  const events = window.CQB_DRAIN_EVENTS();
  for (const e of events) {
    sfxPlayed++;
    let a = 1;
    if (p && e.x != null && e.who !== "你") {
      const d = Math.hypot(e.x - p.x, e.y - p.y);
      a = Math.max(0.15, Math.min(1, 1 - d / (8 * (window.CQB1 ? window.CQB1.CELL : 32))));
    }
    switch (e.t) {
      case "shot":   (e.w === "rifle" ? SFX.shotRifle : SFX.shotPistol)(a); break;
      case "knife":  SFX.knife(a); break;
      case "reload": SFX.reload(); break;
      case "hurt":   SFX.hurt(); break;
      case "death":  SFX.death(e.who === "你" ? 1 : a); break;
      case "win":    SFX.win(); break;
    }
  }
}

/* ============================ 小地图(全信息版) ============================ */
const mmCv = $("minimap");
const mctx = mmCv.getContext("2d");
const MS = 3;                                    // 每格像素
mmCv.width = 56 * MS; mmCv.height = 40 * MS;

/* 地形层预渲染一次 */
const terr = document.createElement("canvas");
terr.width = mmCv.width; terr.height = mmCv.height;
(function prerenderTerrain() {
  const t = terr.getContext("2d");
  const md = window.CQB1.MAP_DATA;
  t.fillStyle = "#10141F"; t.fillRect(0, 0, terr.width, terr.height);
  for (const [, x, y, w, h] of md.rooms) {
    t.fillStyle = "#232B3E";
    t.fillRect(x * MS, y * MS, w * MS, h * MS);
  }
  for (const [x, y] of md.doors) {
    t.fillStyle = "#8a6d33";
    t.fillRect(x * MS, y * MS, MS, MS);
  }
  for (const [x, y] of md.crates) {
    t.fillStyle = "#4A5578";
    t.fillRect(x * MS, y * MS, MS, MS);
  }
})();

/* 已探索层:初始全黑,格子被看见时从地形层盖章一次 */
const rev = document.createElement("canvas");
rev.width = mmCv.width; rev.height = mmCv.height;
const rctx = rev.getContext("2d");
rctx.fillStyle = "#0A0D16"; rctx.fillRect(0, 0, rev.width, rev.height);
const seen = new Uint8Array(56 * 40);

function updateMinimap(now) {
  const D = window.__CQB_DEBUG;
  if (!D || !D.player || !D.player.alive) { mctx.clearRect(0, 0, mmCv.width, mmCv.height); return; }
  const ENG = window.CQB1;
  const poly = D.lastPoly || [];
  const px = D.player.x, py = D.player.y;
  const R = ENG.VISION_R;

  /* 标记已探索格(视野多边形覆盖到的格子中心) */
  const i0 = Math.max(0, ((px - R) / ENG.CELL) | 0);
  const i1 = Math.min(MAP_W - 1, ((px + R) / ENG.CELL) | 0);
  const j0 = Math.max(0, ((py - R) / ENG.CELL) | 0);
  const j1 = Math.min(MAP_H - 1, ((py + R) / ENG.CELL) | 0);
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const idx = j * MAP_W + i;
      if (seen[idx]) continue;
      if (ENG.entityVisible(poly, px, py, (i + .5) * ENG.CELL, (j + .5) * ENG.CELL)) {
        seen[idx] = 1;
        rctx.drawImage(terr, i * MS, j * MS, MS, MS, i * MS, j * MS, MS, MS);
      }
    }
  }

  mctx.clearRect(0, 0, mmCv.width, mmCv.height);
  mctx.drawImage(rev, 0, 0);

  /* 自身位置与朝向扇形 */
  const sx = px / ENG.CELL * MS, sy = py / ENG.CELL * MS;
  mctx.save();
  mctx.translate(sx, sy); mctx.rotate(D.player.facing);
  mctx.fillStyle = "#E8ECF5";
  mctx.beginPath(); mctx.moveTo(6, 0); mctx.lineTo(-4, -4); mctx.lineTo(-4, 4);
  mctx.closePath(); mctx.fill();
  mctx.restore();

  /* 视野内敌人红点 */
  if (D.bot && D.bot.alive && ENG.pip(poly, D.bot.x, D.bot.y)) {
    mctx.fillStyle = "#FF5C5C";
    mctx.beginPath();
    mctx.arc(D.bot.x / ENG.CELL * MS, D.bot.y / ENG.CELL * MS, 3, 0, Math.PI * 2);
    mctx.fill();
  }

  /* 噪波闪点(他人、5 格内) */
  for (const r of D.ripples || []) {
    if (r.who === D.player) continue;
    const d = Math.hypot(r.x - px, r.y - py);
    if (d > 5 * ENG.CELL) continue;
    const age = (now - r.born) / 650;
    if (age >= 1) continue;
    mctx.fillStyle = `rgba(124,92,255,${(1 - age) * .9})`;
    mctx.beginPath();
    mctx.arc(r.x / ENG.CELL * MS, r.y / ENG.CELL * MS, 2.5, 0, Math.PI * 2);
    mctx.fill();
  }
}

const MAP_W = 56, MAP_H = 40;

/* ============================ 菜单与流程 ============================ */
let minimapOn = false;

function mmLoop(t) {
  pumpEvents();
  if (minimapOn) updateMinimap(t);
  requestAnimationFrame(mmLoop);
}
requestAnimationFrame(mmLoop);

function startSolo() {
  ensureAudio();
  $("menu").classList.add("hidden");
  $("gamehud").classList.remove("hidden");
  $("minimap").classList.remove("hidden");
  window.CQB_BOOT();                    // 引擎启动
  $("startBtn").click();                // 直接进入对局
  minimapOn = true;
}

$("btnSolo").onclick = startSolo;

})();
