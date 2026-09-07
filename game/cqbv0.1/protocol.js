/* CQB 二期 B 批 · 网络协议模块(纯函数,无 DOM 依赖,headless 可测)
 *
 * 职责:
 *   - 消息类型常量
 *   - encode(msg) / decode(raw)  JSON 编解码
 *   - 校验和(防 JSON 序列化中被截断/损坏)
 *   - 房间码生成
 *
 * 使用方式:
 *   const { encode, decode, genRoomCode, MSG, checksum } = require('./protocol');
 *   const wire = encode({ type: MSG.INPUT, seq: 1, keys: {w: true}, aim: 0 });
 *   const msg  = decode(wire);     // { ok: true, msg: {...} } 或 { ok: false, err: 'bad-checksum' }
 *
 * 设计前提(见 DESIGN.md):
 *   - 客户端永远最新版(网页版部署),无版本兼容包袱
 *   - 协议层只关心消息格式,可靠性/排序由通道层负责
 */
(function (global) {
"use strict";

/* 消息类型常量(用数字便于序列化、便于日志分类) */
const MSG = Object.freeze({
  INPUT:    "input",      // 客户端 → 主机:玩家输入意图
  SNAPSHOT: "snapshot",   // 主机 → 客户端:状态快照(30Hz)
  SHOT:     "shot",       // 客户端 → 主机:开火(仅做事件通知,主机在快照前可忽略)
  DEATH:    "death",      // 主机 → 客户端:玩家/Bot 死亡
  RELOAD:   "reload",     // 主机 → 客户端:换弹完成
  JOIN:     "join",       // 主机 → 客户端:新玩家进入
  LEAVE:    "leave",      // 主机 → 客户端:玩家离开
  WEAPON:   "weapon",     // 客户端 → 主机:切枪意图
});

/* 校验和:对字符串做 32-bit FNV-1a 哈希,输出无符号整数。
 * 用途:对消息体的关键数字字段求校验和,接收方校验失败则丢包(说明包在传输/JSON.parse 阶段被破坏)。 */
function checksum(s) {
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/* 编码:消息 → JSON 字符串(末尾追加 "|<checksum>")
 * 协议格式(整段当字符串传输):
 *   { ...msg, _c: <checksum over JSON of msg without _c> }
 * _c 字段本身是 checksum 的载体:decode 时先剥掉 _c,对其余字段重算,比对。
 *
 * 为何不把 checksum 放在消息体外:让 encode/decode 形如 encode({...}) ↔ decode(json),
 * 不需要协议层外的元数据;校验和自然成为消息的一部分。 */
function encode(msg) {
  if (!msg || typeof msg !== "object") throw new TypeError("encode: msg must be object");
  if ("_c" in msg) throw new Error("encode: msg must not contain _c field");
  const body = JSON.stringify(msg);
  const c = checksum(body);
  return JSON.stringify({ ...msg, _c: c });
}

function decode(raw) {
  if (typeof raw !== "string") return { ok: false, err: "non-string" };
  let obj;
  try { obj = JSON.parse(raw); } catch (e) { return { ok: false, err: "parse-failed" }; }
  if (!obj || typeof obj !== "object" || !("_c" in obj)) return { ok: false, err: "no-checksum" };
  if (typeof obj._c !== "number") return { ok: false, err: "bad-checksum-format" };
  const c = obj._c;
  const { _c: _, ...rest } = obj;
  const body = JSON.stringify(rest);
  const expected = checksum(body);
  if (c !== expected) return { ok: false, err: "bad-checksum" };
  return { ok: true, msg: rest };
}

/* 房间号:4 字符大写字母数字,易读易念("cqb-XXXX")
 * 字母剔除 I/O(混淆 1/0),数字剔除 0(混淆 O) */
const ROOM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function genRoomCode() {
  let s = "";
  for (let i = 0; i < 4; i++) {
    s += ROOM_ALPHABET[Math.floor(Math.random() * ROOM_ALPHABET.length)];
  }
  return "cqb-" + s;
}

/* 序列号:monotonic(单玩家),初始化为 0
 * 用于 host 丢旧 input 包:每次发包 seq+1,接收方只接受 seq>lastSeq */
function makeSeqGen() {
  let seq = 0;
  return function next() { return seq++; };
}

const api = { MSG, encode, decode, checksum, genRoomCode, makeSeqGen };
if (typeof module !== "undefined" && module.exports) module.exports = api;
global.CQB_NET = api;
})(typeof window !== "undefined" ? window : globalThis);
