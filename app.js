/* ===========================================================
   יומן הצלחות — Success Log PWA
   Local-only (IndexedDB), offline-first, RTL Hebrew
   =========================================================== */
'use strict';

/* ---------- IndexedDB storage layer ---------- */
const DB = (() => {
  const NAME = 'success-log-db';
  const VERSION = 1;
  const STORE = 'entries';
  const META = 'meta';
  let dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(NAME, VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const s = db.createObjectStore(STORE, { keyPath: 'id' });
          s.createIndex('createdAt', 'createdAt');
        }
        if (!db.objectStoreNames.contains(META)) {
          db.createObjectStore(META, { keyPath: 'key' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbp;
  }

  async function tx(store, mode) {
    const db = await open();
    return db.transaction(store, mode).objectStore(store);
  }

  return {
    async all() {
      const store = await tx(STORE, 'readonly');
      return new Promise((res, rej) => {
        const out = [];
        const cur = store.openCursor();
        cur.onsuccess = (e) => {
          const c = e.target.result;
          if (c) { out.push(c.value); c.continue(); }
          else res(out);
        };
        cur.onerror = () => rej(cur.error);
      });
    },
    async put(entry) {
      const store = await tx(STORE, 'readwrite');
      return new Promise((res, rej) => {
        const r = store.put(entry);
        r.onsuccess = () => res(entry);
        r.onerror = () => rej(r.error);
      });
    },
    async del(id) {
      const store = await tx(STORE, 'readwrite');
      return new Promise((res, rej) => {
        const r = store.delete(id);
        r.onsuccess = () => res();
        r.onerror = () => rej(r.error);
      });
    },
    async clear() {
      const store = await tx(STORE, 'readwrite');
      return new Promise((res, rej) => {
        const r = store.clear();
        r.onsuccess = () => res();
        r.onerror = () => rej(r.error);
      });
    },
    async getMeta(key, fallback) {
      const store = await tx(META, 'readonly');
      return new Promise((res) => {
        const r = store.get(key);
        r.onsuccess = () => res(r.result ? r.result.value : fallback);
        r.onerror = () => res(fallback);
      });
    },
    async setMeta(key, value) {
      const store = await tx(META, 'readwrite');
      return new Promise((res, rej) => {
        const r = store.put({ key, value });
        r.onsuccess = () => res();
        r.onerror = () => rej(r.error);
      });
    }
  };
})();

/* ---------- App state ---------- */
const State = {
  entries: [],          // {id, createdAt, text, predicted|null, actual|null}
  view: 'list',
  search: '',
  editingId: null,
};

/* ---------- Utilities ---------- */
const $ = (sel, el = document) => el.querySelector(sel);
const main = $('#main');
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const HE_DAYS = ['ראשון','שני','שלישי','רביעי','חמישי','שישי','שבת'];
const HE_MONTHS = ['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];

function fmtDate(ts) {
  const d = new Date(ts);
  return `יום ${HE_DAYS[d.getDay()]}, ${d.getDate()} ב${HE_MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}
function fmtTime(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}
function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}
function relativeDay(ts) {
  const now = new Date(); const d = new Date(ts);
  const k = dayKey(ts);
  if (k === dayKey(now.getTime())) return 'היום';
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (k === dayKey(y.getTime())) return 'אתמול';
  return fmtDate(ts);
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, 2600);
}

// convert epoch ms -> value for <input type=datetime-local> in local time
function tsToLocalInput(ts) {
  const d = new Date(ts - d0OffsetGuard(ts));
  return d.toISOString().slice(0, 16);
}
function d0OffsetGuard(ts) { return new Date(ts).getTimezoneOffset() * 60000; }
function localInputToTs(val) {
  // val like "2026-06-15T14:30" interpreted as local
  const [date, time] = val.split('T');
  const [y, m, day] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  return new Date(y, m - 1, day, hh, mm).getTime();
}

/* ---------- Persistence helpers ---------- */
async function loadAll() {
  State.entries = await DB.all();
  State.entries.sort((a, b) => b.createdAt - a.createdAt);
}
async function saveEntry(entry) {
  await DB.put(entry);
  const i = State.entries.findIndex(e => e.id === entry.id);
  if (i >= 0) State.entries[i] = entry; else State.entries.push(entry);
  State.entries.sort((a, b) => b.createdAt - a.createdAt);
}
async function deleteEntry(id) {
  await DB.del(id);
  State.entries = State.entries.filter(e => e.id !== id);
}

/* ===========================================================
   RENDER
   =========================================================== */
function setTopbar(title, showBack) {
  $('#topbarTitle').textContent = title;
  $('#navBack').hidden = !showBack;
}

function render() {
  // top-level views
  if (State.view === 'list') { renderList(); $('#fab').hidden = false; setNav(true); setTopbar('יומן הצלחות', false); }
  else if (State.view === 'stats') { renderStats(); $('#fab').hidden = false; setNav(true); setTopbar('ההתקדמות שלי', false); }
  else if (State.view === 'form') { renderForm(); $('#fab').hidden = true; setNav(false); setTopbar(State.editingId ? 'עריכת תיעוד' : 'תיעוד הצלחה', true); }
  else if (State.view === 'detail') { renderDetail(); $('#fab').hidden = true; setNav(false); setTopbar('פרטי ההצלחה', true); }
  main.scrollTop = 0;
}
function setNav(show) {
  $('#bottomnav').style.display = show ? 'flex' : 'none';
  document.querySelectorAll('.navtab').forEach(t =>
    t.classList.toggle('active', t.dataset.view === State.view));
}

/* ----- LIST ----- */
function filteredEntries() {
  const q = State.search.trim().toLowerCase();
  return State.entries.filter(e => {
    if (q && !(e.text || '').toLowerCase().includes(q)) return false;
    return true;
  });
}

function sudsChips(e) {
  let html = '';
  if (e.predicted != null) html += `<span class="suds-chip pred">צפי ${e.predicted}</span>`;
  if (e.actual != null) html += `<span class="suds-chip actual">בפועל ${e.actual}</span>`;
  if (e.predicted != null && e.actual != null && e.actual < e.predicted)
    html += `<span class="suds-chip drop">↓ ${e.predicted - e.actual}</span>`;
  return html;
}

function renderList() {
  // Empty journal: keep the page clean so the centered "תיעוד הצלחה" button is the focal point.
  if (!State.entries.length) {
    main.innerHTML = '';
    return;
  }

  const list = filteredEntries();

  let html = `
    <div class="searchbar">
      <input class="search-input" id="searchInput" type="search"
        placeholder="חיפוש בתיעודים…" value="${esc(State.search)}" />
    </div>`;

  if (!list.length) {
    html += `<div class="empty"><span class="emoji">🔍</span><h3>לא נמצאו תוצאות</h3><p>נסי חיפוש אחר.</p></div>`;
  } else {
    let lastDay = null;
    list.forEach(e => {
      const dk = dayKey(e.createdAt);
      if (dk !== lastDay) {
        html += `<div class="day-divider">${esc(relativeDay(e.createdAt))}</div>`;
        lastDay = dk;
      }
      const chips = sudsChips(e);
      html += `<div class="entry-card" data-id="${e.id}">
        <button class="ec-del" data-del="${e.id}" aria-label="מחיקה">🗑️</button>
        <div class="ec-date">🕊️ ${fmtTime(e.createdAt)}</div>
        <div class="ec-text">${esc(e.text) || '<i style="color:var(--ink-soft)">ללא תיאור</i>'}</div>
        ${chips ? `<div class="ec-meta">${chips}</div>` : ''}
      </div>`;
    });
  }

  main.innerHTML = html;

  const si = $('#searchInput');
  if (si) si.addEventListener('input', (e) => {
    State.search = e.target.value;
    renderListBodyOnly();
  });
  main.querySelectorAll('.ec-del').forEach(b =>
    b.addEventListener('click', (ev) => {
      ev.stopPropagation();
      quickDelete(b.dataset.del);
    }));
  main.querySelectorAll('.entry-card').forEach(c =>
    c.addEventListener('click', () => openDetail(c.dataset.id)));
}

async function quickDelete(id) {
  if (!confirm('האם אתה בטוח?')) return;
  await deleteEntry(id);
  toast('התיעוד נמחק');
  renderList();
}

// re-render without losing search input focus: only rebuild the cards area
function renderListBodyOnly() {
  // Simplest robust approach: re-run renderList but restore focus & caret
  const si = $('#searchInput');
  const pos = si ? si.selectionStart : null;
  renderList();
  const ns = $('#searchInput');
  if (ns) { ns.focus(); if (pos != null) ns.setSelectionRange(pos, pos); }
}

/* ----- FORM ----- */
function blankDraft() {
  return { id: null, createdAt: Date.now(), text: '', predicted: null, actual: null };
}
let draft = null;

function renderForm() {
  const e = draft;

  main.innerHTML = `
  <div class="form">
    <div class="field">
      <label class="field-label">מה קרה? <span style="font-size:13px;color:var(--ink-soft);font-weight:600">ספרי במילים שלך</span></label>
      <textarea class="input big" id="fText" placeholder="לדוגמה: עניתי לטלפון למרות החשש, והשיחה עברה בסדר גמור…">${esc(e.text)}</textarea>
    </div>

    <div class="field">
      <label class="field-label">מתי?</label>
      <div class="field-hint">נלכד אוטומטית — אפשר לשנות אם צריך.</div>
      <input class="input" id="fDate" type="datetime-local" value="${tsToLocalInput(e.createdAt)}" />
    </div>

    <div class="field">
      <label class="field-label">דירוג חרדה <span class="opt">לא חובה</span></label>
      <div class="field-hint">סולם 0–100 (SUDS). אפשר לדלג — התיעוד יישמר גם בלי זה.</div>

      ${sudsBlock('pred', 'חרדה שחזיתי מראש', e.predicted)}
      ${sudsBlock('actual', 'חרדה שחשתי בפועל', e.actual)}
    </div>

    <div class="form-actions">
      <button class="btn btn-primary" id="saveBtn">${State.editingId ? 'שמירת שינויים' : 'שמירת ההצלחה ✨'}</button>
    </div>
  </div>`;

  // text
  $('#fText').addEventListener('input', ev => e.text = ev.target.value);
  $('#fDate').addEventListener('change', ev => { if (ev.target.value) e.createdAt = localInputToTs(ev.target.value); });

  wireSuds('pred', v => e.predicted = v);
  wireSuds('actual', v => e.actual = v);

  $('#saveBtn').addEventListener('click', onSave);
  setTimeout(() => $('#fText').focus(), 60);
}

function sudsBlock(kind, label, val) {
  const has = val != null;
  const v = has ? val : 50;
  return `
  <div class="suds-block" data-kind="${kind}">
    <div class="suds-head">
      <span class="lbl">${label}</span>
      <span class="suds-val ${has ? '' : 'empty-val'}" id="sv-${kind}">${has ? val : 'לא דורג'}</span>
    </div>
    <div class="suds-row">
      <input type="range" min="0" max="100" step="1" value="${v}" id="sr-${kind}" class="${has ? '' : 'inactive'}" />
    </div>
    <div class="suds-scale"><span>0 · רגוע</span><span>100 · עוצמתי</span></div>
    <div style="text-align:left;margin-top:6px">
      <button type="button" class="suds-clear" id="sc-${kind}">${has ? 'נקה דירוג' : 'הקש/החלק כדי לדרג'}</button>
    </div>
  </div>`;
}

function wireSuds(kind, setter) {
  const range = $('#sr-' + kind);
  const valEl = $('#sv-' + kind);
  const clear = $('#sc-' + kind);
  const activate = () => {
    range.classList.remove('inactive');
    valEl.classList.remove('empty-val');
    valEl.textContent = range.value;
    setter(parseInt(range.value, 10));
    clear.textContent = 'נקה דירוג';
  };
  range.addEventListener('input', activate);
  range.addEventListener('pointerdown', () => { if (range.classList.contains('inactive')) activate(); });
  clear.addEventListener('click', () => {
    if (range.classList.contains('inactive')) { activate(); }
    else {
      range.classList.add('inactive');
      valEl.classList.add('empty-val');
      valEl.textContent = 'לא דורג';
      range.value = 50;
      setter(null);
      clear.textContent = 'הקש/החלק כדי לדרג';
    }
  });
}

async function onSave() {
  const e = draft;
  e.text = (e.text || '').trim();
  if (!e.text && e.predicted == null && e.actual == null) {
    toast('כתבי משהו קצר או הוסיפי דירוג 🙂');
    return;
  }
  if (!e.id) e.id = uid();
  e.updatedAt = Date.now();
  await saveEntry({ ...e });
  toast(State.editingId ? 'השינויים נשמרו ✓' : 'כל הכבוד! ההצלחה נשמרה ✨');
  State.editingId = null;
  draft = null;
  State.view = 'list';
  render();
}

/* ----- DETAIL ----- */
function openDetail(id) {
  State.editingId = id;
  State.view = 'detail';
  render();
}

function renderDetail() {
  const e = State.entries.find(x => x.id === State.editingId);
  if (!e) { State.view = 'list'; return render(); }

  let sudsHtml = '';
  if (e.predicted != null || e.actual != null) {
    sudsHtml = `<div class="detail-section">
      <h4>דירוג חרדה (0–100)</h4>
      <div class="suds-pair">
        <div class="suds-card"><div class="num pred">${e.predicted != null ? e.predicted : '–'}</div><div class="cap">חזוי מראש</div></div>
        <div class="suds-card"><div class="num actual">${e.actual != null ? e.actual : '–'}</div><div class="cap">בפועל</div></div>
      </div>
      ${(e.predicted != null && e.actual != null && e.actual < e.predicted)
        ? `<div class="insight" style="margin-top:12px">החרדה בפועל הייתה נמוכה ב‑${e.predicted - e.actual} נק' ממה שחששת. הראש לרוב מגזים — ועכשיו יש לך הוכחה 💛</div>` : ''}
    </div>`;
  }

  main.innerHTML = `
  <div class="detail">
    <div class="detail-date">🕊️ ${fmtDate(e.createdAt)} · ${fmtTime(e.createdAt)}</div>
    <div class="detail-text">${esc(e.text) || '<i style="color:var(--ink-soft)">ללא תיאור</i>'}</div>
    ${sudsHtml}
    <div class="detail-actions">
      <button class="btn btn-primary" id="editBtn">עריכה</button>
      <button class="btn btn-danger" id="delBtn">מחיקה</button>
    </div>
  </div>`;

  $('#editBtn').addEventListener('click', () => {
    draft = { ...e };
    State.view = 'form';
    render();
  });
  $('#delBtn').addEventListener('click', async () => {
    if (!confirm('האם אתה בטוח?')) return;
    await deleteEntry(e.id);
    toast('התיעוד נמחק');
    State.editingId = null;
    State.view = 'list';
    render();
  });
}

/* ----- STATS ----- */
function renderStats() {
  const all = State.entries;
  const rated = all.filter(e => e.predicted != null || e.actual != null);
  const bothRated = all.filter(e => e.predicted != null && e.actual != null);

  if (!all.length) {
    main.innerHTML = `<div class="empty"><span class="emoji">📈</span><h3>עוד אין נתונים</h3><p>תיעדי כמה הצלחות וכאן תראי את ההתקדמות שלך לאורך זמן.</p></div>`;
    return;
  }

  const avg = (arr, key) => {
    const vals = arr.filter(e => e[key] != null).map(e => e[key]);
    return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
  };
  const avgPred = avg(rated, 'predicted');
  const avgActual = avg(rated, 'actual');
  const avgDrop = bothRated.length
    ? Math.round(bothRated.reduce((a, e) => a + (e.predicted - e.actual), 0) / bothRated.length) : null;

  // entries per week (last 8 weeks)
  const weeks = buildWeeks(all, 8);

  // comparison over time (per week, only rated)
  const weekRatings = buildWeekRatings(rated, 8);

  let insight = '';
  if (avgDrop != null && avgDrop > 0) {
    insight = `בממוצע, החרדה שחשת בפועל הייתה נמוכה ב‑<b>${avgDrop} נק'</b> ממה שחזית מראש. ההתמודדות שלך מלמדת את המוח שהפחד מוגזם — וזה בדיוק העניין 💛`;
  } else if (rated.length) {
    insight = `תיעדת ${rated.length} התמודדויות עם דירוג. כל אחת מהן היא צעד — המשיכי כך 🌿`;
  }

  let html = `
    <div class="stats-grid">
      <div class="stat-card"><div class="big neutral">${all.length}</div><div class="cap">סה"כ הצלחות</div></div>
      <div class="stat-card"><div class="big neutral">${entriesThisWeek(all)}</div><div class="cap">השבוע</div></div>
      ${avgPred != null ? `<div class="stat-card"><div class="big pred">${avgPred}</div><div class="cap">חרדה חזויה (ממוצע)</div></div>` : ''}
      ${avgActual != null ? `<div class="stat-card"><div class="big actual">${avgActual}</div><div class="cap">חרדה בפועל (ממוצע)</div></div>` : ''}
    </div>

    ${insight ? `<div class="insight">${insight}</div>` : ''}

    <div class="section-title">הצלחות בשבוע</div>
    <div class="chart">
      <div class="bars">
        ${weeks.map(w => {
          const max = Math.max(1, ...weeks.map(x => x.count));
          const h = Math.round((w.count / max) * 100);
          return `<div class="bar-col">
            <div class="bar-num">${w.count || ''}</div>
            <div class="bar" style="height:${w.count ? Math.max(h, 6) : 2}%"></div>
            <div class="bar-lbl">${w.label}</div>
          </div>`;
        }).join('')}
      </div>
    </div>`;

  if (weekRatings.some(w => w.pred != null || w.actual != null)) {
    const maxV = 100;
    html += `
    <div class="section-title">חרדה חזויה מול בפועל (לפי שבוע)</div>
    <div class="chart">
      <div class="bars">
        ${weekRatings.map(w => `
          <div class="bar-col" style="flex-direction:row;align-items:flex-end;gap:3px">
            <div style="display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:100%;flex:1">
              <div class="bar-num" style="color:var(--sky)">${w.pred != null ? w.pred : ''}</div>
              <div class="bar" style="height:${w.pred != null ? Math.max((w.pred / maxV) * 100, 4) : 0}%;max-width:14px;background:linear-gradient(180deg,#a9cde6,var(--sky))"></div>
            </div>
            <div style="display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:100%;flex:1">
              <div class="bar-num" style="color:var(--sage-deep)">${w.actual != null ? w.actual : ''}</div>
              <div class="bar" style="height:${w.actual != null ? Math.max((w.actual / maxV) * 100, 4) : 0}%;max-width:14px;background:linear-gradient(180deg,var(--sage),var(--sage-deep))"></div>
            </div>
          </div>`).join('')}
      </div>
      <div style="display:flex;gap:8px;margin-top:6px">
        ${weekRatings.map(w => `<div class="bar-lbl" style="flex:1">${w.label}</div>`).join('')}
      </div>
      <div class="compare-legend">
        <span><span class="legend-dot pred"></span>חזוי</span>
        <span><span class="legend-dot actual"></span>בפועל</span>
      </div>
    </div>
    <p style="font-size:12px;color:var(--ink-soft);text-align:center;margin-top:10px">* מוצגות רק הצלחות שיש בהן דירוג חרדה (${rated.length} מתוך ${all.length}).</p>`;
  }

  main.innerHTML = html;
}

function startOfWeek(d) {
  const x = new Date(d); x.setHours(0,0,0,0);
  x.setDate(x.getDate() - x.getDay()); // Sunday start (Israel)
  return x;
}
function entriesThisWeek(all) {
  const s = startOfWeek(new Date()).getTime();
  return all.filter(e => e.createdAt >= s).length;
}
function buildWeeks(all, n) {
  const out = [];
  const thisStart = startOfWeek(new Date());
  for (let i = n - 1; i >= 0; i--) {
    const ws = new Date(thisStart); ws.setDate(ws.getDate() - i * 7);
    const we = new Date(ws); we.setDate(we.getDate() + 7);
    const count = all.filter(e => e.createdAt >= ws.getTime() && e.createdAt < we.getTime()).length;
    out.push({ label: `${ws.getDate()}/${ws.getMonth() + 1}`, count });
  }
  return out;
}
function buildWeekRatings(rated, n) {
  const out = [];
  const thisStart = startOfWeek(new Date());
  for (let i = n - 1; i >= 0; i--) {
    const ws = new Date(thisStart); ws.setDate(ws.getDate() - i * 7);
    const we = new Date(ws); we.setDate(we.getDate() + 7);
    const inWeek = rated.filter(e => e.createdAt >= ws.getTime() && e.createdAt < we.getTime());
    const pv = inWeek.filter(e => e.predicted != null).map(e => e.predicted);
    const av = inWeek.filter(e => e.actual != null).map(e => e.actual);
    out.push({
      label: `${ws.getDate()}/${ws.getMonth() + 1}`,
      pred: pv.length ? Math.round(pv.reduce((a,b)=>a+b,0)/pv.length) : null,
      actual: av.length ? Math.round(av.reduce((a,b)=>a+b,0)/av.length) : null,
    });
  }
  return out;
}

/* ===========================================================
   EXPORT / IMPORT
   =========================================================== */
function download(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
}
function stamp() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function exportJSON() {
  const data = {
    app: 'success-log', version: 1, exportedAt: new Date().toISOString(),
    entries: State.entries,
  };
  download(`גיבוי-יומן-הצלחות-${stamp()}.json`, JSON.stringify(data, null, 2), 'application/json');
  toast('הגיבוי הורד למכשיר 💾');
}

function csvCell(v) {
  const s = String(v == null ? '' : v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function exportCSV() {
  const head = ['תאריך','שעה','תיאור','חרדה חזויה','חרדה בפועל'];
  const rows = [...State.entries].sort((a,b)=>a.createdAt-b.createdAt).map(e => [
    fmtDate(e.createdAt), fmtTime(e.createdAt), e.text || '',
    e.predicted != null ? e.predicted : '', e.actual != null ? e.actual : ''
  ].map(csvCell).join(','));
  const csv = '\uFEFF' + [head.map(csvCell).join(','), ...rows].join('\r\n');
  download(`יומן-הצלחות-${stamp()}.csv`, csv, 'text/csv;charset=utf-8');
  toast('קובץ CSV הורד 📊');
}

function exportPDF() {
  const all = [...State.entries].sort((a,b)=>a.createdAt-b.createdAt);
  if (!all.length) { toast('אין תיעודים להדפסה'); return; }
  const rated = all.filter(e => e.predicted != null && e.actual != null);
  const avgP = rated.length ? Math.round(rated.reduce((a,e)=>a+e.predicted,0)/rated.length) : null;
  const avgA = rated.length ? Math.round(rated.reduce((a,e)=>a+e.actual,0)/rated.length) : null;

  let area = document.getElementById('print-area');
  if (!area) { area = document.createElement('div'); area.id = 'print-area'; document.body.appendChild(area); }

  area.innerHTML = `
    <div class="print-header">
      <h1>יומן הצלחות — סיכום</h1>
      <div class="sub">הופק ב‑${fmtDate(Date.now())} · ${all.length} תיעודים</div>
    </div>
    <div class="print-summary">
      <div class="print-stat"><div class="pn">${all.length}</div><div class="pc">סה"כ הצלחות</div></div>
      ${avgP != null ? `<div class="print-stat"><div class="pn">${avgP}</div><div class="pc">חרדה חזויה (ממוצע)</div></div>` : ''}
      ${avgA != null ? `<div class="print-stat"><div class="pn">${avgA}</div><div class="pc">חרדה בפועל (ממוצע)</div></div>` : ''}
    </div>
    ${all.map(e => `
      <div class="print-entry">
        <div class="pd">${fmtDate(e.createdAt)} · ${fmtTime(e.createdAt)}</div>
        <div class="pt">${esc(e.text) || '—'}</div>
        <div class="pm">
          ${e.predicted != null ? `<b>חרדה חזויה:</b> ${e.predicted} ` : ''}
          ${e.actual != null ? `&nbsp; <b>בפועל:</b> ${e.actual}` : ''}
        </div>
      </div>`).join('')}`;
  closeMenu();
  setTimeout(() => window.print(), 150);
}

function importJSON(file) {
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const data = JSON.parse(reader.result);
      const incoming = Array.isArray(data) ? data : data.entries;
      if (!Array.isArray(incoming)) throw new Error('bad');
      const choice = State.entries.length
        ? confirm(`הקובץ מכיל ${incoming.length} תיעודים.\n\nאישור = מיזוג עם הקיים.\nביטול = החלפת כל הנתונים הקיימים.`)
        : true;
      if (!choice) { await DB.clear(); State.entries = []; }
      const existing = new Set(State.entries.map(e => e.id));
      let added = 0;
      for (const raw of incoming) {
        const e = normalizeEntry(raw);
        if (!e.id || existing.has(e.id)) e.id = e.id && !existing.has(e.id) ? e.id : uid();
        existing.add(e.id);
        await DB.put(e);
        added++;
      }
      await loadAll();
      State.view = 'list';
      render();
      toast(`יובאו ${added} תיעודים ✓`);
    } catch (err) {
      toast('הקובץ אינו תקין');
    }
  };
  reader.readAsText(file);
}
function normalizeEntry(raw) {
  return {
    id: raw.id || uid(),
    createdAt: raw.createdAt || (raw.date ? Date.parse(raw.date) : Date.now()),
    updatedAt: raw.updatedAt || Date.now(),
    text: raw.text || '',
    predicted: raw.predicted != null ? Number(raw.predicted) : null,
    actual: raw.actual != null ? Number(raw.actual) : null,
  };
}

/* ===========================================================
   MENU / EVENTS
   =========================================================== */
function openMenu() { $('#menuBackdrop').hidden = false; }
function closeMenu() { $('#menuBackdrop').hidden = true; }

function wireGlobal() {
  $('#fab').addEventListener('click', () => {
    State.editingId = null;
    draft = blankDraft();
    State.view = 'form';
    render();
  });

  $('#navBack').addEventListener('click', () => {
    if (State.view === 'form' && State.editingId) { State.view = 'detail'; }
    else { State.view = 'list'; State.editingId = null; draft = null; }
    render();
  });

  document.querySelectorAll('.navtab').forEach(t =>
    t.addEventListener('click', () => {
      State.view = t.dataset.view;
      State.editingId = null; draft = null;
      render();
    }));

  $('#menuBtn').addEventListener('click', openMenu);
  $('#menuBackdrop').addEventListener('click', (e) => {
    if (e.target.id === 'menuBackdrop') closeMenu();
  });
  $('#menuSheet').querySelectorAll('.sheet-item').forEach(b =>
    b.addEventListener('click', () => {
      const a = b.dataset.action;
      if (a === 'close') return closeMenu();
      if (a === 'export-json') { exportJSON(); closeMenu(); }
      if (a === 'export-csv') { exportCSV(); closeMenu(); }
      if (a === 'export-pdf') { exportPDF(); }
      if (a === 'import-json') { closeMenu(); $('#importFile').click(); }
    }));
  $('#importFile').addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (f) importJSON(f);
    e.target.value = '';
  });
}

/* ===========================================================
   INIT
   =========================================================== */
async function init() {
  wireGlobal();
  await loadAll();
  render();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}
init();
