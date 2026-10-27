/* 吃饭记 · 端到端冒烟测试（Playwright + 本地静态服务器）
   运行：NODE_PATH=<playwright所在node_modules> node test/smoke.cjs
   全部断言基于 DOM/文本，不使用截图。 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

/* 1x1 红色 PNG，用于模拟拍照/选图 */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');

function startServer() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (p === '/' || p === '') p = '/index.html';
      const file = path.join(ROOT, p);
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        res.writeHead(404); res.end('not found'); return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

/* ---------------- 断言收集 ---------------- */
let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; failures.push(name + (extra ? `（${extra}）` : '')); console.log('  ✗ ' + name + (extra ? ` — ${extra}` : '')); }
}
function section(name) { console.log('\n== ' + name + ' =='); }

/* 复刻 app.js 的餐次自动预选逻辑，用于对照 */
function defaultMeal(d) {
  const m = d.getHours() * 60 + d.getMinutes();
  if (m >= 300 && m < 630) return 'breakfast';
  if (m >= 630 && m < 840) return 'lunch';
  if (m >= 1020 && m < 1320) return 'dinner';
  return 'snack';
}

(async () => {
  /* 可传入线上地址运行：node test/smoke.cjs https://xxx.github.io/eat/ */
  const LIVE = process.argv[2] || null;
  let srv = null;
  let base = LIVE;
  if (!LIVE) { const s = await startServer(); srv = s.srv; base = `http://127.0.0.1:${s.port}/`; }
  const PROXY = process.env.PROXY || null;
  const browser = await chromium.launch({ headless: true, ...(PROXY ? { proxy: { server: PROXY } } : {}) });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true });
  const page = await ctx.newPage();

  const consoleErrors = [];
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

  const entryCount = () => page.locator('#log-list .entry').count();
  const toastText = () => page.textContent('#toast');

  async function addText(text) {
    await page.fill('#food-input', text);
    await page.click('#compose button[type=submit]');
  }

  /* ============ 1. 加载与空状态 ============ */
  section('加载与空状态');
  await page.goto(base, { waitUntil: 'load' });
  await page.waitForSelector('#compose', { state: 'visible' });
  ok(true, '页面正常打开');
  ok((await page.textContent('#log-list')).includes('还没有记录'), '记录页空状态文案');
  ok((await page.textContent('#recipe-list')).includes('还没有菜谱'), '菜谱页空状态文案');

  /* Service Worker 注册成功并接管页面 */
  const swOk = await page.waitForFunction(
    () => navigator.serviceWorker.controller !== null, null, { timeout: 15000 })
    .then(() => true).catch(() => false);
  ok(swOk, 'Service Worker 已注册并接管页面');

  /* 餐次按当前时间自动预选 */
  const activeMeal = await page.getAttribute('#meal-chips .meal-chip.active', 'data-meal');
  ok(activeMeal === defaultMeal(new Date()), `餐次自动预选正确（当前=${activeMeal}，预期=${defaultMeal(new Date())}）`);

  /* ============ 2. 记录：增删、校验、照片 ============ */
  section('吃饭记录');
  await addText('牛肉面');
  await page.waitForFunction(() => document.querySelector('#toast').classList.contains('show'));
  ok((await toastText()).includes('记下这一顿'), '记一笔有轻提示');
  await page.waitForSelector('#log-list .entry');
  ok((await entryCount()) === 1, '文字记录已入列表');
  ok((await page.inputValue('#food-input')) === '', '记下后输入框清空');
  const dayCount = await page.textContent('.day-card .day-count');
  ok(dayCount.trim() === '1 顿', '当天分组计数 1 顿');

  /* 两者都空：拒绝 */
  await page.click('#compose button[type=submit]');
  await page.waitForFunction(() => document.querySelector('#toast').classList.contains('show'));
  ok((await toastText()).includes('写点什么') || (await toastText()).includes('拍张照'), '空内容被拒绝');
  ok((await entryCount()) === 1, '空内容不产生记录');

  /* 手动改餐次后记录 */
  await page.click('#meal-chips .meal-chip[data-meal=dinner]');
  await addText('测试晚餐');
  await page.waitForFunction(() => document.querySelectorAll('#log-list .entry').length === 2);
  const tagCls = await page.locator('#log-list .entry').first().locator('.meal-tag').getAttribute('class');
  ok(/dinner/.test(tagCls), '手动改餐次生效（晚餐标签）');
  await page.click('#meal-chips .meal-chip[data-meal=' + defaultMeal(new Date()) + ']');

  /* 只拍照不写字 */
  await page.setInputFiles('#compose-file', { name: 'cam.png', mimeType: 'image/png', buffer: TINY_PNG });
  await page.waitForSelector('#compose-photo:not([hidden])');
  ok(true, '选图后输入区出现缩略图');
  await page.click('#compose button[type=submit]');
  await page.waitForFunction(() => document.querySelectorAll('#log-list .entry').length === 3);
  const firstText = await page.locator('#log-list .entry').first().locator('.entry-text').textContent();
  ok(firstText.includes('只拍了照'), '只拍照可保存，显示（只拍了照）');
  await page.waitForSelector('#log-list .entry img[data-photo][src^="blob:"]', { timeout: 5000 });
  ok(true, '记录缩略图已从 IndexedDB 加载');

  /* 常吃快捷标签 */
  await page.waitForSelector('#recent-chips .chip');
  const chipText = await page.textContent('#recent-chips .chip');
  await page.click('#recent-chips .chip');
  await page.waitForFunction(() => document.querySelectorAll('#log-list .entry').length === 4);
  ok(true, `常吃标签点击即记（${chipText}）`);

  /* 大图查看 */
  await page.click('#log-list .entry .entry-photo');
  await page.waitForSelector('#lightbox.open');
  ok((await page.getAttribute('#lightbox-img', 'src') || '').startsWith('blob:'), '点缩略图可全屏看大图');
  await page.click('#lightbox');
  await page.waitForFunction(() => !document.querySelector('#lightbox').classList.contains('open'));
  ok(true, '点任意处关闭大图');

  /* 两步删除：先测 2.6 秒超时失效果 */
  const cntBefore = await entryCount();
  await page.click('#log-list .entry .del-btn');
  await page.waitForSelector('#log-list .del-btn.armed');
  ok((await page.textContent('#log-list .del-btn.armed .confirm')).includes('确认删除'), '第一步点变"确认删除？"');
  await page.waitForTimeout(2900);   // 超过 2.6s，应失效
  await page.click('#log-list .entry .del-btn');   // 这次应该是重新布防而非删除
  await page.waitForSelector('#log-list .del-btn.armed');
  await page.click('#log-list .del-btn.armed .confirm');
  await page.waitForFunction((n) => document.querySelectorAll('#log-list .entry').length === n - 1, cntBefore);
  ok(true, '两步删除生效（超时后需重新两步）');

  /* 刷新后数据仍在 */
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction((n) => document.querySelectorAll('#log-list .entry').length === n, cntBefore - 1);
  ok(true, '刷新后记录完好');
  await page.waitForSelector('#log-list .entry img[data-photo][src^="blob:"]', { timeout: 5000 });
  ok(true, '刷新后照片完好');

  /* ============ 3. 菜谱 ============ */
  section('菜谱');
  await page.click('.nav-btn[data-tab=recipes]');
  await page.click('[data-action="new-recipe"]');
  await page.waitForSelector('#recipe-modal.open');
  ok((await page.textContent('#modal-title')).includes('新增菜谱'), '新增菜谱弹层打开');

  await page.fill('#f-name', '鸡蛋灌饼');
  /* 第一行食材（默认已有一行） */
  await page.fill('#ing-rows .ing-row:first-child .ing-name', '面粉');
  await page.fill('#ing-rows .ing-row:first-child .ing-amount', '250g');
  await page.click('[data-action="add-ing"]');
  await page.fill('#ing-rows .ing-row:nth-child(2) .ing-name', '鸡蛋');
  await page.fill('#ing-rows .ing-row:nth-child(2) .ing-amount', '2个');
  /* 长做法，用于测折叠 */
  await page.fill('#f-detail', '这是很长很长的做法。'.repeat(30));
  await page.setInputFiles('#recipe-file', { name: 'dish.png', mimeType: 'image/png', buffer: TINY_PNG });
  await page.waitForSelector('#recipe-photo-preview:not([hidden])');
  ok(true, '菜谱配图预览正常');
  await page.click('#recipe-form button[type=submit]');
  await page.waitForSelector('#recipe-list .recipe-card');
  await page.waitForFunction(() => !document.querySelector('#recipe-modal').classList.contains('open'));
  ok(true, '菜谱保存成功');
  ok((await page.textContent('.recipe-card .recipe-name')) === '鸡蛋灌饼', '菜名显示正确');
  ok((await page.textContent('.recipe-card')).includes('面粉') && (await page.textContent('.recipe-card')).includes('250g'), '食材及用量显示');
  await page.waitForSelector('.recipe-card img[data-photo][src^="blob:"]', { timeout: 5000 });
  ok(true, '菜谱配图已持久化');
  ok(await page.locator('.recipe-card.has-more .expand-btn').count() === 1, '超长做法出现"展开"按钮');
  await page.click('.recipe-card .expand-btn');
  ok(await page.locator('.recipe-card.expanded').count() === 1, '做法可展开');
  await page.click('.recipe-card .expand-btn');
  ok(await page.locator('.recipe-card.expanded').count() === 0, '做法可收起');

  /* 第二道：午/晚餐分类 + 无配图 */
  await page.click('[data-action="new-recipe"]');
  await page.waitForSelector('#recipe-modal.open');
  await page.fill('#f-name', '番茄牛腩');
  await page.click('#f-category button[data-cat=meal]');
  await page.fill('#ing-rows .ing-row:first-child .ing-name', '牛腩');
  await page.fill('#ing-rows .ing-row:first-child .ing-amount', '500g');
  await page.click('#recipe-form button[type=submit]');
  await page.waitForFunction(() => document.querySelectorAll('#recipe-list .recipe-card').length === 2);

  /* 再加两道早餐，凑转盘（注意：表单会记住上次分类，须显式选早餐） */
  for (const nm of ['燕麦粥', '煎饺']) {
    await page.click('[data-action="new-recipe"]');
    await page.waitForSelector('#recipe-modal.open');
    await page.fill('#f-name', nm);
    await page.click('#f-category button[data-cat=breakfast]');
    await page.click('#recipe-form button[type=submit]');
    await page.waitForFunction(() => !document.querySelector('#recipe-modal').classList.contains('open'));
  }
  await page.waitForFunction(() => document.querySelectorAll('#recipe-list .recipe-card').length === 4);
  ok(true, '共 4 道菜谱入列表');

  /* 分类筛选 */
  await page.click('.filter-chip[data-filter=breakfast]');
  await page.waitForFunction(() => document.querySelectorAll('#recipe-list .recipe-card').length === 3);
  ok(true, '早餐筛选 3 道');
  await page.click('.filter-chip[data-filter=meal]');
  await page.waitForFunction(() => document.querySelectorAll('#recipe-list .recipe-card').length === 1);
  ok((await page.textContent('#recipe-list .recipe-name')) === '番茄牛腩', '午/晚餐筛选正确');
  await page.click('.filter-chip[data-filter=all]');

  /* 编辑 */
  await page.locator('.recipe-card', { hasText: '鸡蛋灌饼' }).locator('[data-action="edit-recipe"]').click();
  await page.waitForSelector('#recipe-modal.open');
  ok((await page.textContent('#modal-title')).includes('编辑菜谱'), '编辑弹层标题正确');
  ok((await page.inputValue('#f-name')) === '鸡蛋灌饼' && (await page.inputValue('#ing-rows .ing-row:first-child .ing-name')) === '面粉', '编辑回填正确');
  await page.fill('#f-name', '鸡蛋灌饼·改良版');
  await page.click('#recipe-form button[type=submit]');
  await page.waitForFunction(() => document.querySelector('#recipe-list').textContent.includes('鸡蛋灌饼·改良版'));
  ok(true, '编辑保存生效');

  /* 记一笔 */
  const entriesBeforeEat = await entryCount();
  await page.locator('.recipe-card', { hasText: '番茄牛腩' }).locator('[data-action="eat-recipe"]').click();
  await page.waitForFunction((n) => document.querySelectorAll('#log-list .entry').length === n + 1, entriesBeforeEat);
  ok(true, '菜谱"记一笔"入当天记录');

  /* 删除菜谱（两步） */
  await page.locator('.recipe-card', { hasText: '煎饺' }).locator('[data-action="del-recipe"]').click();
  await page.waitForSelector('.recipe-card .del-btn.armed, .recipe-card [data-action="del-recipe"].armed');
  await page.locator('.recipe-card', { hasText: '煎饺' }).locator('[data-action="del-recipe"]').click();
  await page.waitForFunction(() => !document.querySelector('#recipe-list').textContent.includes('煎饺'));
  ok(true, '菜谱两步删除生效');

  /* ============ 4. 转盘 ============ */
  section('转盘');
  await page.click('[data-action="open-wheel"][data-cat=breakfast]');
  await page.waitForSelector('#wheel-overlay.open');
  await page.waitForSelector('#wheel-canvas');
  ok(true, '转盘弹层打开');
  await page.click('#wheel-go');
  await page.waitForSelector('#wheel-result:not([hidden])', { timeout: 9000 });
  const wr = await page.textContent('#wheel-result');
  ok(wr.includes('今天吃：'), `转盘落定出结果（${wr.match(/今天吃：\S{0,12}/)?.[0] || ''}）`);
  ok(wr.includes('再转一次'), '结果含"再转一次"');
  await page.click('[data-action="wheel-again"]');
  await page.waitForFunction(() => !document.querySelector('#wheel-result').hidden);
  await page.waitForFunction(() => document.querySelector('#wheel-result').hidden, null, { timeout: 2000 }).catch(() => {});
  await page.waitForSelector('#wheel-result:not([hidden])', { timeout: 9000 });
  ok(true, '再转一次可重新抽样');

  /* 就吃这个 · 记一笔 */
  const beforeWheelEat = await entryCount();
  await page.click('[data-action="wheel-eat"]');
  await page.waitForFunction((n) => document.querySelectorAll('#log-list .entry').length === n + 1, beforeWheelEat);
  ok(await page.locator('.nav-btn[data-tab=log].active').count() === 1, '记一笔后跳回记录页');

  /* 空分类提示：删光早餐菜谱（记一笔后当前在记录页，先切回菜谱页） */
  await page.click('.nav-btn[data-tab=recipes]');
  await page.waitForSelector('#page-recipes:not([hidden]) .recipe-card');
  for (const nm of ['鸡蛋灌饼·改良版', '燕麦粥']) {
    const card = page.locator('.recipe-card', { hasText: nm }).locator('[data-action="del-recipe"]');
    await card.click();
    await card.click();
    await page.waitForFunction((name) => !document.querySelector('#recipe-list').textContent.includes(name), nm);
  }
  await page.click('[data-action="open-wheel"][data-cat=breakfast]');
  await page.waitForFunction(() => document.querySelector('#toast').classList.contains('show'));
  ok((await toastText()).includes('还没有早餐菜谱'), '空分类转盘有引导提示');
  ok(await page.locator('#wheel-overlay.open').count() === 0, '空分类时转盘自动关闭');

  /* ============ 5. 统计 ============ */
  section('统计');
  /* 先补一条重复文字（牛肉面再记一次），让常吃榜 TOP1 唯一 */
  await page.click('.nav-btn[data-tab=log]');
  const cntPre = await entryCount();
  await addText('牛肉面');
  await page.waitForFunction((n) => document.querySelectorAll('#log-list .entry').length === n + 1, cntPre);
  /* 从 DOM 推导当前应有数字 */
  const domStats = await page.evaluate(() => {
    const tags = [...document.querySelectorAll('#log-list .meal-tag')];
    const texts = [...document.querySelectorAll('#log-list .entry-text')]
      .map((e) => e.textContent).filter((t) => t !== '（只拍了照）');
    const freq = {};
    texts.forEach((t) => { freq[t] = (freq[t] || 0) + 1; });
    return {
      total: document.querySelectorAll('#log-list .entry').length,
      meals: {
        breakfast: tags.filter((t) => t.className.includes('breakfast')).length,
        lunch: tags.filter((t) => t.className.includes('lunch')).length,
        dinner: tags.filter((t) => t.className.includes('dinner')).length,
        snack: tags.filter((t) => t.className.includes('snack')).length,
      },
      freq,
    };
  });
  await page.click('.nav-btn[data-tab=stats]');
  await page.waitForSelector('.stat-tile');
  const tiles = await page.$$eval('.stat-tile .stat-value', (els) => els.map((e) => e.textContent.trim()));
  ok(+tiles[0] === domStats.total, `总览记录数一致（页=${tiles[0]}，实际=${domStats.total}）`);
  ok(+tiles[1] === 1, '有记录天数 = 1（今天）');
  ok(tiles[2] === (domStats.total / 7).toFixed(1), `日均计算正确（${tiles[2]}）`);
  const todayBar = await page.textContent('.bar-slot.today .bar-val');
  ok(+todayBar === domStats.total, `今天柱形 = ${todayBar}`);
  const distVals = await page.$$eval('.dist-row', (rows) => rows.map((r) => r.querySelector('.dist-val').textContent.trim()));
  const meals = ['breakfast', 'lunch', 'dinner', 'snack'];
  let distOk = true;
  meals.forEach((k, i) => {
    const expect = `${domStats.meals[k]} · ${Math.round(domStats.meals[k] / domStats.total * 100)}%`;
    if (distVals[i] !== expect) distOk = false;
  });
  ok(distOk, `餐次分布一致（${distVals.join(' / ')}）`);
  const topName = Object.entries(domStats.freq).sort((a, b) => b[1] - a[1])[0];
  const top1 = await page.textContent('.top-list li:first-child .top-name');
  const topCnt = await page.textContent('.top-list li:first-child .top-count');
  ok(top1 === topName[0] && topCnt === `×${topName[1]}`, `常吃 TOP1 = ${top1} ${topCnt}`);

  /* 近 30 天切换 */
  await page.click('#range-seg button[data-range="30"]');
  await page.waitForFunction(() => document.querySelector('.stat-tile .stat-sub').textContent.includes('30'));
  const tiles30 = await page.$$eval('.stat-tile .stat-value', (els) => els.map((e) => e.textContent.trim()));
  ok(+tiles30[0] === domStats.total && tiles30[2] === (domStats.total / 30).toFixed(1), '近 30 天切换后数字一致');

  /* ============ 6. 导出备份 ============ */
  section('导出备份');
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 15000 }),
    page.click('[data-action="export"]'),
  ]);
  const fname = download.suggestedFilename();
  ok(/\.json$/.test(fname), `备份文件名正确（${fname}）`);
  const buf = fs.readFileSync(await download.path());
  const payload = JSON.parse(buf.toString('utf8'));
  ok(payload.app === 'eatlog' && payload.version === 1, '备份 JSON 结构标识正确');
  ok(Array.isArray(payload.entries) && payload.entries.length === domStats.total, `备份含全部记录（${payload.entries.length}）`);
  ok(Array.isArray(payload.recipes) && payload.recipes.length === 1, `备份含全部菜谱（${payload.recipes.length}）`);
  ok(Array.isArray(payload.photos) && payload.photos.length === 1 &&
    payload.photos.every((p) => p.data && p.data.startsWith('data:image/jpeg')), `备份含照片 JPEG×${payload.photos?.length}（预期 1：带配图菜谱已在转盘测试中删除，其照片同删）`);

  /* ============ 7. 布局与报错 ============ */
  section('布局与控制台');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok(overflow <= 0, `375–430px 宽度无横向溢出（差 ${overflow}px）`);
  await page.click('.nav-btn[data-tab=log]');
  const overflow2 = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok(overflow2 <= 0, '记录页同样无横向溢出');
  ok(consoleErrors.length === 0, `无控制台报错${consoleErrors.length ? '：' + consoleErrors.join(' | ') : ''}`);

  /* ============ 汇总 ============ */
  await browser.close();
  if (srv) srv.close();
  console.log(`\n======== 结果：${pass} 通过 / ${fail} 失败 ========`);
  if (fail) { failures.forEach((f) => console.log('  ✗ ' + f)); process.exit(1); }
})().catch((e) => { console.error('测试脚本异常：', e); process.exit(2); });
