/* CQB 单机引擎外壳(渲染 / 输入 / 相机 / HUD / 音效桥)
 * 命名沿用一期(engine.js),2026-09-05 二期后游戏语义不再在此:
 *   - 全部常量/算法/状态层(战斗/投掷物/交互/Bot/玩法模式/主循环)单源自 shared.js;
 *   - 本文件职责 = 对局状态 S 的装载 + collectInputs 键鼠适配 + updateFighters 调用 +
 *     state.events 事件消费(音效/红闪/播报/结算)+ 渲染与联机快照灌入;
 *   - 模块级导出(EXPORTS/CQB1)供无头测试与 parity 同引用断言使用。
 * 设计依据:同目录 DESIGN.md「架构与双核治理」。
 */
(function (global) {
"use strict";

/* 公共逻辑核心(单源):纯算法层 + 状态层(2026-09-05 二期),与 rules.js 同引用。 */
const SHARED = (typeof require !== "undefined")
  ? require("./shared.js")
  : (global.CQB_SHARED || null);
if (!SHARED) throw new Error("shared.js 未加载:请先于本文件引入");
const {
  CELL, VISION_R_TILES, VISION_R, CONE_HALF, NEAR_R, PLAYER_R, WEAPONS, RESERVE,
  buildGrid, solidAt, blocksSight, dda, losClear, normAngle, visibilityPolygon,
  pip, entityVisible, astar, moveCircle, resolveShotGeometry, makeFighter,
  BOX_FILL, BOX_RESPAWN_MS, rollNadeType,
  deriveStandableCells, derivePointZones, deriveRescueZones, nearestStandableCell,
  /* 状态层(2026-09-05 二期单源,与 rules.js 同引用) */
  SPEED, SHIFT_SPEED, NOISE_INTERVAL, NOISE_RADIUS, SHOT_NOISE_R,
  RESPAWN_MS, PROTECT_MS, KILL_TARGET, TEAM_KILL_TARGET, RESERVE_CAP,
  NADE_THROW_DIST, NADE_V0, NADE_FRICTION, NADE_STOP_SPEED, NADE_FUSE,
  FLASH_R, FLASH_BLIND_FULL, FLASH_BLIND_BACK, FLASH_FADE, FLASH_NOISE_R,
  SMOKE_R, SMOKE_DUR, SMOKE_FADE, SMOKE_NOISE_R, NADE_CAP,
  BOT_DODGE_DELAY, HIT_TURN_DELAY, ALERT_MS, BOT_SEARCH_MS, BOT_HUNT_TIMEOUT,
  BOT_COMBAT_MOVE_MS, BOT_REPOSITION_MS,
  BOT_NADE_CD, BOT_FLASH_INFO_AGE, BOT_FLASH_MIN_DIST,
  BOT_SMOKE_HP, BOT_SMOKE_MAX_DIST, BOT_SMOKE_MIN_DIST, BOT_RETREAT_MS,
  RESCUE_TIME_MS, RESCUE_CHANNEL_MS, EXTRACT_CHANNEL_MS,
  POINT_TIME_MS, CAPTURE_MS, POINT_TICK_MS, POINT_SCORE_TARGET, ZONE_R,
  DOOR_INTERACT_R, BOX_INTERACT_R, DOOR_NOISE_R, DOOR_AUTO_OPEN_R, BOT_CFG,
  doFire, applyDamage, tryReload, switchWeapon, finishReloadIfDue, checkTeamWin,
  rebuildSightGrid, explosionNoise, explodeNade, updateGrenades, updateSmokes,
  emitNoise, doorNoise, nearestInteractive, interact, botAutoOpen, updateBoxes,
  circleHitsCell, resolveOverlap,
  pickSpawn, spawnFighter, BotBrain,
  initObjState, updateObj, objHintFor, updateFighters,
  createState, shiftTimers,
} = SHARED;

/* ============================ 地图数据 ============================ */
/* 单源来自 maps.js(map-office.generator.js 生成);Node 走 require,浏览器读全局 */
const MAP_DATA = (typeof require !== "undefined")
  ? require("./maps.js").office
  : (global.CQB_MAPS ? global.CQB_MAPS.office : null);
if (!MAP_DATA) throw new Error("maps.js 未加载:请先于 engine.js 引入 maps.js");



















/* ============================ 导出(无头测试用) ============================ */
const EXPORTS = {
  CELL, VISION_R, VISION_R_TILES, CONE_HALF, NEAR_R, PLAYER_R, WEAPONS, RESERVE, MAP_DATA,
  SPEED, SHIFT_SPEED, NOISE_INTERVAL, NOISE_RADIUS, SHOT_NOISE_R,
  PROTECT_MS, RESPAWN_MS, RESERVE_CAP, KILL_TARGET, TEAM_KILL_TARGET,
  buildGrid, solidAt, blocksSight, dda, losClear, normAngle, visibilityPolygon, pip,
  entityVisible, astar, moveCircle, resolveShotGeometry, makeFighter,
  BOX_FILL, BOX_RESPAWN_MS, rollNadeType,
  deriveStandableCells, derivePointZones, deriveRescueZones, nearestStandableCell,
  BotBrain, BOT_CFG,
  NADE_V0, NADE_FRICTION, NADE_STOP_SPEED, NADE_FUSE, NADE_THROW_DIST,
  FLASH_R, FLASH_BLIND_FULL, FLASH_BLIND_BACK, FLASH_FADE, FLASH_NOISE_R,
  SMOKE_R, SMOKE_DUR, SMOKE_FADE, SMOKE_NOISE_R,
  NADE_CAP, BOT_DODGE_DELAY, HIT_TURN_DELAY, ALERT_MS, BOT_COMBAT_MOVE_MS, BOT_REPOSITION_MS,
  BOT_SEARCH_MS, BOT_HUNT_TIMEOUT, BOT_NADE_CD, BOT_FLASH_INFO_AGE,
  BOT_FLASH_MIN_DIST, BOT_SMOKE_HP, BOT_SMOKE_MAX_DIST, BOT_SMOKE_MIN_DIST, BOT_RETREAT_MS,
  RESCUE_TIME_MS, RESCUE_CHANNEL_MS, EXTRACT_CHANNEL_MS,
  POINT_TIME_MS, CAPTURE_MS, POINT_TICK_MS, POINT_SCORE_TARGET, ZONE_R,
  DOOR_INTERACT_R, BOX_INTERACT_R, DOOR_NOISE_R, DOOR_AUTO_OPEN_R,
  doFire, applyDamage, tryReload, switchWeapon, finishReloadIfDue, checkTeamWin,
  rebuildSightGrid, explosionNoise, explodeNade, updateGrenades, updateSmokes,
  emitNoise, doorNoise, nearestInteractive, interact, botAutoOpen, updateBoxes,
  circleHitsCell, resolveOverlap,
  pickSpawn, spawnFighter,
  initObjState, updateObj, objHintFor, updateFighters,
  createState, shiftTimers,
};
global.CQB1 = EXPORTS;
if (typeof module !== "undefined" && module.exports) module.exports = EXPORTS;

/* ============================ 浏览器启动区 ============================ */
function bootBrowser() {
  if (bootBrowser.done) return; bootBrowser.done = true;

  const cv = document.getElementById("cv");
  const ctx = cv.getContext("2d");
  const fogCv = document.createElement("canvas");
  const fctx = fogCv.getContext("2d");

  const el = (id) => document.getElementById(id);
  const hud = {
    kills: el("kills"), deaths: el("deaths"), feed: el("killfeed"),
    wname: el("wname"), mag: el("mag"), reserve: el("reserve"), reloadFill: el("reloadFill"),
    hpfill: el("hpfill"), hptext: el("hptext"), vignette: el("vignette"),
    center: el("center"), ovTitle: el("ovTitle"), ovText: el("ovText"),
    startBtn: el("startBtn"), respawnTxt: el("respawnTxt"),
    killtarget: el("killtarget"), killtarget2: el("killtarget2"),
    ekills: el("ekills"), roomname: el("roomname"), hint: el("hint"),
    mykills: el("mykills"), modetext: el("modetext"), flashwhite: el("flashwhite"),
    objbar: el("objbar"), objtext: el("objtext"),
    pauseMenu: el("pauseMenu"), pauseResumeBtn: el("pauseResumeBtn"),
    pauseRestartBtn: el("pauseRestartBtn"), pauseExitBtn: el("pauseExitBtn"),
  };

  let cssW = 0, cssH = 0, ZOOM = 1;
  /* 事件总线:cqb2 的音效/统计层通过 CQB_DRAIN_EVENTS() 消费 */
  const EVENTS = [];
  global.CQB_EVENTS = EVENTS;
  global.CQB_DRAIN_EVENTS = () => EVENTS.splice(0);
  let lastPoly = [];
  let lastTeamVision = [];            // 队伍视野视图集(自己∪队友,供小地图等消费)
  let netMates = [];                  // 联机:快照下发的队友实体(整份,恒可见)
  let netEnemies = [];                // 联机:快照下发的可见敌人(完整列表,渲染按视野剪裁)
  /* 联机手感包(2026-09-05):自体预测历史 + 远程实体插值采样 */
  const NET_INTERP_MS = 100;          // ⚙ 实体插值渲染延迟(≈3 份 30Hz 快照)
  const netBuf = new Map();           // 实体 id → [{t,x,y,f}] 采样环(渲染时间线 = now-100ms)
  let predHistory = [];               // 自体预测位姿历史 [{seq,x,y}](对账后 rebase)
  function resize() {
    cssW = window.innerWidth; cssH = window.innerHeight;
    cv.width = cssW; cv.height = cssH;
    fogCv.width = cssW; fogCv.height = cssH;
    ZOOM = (cssH * 0.78) / (VISION_R * 2);
  }
  window.addEventListener("resize", resize);

  /* ---- 状态 ---- */
  /* 对局状态 S:shared.js 单源(createState 产出,reset 时重建)。引擎外壳只保留
   * 输入采集/渲染/HUD/相机/音效桥;全部游戏语义经 S 消费 shared 单源函数。 */
  /* 对局模式(1v1/2v2/3v3)与团队击杀阈值(用户拍板:合计 15/20/25)。
   * 每局 reset 时从 __CQB_MATCH_SETTINGS 重读——同会话回主菜单改规模必须生效
   * (2026-09-05 修复:此前为 boot 时常量,地图/玩法每局生效而规模永远停在首局) */
  let MODE_KEY = "1v1", TEAM_SIZE = 1, killTarget = 15;
  const KILL_TARGETS = { "1v1": 15, "2v2": 20, "3v3": 25 };

  /* 模式说明行(血量条下方):地图・规模・阵营(仅非 1v1)・玩法
   * 单机 = 开局按本地设置计算;联机 = 快照 match 字段驱动(以 host 为准) */
  const PLAY_NAMES = { tdm: "死斗", rescue: "解救", point: "占点" };
  function matchLabel(m) {
    const parts = [String((m && m.map) || "").split("·")[0],
                   (m && m.mode) || "1v1"];
    if (m && m.mode && m.mode !== "1v1") parts.push(m.team === "coop" ? "团队" : "对抗");
    parts.push(PLAY_NAMES[(m && m.play)] || "死斗");
    return parts.join("・");
  }
  function setLocalMatchText() {
    const s = global.__CQB_MATCH_SETTINGS || {};
    if (hud.modetext) hud.modetext.textContent = matchLabel({
      map: S.md.name, mode: MODE_KEY,
      team: MODE_KEY !== "1v1" ? "coop" : null,   // 单人非 1v1 恒为与队友 Bot 合作
      play: s.playMode || "tdm",
    });
  }
  let S = null;                         // 对局状态(shared 单源,reset 时重建)
  let player = null, bot = null;
  let cam = { x: 0, y: 0, shake: 0 };
  let started = false, over = false, lastT = 0, animId = 0;
  let paused = false, pauseStartedAt = 0;   // 单人暂停:ESC 开关,恢复时平移绝对时间戳
  const keys = {};
  let mouseX = 0, mouseY = 0, firing = false, fireEdge = false;
  let interactEdge = false;
  let pendingReload = false, pendingSwitch = -1;   // 键盘边沿 → 下一帧 inputs 消费

  /* 全队击杀合计(胜利条件按队伍统计) */
  function teamKills(team) {
    let s = 0;
    if (S) for (const f of S.fighters) if (f.team === team) s += f.kills;
    return s;
  }
  /* 对局重建:shared 单源 createState 产出 S;引擎外壳只补玩家/Bot 实体与 HUD */
  function reset() {
    const ms = global.__CQB_MATCH_SETTINGS || {};
    MODE_KEY = ms.mode || "1v1";
    TEAM_SIZE = Math.max(1, parseInt(MODE_KEY, 10) || 1);
    killTarget = KILL_TARGETS[MODE_KEY] || 15;
    const play = ms.playMode || "tdm";
    S = createState(global.__CQB_MAP_KEY, play);
    S.teamTarget = killTarget;                      // 单人 TDM 阈值(联机由 host 下发)
    S.boxSet = new Set((S.md.ammoBoxes || []).map(([x, y]) => x + "," + y));
    netMates = []; netEnemies = [];
    player = makeFighter({ id: "P1", name: "你", x: 0, y: 0, team: 0 });
    S.fighters.push(player);
    /* 队友 Bot(2v2/3v3 补齐我方,1v1 无) */
    let botNo = 0;
    for (let i = 1; i < TEAM_SIZE; i++) {
      botNo++;
      const mate = makeFighter({ id: "B" + botNo, name: "友军·" + i, isBot: true, team: 0 });
      S.fighters.push(mate);
      S.brainById[mate.id] = new BotBrain(S.grid, mate, S.md.rooms, S.doorSet, S.sightGrid);
    }
    /* 敌方 Bot */
    for (let i = 1; i <= TEAM_SIZE; i++) {
      botNo++;
      const enemy = makeFighter({ id: "B" + botNo, name: i === 1 ? "BOT" : "BOT·" + i,
        isBot: true, team: 1 });
      S.fighters.push(enemy);
      S.brainById[enemy.id] = new BotBrain(S.grid, enemy, S.md.rooms, S.doorSet, S.sightGrid);
    }
    bot = S.fighters.find((f) => f.team === 1);   // 兼容联机快照/调试的第一个敌人
    for (const f of S.fighters) spawnFighter(S, f);
    rebuildSightGrid(S);                          // 门开局全关 → 层叠格初始化
    cam = { x: player.x, y: player.y, shake: 0 };
    over = false;
    hud.feed.innerHTML = "";
    setLocalMatchText();
    updateHUD();
    // 注意:此处不隐藏开场面板——它应等待玩家点击「开始行动」
    hud.respawnTxt.classList.add("hidden");
  }

  /* ---- 输入 ---- */
  window.addEventListener("keydown", (e) => {
    keys[e.key.toLowerCase()] = true;
    if (["arrowup","arrowdown","arrowleft","arrowright"].includes(e.key.toLowerCase()))
      e.preventDefault();
    if (e.key === "Escape") {          // 单人暂停开关(联机由 host 权威推进,不提供暂停)
      if (!_remoteMode && started && !over) (paused ? resumeGame() : pauseGame());
      return;
    }
    if (paused) return;                // 暂停中不响应任何对局操作
    if (!started || over) return;
    if (e.key === "r" || e.key === "R") pendingReload = true;
    if (e.key === "f" || e.key === "F") interactEdge = true;
    if (e.key === "1") pendingSwitch = 0;
    if (e.key === "2") pendingSwitch = 1;
    if (e.key === "3") pendingSwitch = 2;
    if (e.key === "e" || e.key === "E") cycleNade();
  });
  /* E 键循环:闪光弹 ↔ 烟雾弹(枪械由 1/2/3 切回) */
  function cycleNade() {
    if (!player) return;
    pendingSwitch = player.weapon === 3 ? 4 : 3;
  }
  window.addEventListener("keyup", (e) => { keys[e.key.toLowerCase()] = false; });
  cv.addEventListener("mousemove", (e) => { mouseX = e.clientX; mouseY = e.clientY; });
  cv.addEventListener("mousedown", (e) => {
    if (paused) return;                // 暂停中不积攒开火边沿
    if (e.button === 0) {
      firing = true; fireEdge = true;
      if (player.protectT > 0) player.protectT = 0;   // 开枪解除保护
    }
  });
  window.addEventListener("mouseup", () => { firing = false; });
  /* 开局/再来一局共用入口(app.js startSolo 会以 $("startBtn").click() 直触) */
  function startMatch() {
    started = true;
    hideOverlay();
    reset();
  }
  hud.startBtn.onclick = startMatch;
  hud.pauseResumeBtn.onclick = () => resumeGame();
  hud.pauseRestartBtn.onclick = () => {
    paused = false;
    hud.pauseMenu.classList.add("hidden");
    startMatch();
  };
  hud.pauseExitBtn.onclick = exitToMenu;

  /* 调试钩子:供无头冒烟测试读取内部状态 */
  Object.defineProperty(global, "__CQB_DEBUG", {
    get() {
      return {
        get started() { return started; },
        get paused() { return paused; },
        get brains() { return S ? S.brainById : {}; },
        get obj() {
          return _remoteMode ? clientObj
            : (S && S.obj && started && !over ? S.obj : null);
        },
        get player() { return player; },
        get bot() { return bot; },
        get fighters() { return S ? S.fighters : []; },
        get tracers() { return S ? S.tracers : []; },
        get flashes() { return S ? S.flashes : []; },
        get grenades() { return S ? S.grenades : []; },
        get smokes() { return S ? S.smokes : []; },
        get cam() { return cam; },
        get zoom() { return ZOOM; },
        get lastPoly() { return lastPoly; },
        get lastTeamVision() { return lastTeamVision; },
        get sightGrid() { return S ? S.sightGrid : []; },
        get netBuf() { return (id) => netBuf.get(id) || []; },
        get netMates() { return netMates; },
        get netEnemies() { return netEnemies; },
        get ripples() { return S ? S.ripples : []; },
        keys,
      };
    },
    configurable: true,
  });

  /* 联机渲染钩子:把 host 的 snapshot 推回闭包变量,renderer 仍走 cqb1 现有 render()
   * - 联机 client 模式下:cqb1 的 update() 内由 __CQB_REMOTE_MODE 短路
   * - 单人模式不受影响(setter 不被调,__CQB_REMOTE_MODE 未设,行为完全一致)
   *
   * 用法:
   *   window.__CQB_PUSH_SNAPSHOT(snap)   // 每收到一份 snapshot 调一次
   *   window.__CQB_REMOTE_MODE = true    // 进入联机模式(放在 CQB_BOOT 之前) */
  let _remoteMode = (global.__CQB_REMOTE_MODE === true);
  Object.defineProperty(global, "__CQB_REMOTE_MODE", {
    get() { return _remoteMode; },
    set(v) { _remoteMode = !!v; },
    configurable: true,
  });
  Object.defineProperty(global, "__CQB_PUSH_SNAPSHOT", {
    configurable: true, writable: true,
    value: (snap) => {
      if (!snap || !S) return;
      // 灌 self → player
      if (snap.self && player) {
        player.hp = snap.self.hp;
        player.alive = snap.self.alive;
        player.weapon = snap.self.weapon;
        player.mags = player.mags ? player.mags.slice() : [30, 12];
        player.mags[snap.self.weapon] = snap.self.mag;   // 快照只带当前武器弹匣,写进对应槽位
        player.reserve = Array.isArray(snap.self.reserve)
          ? [snap.self.reserve[0] ?? 0, snap.self.reserve[1] ?? 0]
          : player.reserve;
        player.kills = snap.self.kills;
        player.deaths = snap.self.deaths;
        player.protectT = snap.self.protectT;
        player.team = snap.self.team ?? player.team;
        /* 名字随快照同步:事件 who/by 是 fighter 名(host 端起),本地占位名("你")
         * 与加入者实际名("玩家2")不同——本人受击/死亡判定按名字匹配,必须一致 */
        player.name = snap.self.name ?? player.name;
        player.deadUntil = 0;          // host 负责死亡计时,client 只看 alive
        /* 位置:自体预测对账(2026-09-05 联机手感包)。
         * 权威位 = host 消费到 snap.self.seq 的输入后的位姿;与本地预测历史比对,
         * 误差一次性并入并 rebase 后续预测(不回弹)。死亡/无 seq(旧包)直接对齐。
         * facing/瞄准由 frame() 本地鼠标计算(更新鲜),不再用快照回写。 */
        const seqOk = typeof snap.self.seq === "number";
        if (!snap.self.alive || !seqOk || !predHistory.length) {
          player.x = snap.self.x;
          player.y = snap.self.y;
          if (!snap.self.alive) predHistory.length = 0;
        } else {
          let hx = null;
          for (let i = predHistory.length - 1; i >= 0; i--)
            if (predHistory[i].seq <= snap.self.seq) { hx = predHistory[i]; break; }
          if (!hx) hx = predHistory[0];
          const ex = snap.self.x - hx.x, ey = snap.self.y - hx.y;
          player.x += ex; player.y += ey;
          for (const h of predHistory) { h.x += ex; h.y += ey; }
        }
        /* 死亡倒计时(2026-09-05 补齐,原联机缺失):host 快照自带 deadUntil(host 时基),
         * 每份快照按剩余折算秒数,30Hz 持续刷新,免跨时基换算 */
        if (!snap.self.alive && snap.self.deadUntil > snap.ts) {
          const left = Math.max(1, Math.ceil((snap.self.deadUntil - snap.ts) / 1000));
          hud.respawnTxt.textContent = "重生中 " + left + "s";
          hud.respawnTxt.classList.remove("hidden");
        } else {
          hud.respawnTxt.classList.add("hidden");
        }
        cam.x = player.x; cam.y = player.y;
      }
      // 灌 enemies[0] → bot(1v1 假设;多敌人需要扩展)
      if (snap.enemies && snap.enemies.length > 0 && bot) {
        const e = snap.enemies[0];
        bot.x = e.x; bot.y = e.y; bot.facing = e.facing;
        bot.hp = e.hp; bot.alive = true;
        bot.weapon = e.weapon;
        bot.mags = [e.mag, 12];
        bot.name = e.name;
        bot.kills = e.kills ?? bot.kills;
      } else if (bot) {
        bot.alive = false;             // 看不见 = 不可见
      }
      // 队友实体(批2 共享视野:整份下发,本地渲染 + 视野并集)
      /* 快照实体不带 r(身体半径):补默认值,否则 drawFighter 的 arc(NaN) 被规范静默跳过,
       * 只剩枪的描边线——“只见枪不见人”(2026-09-05 回归修复) */
      netMates = (snap.mates || []).map((m) => Object.assign({}, m,
        { team: player.team ?? 0, __mate: true, r: m.r ?? PLAYER_R }));
      /* 敌人完整列表(修复:此前只灌 enemies[0],2v2+ 其余敌人只见曳光不见主体;
       * __mate 显式标敌我,不读本地 team 占位值(快照敌人不带 team) */
      netEnemies = (snap.enemies || []).map((e) => Object.assign({}, e,
        { __mate: false, r: e.r ?? PLAYER_R }));
      /* 插值采样:按 id 记录实体位姿流(>500ms 裁剪) */
      const _nowP = performance.now();
      const _feed = (list) => {
        for (const m of list) {
          let a = netBuf.get(m.id);
          if (!a) { a = []; netBuf.set(m.id, a); }
          a.push({ t: _nowP, x: m.x, y: m.y, f: m.facing });
          while (a.length && a[0].t < _nowP - 500) a.shift();
        }
      };
      _feed(netMates); _feed(netEnemies);
      // 门与弹药箱状态(联机同步:host 权威 → 本地网格与箱余量)
      let doorsChanged = false;
      if (Array.isArray(snap.doors) && S.doors.length) {
        snap.doors.forEach((open, i) => {
          const d = S.doors[i];
          if (!d || d.open === !!open) return;
          d.open = !!open;
          S.grid[d.y][d.x] = d.open ? 0 : 1;
          doorsChanged = true;
        });
      }
      if (Array.isArray(snap.boxes)) {
        for (const sb of snap.boxes) {
          const b = S.ammoBoxes[sb.i];
          if (!b) continue;
          b.rifle = sb.r; b.pistol = sb.p;
          /* 剩余补充毫秒(host 时基)→ 本地时基绝对值,渲染层统一用 performance.now() 倒计时 */
          b.respawnAt = sb.t > 0 ? performance.now() + sb.t : 0;
        }
      }
      // S.ripples 覆盖(born 为 host 时间,盖 _recv 本地时基供客户端算 age)
      S.ripples = (snap.ripples || []).map((r) => ({
        x: r.x, y: r.y, born: r.born, r: r.r,
        _recv: performance.now(), who: player.id, net: true,
      }));
      // 曳光/枪口火光:随快照下发,盖 _recv 本地时基(渲染层按 90/50ms 生命周期渐隐)
      S.tracers = (snap.tracers || []).map((t) => Object.assign({}, t, { _recv: performance.now() }));
      S.flashes = (snap.flashes || []).map((f) => Object.assign({}, f, { _recv: performance.now() }));
      // host 事件 → SFX 事件泵 + 本地 UI 副作用(播报/红闪经 eventUiSideEffects,
      // 与单机 pumpStateEvents 同口径;2026-09-05 补齐,原联机只播音效)
      if (Array.isArray(snap.events)) for (const e of snap.events) {
        if (e.t === "hurt") { eventUiSideEffects(e); continue; }   // 受击无音效:红闪+震动足够
        eventUiSideEffects(e);
        EVENTS.push(e);
      }
      // 投掷物/烟雾:盖 _recv 本地时基(烟的绽放/消散动画客户端本地算)
      S.grenades = (snap.grenades || []).map((g) => Object.assign({}, g));
      S.smokes = (snap.smokes || []).map((s) => Object.assign({}, s, { _recv: performance.now() }));
      /* 门/烟变化 → 视线层叠格重建(2026-09-05 修复:此前 client 从不重建——
       * 开门后视野多边形仍被旧门格挡住(看不到门对面)、烟也挡不住 client 视线) */
      const smokeSig = S.smokes.map((s) => ((s.x | 0) + "," + (s.y | 0))).join(";");
      if (doorsChanged || smokeSig !== S._smokeSig) {
        S._smokeSig = smokeSig;
        rebuildSightGrid(S);
      }
      // 闪光:本人白屏按本地朝向/遮挡计算(致盲是各客户端私事)
      for (const e of (snap.events || [])) {
        if (e.t !== "flash" || !player || !player.alive) continue;
        const d = Math.hypot(e.x - player.x, e.y - player.y);
        if (d > FLASH_R) continue;
        if (!losClear(S.sightGrid, e.x, e.y, player.x, player.y)) continue;
        const dir = Math.atan2(e.y - player.y, e.x - player.x);   // 从 player 指向炸点
        const dot = Math.cos(player.facing - dir);
        player.blindUntil = Math.max(player.blindUntil || 0,
          performance.now() + (dot > 0.3 ? FLASH_BLIND_FULL : FLASH_BLIND_BACK));
      }
      // 对局信息:HUD 模式说明行以 host 为准
      if (snap.match && hud.modetext) hud.modetext.textContent = matchLabel(snap.match);
      // HUD 刷新:联机模式 update() 短路,updateHUD 只能由快照推送驱动
      clientObj = snap.obj || null;    // 玩法模式目标状态(host 权威,只读消费)
      for (const e of (snap.events || [])) {
        if (e.t !== "matchover" || over || !player) continue;
        /* 联机对局结束:按己方视角显示结算画面(win/lose/draw) */
        if (e.winner === -1) endOverlay("⚖ 平局", e.text || "", "draw");
        else if (e.winner === player.team) endOverlay("🏆 行动完成", e.text || "", "win");
        else endOverlay("💀 行动失败", e.text || "", "lose");
      }
      updateHUD();
      // S.tracers/S.flashes 由快照整体覆盖,不再沿用上一帧
    },
  });

  /* ---- 战斗流程 ---- */
  function addFeed(text) {
    const div = document.createElement("div");
    div.textContent = text;
    hud.feed.prepend(div);
    setTimeout(() => div.remove(), 4000);
    while (hud.feed.children.length > 4) hud.feed.lastChild.remove();
  }

  /* 事件 → 本地 UI 副作用(单机 pumpStateEvents 与联机 push 快照共用):
   * death → 击杀播报;hurt(本人) → 红闪 + 镜头震动。返回是否本人受击。 */
  function eventUiSideEffects(e) {
    if (e.t === "death") addFeed(e.killer ? (e.killer + " ⚔ " + e.who) : (e.who + " 阵亡"));
    if (e.t === "hurt" && player && e.who === player.name) {
      hud.vignette.style.opacity = "0.85";
      setTimeout(() => (hud.vignette.style.opacity = "0"), 120);
      cam.shake = Math.max(cam.shake, 5);
      return true;
    }
    return false;
  }

  function showRespawn() {
    hud.respawnTxt.textContent = "重生中…";
    hud.respawnTxt.classList.remove("hidden");
  }

  function hideOverlay() {
    hud.center.classList.add("hidden");
  }

  /* ============================ 玩法模式:事件消费(单人本地) ============================
   * 目标推进逻辑单源在 shared(updateObj);引擎只消费 state.events:
   * matchover → 结算画面;hurt(本人) → 红闪/镜头震动;death → 击杀播报。 */
  let clientObj = null;     // 联机快照 obj 字段(仅渲染/HUD 消费)

  /* 把 shared 状态层产生的事件桥接到 app.js 音效泵(EVENTS)与本地 UI 副作用。
   * hurt 只对本人出声/红闪(单机口径;联机客户端由快照事件直推,行为不变) */
  function pumpStateEvents() {
    if (!S || !S.events.length) return;
    const evs = S.events.splice(0);
    for (const e of evs) {
      if (e.t === "hurt") { eventUiSideEffects(e); continue; }   // 受击无音效:红闪+震动足够
      if (e.t === "death") {
        eventUiSideEffects(e);
        if (player && e.who === player.name) showRespawn();
      }
      if (e.t === "matchover") { handleMatchover(e); continue; }
      EVENTS.push(e);
    }
  }
  /* 对局结束:按己方视角显示结算画面(TDM 文案本地生成,目标模式用事件文案) */
  function handleMatchover(e) {
    if (over || !player) return;
    if (e.winner === -1) endOverlay("⚖ 平局", e.text || "", "draw");
    else if (e.winner === player.team) {
      endOverlay("🏆 行动完成",
        e.kind === "tdm"
          ? "击杀 " + teamKills(0) + " · 死亡 " + player.deaths + "<br>敌方已被压制。"
          : (e.text || ""), "win");
    } else {
      endOverlay("💀 行动失败",
        e.kind === "tdm"
          ? "击杀 " + teamKills(0) + " · 死亡 " + player.deaths + "<br>敌方率先达成 " + killTarget + " 杀。"
          : (e.text || ""), "lose");
    }
  }

  function fmtObjTime(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    return String((s / 60) | 0).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
  }
  function objHudText(o) {
    const myTeam = player ? player.team : 0;
    if (o.play === "point") {
      const own = (z) => {
        if (z.owner === -1)
          return z.capTeam !== -1
            ? `${z.capTeam === myTeam ? "我" : "敌"}${Math.floor(z.prog * 100)}%` : "—";
        return z.owner === myTeam ? "我" : "敌";
      };
      return o.zones.map((z) => `${z.name}:${own(z)}`).join("  ")
        + `   比分 ${Math.floor(o.score[0])} : ${Math.floor(o.score[1])}   ${fmtObjTime(o.time)}`;
    }
    let s;
    if (o.stage === "escort") {
      if ((o.carrierTeam ?? 0) === myTeam)
        s = o.zones[1].prog > 0 ? `撤离中 ${Math.floor(o.zones[1].prog * 100)}%` : "护送人质至撤离点";
      else
        s = o.zones[0].prog > 0 ? `押回中 ${Math.floor(o.zones[0].prog * 100)}%`
                                : "敌方正押回人质——阻止携行者!";
    } else {
      s = o.zones[0].prog > 0 ? `引导中 ${Math.floor(o.zones[0].prog * 100)}%` : "营救人质";
    }
    return `${s}   ${fmtObjTime(o.time)}`;
  }

  /* ---- 单人暂停:ESC 开关;恢复时把绝对时间戳整体平移暂停时长 ----  /* ---- 单人暂停:ESC 开关;恢复时把绝对时间戳整体平移暂停时长 ----
   * 所有计时都是 performance.now() 基准的绝对值,不平移则投掷物引信/烟雾时长/
   * 重生倒计时/换弹/致盲/Bot 各计时器会在长时间暂停后瞬间跳完。 */
  function pauseGame() {
    paused = true;
    pauseStartedAt = performance.now();
    for (const k in keys) delete keys[k];   // 防恢复后移动键粘滞
    firing = false; fireEdge = false; interactEdge = false;
    pendingReload = false; pendingSwitch = -1;
    hud.pauseMenu.classList.remove("hidden");
  }
  function resumeGame() {
    shiftTimers(S, performance.now() - pauseStartedAt);
    paused = false;
    hud.pauseMenu.classList.add("hidden");
  }
  /* 回到主菜单:停掉对局并全量重建(reset 清一切计时,无需平移),
   * 恢复"开始行动"按钮后通知应用层显示主菜单(app.js 定义 __CQB_ON_EXIT_TO_MENU) */
  function exitToMenu() {
    paused = false;
    hud.pauseMenu.classList.add("hidden");
    started = false;
    over = false;
    reset();
    restoreStartBtn();
    if (typeof global.__CQB_ON_EXIT_TO_MENU === "function") global.__CQB_ON_EXIT_TO_MENU();
  }

  function endOverlay(title, html, eventType) {
    over = true;
    EVENTS.push({ t: eventType });
    hud.ovTitle.textContent = title;
    hud.ovText.innerHTML = html;
    /* 按钮区整体重建:再来一局 + 回到主菜单(可反复结算,避免残留旧按钮) */
    const old = hud.center.querySelector("button, .btnrow");
    if (old) old.remove();
    const row = document.createElement("div");
    row.className = "btnrow";
    const again = document.createElement("button");
    again.id = "startBtn";
    again.textContent = "再来一局";
    again.onclick = startMatch;
    const exit = document.createElement("button");
    exit.textContent = "回到主菜单";
    exit.onclick = exitToMenu;
    row.appendChild(again);
    row.appendChild(exit);
    hud.center.appendChild(row);
    hud.startBtn = again;
    hud.center.classList.remove("hidden");
  }

  /* 恢复开场"开始行动"单按钮(退出到主菜单后,再入单人走 startBtn.click()) */
  function restoreStartBtn() {
    const old = hud.center.querySelector("button, .btnrow");
    if (old) old.remove();
    const btn = document.createElement("button");
    btn.id = "startBtn";
    btn.textContent = "开始行动";
    btn.onclick = startMatch;
    hud.center.appendChild(btn);
    hud.startBtn = btn;
  }

  /* ---- 主更新 ----
   * 引擎外壳只负责:①把键鼠意图翻译成 inputs[player.id];②调 shared 单源
   * updateFighters 推进全部语义;③消费事件(音效/红闪/播报/结算);④相机/HUD。
   * 联机模式:input/移动/开火/换弹全部由 host 推进,client 不参与(渲染仍每帧跑) */
  function collectInputs() {
    let mx = 0, my = 0;
    if (keys["w"]) my -= 1;
    if (keys["s"]) my += 1;
    if (keys["a"]) mx -= 1;
    if (keys["d"]) mx += 1;
    /* 鼠标 → 世界朝向(相机换算是引擎外壳私事,不进单源) */
    const wx = cam.x - cssW / (2 * ZOOM) + mouseX / ZOOM;
    const wy = cam.y - cssH / (2 * ZOOM) + mouseY / ZOOM;
    const inp = {
      keys: { w: !!keys["w"], a: !!keys["a"], s: !!keys["s"], d: !!keys["d"],
              shift: !!keys["shift"] },
      aim: Math.atan2(wy - player.y, wx - player.x),
      fire: firing, fireEdge: fireEdge,
      reload: pendingReload,
      switch: pendingSwitch >= 0 ? pendingSwitch : undefined,
      interact: interactEdge,
    };
    /* 边沿一次性消费(与联机客户端 resetInputEdges 同口径) */
    fireEdge = false; interactEdge = false;
    pendingReload = false; pendingSwitch = -1;
    return inp;
  }
  function update(now, dt) {
    // 联机模式:input/移动/开火/换弹全部由 host 推进,client 不参与
    // 渲染仍每帧跑(frame() 不短路)
    if (_remoteMode) return;
    if (!S) return;
    const inputs = Object.create(null);
    inputs[player.id] = collectInputs();
    updateFighters(S, inputs, dt, now);   // shared 单源:移动/开火/Bot/投掷物/玩法/特效
    pumpStateEvents();
    /* 重生倒计时 HUD(spawn 由 updateFighters 内的 shared 逻辑完成) */
    if (!player.alive && started && !over) {
      const left = Math.max(1, Math.ceil((player.deadUntil - now) / 1000));
      hud.respawnTxt.textContent = "重生中 " + left + "s";
      hud.respawnTxt.classList.remove("hidden");
    } else {
      hud.respawnTxt.classList.add("hidden");
    }
    // 相机跟随:角色恒居屏幕正中(刚性跟随,地图边缘之外以黑暗呈现)
    cam.x = player.x;
    cam.y = player.y;
    updateHUD();
  }

  /* ---- 主更新 ---- */
  function updateHUD() {
    /* 双队人头比:单人显示两队合计,联机显示自己与可见敌人(快照口径) */
    hud.kills.textContent = player
      ? (_remoteMode ? player.kills : teamKills(0)) : 0;
    if (hud.ekills) {
      hud.ekills.textContent = player
        ? (_remoteMode ? (bot ? bot.kills : 0) : teamKills(1)) : 0;
    }
    /* 个人击杀/死亡计数器(与左 chip 的队伍口径区分,团队模式看自己杀了几何) */
    if (hud.mykills) hud.mykills.textContent = player ? player.kills : 0;
    if (hud.killtarget) hud.killtarget.textContent = killTarget;
    if (hud.killtarget2) hud.killtarget2.textContent = killTarget;
    hud.deaths.textContent = player ? player.deaths : 0;
    /* 玩法模式目标条(死斗隐藏;联机由快照 obj 驱动) */
    if (hud.objbar) {
      const o = _remoteMode ? clientObj
        : (S.obj && started && !over ? S.obj : null);
      if (o) {
        hud.objbar.classList.remove("hidden");
        hud.objtext.textContent = objHudText(o);
      } else {
        hud.objbar.classList.add("hidden");
      }
    }
    if (!player) return;
    const w = WEAPONS[player.weapon];
    hud.wname.textContent = w.name;
    hud.mag.textContent = w.melee ? "—"
      : w.grenade ? (player.nades[w.key] || 0)
      : player.mags[player.weapon];
    if (hud.reserve) {
      hud.reserve.textContent = w.melee ? "∞"
        : w.grenade ? "—"
        : (player.reserve?.[player.weapon] ?? 0);
    }
    const rt = player.reloadEnd - performance.now();
    hud.reloadFill.style.width =
      rt > 0 ? Math.min(100, (1 - rt / w.reloadMs) * 100) + "%" : "0%";
    hud.hpfill.style.width = player.hp + "%";
    hud.hpfill.style.background = player.hp > 50 ? "#5AD07A" :
                                  player.hp > 25 ? "#FFC24B" : "#FF6B6B";
    hud.hptext.textContent = `${player.hp} / 100`;
  }

  /* ============================ 渲染 ============================ */
  const COLORS = {
    floor: "#1B2233", floorLine: "rgba(124,160,255,.05)",
    wall: "#39415A", wallEdge: "#4A5578",
    crate: "#55607A", crateEdge: "#7A86A8",
    half: "rgba(94,208,180,.30)", halfEdge: "rgba(94,208,180,.55)",
    door: "rgba(255,194,75,.28)",
    tracer: "rgba(255,220,150,.9)",
    meleec: "rgba(180,200,255,.5)",
    ripple: "rgba(124,92,255,.35)",
    self: "#E8ECF5", bot: "#FF7B7B", mate: "#6FD98F",
  };

  function worldTransform(c2) {
    c2.setTransform(ZOOM, 0, 0, ZOOM,
      cssW / 2 - cam.x * ZOOM + shakeOX, cssH / 2 - cam.y * ZOOM + shakeOY);
  }
  let shakeOX = 0, shakeOY = 0;

  function drawWorldTiles(view) {
    const { x0, y0, x1, y1 } = view;
    const i0 = Math.max(0, Math.floor(x0 / CELL)), i1 = Math.min(S.md.w - 1, Math.ceil(x1 / CELL));
    const j0 = Math.max(0, Math.floor(y0 / CELL)), j1 = Math.min(S.md.h - 1, Math.ceil(y1 / CELL));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const px = i * CELL, py = j * CELL;
        if (S.grid[j][i] === 1) {
          if (S.doorSet.has(i + "," + j)) {
            /* 关闭的门:琥珀门板 */
            ctx.fillStyle = "#4A3A12";
            ctx.fillRect(px, py, CELL, CELL);
            ctx.fillStyle = "#B8862E";
            ctx.fillRect(px + 4, py + 4, CELL - 8, CELL - 8);
            ctx.strokeStyle = "#12151E";
            ctx.strokeRect(px + 4.5, py + 4.5, CELL - 9, CELL - 9);
          } else {
            const isCrate = S.md.crates.some(([cx, cy]) => cx === i && cy === j);
            ctx.fillStyle = isCrate ? COLORS.crate : COLORS.wall;
            ctx.fillRect(px, py, CELL, CELL);
            ctx.strokeStyle = isCrate ? COLORS.crateEdge : COLORS.wallEdge;
            ctx.strokeRect(px + 1.5, py + 1.5, CELL - 3, CELL - 3);
          }
        } else {
          ctx.fillStyle = COLORS.floor;
          ctx.fillRect(px, py, CELL, CELL);
          if (S.doorSet.has(i + "," + j)) {
            /* 开着的门:地面 + 门框痕迹 */
            ctx.strokeStyle = "rgba(255,194,75,.55)";
            ctx.strokeRect(px + 2.5, py + 2.5, CELL - 5, CELL - 5);
          } else if (S.grid[j][i] === 2) {
            if (S.boxSet.has(i + "," + j)) {
              /* 弹药箱:满=亮+弹药纹,空=暗灰 */
              const bs = S.ammoBoxes.find((b) => b.x === i && b.y === j);
              const full = bs && (bs.rifle > 0 || bs.pistol > 0);
              ctx.fillStyle = full ? "#5E8FB0" : "#2E3644";
              ctx.fillRect(px + 3, py + 3, CELL - 6, CELL - 6);
              ctx.strokeStyle = full ? "#FFC24B" : "#55607A";
              ctx.strokeRect(px + 3.5, py + 3.5, CELL - 7, CELL - 7);
              if (full) {
                ctx.fillStyle = "#FFC24B";
                ctx.fillRect(px + 10, py + 12, CELL - 20, 3);
                ctx.fillRect(px + 10, py + 17, CELL - 20, 3);
              }
            } else {
              ctx.fillStyle = COLORS.half;
              ctx.fillRect(px, py, CELL, CELL);
              ctx.strokeStyle = COLORS.halfEdge;
              ctx.strokeRect(px + 1.5, py + 1.5, CELL - 3, CELL - 3);
            }
          }
        }
      }
    }
  }

  function drawFighter(f, now) {
    ctx.save();
    ctx.translate(f.x, f.y);
    ctx.rotate(f.facing);
    if (f.protectT > 0 && Math.floor(now / 120) % 2 === 0) ctx.globalAlpha = 0.45;
    // 身体(自己=白,队友=绿,敌人=红)
    ctx.fillStyle = f === player ? COLORS.self
      : (_remoteMode ? (f.__mate ? COLORS.mate : COLORS.bot)
      : (f.team === player.team ? COLORS.mate : COLORS.bot));
    ctx.beginPath(); ctx.arc(0, 0, f.r, 0, Math.PI * 2); ctx.fill();
    // 持枪手臂 + 枪
    const w = WEAPONS[f.weapon];
    ctx.strokeStyle = "#12151E"; ctx.lineWidth = 5; ctx.lineCap = "round";
    if (w.melee) {
      ctx.beginPath(); ctx.moveTo(4, 6); ctx.lineTo(f.r + 12, 2); ctx.stroke();
    } else {
      const gl = w.key === "rifle" ? 26 : 17;
      ctx.beginPath(); ctx.moveTo(2, 7); ctx.lineTo(gl, 3); ctx.stroke();
    }
    // 朝向指示
    ctx.strokeStyle = "rgba(255,255,255,.55)"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(0, 0, f.r + 4, -0.42, 0.42); ctx.stroke();
    ctx.restore();
  }

  /* 目标区绘制:地面圈 + 引导进度弧 + 字母;携行者标记(公共情报,雾上) */
  function drawObjOverlay(o) {
    worldTransform(ctx);
    const myTeam = player ? player.team : 0;
    const colOf = (z) => {
      if (o.play === "rescue") {
        if (z.name === "E")
          return (o.stage === "escort" && o.carrierTeam === 0) ? "111,217,143" : "150,155,175";
        return "255,196,75";
      }
      return z.owner === -1 ? "185,190,232" : z.owner === myTeam ? "111,217,143" : "255,92,92";
    };
    const ring = (x, y, r, col) => {
      ctx.strokeStyle = `rgba(${col},.95)`;
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(x, y, 22, 0, Math.PI * 2); ctx.stroke();
    };
    for (const z of o.zones) {
      const col = colOf(z);
      ctx.beginPath(); ctx.arc(z.x, z.y, z.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${col},0.10)`;
      ctx.fill();
      ctx.strokeStyle = `rgba(${col},0.85)`;
      ctx.lineWidth = 2.5;
      ctx.stroke();
      if (z.prog > 0 && z.prog < 1) {
        ctx.strokeStyle = `rgba(${col},1)`;
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.arc(z.x, z.y, z.r - 7, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * z.prog);
        ctx.stroke();
      }
      ctx.fillStyle = `rgba(${col},0.95)`;
      ctx.font = "bold 22px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(z.name, z.x, z.y);
    }
    if (o.play === "rescue") {
      if (o.stage === "escort" && o.carrierTeam === 1 && o.homeH) {
        /* 守方押回:人质房目标圈 + 引导进度弧 */
        ctx.beginPath(); ctx.arc(o.homeH.x, o.homeH.y, ZONE_R, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(255,196,75,0.10)"; ctx.fill();
        ctx.strokeStyle = "rgba(255,196,75,0.85)"; ctx.lineWidth = 2.5; ctx.stroke();
        if (o.zones[0].prog > 0) {
          ctx.strokeStyle = "rgba(255,196,75,1)"; ctx.lineWidth = 4;
          ctx.beginPath();
          ctx.arc(o.homeH.x, o.homeH.y, ZONE_R - 7, -Math.PI / 2,
                  -Math.PI / 2 + Math.PI * 2 * o.zones[0].prog);
          ctx.stroke();
        }
        ctx.fillStyle = "rgba(255,196,75,0.95)";
        ctx.font = "bold 14px system-ui, sans-serif";
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillText("押回", o.homeH.x, o.homeH.y);
      }
      if (!_remoteMode && o.carrierRef && o.carrierRef.alive) {
        ring(o.carrierRef.x, o.carrierRef.y, 22, "255,196,75");
      } else if (_remoteMode) {
        for (const e of netEnemies)
          if (e.alive !== false && e.carrier) ring(e.x, e.y, 22, "255,196,75");
        for (const m of netMates)
          if (m.alive !== false && m.carrier) ring(m.x, m.y, 22, "255,196,75");
      }
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  function render(now) {
    shakeOX = (Math.random() - 0.5) * cam.shake * 2;
    shakeOY = (Math.random() - 0.5) * cam.shake * 2;
    /* 远程实体插值(2026-09-05 联机手感包):按 100ms 延迟时间线在相邻采样间
     * 插值(不外推),写回实体供渲染/队友视野多边形/小地图统一消费 */
    if (_remoteMode) {
      const rt = performance.now() - NET_INTERP_MS;
      const apply = (list) => {
        for (const m of list) {
          const a = netBuf.get(m.id);
          if (!a || !a.length) continue;
          let s0 = a[0], s1 = a[0];
          for (let i = 0; i < a.length; i++) {
            if (a[i].t <= rt) { s0 = a[i]; s1 = a[i]; }
            else { s1 = a[i]; break; }
          }
          let t = (s1.t > s0.t) ? (rt - s0.t) / (s1.t - s0.t) : 0;
          t = Math.max(0, Math.min(1, t));
          m.x = s0.x + (s1.x - s0.x) * t;
          m.y = s0.y + (s1.y - s0.y) * t;
          m.facing = s0.f + normAngle(s1.f - s0.f) * t;
        }
      };
      apply(netMates); apply(netEnemies);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const viewHalfW = cssW / (2 * ZOOM), viewHalfH = cssH / (2 * ZOOM);
    const view = { x0: cam.x - viewHalfW, y0: cam.y - viewHalfH,
                   x1: cam.x + viewHalfW, y1: cam.y + viewHalfH };

    worldTransform(ctx);
    drawWorldTiles(view);

    // 队伍视野多边形:自己 ∪ 存活队友(联机含快照 mates)——共享视野按并集渲染
    // 视线用 S.sightGrid(含烟雾格):烟会真实挖开视野
    const playerPoly = player.alive
      ? visibilityPolygon(S.sightGrid, player.x, player.y, player.facing, VISION_R)
      : [];
    lastPoly = playerPoly;
    const teamViews = [];
    if (player.alive) teamViews.push({ x: player.x, y: player.y, poly: playerPoly });
    if (_remoteMode) {
      for (const m of netMates) {
        if (m.alive === false) continue;
        teamViews.push({ x: m.x, y: m.y,
          poly: visibilityPolygon(S.sightGrid, m.x, m.y, m.facing, VISION_R) });
      }
    } else {
      for (const f of S.fighters) {
        if (f === player || !f.alive || f.team !== player.team) continue;
        teamViews.push({ x: f.x, y: f.y,
          poly: visibilityPolygon(S.sightGrid, f.x, f.y, f.facing, VISION_R) });
      }
    }
    lastTeamVision = teamViews;
    const teamCanSee = (ex, ey) => teamViews.some((v) => {
      const d = Math.hypot(ex - v.x, ey - v.y);
      return d <= NEAR_R || (d < VISION_R && pip(v.poly, ex, ey));
    });

    // 噪波涟漪(仅可见的绘制)
    for (const r of S.ripples) {
      const age = (now - (r._recv ?? r.born)) / 650;
      if (age >= 1) continue;
      if (r.who !== player.id && !teamCanSee(r.x, r.y)) continue;
      const rr = age * (r.r || NOISE_RADIUS);
      ctx.strokeStyle = COLORS.ripple;
      ctx.globalAlpha = 1 - age;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(r.x, r.y, rr, 0, Math.PI * 2); ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // 其他战斗员(队友/敌人):队友共享视野内可见,敌人按队伍视野并集判定
    if (_remoteMode) {
      for (const m of netMates) {
        if (m.alive === false) continue;
        drawFighter(m, now);
      }
      for (const e of netEnemies) {
        if (e.alive === false) continue;
        if (!teamCanSee(e.x, e.y)) continue;   // 快照已按 host 视野剪裁,本地再过滤一次
        drawFighter(e, now);
      }
    } else {
      for (const f of S.fighters) {
        if (f === player || !f.alive) continue;
        if (teamCanSee(f.x, f.y)) drawFighter(f, now);
      }
    }

    // 曳光弹与枪口火光(_recv = 客户端收到时刻,兼容单机 born 本地时基)
    for (const t of S.tracers) {
      const a = Math.max(0, ((t._recv ?? t.t) + 90 - now) / 90);
      ctx.strokeStyle = t.melee ? COLORS.meleec : COLORS.tracer;
      ctx.globalAlpha = a;
      ctx.lineWidth = t.melee ? 3 : 2;
      ctx.beginPath(); ctx.moveTo(t.x1, t.y1); ctx.lineTo(t.x2, t.y2); ctx.stroke();
      ctx.globalAlpha = 1;
    }
    for (const f of S.flashes) {
      const a = Math.max(0, ((f._recv ?? f.t) + 50 - now) / 50);
      ctx.fillStyle = `rgba(255,210,130,${a * 0.9})`;
      ctx.beginPath(); ctx.arc(f.x, f.y, 6 * a + 2, 0, Math.PI * 2); ctx.fill();
    }

    // 飞行中的投掷物(世界层,雾下——看不见的雷不泄露)
    for (const g of S.grenades) {
      ctx.fillStyle = g.type === "flash" ? "#E8ECF5" : "#9FB4C8";
      ctx.beginPath(); ctx.arc(g.x, g.y, 5, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = "rgba(18,21,30,.8)"; ctx.lineWidth = 1.5; ctx.stroke();
    }

    // 自己
    if (player.alive) drawFighter(player, now);

    // ---------- 迷雾 ----------
    fctx.setTransform(1, 0, 0, 1, 0, 0);
    fctx.clearRect(0, 0, cssW, cssH);
    fctx.fillStyle = "rgba(4,6,12,.92)";
    fctx.fillRect(0, 0, cssW, cssH);
    fctx.save();
    worldTransform(fctx);
    fctx.globalCompositeOperation = "destination-out";
    fctx.filter = "blur(7px)";
    fctx.fillStyle = "rgba(255,255,255,1)";
    for (const v of teamViews) {
      if (v.poly.length) {
        fctx.beginPath();
        fctx.moveTo(v.poly[0][0], v.poly[0][1]);
        for (let i = 1; i < v.poly.length; i++) fctx.lineTo(v.poly[i][0], v.poly[i][1]);
        fctx.closePath(); fctx.fill(); fctx.fill();
      }
      fctx.beginPath();
      fctx.arc(v.x, v.y, NEAR_R, 0, Math.PI * 2);
      fctx.fill(); fctx.fill();
    }
    fctx.restore();

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(fogCv, 0, 0);

    // ---------- 烟雾(画在迷雾之上:人在烟中可见烟,烟团遮蔽其覆盖区域) ----------
    for (const s of S.smokes) {
      const age = now - (s._recv ?? s.born);
      let a = 1;
      if (age < 400) a = age / 400;                                   // 绽放
      else if (age > SMOKE_DUR) a = Math.max(0, 1 - (age - SMOKE_DUR) / SMOKE_FADE);  // 消散
      worldTransform(ctx);
      for (const [ox, oy, rr] of [[0, 0, 1], [-0.18, 0.1, 0.72], [0.2, -0.08, 0.66], [0.02, -0.2, 0.5]]) {
        ctx.fillStyle = `rgba(178,188,204,${(0.5 * a).toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(s.x + ox * SMOKE_R, s.y + oy * SMOKE_R, rr * SMOKE_R, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }

    // ---------- 玩法模式目标区(画在迷雾之上:目标是公共情报) ----------
    {
      const o = _remoteMode ? clientObj : (S.obj && started && !over && !paused ? S.obj : null);
      if (o) drawObjOverlay(o);
    }

  /* ---------- 闪光白屏(本人被致盲:透明度随时长衰减) ---------- */
    if (hud.flashwhite) {
      const remain = (player.blindUntil || 0) - now;
      let op = 0;
      if (remain > 0) op = remain > FLASH_FADE ? 1 : remain / FLASH_FADE;
      hud.flashwhite.style.opacity = op.toFixed(2);
    }

    // ---------- 声波指示器(只画给当前玩家自己) ----------
    // 声源在自己视野内 → 看得见不提示;否则朝声源方向画扩散波纹弧:
    // 距离 0~8 格 1 道最亮 / 8~16 格 2 道 / 16~24 格 3 道最淡(能量扩散衰减)
    if (player.alive && started && !over) {
      const cx = cssW / 2, cy = cssH / 2;   // 角色恒居屏幕正中
      for (const r of S.ripples) {
        if (r.who === player.id && !r.net) continue;      // 自己发的声音不提示
        const age = (now - (r._recv ?? r.born)) / 650;
        if (age >= 1) continue;
        const d = Math.hypot(r.x - player.x, r.y - player.y);
        if (d <= NEAR_R || (d < VISION_R && pip(lastPoly, r.x, r.y))) continue;  // 视野内可见
        const tiles = d / CELL;
        const waves = tiles <= 8 ? 1 : tiles <= 16 ? 2 : 3;
        const baseA = waves === 1 ? 0.95 : waves === 2 ? 0.6 : 0.35;
        const ang = Math.atan2(r.y - player.y, r.x - player.x);
        const ARC = 0.55;                              // 每道波弧的角宽(弧度)
        ctx.lineWidth = 2.5;
        for (let k = 1; k <= waves; k++) {
          ctx.strokeStyle = `rgba(164,142,255,${(baseA * (1 - age)).toFixed(3)})`;
          ctx.beginPath();
          ctx.arc(cx, cy, 34 + k * 20, ang - ARC, ang + ARC);
          ctx.stroke();
        }
      }
    }

    // 交互提示(F 开门/关门/拾取弹药)
    if (hud.hint) {
      const t = (player && player.alive && started && !over) ? nearestInteractive(S, player) : null;
      if (!t) {
        hud.hint.classList.add("hidden");
      } else {
        hud.hint.classList.remove("hidden");
        if (t.kind === "door") {
          hud.hint.textContent = t.obj.open ? "F 关门" : "F 开门";
        } else {
          /* 补给文案数据驱动自 shared.BOX_FILL(2026-09-05 修:硬编码旧值
           * 步枪+60/手枪+30 未随补给闭环改版更新——手枪已砍半并新增第三格投掷物) */
          hud.hint.textContent = (t.obj.respawnAt && now < t.obj.respawnAt)
            ? "弹药箱补充中(" + Math.max(1, Math.ceil((t.obj.respawnAt - now) / 1000)) + "s)"
            : "F 拾取补给 (步枪+" + BOX_FILL.rifle + " / 手枪+" + BOX_FILL.pistol
              + " / 投掷物+1)";
        }
      }
    }

    // ---------- 准星 ----------
    if (started && !over && player.alive) {
      const gap = 6 + player.bloom * 260;
      ctx.strokeStyle = "rgba(232,236,245,.95)";
      ctx.lineWidth = 1.6;
      for (const [ax, ay] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        ctx.beginPath();
        ctx.moveTo(mouseX + ax * gap, mouseY + ay * gap);
        ctx.lineTo(mouseX + ax * (gap + 7), mouseY + ay * (gap + 7));
        ctx.stroke();
      }
      ctx.fillStyle = "rgba(232,236,245,.95)";
      ctx.fillRect(mouseX - 1, mouseY - 1, 2, 2);
    }
  }

  /* ---- 主循环 ---- */
  function frame(t) {
    const dt = Math.min(0.05, (t - lastT) / 1000 || 0);
    lastT = t;
    /* 镜头震动衰减:必须在 frame(单机/联机每帧都跑)——原在 update 内,
     * 联机模式 update 短路导致震动只增不减、画面永久疯狂抖动(2026-09-05 修复) */
    cam.shake *= Math.pow(0.001, dt);
    /* 自体移动预测(2026-09-05 联机手感包):client 每帧用与 host 相同的
     * moveCircle 本地推进自己;快照到达时按 seq 对账(见 __CQB_PUSH_SNAPSHOT)。
     * 预测仅位移+瞄准;开火/换弹/受击等仍由 host 权威。 */
    if (_remoteMode && S && player && started && !over && !paused && player.alive) {
      let mx = 0, my = 0;
      if (keys["w"]) my -= 1;
      if (keys["s"]) my += 1;
      if (keys["a"]) mx -= 1;
      if (keys["d"]) mx += 1;
      const len = Math.hypot(mx, my);
      player.movingFast = len > 0 && !keys["shift"];
      if (len > 0) {
        const sp = keys["shift"] ? SHIFT_SPEED : SPEED;
        moveCircle(S.grid, player, (mx / len) * sp * dt, (my / len) * sp * dt);
      }
      /* 瞄准本地化:鼠标世界方位(与 host 消费的 aim 同源,本地更新鲜) */
      const wx = cam.x - cssW / (2 * ZOOM) + mouseX / ZOOM;
      const wy = cam.y - cssH / (2 * ZOOM) + mouseY / ZOOM;
      player.facing = Math.atan2(wy - player.y, wx - player.x);
      predHistory.push({ seq: (global.__CQB_LAST_INPUT_SEQ != null)
        ? global.__CQB_LAST_INPUT_SEQ : -1, x: player.x, y: player.y });
      if (predHistory.length > 90) predHistory.shift();
      cam.x = player.x; cam.y = player.y;
    }
    if (started && !over && !paused) update(performance.now(), dt);
    /* 对局进行中才隐藏系统光标(自绘准星);暂停/结算弹起时恢复,否则用户找不到鼠标 */
    cv.classList.toggle("playing", started && !over && !paused);
    render(performance.now());
    animId = requestAnimationFrame(frame);
  }

  resize();
  reset();
  lastT = performance.now();
  animId = requestAnimationFrame(frame);
}
global.CQB_BOOT = bootBrowser;
if (!global.CQB_NO_AUTOBOOT &&
    typeof window !== "undefined" && typeof document !== "undefined") {
  bootBrowser();
}
})(typeof window !== "undefined" ? window : globalThis);
