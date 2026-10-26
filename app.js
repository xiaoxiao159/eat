/* ============================================================
   吃饭记 · 主逻辑
   数据全部存在浏览器 IndexedDB（entries / recipes / photos）
   ============================================================ */
(() => {
'use strict';

/* ---------------- 工具 ---------------- */
const $  = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const esc = (s) => String(s).replace(/[&<>"']/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad2 = (n) => String(n).padStart(2, '0');
const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

const MEALS = {
  breakfast: { label: '早餐', emoji: '🍳', cls: 'breakfast' },
  lunch:     { label: '午餐', emoji: '🍚', cls: 'lunch' },
  dinner:    { label: '晚餐', emoji: '🍜', cls: 'dinner' },
  snack:     { label: '加餐', emoji: '🍎', cls: 'snack' },
};
const CATS = { breakfast: '🍳 早餐', meal: '🍛 午餐/晚餐' };

const dayKey = (d) => d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate();
const fmtTime = (iso) => { const d = new Date(iso); return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); };

function dayLabel(d) {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const that = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((start - that) / 86400000);
  const base = `${d.getMonth() + 1}月${d.getDate()}日 ${WEEK[d.getDay()]}`;
  if (diff === 0) return `今天 · ${base}`;
  if (diff === 1) return `昨天 · ${base}`;
  return (d.getFullYear() === now.getFullYear() ? '' : `${d.getFullYear()}年`) + base;
}

/* 餐次自动预选：05:00–10:29 早 / 10:30–13:59 午 / 17:00–21:59 晚 / 其余 加餐 */
function defaultMeal(now = new Date()) {
  const m = now.getHours() * 60 + now.getMinutes();
  if (m >= 300 && m < 630) return 'breakfast';
  if (m >= 630 && m < 840) return 'lunch';
  if (m >= 1020 && m < 1320) return 'dinner';
  return 'snack';
}

/* ---------------- IndexedDB ---------------- */
const DB_NAME = 'eatlog';
const DB_VERSION = 1;
let db = null;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('entries')) d.createObjectStore('entries', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('recipes')) d.createObjectStore('recipes', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('photos'))  d.createObjectStore('photos',  { keyPath: 'id' });
    };
    req.onsuccess = () => { db = req.result; resolve(db); };
    req.onerror = () => reject(req.error);
  });
}
const dbReq = (store, mode, fn) => new Promise((resolve, reject) => {
  const r = fn(db.transaction(store, mode).objectStore(store));
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});
const dbPut    = (store, val) => dbReq(store, 'readwrite', s => s.put(val));
const dbGetAll = (store)       => dbReq(store, 'readonly',  s => s.getAll());
const dbGet    = (store, id)   => dbReq(store, 'readonly',  s => s.get(id));
const dbDelete = (store, id)   => dbReq(store, 'readwrite', s => s.delete(id));

/* ---------------- 状态 ---------------- */
let entries = [];   // {id, time, meal, text, photoId?}
let recipes = [];   // {id, name, category, ingredients[], detail, photoId?, createdAt}
let curTab = 'log';
let curFilter = 'all';
let range = 7;

let composeMeal = null;          // 输入区当前餐次
let composePhoto = null;         // {blob, url} 待保存
let composeBusy = false;

let editingId = null;            // 正在编辑的菜谱
let formCat = 'breakfast';
let lastCat = 'breakfast';
let formNewPhoto = null;         // {blob, url} 新选配图
let formPhotoId = null;          // 已有配图 id
let formPhotoRemoved = false;
let formPhotoToken = 0;
let formBusy = false;

let wheelCat = 'breakfast';
let wheelItems = [];
let wheelRot = 0;
let wheelSpinning = false;

let toastTimer = null;

/* ---------------- 照片 ---------------- */
const photoURLCache = new Map(); // photoId -> objectURL

async function getPhotoURL(id) {
  if (!id) return null;
  if (photoURLCache.has(id)) return photoURLCache.get(id);
  let url = null;
  try {
    const rec = await dbGet('photos', id);
    if (rec && rec.blob) url = URL.createObjectURL(rec.blob);
  } catch { /* 数据缺失时返回 null */ }
  photoURLCache.set(id, url);
  return url;
}

function hydratePhotos(root = document) {
  $$('img[data-photo]', root).forEach(async (img) => {
    const url = await getPhotoURL(img.dataset.photo);
    if (url && img.isConnected) img.src = url;
  });
}

function dropPhotoURL(id) {
  const u = photoURLCache.get(id);
  if (u) URL.revokeObjectURL(u);
  photoURLCache.delete(id);
}

function loadImageFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ img, url });
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('图片读取失败')); };
    img.src = url;
  });
}

/* 压缩：最长边 1280px、JPEG 80% */
async function compressImage(file, maxSide = 1280, quality = 0.8) {
  const { img, url } = await loadImageFile(file);
  try {
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    canvas.getContext('2d').drawImage(img, 0, 0, w, h);
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', quality));
    return blob || file;
  } finally { URL.revokeObjectURL(url); }
}

async function storePhotoBlob(blob) {
  const id = 'ph_' + uid();
  await dbPut('photos', { id, blob, createdAt: new Date().toISOString() });
  return id;
}

/* ---------------- Toast ---------------- */
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 1800);
}

/* ---------------- 弹层 ---------------- */
function openOverlay(sel) {
  $(sel).classList.add('open');
  document.body.classList.add('modal-open');
}
function closeOverlay(sel) {
  $(sel).classList.remove('open');
  if (!$$('.overlay.open').length) document.body.classList.remove('modal-open');
}

/* ============================================================
   记录页
   ============================================================ */

function setComposeMeal(meal) {
  composeMeal = meal;
  $$('#meal-chips .meal-chip').forEach(b => b.classList.toggle('active', b.dataset.meal === meal));
}

function renderComposePhoto() {
  const box = $('#compose-photo');
  if (composePhoto) { box.hidden = false; $('#compose-photo-img').src = composePhoto.url; }
  else { box.hidden = true; $('#compose-photo-img').removeAttribute('src'); }
}

async function addEntry({ text = '', meal, photoId = null }) {
  const entry = { id: uid(), time: new Date().toISOString(), meal: meal || defaultMeal(), text, photoId };
  entries.push(entry);
  await dbPut('entries', entry);
  return entry;
}

function renderLog() {
  const list = $('#log-list');
  const sorted = [...entries].sort((a, b) => new Date(b.time) - new Date(a.time));

  if (!sorted.length) {
    list.innerHTML = `<div class="empty"><span class="emoji">🍚</span><p>还没有记录</p><p>在上面写下这顿吃了什么，或点 📷 拍张照</p></div>`;
  } else {
    const groups = [];
    let cur = null;
    for (const e of sorted) {
      const d = new Date(e.time);
      const key = dayKey(d);
      if (!cur || cur.key !== key) { cur = { key, d, items: [] }; groups.push(cur); }
      cur.items.push({ ...e, d });
    }
    list.innerHTML = groups.map(g => `
      <div class="card day-card">
        <div class="day-head"><span>${dayLabel(g.d)}</span><span class="day-count">${g.items.length} 顿</span></div>
        ${g.items.map(e => `
          <div class="entry">
            <span class="entry-time">${fmtTime(e.time)}</span>
            <div class="entry-main">
              <div class="entry-line">
                ${MEALS[e.meal] ? `<span class="meal-tag ${MEALS[e.meal].cls}">${MEALS[e.meal].label}</span>` : ''}
                ${e.text ? `<span class="entry-text">${esc(e.text)}</span>` : '<span class="entry-text" style="color:var(--muted)">（只拍了照）</span>'}
              </div>
              ${e.photoId ? `
                <button type="button" class="entry-photo" data-action="view-photo" data-photo="${e.photoId}" aria-label="查看照片大图">
                  <img data-photo="${e.photoId}" alt="">
                </button>` : ''}
            </div>
            <button type="button" class="del-btn step-del" data-action="del-entry" data-id="${e.id}">
              <span class="normal">删除</span><span class="confirm">确认删除？</span>
            </button>
          </div>`).join('')}
      </div>`).join('');
  }
  hydratePhotos(list);
  renderRecent();
}

function renderRecent() {
  const recent = [];
  const seen = new Set();
  for (const e of [...entries].sort((a, b) => new Date(b.time) - new Date(a.time))) {
    if (e.text && !seen.has(e.text)) { seen.add(e.text); recent.push(e.text); }
    if (recent.length >= 8) break;
  }
  $('#recent').hidden = recent.length === 0;
  $('#recent-chips').innerHTML = recent.map(t =>
    `<button type="button" class="chip" data-action="quick-add" data-text="${esc(t)}">${esc(t)}</button>`).join('');
}

$('#compose').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (composeBusy) return;
  const input = $('#food-input');
  const text = input.value.trim();
  if (!text && !composePhoto) { toast('写点什么，或拍张照吧'); return; }
  composeBusy = true;
  try {
    let photoId = null;
    if (composePhoto) {
      photoId = await storePhotoBlob(composePhoto.blob);
      URL.revokeObjectURL(composePhoto.url);
      composePhoto = null;
      renderComposePhoto();
    }
    await addEntry({ text, meal: composeMeal || defaultMeal(), photoId });
    input.value = '';
    renderLog();
    setComposeMeal(defaultMeal());
    toast('记下这一顿 ✓');
    input.focus();
  } finally { composeBusy = false; }
});

$('#compose-file').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const blob = await compressImage(file);
    if (composePhoto) URL.revokeObjectURL(composePhoto.url);
    composePhoto = { blob, url: URL.createObjectURL(blob) };
    renderComposePhoto();
  } catch { toast('这张图片读取失败'); }
});

/* ============================================================
   菜谱页
   ============================================================ */

function ingRowHTML(name = '', amount = '') {
  return `<div class="ing-row">
    <input type="text" class="ing-name" placeholder="食材" maxlength="30" value="${esc(name)}">
    <input type="text" class="ing-amount" placeholder="用量（可选）" maxlength="20" value="${esc(amount)}">
    <button type="button" class="ing-x" data-action="del-ing" aria-label="删除这行">✕</button>
  </div>`;
}

function recipeCardHTML(r) {
  const ings = (r.ingredients || []).filter(i => i && i.name);
  return `
  <div class="card recipe-card" data-id="${r.id}">
    ${r.photoId
      ? `<button type="button" class="recipe-photo" data-action="view-photo" data-photo="${r.photoId}" aria-label="查看配图大图"><img data-photo="${r.photoId}" alt=""></button>`
      : `<div class="recipe-photo ph ${r.category === 'breakfast' ? 'breakfast' : 'meal'}"><span>${r.category === 'breakfast' ? '🍳' : '🍛'}</span></div>`}
    <div class="recipe-body">
      <span class="badge ${r.category === 'breakfast' ? 'breakfast' : 'meal'}">${CATS[r.category] || CATS.meal}</span>
      <h3 class="recipe-name">${esc(r.name)}</h3>
      ${ings.length ? `<ul class="ings">${ings.map(i =>
        `<li>${esc(i.name)}${i.amount ? `<i>${esc(i.amount)}</i>` : ''}</li>`).join('')}</ul>` : ''}
      ${r.detail ? `
        <p class="recipe-detail">${esc(r.detail)}</p>
        <button type="button" class="expand-btn" data-action="toggle-expand"><span class="more">展开 ▾</span><span class="less">收起 ▴</span></button>` : ''}
      <div class="recipe-foot">
        <button type="button" class="btn-eat" data-action="eat-recipe">🍽️ 记一笔</button>
        <span class="grow"></span>
        <button type="button" class="link-btn" data-action="edit-recipe">编辑</button>
        <button type="button" class="link-btn danger step-del" data-action="del-recipe"><span class="normal">删除</span><span class="confirm">确认？</span></button>
      </div>
    </div>
  </div>`;
}

function renderRecipes() {
  const list = $('#recipe-list');
  const shown = curFilter === 'all' ? recipes : recipes.filter(r => r.category === curFilter);
  if (!shown.length) {
    list.className = 'recipe-grid empty-grid';
    list.innerHTML = `<div class="empty"><span class="emoji">📖</span>
      <p>${recipes.length ? '这个分类下还没有菜谱' : '还没有菜谱'}</p>
      <p>点右上角「＋ 新增」添加第一道菜</p></div>`;
    return;
  }
  list.className = 'recipe-grid';
  list.innerHTML = shown.map(recipeCardHTML).join('');
  hydratePhotos(list);
  $$('.recipe-detail', list).forEach(el => {
    if (el.scrollHeight > el.clientHeight + 2) el.closest('.recipe-card').classList.add('has-more');
  });
}

/* ---- 菜谱表单 ---- */
function syncSegment() {
  $$('#f-category button').forEach(b => b.classList.toggle('active', b.dataset.cat === formCat));
}

function openRecipeModal(recipe) {
  editingId = recipe ? recipe.id : null;
  $('#modal-title').textContent = recipe ? '编辑菜谱' : '新增菜谱';
  $('#f-name').value = recipe ? recipe.name : '';
  $('#f-detail').value = recipe ? (recipe.detail || '') : '';
  formCat = recipe ? recipe.category : lastCat;
  syncSegment();
  const rows = recipe && recipe.ingredients && recipe.ingredients.length
    ? recipe.ingredients : [{ name: '', amount: '' }];
  $('#ing-rows').innerHTML = rows.map(i => ingRowHTML(i.name || '', i.amount || '')).join('');
  formNewPhoto = null;
  formPhotoRemoved = false;
  formPhotoId = recipe ? (recipe.photoId || null) : null;
  formPhotoToken++;
  renderFormPhoto();
  openOverlay('#recipe-modal');
  setTimeout(() => $('#f-name').focus(), 60);
}

async function renderFormPhoto() {
  const token = ++formPhotoToken;
  const box = $('#recipe-photo-preview');
  const img = $('#recipe-photo-img');
  if (formNewPhoto) { box.hidden = false; img.src = formNewPhoto.url; return; }
  if (formPhotoId && !formPhotoRemoved) {
    const url = await getPhotoURL(formPhotoId);
    if (token !== formPhotoToken) return;   // 状态已变，丢弃
    if (url) { box.hidden = false; img.src = url; return; }
  }
  box.hidden = true;
  img.removeAttribute('src');
}

$('#recipe-file').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const blob = await compressImage(file);
    if (formNewPhoto) URL.revokeObjectURL(formNewPhoto.url);
    formNewPhoto = { blob, url: URL.createObjectURL(blob) };
    renderFormPhoto();
  } catch { toast('这张图片读取失败'); }
});

$('#recipe-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (formBusy) return;
  const name = $('#f-name').value.trim();
  if (!name) { toast('菜名还没写哦'); $('#f-name').focus(); return; }
  formBusy = true;
  try {
    const ingredients = $$('#ing-rows .ing-row').map(row => ({
      name: $('.ing-name', row).value.trim(),
      amount: $('.ing-amount', row).value.trim(),
    })).filter(i => i.name);
    const detail = $('#f-detail').value.trim();

    let photoId = formPhotoId;
    if (formNewPhoto) {
      const newId = await storePhotoBlob(formNewPhoto.blob);
      URL.revokeObjectURL(formNewPhoto.url);
      if (photoId) { await dbDelete('photos', photoId); dropPhotoURL(photoId); }
      photoId = newId;
    } else if (formPhotoRemoved && photoId) {
      await dbDelete('photos', photoId);
      dropPhotoURL(photoId);
      photoId = null;
    }

    if (editingId) {
      const r = recipes.find(x => x.id === editingId);
      if (r) {
        Object.assign(r, { name, category: formCat, ingredients, detail, photoId });
        await dbPut('recipes', r);
      }
      toast('已保存修改');
    } else {
      const r = { id: uid(), name, category: formCat, ingredients, detail, photoId, createdAt: new Date().toISOString() };
      recipes.push(r);
      await dbPut('recipes', r);
      toast('已添加到菜谱');
    }
    lastCat = formCat;
    formNewPhoto = null;
    closeOverlay('#recipe-modal');
    if (curFilter !== 'all' && formCat !== curFilter) setFilter('all');
    else renderRecipes();
  } finally { formBusy = false; }
});

/* ============================================================
   转盘
   ============================================================ */
const WHEEL_TINTS = ['#e9efdf', '#f6ecd4', '#e3e9f0'];

function openWheel(cat) {
  wheelCat = cat;
  $('#wheel-title').textContent = cat === 'breakfast' ? '转早餐 🎡' : '转午/晚餐 🎡';
  openOverlay('#wheel-overlay');
  if (!spinNewBoard()) closeOverlay('#wheel-overlay');
}

function spinNewBoard() {
  const pool = recipes.filter(r => r.category === wheelCat);
  if (!pool.length) {
    toast(wheelCat === 'breakfast' ? '还没有早餐菜谱，先去添加几道' : '还没有午/晚餐菜谱，先去添加几道');
    return false;
  }
  wheelItems = pool.length > 8
    ? pool.map(r => ({ r, k: Math.random() })).sort((a, b) => a.k - b.k).slice(0, 8).map(x => x.r)
    : [...pool];
  const spin = $('#wheel-spin');
  spin.style.transition = 'none';
  spin.style.transform = 'rotate(0deg)';
  void spin.offsetWidth;            // 强制回流，确保下次动画生效
  wheelRot = 0;
  drawWheel();
  $('#wheel-result').hidden = true;
  $('#wheel-result').innerHTML = '';
  $('#wheel-go').textContent = '开始转 🎡';
  return true;
}

function drawWheel() {
  const canvas = $('#wheel-canvas');
  const stage = canvas.parentElement;
  const size = stage.clientWidth || 290;
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  canvas.width = Math.round(size * dpr);
  canvas.height = Math.round(size * dpr);
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, size, size);

  const cx = size / 2, cy = size / 2, R = size / 2 - 3;
  const n = wheelItems.length;
  const seg = (Math.PI * 2) / n;

  for (let i = 0; i < n; i++) {
    const a0 = -Math.PI / 2 + i * seg;
    g.beginPath();
    g.moveTo(cx, cy);
    g.arc(cx, cy, R, a0, a0 + seg);
    g.closePath();
    g.fillStyle = WHEEL_TINTS[i % WHEEL_TINTS.length];
    g.fill();

    g.save();
    g.translate(cx, cy);
    g.rotate(a0 + seg / 2);
    g.textAlign = 'right';
    g.textBaseline = 'middle';
    g.fillStyle = '#3a4038';
    g.font = `600 ${Math.max(11, Math.round(size / 22))}px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif`;
    const label = wheelItems[i].name.length > 6 ? wheelItems[i].name.slice(0, 6) + '…' : wheelItems[i].name;
    g.fillText(label, R - 10, 0);
    g.restore();
  }
  /* 外圈用面板色描边，分隔扇区 */
  g.beginPath();
  g.arc(cx, cy, R, 0, Math.PI * 2);
  g.lineWidth = 3;
  g.strokeStyle = '#fbf9f3';
  g.stroke();
}

function spinWheel() {
  if (wheelSpinning || !wheelItems.length) return;
  wheelSpinning = true;
  const el = $('#wheel-spin');
  const n = wheelItems.length;
  const targetIdx = Math.floor(Math.random() * n);
  const seg = 360 / n;
  /* 指针固定在正上方(-90°)：让第 targetIdx 扇区中心转到指针处 */
  const targetMod = ((-(targetIdx + 0.5) * seg) % 360 + 360) % 360;
  const curMod = ((wheelRot % 360) + 360) % 360;
  let delta = targetMod - curMod;
  if (delta <= 0) delta += 360;
  const jitter = (Math.random() - 0.5) * seg * 0.5;   // 不总落在正中
  const final = wheelRot + 4 * 360 + delta + jitter;

  el.style.transition = 'transform 3.4s cubic-bezier(.12,.72,.18,1)';
  requestAnimationFrame(() => { el.style.transform = `rotate(${final}deg)`; });

  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    clearTimeout(backup);
    el.removeEventListener('transitionend', finish);
    wheelRot = final;
    wheelSpinning = false;
    showWheelResult(wheelItems[targetIdx]);
  };
  el.addEventListener('transitionend', finish);
  const backup = setTimeout(finish, 3900);   // 兜底：动画事件丢失也能出结果
}

function showWheelResult(r) {
  const box = $('#wheel-result');
  const ings = (r.ingredients || []).filter(i => i && i.name);
  box.innerHTML = `
    <div class="card wr-card">
      ${r.photoId ? `<img class="wr-photo" data-photo="${r.photoId}" alt="">` : ''}
      <div class="wr-name">今天吃：${esc(r.name)} 🎉</div>
      ${ings.length ? `<ul class="ings">${ings.map(i =>
        `<li>${esc(i.name)}${i.amount ? `<i>${esc(i.amount)}</i>` : ''}</li>`).join('')}</ul>` : ''}
      ${r.detail ? `<p class="recipe-detail">${esc(r.detail)}</p>` : ''}
      <div class="wr-actions">
        <button type="button" class="btn-eat" data-action="wheel-eat" data-id="${r.id}">就吃这个 · 记一笔</button>
        <button type="button" class="btn-ghost" data-action="wheel-again">再转一次</button>
      </div>
    </div>`;
  box.hidden = false;
  hydratePhotos(box);
  $('#wheel-go').textContent = '再转一次 🎡';
}

/* ============================================================
   统计页
   ============================================================ */

function statsData(days) {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1));
  const perDay = [];
  for (let i = 0; i < days; i++) {
    perDay.push({ d: new Date(start.getFullYear(), start.getMonth(), start.getDate() + i), count: 0 });
  }
  const map = new Map(perDay.map(p => [dayKey(p.d), p]));
  const mealCounts = { breakfast: 0, lunch: 0, dinner: 0, snack: 0 };
  let total = 0;
  for (const e of entries) {
    const d = new Date(e.time);
    if (d < start) continue;
    const p = map.get(dayKey(d));
    if (p) p.count++;
    if (mealCounts[e.meal] !== undefined) mealCounts[e.meal]++;
    total++;
  }
  const freq = new Map();
  for (const e of entries) {
    const d = new Date(e.time);
    if (d < start || !e.text) continue;
    freq.set(e.text, (freq.get(e.text) || 0) + 1);
  }
  const top = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  return { perDay, mealCounts, top, total, daysCovered: perDay.filter(p => p.count > 0).length };
}

function dataCardHTML() {
  return `<div class="card data-card">
    <div class="chart-title" style="margin:0">数据</div>
    <div class="data-line" id="storage-line">数据都保存在这台手机的浏览器里</div>
    <button type="button" class="export-btn" data-action="export">⬇️ 导出备份（含照片）</button>
    <div class="data-hint">备份为 JSON 文件，可存到「文件」App 或转发收藏。<br>清除 Safari 网站数据、删除主屏幕图标都会丢数据，删除前请先备份。</div>
  </div>`;
}

async function fillStorageLine() {
  try {
    const est = await navigator.storage.estimate();
    const line = $('#storage-line');
    if (est && est.usage != null && line) {
      const mb = est.usage / 1048576;
      line.textContent = `本机已存约 ${mb >= 100 ? Math.round(mb) : mb.toFixed(1)} MB`;
    }
  } catch { /* 忽略 */ }
}

function renderStats() {
  const body = $('#stats-body');
  const days = range;

  if (!entries.length) {
    body.innerHTML = `
      <div class="empty"><span class="emoji">📊</span><p>还没有数据</p><p>先去「记录」记几顿，这里就能看到统计啦</p></div>
      ${dataCardHTML()}`;
    fillStorageLine();
    return;
  }

  const { perDay, mealCounts, top, total, daysCovered } = statsData(days);
  const maxCount = Math.max(1, ...perDay.map(p => p.count));
  const showVals = days <= 8;

  const barsHTML = perDay.map((p, i) => {
    const h = p.count === 0 ? 0 : Math.max(9, Math.round(p.count / maxCount * 100));
    const isToday = i === perDay.length - 1;
    const dateStr = `${p.d.getMonth() + 1}月${p.d.getDate()}日`;
    const week = WEEK[p.d.getDay()];
    const lab = days <= 8
      ? week.slice(1)
      : ((p.d.getDate() % 5 === 0 || isToday) ? `${p.d.getMonth() + 1}/${p.d.getDate()}` : '');
    return `<button type="button" class="bar-slot${isToday ? ' today' : ''}"
        data-tip="${dateStr} ${week} · ${p.count} 顿" aria-label="${dateStr} ${week}，${p.count} 顿">
      <span class="bar-stack">${showVals ? `<span class="bar-val">${p.count}</span>` : ''}<span class="bar-col" style="--h:${h}%"></span></span>
      <span class="bar-lab">${lab}</span>
    </button>`;
  }).join('');

  const distHTML = Object.keys(MEALS).map(k => {
    const c = mealCounts[k];
    const pct = total ? Math.round(c / total * 100) : 0;
    return `<div class="dist-row">
      <span class="dist-label">${MEALS[k].emoji} ${MEALS[k].label}</span>
      <div class="dist-track"><div class="dist-fill" style="width:${pct}%"></div></div>
      <span class="dist-val">${c} · ${pct}%</span>
    </div>`;
  }).join('');

  const topHTML = top.length
    ? `<ol class="top-list">${top.map(([name, cnt], i) =>
        `<li><span class="top-rank">${i + 1}</span><span class="top-name">${esc(name)}</span><span class="top-count">×${cnt}</span></li>`).join('')}</ol>`
    : `<div class="empty" style="padding:18px"><p>暂无文字记录</p></div>`;

  body.innerHTML = `
    <div class="stat-row">
      <div class="card stat-tile"><div class="stat-label">记录</div><div class="stat-value">${total}</div><div class="stat-sub">近 ${days} 天</div></div>
      <div class="card stat-tile"><div class="stat-label">有记录天数</div><div class="stat-value">${daysCovered}</div><div class="stat-sub">共 ${days} 天</div></div>
      <div class="card stat-tile"><div class="stat-label">日均</div><div class="stat-value">${(total / days).toFixed(1)}</div><div class="stat-sub">顿 / 天</div></div>
    </div>
    <div class="card chart-card">
      <div class="chart-title">每日顿数</div>
      <div class="chart-bars${days > 8 ? ' dense' : ''}">${barsHTML}</div>
      <div class="chart-tip"></div>
    </div>
    <div class="card chart-card">
      <div class="chart-title">餐次分布</div>
      <div class="dist-rows">${distHTML}</div>
    </div>
    <div class="card chart-card">
      <div class="chart-title">常吃 TOP 5</div>
      ${topHTML}
    </div>
    ${dataCardHTML()}`;
  fillStorageLine();
  /* 近 30 天条形较宽，默认滚到最右端（今天） */
  const bars = $('.chart-bars', body);
  if (bars) bars.scrollLeft = bars.scrollWidth;
}

/* 柱形图 tooltip：增强不设门槛（数值有直接标注 / aria-label） */
function showBarTip(slot) {
  const card = slot.closest('.chart-card');
  const tip = $('.chart-tip', card);
  if (!tip) return;
  tip.textContent = slot.dataset.tip || '';
  const center = slot.offsetLeft + slot.offsetWidth / 2;
  const x = Math.max(52, Math.min(card.clientWidth - 52, center));
  tip.style.left = x + 'px';
  tip.style.top = (slot.offsetTop - 2) + 'px';
  tip.classList.add('show');
}
function hideBarTip() { $$('.chart-tip.show').forEach(t => t.classList.remove('show')); }

$('#stats-body').addEventListener('pointerover', (e) => {
  const slot = e.target.closest('.bar-slot');
  if (slot) showBarTip(slot);
});
$('#stats-body').addEventListener('pointerout', (e) => {
  if (e.target.closest('.bar-slot')) hideBarTip();
});
$('#stats-body').addEventListener('pointerdown', (e) => {
  const slot = e.target.closest('.bar-slot');
  if (slot) { showBarTip(slot); setTimeout(hideBarTip, 1800); }
});

/* ---------------- 导出备份 ---------------- */
const blobToDataURL = (blob) => new Promise((resolve, reject) => {
  const fr = new FileReader();
  fr.onload = () => resolve(fr.result);
  fr.onerror = () => reject(fr.error);
  fr.readAsDataURL(blob);
});

let exporting = false;
async function exportBackup() {
  if (exporting) return;
  exporting = true;
  try {
    const photos = await dbGetAll('photos');
    const photoData = [];
    for (const p of photos) photoData.push({ id: p.id, data: await blobToDataURL(p.blob) });
    const payload = { app: 'eatlog', version: 1, exportedAt: new Date().toISOString(), entries, recipes, photos: photoData };
    const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
    const d = new Date();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `吃饭记备份-${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast('备份已生成 ✓');
  } catch (err) {
    toast('导出失败' + (err && err.message ? '：' + err.message : ''));
  } finally { exporting = false; }
}

/* ---------------- 大图查看 ---------------- */
async function openLightbox(photoId) {
  const url = await getPhotoURL(photoId);
  if (!url) { toast('照片不见了'); return; }
  $('#lightbox-img').src = url;
  openOverlay('#lightbox');
}

/* ============================================================
   导航 / 通用
   ============================================================ */

function switchTab(tab) {
  curTab = tab;
  $('#page-log').hidden = tab !== 'log';
  $('#page-recipes').hidden = tab !== 'recipes';
  $('#page-stats').hidden = tab !== 'stats';
  $$('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  if (tab === 'stats') renderStats();
  window.scrollTo({ top: 0 });
}

function setFilter(f) {
  curFilter = f;
  $$('.filter-chip').forEach(c => c.classList.toggle('active', c.dataset.filter === f));
  renderRecipes();
}

function setRange(r) {
  range = r;
  $$('#range-seg button').forEach(b => b.classList.toggle('active', +b.dataset.range === r));
  renderStats();
}

/* 两步删除：第一次点变"确认"，2.6 秒内再点才删 */
function armDelete(btn) {
  if (btn.classList.contains('armed')) {
    clearTimeout(btn._t);
    return true;
  }
  $$('.armed').forEach(b => { b.classList.remove('armed'); clearTimeout(b._t); });
  btn.classList.add('armed');
  btn._t = setTimeout(() => btn.classList.remove('armed'), 2600);
  return false;
}

/* ---------------- 事件分发 ---------------- */
document.addEventListener('click', async (e) => {
  const t = e.target;
  const btn = t.closest ? t.closest('[data-action],[data-tab],[data-meal],[data-filter],[data-range],[data-cat]') : null;

  if (!btn) {
    if (t.closest && t.closest('#lightbox')) { closeOverlay('#lightbox'); return; }
    if (t.classList && t.classList.contains('overlay')) closeOverlay('#' + t.id);
    return;
  }

  const action = btn.dataset.action;
  if (action) {
    switch (action) {
      case 'quick-add':
        await addEntry({ text: btn.dataset.text, meal: composeMeal || defaultMeal() });
        renderLog();
        toast('记下这一顿 ✓');
        break;
      case 'pick-compose-photo': $('#compose-file').click(); break;
      case 'remove-compose-photo':
        if (composePhoto) { URL.revokeObjectURL(composePhoto.url); composePhoto = null; renderComposePhoto(); }
        break;
      case 'pick-recipe-photo': $('#recipe-file').click(); break;
      case 'remove-recipe-photo':
        if (formNewPhoto) { URL.revokeObjectURL(formNewPhoto.url); formNewPhoto = null; }
        else formPhotoRemoved = true;
        renderFormPhoto();
        break;
      case 'del-entry':
        if (armDelete(btn)) {
          const id = btn.dataset.id;
          const en = entries.find(x => x.id === id);
          entries = entries.filter(x => x.id !== id);
          await dbDelete('entries', id);
          if (en && en.photoId) { await dbDelete('photos', en.photoId); dropPhotoURL(en.photoId); }
          renderLog();
          toast('已删除');
        }
        break;
      case 'new-recipe': openRecipeModal(null); break;
      case 'edit-recipe': {
        const card = btn.closest('.recipe-card');
        const r = recipes.find(x => x.id === card.dataset.id);
        if (r) openRecipeModal(r);
        break;
      }
      case 'del-recipe':
        if (armDelete(btn)) {
          const card = btn.closest('.recipe-card');
          const id = card.dataset.id;
          const r = recipes.find(x => x.id === id);
          recipes = recipes.filter(x => x.id !== id);
          await dbDelete('recipes', id);
          if (r && r.photoId) { await dbDelete('photos', r.photoId); dropPhotoURL(r.photoId); }
          renderRecipes();
          toast('已删除');
        }
        break;
      case 'eat-recipe': {
        const card = btn.closest('.recipe-card');
        const r = recipes.find(x => x.id === card.dataset.id);
        if (r) {
          await addEntry({ text: r.name, meal: defaultMeal() });
          renderLog();
          toast(`已记录「${r.name}」`);
        }
        break;
      }
      case 'toggle-expand':
        btn.closest('.recipe-card').classList.toggle('expanded');
        break;
      case 'open-wheel':
        openWheel(btn.dataset.cat);
        break;
      case 'wheel-go':
      case 'wheel-again': {
        if (wheelSpinning) break;
        const needNew = action === 'wheel-again' || !$('#wheel-result').hidden;
        if (needNew || !wheelItems.length) { if (!spinNewBoard()) break; }
        spinWheel();
        break;
      }
      case 'wheel-eat': {
        const r = recipes.find(x => x.id === btn.dataset.id);
        if (r) {
          await addEntry({ text: r.name, meal: defaultMeal() });
          closeOverlay('#wheel-overlay');
          renderLog();
          switchTab('log');
          toast(`已记录「${r.name}」`);
        }
        break;
      }
      case 'close-recipe-modal': closeOverlay('#recipe-modal'); break;
      case 'close-wheel': closeOverlay('#wheel-overlay'); break;
      case 'view-photo': openLightbox(btn.dataset.photo); break;
      case 'add-ing':
        $('#ing-rows').insertAdjacentHTML('beforeend', ingRowHTML());
        break;
      case 'del-ing': {
        const rows = $$('#ing-rows .ing-row');
        const row = btn.closest('.ing-row');
        if (rows.length > 1) row.remove();
        else { $('.ing-name', row).value = ''; $('.ing-amount', row).value = ''; }
        break;
      }
      case 'export': exportBackup(); break;
    }
    return;
  }

  if (btn.dataset.tab) { switchTab(btn.dataset.tab); return; }
  if (btn.dataset.meal) { setComposeMeal(btn.dataset.meal); return; }
  if (btn.dataset.filter) { setFilter(btn.dataset.filter); return; }
  if (btn.dataset.range) { setRange(+btn.dataset.range); return; }
  if (btn.dataset.cat) { formCat = btn.dataset.cat; syncSegment(); }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    $$('.overlay.open').forEach(o => o.classList.remove('open'));
    document.body.classList.remove('modal-open');
  }
});

window.addEventListener('resize', () => {
  if ($('#wheel-overlay').classList.contains('open') && !wheelSpinning && wheelItems.length) drawWheel();
});

/* ---------------- 启动 ---------------- */
async function init() {
  try {
    await openDB();
  } catch {
    $('.app').innerHTML = `<div class="empty" style="padding-top:90px"><span class="emoji">😔</span>
      <p>本地存储不可用</p><p>请关闭无痕/隐私模式后重新打开</p></div>`;
    return;
  }
  entries = (await dbGetAll('entries')).filter(e =>
    e && typeof e.id === 'string' && e.time && !Number.isNaN(new Date(e.time).getTime()) &&
    (typeof e.text === 'string' || typeof e.photoId === 'string'));
  recipes = (await dbGetAll('recipes')).filter(r =>
    r && typeof r.id === 'string' && typeof r.name === 'string' && r.name);

  setComposeMeal(defaultMeal());
  renderLog();
  renderRecipes();

  /* Service Worker：仅 http/https 下注册（离线缓存） */
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

init();
})();
