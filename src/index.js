// 수업 관리 — Cloudflare Worker + D1 + static assets + cron
// Secrets: SOLAPI_KEY, SOLAPI_SECRET, SOLAPI_FROM

const enc = new TextEncoder();
const HOUR = 3600 * 1000;
const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const fail = (s, m) => json({ error: m }, s);
const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const rand = (n = 12) => hex(crypto.getRandomValues(new Uint8Array(n)));
const b64u = (s) => btoa(String.fromCharCode(...enc.encode(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)));
const clip = (v, n) => String(v == null ? "" : v).trim().slice(0, n);
const digits = (v) => String(v || "").replace(/\D/g, "");
const cleanKey = (v) => String(v || "").replace(/[^\x21-\x7E]/g, "");
class HttpError extends Error { constructor(s, m) { super(m); this.status = s; } }
const bad = (m) => { throw new HttpError(400, m); };

/* ---------- Korea time helpers ---------- */
const kstNow = () => new Date(Date.now() + 9 * HOUR);
const today = () => kstNow().toISOString().slice(0, 10);
const hhmm = () => kstNow().toISOString().slice(11, 16);
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));
const dow = (d) => new Date(d + "T00:00:00Z").getUTCDay(); // 0=일
const addDays = (d, n) => new Date(Date.parse(d + "T00:00:00Z") + n * 24 * HOUR).toISOString().slice(0, 10);
const weekStart = (d) => addDays(d, -((dow(d) + 6) % 7)); // Monday
const monthStart = (d) => d.slice(0, 8) + "01";
const isLastDay = (d) => addDays(d, 1).slice(8) === "01";
const dLabel = (d) => `${+d.slice(5, 7)}월 ${+d.slice(8)}일(${"일월화수목금토"[dow(d)]})`;

/* ---------- defaults ---------- */
const DEFAULTS = {
  academy: "우리 학원",
  courses: ["중등", "초등 리딩", "초등 파닉스"],
  hwPresets: ["워크북", "단어 암기", "단어 시험 준비", "리딩 녹음", "원서 읽기 + 녹음", "문법 문제", "오답 정리", "숙제 없음"],
  composeTime: "20:00",
  sendTime: "20:30",
  autoSend: true,
  weeklyDay: 5,
  weekly: true,
  monthlyAuto: false, // 월간 리포트도 기본으로 직접 골라서 보내요
  weeklyAuto: false, // 주간 리포트는 기본으로 직접 골라서 보내요
  weeklySkipDay: true, // 주간 리포트에서 기준일(금요일) 수업은 일간 알림톡이 따로 가니 제외
  monthly: true,
  missingAuto: true,
  warnOn: true,
  warnCount: 5,
  warnPart: false,
  missingPart: false,
  notifyIn: false,
  notifyLate: false,
  notifyOut: false,
  phr: {
    greet: ["{학생명} 어머님, 안녕하세요 😊", "오늘 {학생명}의 수업 소식 전해 드려요.", "{학생명} 어머님, 오늘 수업 이야기 들려드릴게요."],
    done: ["숙제도 꼼꼼히 해 왔어요 👍", "숙제를 성실하게 해 와서 칭찬해 주었어요.", "오늘도 숙제 완벽하게 해 왔네요!"],
    part: ["숙제를 조금 덜 해 왔어요. 남은 부분은 다음 시간에 같이 확인할게요.", "숙제를 해 오긴 했는데 조금 아쉬웠어요. 집에서 한 번만 봐 주세요."],
    none: ["다음 시간 전에 숙제 한 번만 챙겨 주시면 감사하겠습니다.", "숙제를 못 해 왔어요. 집에서 함께 챙겨 주시면 큰 도움이 돼요."],
    late: ["조금 늦게 왔지만 끝까지 집중해서 잘 따라왔어요.", "오늘은 조금 늦었지만 수업은 열심히 했어요."],
    out: ["오늘은 결석했어요. 놓친 부분은 다음 시간에 함께 챙길게요.", "오늘 수업에 오지 못했어요. 다음 시간에 보충할게요."],
    close: ["오늘도 믿고 맡겨 주셔서 감사합니다.", "편안한 저녁 보내세요 🙂", "궁금하신 점은 언제든 편하게 연락 주세요."],
    weekGood: ["이번 주 숙제를 정말 성실하게 해 왔어요. 많이 칭찬해 주세요!", "한 주 동안 꾸준히 잘해 줘서 고마운 한 주였어요."],
    weekMid: ["이번 주도 열심히 했어요. 숙제를 조금만 더 챙기면 더 좋아질 거예요.", "꾸준히 잘하고 있어요. 다음 주엔 숙제를 조금 더 함께 챙겨 볼게요."],
    weekLow: ["이번 주는 숙제가 많이 밀렸어요. 집에서 한 번만 같이 챙겨 주세요.", "숙제 습관을 다시 잡을 수 있도록 다음 주에 함께 신경 쓸게요."],
  },
  atpl: {
    in: "{학원}입니다. {학생명} 학생이 {현재 시각}에 학원에 도착했어요. ({반})",
    late: "{학원}입니다. {학생명} 학생이 {현재 시각}에 조금 늦게 도착했어요. ({반} {수업 시간} 수업)",
    out: "{학원}입니다. {학생명} 학생이 오늘 {수업 시간} {반} 수업에 아직 도착하지 않았어요. 결석이라면 학원으로 연락 부탁드려요.",
  },
  tpl: {
    daily: "{학원}입니다.\n{인사}\n\n[{학생명} 오늘 수업 · {날짜}]\n출석: {출석}\n{출석 멘트}\n오늘 배운 내용: {오늘 할 일}\n지난 숙제: {지난 숙제 결과}\n{숙제 멘트}\n오늘 숙제: {숙제}\n다음 수업: {다음 수업}\n선생님 한마디: {선생님 한마디}\n{사진 링크}\n\n{마무리}",
    missing: "{학원}입니다.\n{학생명} 어머님, 숙제 안내드려요. ({날짜})\n\n지난 숙제: {지난 숙제 내용}\n확인 결과: {지난 숙제 결과}\n\n다음 수업 전까지 꼭 해 올 수 있도록 집에서 한 번 챙겨 주세요.\n오늘 숙제: {숙제}",
    warn: "{학원}입니다.\n{학생명} 어머님, 안녕하세요.\n\n최근 숙제를 {누적 횟수}번 해 오지 못했어요.\n({누적 날짜})\n\n집에서 숙제 습관을 한 번 함께 챙겨 주시면 감사하겠습니다.\n궁금하신 점은 편하게 연락 주세요.",
    weekly: "{학원}입니다.\n{인사}\n\n[{학생명} 주간 리포트 · {기간}]\n출석: {출석 요약}\n숙제 완료율: {숙제 완료율}\n이번 주 진도: {진도}\n선생님 코멘트: {코멘트}\n\n{주간 멘트}\n{마무리}",
    monthly: "{학원}입니다.\n{인사}\n\n[{학생명} 월간 리포트 · {기간}]\n출석: {출석 요약}\n숙제 완료율: {숙제 완료율}\n이번 달 진도: {진도}\n선생님 코멘트: {코멘트}\n\n{주간 멘트}\n{마무리}",
  },
  channel: "ata",
  pfId: "",
  ata: {},
  ata2: {},
  style: "basic",
};
const ATT = { in: "출석", late: "지각", out: "결석" };
// 저녁 문자 보류: 이런 날은 메시지를 만들어 두되 자동으로 보내지 않아요 (원장님이 따로 확인하고 보내요)
const HOLD = ["결석", "보강", "결강", "미작성", "auto"]; // auto = 결석이어도 자동 발송
// 결석은 따로 정하지 않으면 자동 발송에서 빠져요
const effHold = (r) => (!r || r.hold === "auto" ? null : r.hold || (r.att === "out" ? "결석" : null));
async function hasMsgs(env, kind, date) { return !!(await getConf(env, `composed:${kind}:${date}`)) || !!(await one(env, "SELECT 1 AS x FROM msgs WHERE kind=? AND date=? LIMIT 1", kind, date)); }
const HW = { done: "완료", part: "미흡", none: "미제출" };

/* ---------- db ---------- */
let ready = null;
function init(env) {
  if (!ready) {
    const q = (s) => env.DB.prepare(s);
    ready = env.DB.batch([
      q("CREATE TABLE IF NOT EXISTS config (k TEXT PRIMARY KEY, v TEXT)"),
      q("CREATE TABLE IF NOT EXISTS teachers (id TEXT PRIMARY KEY, name TEXT NOT NULL, room TEXT, pw TEXT, ver INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0)"),
      q("CREATE TABLE IF NOT EXISTS curricula (id TEXT PRIMARY KEY, name TEXT NOT NULL)"),
      q("CREATE TABLE IF NOT EXISTS lessons (cur TEXT NOT NULL, seq INTEGER NOT NULL, title TEXT, content TEXT, hw TEXT, PRIMARY KEY (cur, seq))"),
      q("CREATE TABLE IF NOT EXISTS classes (id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'group', days TEXT NOT NULL DEFAULT '1,2,3,4,5', time TEXT, teacher TEXT, cur TEXT, start INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0)"),
      q("CREATE TABLE IF NOT EXISTS students (id TEXT PRIMARY KEY, name TEXT NOT NULL, cls TEXT, phone TEXT, cur TEXT, start INTEGER NOT NULL DEFAULT 1, active INTEGER NOT NULL DEFAULT 1)"),
      q("CREATE TABLE IF NOT EXISTS lessonlog (unit TEXT NOT NULL, date TEXT NOT NULL, seq INTEGER, adv INTEGER NOT NULL DEFAULT 1, today TEXT, next TEXT, hw TEXT, by TEXT, at INTEGER, PRIMARY KEY (unit, date))"),
      q("CREATE TABLE IF NOT EXISTS records (sid TEXT NOT NULL, date TEXT NOT NULL, cls TEXT, att TEXT, hwprev TEXT, note TEXT, by TEXT, at INTEGER, PRIMARY KEY (sid, date))"),
      q("CREATE INDEX IF NOT EXISTS records_date ON records(date)"),
      q("CREATE TABLE IF NOT EXISTS msgs (id TEXT PRIMARY KEY, kind TEXT NOT NULL, date TEXT NOT NULL, sid TEXT NOT NULL, text TEXT, edited INTEGER NOT NULL DEFAULT 0, checked INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'draft', err TEXT, at INTEGER, UNIQUE (kind, date, sid))"),
      q("CREATE TABLE IF NOT EXISTS fails (k TEXT PRIMARY KEY, n INTEGER NOT NULL, at INTEGER NOT NULL)"),
      q("CREATE TABLE IF NOT EXISTS media (id TEXT PRIMARY KEY, sid TEXT NOT NULL, date TEXT NOT NULL, type TEXT, mime TEXT, size INTEGER, by TEXT, at INTEGER)"),
      q("CREATE INDEX IF NOT EXISTS media_sd ON media(sid, date)"),
    ]).then(async () => {
      // columns added later; ignore "duplicate column" on databases that already have them
      for (const sql of ["ALTER TABLE curricula ADD COLUMN course TEXT", "ALTER TABLE classes ADD COLUMN course TEXT", "ALTER TABLE curricula ADD COLUMN loop INTEGER NOT NULL DEFAULT 1", "ALTER TABLE lessonlog ADD COLUMN cur TEXT", "ALTER TABLE classes ADD COLUMN rot TEXT", "ALTER TABLE students ADD COLUMN rot TEXT", "ALTER TABLE lessonlog ADD COLUMN ncur TEXT", "ALTER TABLE lessonlog ADD COLUMN nseq INTEGER", "ALTER TABLE msgs ADD COLUMN vars TEXT", "ALTER TABLE msgs ADD COLUMN ata TEXT", "ALTER TABLE msgs ADD COLUMN style TEXT", "ALTER TABLE students ADD COLUMN days TEXT", "ALTER TABLE msgs ADD COLUMN kakao INTEGER NOT NULL DEFAULT 1", "ALTER TABLE msgs ADD COLUMN sends INTEGER NOT NULL DEFAULT 0", "ALTER TABLE records ADD COLUMN hold TEXT", "ALTER TABLE msgs ADD COLUMN hold TEXT", "ALTER TABLE media ADD COLUMN store TEXT"]) await env.DB.prepare(sql).run().catch(() => {});
      // one-time: attendance alerts (등원·지각·결석) off — the daily report already carries 출석
      if (!(await getConf(env, "mig_notify_off"))) {
        const raw = await getConf(env, "settings");
        if (raw) { try { const o = JSON.parse(raw); o.notifyIn = o.notifyLate = o.notifyOut = false; await setConf(env, "settings", JSON.stringify(o)); } catch {} }
        await setConf(env, "mig_notify_off", "1");
      }
    }).catch((e) => { ready = null; throw e; });
  }
  return ready;
}
const one = (env, sql, ...a) => env.DB.prepare(sql).bind(...a).first();
const all = async (env, sql, ...a) => (await env.DB.prepare(sql).bind(...a).all()).results;
const run = (env, sql, ...a) => env.DB.prepare(sql).bind(...a).run();
// "월수금", "화/목", [1,3] → "1,3,5"; nothing → null (= follow the class days)
const DAYCH = { 일: 0, 월: 1, 화: 2, 수: 3, 목: 4, 금: 5, 토: 6 };
function parseDays(v) {
  const l = Array.isArray(v) ? v.map(Number).filter((d) => d >= 0 && d <= 6) : [...String(v || "").replace(/요일/g, "")].filter((ch) => ch in DAYCH).map((ch) => DAYCH[ch]);
  return l.length ? [...new Set(l)].sort().join(",") : null;
}
async function getConf(env, k) { const r = await one(env, "SELECT v FROM config WHERE k=?", k); return r ? r.v : null; }
const setConf = (env, k, v) => run(env, "INSERT INTO config (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", k, v);
async function settings(env) {
  let s = {}; try { s = JSON.parse((await getConf(env, "settings")) || "{}") || {}; } catch {}
  return { ...DEFAULTS, ...s, tpl: { ...DEFAULTS.tpl, ...(s.tpl || {}) }, atpl: { ...DEFAULTS.atpl, ...(s.atpl || {}) }, phr: { ...DEFAULTS.phr, ...(s.phr || {}) } };
}

/* ---------- auth ---------- */
let keyCache = null;
async function hkey(env) {
  if (keyCache) return keyCache;
  let s = await getConf(env, "secret");
  if (!s) { await run(env, "INSERT OR IGNORE INTO config (k,v) VALUES ('secret',?)", rand(32)); s = await getConf(env, "secret"); }
  return (keyCache = await crypto.subtle.importKey("raw", enc.encode(s), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]));
}
async function pwHash(pw, salt = rand(16)) {
  const k = await crypto.subtle.importKey("raw", enc.encode(pw), "PBKDF2", false, ["deriveBits"]);
  return salt + ":" + hex(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: enc.encode(salt), iterations: 2000 }, k, 256));
}
async function pwOk(pw, stored) { if (!stored) return false; return (await pwHash(pw, stored.split(":")[0])) === stored; }
async function makeToken(env, who, ver) {
  const body = b64u(JSON.stringify({ who, v: ver, exp: Date.now() + 30 * 24 * HOUR }));
  return body + "." + hex(await crypto.subtle.sign("HMAC", await hkey(env), enc.encode(body)));
}
async function whoami(env, req) {
  const h = req.headers.get("authorization") || "";
  const [body, sig] = (h.startsWith("Bearer ") ? h.slice(7) : "").split(".");
  if (!body || !sig) return null;
  const want = hex(await crypto.subtle.sign("HMAC", await hkey(env), enc.encode(body)));
  if (want !== sig) return null;
  let p; try { p = JSON.parse(unb64u(body)); } catch { return null; }
  if (!(p.exp > Date.now())) return null;
  if (p.who === "director") {
    if (String(p.v) !== String(await getConf(env, "dver"))) return null;
    return { role: "director", id: "director", name: "원장" };
  }
  const t = await one(env, "SELECT id, name, ver FROM teachers WHERE id=?", p.who);
  if (!t || String(t.ver) !== String(p.v)) return null;
  return { role: "teacher", id: t.id, name: t.name };
}
async function limited(env, k) { const r = await one(env, "SELECT n, at FROM fails WHERE k=?", k); return !!(r && r.n >= 8 && Date.now() - r.at < 30 * 60 * 1000); }
async function bump(env, k) {
  const now = Date.now(), w = 30 * 60 * 1000;
  await run(env, "INSERT INTO fails (k,n,at) VALUES (?,1,?) ON CONFLICT(k) DO UPDATE SET n = CASE WHEN ?-at > ? THEN 1 ELSE n+1 END, at = CASE WHEN ?-at > ? THEN ? ELSE at END", k, now, now, w, now, w, now);
}

/* ---------- curriculum position ---------- */
// A "unit" moves through a curriculum: a group class ("c:<id>") or a private student ("s:<id>").
async function lessonsOf(env, cur) { return cur ? all(env, "SELECT seq, title, content, hw FROM lessons WHERE cur=? ORDER BY seq", cur) : []; }
// Where a unit stands in one curriculum: the lesson after the last one taught from it.
// Old logs without a curriculum id count for the unit's main curriculum (base).
async function positionAt(env, unit, cur, base, start, date) {
  const last = await one(env, "SELECT seq, adv FROM lessonlog WHERE unit=? AND date<? AND seq IS NOT NULL AND (cur=? OR (cur IS NULL AND ?=?)) ORDER BY date DESC LIMIT 1", unit, date, cur || "", cur || "", base || "");
  return last ? last.seq + (last.adv ? 1 : 0) : cur === base ? start || 1 : 1;
}
const lessonText = (l) => (l ? [l.title, l.content].filter(Boolean).join(" · ") : "");
const rotList = (v) => String(v || "").split(",").filter(Boolean);
// One curriculum's state for a unit on a date: its lessons and the lesson that comes up next.
async function progState(env, unit, cur, base, start, date) {
  const c = await one(env, "SELECT id, name, loop FROM curricula WHERE id=?", cur);
  if (!c) return null;
  const ls = await lessonsOf(env, cur);
  let pos = await positionAt(env, unit, cur, base, start, date);
  if (ls.length && !ls.some((l) => l.seq === pos)) {
    const nx = ls.find((l) => l.seq > pos);
    pos = nx ? nx.seq : c.loop ? ls[0].seq : pos;
  }
  return { id: c.id, name: c.name, loop: !!c.loop, lessons: ls, pos };
}
const nextLesson = (p, seq) => (p ? p.lessons.find((l) => l.seq > seq) || (p.loop ? p.lessons[0] : null) : null);
// "다음 수업" text: with a rotation it is the next program in line, otherwise the next lesson
function nextText(progs, rot, cur, seq) {
  const here = progs.find((p) => p.id === cur);
  if (rot.length > 1 && rot.includes(cur)) {
    const nid = rot[(rot.indexOf(cur) + 1) % rot.length], np = progs.find((p) => p.id === nid);
    if (!np) return "";
    const L = nid === cur ? nextLesson(np, seq) : np.lessons.find((l) => l.seq === np.pos);
    return L ? `${np.name} · ${lessonText(L)}` : np.name;
  }
  return lessonText(nextLesson(here, seq));
}
async function unitView(env, unit, base, start, date, rotRaw) {
  const rot = rotList(rotRaw).length ? rotList(rotRaw) : base ? [base] : [];
  const log = await one(env, "SELECT * FROM lessonlog WHERE unit=? AND date=?", unit, date);
  const prev = await one(env, "SELECT date, hw, cur, ncur, nseq FROM lessonlog WHERE unit=? AND date<? ORDER BY date DESC LIMIT 1", unit, date);
  // today's program: what was saved; else what the last class picked as "다음 수업"; else the next in the rotation
  let cur = log ? log.cur || base : null, picked = null;
  if (!cur && prev && prev.ncur) { cur = prev.ncur; picked = prev.nseq; }
  if (!cur && rot.length) {
    const lastCur = prev ? prev.cur || base : null;
    cur = lastCur && rot.includes(lastCur) ? rot[(rot.indexOf(lastCur) + 1) % rot.length] : rot[0];
  }
  const ids = [...new Set([...rot, cur].filter(Boolean))];
  const progs = (await Promise.all(ids.map((id) => progState(env, unit, id, base, start, date)))).filter(Boolean);
  const P = progs.find((p) => p.id === cur) || null;
  const seq = log && log.seq != null ? log.seq : picked != null && P && P.lessons.some((l) => l.seq === picked) ? picked : P ? P.pos : null;
  const L = P ? P.lessons.find((l) => l.seq === seq) : null;
  return {
    unit, saved: !!log, cur: P ? P.id : null, rot, progs,
    lessons: P ? P.lessons : [], loop: P ? P.loop : false, seq, adv: log ? !!log.adv : true,
    today: log ? log.today : L ? (rot.length > 1 ? `${P.name} · ${lessonText(L)}` : lessonText(L)) : P ? (P.lessons.length ? "진도표 끝" : P.name) : "",
    next: log ? log.next : nextText(progs, rot, cur, seq),
    hw: log ? log.hw : (L && L.hw) || "",
    prevHw: prev ? prev.hw || "" : "", prevDate: prev ? prev.date : null,
    ncur: log ? log.ncur || null : null, nseq: log ? log.nseq : null,
  };
}

/* ---------- SMS ---------- */
const bytes = (t) => [...t].reduce((n, c) => n + (c.charCodeAt(0) < 128 ? 1 : 2), 0);
function smsStatus(env) {
  const missing = ["SOLAPI_KEY", "SOLAPI_SECRET", "SOLAPI_FROM"].filter((k) => !env[k]);
  const from = digits(env.SOLAPI_FROM), key = cleanKey(env.SOLAPI_KEY);
  return { ready: !missing.length, missing, from: from ? from.replace(/^(\d{3})(\d+)(\d{4})$/, "$1-****-$3") : "", key: key ? key.slice(0, 4) + "••••" : "", secretLen: cleanKey(env.SOLAPI_SECRET).length };
}
async function solapiAuth(env) {
  const k = await crypto.subtle.importKey("raw", enc.encode(cleanKey(env.SOLAPI_SECRET)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const date = new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), salt = rand(16);
  return `HMAC-SHA256 apiKey=${cleanKey(env.SOLAPI_KEY)}, date=${date}, salt=${salt}, signature=${hex(await crypto.subtle.sign("HMAC", k, enc.encode(date + salt)))}`;
}
function smsMessage(env, to, text, subject, ata) {
  // 알림톡: SOLAPI fills the approved template; if Kakao can't deliver, it sends the same content as 문자
  if (ata) return { to: digits(to), from: digits(env.SOLAPI_FROM), type: "ATA", kakaoOptions: { pfId: ata.pfId, templateId: ata.templateId, variables: ata.variables, disableSms: false } };
  const m = { to: digits(to), from: digits(env.SOLAPI_FROM), text };
  if (bytes(text) > 90) { m.type = "LMS"; m.subject = [...subject].reduce((o, c) => (bytes(o + c) <= 40 ? o + c : o), ""); } else m.type = "SMS";
  return m;
}
const errText = (d, raw, status) => ((d && d.errorCode ? "[" + d.errorCode + "] " : "") + ((d && (d.errorMessage || d.statusMessage)) || raw || "HTTP " + status)).slice(0, 300);
async function sendOne(env, to, text, subject, ata) {
  if (!smsStatus(env).ready) return { ok: false, msg: "솔라피 설정이 아직 없어요" };
  if (!/^01\d{8,9}$/.test(digits(to))) return { ok: false, msg: "받는 번호가 올바르지 않아요" };
  try {
    const res = await fetch("https://api.solapi.com/messages/v4/send", { method: "POST", headers: { "content-type": "application/json", authorization: await solapiAuth(env) }, body: JSON.stringify({ message: smsMessage(env, to, text, subject, ata) }) });
    const raw = await res.text(); let d = null; try { d = JSON.parse(raw); } catch {}
    const code = d && d.statusCode ? String(d.statusCode) : "";
    if (!res.ok || (code && !code.startsWith("2"))) return { ok: false, msg: errText(d, raw, res.status) };
    return { ok: true };
  } catch (e) { return { ok: false, msg: String(e.message || e).slice(0, 300) }; }
}
// Many messages in one request (keeps the Worker under its per-request limits).
async function sendMany(env, list, subject) {
  const out = new Map();
  if (!smsStatus(env).ready) { list.forEach((x) => out.set(x.id, "솔라피 설정이 아직 없어요")); return out; }
  const good = [];
  for (const x of list) { if (/^01\d{8,9}$/.test(digits(x.to))) good.push(x); else out.set(x.id, "학부모 번호가 없거나 올바르지 않아요"); }
  for (let i = 0; i < good.length; i += 500) {
    const chunk = good.slice(i, i + 500);
    try {
      const res = await fetch("https://api.solapi.com/messages/v4/send-many/detail", {
        method: "POST", headers: { "content-type": "application/json", authorization: await solapiAuth(env) },
        body: JSON.stringify({ messages: chunk.map((x) => smsMessage(env, x.to, x.text, subject, x.ata)) }),
      });
      const raw = await res.text(); let d = null; try { d = JSON.parse(raw); } catch {}
      if (!res.ok) { chunk.forEach((x) => out.set(x.id, errText(d, raw, res.status))); continue; }
      const failed = (d && d.failedMessageList) || [];
      const byTo = new Map(); failed.forEach((f) => byTo.set(digits(f.to), (f.statusCode ? "[" + f.statusCode + "] " : "") + (f.statusMessage || "발송 실패")));
      chunk.forEach((x) => out.set(x.id, byTo.get(digits(x.to)) || null));
    } catch (e) { chunk.forEach((x) => out.set(x.id, String(e.message || e).slice(0, 300))); }
  }
  return out;
}

/* ---------- 학생별 사진·영상 (KV, 30일 보관) ---------- */
const MEDIA_TTL = 30 * 24 * 3600, MEDIA_MAX = 20 * 1024 * 1024;
// 긴 영상은 R2(VIDEO)에 조각으로 올려요: 조각 25MB, 한 개 최대 1GB (휴대폰 5분 영상도 충분)
const PART = 25 * 1024 * 1024, VIDEO_MAX = 1024 * 1024 * 1024;
async function mediaSig(env, sid, date) {
  return hex(await crypto.subtle.sign("HMAC", await hkey(env), enc.encode("media:" + sid + ":" + date))).slice(0, 24);
}
async function photoLink(env, s, sid, date) {
  if ((!env.MEDIA && !env.VIDEO) || !s.baseUrl) return "";
  const n = await one(env, "SELECT COUNT(*) AS n FROM media WHERE sid=? AND date=?", sid, date);
  if (!n || !n.n) return "";
  return `${s.baseUrl}/p/${sid}.${date}.${await mediaSig(env, sid, date)}`;
}
const VID_JS = '<script>(function(){function go(v){var u=v.getAttribute("src"),n=v.parentNode.querySelector(".nt");function msg(t){if(!n){n=document.createElement("p");n.className="nt";n.style.cssText="padding:8px 12px;margin:0;font-size:13px";v.parentNode.insertBefore(n,v.nextSibling)}n.textContent=t}var done=false;function blobPlay(){if(done)return;done=true;msg("영상을 내려받아 재생하는 중이에요… 잠시만 기다려 주세요.");fetch(u).then(function(r){if(!r.ok)throw 0;return r.blob()}).then(function(b){v.src=URL.createObjectURL(new Blob([b],{type:b.type||"video/mp4"}));v.load();msg("");}).catch(function(){msg("재생이 안 되면 아래 \'영상 저장하기\'를 눌러 저장한 뒤 갤러리에서 보세요.")})}var t=setTimeout(function(){if(v.readyState<2)blobPlay()},9000);v.addEventListener("loadeddata",function(){clearTimeout(t)});v.addEventListener("error",function(){clearTimeout(t);blobPlay()});}document.querySelectorAll("video").forEach(go)})()</script>';
const PAGE_CSS = "body{margin:0;background:#F6F4EF;color:#1C2433;font-family:-apple-system,'Apple SD Gothic Neo','Malgun Gothic',sans-serif}main{max-width:720px;margin:0 auto;padding:24px 16px 48px}h1{font-size:22px;margin:0 0 4px;letter-spacing:-.02em}p{color:#7C8494;margin:0 0 18px;font-size:14px}figure{margin:0 0 14px;background:#fff;border:1px solid #E3DFD5;border-radius:16px;overflow:hidden}img,video{display:block;width:100%;height:auto;background:#000}a.dl{display:block;text-align:center;padding:10px;font-size:14px;color:#1F7A5C;font-weight:600;text-decoration:none}";
async function photoPage(env, sid, date, sig) {
  const page = (body, st = 200) => new Response(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>오늘 수업 사진</title><style>${PAGE_CSS}</style></head><body><main>${body}</main></body></html>`, { status: st, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "private, max-age=60" } });
  if (!isDate(date) || sig !== (await mediaSig(env, sid, date))) return page("<h1>열 수 없는 링크예요</h1><p>주소가 바뀌었거나 잘못됐어요. 학원에 문의해 주세요.</p>", 404);
  const st = await one(env, "SELECT name FROM students WHERE id=?", sid), s = await settings(env);
  const ms = await all(env, "SELECT id, type FROM media WHERE sid=? AND date=? ORDER BY at", sid, date);
  const items = ms.map((m) => { const src = `/m/${m.id}?t=${sig}`; return m.type === "video" ? `<figure><video src="${src}" controls playsinline preload="metadata"></video><a class="dl" href="${src}" download>영상 저장하기</a></figure>` : `<figure><img src="${src}" alt="수업 사진" loading="lazy"><a class="dl" href="${src}" download>사진 저장하기</a></figure>`; }).join("");
  const esc = (t) => String(t || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  return page(`<h1>${esc(st ? st.name : "")} 오늘 수업</h1><p>${esc(s.academy)} · ${dLabel(date)}${ms.length ? "" : " · 사진 보관 기간(30일)이 지나 지워졌어요."}</p>${items}${VID_JS}`);
}
// 학생별 사진·영상 모아 보기 (최근 30일). 알림톡 버튼 주소: {baseUrl}/g/#{사진코드}
async function gallerySig(env, sid) { return hex(await crypto.subtle.sign("HMAC", await hkey(env), enc.encode("gallery:" + sid))).slice(0, 20); }
async function galleryPage(env, sid, sig) {
  const page = (body, st = 200) => new Response(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>수업 사진·영상</title><style>${PAGE_CSS}h2{font-size:16px;margin:22px 0 10px;color:#4A5263}</style></head><body><main>${body}</main></body></html>`, { status: st, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "private, max-age=60" } });
  if (sig !== (await gallerySig(env, sid))) return page("<h1>열 수 없는 링크예요</h1><p>주소가 바뀌었거나 잘못됐어요. 학원에 문의해 주세요.</p>", 404);
  const st = await one(env, "SELECT name FROM students WHERE id=?", sid), s = await settings(env);
  const ms = await all(env, "SELECT id, type, date FROM media WHERE sid=? AND at > ? ORDER BY date DESC, at", sid, Date.now() - MEDIA_TTL * 1000);
  const esc = (t) => String(t || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  let body = "", last = "";
  for (const m of ms) {
    if (m.date !== last) { body += `<h2>${dLabel(m.date)}</h2>`; last = m.date; }
    const src = `/m/${m.id}?t=${await mediaSig(env, sid, m.date)}`;
    body += m.type === "video" ? `<figure><video src="${src}" controls playsinline preload="metadata"></video><a class="dl" href="${src}" download>영상 저장하기</a></figure>` : `<figure><img src="${src}" alt="수업 사진" loading="lazy"><a class="dl" href="${src}" download>사진 저장하기</a></figure>`;
  }
  return page(`<h1>${esc(st ? st.name : "")} 수업 사진·영상</h1><p>${esc(s.academy)} · 최근 30일${ms.length ? ` · ${ms.length}개` : ""}</p>${body || "<p>아직 올라온 사진·영상이 없어요. 수업 사진이 올라오면 여기서 볼 수 있어요.</p>"}${VID_JS}`);
}

/* ---------- 영상 호환 수리: 갤럭시 영상(hev1)을 아이폰이 읽게 이름표만 hvc1로 고쳐서 내보내요 (파일은 그대로) ---------- */
async function hevcPatches(env, id, size) {
  const key = "hv:" + id, c = await getConf(env, key);
  if (c !== null) { try { return JSON.parse(c); } catch { return []; } }
  const list = []; let ok = false;
  try {
    let off = 0;
    for (let n = 0; n < 64 && off + 8 <= size; n++) {
      const h = await env.VIDEO.get("m/" + id, { range: { offset: off, length: Math.min(16, size - off) } });
      if (!h) break;
      const b = new DataView(await h.arrayBuffer());
      let len = b.getUint32(0);
      const type = String.fromCharCode(b.getUint8(4), b.getUint8(5), b.getUint8(6), b.getUint8(7));
      if (len === 1 && b.byteLength >= 16) len = Number(b.getBigUint64(8)); else if (len === 0) len = size - off;
      if (len < 8) break;
      if (type === "moov") {
        if (len <= 32 * 1048576) {
          const o = await env.VIDEO.get("m/" + id, { range: { offset: off, length: len } });
          const m = new Uint8Array(await o.arrayBuffer());
          for (let i = 0; i + 20 < m.length; i++) if (m[i] === 0x73 && m[i + 1] === 0x74 && m[i + 2] === 0x73 && m[i + 3] === 0x64 && m[i + 16] === 0x68 && m[i + 17] === 0x65 && m[i + 18] === 0x76 && m[i + 19] === 0x31) list.push(off + i + 17);
        }
        ok = true; break;
      }
      off += len;
    }
    if (off + 8 > size) ok = true;
  } catch {}
  if (ok) await setConf(env, key, JSON.stringify(list));
  return list;
}
function patchBody(body, start, list, length) {
  const set = new Map();
  for (const p of list) { set.set(p, 0x76); set.set(p + 1, 0x63); }
  let pos = start;
  const out = body.pipeThrough(new TransformStream({ transform(chunk, ctl) { const end = pos + chunk.length; for (const [p, v] of set) if (p >= pos && p < end) chunk[p - pos] = v; pos = end; ctl.enqueue(chunk); } }));
  return typeof FixedLengthStream === "function" ? out.pipeThrough(new FixedLengthStream(length)) : out; // 길이를 알려 줘야 아이폰이 재생해요
}
async function mediaFile(env, req, id, sig) {
  const m = await one(env, "SELECT * FROM media WHERE id=?", id);
  if (!m || sig !== (await mediaSig(env, m.sid, m.date))) return new Response("없는 파일이에요", { status: 404 });
  if (m.store === "r2") {
    if (!env.VIDEO) return new Response("없는 파일이에요", { status: 404 });
    const obj = await env.VIDEO.get("m/" + id, { range: req.headers });
    if (!obj) return new Response("보관 기간이 지나 지워졌어요", { status: 404 });
    const h = { "content-type": !m.mime || m.mime === "video/quicktime" ? "video/mp4" : m.mime, "accept-ranges": "bytes", "cache-control": "private, max-age=86400", etag: obj.httpEtag };
    const patches = /^video\//.test(h["content-type"]) && req.method !== "HEAD" ? await hevcPatches(env, id, obj.size) : [];
    if (obj.range && req.headers.get("range")) {
      const off = obj.range.offset ?? (obj.range.suffix != null ? obj.size - obj.range.suffix : 0), len = obj.range.length ?? obj.size - off;
      return new Response(patches.length ? patchBody(obj.body, off, patches, len) : obj.body, { status: 206, headers: { ...h, "content-range": `bytes ${off}-${off + len - 1}/${obj.size}`, "content-length": String(len) } });
    }
    return new Response(patches.length ? patchBody(obj.body, 0, patches, obj.size) : obj.body, { headers: { ...h, "content-length": String(obj.size) } });
  }
  if (!env.MEDIA) return new Response("없는 파일이에요", { status: 404 });
  const buf = await env.MEDIA.get("m:" + id, { type: "arrayBuffer", cacheTtl: 3600 });
  if (!buf) return new Response("보관 기간이 지나 지워졌어요", { status: 404 });
  if (/^video\//.test(m.mime || "")) { // 갤럭시 영상(hev1) → 아이폰용 hvc1 이름표
    const u = new Uint8Array(buf); let off = 0;
    for (let n = 0; n < 64 && off + 8 <= u.length; n++) {
      const dv = new DataView(buf, off); let len = dv.getUint32(0); const t = String.fromCharCode(u[off + 4], u[off + 5], u[off + 6], u[off + 7]);
      if (len === 1 && off + 16 <= u.length) len = Number(dv.getBigUint64(8)); else if (len === 0) len = u.length - off;
      if (len < 8) break;
      if (t === "moov") { for (let i = off; i + 20 < off + len && i + 20 < u.length; i++) if (u[i] === 0x73 && u[i + 1] === 0x74 && u[i + 2] === 0x73 && u[i + 3] === 0x64 && u[i + 16] === 0x68 && u[i + 17] === 0x65 && u[i + 18] === 0x76 && u[i + 19] === 0x31) { u[i + 17] = 0x76; u[i + 18] = 0x63; } break; }
      off += len;
    }
  }
  const h = { "content-type": m.mime === "video/quicktime" ? "video/mp4" : m.mime || "application/octet-stream", "accept-ranges": "bytes", "cache-control": "private, max-age=86400" };
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.get("range") || "");
  if (range) {
    const size = buf.byteLength, start = range[1] ? +range[1] : Math.max(0, size - +range[2]), end = range[1] && range[2] ? Math.min(+range[2], size - 1) : size - 1;
    if (start >= size) return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
    return new Response(buf.slice(start, end + 1), { status: 206, headers: { ...h, "content-range": `bytes ${start}-${end}/${size}`, "content-length": String(end - start + 1) } });
  }
  return new Response(buf, { headers: { ...h, "content-length": String(buf.byteLength) } });
}

/* ---------- kakao 알림톡 ---------- */
// The approved template's #{변수} are filled from the same values the 문자 version uses.
const ATA_KINDS = ["daily", "missing", "warn", "weekly", "monthly", "att_in", "att_late", "att_out"];
const ALIAS = {
  "이름": "학생명", "학생": "학생명", "학생이름": "학생명", "원생명": "학생명", "자녀명": "학생명", "학원명": "학원", "학원이름": "학원",
  "수업내용": "오늘할일", "오늘수업": "오늘할일", "배운내용": "오늘할일", "진도내용": "오늘할일", "오늘배운내용": "오늘할일",
  "과제": "숙제", "오늘숙제": "숙제", "다음수업내용": "다음수업", "숙제결과": "지난숙제결과", "숙제확인": "지난숙제결과",
  "한마디": "선생님한마디", "선생님코멘트": "선생님한마디", "출결": "출석", "출석여부": "출석", "일자": "날짜", "수업일": "날짜",
  "시간": "현재시각", "도착시간": "현재시각", "반이름": "반", "클래스": "반", "횟수": "누적횟수", "미제출횟수": "누적횟수", "사진": "사진링크", "사진보기": "사진링크", "링크": "사진주소", "사진url": "사진주소",
  "오늘진도": "수업진도", "오늘의수업진도": "수업진도", "학습": "학습내용", "오늘학습내용": "학습내용", "수업활동": "학습내용",
  "오늘학습": "수업진도", "학습성취": "선생님한마디", "다음학습": "다음수업",
  "전달사항": "선생님한마디", "선생님전달사항": "선생님한마디", "특이사항": "선생님한마디", "숙제안내": "숙제", "숙제내용": "숙제",
};
const nk = (k) => String(k).replace(/\s/g, "");
function ataValue(name, map) {
  const m = {}; for (const k of Object.keys(map)) m[nk(k)] = map[k];
  const n = nk(name);
  let v = n in m ? m[n] : ALIAS[n] in m ? m[ALIAS[n]] : n === "코멘트" && "선생님한마디" in m ? m["선생님한마디"] : undefined;
  // 알림톡은 칸을 비울 수 없어서, 빈 칸은 자연스러운 기본 문장으로 채워요
  const t = ALIAS[n] || n;
  if ((v == null || v === "") && t === "선생님한마디") v = m["기본한마디"];
  // 주간·월간 알림톡 칸 이름이 달라도(예: 학습 기간, 수업 내용 및 진도, 이해도 및 학습 성취, 숙제 수행 현황, 다음 주 학습 계획) 뜻으로 찾아 채워요
  if ((v == null || v === "") && "주간기간" in m) {
    for (const [re, k] of [[/기간/, "주간기간"], [/이해|성취|평가|코멘트|한마디/, "주간이해도"], [/숙제|과제/, "숙제완료율"], [/계획|다음/, "주간다음계획"], [/진도|수업|학습내용/, "진도"]]) if (re.test(n) && k in m && m[k] !== "") { v = m[k]; break; }
  }
  return v == null || v === "" ? "-" : String(v).slice(0, 400);
}
function ataBuild(body, map, btn) {
  const vars = {};
  for (const [, name] of (String(body) + " " + String(btn || "")).matchAll(/#\{([^{}]+)\}/g)) vars[`#{${name}}`] = ataValue(name, map);
  return { vars, text: String(body).replace(/#\{([^{}]+)\}/g, (x) => vars[x]) };
}
// 기본형 = s.ata, 쿠션멘트형 = s.ata2 (both are 알림톡 templates on the same channel); falls back to 기본형.
function ataFor(s, kind, style) {
  if (s.channel !== "ata" || !s.pfId) return null;
  const ok = (a) => a && a.id && a.body ? a : null;
  const st = style || s.style || "basic";
  return st === "cushion" ? ok(s.ata2 && s.ata2[kind]) || ok(s.ata && s.ata[kind]) : ok(s.ata && s.ata[kind]) || ok(s.ata2 && s.ata2[kind]);
}
// The app always sends against the APPROVED template text kept in SOLAPI: each template ID is looked up once
// (and again whenever the ID changes), and its content replaces whatever was pasted, so #{칸} names always match.
async function fetchTemplate(env, id) {
  const res = await fetch("https://api.solapi.com/kakao/v2/templates/" + encodeURIComponent(id), { headers: { authorization: await solapiAuth(env) } });
  const raw = await res.text(); let d = null; try { d = JSON.parse(raw); } catch {}
  if (!res.ok || !d || typeof d.content !== "string") throw new Error(errText(d, raw, res.status));
  return d;
}
async function syncAta(env, s) {
  const notes = [];
  if (!smsStatus(env).ready) return notes;
  let changed = false;
  for (const key of ["ata", "ata2"]) for (const k of Object.keys(s[key] || {})) {
    const a = s[key][k]; if (!a || !a.id || a.ok === a.id + "#2") continue;
    try { const d = await fetchTemplate(env, a.id); a.body = d.content; a.btn = (d.buttons || []).map((x) => [x.linkMo, x.linkPc, x.linkAnd, x.linkIos].filter(Boolean).join(" ")).join(" "); a.ok = a.id + "#2"; changed = true; }
    catch (e) { notes.push(`${k}: ${String(e.message || e).slice(0, 120)}`); }
  }
  if (changed) {
    let raw = {}; try { raw = JSON.parse((await getConf(env, "settings")) || "{}") || {}; } catch {}
    raw.ata = s.ata; raw.ata2 = s.ata2; await setConf(env, "settings", JSON.stringify(raw));
  }
  return notes;
}
function out(s, kind, map, tpl) {
  const a = ataFor(s, kind, s._style);
  if (a && a.id && a.body) { const r = ataBuild(a.body, map, a.btn); return { text: r.text, vars: r.vars, ata: a.id }; }
  return { text: fill(tpl != null ? tpl : s.tpl[kind], map), vars: null, ata: null };
}

/* ---------- report text ---------- */
// Picks one phrase from a list; the same student+date always gets the same phrase, so a re-made preview doesn't change.
function pick(list, seed) {
  const l = (list || []).filter(Boolean);
  if (!l.length) return "";
  let h = 2166136261;
  for (const ch of seed) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return l[(h >>> 0) % l.length];
}
function fill(tpl, map) {
  const sub = (t) => t.replace(/\{([^{}]+)\}/g, (m, k) => (k in map ? map[k] ?? "" : m));
  // a line with {칸} that came out empty (or only "라벨:") is dropped; blank lines you typed stay
  const lines = String(tpl || "").split("\n").flatMap((line) => {
    if (!/\{[^{}]+\}/.test(line)) return [line];
    const out = sub(line);
    return !out.trim() || /^[^:\n]{1,20}:\s*$/.test(out) ? [] : [out];
  });
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
async function prevHwText(env, st, c, date) {
  const unit = c && c.kind === "group" ? "c:" + c.id : "s:" + st.id;
  const p = await one(env, "SELECT hw FROM lessonlog WHERE unit=? AND date<? ORDER BY date DESC LIMIT 1", unit, date);
  return p ? p.hw || "" : "";
}
async function dailyFor(env, s, st, date, kind = "daily") {
  const r = await one(env, "SELECT * FROM records WHERE sid=? AND date=?", st.id, date);
  if (!r) return null;
  const c = st.cls ? await one(env, "SELECT * FROM classes WHERE id=?", st.cls) : null;
  const unit = c && c.kind === "group" ? "c:" + c.id : "s:" + st.id;
  const log = await one(env, "SELECT * FROM lessonlog WHERE unit=? AND date=?", unit, date);
  if (kind === "missing" && !(r.hwprev === "none" || (s.missingPart && r.hwprev === "part"))) return null;
  const sd = st.id + date, base = { "학원": s.academy, "학생명": st.name };
  const P = (k) => fill(pick(s.phr[k], sd + k), base);
  // 학습 내용 = the 진도표 lesson's 수업 내용 column for today's lesson
  const L = log && log.cur && log.seq ? await one(env, "SELECT content FROM lessons WHERE cur=? AND seq=?", log.cur, log.seq) : null;
  const C = log && log.cur ? await one(env, "SELECT name FROM curricula WHERE id=?", log.cur) : null;
  const todayTxt = r.att === "out" ? "" : log ? log.today || "" : "";
  return out(s, kind, {
    // 원장님 템플릿: 오늘의 수업 진도 = 오늘 할 일, 오늘 학습 내용 = 다음 수업 칸 그대로
    "수업 진도": todayTxt,
    "학습 내용": (log && log.next) || "",
    "기본 한마디": r.att === "out" ? "오늘은 결석했어요. 다음 시간에 만나요." : pick(["오늘도 수업에 성실하게 참여했어요.", "오늘도 즐겁게 열심히 참여했어요.", "오늘 수업도 잘 따라왔어요."], sd + "note"),
    "인사": P("greet"), "마무리": P("close"),
    "출석 멘트": r.att === "late" ? P("late") : r.att === "out" ? P("out") : "",
    "숙제 멘트": r.att === "out" ? "" : r.hwprev === "done" ? P("done") : r.hwprev === "part" ? P("part") : r.hwprev === "none" ? P("none") : "",
    "학원": s.academy, "학생명": st.name, "반": c ? c.name : "", "날짜": dLabel(date), "지난 숙제 내용": await prevHwText(env, st, c, date),
    ...(await (async () => { const u = kind === "daily" ? await photoLink(env, s, st.id, date) : ""; return { "사진 링크": u ? "오늘 수업 사진 보기 ▶ " + u : "", "사진 주소": u, "사진코드": `${st.id}.${await gallerySig(env, st.id)}` }; })()),
    "출석": ATT[r.att] || "", "오늘 할 일": r.att === "out" ? "" : log ? log.today : "", "다음 수업": log ? log.next : "",
    "숙제": log ? log.hw : "", "지난 숙제 결과": HW[r.hwprev] || "", "선생님 한마디": r.note || "",
  });
}
// Homework missed since the last warning sent to this parent; a message when it reaches the set count.
async function missCount(env, s, sid, date) {
  const last = await one(env, "SELECT date FROM msgs WHERE kind='warn' AND sid=? AND status='sent' AND date<? ORDER BY date DESC LIMIT 1", sid, date);
  const kinds = s.warnPart ? "('none','part')" : "('none')";
  return all(env, `SELECT date, hwprev FROM records WHERE sid=? AND date<=? AND date>? AND hwprev IN ${kinds} ORDER BY date`, sid, date, last ? last.date : "0000-00-00");
}
async function warnFor(env, s, st, date) {
  const r = await one(env, "SELECT hwprev FROM records WHERE sid=? AND date=?", st.id, date);
  if (!r || !(r.hwprev === "none" || (s.warnPart && r.hwprev === "part"))) return null;
  const miss = await missCount(env, s, st.id, date);
  if (miss.length < Math.max(1, Number(s.warnCount) || 5)) return null;
  const c = st.cls ? await one(env, "SELECT name FROM classes WHERE id=?", st.cls) : null;
  const base = { "학원": s.academy, "학생명": st.name };
  return out(s, "warn", {
    ...base, "반": c ? c.name : "", "날짜": dLabel(date), "인사": fill(pick(s.phr.greet, st.id + date + "greet"), base),
    "마무리": fill(pick(s.phr.close, st.id + date + "close"), base),
    "누적 횟수": String(miss.length), "누적 날짜": miss.map((m) => `${+m.date.slice(5, 7)}/${+m.date.slice(8)}`).join(", "),
  });
}
async function periodFor(env, s, st, from, to, kind) {
  const rs = await all(env, "SELECT * FROM records WHERE sid=? AND date>=? AND date<=? ORDER BY date", st.id, from, to);
  if (!rs.length) return null;
  const c = st.cls ? await one(env, "SELECT * FROM classes WHERE id=?", st.cls) : null;
  const unit = c && c.kind === "group" ? "c:" + c.id : "s:" + st.id;
  const logs = await all(env, "SELECT date, today, next FROM lessonlog WHERE unit=? AND date>=? AND date<=? ORDER BY date", unit, from, to);
  const n = (a) => rs.filter((r) => r.att === a).length;
  const hws = rs.filter((r) => r.hwprev);
  const done = hws.filter((r) => r.hwprev === "done").length;
  const miss = hws.filter((r) => r.hwprev === "none").length;
  const topics = logs.map((l) => l.today).filter(Boolean);
  const prog = topics.length ? (topics.length > 2 ? `${topics[0]} → ${topics[topics.length - 1]} (${topics.length}회 수업)` : topics.join(", ")) : "";
  const sd = st.id + to, base = { "학원": s.academy, "학생명": st.name };
  const P = (k) => fill(pick(s.phr[k], sd + k), base);
  const rate = hws.length ? done / hws.length : null;
  return out(s, kind, {
    "인사": P("greet"), "마무리": P("close"),
    "주간 멘트": rate == null ? "" : rate >= 0.8 ? P("weekGood") : rate >= 0.5 ? P("weekMid") : P("weekLow"),
    "학원": s.academy, "학생명": st.name, "반": c ? c.name : "", "기간": `${+from.slice(5, 7)}/${+from.slice(8)}~${+to.slice(5, 7)}/${+to.slice(8)}`,
    "출석 요약": `출석 ${n("in")}회` + (n("late") ? `, 지각 ${n("late")}회` : "") + (n("out") ? `, 결석 ${n("out")}회` : ""),
    "숙제 완료율": hws.length ? `${Math.round((done / hws.length) * 100)}% (${done}/${hws.length})` + (miss ? `, 미제출 ${miss}회` : "") : "",
    "진도": prog, "코멘트": rs.map((r) => r.note).filter(Boolean).join(" / "),
    "주간 기간": `${+from.slice(5, 7)}/${+from.slice(8)}~${+to.slice(5, 7)}/${+to.slice(8)}`,
    "대상 월": `${+to.slice(0, 4)}년 ${+to.slice(5, 7)}월`,
    "보완 사항": miss ? `숙제 미제출 ${miss}회가 있었어요. 가정에서도 숙제 제출을 함께 챙겨 주세요.` : "특별히 보완할 부분 없이 잘 따라오고 있어요.",
    "주간 이해도": rs.map((r) => r.note).filter(Boolean).join(" / ") || (rate == null ? "" : rate >= 0.8 ? P("weekGood") : rate >= 0.5 ? P("weekMid") : P("weekLow")),
    "주간 다음 계획": [...logs].reverse().map((l) => l.next).find(Boolean) || "",
  });
}
const SUBJECT = { daily: "오늘 수업 안내", missing: "숙제 안내", warn: "숙제 누적 안내", weekly: "주간 리포트", monthly: "월간 리포트" };
function rangeFor(kind, date, s) {
  if (kind === "weekly") return [weekStart(date), s && s.weeklySkipDay ? addDays(date, -1) : date];
  if (kind === "monthly") return [monthStart(date), date];
  return [date, date];
}
async function compose(env, kind, date, opt = {}) {
  const s = await settings(env);
  if (s.channel === "ata") await syncAta(env, s);
  const [from, to] = rangeFor(kind, date, s);
  const sts = await all(env, "SELECT * FROM students WHERE active=1 AND id IN (SELECT DISTINCT sid FROM records WHERE date>=? AND date<=?)", from, to);
  const have = new Map((await all(env, "SELECT id, sid, edited, status, style, hold FROM msgs WHERE kind=? AND date=?", kind, date)).map((m) => [m.sid, m]));
  const holds = new Map((kind === "weekly" && s.weeklySkipDay ? [] : await all(env, "SELECT sid, hold, att FROM records WHERE date=?", date)).map((r) => [r.sid, effHold(r)]));
  const stmts = [];
  let made = 0;
  for (const st of sts) {
    if (opt.only && !opt.only.has(st.id)) continue;
    const m = have.get(st.id);
    if (m && (m.status === "sent" || m.status === "deleted" || (m.edited && !opt.force))) continue;
    if (m && opt.onlyNew) continue;
    const style = (m && m.style) || opt.style || s.style || "basic", sx = { ...s, _style: style };
    const res = kind === "warn" ? await warnFor(env, sx, st, date) : kind === "daily" || kind === "missing" ? await dailyFor(env, sx, st, date, kind) : await periodFor(env, sx, st, from, to, kind);
    const text = res && res.text, vars = res && res.vars ? JSON.stringify(res.vars) : null, ata = res ? res.ata : null;
    if (!text) { if (m && m.status !== "sent" && !m.edited) stmts.push(env.DB.prepare("DELETE FROM msgs WHERE id=?").bind(m.id)); continue; }
    const hold = holds.get(st.id) || null;
    // held → not checked (no auto-send); hold just removed → checked again
    if (m) stmts.push(env.DB.prepare("UPDATE msgs SET text=?, vars=?, ata=?, style=?, edited=0, checked=CASE WHEN ? IS NOT NULL THEN 0 WHEN hold IS NOT NULL AND ?=0 THEN 1 ELSE checked END, hold=? WHERE id=?").bind(text, vars, ata, style, hold, (kind === "weekly" && !s.weeklyAuto) || (kind === "monthly" && !s.monthlyAuto) ? 1 : 0, hold, m.id));
    else stmts.push(env.DB.prepare("INSERT INTO msgs (id, kind, date, sid, text, vars, ata, style, hold, checked) VALUES (?,?,?,?,?,?,?,?,?,?)").bind(rand(), kind, date, st.id, text, vars, ata, style, hold, hold || (kind === "weekly" && !s.weeklyAuto) || (kind === "monthly" && !s.monthlyAuto) ? 0 : 1));
    made++;
  }
  if (stmts.length) await env.DB.batch(stmts);
  return made;
}
async function sendDrafts(env, kind, date, ids) {
  const s = await settings(env);
  const rows = await all(env, `SELECT m.id, m.text, m.vars, m.ata, m.edited, m.kakao, st.phone FROM msgs m JOIN students st ON st.id=m.sid WHERE m.kind=? AND m.date=? AND m.checked=1 AND m.status IN ('draft','failed')`, kind, date);
  const list = rows.filter((r) => !ids || ids.has(r.id)).map((r) => ({ id: r.id, to: r.phone, text: r.text, ata: r.ata && r.vars && !r.edited && r.kakao !== 0 && s.pfId ? { pfId: s.pfId, templateId: r.ata, variables: JSON.parse(r.vars) } : null }));
  if (!list.length) return { sent: 0, failed: 0 };
  const res = await sendMany(env, list, `[${s.academy}] ${SUBJECT[kind]}`);
  const okIds = list.filter((x) => !res.get(x.id)).map((x) => x.id);
  const now = Date.now(), stmts = [];
  if (okIds.length) stmts.push(env.DB.prepare(`UPDATE msgs SET status='sent', err=NULL, at=?, sends=sends+1 WHERE id IN (${okIds.map(() => "?").join(",")})`).bind(now, ...okIds));
  for (const x of list) if (res.get(x.id)) stmts.push(env.DB.prepare("UPDATE msgs SET status='failed', err=?, at=? WHERE id=?").bind(res.get(x.id), now, x.id));
  await env.DB.batch(stmts);
  return { sent: okIds.length, failed: list.length - okIds.length };
}

/* ---------- cron (every 10 minutes) ---------- */
async function tick(env) {
  await init(env);
  const s = await settings(env), d = today(), t = hhmm();
  // 하루 한 번: 30일 지난 사진·영상 정리 (R2는 직접 지워야 해요)
  if (!(await getConf(env, "mclean:" + d))) {
    await setConf(env, "mclean:" + d, "1");
    const old = await all(env, "SELECT id, store FROM media WHERE at < ? LIMIT 500", Date.now() - MEDIA_TTL * 1000);
    for (const m of old) { if (m.store === "r2" && env.VIDEO) await env.VIDEO.delete("m/" + m.id).catch(() => {}); }
    if (old.length) await env.DB.batch(old.map((m) => env.DB.prepare("DELETE FROM media WHERE id=?").bind(m.id)));
  }
  const kinds = ["daily"];
  if (s.missingAuto) kinds.push("missing");
  if (s.warnOn) kinds.push("warn");
  if (s.weekly && dow(d) === Number(s.weeklyDay)) kinds.push("weekly");
  if (s.monthly && isLastDay(d)) kinds.push("monthly");
  for (const k of kinds) {
    if (t >= s.composeTime && !(await getConf(env, `composed:${k}:${d}`))) {
      await compose(env, k, d);
      await setConf(env, `composed:${k}:${d}`, "1");
    }
    if (s.autoSend && (k !== "weekly" || s.weeklyAuto) && (k !== "monthly" || s.monthlyAuto) && t >= s.sendTime && !(await getConf(env, `sent:${k}:${d}`))) {
      await compose(env, k, d, { onlyNew: true }); // records saved after the preview was made
      await sendDrafts(env, k, d);
      await setConf(env, `sent:${k}:${d}`, "1");
    }
  }
}

/* ---------- permission helpers ---------- */
async function myClasses(env, me) {
  return me.role === "director"
    ? all(env, "SELECT * FROM classes ORDER BY sort, name")
    : all(env, "SELECT * FROM classes WHERE teacher=? ORDER BY sort, name", me.id);
}
async function canClass(env, me, cid) {
  if (me.role === "director") return true;
  const c = await one(env, "SELECT teacher FROM classes WHERE id=?", cid);
  return !!(c && c.teacher === me.id);
}
const director = (me) => { if (me.role !== "director") throw new HttpError(403, "원장님만 할 수 있어요."); };

/* ---------- API ---------- */
async function api(req, env, path) {
  await init(env);
  const M = req.method, url = new URL(req.url);
  const body = async () => (M === "GET" ? {} : await req.json().catch(() => ({})));

  if (path === "/api/auth/state") {
    const t = await all(env, "SELECT id, name, room FROM teachers ORDER BY sort, name");
    return json({ setup: !!(await getConf(env, "dpw")), people: [{ id: "director", name: "원장" }, ...t] });
  }
  if (path === "/api/auth/setup" && M === "POST") {
    if (await getConf(env, "dpw")) return fail(409, "이미 원장 비밀번호가 있어요.");
    const b = await body(), pw = String(b.password || ""), academy = clip(b.academy, 30);
    if (!academy) return fail(400, "학원 이름을 입력해 주세요.");
    if (pw.length < 6) return fail(400, "비밀번호는 6자 이상으로 정해 주세요.");
    const r = await run(env, "INSERT OR IGNORE INTO config (k,v) VALUES ('dpw',?)", await pwHash(pw));
    if (!r.meta.changes) return fail(409, "이미 원장 비밀번호가 있어요.");
    await setConf(env, "dver", "1");
    { const old = await getConf(env, "settings"), cur = old ? JSON.parse(old) : {}; await setConf(env, "settings", JSON.stringify({ ...cur, academy })); }
    return json({ token: await makeToken(env, "director", "1") });
  }
  if (path === "/api/auth/login" && M === "POST") {
    const b = await body(), who = String(b.who || "");
    if (await limited(env, "login:" + who)) return fail(429, "비밀번호를 여러 번 틀렸어요. 30분 뒤에 다시 해 주세요.");
    let ok = false, ver = null;
    if (who === "director") { ok = await pwOk(String(b.password || ""), await getConf(env, "dpw")); ver = await getConf(env, "dver"); }
    else { const t = await one(env, "SELECT pw, ver FROM teachers WHERE id=?", who); ok = !!t && (await pwOk(String(b.password || ""), t.pw)); ver = t && t.ver; }
    if (!ok) { await bump(env, "login:" + who); return fail(401, "비밀번호가 맞지 않아요."); }
    await run(env, "DELETE FROM fails WHERE k=?", "login:" + who);
    return json({ token: await makeToken(env, who, ver) });
  }

  const me = await whoami(env, req);
  if (!me) return fail(401, "다시 로그인해 주세요.");
  if (path === "/api/me") {
    const s0 = await settings(env), origin = url.origin;
    if (!/localhost|127\.0\.0\.1/.test(origin) && s0.baseUrl !== origin) await setConf(env, "settings", JSON.stringify({ ...JSON.parse((await getConf(env, "settings")) || "{}"), baseUrl: origin }));
  }
  if (path === "/api/me") return json({ me, today: today(), sms: smsStatus(env), settings: await settings(env) });

  /* ----- day view ----- */
  if (path === "/api/day" && M === "GET") {
    const date = isDate(url.searchParams.get("date")) ? url.searchParams.get("date") : today();
    const all_ = url.searchParams.get("all") === "1";
    // a student with own days comes only on those days; others follow the class days
    const dd = String(dow(date)), onDay = (days) => String(days || "").split(",").includes(dd);
    const own = await all(env, "SELECT cls, days FROM students WHERE active=1 AND days IS NOT NULL");
    const cls = (await myClasses(env, me)).filter((c) => all_ || onDay(c.days) || own.some((x) => x.cls === c.id && onDay(x.days)));
    const out = [];
    for (const c of cls) {
      const sts = (await all(env, "SELECT id, name, phone, cur, start, days FROM students WHERE cls=? AND active=1 ORDER BY name", c.id)).filter((st) => all_ || (st.days ? onDay(st.days) : onDay(c.days)));
      if (!sts.length && !all_) continue;
      const recs = new Map((await all(env, `SELECT * FROM records WHERE date=? AND sid IN (SELECT id FROM students WHERE cls=?)`, date, c.id)).map((r) => [r.sid, r]));
      const group = c.kind === "group";
      const unit = group ? await unitView(env, "c:" + c.id, c.cur, c.start, date, c.rot) : null;
      const students = [];
      for (const st of sts) students.push({ id: st.id, name: st.name, hasPhone: !!st.phone, rec: recs.get(st.id) || null, cur: st.cur || c.cur || null, unit: group ? null : await unitView(env, "s:" + st.id, st.cur || c.cur, st.start, date, st.rot || (st.cur ? null : c.rot)) });
      out.push({ id: c.id, name: c.name, kind: c.kind, time: c.time, course: c.course || null, cur: c.cur || null, unit, students, saved: students.some((s) => s.rec) });
    }
    const am = await all(env, "SELECT sid, kind, status, err FROM msgs WHERE date=? AND kind LIKE 'att_%'", date);
    const amap = {}; for (const x of am) (amap[x.sid] = amap[x.sid] || []).push(x);
    for (const c of out) for (const st of c.students) st.alerts = amap[st.id] || [];
    // 오늘 학부모 리포트 상태 (전송됨 / 실패 / 대기 / 따로 보내기)
    const dm = new Map((await all(env, "SELECT sid, status, err, hold, checked, at FROM msgs WHERE date=? AND kind='daily' AND status!='deleted'", date)).map((x) => [x.sid, x]));
    for (const c of out) for (const st of c.students) st.daily = dm.get(st.id) || null;
    const md = await all(env, "SELECT id, sid, type FROM media WHERE date=? ORDER BY at", date);
    for (const c of out) for (const st of c.students) {
      const mine = md.filter((m) => m.sid === st.id);
      st.media = mine.map((m) => ({ id: m.id, type: m.type }));
      st.mediaSig = await mediaSig(env, st.id, date);
    }
    const la = {};
    for (const l of await all(env, "SELECT cur, seq, title, content FROM lessons ORDER BY cur, seq LIMIT 3000")) (la[l.cur] = la[l.cur] || []).push({ seq: l.seq, title: l.title, content: l.content });
    return json({ date, media: !!(env.MEDIA || env.VIDEO), bigVideo: !!env.VIDEO, classes: out, curricula: await all(env, "SELECT id, name, course FROM curricula ORDER BY name"), lessonsAll: la });
  }
  if (path === "/api/attend" && M === "POST") {
    const b = await body();
    if (!isDate(b.date)) bad("날짜를 확인해 주세요.");
    const st = await one(env, "SELECT * FROM students WHERE id=?", String(b.sid || ""));
    if (!st || !st.cls || !(await canClass(env, me, st.cls))) return fail(403, "이 학생을 볼 수 없어요.");
    const c = await one(env, "SELECT * FROM classes WHERE id=?", st.cls);
    const att = ATT[b.att] ? b.att : null;
    if (att) await run(env, "INSERT INTO records (sid, date, cls, att, by, at) VALUES (?,?,?,?,?,?) ON CONFLICT(sid, date) DO UPDATE SET att=excluded.att, cls=excluded.cls, by=excluded.by, at=excluded.at", st.id, b.date, c.id, att, me.name, Date.now());
    else await env.DB.batch([env.DB.prepare("DELETE FROM records WHERE sid=? AND date=? AND hwprev IS NULL AND (note IS NULL OR note='') AND hold IS NULL").bind(st.id, b.date), env.DB.prepare("UPDATE records SET att=NULL WHERE sid=? AND date=?").bind(st.id, b.date)]);
    for (const k of ["daily", "missing"]) if (await hasMsgs(env, k, b.date)) await compose(env, k, b.date, { only: new Set([st.id]) });
    // instant parent alert (today only, once per kind per day)
    const s = await settings(env), on = { in: s.notifyIn, late: s.notifyLate, out: s.notifyOut };
    let sms = null;
    // 결강·보강·미작성으로 표시된 학생에게는 "도착하지 않았어요" 같은 즉시 알림을 보내지 않아요
    const rec0 = await one(env, "SELECT hold FROM records WHERE sid=? AND date=?", st.id, b.date);
    const holdNow = HOLD.includes(b.hold) ? b.hold : rec0 ? rec0.hold : null;
    const skipAlert = ["결강", "미작성", "보강"].includes(holdNow);
    if (att && on[att] && b.date === today() && st.phone && !skipAlert) {
      const kind = "att_" + att;
      const ins = await run(env, "INSERT OR IGNORE INTO msgs (id, kind, date, sid, text, status) VALUES (?,?,?,?,?, 'draft')", rand(), kind, b.date, st.id, "");
      if (ins.meta.changes) {
        const o = out(s, kind, { "학원": s.academy, "학생명": st.name, "반": c.name, "수업 시간": c.time || "", "날짜": dLabel(b.date), "현재 시각": hhmm(), "출석": ATT[att], "인사": fill(pick(s.phr.greet, st.id + b.date + "greet"), { "학원": s.academy, "학생명": st.name }), "마무리": fill(pick(s.phr.close, st.id + b.date + "close"), { "학원": s.academy, "학생명": st.name }) }, s.atpl[att]);
        const text = o.text;
        const r = await sendOne(env, st.phone, text, `[${s.academy}] 출결 안내`, o.ata ? { pfId: s.pfId, templateId: o.ata, variables: o.vars } : null);
        await run(env, "UPDATE msgs SET text=?, status=?, err=?, at=? WHERE kind=? AND date=? AND sid=?", text, r.ok ? "sent" : "failed", r.ok ? null : r.msg, Date.now(), kind, b.date, st.id);
        sms = r.ok ? "sent" : r.msg;
      } else sms = "already";
    }
    return json({ ok: true, sms });
  }
  if (path === "/api/media" && M === "POST") {
    if (!env.MEDIA) return fail(400, "사진 저장 공간이 연결되지 않았어요.");
    const sid = url.searchParams.get("sid"), date = url.searchParams.get("date");
    const st = await one(env, "SELECT * FROM students WHERE id=?", String(sid || ""));
    if (!st || !st.cls || !isDate(date) || !(await canClass(env, me, st.cls))) return fail(403, "이 학생에게 올릴 수 없어요.");
    const mime = (req.headers.get("content-type") || "").split(";")[0];
    const type = mime.startsWith("video/") ? "video" : mime.startsWith("image/") ? "image" : null;
    if (!type) return fail(400, "사진이나 영상만 올릴 수 있어요.");
    const len = +(req.headers.get("content-length") || 0);
    if (len > MEDIA_MAX) return fail(413, "파일이 너무 커요. 영상은 20MB(1분 정도)까지 올릴 수 있어요.");
    const buf = await req.arrayBuffer();
    if (buf.byteLength > MEDIA_MAX) return fail(413, "파일이 너무 커요. 영상은 20MB(1분 정도)까지 올릴 수 있어요.");
    const n = await one(env, "SELECT COUNT(*) AS n FROM media WHERE sid=? AND date=?", st.id, date);
    if (n.n >= 20) return fail(400, "하루에 학생당 20개까지 올릴 수 있어요.");
    const id = rand(10);
    await env.MEDIA.put("m:" + id, buf, { expirationTtl: MEDIA_TTL });
    await run(env, "INSERT INTO media (id, sid, date, type, mime, size, by, at) VALUES (?,?,?,?,?,?,?,?)", id, st.id, date, type, mime, buf.byteLength, me.name, Date.now());
    // keep an unsent daily preview in step (adds the photo link)
    if (await getConf(env, `composed:daily:${date}`)) await compose(env, "daily", date, { only: new Set([st.id]) });
    return json({ ok: true, id, type, sig: await mediaSig(env, st.id, date) });
  }
  // 큰 영상: start → part(여러 번) → finish
  if (path.startsWith("/api/media/") && ["/api/media/start", "/api/media/part", "/api/media/finish", "/api/media/abort"].includes(path)) {
    if (!env.VIDEO) return fail(400, "긴 영상 저장소(R2)가 아직 연결되지 않았어요. 영상은 1분(20MB)까지만 올릴 수 있어요.");
    const q = path === "/api/media/part" ? Object.fromEntries(url.searchParams) : await body();
    const st = await one(env, "SELECT * FROM students WHERE id=?", String(q.sid || ""));
    if (!st || !st.cls || !isDate(q.date) || !(await canClass(env, me, st.cls))) return fail(403, "이 학생에게 올릴 수 없어요.");
    const key = "m/" + String(q.id || "").replace(/[^a-z0-9]/gi, "");
    if (path === "/api/media/start") {
      const mime = String(q.mime || "").split(";")[0];
      if (!mime.startsWith("video/") && !mime.startsWith("image/")) return fail(400, "사진이나 영상만 올릴 수 있어요.");
      if (!(q.size > 0) || q.size > VIDEO_MAX) return fail(413, "영상이 너무 커요. 1GB(휴대폰 영상 약 5분)까지 올릴 수 있어요.");
      const n = await one(env, "SELECT COUNT(*) AS n FROM media WHERE sid=? AND date=?", st.id, q.date);
      if (n.n >= 20) return fail(400, "하루에 학생당 20개까지 올릴 수 있어요.");
      const id = rand(10), up = await env.VIDEO.createMultipartUpload("m/" + id, { httpMetadata: { contentType: mime } });
      return json({ id, uploadId: up.uploadId, partSize: PART });
    }
    const up = env.VIDEO.resumeMultipartUpload(key, String(q.uploadId || ""));
    if (path === "/api/media/part") {
      const part = await up.uploadPart(Math.max(1, Number(q.n) || 1), await req.arrayBuffer());
      return json({ partNumber: part.partNumber, etag: part.etag });
    }
    if (path === "/api/media/abort") { await up.abort().catch(() => {}); return json({ ok: true }); }
    const obj = await up.complete((q.parts || []).map((x) => ({ partNumber: Number(x.partNumber), etag: String(x.etag) })));
    const mime = String(q.mime || "").split(";")[0], id = key.slice(2);
    await run(env, "INSERT INTO media (id, sid, date, type, mime, size, by, at, store) VALUES (?,?,?,?,?,?,?,?,?)", id, st.id, q.date, mime.startsWith("video/") ? "video" : "image", mime, obj.size, me.name, Date.now(), "r2");
    if (await getConf(env, `composed:daily:${q.date}`)) await compose(env, "daily", q.date, { only: new Set([st.id]) });
    return json({ ok: true, id, type: mime.startsWith("video/") ? "video" : "image", sig: await mediaSig(env, st.id, q.date) });
  }
  if (path === "/api/media/delete" && M === "POST") {
    const b = await body(), m = await one(env, "SELECT m.*, st.cls FROM media m JOIN students st ON st.id=m.sid WHERE m.id=?", String(b.id || ""));
    if (!m || !(await canClass(env, me, m.cls))) return fail(403, "지울 수 없어요.");
    if (m.store === "r2") { if (env.VIDEO) await env.VIDEO.delete("m/" + m.id); }
    else if (env.MEDIA) await env.MEDIA.delete("m:" + m.id);
    await run(env, "DELETE FROM media WHERE id=?", m.id);
    if (await getConf(env, `composed:daily:${m.date}`)) await compose(env, "daily", m.date, { only: new Set([m.sid]) });
    return json({ ok: true });
  }
  if (path === "/api/unitprog") {
    const unit = String(url.searchParams.get("unit") || ""), cur = url.searchParams.get("cur"), date = url.searchParams.get("date");
    if (!isDate(date) || !/^[cs]:/.test(unit)) bad("요청을 확인해 주세요.");
    let base = null, start = 1, cls = null;
    if (unit.startsWith("c:")) { const c = await one(env, "SELECT * FROM classes WHERE id=?", unit.slice(2)); if (c) { base = c.cur; start = c.start; cls = c.id; } }
    else { const st = await one(env, "SELECT * FROM students WHERE id=?", unit.slice(2)); if (st) { cls = st.cls; const c = cls ? await one(env, "SELECT cur FROM classes WHERE id=?", cls) : null; base = st.cur || (c && c.cur); start = st.start; } }
    if (!cls || !(await canClass(env, me, cls))) return fail(403, "볼 수 없어요.");
    return json({ prog: await progState(env, unit, cur, base, start, date) });
  }
  if (path === "/api/student/cur" && M === "POST") {
    const b = await body();
    const st = await one(env, "SELECT * FROM students WHERE id=?", String(b.id || ""));
    if (!st || !st.cls || !(await canClass(env, me, st.cls))) return fail(403, "이 학생을 바꿀 수 없어요.");
    const cur = b.cur ? await one(env, "SELECT id FROM curricula WHERE id=?", b.cur) : null;
    await run(env, "UPDATE students SET cur=?, start=? WHERE id=?", cur ? cur.id : null, Math.max(1, Number(b.start) || 1), st.id);
    return json({ ok: true });
  }
  if (path === "/api/day" && M === "POST") {
    const b = await body();
    if (!isDate(b.date)) bad("날짜를 확인해 주세요.");
    if (!(await canClass(env, me, b.classId))) return fail(403, "이 반을 볼 수 없어요.");
    const c = await one(env, "SELECT * FROM classes WHERE id=?", b.classId);
    const valid = new Set((await all(env, "SELECT id FROM students WHERE cls=?", c.id)).map((x) => x.id));
    const now = Date.now(), stmts = [];
    for (const u of b.units || []) {
      const okUnit = (c.kind === "group" && u.unit === "c:" + c.id) || (u.unit.startsWith("s:") && valid.has(u.unit.slice(2)));
      if (!okUnit) continue;
      const seq = Number.isInteger(u.seq) ? u.seq : null;
      stmts.push(env.DB.prepare("INSERT INTO lessonlog (unit, date, seq, adv, today, next, hw, by, at, cur, ncur, nseq) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(unit, date) DO UPDATE SET seq=excluded.seq, adv=excluded.adv, today=excluded.today, next=excluded.next, hw=excluded.hw, by=excluded.by, at=excluded.at, cur=excluded.cur, ncur=excluded.ncur, nseq=excluded.nseq")
        .bind(u.unit, b.date, seq, u.adv ? 1 : 0, clip(u.today, 300), clip(u.next, 300), clip(u.hw, 500), me.name, now, u.cur ? String(u.cur).slice(0, 20) : null, u.ncur ? String(u.ncur).slice(0, 20) : null, Number.isInteger(u.nseq) ? u.nseq : null));
    }
    for (const r of b.students || []) {
      if (!valid.has(r.id)) continue;
      const hold = HOLD.includes(r.hold) ? r.hold : null;
      if (!r.att && !hold) { stmts.push(env.DB.prepare("DELETE FROM records WHERE sid=? AND date=?").bind(r.id, b.date)); continue; }
      stmts.push(env.DB.prepare("INSERT INTO records (sid, date, cls, att, hwprev, note, by, at, hold) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(sid, date) DO UPDATE SET cls=excluded.cls, att=excluded.att, hwprev=excluded.hwprev, note=excluded.note, by=excluded.by, at=excluded.at, hold=excluded.hold")
        .bind(r.id, b.date, c.id, ATT[r.att] ? r.att : null, HW[r.hwprev] ? r.hwprev : null, clip(r.note, 300), me.name, now, hold));
    }
    if (stmts.length) await env.DB.batch(stmts);
    // keep an unsent preview in step with the record
    for (const k of ["daily", "missing", "warn"]) if (await hasMsgs(env, k, b.date)) await compose(env, k, b.date, { only: valid });
    return json({ ok: true });
  }

  /* ----- homework status for one day ----- */
  if (path === "/api/hwstatus") {
    const date = isDate(url.searchParams.get("date")) ? url.searchParams.get("date") : today();
    const out = [];
    for (const c of await myClasses(env, me)) {
      const recs = await all(env, "SELECT r.*, st.name, st.phone FROM records r JOIN students st ON st.id=r.sid WHERE r.date=? AND r.cls=? ORDER BY st.name", date, c.id);
      if (!recs.length) continue;
      const rows = [];
      const s2 = await settings(env);
      for (const r of recs) rows.push({ sid: r.sid, name: r.name, hasPhone: !!r.phone, att: r.att, hwprev: r.hwprev, hwText: await prevHwText(env, { id: r.sid }, c, date), miss: (await missCount(env, s2, r.sid, date)).length });
      out.push({ id: c.id, name: c.name, kind: c.kind, rows });
    }
    const m = await all(env, "SELECT sid, status FROM msgs WHERE kind='missing' AND date=?", date);
    return json({ date, classes: out, sent: Object.fromEntries(m.map((x) => [x.sid, x.status])) });
  }

  /* ----- missing homework ----- */
  if (path === "/api/missing") {
    const to = isDate(url.searchParams.get("to")) ? url.searchParams.get("to") : today();
    const from = isDate(url.searchParams.get("from")) ? url.searchParams.get("from") : weekStart(to);
    const cls = await myClasses(env, me), ids = cls.map((c) => c.id);
    if (!ids.length) return json({ from, to, rows: [] });
    const rows = await all(env, `SELECT r.sid, r.date, r.hwprev, st.name, c.name AS cname FROM records r JOIN students st ON st.id=r.sid LEFT JOIN classes c ON c.id=r.cls WHERE r.date>=? AND r.date<=? AND r.hwprev IN ('none','part') AND r.cls IN (${ids.map(() => "?").join(",")}) ORDER BY r.date DESC`, from, to, ...ids);
    const map = new Map();
    for (const r of rows) {
      const k = r.sid; if (!map.has(k)) map.set(k, { sid: k, name: r.name, cname: r.cname, none: 0, part: 0, dates: [] });
      const x = map.get(k); x[r.hwprev]++; x.dates.push({ date: r.date, v: r.hwprev });
    }
    return json({ from, to, rows: [...map.values()].sort((a, b) => b.none - a.none || b.part - a.part) });
  }

  /* ----- messages ----- */
  if (path === "/api/msgs" && M === "GET") {
    const date = isDate(url.searchParams.get("date")) ? url.searchParams.get("date") : today();
    const kind = SUBJECT[url.searchParams.get("kind")] ? url.searchParams.get("kind") : "daily";
    const cls = await myClasses(env, me), ids = new Set(cls.map((c) => c.id));
    // 열 때마다 아직 안 보낸 미리보기를 최신 수업 기록으로 다시 맞춰요 (직접 고친 건 그대로)
    if (await one(env, "SELECT 1 AS x FROM msgs WHERE kind=? AND date=? AND status IN ('draft','failed') LIMIT 1", kind, date)) await compose(env, kind, date);
    const rows = (await all(env, "SELECT m.*, st.name, st.phone, st.cls, c.name AS cname FROM msgs m JOIN students st ON st.id=m.sid LEFT JOIN classes c ON c.id=st.cls WHERE m.kind=? AND m.date=? AND m.status!='deleted' ORDER BY c.sort, c.name, st.name", kind, date))
      .filter((r) => ids.has(r.cls)).map((r) => ({ ...r, phone: r.phone ? r.phone.replace(/^(\d{3})(\d+)(\d{4})$/, "$1-****-$3") : "" }));
    return json({ date, kind, rows, composed: !!(await getConf(env, `composed:${kind}:${date}`)), sentAuto: !!(await getConf(env, `sent:${kind}:${date}`)), settings: await settings(env) });
  }
  // 보낸 메시지 기록 (전송됨·실패), 최근 것부터
  if (path === "/api/sent" && M === "GET") {
    const from = isDate(url.searchParams.get("from")) ? url.searchParams.get("from") : addDays(today(), -30);
    const to = isDate(url.searchParams.get("to")) ? url.searchParams.get("to") : today();
    const kind = SUBJECT[url.searchParams.get("kind")] ? url.searchParams.get("kind") : "";
    const q = String(url.searchParams.get("q") || "").trim(), only = url.searchParams.get("st");
    const ids = new Set((await myClasses(env, me)).map((c) => c.id));
    const rows = (await all(env, `SELECT m.id, m.kind, m.date, m.text, m.status, m.err, m.at, m.sends, m.ata, m.edited, m.kakao, st.name, st.phone, st.cls, c.name AS cname FROM msgs m JOIN students st ON st.id=m.sid LEFT JOIN classes c ON c.id=st.cls
      WHERE m.status IN ('sent','failed') AND m.date BETWEEN ? AND ? ${kind ? "AND m.kind=?" : ""} ORDER BY m.date DESC, COALESCE(m.at, 0) DESC LIMIT 500`, ...[from, to, ...(kind ? [kind] : [])]))
      .filter((r) => ids.has(r.cls) && (!q || r.name.includes(q)) && (!only || r.status === only))
      .map((r) => ({ ...r, phone: r.phone ? r.phone.replace(/^(\d{3})(\d+)(\d{4})$/, "$1-****-$3") : "" }));
    return json({ from, to, rows });
  }
  if (path === "/api/msgs/checkall" && M === "POST") {
    const b = await body();
    if (!isDate(b.date) || !SUBJECT[b.kind]) bad("요청을 확인해 주세요.");
    const cls = new Set((await myClasses(env, me)).map((c) => c.id));
    const all_ = (await all(env, "SELECT m.id, m.hold, st.cls FROM msgs m JOIN students st ON st.id=m.sid WHERE m.kind=? AND m.date=? AND m.status IN ('draft','failed')", b.kind, b.date)).filter((r) => cls.has(r.cls));
    const rows = all_.filter((r) => !b.checked || !r.hold);
    if (rows.length) await env.DB.batch(rows.map((r) => env.DB.prepare("UPDATE msgs SET checked=? WHERE id=?").bind(b.checked ? 1 : 0, r.id)));
    return json({ n: rows.length, skipped: b.checked ? all_.length - rows.length : 0 });
  }
  if (path === "/api/msgs/compose" && M === "POST") {
    const b = await body();
    if (!isDate(b.date) || !SUBJECT[b.kind]) bad("요청을 확인해 주세요.");
    const only = me.role === "director" ? null : new Set((await all(env, "SELECT st.id FROM students st JOIN classes c ON c.id=st.cls WHERE c.teacher=?", me.id)).map((x) => x.id));
    const n = await compose(env, b.kind, b.date, { force: !!b.force, only });
    if (me.role === "director") await setConf(env, `composed:${b.kind}:${b.date}`, "1");
    return json({ made: n });
  }
  if (path === "/api/msgs/update" && M === "POST") {
    const b = await body();
    const m = await one(env, "SELECT m.*, st.cls FROM msgs m JOIN students st ON st.id=m.sid WHERE m.id=?", String(b.id || ""));
    if (!m) return fail(404, "메시지를 찾지 못했어요.");
    if (!(await canClass(env, me, m.cls))) return fail(403, "이 학생 메시지를 고칠 수 없어요.");
    if (m.status === "sent" && b.kakao === undefined) return fail(400, "이미 보낸 메시지예요.");
    if (typeof b.text === "string") await run(env, "UPDATE msgs SET text=?, edited=1 WHERE id=?", clip(b.text, 2000), m.id);
    if (typeof b.checked === "boolean") await run(env, "UPDATE msgs SET checked=? WHERE id=?", b.checked ? 1 : 0, m.id);
    if (typeof b.kakao === "boolean") await run(env, "UPDATE msgs SET kakao=? WHERE id=?", b.kakao ? 1 : 0, m.id);
    if (b.delete === true) await run(env, "UPDATE msgs SET status='deleted', checked=0 WHERE id=?", m.id);
    return json({ ok: true });
  }
  if (path === "/api/msgs/style" && M === "POST") {
    const b = await body(), style = b.style === "cushion" ? "cushion" : "basic";
    if (!isDate(b.date) || !SUBJECT[b.kind]) bad("요청을 확인해 주세요.");
    let rows = await all(env, "SELECT m.id, m.sid, st.cls FROM msgs m JOIN students st ON st.id=m.sid WHERE m.kind=? AND m.date=? AND m.status NOT IN ('sent','deleted')", b.kind, b.date);
    if (b.id) rows = rows.filter((r) => r.id === String(b.id));
    const ok = []; for (const r of rows) if (await canClass(env, me, r.cls)) ok.push(r);
    if (!ok.length) return json({ made: 0 });
    await env.DB.batch(ok.map((r) => env.DB.prepare("UPDATE msgs SET style=? WHERE id=?").bind(style, r.id)));
    return json({ made: await compose(env, b.kind, b.date, { force: true, only: new Set(ok.map((r) => r.sid)) }) });
  }
  // 보낸 메시지 다시 보내기: 지금 설정(알림톡 템플릿 등)으로 다시 만들어서 그 학생에게만 보내요. 직접 고친 내용은 그대로.
  if (path === "/api/msgs/resend" && M === "POST") {
    const b = await body();
    const m = await one(env, "SELECT m.*, st.cls FROM msgs m JOIN students st ON st.id=m.sid WHERE m.id=?", String(b.id || ""));
    if (!m) return fail(404, "메시지를 찾지 못했어요.");
    if (!(await canClass(env, me, m.cls))) return fail(403, "이 학생 메시지를 보낼 수 없어요.");
    if (typeof b.kakao === "boolean") await run(env, "UPDATE msgs SET kakao=? WHERE id=?", b.kakao ? 1 : 0, m.id);
    await run(env, "UPDATE msgs SET status='draft', checked=1 WHERE id=?", m.id);
    await compose(env, m.kind, m.date, { only: new Set([m.sid]) });
    return json(await sendDrafts(env, m.kind, m.date, new Set([m.id])));
  }
  if (path === "/api/msgs/send" && M === "POST") {
    const b = await body();
    if (!isDate(b.date) || !SUBJECT[b.kind]) bad("요청을 확인해 주세요.");
    let ids = null;
    if (me.role !== "director") ids = new Set((await all(env, "SELECT m.id FROM msgs m JOIN students st ON st.id=m.sid JOIN classes c ON c.id=st.cls WHERE c.teacher=? AND m.kind=? AND m.date=?", me.id, b.kind, b.date)).map((x) => x.id));
    if (Array.isArray(b.ids)) { const want = new Set(b.ids.map(String)); ids = new Set([...(ids || want)].filter((x) => want.has(x))); }
    return json(await sendDrafts(env, b.kind, b.date, ids));
  }
  // 미제출 / 누적 알림을 한 명에게만 바로 보내요 (미리보기 만들기 → 체크 → 발송을 한 번에)
  if (path === "/api/msgs/sendnow" && M === "POST") {
    const b = await body();
    if (!isDate(b.date) || !["missing", "warn"].includes(b.kind) || !b.sid) bad("요청을 확인해 주세요.");
    const mine = new Set((await myClasses(env, me)).map((c) => c.id));
    const st = await one(env, "SELECT id, cls, phone FROM students WHERE id=?", b.sid);
    if (!st || !mine.has(st.cls)) return fail(403, "이 학생은 보낼 수 없어요.");
    if (!st.phone) bad("학부모 번호가 없어요.");
    await compose(env, b.kind, b.date, { force: false, only: new Set([st.id]) });
    const m = await one(env, "SELECT id, status FROM msgs WHERE kind=? AND date=? AND sid=? AND status!='deleted'", b.kind, b.date, st.id);
    if (!m) bad(b.kind === "warn" ? "아직 누적 알림 기준에 해당하지 않아요." : "이 학생은 미제출 알림 대상이 아니에요.");
    if (m.status === "sent") bad("이미 보냈어요. '학부모 메시지' 탭에서 다시 보낼 수 있어요.");
    await env.DB.prepare("UPDATE msgs SET checked=1 WHERE id=?").bind(m.id).run();
    return json(await sendDrafts(env, b.kind, b.date, new Set([m.id])));
  }
  // 승인된 알림톡 템플릿 내용을 솔라피에서 그대로 가져와요 (붙여넣기 오타로 칸이 비는 것 방지)
  if (path === "/api/ata/template" && M === "POST") {
    if (me.role !== "director") return fail(403, "원장님만 할 수 있어요.");
    const id = String((await body()).id || "").replace(/\s/g, "");
    if (!id) bad("템플릿 ID를 먼저 넣어 주세요.");
    if (!smsStatus(env).ready) return fail(400, "솔라피 연결(비밀값)이 먼저 필요해요.");
    const res = await fetch("https://api.solapi.com/kakao/v2/templates/" + encodeURIComponent(id), { headers: { authorization: await solapiAuth(env) } });
    const raw = await res.text(); let d = null; try { d = JSON.parse(raw); } catch {}
    if (!res.ok || !d || typeof d.content !== "string") return fail(400, "솔라피에서 템플릿을 찾지 못했어요: " + errText(d, raw, res.status));
    return json({ content: d.content, name: d.name || "", status: d.status || "" });
  }
  if (path === "/api/test" && M === "POST") {
    const b = await body(), s = await settings(env);
    if (b.ataKind) {
      const notes = await syncAta(env, s); // if the lookup fails, still send with the saved text and report why
      const a = s.pfId && (b.ataStyle === "cushion" ? s.ata2 : s.ata) && (b.ataStyle === "cushion" ? s.ata2 : s.ata)[b.ataKind];
      if (!a || !a.id || !a.body) return json({ ok: false, msg: "이 메시지의 알림톡 템플릿 ID와 내용을 먼저 저장해 주세요." });
      const sample = { "학원": s.academy, "학생명": "홍길동", "반": "샘플반", "날짜": dLabel(today()), "출석": "출석", "오늘 할 일": "Unit 1 Lesson 2", "숙제": "워크북 p.6~7", "다음 수업": "Unit 1 Review", "지난 숙제 결과": "완료", "지난 숙제 내용": "워크북 p.4~5", "선생님 한마디": "발음이 좋아졌어요", "현재 시각": hhmm(), "수업 시간": "16:00", "누적 횟수": "5", "누적 날짜": "11/2, 11/3, 11/5, 11/6, 11/9", "기간": "11/9~11/13", "출석 요약": "출석 4회", "숙제 완료율": "80% (4/5)", "진도": "Unit 1 → Unit 2", "코멘트": "열심히 했어요", "학습 내용": "Unit 2 본문 읽기 + 단어 시험", "수업 진도": "Unit 1 Review", "사진 주소": "", "사진 링크": "", "사진코드": "sample.0", "인사": "홍길동 어머님, 안녕하세요 😊", "마무리": "오늘도 감사합니다. 좋은 저녁 보내세요!", "숙제 멘트": "숙제를 꼼꼼히 해 왔어요.", "출석 멘트": "", "주간 멘트": "이번 주도 정말 잘 해냈어요." };
      const r = ataBuild(a.body, sample, a.btn);
      const sent = await sendOne(env, b.phone, r.text, s.academy, { pfId: s.pfId, templateId: a.id, variables: r.vars });
      return json({ ...sent, vars: r.vars, notes, msg: sent.ok ? undefined : sent.msg + (notes.length ? " / 템플릿 가져오기: " + notes.join(" / ") : "") });
    }
    return json(await sendOne(env, b.phone, `[${s.academy}] 수업 관리 앱 테스트 문자예요. 이 문자가 보이면 연결 성공!`, s.academy));
  }

  /* ----- export ----- */
  if (path === "/api/export") {
    const to = isDate(url.searchParams.get("to")) ? url.searchParams.get("to") : today();
    const from = isDate(url.searchParams.get("from")) ? url.searchParams.get("from") : monthStart(to);
    const ids = (await myClasses(env, me)).map((c) => c.id);
    if (!ids.length) return json({ rows: [] });
    const rows = await all(env, `SELECT r.date, c.name AS cname, st.name, r.att, r.hwprev, r.note, r.by, COALESCE(lg.today, lp.today) AS today, COALESCE(lg.hw, lp.hw) AS hw, COALESCE(lg.next, lp.next) AS next
      FROM records r JOIN students st ON st.id=r.sid LEFT JOIN classes c ON c.id=r.cls
      LEFT JOIN lessonlog lg ON lg.unit='c:'||r.cls AND lg.date=r.date LEFT JOIN lessonlog lp ON lp.unit='s:'||r.sid AND lp.date=r.date
      WHERE r.date>=? AND r.date<=? AND r.cls IN (${ids.map(() => "?").join(",")}) ORDER BY r.date, c.name, st.name`, from, to, ...ids);
    return json({ from, to, rows: rows.map((r) => ({ ...r, att: ATT[r.att] || "", hwprev: HW[r.hwprev] || "" })) });
  }

  /* ----- setup data (read for everyone, write for director) ----- */
  if (path === "/api/setup" && M === "GET") {
    return json({
      teachers: await all(env, "SELECT id, name, room, sort, (pw IS NOT NULL) AS haspw FROM teachers ORDER BY sort, name"),
      classes: await all(env, "SELECT * FROM classes ORDER BY sort, name"),
      students: me.role === "director"
        ? await all(env, "SELECT * FROM students WHERE active=1 ORDER BY name")
        : (await all(env, "SELECT st.* FROM students st JOIN classes c ON c.id=st.cls WHERE st.active=1 AND c.teacher=? ORDER BY st.name", me.id)).map((s) => ({ ...s, phone: s.phone ? s.phone.replace(/^(\d{3})(\d+)(\d{4})$/, "$1-****-$3") : "" })),
      curricula: await all(env, "SELECT c.id, c.name, c.course, (SELECT COUNT(*) FROM lessons l WHERE l.cur=c.id) AS n FROM curricula c ORDER BY c.name"),
      settings: await settings(env), sms: smsStatus(env), defaults: DEFAULTS,
    });
  }
  director(me);
  if (path === "/api/teacher" && M === "POST") {
    const b = await body(), name = clip(b.name, 30);
    if (!name) bad("선생님 이름을 입력해 주세요.");
    if (b.password && String(b.password).length < 4) bad("선생님 비밀번호는 4자 이상으로 정해 주세요.");
    if (b.id) {
      await run(env, "UPDATE teachers SET name=?, room=? WHERE id=?", name, clip(b.room, 30), b.id);
      if (b.password) await run(env, "UPDATE teachers SET pw=?, ver=ver+1 WHERE id=?", await pwHash(String(b.password)), b.id);
      return json({ ok: true });
    }
    if (!b.password) bad("선생님 비밀번호를 정해 주세요.");
    await run(env, "INSERT INTO teachers (id, name, room, pw, sort) VALUES (?,?,?,?,?)", rand(6), name, clip(b.room, 30), await pwHash(String(b.password)), Date.now() % 100000);
    return json({ ok: true });
  }
  if (path === "/api/teacher/delete" && M === "POST") {
    const b = await body();
    await env.DB.batch([env.DB.prepare("UPDATE classes SET teacher=NULL WHERE teacher=?").bind(b.id), env.DB.prepare("DELETE FROM teachers WHERE id=?").bind(b.id)]);
    return json({ ok: true });
  }
  if (path === "/api/director/password" && M === "POST") {
    const b = await body();
    if (!(await pwOk(String(b.old || ""), await getConf(env, "dpw")))) return fail(401, "지금 비밀번호가 맞지 않아요.");
    if (String(b.password || "").length < 6) bad("새 비밀번호는 6자 이상으로 정해 주세요.");
    const v = String(Number(await getConf(env, "dver")) + 1);
    await setConf(env, "dpw", await pwHash(String(b.password))); await setConf(env, "dver", v);
    return json({ token: await makeToken(env, "director", v) });
  }
  if (path === "/api/class" && M === "POST") {
    const b = await body(), name = clip(b.name, 40);
    if (!name) bad("반 이름을 입력해 주세요.");
    const days = (Array.isArray(b.days) ? b.days : []).map(Number).filter((d) => d >= 0 && d <= 6);
    if (!days.length) bad("수업 요일을 하나 이상 골라 주세요.");
    const rot = (Array.isArray(b.rot) ? b.rot : []).map(String).filter(Boolean).slice(0, 8);
    const cur0 = rot[0] || b.cur || null;
    const vals = [name, b.kind === "private" ? "private" : "group", [...new Set(days)].sort().join(","), clip(b.time, 10), b.teacher || null, cur0, Math.max(1, Number(b.start) || 1), clip(b.course, 30) || null, rot.length > 1 ? rot.join(",") : null];
    if (b.id) await run(env, "UPDATE classes SET name=?, kind=?, days=?, time=?, teacher=?, cur=?, start=?, course=?, rot=? WHERE id=?", ...vals, b.id);
    else await run(env, "INSERT INTO classes (name, kind, days, time, teacher, cur, start, course, rot, id, sort) VALUES (?,?,?,?,?,?,?,?,?,?,?)", ...vals, rand(6), Date.now() % 100000);
    return json({ ok: true });
  }
  if (path === "/api/class/delete" && M === "POST") {
    const b = await body();
    await env.DB.batch([env.DB.prepare("UPDATE students SET cls=NULL WHERE cls=?").bind(b.id), env.DB.prepare("DELETE FROM classes WHERE id=?").bind(b.id)]);
    return json({ ok: true });
  }
  // 여러 학생 한 번에 바꾸기: 보낸 항목만 바꿔요 (반 / 수업 순서 / 시작 차시 / 요일)
  if (path === "/api/students/bulk" && M === "POST") {
    const b = await body(), ids = (Array.isArray(b.ids) ? b.ids : []).map(String).slice(0, 500);
    if (!ids.length) bad("학생을 먼저 골라 주세요.");
    const sets = [], vals = [];
    if (b.cls !== undefined) { sets.push("cls=?"); vals.push(b.cls || null); }
    if (Array.isArray(b.rot)) { const rot = b.rot.map(String).filter(Boolean).slice(0, 8); sets.push("cur=?", "rot=?"); vals.push(rot[0] || null, rot.length > 1 ? rot.join(",") : null); }
    if (b.start !== undefined && b.start !== null && b.start !== "") { sets.push("start=?"); vals.push(Math.max(1, Number(b.start) || 1)); }
    if (b.days !== undefined) { sets.push("days=?"); vals.push(parseDays(b.days)); }
    if (!sets.length) bad("바꿀 항목을 골라 주세요.");
    await env.DB.batch(ids.map((id) => env.DB.prepare(`UPDATE students SET ${sets.join(", ")} WHERE id=?`).bind(...vals, id)));
    return json({ ok: true, n: ids.length });
  }
  if (path === "/api/student" && M === "POST") {
    const b = await body(), name = clip(b.name, 30), phone = digits(b.phone);
    if (!name) bad("학생 이름을 입력해 주세요.");
    if (phone && !/^01\d{8,9}$/.test(phone)) bad("학부모 번호를 확인해 주세요.");
    const rot = (Array.isArray(b.rot) ? b.rot : []).map(String).filter(Boolean).slice(0, 8);
    const vals = [name, b.cls || null, phone, rot[0] || b.cur || null, Math.max(1, Number(b.start) || 1), rot.length > 1 ? rot.join(",") : null, parseDays(b.days)];
    if (b.id) await run(env, "UPDATE students SET name=?, cls=?, phone=?, cur=?, start=?, rot=?, days=? WHERE id=?", ...vals, b.id);
    else await run(env, "INSERT INTO students (name, cls, phone, cur, start, rot, days, id) VALUES (?,?,?,?,?,?,?,?)", ...vals, rand(6));
    return json({ ok: true });
  }
  if (path === "/api/student/delete" && M === "POST") {
    await run(env, "UPDATE students SET active=0 WHERE id=?", (await body()).id);
    return json({ ok: true });
  }
  if (path === "/api/students/import" && M === "POST") {
    const b = await body(), list = Array.isArray(b.students) ? b.students.slice(0, 1000) : [];
    const classes = await all(env, "SELECT id, name FROM classes");
    const byName = new Map(classes.map((c) => [c.name.replace(/\s+/g, ""), c.id]));
    // class names in the list that don't exist yet are made (days = all days its students come)
    let madeCls = 0;
    for (const x of list) {
      const k = String(x.cls || "").replace(/\s+/g, ""); if (!k || byName.has(k)) continue;
      const ds = [...new Set(list.filter((y) => String(y.cls || "").replace(/\s+/g, "") === k).flatMap((y) => (parseDays(y.days) || "").split(",").filter(Boolean)))].sort().join(",") || "1,2,3,4,5";
      const id = rand(6); await run(env, "INSERT INTO classes (id, name, kind, days, sort) VALUES (?,?,?,?,?)", id, clip(String(x.cls).trim(), 30), "group", ds, Date.now() % 100000);
      byName.set(k, id); madeCls++;
    }
    const existing = await all(env, "SELECT id, name, cls, phone FROM students WHERE active=1");
    const stmts = []; let added = 0, updated = 0;
    for (const x of list) {
      const name = clip(x.name, 30); if (!name) continue;
      const phone = /^01\d{8,9}$/.test(digits(x.phone)) ? digits(x.phone) : "";
      const cls = x.cls ? byName.get(String(x.cls).replace(/\s+/g, "")) || null : null, days = parseDays(x.days);
      const same = existing.filter((e) => e.name === name);
      const hit = same.find((e) => phone && e.phone === phone) || (same.length === 1 ? same[0] : null);
      if (hit) { stmts.push(env.DB.prepare("UPDATE students SET phone=COALESCE(NULLIF(?,''), phone), cls=COALESCE(?, cls), days=COALESCE(?, days) WHERE id=?").bind(phone, cls, days, hit.id)); updated++; }
      else { stmts.push(env.DB.prepare("INSERT INTO students (id, name, cls, phone, days) VALUES (?,?,?,?,?)").bind(rand(6), name, cls, phone, days)); added++; }
    }
    for (let i = 0; i < stmts.length; i += 80) await env.DB.batch(stmts.slice(i, i + 80));
    return json({ added, updated, madeCls });
  }
  if (path === "/api/curriculum" && M === "POST") {
    const b = await body(), name = clip(b.name, 60);
    if (!name) bad("진도표 이름을 입력해 주세요.");
    const ls = (Array.isArray(b.lessons) ? b.lessons : []).slice(0, 500).map((l, i) => ({ seq: Number(l.seq) > 0 ? Math.round(Number(l.seq)) : i + 1, title: clip(l.title, 120), content: clip(l.content, 300), hw: clip(l.hw, 500) })).filter((l) => l.title || l.content || l.hw);
    const seqs = new Set(); for (const l of ls) { if (seqs.has(l.seq)) bad(`${l.seq}번 차시가 두 번 있어요.`); seqs.add(l.seq); }
    const id = b.id || rand(6), course = clip(b.course, 30) || null;
    const loop = b.loop === false ? 0 : 1;
    const stmts = [b.id ? env.DB.prepare("UPDATE curricula SET name=?, course=?, loop=? WHERE id=?").bind(name, course, loop, id) : env.DB.prepare("INSERT INTO curricula (id, name, course, loop) VALUES (?,?,?,?)").bind(id, name, course, loop)];
    if (Array.isArray(b.lessons)) {
      stmts.push(env.DB.prepare("DELETE FROM lessons WHERE cur=?").bind(id));
      for (const l of ls) stmts.push(env.DB.prepare("INSERT INTO lessons (cur, seq, title, content, hw) VALUES (?,?,?,?,?)").bind(id, l.seq, l.title, l.content, l.hw));
    }
    for (let i = 0; i < stmts.length; i += 80) await env.DB.batch(stmts.slice(i, i + 80));
    return json({ ok: true, id, n: ls.length });
  }
  if (path === "/api/curriculum/get") {
    const id = url.searchParams.get("id");
    return json({ cur: await one(env, "SELECT * FROM curricula WHERE id=?", id), lessons: await lessonsOf(env, id) });
  }
  if (path === "/api/curriculum/delete" && M === "POST") {
    const id = (await body()).id;
    await env.DB.batch([env.DB.prepare("DELETE FROM lessons WHERE cur=?").bind(id), env.DB.prepare("DELETE FROM curricula WHERE id=?").bind(id), env.DB.prepare("UPDATE classes SET cur=NULL WHERE cur=?").bind(id), env.DB.prepare("UPDATE students SET cur=NULL WHERE cur=?").bind(id)]);
    return json({ ok: true });
  }
  if (path === "/api/settings" && M === "POST") {
    const b = await body(), s = await settings(env);
    const time = (v, d) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(String(v)) ? String(v) : d);
    const n = {
      baseUrl: s.baseUrl,
      hwPresets: Array.isArray(b.hwPresets) ? b.hwPresets.map((x) => clip(x, 40)).filter(Boolean).slice(0, 30) : s.hwPresets,
      courses: Array.isArray(b.courses) ? [...new Set(b.courses.map((x) => clip(x, 30)).filter(Boolean))].slice(0, 12) : s.courses,
      academy: clip(b.academy, 30) || s.academy, composeTime: time(b.composeTime, s.composeTime), sendTime: time(b.sendTime, s.sendTime),
      notifyIn: !!b.notifyIn, notifyLate: !!b.notifyLate, notifyOut: !!b.notifyOut, atpl: { ...s.atpl },
      autoSend: !!b.autoSend, warnOn: !!b.warnOn, warnPart: !!b.warnPart, warnCount: Math.min(30, Math.max(2, Math.round(Number(b.warnCount) || 5))), missingAuto: !!b.missingAuto, missingPart: !!b.missingPart, weekly: !!b.weekly, monthlyAuto: b.monthlyAuto === undefined ? !!s.monthlyAuto : !!b.monthlyAuto, weeklyAuto: b.weeklyAuto === undefined ? !!s.weeklyAuto : !!b.weeklyAuto, weeklySkipDay: b.weeklySkipDay === undefined ? s.weeklySkipDay !== false : !!b.weeklySkipDay, monthly: !!b.monthly, weeklyDay: Math.min(6, Math.max(0, Number(b.weeklyDay) || 5)), tpl: { ...s.tpl },
    };
    if (n.sendTime <= n.composeTime) bad("발송 시간은 미리보기 시간보다 늦어야 해요.");
    // fields a form didn't send keep their saved value
    n.channel = b.channel === undefined ? s.channel : b.channel === "ata" ? "ata" : "sms";
    n.pfId = b.pfId === undefined ? s.pfId : clip(b.pfId, 60).replace(/\s/g, "");
    for (const key of ["ata", "ata2"]) {
      if (b[key] === undefined) { n[key] = s[key] || {}; continue; }
      n[key] = {};
      for (const k of ATA_KINDS) {
        const a = b[key] && b[key][k]; if (!a || !(a.id || a.body)) continue;
        const id = clip(a.id, 60).replace(/\s/g, ""), bodyT = clip(a.body, 1000), old = (s[key] || {})[k];
        n[key][k] = { id, body: bodyT, ...(old && old.ok === id + "#2" && old.body === bodyT ? { ok: id + "#2", btn: old.btn || "" } : {}) };
      }
    }
    n.style = b.style === undefined ? s.style || "basic" : b.style === "cushion" ? "cushion" : "basic";
    if (n.channel === "ata" && !n.pfId) bad("알림톡을 쓰려면 카카오 채널 ID(pfId)를 넣어 주세요.");
    n.phr = { ...s.phr };
    for (const k of Object.keys(DEFAULTS.phr)) if (b.phr && Array.isArray(b.phr[k])) n.phr[k] = b.phr[k].map((x) => clip(x, 200)).filter(Boolean).slice(0, 30);
    for (const k of Object.keys(DEFAULTS.atpl)) if (b.atpl && typeof b.atpl[k] === "string") { const t = clip(b.atpl[k], 500); if (!t) bad("출결 문구를 비워 둘 수 없어요."); n.atpl[k] = t; }
    for (const k of Object.keys(DEFAULTS.tpl)) if (b.tpl && typeof b.tpl[k] === "string") { const t = clip(b.tpl[k], 1500); if (!t) bad("메시지 문구를 비워 둘 수 없어요."); n.tpl[k] = t; }
    await setConf(env, "settings", JSON.stringify(n));
    const notes = n.channel === "ata" ? await syncAta(env, n) : [];
    return json({ ok: true, settings: n, notes });
  }
  return fail(404, "없는 주소예요.");
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/")) {
      try { return await api(req, env, url.pathname); }
      catch (e) { if (e instanceof HttpError) return fail(e.status, e.message); console.error(e); return fail(500, "잠시 문제가 생겼어요. 다시 시도해 주세요."); }
    }
    const pm = /^\/p\/([\w]+)\.(\d{4}-\d{2}-\d{2})\.([0-9a-f]+)$/.exec(url.pathname);
    if (pm) { await init(env); return photoPage(env, pm[1], pm[2], pm[3]); }
    const gm = /^\/g\/(\w+)\.([0-9a-f]+)$/.exec(url.pathname);
    if (gm) { await init(env); return galleryPage(env, gm[1], gm[2]); }
    // 버튼 주소의 #{사진코드}가 채워지지 않은 예전 알림톡 등: 하얀 화면 대신 이유를 알려 줘요
    if (url.pathname === "/g" || url.pathname.startsWith("/g/")) return new Response(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>수업 사진·영상</title><style>${PAGE_CSS}</style></head><body><main><h1>사진 주소가 비어 있어요</h1><p>이 알림톡 버튼에는 학생 정보가 들어 있지 않아요. 예전에 보낸 알림톡이라면 학원에서 다시 보내 드릴게요. 새로 받은 알림톡의 버튼을 눌러 주세요.</p></main></body></html>`, { status: 404, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
    const mm = /^\/m\/(\w+)$/.exec(url.pathname);
    if (mm) { await init(env); return mediaFile(env, req, mm[1], url.searchParams.get("t") || ""); }
    return env.ASSETS.fetch(req);
  },
  async scheduled(_e, env, ctx) { ctx.waitUntil(tick(env)); },
};
