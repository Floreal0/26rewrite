/* cqb1 浏览器区冒烟测试:
 * 1) 构造最小 DOM/Canvas 桩
 * 2) 真实加载 cqb1.js(启动区完整执行)
 * 3) 手动驱动动画帧、点击"开始行动"、模拟按键与开火
 * 4) 每帧捕获异常 —— 定位"全黑屏"类问题 */
"use strict";
const fs = require("fs");
const path = require("path");

let frameError = null;

/* ---- DOM 桩 ---- */
function makeEl(id) {
  const el = {
    id, style: {}, children: [], textContent: "", innerHTML: "",
    width: 0, height: 0,
    _handlers: {},
    _classes: new Set(),
    classList: {
      add(...c) { c.forEach((x) => el._classes.add(x)); },
      remove(...c) { c.forEach((x) => el._classes.delete(x)); },
      contains(c) { return el._classes.has(c); },
    },
    appendChild(c) { el.children.push(c); return c; },
    prepend(c) { el.children.unshift(c); return c; },
    querySelector() { return makeEl(id + "-child"); },
    addEventListener(t, f) { (el._handlers[t] ||= []).push(f); },
    getContext() {
      const grad = { addColorStop() {} };
      return new Proxy({}, {
        get(t, p) {
          if (p === "canvas") return cvEl;
          return function () { return grad; };
        },
        set() { return true; },
      });
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

global.window = global;
const winHandlers = {};
global.addEventListener = function (t, f) { (winHandlers[t] ||= []).push(f); };
global.innerWidth = 1920; global.innerHeight = 1080;
global.requestAnimationFrame = function (f) { global.__frame = f; return 1; };

/* 虚拟时钟:每帧推进 16.7ms(标准 60fps),使位移/冷却等时间量真实演进 */
let simNow = 1000;
global.performance = { now: () => simNow };

/* ---- 加载游戏 ---- */
try {
  require(path.join(__dirname, "cqb1.js"));
} catch (e) {
  console.error("加载阶段异常:\n" + e.stack);
  process.exit(1);
}
console.log("PASS: 启动区执行完毕(resize/reset/首帧已排程)");

/* ---- 开场面板必须保持可见直到玩家点击(回归:「一闪而过」bug) ---- */
ok(!els["center"].classList.contains("hidden"), "加载后开场面板可见");
ok(global.__CQB_DEBUG.started === false, "未点击时游戏未启动");

/* ---- 驱动帧 ---- */
function stepFrames(n, label) {
  for (let i = 0; i < n; i++) {
    try {
      if (typeof global.__frame !== "function") {
        throw new Error("动画循环已中断(未排程下一帧)");
      }
      simNow += 16.7;
      const f = global.__frame;
      global.__frame = null;
      f(simNow);
    } catch (e) {
      console.error(`FRAME ERROR @ ${label} 第 ${i} 帧:\n` + e.stack);
      process.exit(1);
    }
  }
  console.log(`PASS: ${label} 连续 ${n} 帧无异常`);
}

stepFrames(10, "开始界面");

/* ---- 模拟点击"开始行动" ---- */
const startBtn = els["startBtn"];
if (!startBtn || typeof startBtn.onclick !== "function") {
  console.error("FAIL: 开始按钮未绑定 onclick"); process.exit(1);
}
startBtn.onclick();
stepFrames(5, "开局");

/* ---- 行为断言:输入必须真实改变游戏状态 ---- */
const D = global.__CQB_DEBUG;
let failed = false;
function ok(cond, msg) {
  if (!cond) { console.error("FAIL:", msg); failed = true; }
  else console.log("PASS:", msg);
}
ok(D.started === true, "点击后 started=true");

// 按住 W 60 帧 → y 应减小(向上移动)
const yBefore = D.player.y;
for (const h of winHandlers["keydown"] || []) h({ key: "w", preventDefault() {} });
stepFrames(60, "按住 W");
ok(D.player.y < yBefore - 80, `W 移动生效(y ${yBefore.toFixed(0)}→${D.player.y.toFixed(0)},期望≥100)`);
ok(Math.abs(D.cam.x - D.player.x) < 0.5 && Math.abs(D.cam.y - D.player.y) < 0.5,
   "角色恒居屏幕中心(相机无钳制)");
for (const h of winHandlers["keyup"] || []) h({ key: "w" });

// 鼠标移到右侧 → facing 应与"相机真实值反推的期望角"一致(允许微小误差)
{
  const CQB = require(path.join(__dirname, "cqb1.js"));
  for (const h of (els["cv"]._handlers["mousemove"] || [])) {
    h({ clientX: global.innerWidth - 60, clientY: global.innerHeight / 2 });
  }
  stepFrames(3, "鼠标指向右侧");
  const mx = global.innerWidth - 60, my = global.innerHeight / 2;
  const wx = D.cam.x - global.innerWidth / (2 * D.zoom) + mx / D.zoom;
  const wy = D.cam.y - global.innerHeight / (2 * D.zoom) + my / D.zoom;
  const expect = Math.atan2(wy - D.player.y, wx - D.player.x);
  const diff = Math.abs(Math.atan2(Math.sin(D.player.facing - expect),
                                   Math.cos(D.player.facing - expect)));
  ok(diff < 0.02, `面朝方向与鼠标世界方位一致(偏差 ${(diff * 180 / Math.PI).toFixed(2)}°)`);
}

// 按住左键 40 帧 → 弹药应减少(射击管线工作)
const magBefore = D.player.mags[0];
for (const h of (els["cv"]._handlers["mousedown"] || [])) h({ button: 0 });
stepFrames(40, "持续开火");
for (const h of (winHandlers["mouseup"] || [])) h({});
ok(D.player.mags[0] < magBefore, `弹药减少(${magBefore}→${D.player.mags[0]})`);

if (failed) { console.error("\nSMOKE FAILED —— 输入链路存在缺陷"); process.exit(1); }
console.log("\nSMOKE ALL PASSED —— 渲染管线无运行期异常");
