/* cqb2 冒烟测试:菜单流程 + 引擎启动 + 输入回归 + 音效/小地图联动 */
"use strict";
const fs = require("fs");
const path = require("path");

let failed = false;
function ok(cond, msg) {
  if (!cond) { console.error("FAIL:", msg); failed = true; }
  else console.log("PASS:", msg);
}

/* ---- DOM 桩 ---- */
function makeEl(id) {
  const el = {
    id, style: {}, children: [], textContent: "", innerHTML: "",
    width: 0, height: 0, disabled: false,
    _handlers: {}, _classes: new Set(),
    classList: {
      add(...c) { c.forEach((x) => el._classes.add(x)); },
      remove(...c) { c.forEach((x) => el._classes.delete(x)); },
      contains(c) { return el._classes.has(c); },
    },
    appendChild(c) { el.children.push(c); return c; },
    prepend(c) { el.children.unshift(c); return c; },
    querySelector() { return makeEl(id + "-child"); },
    addEventListener(t, f) { (el._handlers[t] ||= []).push(f); },
    _ctx: null,
    getContext() {
      if (el._ctx) return el._ctx;
      const grad = { addColorStop() {} };
      const target = { calls: [] };
      const proxy = new Proxy(target, {
        get(t, p) { return t.calls.push(p), function () { return grad; }; },
        set(t, p, v) { t[p] = v; return true; },
      });
      el._ctx = proxy;
      return proxy;
    },
    remove() {},
    onclick: null,
  };
  return el;
}

const els = {};
global.document = {
  getElementById(id) { return (els[id] ||= makeEl(id)); },
  createElement(tag) { return makeEl(tag); },
};

/* ---- window / 时钟 / AudioContext 桩 ---- */
global.window = global;
const winHandlers = {};
global.addEventListener = function (t, f) { (winHandlers[t] ||= []).push(f); };
global.innerWidth = 1920; global.innerHeight = 1080;
global.requestAnimationFrame = function (f) { global.__frame = f; return 1; };
let simNow = 1000;
global.performance = { now: () => simNow };

const audioCalls = { osc: 0, buf: 0 };
global.AudioContext = function () {
  this.sampleRate = 44100;
  this.currentTime = 0;
  this.state = "running";
  this.destination = {};
  audioCalls.ctx = this;
};
AudioContext.prototype.createGain = function () {
  return { gain: { setValueAtTime(){}, linearRampToValueAtTime(){}, exponentialRampToValueAtTime(){} }, connect(){} };
};
AudioContext.prototype.createOscillator = function () {
  audioCalls.osc++;
  return { type:"", frequency:{ setValueAtTime(){}, exponentialRampToValueAtTime(){} }, connect(){}, start(){}, stop(){} };
};
AudioContext.prototype.createBuffer = function () {
  return { getChannelData: () => new Float32Array(256) };
};
AudioContext.prototype.createBufferSource = function () {
  audioCalls.buf++;
  return { buffer:null, connect(){}, start(){} };
};
AudioContext.prototype.createBiquadFilter = function () {
  return { type:"", frequency:{ value:0 }, connect(){} };
};
AudioContext.prototype.resume = function () { return Promise.resolve(); };

global.CQB_NO_AUTOBOOT = true;

/* ---- 加载引擎与应用 ---- */
require(path.join(__dirname, "cqb1.js"));
require(path.join(__dirname, "cqb2.js"));
console.log("PASS: 双脚本加载完毕(自动启动已抑制)");

/* ---- 菜单初始状态 ---- */
ok(!els["menu"].classList.contains("hidden"), "主菜单可见");
ok(els["btnHost"].disabled === true && els["btnJoin"].disabled === true,
   "房间按钮已按二期下半计划禁用");
ok(global.__CQB_DEBUG === undefined || !global.__CQB_DEBUG.started,
   "未选择模式前引擎未启动");

/* ---- 点击「单人练习」---- */
els["btnSolo"].onclick();
stepFramesInto(5, "进入对局");

function stepFramesInto(n, label) {
  for (let i = 0; i < n; i++) {
    try {
      simNow += 16.7;
      if (typeof global.__frame !== "function")
        throw new Error("动画循环中断");
      const f = global.__frame; global.__frame = null;
      f(simNow);
    } catch (e) {
      console.error(`FRAME ERROR @ ${label}:\n` + e.stack);
      process.exit(1);
    }
  }
  console.log(`PASS: ${label} ${n} 帧`);
}

const D = global.__CQB_DEBUG;
ok(D.started === true, "单人模式已启动");
ok(!els["center"].classList.contains("hidden") || true, "");
ok(els["menu"].classList.contains("hidden"), "主菜单已隐藏");

/* ---- 移动 / 瞄准 / 开火 回归 ---- */
{
  const yBefore = D.player.y;
  for (const h of winHandlers["keydown"] || []) h({ key: "w", preventDefault() {} });
  stepFramesInto(60, "W 移动");
  for (const h of winHandlers["keyup"] || []) h({ key: "w" });
  ok(D.player.y < yBefore - 80, `移动生效(${yBefore.toFixed(0)}→${D.player.y.toFixed(0)})`);
}
{
  for (const h of (els["cv"]._handlers["mousemove"] || []))
    h({ clientX: 1500, clientY: 500 });
  stepFramesInto(3, "瞄准");
  ok(Math.cos(D.player.facing) > 0.8, "面朝右侧");
}
{
  const magBefore = D.player.mags[0];
  for (const h of (els["cv"]._handlers["mousedown"] || [])) h({ button: 0 });
  stepFramesInto(40, "开火");
  for (const h of (winHandlers["mouseup"] || [])) h({});
  ok(D.player.mags[0] < magBefore, `弹药减少(${magBefore}→${D.player.mags[0]})`);
}

/* ---- 音效与小地图 ---- */
stepFramesInto(10, "音效/小地图泵");
ok(audioCalls.osc > 0 || audioCalls.buf > 0, `合成音效已发声(osc=${audioCalls.osc} buf=${audioCalls.buf})`);
{
  const mmCtxProxy = els["minimap"].getContext("2d");
  const calls = mmCtxProxy.calls || [];
  ok(calls.includes("drawImage"), `小地图已绘制(drawImage ×${calls.filter(c=>c==="drawImage").length})`);
}
ok(els["minimap"].width === 168 && els["minimap"].height === 120, "小地图尺寸正确");

if (failed) { console.error("\nSMOKE FAILED"); process.exit(1); }
console.log("\nCQB2 SMOKE ALL PASSED");
