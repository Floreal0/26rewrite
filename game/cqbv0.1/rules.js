/* CQB 引擎核心(纯函数,无 DOM / 无闭包副作用)
 *
 * 设计目标:
 *   - host/client 都能调用同一套状态机
 *   - 单帧更新是纯函数:updateFighters(state, inputs, dt, now) → {state, events}
 *   - 所有时间/随机源都从参数传入,便于测试与确定回放
 *
 * 架构(2026-09-05 双核治理):
 *   - 全部常量与逻辑(纯算法层 + 状态层)单源自 shared.js,本文件只是
 *     联机侧的再导出门面 + 快照生成(buildSnapshot)。
 *   - 单机(engine.js)与联机(rules.js)引用同一函数对象,单源由构造保证,
 *     parity.test.js 第 1 层断言同引用。
 */
(function (global) {
"use strict";

/* 公共纯逻辑核心(单源):几何/射线/视野/寻路/移动碰撞/弹道解算/fighter 工厂/
 * 区域推导 + 状态层(战斗/投掷物/交互/Bot AI/玩法模式/updateFighters/createState)。 */
const SHARED = (typeof require !== "undefined")
  ? require("./shared.js")
  : (global.CQB_SHARED || null);
if (!SHARED) throw new Error("shared.js 未加载:请先于本文件引入");

const MAP_DATA = (typeof require !== "undefined")
  ? require("./maps.js").office
  : (global.CQB_MAPS ? global.CQB_MAPS.office : null);
if (!MAP_DATA) throw new Error("maps.js 未加载:请先于 rules.js 引入 maps.js");

/* ============================ 按人剪裁的 snapshot 生成 ============================
 * 文档规定:每客户端只发自己能看见的实体。
 * 团队模式:敌人的可见性按"全队视野并集"剪裁;队友信息整份下发(位置/血量/战绩)。
 * 调用方:host 在 20Hz 触发,给每个 client 算一份。
 */
function buildSnapshot(state, viewer, allFighters) {
  const self = state.fighters.find((f) => f.id === viewer);
  if (!self) return null;
  const poly = SHARED.visibilityPolygon(state.sightGrid, self.x, self.y, self.facing, SHARED.VISION_R);
  /* 全队(存活成员)视野多边形并集 */
  const members = allFighters.filter((f) => f.alive && f.team === self.team);
  const memberViews = members.map((m) => ({
    x: m.x, y: m.y,
    poly: (m.id === self.id) ? poly
      : SHARED.visibilityPolygon(state.sightGrid, m.x, m.y, m.facing, SHARED.VISION_R),
  }));
  const teamCanSee = (ex, ey) => memberViews.some((v) =>
    Math.hypot(ex - v.x, ey - v.y) <= SHARED.NEAR_R ||
    (Math.hypot(ex - v.x, ey - v.y) < SHARED.VISION_R && SHARED.pip(v.poly, ex, ey)));

  const enemies = [];
  const mates = [];
  const o = state.obj;
  for (const f of allFighters) {
    if (f.id === viewer) continue;
    if (f.team === self.team) {
      /* 队友:整份下发(共享视野下队友位置总是已知);携行者带标记 */
      mates.push({
        id: f.id, x: f.x, y: f.y, hp: f.hp, facing: f.facing,
        weapon: f.weapon, mag: f.mags[f.weapon] ?? 0, name: f.name,
        alive: f.alive, kills: f.kills, deaths: f.deaths,
        carrier: (o && o.play === "rescue" && o.carrierId === f.id) || undefined,
      });
      continue;
    }
    if (!f.alive) continue;
    if (!teamCanSee(f.x, f.y)) continue;
    enemies.push({
      id: f.id, x: f.x, y: f.y, hp: f.hp, facing: f.facing,
      weapon: f.weapon, mag: f.mags[f.weapon] ?? 0, name: f.name,
    });
  }
  /* 解救模式:携行者情报公开——防守方视角强制附带(不受迷雾剪裁) */
  if (o && o.play === "rescue" && o.stage === "escort" && o.carrierId &&
      o.carrierTeam !== self.team && !enemies.some((e) => e.id === o.carrierId)) {
    const c = allFighters.find((f) => f.id === o.carrierId);
    if (c && c.alive) enemies.push({
      id: c.id, x: c.x, y: c.y, hp: c.hp, facing: c.facing,
      weapon: c.weapon, mag: c.mags[c.weapon] ?? 0, name: c.name, carrier: true,
    });
  }
  const ripples = state.ripples
    .filter((r) => r.who !== viewer)
    .map((r) => ({ x: r.x, y: r.y, born: r.born, r: r.r }));
  return {
    type: "snapshot",
    ts: state.now,
    selfId: viewer,
    self: {
      x: self.x, y: self.y, hp: self.hp, weapon: self.weapon,
      mag: self.mags[self.weapon] ?? 0,
      reserve: [self.reserve?.[0] ?? 0, self.reserve?.[1] ?? 0],
      facing: self.facing, kills: self.kills, deaths: self.deaths, name: self.name,
      alive: self.alive, protectT: self.protectT, team: self.team,
      deadUntil: self.deadUntil ?? 0,   // 死亡倒计时(host 时基;alive 时为 0)
    },
    teamTarget: state.teamTarget ?? 15,
    doors: state.doors.map((d) => (d.open ? 1 : 0)),
    /* t = 空箱剩余补充毫秒(host 时基折算剩余量,客户端换成本地时基);满箱为 0 */
    boxes: state.ammoBoxes.map((b) =>
      ({ i: b.i, r: b.rifle, p: b.pistol, t: b.respawnAt ? Math.max(1, b.respawnAt - state.now) : 0 })),
    /* 射击特效:曳光/火光随快照下发(瞬时件,90/50ms 生命周期,30Hz 快照覆盖) */
    tracers: state.tracers.map((t) =>
      ({ x1: t.x1, y1: t.y1, x2: t.x2, y2: t.y2, t: t.t, melee: !!t.melee })),
    flashes: state.flashes.map((f) => ({ x: f.x, y: f.y, t: f.t })),
    /* 投掷物与烟雾:数量少,全量下发 */
    grenades: state.grenades.map((g) =>
      ({ x: g.x, y: g.y, vx: g.vx, vy: g.vy, type: g.type })),
    smokes: state.smokes.map((s) => ({ x: s.x, y: s.y, born: s.born, r: s.r })),
    enemies, mates, ripples, poly,
    /* 玩法模式目标状态(tdm = undefined):host 权威,客户端只读消费 */
    obj: o ? {
      play: o.play, time: o.time,
      score: [Math.floor(o.score[0]), Math.floor(o.score[1])],
      stage: o.stage, carrierId: o.carrierId, carrierTeam: o.carrierTeam,
      homeH: o.homeH,
      zones: o.zones.map((z) => ({
        name: z.name, x: z.x, y: z.y, r: z.r,
        owner: z.owner ?? -1, prog: Math.round(z.prog * 100) / 100, capTeam: z.capTeam ?? -1,
      })),
    } : undefined,
  };
}

/* ============================ 导出 ============================ */
/* 单源再导出:shared 的全部常量与函数 + 本文件特有的 buildSnapshot/MAP_DATA。 */
const api = Object.assign({}, SHARED, { buildSnapshot, MAP_DATA,
  nearestEnemy: SHARED._nearestEnemy, nearestInteractiveSolo: SHARED.nearestInteractive });
if (typeof module !== "undefined" && module.exports) module.exports = api;
global.CQB_RULES = api;
})(typeof window !== "undefined" ? window : globalThis);
