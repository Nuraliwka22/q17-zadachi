/* Q17 Задачи — простое приложение задач и напоминаний по объектам.
   Данные: Supabase (вход, база, серверные напоминания). Часовой пояс: Asia/Almaty. */
(() => {
"use strict";
const C = window.Q17_CONFIG;
const sb = window.supabase.createClient(C.supabaseUrl, C.supabaseKey, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});
const TZ = "Asia/Almaty";
const STATUS = { planned: "Запланировано", in_progress: "В работе", waiting: "Ожидание", done: "Готово" };
const STATUS_ORDER = ["in_progress", "waiting", "planned", "done"];
const WD = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];
const WD_FULL = ["воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота"];
const MON = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];

const S = { user: null, projects: [], tasks: [], loaded: false, loadError: null, chat: [], chatBusy: false, aiState: "unknown" };
const $app = document.getElementById("app");

// ---------------- утилиты ----------------
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function parts(d) {
  const p = {};
  for (const x of new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d)) p[x.type] = x.value;
  return p;
}
const dateOf = (d) => { const p = parts(d); return `${p.year}-${p.month}-${p.day}`; };
const todayStr = () => dateOf(new Date());
function addDays(ds, n) { const [y, m, d] = ds.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); }
function weekday(ds) { const [y, m, d] = ds.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); }
function localToUtc(local) { // "YYYY-MM-DDTHH:mm" по Алматы -> ISO
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(local); if (!m) return null;
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  const p = parts(new Date(guess));
  const off = (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - guess) / 60000;
  return new Date(guess - off * 60000).toISOString();
}
function utcToLocal(iso) { if (!iso) return ""; const p = parts(new Date(iso)); return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`; }
const timeOf = (iso) => { const p = parts(new Date(iso)); return `${p.hour}:${p.minute}`; };
function relDay(ds) {
  const t = todayStr();
  if (ds === t) return "сегодня";
  if (ds === addDays(t, 1)) return "завтра";
  if (ds === addDays(t, -1)) return "вчера";
  return null;
}
function fmtD(ds) { // "пт, 27.11" (+ "сегодня")
  if (!ds) return "";
  const [y, m, d] = ds.split("-");
  const r = relDay(ds);
  const base = `${WD[weekday(ds)]}, ${d}.${m}${y !== todayStr().slice(0, 4) ? "." + y : ""}`;
  return r ? `${r}, ${base}` : base;
}
function fmtDT(iso) { if (!iso) return ""; return `${fmtD(dateOf(new Date(iso)))} в ${timeOf(iso)}`; }
function fmtStamp(iso) { const p = parts(new Date(iso)); return `${p.day}.${p.month}.${p.year} ${p.hour}:${p.minute}`; }
function longDate(ds) { const [y, m, d] = ds.split("-").map(Number); return `${WD_FULL[weekday(ds)]}, ${d} ${MON[m - 1]}`; }
function nextWeekday(wd, fromDs = todayStr()) { let ds = addDays(fromDs, 1); while (weekday(ds) !== wd) ds = addDays(ds, 1); return ds; }
const projectOf = (t) => S.projects.find((p) => p.id === t.project_id) || null;
const projName = (t) => projectOf(t)?.name || "Без объекта";
const isOpen = (t) => t.status !== "done";
const ago = (iso) => Date.now() - new Date(iso).getTime();

function toast(msg, err = false, ms = 4200) {
  const el = document.getElementById("toast");
  el.textContent = msg; el.className = "show" + (err ? " err" : "");
  clearTimeout(toast._t); toast._t = setTimeout(() => (el.className = ""), ms);
}
function errText(e) {
  const m = String(e?.message || e || "");
  if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return "Нет связи с сервером. Проверьте интернет и повторите.";
  if (/JWT|session/i.test(m)) return "Сессия истекла. Войдите снова.";
  if (/email address .* is invalid|invalid email/i.test(m)) return "Сервер не принял этот адрес почты. Укажите настоящий адрес.";
  if (/already registered|already been registered/i.test(m)) return "Такой адрес уже зарегистрирован. Нажмите «Войти».";
  if (/password should be|weak password/i.test(m)) return "Пароль слишком простой: нужно не меньше 6 символов.";
  if (/rate limit|too many|security purposes/i.test(m)) return "Слишком много попыток подряд. Подождите минуту и повторите.";
  return m || "Неизвестная ошибка";
}
async function busy(btn, fn) {
  const old = btn?.innerHTML;
  if (btn) { btn.disabled = true; btn.innerHTML = `<span class="spinner"></span> Сохраняю…`; }
  try { return await fn(); }
  finally { if (btn && btn.isConnected) { btn.disabled = false; btn.innerHTML = old; } }
}

// ---------------- данные ----------------
async function loadAll() {
  const since = new Date(Date.now() - 120 * 86400000).toISOString();
  const [p, t] = await Promise.all([
    sb.from("projects").select("*").eq("archived", false).order("name"),
    sb.from("tasks").select("*").or(`status.neq.done,completed_at.gte.${since}`).order("created_at", { ascending: false }),
  ]);
  if (p.error) throw p.error; if (t.error) throw t.error;
  S.projects = p.data; S.tasks = t.data; S.loaded = true; S.loadError = null;
}
async function refresh(silent = true) {
  try { await loadAll(); render(); }
  catch (e) { S.loadError = errText(e); if (!silent) toast(S.loadError, true); render(); }
}
async function ensureProject(name) {
  const clean = name.trim();
  const ex = S.projects.find((p) => p.name.toLowerCase() === clean.toLowerCase());
  if (ex) return ex.id;
  const { data, error } = await sb.from("projects").insert({ name: clean }).select().single();
  if (error) throw error;
  S.projects.push(data);
  return data.id;
}
async function createTask(row) {
  const { data, error } = await sb.from("tasks").insert(row).select().single();
  if (error) throw error;
  await refresh();
  return data;
}
async function updateTask(id, patch) {
  const { data, error } = await sb.from("tasks").update(patch).eq("id", id).select().single();
  if (error) throw error;
  await refresh();
  return data;
}
async function addEvent(task_id, kind, text) {
  const { error } = await sb.from("task_events").insert({ task_id, kind, text });
  if (error) throw error;
}
function confirmText(t) {
  const bits = [`«${t.title}»`];
  const p = S.projects.find((x) => x.id === t.project_id); if (p) bits.push(`объект ${p.name}`);
  if (t.due_date) bits.push(`срок ${fmtD(t.due_date)}`);
  if (t.remind_at) bits.push(`напоминание ${fmtDT(t.remind_at)}`);
  return "Сохранено: " + bits.join(", ");
}

// ---------------- оболочка ----------------
function route() { const h = location.hash.replace(/^#\/?/, "").split("?")[0] || "today"; const [name, id] = h.split("/"); return { name, id }; }
function shell(title, body, { back = null, fab = true, actions = "" } = {}) {
  const r = route().name;
  const tab = (href, ico, label, keys) => `<a href="#/${href}" class="${keys.includes(r) ? "on" : ""}"><span class="ico" aria-hidden="true">${ico}</span>${label}</a>`;
  $app.innerHTML = `
    <header class="top">
      ${back ? `<a class="icon-btn back" href="${back}" aria-label="Назад">←</a>` : ""}
      <h1>${esc(title)}</h1>${actions}
      <a class="icon-btn" href="#/settings" aria-label="Настройки и уведомления">⚙︎</a>
    </header>
    <main>${S.loadError ? `<div class="banner err">${esc(S.loadError)} <div class="row"><button class="btn small" data-act="reload">Повторить</button></div></div>` : ""}${body}</main>
    ${fab ? `<button class="fab" data-act="add">＋ Добавить задачу</button>` : ""}
    <nav class="tabs">
      ${tab("today", "☀︎", "Сегодня", ["today"])}
      ${tab("projects", "▦", "Проекты", ["projects", "project"])}
      ${tab("chat", "✎", "Чат", ["chat"])}
      ${tab("plan", "☰", "План и факт", ["plan"])}
    </nav>`;
}

function taskCard(t, { actions = true, showProject = true, reason = "" } = {}) {
  const now = Date.now();
  const lateDue = t.due_date && t.due_date < todayStr() && isOpen(t);
  const lateRem = t.remind_at && new Date(t.remind_at).getTime() < now && isOpen(t);
  const p = projectOf(t);
  return `<div class="card task ${t.status === "done" ? "is-done" : ""}" data-open="${t.id}">
    <div class="row"><span class="t grow">${esc(t.title)}</span><span class="st st-${t.status}">${STATUS[t.status]}</span></div>
    <div class="meta">
      ${showProject ? `<span class="chip ${p?.is_example ? "example" : ""}">${esc(projName(t))}</span>` : ""}
      ${t.is_example ? `<span class="chip example">пример</span>` : ""}
      ${t.due_date ? `<span class="${lateDue ? "late" : ""}">Срок: ${fmtD(t.due_date)}</span>` : ""}
      ${t.remind_at ? `<span class="${lateRem ? "late" : ""}">🔔 ${fmtDT(t.remind_at)}</span>` : ""}
      ${t.assignee ? `<span>👤 ${esc(t.assignee)}</span>` : ""}
      ${t.status === "done" && t.completed_at ? `<span>Завершено ${fmtDT(t.completed_at)}</span>` : ""}
    </div>
    ${reason ? `<div class="na late small">${esc(reason)}</div>` : ""}
    ${t.next_action ? `<div class="na">→ ${esc(t.next_action)}</div>` : ""}
    ${actions && isOpen(t) ? `<div class="acts">
      <button class="btn small done" data-done="${t.id}">✓ Готово</button>
      <button class="btn small" data-resched="${t.id}">Перенести</button>
      <button class="btn small" data-result="${t.id}">Добавить результат</button>
    </div>` : ""}
  </div>`;
}

// ---------------- экраны ----------------
function viewToday() {
  const t0 = todayStr(), now = Date.now();
  const endToday = new Date(localToUtc(addDays(t0, 1) + "T00:00")).getTime();
  const open = S.tasks.filter(isOpen);
  const overdue = [], today = [], upcoming = [], rest = [];
  for (const t of open) {
    const rem = t.remind_at ? new Date(t.remind_at).getTime() : null;
    if ((t.due_date && t.due_date < t0) || (rem && rem < now)) {
      const why = [];
      if (t.due_date && t.due_date < t0) why.push(`срок прошёл ${fmtD(t.due_date)}`);
      if (rem && rem < now) why.push(`напоминание было ${fmtDT(t.remind_at)}`);
      overdue.push([t, why.join("; ")]);
    } else if (t.due_date === t0 || (rem && rem < endToday)) today.push(t);
    else if (rem && rem < endToday + 7 * 86400000) upcoming.push(t);
    else rest.push(t);
  }
  const byRem = (a, b) => (a.remind_at || "9").localeCompare(b.remind_at || "9");
  today.sort(byRem); upcoming.sort(byRem);
  const doneToday = S.tasks.filter((t) => t.status === "done" && t.completed_at && dateOf(new Date(t.completed_at)) === t0);
  const empty = !S.tasks.length;
  const body = `
    <p class="muted" style="margin:4px 0 0">${esc(longDate(t0))}, Алматы</p>
    ${pushBanner()}
    ${empty ? `<div class="card empty" style="margin-top:16px">
        <p><b>Задач пока нет.</b></p>
        <p>Нажмите «Добавить задачу» внизу или напишите в чат, например:<br>«По Акколу поставка нужна к пятнице. Завтра в 11:00 напомни уточнить дату отгрузки».</p>
        <p class="small">Можно загрузить демонстрационные данные (помечены как «пример»), чтобы посмотреть, как всё выглядит.</p>
        <button class="btn" data-act="examples">Загрузить примеры</button></div>` : ""}
    ${overdue.length ? `<h2 class="danger">Просрочено <span class="count">${overdue.length}</span></h2><div class="list">${overdue.map(([t, r]) => taskCard(t, { reason: r })).join("")}</div>` : ""}
    ${!empty ? `<h2>На сегодня <span class="count">${today.length}</span></h2><div class="list">${today.length ? today.map((t) => taskCard(t)).join("") : `<div class="card empty">На сегодня ничего не запланировано</div>`}</div>` : ""}
    ${upcoming.length ? `<h2>Ближайшие напоминания</h2><div class="list">${upcoming.map((t) => taskCard(t)).join("")}</div>` : ""}
    ${rest.length ? `<details class="more"><summary>Остальные открытые задачи (${rest.length})</summary><div class="list">${rest.map((t) => taskCard(t)).join("")}</div></details>` : ""}
    ${doneToday.length ? `<details class="more"><summary>Сделано сегодня (${doneToday.length})</summary><div class="list">${doneToday.map((t) => taskCard(t, { actions: false })).join("")}</div></details>` : ""}`;
  shell("Сегодня", body);
}

function viewProjects() {
  const rows = S.projects.map((p) => {
    const ts = S.tasks.filter((t) => t.project_id === p.id);
    const open = ts.filter(isOpen);
    const late = open.filter((t) => (t.due_date && t.due_date < todayStr()) || (t.remind_at && ago(t.remind_at) > 0)).length;
    const cnt = (s) => ts.filter((t) => t.status === s).length;
    return `<div class="card task" data-project="${p.id}">
      <div class="row"><span class="t grow">${esc(p.name)}</span>${p.is_example ? `<span class="chip example">пример</span>` : ""}</div>
      <div class="meta">
        <span>Открыто: <b>${open.length}</b></span>
        ${cnt("in_progress") ? `<span class="st st-in_progress">В работе ${cnt("in_progress")}</span>` : ""}
        ${cnt("waiting") ? `<span class="st st-waiting">Ожидание ${cnt("waiting")}</span>` : ""}
        ${cnt("planned") ? `<span class="st st-planned">Запланировано ${cnt("planned")}</span>` : ""}
        ${late ? `<span class="late">Просрочено ${late}</span>` : ""}
      </div></div>`;
  });
  const noProj = S.tasks.filter((t) => !t.project_id && isOpen(t));
  shell("Проекты", `
    <div class="row" style="margin-top:6px"><button class="btn" data-act="new-project">＋ Добавить объект</button></div>
    <div class="list" style="margin-top:12px">${rows.join("") || `<div class="card empty">Объектов пока нет</div>`}
    ${noProj.length ? `<div class="card task" data-project="none"><div class="t">Без объекта</div><div class="meta">Открыто: ${noProj.length}</div></div>` : ""}</div>`);
}

function viewProject(id) {
  const p = id === "none" ? { id: null, name: "Без объекта" } : S.projects.find((x) => x.id === id);
  if (!p) return shell("Объект", `<div class="card empty">Объект не найден</div>`, { back: "#/projects" });
  const ts = S.tasks.filter((t) => (p.id ? t.project_id === p.id : !t.project_id));
  const groups = STATUS_ORDER.map((s) => {
    const list = ts.filter((t) => t.status === s);
    if (!list.length) return "";
    const inner = `<div class="list">${list.map((t) => taskCard(t, { showProject: false })).join("")}</div>`;
    return s === "done" ? `<details class="more"><summary>Готово (${list.length})</summary>${inner}</details>`
      : `<h2>${STATUS[s]} <span class="count">${list.length}</span></h2>${inner}`;
  }).join("");
  shell(p.name, `
    ${p.is_example ? `<div class="banner">Это демонстрационный объект (пример).</div>` : ""}
    ${groups || `<div class="card empty">В этом объекте пока нет задач</div>`}
    ${p.id ? `<div class="row" style="margin-top:20px"><button class="btn small" data-rename="${p.id}">Переименовать объект</button><button class="btn small danger" data-archive="${p.id}">Убрать в архив</button></div>` : ""}`,
    { back: "#/projects" });
  document.querySelector(".fab").dataset.project = p.id || "";
}

async function viewTask(id) {
  let t = S.tasks.find((x) => x.id === id);
  if (!t) {
    const { data } = await sb.from("tasks").select("*").eq("id", id).maybeSingle();
    if (data) { t = data; S.tasks.push(data); }
  }
  if (!t) return shell("Задача", `<div class="card empty">Задача не найдена</div>`, { back: "#/today" });
  const projOpts = `<option value="">Без объекта</option>` + S.projects.map((p) => `<option value="${p.id}" ${p.id === t.project_id ? "selected" : ""}>${esc(p.name)}</option>`).join("") + `<option value="__new">＋ Новый объект…</option>`;
  shell("Задача", `
    <div class="card">
      ${t.is_example ? `<div class="banner" style="margin-top:0">Демонстрационная задача (пример)</div>` : ""}
      <div class="row"><span class="chip">${esc(projName(t))}</span><span class="st st-${t.status}">${STATUS[t.status]}</span></div>
      <h3 style="font-size:21px;margin:10px 0 2px">${esc(t.title)}</h3>
      ${t.next_action ? `<p style="margin:6px 0"><b>Следующее действие:</b> ${esc(t.next_action)}</p>` : `<p class="muted" style="margin:6px 0">Следующее действие не указано</p>`}
      <p style="margin:4px 0">Срок: <b>${t.due_date ? fmtD(t.due_date) : "не задан"}</b></p>
      <p style="margin:4px 0">Напоминание: <b>${t.remind_at ? fmtDT(t.remind_at) : "нет"}</b></p>
      ${t.assignee ? `<p style="margin:4px 0">Ответственный: <b>${esc(t.assignee)}</b></p>` : ""}
      ${t.completed_at ? `<p style="margin:4px 0">Завершено: <b>${fmtDT(t.completed_at)}</b></p>` : ""}
      <div class="row" style="margin-top:12px">
        ${isOpen(t) ? `<button class="btn primary" data-done="${t.id}">✓ Готово</button><button class="btn" data-resched="${t.id}">Перенести</button>`
          : `<button class="btn" data-reopen="${t.id}">Вернуть в работу</button>`}
        <button class="btn" data-result="${t.id}">Добавить результат</button>
      </div>
    </div>
    <h2>Статус</h2>
    <div class="seg">${STATUS_ORDER.slice(0, 3).concat("done").map((s) => `<button data-status="${s}" data-id="${t.id}" class="${t.status === s ? "on" : ""}">${STATUS[s]}</button>`).join("")}</div>
    <details class="more"><summary>Изменить поля задачи</summary>
      <form class="card" id="editForm">
        <label class="f"><span>Название</span><input class="i" name="title" required value="${esc(t.title)}"></label>
        <label class="f"><span>Объект</span><select class="i" name="project_id">${projOpts}</select></label>
        <label class="f" hidden data-newproj><span>Название нового объекта</span><input class="i" name="new_project"></label>
        <label class="f"><span>Следующее действие</span><input class="i" name="next_action" value="${esc(t.next_action || "")}"></label>
        <div class="two">
          <label class="f"><span>Срок выполнения</span><input class="i" type="date" name="due_date" value="${t.due_date || ""}"><div class="hint" data-hint="due_date"></div></label>
          <label class="f"><span>Напоминание (время Алматы)</span><input class="i" type="datetime-local" name="remind_at" value="${utcToLocal(t.remind_at)}"><div class="hint" data-hint="remind_at"></div></label>
        </div>
        <label class="f"><span>Ответственный</span><input class="i" name="assignee" value="${esc(t.assignee || "")}"></label>
        <div class="row end" style="margin-top:14px"><button class="btn primary" type="submit">Сохранить изменения</button></div>
      </form>
    </details>
    <h2>История</h2>
    <div class="card"><ul class="hist" id="hist"><li class="muted">Загружаю историю…</li></ul></div>
    <h2>Напоминания по задаче</h2>
    <div class="card"><ul class="hist" id="rems"><li class="muted">Загружаю…</li></ul></div>`,
    { back: t.project_id ? `#/project/${t.project_id}` : "#/today" });
  document.querySelector(".fab").dataset.project = t.project_id || "";
  wireDateHints(document.getElementById("editForm"));
  const [ev, rm] = await Promise.all([
    sb.from("task_events").select("*").eq("task_id", id).order("created_at", { ascending: false }),
    sb.from("reminders").select("*").eq("task_id", id).order("created_at", { ascending: false }),
  ]);
  const h = document.getElementById("hist"), r = document.getElementById("rems");
  if (!h) return;
  h.innerHTML = ev.error ? `<li class="late">Не удалось загрузить историю: ${esc(ev.error.message)}</li>`
    : ev.data.map((e) => `<li class="k-${e.kind}"><div class="when">${fmtStamp(e.created_at)}${e.source === "chat" ? `<span class="src">чат</span>` : e.source === "system" ? `<span class="src">система</span>` : ""}</div><div class="txt">${esc(e.text)}</div></li>`).join("") || `<li class="muted">Пока пусто</li>`;
  const RS = { pending: "ожидает", sending: "отправляется", sent: "отправлено", failed: "ошибка отправки" };
  const CR = { moved: "перенесено", task_done: "отменено: задача закрыта", removed: "удалено", stale: "отменено" };
  r.innerHTML = rm.error ? `<li class="late">${esc(rm.error.message)}</li>`
    : rm.data.map((x) => `<li><div class="${x.status === "cancelled" ? "cancelled" : ""}">${fmtDT(x.remind_at)}${x.note ? " — " + esc(x.note) : ""}</div>
      <div class="when">${x.status === "cancelled" ? CR[x.cancel_reason] || "отменено" : RS[x.status]}${x.sent_at ? " " + fmtStamp(x.sent_at) : ""}${x.last_error && x.status !== "sent" ? " · " + esc(x.last_error) : ""}</div></li>`).join("") || `<li class="muted">Напоминаний не было</li>`;
}

// ---------------- План и факт ----------------
async function viewPlan() {
  const qd = new URLSearchParams(location.hash.split("?")[1] || "").get("d");
  const day = /^\d{4}-\d{2}-\d{2}$/.test(qd || "") ? qd : todayStr();
  shell("План и факт", `
    <div class="row" style="margin-top:6px">
      <button class="btn small" data-day="${addDays(day, -1)}" aria-label="Предыдущий день">←</button>
      <input class="i" type="date" id="pfDay" value="${day}" style="max-width:190px">
      <button class="btn small" data-day="${addDays(day, 1)}" aria-label="Следующий день">→</button>
      ${day !== todayStr() ? `<button class="btn small" data-day="${todayStr()}">Сегодня</button>` : ""}
    </div>
    <p class="muted small">${esc(longDate(day))}. Что было запланировано на день, что произошло и какой следующий шаг.</p>
    <div id="pf"><div class="card empty"><span class="spinner"></span> Загружаю…</div></div>`, { fab: true });
  const start = localToUtc(day + "T00:00"), end = localToUtc(addDays(day, 1) + "T00:00");
  const [rem, ev, dueEv, naEv] = await Promise.all([
    sb.from("reminders").select("*").gte("remind_at", start).lt("remind_at", end).order("remind_at"),
    sb.from("task_events").select("*").gte("created_at", start).lt("created_at", end).order("created_at"),
    sb.from("task_events").select("*").eq("kind", "due").eq("data->>old", day),
    sb.from("task_events").select("task_id,kind,data,created_at").in("kind", ["next_action", "created"]).lt("created_at", end).order("created_at"),
  ]);
  const el = document.getElementById("pf"); if (!el) return;
  const err = rem.error || ev.error || dueEv.error || naEv.error;
  if (err) { el.innerHTML = `<div class="banner err">Не удалось загрузить: ${esc(err.message)}</div>`; return; }
  // нужные задачи, которых нет в памяти (старые закрытые)
  const ids = new Set([...rem.data, ...ev.data, ...dueEv.data].map((x) => x.task_id));
  const missing = [...ids].filter((i) => !S.tasks.find((t) => t.id === i));
  let extra = [];
  if (missing.length) { const r = await sb.from("tasks").select("*").in("id", missing); extra = r.data || []; }
  const all = [...S.tasks, ...extra];
  const task = (i) => all.find((t) => t.id === i);
  S.tasks.filter((t) => t.due_date === day).forEach((t) => ids.add(t.id));
  const naAt = {}; // следующее действие на конец дня
  for (const e of naEv.data) naAt[e.task_id] = e.kind === "created" ? e.data?.next_action ?? null : e.data?.new ?? null;
  const rows = {};
  const row = (t) => { const k = t?.project_id || "none"; return (rows[k] ||= { plan: [], fact: [], next: new Map() }); };
  const CR = { moved: "перенесено", task_done: "отменено (задача закрыта)", removed: "удалено", stale: "отменено" };
  for (const r of rem.data) {
    const t = task(r.task_id); if (!t) continue;
    const x = r.status === "cancelled";
    row(t).plan.push(`<li class="${x ? "cancelled" : ""}">${timeOf(r.remind_at)} — ${esc(t.title)}${r.note ? ": " + esc(r.note) : ""}</li>${x ? `<li class="muted small" style="list-style:none">${CR[r.cancel_reason] || "отменено"}</li>` : ""}`);
  }
  for (const t of all.filter((t) => t.due_date === day)) row(t).plan.push(`<li>Срок: ${esc(t.title)}${t.status === "done" ? " ✓" : ""}</li>`);
  for (const e of dueEv.data) { const t = task(e.task_id); if (t && t.due_date !== day) row(t).plan.push(`<li class="cancelled">Срок: ${esc(t.title)}</li><li class="muted small" style="list-style:none">срок перенесён на ${e.data?.new ? fmtD(e.data.new) : "—"}</li>`); }
  for (const e of ev.data) {
    const t = task(e.task_id); if (!t) continue;
    if (e.kind === "next_action") continue;
    const txt = e.kind === "result" ? `<b>${esc(e.text)}</b>` : e.kind === "created" ? `Создана задача` : esc(e.text);
    row(t).fact.push(`<li>${timeOf(e.created_at)} — ${esc(t.title)}: ${txt}</li>`);
  }
  for (const i of ids) {
    const t = task(i); if (!t) continue;
    const na = day === todayStr() ? t.next_action : (i in naAt ? naAt[i] : t.next_action);
    if (t.status === "done" && (!t.completed_at || dateOf(new Date(t.completed_at)) <= day)) { row(t).next.set(i, `<li>${esc(t.title)}: завершено</li>`); continue; }
    row(t).next.set(i, `<li>${esc(t.title)}: ${na ? esc(na) : "<span class='muted'>не указано</span>"}${day === todayStr() && t.remind_at ? ` <span class="muted">(🔔 ${fmtDT(t.remind_at)})</span>` : ""}</li>`);
  }
  const keys = Object.keys(rows);
  if (!keys.length) { el.innerHTML = `<div class="card empty">На этот день записей нет</div>`; return; }
  const name = (k) => k === "none" ? "Без объекта" : (S.projects.find((p) => p.id === k)?.name || "Объект");
  keys.sort((a, b) => name(a).localeCompare(name(b), "ru"));
  el.innerHTML = `<table class="pf"><thead><tr><th>Проект</th><th>Запланировано</th><th>Произошло</th><th>Следующее действие</th></tr></thead><tbody>
    ${keys.map((k) => `<tr><td data-l="Проект">${esc(name(k))}</td>
      <td data-l="Запланировано">${rows[k].plan.length ? `<ul>${rows[k].plan.join("")}</ul>` : "<span class='muted'>—</span>"}</td>
      <td data-l="Произошло">${rows[k].fact.length ? `<ul>${rows[k].fact.join("")}</ul>` : "<span class='muted'>—</span>"}</td>
      <td data-l="Следующее действие">${rows[k].next.size ? `<ul>${[...rows[k].next.values()].join("")}</ul>` : "<span class='muted'>—</span>"}</td></tr>`).join("")}
  </tbody></table>`;
}

// ---------------- Чат ----------------
const chatKey = () => "q17chat:" + (S.user?.id || "");
function loadChat() { try { S.chat = JSON.parse(localStorage.getItem(chatKey()) || "[]"); } catch { S.chat = []; } }
function saveChat() { try { localStorage.setItem(chatKey(), JSON.stringify(S.chat.slice(-60))); } catch { /* ignore */ } }
function viewChat() {
  const msgs = S.chat.map((m, i) => {
    if (m.role === "user") return `<div class="msg me">${esc(m.display || m.content)}</div>`;
    const acts = (m.actions || []).map((a) => a.task_id ? `<a class="btn small" href="#/task/${a.task_id}">✓ ${esc(a.summary)} — открыть</a>` : "").join("");
    const cands = (m.candidates || []).map((c, j) => `<button class="btn small" data-cand="${i}:${j}">${esc(c.title)}${c.project ? " · " + esc(c.project) : ""}</button>`).join("");
    const tasks = (m.tasks || []).map((t) => `<a class="btn small" href="#/task/${t.id}" style="justify-content:flex-start">${esc(t.title)} · ${esc(projName(t))}${t.remind_at ? " · 🔔 " + fmtDT(t.remind_at) : t.due_date ? " · срок " + fmtD(t.due_date) : ""}</a>`).join("");
    return `<div class="msg bot ${m.error ? "err" : ""}">${esc(m.content)}${acts || cands || tasks ? `<div class="acts">${acts}${cands ? `<div class="muted small">Выберите задачу:</div>${cands}` : ""}${tasks}</div>` : ""}</div>`;
  }).join("");
  const intro = `<div class="msg bot">Напишите, что нужно сделать или что произошло. Например:
«По Акколу поставка нужна к пятнице. Завтра в 11:00 напомни уточнить дату отгрузки»
«По Акколу позвонил. Поставщик обещал ответить в четверг. Напомни в четверг в 10:00»
«Что у меня сегодня?», «Что просрочено?», «Покажи задачи по Акколу»${S.aiState === "off" ? "\n\nИИ-помощник пока не подключён: я отвечаю на вопросы о делах, а задачи добавляйте кнопкой «Добавить задачу»." : ""}</div>`;
  shell("Чат", `<div class="chat" id="chat">${intro}${msgs}${S.chatBusy ? `<div class="msg bot"><span class="spinner"></span> Думаю и сохраняю…</div>` : ""}</div>
    <div class="chatbar">
      <div class="sugg">${["Что у меня сегодня?", "Что просрочено?", "Покажи задачи по объекту…"].map((s) => `<button data-sugg="${esc(s)}">${esc(s)}</button>`).join("")}${S.chat.length ? `<button data-act="clear-chat">Очистить чат</button>` : ""}</div>
      <form class="row" id="chatForm"><textarea class="i" name="m" placeholder="Сообщение…" rows="1" ${S.chatBusy ? "disabled" : ""}></textarea><button class="btn primary" ${S.chatBusy ? "disabled" : ""}>Отправить</button></form>
    </div>`, { fab: false });
  const c = document.getElementById("chat"); window.scrollTo(0, document.body.scrollHeight); c && c.lastElementChild?.scrollIntoView({ block: "end" });
}
async function sendChat(content, display) {
  if (!content.trim() || S.chatBusy) return;
  S.chat.push({ role: "user", content, display }); S.chatBusy = true; saveChat(); render();
  let reply;
  try {
    const local = S.aiState === "off" ? localAnswer(content) : null;
    if (local) reply = local;
    else {
      const { data: s } = await sb.auth.getSession();
      const res = await fetch(`${C.supabaseUrl}/functions/v1/assistant`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${s.session?.access_token}`, apikey: C.supabaseKey },
        body: JSON.stringify({ message: content, history: S.chat.slice(-11, -1).map((m) => ({ role: m.role, content: m.content })) }),
      });
      const j = await res.json().catch(() => ({}));
      if (j.error === "no_key") {
        S.aiState = "off";
        reply = localAnswer(content) || { role: "assistant", content: "ИИ-помощник пока не подключён (нужен ключ API на сервере). Ничего не сохранено. Добавьте задачу кнопкой «Добавить задачу» или задайте вопрос: «Что у меня сегодня?», «Что просрочено?», «Покажи задачи по …»." };
      } else if (!res.ok || j.error) {
        reply = { role: "assistant", error: true, content: "Не удалось выполнить. Ничего не сохранено. " + (j.message || `Ошибка сервера (${res.status})`) };
      } else {
        S.aiState = "on";
        reply = { role: "assistant", content: j.reply, actions: j.actions, candidates: j.candidates };
        if (j.actions?.length) await refresh();
      }
    }
  } catch (e) {
    reply = { role: "assistant", error: true, content: "Не удалось выполнить. Ничего не сохранено. " + errText(e) };
  }
  S.chat.push(reply); S.chatBusy = false; saveChat(); render();
}
// Ответы без ИИ: вопросы о текущих делах
function localAnswer(q) {
  const s = q.toLowerCase();
  const open = S.tasks.filter(isOpen), t0 = todayStr(), now = Date.now();
  const endToday = new Date(localToUtc(addDays(t0, 1) + "T00:00")).getTime();
  const mk = (content, tasks) => ({ role: "assistant", content, tasks: tasks.map((t) => ({ id: t.id, title: t.title, project_id: t.project_id, remind_at: t.remind_at, due_date: t.due_date })) });
  if (/просроч/.test(s)) {
    const l = open.filter((t) => (t.due_date && t.due_date < t0) || (t.remind_at && new Date(t.remind_at).getTime() < now));
    return mk(l.length ? `Просрочено: ${l.length}.` : "Просроченных задач нет.", l);
  }
  if (/сегодня/.test(s) && /(что|какие|план|дел)/.test(s)) {
    const l = open.filter((t) => t.due_date === t0 || (t.remind_at && new Date(t.remind_at).getTime() < endToday));
    return mk(l.length ? `На сегодня (${fmtD(t0)}): ${l.length}.` : `На сегодня (${fmtD(t0)}) ничего не запланировано.`, l);
  }
  if (/завтра/.test(s) && /(что|какие|план|дел)/.test(s) && !/напомни/.test(s)) {
    const d = addDays(t0, 1);
    const l = open.filter((t) => t.due_date === d || (t.remind_at && dateOf(new Date(t.remind_at)) === d));
    return mk(l.length ? `На завтра (${fmtD(d)}): ${l.length}.` : `На завтра (${fmtD(d)}) ничего нет.`, l);
  }
  const m = /(?:задачи|покажи|что)\s+(?:по|на)\s+(.+?)[?.!]*$/.exec(s);
  if (m) {
    const key = m[1].trim().slice(0, 4);
    const ps = S.projects.filter((p) => p.name.toLowerCase().includes(key));
    if (ps.length) {
      const l = open.filter((t) => ps.some((p) => p.id === t.project_id));
      return mk(`${ps.map((p) => p.name).join(", ")}: открытых задач ${l.length}.`, l);
    }
    return { role: "assistant", content: `Объект «${m[1]}» не найден. Объекты: ${S.projects.map((p) => p.name).join(", ") || "пока нет"}.` };
  }
  return null;
}

// ---------------- Настройки ----------------
function pushState() {
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  const supported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  return { ios, standalone, supported, perm: "Notification" in window ? Notification.permission : "unsupported" };
}
function pushBanner() {
  const st = pushState();
  if (localStorage.getItem("q17pushDismiss") === "1") return "";
  if (st.perm === "granted" && localStorage.getItem("q17pushOn") === "1") return "";
  if (st.ios && !st.standalone) return `<div class="banner info">Чтобы получать напоминания на iPhone, добавьте приложение на экран «Домой»: кнопка «Поделиться» → «На экран Домой», затем откройте его с иконки и включите уведомления. <div class="row"><a class="btn small" href="#/settings">Подробнее</a><button class="btn small ghost" data-act="dismiss-push">Скрыть</button></div></div>`;
  if (!st.supported) return "";
  if (st.perm === "denied") return `<div class="banner">Уведомления запрещены в настройках браузера. Напоминания видны только в приложении. <div class="row"><a class="btn small" href="#/settings">Как включить</a><button class="btn small ghost" data-act="dismiss-push">Скрыть</button></div></div>`;
  return `<div class="banner info">Включите уведомления, чтобы напоминания приходили даже при закрытом приложении. <div class="row"><button class="btn small primary" data-act="enable-push">Включить уведомления</button><button class="btn small ghost" data-act="dismiss-push">Позже</button></div></div>`;
}
async function enablePush(btn) {
  const st = pushState();
  if (st.ios && !st.standalone) { toast("На iPhone сначала добавьте приложение на экран «Домой» и откройте его с иконки.", true, 7000); return; }
  if (!st.supported) { toast("Этот браузер не поддерживает веб-уведомления.", true); return; }
  await busy(btn, async () => {
    const perm = await Notification.requestPermission();
    if (perm !== "granted") { toast("Разрешение на уведомления не выдано.", true); return; }
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      const key = Uint8Array.from(atob(C.vapidPublicKey.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    }
    const j = sub.toJSON();
    const { error } = await sb.from("push_subscriptions").upsert({ endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth, user_agent: navigator.userAgent.slice(0, 300) }, { onConflict: "endpoint" });
    if (error) throw error;
    localStorage.setItem("q17pushOn", "1");
    toast("Уведомления включены на этом устройстве.");
  }).catch((e) => toast("Не удалось включить уведомления: " + errText(e), true, 7000));
  render();
}
async function testPush(btn) {
  await busy(btn, async () => {
    const { data: s } = await sb.auth.getSession();
    const res = await fetch(`${C.supabaseUrl}/functions/v1/send-reminders`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${s.session?.access_token}`, apikey: C.supabaseKey },
      body: JSON.stringify({ test: true }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Ошибка сервера (${res.status})`);
    if (j.delivered > 0) toast(`Проверочное уведомление отправлено на устройств: ${j.delivered}.`);
    else toast("Нет устройств с включёнными уведомлениями." + (j.errors?.length ? " " + j.errors[0] : ""), true, 7000);
  }).catch((e) => toast(errText(e), true));
}
function viewSettings() {
  const st = pushState();
  const examples = S.projects.some((p) => p.is_example) || S.tasks.some((t) => t.is_example);
  shell("Настройки", `
    <h2>Аккаунт</h2>
    <div class="card"><div>Вы вошли как <b>${esc(S.user?.email)}</b></div><div class="muted small">Задачи хранятся на сервере и доступны с телефона и компьютера под этим входом.</div>
      <div class="row" style="margin-top:10px"><button class="btn small" data-act="logout">Выйти</button></div></div>
    <h2>Уведомления</h2>
    <div class="card">
      <div>Статус на этом устройстве: <b>${st.perm === "granted" && localStorage.getItem("q17pushOn") === "1" ? "включены" : st.perm === "denied" ? "запрещены в браузере" : st.supported ? "выключены" : "не поддерживаются здесь"}</b></div>
      <div class="row" style="margin-top:10px">
        <button class="btn small primary" data-act="enable-push">Включить уведомления</button>
        <button class="btn small" data-act="test-push">Проверить уведомление</button>
      </div>
      <ul class="small" style="padding-left:18px;margin-bottom:0">
        <li><b>Компьютер</b> (Chrome, Edge, Firefox, Safari): уведомления приходят, даже если вкладка закрыта, пока сам браузер запущен (он может работать в фоне).</li>
        <li><b>Android</b> (Chrome): приходят при закрытой вкладке и приложении. Установка на главный экран не обязательна, но удобна.</li>
        <li><b>iPhone/iPad</b> (iOS 16.4 и новее): только после «Поделиться» → «На экран Домой». Откройте приложение с иконки, войдите и нажмите «Включить уведомления». В обычной вкладке Safari уведомления на iPhone не работают.</li>
        <li>Включайте уведомления на каждом устройстве отдельно. Если уведомления запрещены, разрешите их в настройках сайта в браузере (значок замка в адресной строке) или в «Настройки → Уведомления» на телефоне.</li>
      </ul>
      ${st.ios && !st.standalone ? `<div class="banner info">Сейчас приложение открыто в Safari. Добавьте его на экран «Домой», чтобы включить уведомления.</div>` : ""}
    </div>
    <h2>Установка на главный экран</h2>
    <div class="card small">
      <div><b>Android / Chrome на компьютере:</b> меню браузера → «Установить приложение» или «Добавить на главный экран».</div>
      <div style="margin-top:6px"><b>iPhone:</b> Safari → «Поделиться» → «На экран Домой». На iPhone в установленном приложении нужно войти заново один раз.</div>
    </div>
    <h2>ИИ-помощник в чате</h2>
    <div class="card small">${S.aiState === "on" ? "Подключён." : S.aiState === "off" ? "Не подключён: на сервере нет ключа ИИ. Чат отвечает на вопросы о делах, а задачи добавляются кнопками." : "Статус проверяется при первом сообщении в чате."}</div>
    <h2>Демонстрационные данные</h2>
    <div class="card small">Примеры помечены «пример» и не смешиваются с вашими записями.
      <div class="row" style="margin-top:10px">${examples ? `<button class="btn small danger" data-act="del-examples">Удалить примеры</button>` : `<button class="btn small" data-act="examples">Загрузить примеры</button>`}</div></div>
    <p class="muted small" style="margin-top:18px">Часовой пояс приложения: Asia/Almaty. Время в задачах всегда показывается по Алматы.</p>`, { back: "#/today", fab: false });
}

// ---------------- листы (формы) ----------------
function sheet(html, onMount) {
  closeSheet();
  const bg = document.createElement("div");
  bg.className = "sheet-bg"; bg.innerHTML = `<div class="sheet" role="dialog" aria-modal="true">${html}</div>`;
  bg.addEventListener("click", (e) => { if (e.target === bg || e.target.closest("[data-close]")) closeSheet(); });
  document.body.appendChild(bg);
  onMount && onMount(bg.querySelector(".sheet"));
  const first = bg.querySelector("input,textarea"); first && setTimeout(() => first.focus(), 50);
}
function closeSheet() { document.querySelectorAll(".sheet-bg").forEach((x) => x.remove()); }
function wireDateHints(root) {
  if (!root) return;
  const upd = () => {
    root.querySelectorAll("[data-hint]").forEach((h) => {
      const inp = root.querySelector(`[name="${h.dataset.hint}"]`); if (!inp) return;
      const v = inp.value;
      h.textContent = !v ? "" : inp.type === "date" ? "= " + fmtD(v) : (() => { const iso = localToUtc(v); return iso ? `= ${fmtDT(iso)}${new Date(iso) < new Date() ? " (уже прошло)" : ""}` : ""; })();
    });
  };
  root.addEventListener("input", upd); root.addEventListener("change", upd); upd();
  root.querySelectorAll("[data-quick]").forEach((b) => b.addEventListener("click", (e) => {
    e.preventDefault();
    const [field, val] = b.dataset.quick.split("|");
    root.querySelector(`[name="${field}"]`).value = val; upd();
    const det = root.querySelector("details.more"); if (det) det.open = true;
  }));
  const sel = root.querySelector('select[name="project_id"]');
  if (sel) sel.addEventListener("change", () => { const n = root.querySelector("[data-newproj]"); n.hidden = sel.value !== "__new"; if (!n.hidden) n.querySelector("input").focus(); });
}
function quickDue() {
  const t = todayStr();
  return [["Сегодня", t], ["Завтра", addDays(t, 1)], ["Пятница", weekday(t) === 5 ? t : nextWeekday(5)], ["Через неделю", addDays(t, 7)]];
}
function quickRem() {
  const t = todayStr(); const now = Date.now();
  const inH = utcToLocal(new Date(Math.ceil((now + 3600000) / 900000) * 900000).toISOString());
  const list = [["Через час", inH]];
  if (new Date(localToUtc(t + "T17:00")).getTime() > now + 600000) list.push(["Сегодня 17:00", t + "T17:00"]);
  list.push(["Завтра 10:00", addDays(t, 1) + "T10:00"], ["Завтра 11:00", addDays(t, 1) + "T11:00"], ["Пн 10:00", nextWeekday(1) + "T10:00"]);
  return list;
}
function addTaskSheet(projectId = "") {
  const projOpts = `<option value="">Без объекта</option>` + S.projects.map((p) => `<option value="${p.id}" ${p.id === projectId ? "selected" : ""}>${esc(p.name)}</option>`).join("") + `<option value="__new" ${!S.projects.length ? "selected" : ""}>＋ Новый объект…</option>`;
  sheet(`<form id="addForm">
    <div class="row"><h3 class="grow">Новая задача</h3><button type="button" class="icon-btn" data-close aria-label="Закрыть">✕</button></div>
    <label class="f"><span>Название *</span><input class="i" name="title" required placeholder="Например: Поставка металла"></label>
    <label class="f"><span>Объект</span><select class="i" name="project_id">${projOpts}</select></label>
    <label class="f" ${S.projects.length ? "hidden" : ""} data-newproj><span>Название нового объекта</span><input class="i" name="new_project" placeholder="Например: Аккол"></label>
    <details class="more"><summary>＋ Срок, напоминание и другие поля</summary>
      <label class="f"><span>Срок выполнения</span><input class="i" type="date" name="due_date"><div class="hint" data-hint="due_date"></div></label>
      <div class="seg">${quickDue().map(([l, v]) => `<button data-quick="due_date|${v}">${l}</button>`).join("")}</div>
      <label class="f"><span>Напоминание (время Алматы)</span><input class="i" type="datetime-local" name="remind_at"><div class="hint" data-hint="remind_at"></div></label>
      <div class="seg">${quickRem().map(([l, v]) => `<button data-quick="remind_at|${v}">${l}</button>`).join("")}</div>
      <label class="f"><span>Следующее действие</span><input class="i" name="next_action" placeholder="Например: Уточнить дату отгрузки"></label>
      <label class="f"><span>Ответственный</span><input class="i" name="assignee"></label>
      <label class="f"><span>Статус</span><select class="i" name="status">${["planned", "in_progress", "waiting"].map((s) => `<option value="${s}">${STATUS[s]}</option>`).join("")}</select></label>
    </details>
    <div class="row end" style="margin-top:16px"><button type="button" class="btn ghost" data-close>Отмена</button><button class="btn primary" type="submit">Добавить задачу</button></div>
  </form>`, (root) => wireDateHints(root));
}
async function readTaskForm(form) {
  const f = Object.fromEntries(new FormData(form));
  const row = { title: (f.title || "").trim() };
  if (!row.title) throw new Error("Введите название задачи");
  if (f.project_id === "__new") {
    if (!f.new_project?.trim()) throw new Error("Введите название нового объекта");
    row.project_id = await ensureProject(f.new_project);
  } else row.project_id = f.project_id || null;
  if ("due_date" in f) row.due_date = f.due_date || null;
  if ("remind_at" in f) row.remind_at = f.remind_at ? localToUtc(f.remind_at) : null;
  if ("next_action" in f) row.next_action = f.next_action?.trim() || null;
  if ("assignee" in f) row.assignee = f.assignee?.trim() || null;
  if (f.status) row.status = f.status;
  return row;
}
function reschedSheet(id) {
  const t = S.tasks.find((x) => x.id === id); if (!t) return;
  sheet(`<form id="reschedForm" data-id="${id}">
    <div class="row"><h3 class="grow">Перенести напоминание</h3><button type="button" class="icon-btn" data-close aria-label="Закрыть">✕</button></div>
    <p class="muted" style="margin:0">${esc(t.title)}<br>Сейчас: ${t.remind_at ? fmtDT(t.remind_at) : "напоминания нет"}</p>
    <div class="seg" style="margin-top:12px">${quickRem().map(([l, v]) => `<button data-quick="remind_at|${v}">${l}</button>`).join("")}</div>
    <label class="f"><span>Новое время (Алматы)</span><input class="i" type="datetime-local" name="remind_at" required value="${utcToLocal(t.remind_at)}"><div class="hint" data-hint="remind_at"></div></label>
    <label class="f"><span>Следующее действие</span><input class="i" name="next_action" value="${esc(t.next_action || "")}"></label>
    <div class="row end" style="margin-top:16px">${t.remind_at ? `<button type="button" class="btn ghost danger" data-clear-rem="${id}">Убрать напоминание</button>` : ""}<button class="btn primary" type="submit">Перенести</button></div>
  </form>`, (root) => wireDateHints(root));
}
function resultSheet(id) {
  const t = S.tasks.find((x) => x.id === id); if (!t) return;
  sheet(`<form id="resultForm" data-id="${id}">
    <div class="row"><h3 class="grow">Добавить результат</h3><button type="button" class="icon-btn" data-close aria-label="Закрыть">✕</button></div>
    <p class="muted" style="margin:0">${esc(t.title)} · ${esc(projName(t))}</p>
    <label class="f"><span>Что произошло</span><textarea class="i" name="text" required placeholder="Например: Позвонил. Поставщик обещал ответить в четверг"></textarea></label>
    <div class="seg"><button type="button" class="on" data-kind="result">Результат</button><button type="button" data-kind="comment">Комментарий</button></div>
    <input type="hidden" name="kind" value="result">
    <h2 style="margin-top:16px">Следующий шаг (необязательно)</h2>
    <label class="f"><span>Следующее действие</span><input class="i" name="next_action" value="${esc(t.next_action || "")}"></label>
    <label class="f"><span>Новое напоминание (Алматы)</span><input class="i" type="datetime-local" name="remind_at" value="${utcToLocal(t.remind_at)}"><div class="hint" data-hint="remind_at"></div></label>
    <div class="seg">${quickRem().map(([l, v]) => `<button data-quick="remind_at|${v}">${l}</button>`).join("")}</div>
    <label class="f"><span>Статус</span><select class="i" name="status">${STATUS_ORDER.map((s) => `<option value="${s}" ${s === t.status ? "selected" : ""}>${STATUS[s]}</option>`).join("")}</select></label>
    <div class="row end" style="margin-top:16px"><button type="button" class="btn ghost" data-close>Отмена</button><button class="btn primary" type="submit">Сохранить</button></div>
  </form>`, (root) => {
    wireDateHints(root);
    root.querySelectorAll("[data-kind]").forEach((b) => b.addEventListener("click", () => {
      root.querySelectorAll("[data-kind]").forEach((x) => x.classList.toggle("on", x === b));
      root.querySelector('[name="kind"]').value = b.dataset.kind;
    }));
  });
}

// ---------------- примеры ----------------
async function loadExamples(btn) {
  await busy(btn, async () => {
    const t = todayStr();
    const { data: ps, error } = await sb.from("projects").insert([
      { name: "Аккол (пример)", is_example: true }, { name: "ЖК Береке (пример)", is_example: true }, { name: "Склад Косшы (пример)", is_example: true },
    ]).select();
    if (error) throw error;
    const [a, b, c] = ps.map((p) => p.id);
    const rows = [
      { project_id: a, title: "Поставка металлоконструкций", status: "in_progress", due_date: weekday(t) === 5 ? t : nextWeekday(5), next_action: "Уточнить дату отгрузки у поставщика", remind_at: localToUtc(addDays(t, 1) + "T11:00") },
      { project_id: a, title: "Согласовать КМД с заказчиком", status: "waiting", next_action: "Ждём замечания от ГИПа", remind_at: localToUtc(addDays(t, 2) + "T10:00") },
      { project_id: b, title: "Коммерческое предложение на фасад", status: "planned", due_date: addDays(t, 3), next_action: "Собрать цены на кассеты" },
      { project_id: b, title: "Оплата аванса субподрядчику", status: "in_progress", due_date: addDays(t, -1), next_action: "Проверить счёт в бухгалтерии" },
      { project_id: c, title: "Расчёт фундамента под оборудование", status: "planned", next_action: "Запросить нагрузки у технолога", remind_at: localToUtc(t + "T17:30") },
    ].map((r) => ({ ...r, is_example: true }));
    const r2 = await sb.from("tasks").insert(rows);
    if (r2.error) throw r2.error;
    await refresh();
    toast("Примеры загружены. Они помечены «пример».");
  }).catch((e) => toast("Не удалось загрузить примеры: " + errText(e), true));
}
async function deleteExamples(btn) {
  if (!confirm("Удалить все демонстрационные задачи и объекты (помеченные «пример»)? Ваши записи не затрагиваются.")) return;
  await busy(btn, async () => {
    const r1 = await sb.from("tasks").delete().eq("is_example", true); if (r1.error) throw r1.error;
    const r2 = await sb.from("projects").delete().eq("is_example", true); if (r2.error) throw r2.error;
    await refresh(); toast("Примеры удалены.");
  }).catch((e) => toast(errText(e), true));
}

// ---------------- напоминания внутри приложения ----------------
function checkInAppReminders() {
  if (!S.loaded || document.querySelector(".reminder-pop") || document.querySelector(".sheet-bg")) return;
  const now = Date.now();
  let seen = {}; try { seen = JSON.parse(sessionStorage.getItem("q17seen") || "{}"); } catch { /* */ }
  const due = S.tasks.filter((t) => isOpen(t) && t.remind_at && new Date(t.remind_at).getTime() <= now && now - new Date(t.remind_at).getTime() < 12 * 3600000 && !seen[t.id + t.remind_at])
    .sort((a, b) => a.remind_at.localeCompare(b.remind_at))[0];
  if (!due) return;
  seen[due.id + due.remind_at] = 1; try { sessionStorage.setItem("q17seen", JSON.stringify(seen)); } catch { /* */ }
  const el = document.createElement("div");
  el.className = "card reminder-pop"; el.setAttribute("role", "alert");
  el.innerHTML = `<div class="muted small">🔔 Напоминание · ${fmtDT(due.remind_at)}</div>
    <div class="t" style="font-weight:700;font-size:18px">${esc(projName(due))}: ${esc(due.title)}</div>
    ${due.next_action ? `<div>→ ${esc(due.next_action)}</div>` : ""}
    <div class="row" style="margin-top:10px"><a class="btn small primary" href="#/task/${due.id}" data-pop-close>Открыть</a><button class="btn small" data-resched="${due.id}" data-pop-close>Перенести</button><button class="btn small done" data-done="${due.id}" data-pop-close>✓ Готово</button><button class="btn small ghost" data-pop-close>Закрыть</button></div>`;
  el.addEventListener("click", (e) => { if (e.target.closest("[data-pop-close]")) setTimeout(() => el.remove(), 0); });
  document.body.appendChild(el);
}

// ---------------- вход ----------------
function viewLogin(msg = "", err = false) {
  $app.innerHTML = `<div class="login">
    <h1>Q17 Задачи</h1><p class="muted">Задачи и напоминания по объектам</p>
    ${msg ? `<div class="banner ${err ? "err" : "info"}">${esc(msg)}</div>` : ""}
    <form class="card" id="loginForm">
      <label class="f"><span>Электронная почта</span><input class="i" type="email" name="email" autocomplete="username" required></label>
      <label class="f"><span>Пароль</span><input class="i" type="password" name="password" autocomplete="current-password" required minlength="6"></label>
      <div class="row" style="margin-top:16px"><button class="btn primary grow" name="mode" value="in">Войти</button></div>
      <div class="row" style="margin-top:8px"><button class="btn ghost grow" name="mode" value="up">Создать аккаунт</button></div>
    </form>
    <p class="muted small">Один аккаунт работает на телефоне и компьютере. Пароль не меньше 6 символов.</p></div>`;
}

// ---------------- рендер и события ----------------
function render() {
  if (!S.user) return viewLogin();
  if (!S.loaded) { $app.innerHTML = S.loadError ? `<div class="login"><div class="banner err">${esc(S.loadError)}</div><button class="btn" data-act="reload">Повторить</button></div>` : `<div class="boot"><span class="spinner"></span> Загружаю задачи…</div>`; return; }
  const r = route();
  if (r.name === "today") viewToday();
  else if (r.name === "projects") viewProjects();
  else if (r.name === "project") viewProject(r.id);
  else if (r.name === "task") viewTask(r.id);
  else if (r.name === "chat") viewChat();
  else if (r.name === "plan") viewPlan();
  else if (r.name === "settings") viewSettings();
  else viewToday();
}

document.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-act],[data-open],[data-project],[data-done],[data-reopen],[data-resched],[data-result],[data-status],[data-day],[data-sugg],[data-cand],[data-rename],[data-archive],[data-clear-rem]");
  if (!el) return;
  const d = el.dataset;
  // кнопки внутри карточки не должны открывать карточку
  if (d.open && e.target.closest("button,a") && e.target.closest("button,a") !== el) return;
  try {
    if (d.act === "add") addTaskSheet(el.dataset.project || "");
    else if (d.act === "reload") { S.loadError = null; await refresh(false); }
    else if (d.act === "new-project") {
      const n = prompt("Название объекта:"); if (n && n.trim()) { await ensureProject(n); await refresh(); toast(`Объект «${n.trim()}» добавлен`); }
    }
    else if (d.act === "enable-push") await enablePush(el);
    else if (d.act === "test-push") await testPush(el);
    else if (d.act === "dismiss-push") { localStorage.setItem("q17pushDismiss", "1"); render(); }
    else if (d.act === "logout") { await sb.auth.signOut(); }
    else if (d.act === "examples") await loadExamples(el);
    else if (d.act === "del-examples") await deleteExamples(el);
    else if (d.act === "clear-chat") { S.chat = []; saveChat(); render(); }
    else if (d.open) location.hash = `#/task/${d.open}`;
    else if (d.project) location.hash = `#/project/${d.project}`;
    else if (d.done) {
      const t = S.tasks.find((x) => x.id === d.done);
      await busy(el, () => updateTask(d.done, { status: "done" }));
      toast(`Готово: «${t?.title}».${t?.remind_at ? " Будущие напоминания отменены." : ""}`);
    }
    else if (d.reopen) { await busy(el, () => updateTask(d.reopen, { status: "in_progress" })); toast("Задача снова в работе"); }
    else if (d.resched) reschedSheet(d.resched);
    else if (d.result) resultSheet(d.result);
    else if (d.status) {
      if (S.tasks.find((x) => x.id === d.id)?.status === d.status) return;
      await updateTask(d.id, { status: d.status }); toast(`Статус: ${STATUS[d.status]}`);
    }
    else if (d.day) location.hash = `#/plan?d=${d.day}`;
    else if (d.sugg) {
      const ta = document.querySelector("#chatForm textarea");
      if (d.sugg.endsWith("…")) { ta.value = "Покажи задачи по "; ta.focus(); } else sendChat(d.sugg);
    }
    else if (d.cand) {
      const [i, j] = d.cand.split(":").map(Number); const c = S.chat[i]?.candidates?.[j];
      const prev = [...S.chat].reverse().find((m) => m.role === "user");
      if (c) sendChat(`Это задача «${c.title}» (id ${c.id}). Выполни мой предыдущий запрос${prev ? ": " + prev.content : ""}`, `Выбрал: «${c.title}»`);
    }
    else if (d.rename) {
      const p = S.projects.find((x) => x.id === d.rename); const n = prompt("Новое название объекта:", p?.name || "");
      if (n && n.trim()) { const { error } = await sb.from("projects").update({ name: n.trim() }).eq("id", d.rename); if (error) throw error; await refresh(); toast("Переименовано"); }
    }
    else if (d.archive) {
      if (!confirm("Убрать объект в архив? Задачи сохранятся, но объект исчезнет из списка.")) return;
      const { error } = await sb.from("projects").update({ archived: true }).eq("id", d.archive); if (error) throw error;
      location.hash = "#/projects"; await refresh(); toast("Объект в архиве");
    }
    else if (d.clearRem) { await busy(el, () => updateTask(d.clearRem, { remind_at: null })); closeSheet(); toast("Напоминание убрано"); }
  } catch (err) { toast("Не удалось сохранить: " + errText(err), true, 7000); }
});

document.addEventListener("submit", async (e) => {
  const form = e.target; e.preventDefault();
  const btn = form.querySelector('[type="submit"],button:not([type])');
  try {
    if (form.id === "loginForm") {
      const mode = e.submitter?.value || "in";
      const f = Object.fromEntries(new FormData(form));
      await busy(e.submitter, async () => {
        if (mode === "up") {
          const { data, error } = await sb.auth.signUp({ email: f.email, password: f.password, options: { emailRedirectTo: location.origin + location.pathname } });
          if (error) throw error;
          if (!data.session) viewLogin("Аккаунт создан. Откройте письмо от Supabase и нажмите ссылку подтверждения, затем войдите здесь.");
        } else {
          const { error } = await sb.auth.signInWithPassword({ email: f.email, password: f.password });
          if (error) throw error;
        }
      }).catch((err) => viewLogin(/Invalid login/i.test(err.message) ? "Неверная почта или пароль." : /not confirmed/i.test(err.message) ? "Почта ещё не подтверждена. Откройте письмо и нажмите ссылку." : errText(err), true));
      return;
    }
    if (form.id === "addForm") {
      await busy(btn, async () => {
        const row = await readTaskForm(form);
        const t = await createTask(row);
        closeSheet(); toast(confirmText(t), false, 6500);
      });
    } else if (form.id === "editForm") {
      const id = route().id;
      await busy(btn, async () => {
        const row = await readTaskForm(form);
        const t = await updateTask(id, row); toast(confirmText(t), false, 6000);
      });
    } else if (form.id === "reschedForm") {
      const id = form.dataset.id; const f = Object.fromEntries(new FormData(form));
      const iso = localToUtc(f.remind_at);
      if (!iso) throw new Error("Укажите дату и время");
      if (new Date(iso) < new Date()) throw new Error("Это время уже прошло");
      await busy(btn, async () => {
        const t = await updateTask(id, { remind_at: iso, next_action: f.next_action.trim() || null });
        closeSheet(); toast(`Напоминание перенесено на ${fmtDT(t.remind_at)}`, false, 6000);
      });
    } else if (form.id === "resultForm") {
      const id = form.dataset.id; const f = Object.fromEntries(new FormData(form));
      const t = S.tasks.find((x) => x.id === id);
      if (!f.text.trim()) throw new Error("Опишите результат");
      await busy(btn, async () => {
        await addEvent(id, f.kind, f.text.trim());
        const patch = {};
        const iso = f.remind_at ? localToUtc(f.remind_at) : null;
        if ((iso || null) !== (t.remind_at ? new Date(t.remind_at).toISOString() : null) && iso !== null) {
          if (new Date(iso) < new Date()) throw new Error("Результат сохранён, но время напоминания уже прошло — укажите другое");
          patch.remind_at = iso;
        }
        if ((f.next_action.trim() || null) !== (t.next_action || null)) patch.next_action = f.next_action.trim() || null;
        if (f.status !== t.status) patch.status = f.status;
        let saved = t;
        if (Object.keys(patch).length) saved = await updateTask(id, patch); else await refresh();
        closeSheet();
        toast(`Результат сохранён.${patch.remind_at ? " Следующая проверка: " + fmtDT(saved.remind_at) + "." : ""}${patch.status === "done" ? " Задача закрыта." : ""}`, false, 6500);
      });
    } else if (form.id === "chatForm") {
      const ta = form.querySelector("textarea"); const v = ta.value; ta.value = ""; await sendChat(v);
    }
  } catch (err) { toast(errText(err), true, 7000); }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && e.target.matches("#chatForm textarea")) { e.preventDefault(); e.target.form.requestSubmit(); }
  if (e.key === "Escape") closeSheet();
});
document.addEventListener("change", (e) => { if (e.target.id === "pfDay" && e.target.value) location.hash = `#/plan?d=${e.target.value}`; });
window.addEventListener("hashchange", () => { closeSheet(); window.scrollTo(0, 0); render(); });
window.addEventListener("focus", () => S.user && refresh());
document.addEventListener("visibilitychange", () => { if (!document.hidden && S.user) refresh(); });

// ---------------- запуск ----------------
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
  navigator.serviceWorker.addEventListener("message", (e) => {
    if (e.data?.type === "push") refresh();
    if (e.data?.type === "open" && e.data.url) location.href = e.data.url;
  });
}
sb.auth.onAuthStateChange((_ev, session) => {
  const was = S.user?.id; S.user = session?.user || null;
  if (S.user && S.user.id !== was) { S.loaded = false; loadChat(); render(); refresh(false); }
  if (!S.user) { S.loaded = false; S.tasks = []; S.projects = []; render(); }
});
sb.auth.getSession().then(({ data }) => { if (!data.session) render(); });
setInterval(() => { if (S.user && !document.hidden) refresh(); }, 60000);
setInterval(checkInAppReminders, 15000);
setTimeout(checkInAppReminders, 3000);
})();
