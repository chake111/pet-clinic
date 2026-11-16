async (page) => {
  const base = 'http://127.0.0.1:5174';
  const sid = 12;
  const results = [];
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const adminToken = await page.evaluate(() => localStorage.getItem('qa_admin_token'));
  const api = async (method, path) => {
    const response = await page.request.fetch(base + '/api' + path, {
      method, headers: { Authorization: 'Bearer ' + adminToken }
    });
    const body = await response.json();
    assert(body.code === 200, `${method} ${path}: ${body.code} ${body.msg || ''}`);
    return body.data;
  };
  const monitor = () => {
    window.__qaFrames = [];
    const Native = window.WebSocket;
    window.WebSocket = class extends Native {
      constructor(...args) {
        super(...args);
        this.addEventListener('message', (e) => { try { window.__qaFrames.push(JSON.parse(e.data)); } catch {} });
      }
    };
  };
  const ready = (p) => p.waitForFunction(() => window.__qaFrames.some((f) => f.type === 'HISTORY'));
  // 查看器状态走 DOM 断言：动态 import 会拿到新模块实例，读不到应用内真实状态。
  // .cap 的进度文案 "1 / 2" 由真实 urls 渲染，等价证明图片列表已载入查看器。
  const assertViewerOpen = async (p, side) => {
    await p.locator('.el-image-viewer__wrapper').waitFor();
    await p.locator('.el-image-viewer__img').first().waitFor();
    const hint = await p.locator('.el-image-viewer__wrapper .cap').innerText();
    assert(hint.includes('1 / 2'), `${side} viewer did not load 2 symptom photos: ${hint}`);
  };
  const assertViewerClosed = async (p, side) => {
    await p.waitForFunction(() => !document.querySelector('.el-image-viewer__wrapper'));
    await p.waitForTimeout(500);
    assert(!(await p.locator('.el-image-viewer__wrapper').count()), `${side} viewer reopened after governance`);
  };
  const errors = [];
  page.on('pageerror', (error) => errors.push('client: ' + error.message));
  await page.addInitScript(monitor);
  const browser = page.context().browser();
  const doctorContext = await browser.newContext({ storageState: await page.context().storageState() });
  await doctorContext.addInitScript(monitor);
  const doctor = await doctorContext.newPage();
  doctor.on('pageerror', (error) => errors.push('doctor: ' + error.message));
  try {
    // 用户端：会话页抬头症状照片 -> 打开大图（等 HISTORY 就绪，避开 connect 清理预览的窗口）
    await page.goto(base + `/consult/${sid}`);
    await ready(page);
    const clientThumb = page.locator('.shots .th').first();
    await clientThumb.waitFor();
    await clientThumb.click();
    await assertViewerOpen(page, 'client');
    await page.screenshot({ path: 'output/playwright/symptom-preview-client-open.png' });
    results.push('PASS client opens symptom photo viewer from session header, viewer holds 2 photos');
    // 医生端：详情侧栏症状照片 -> 打开大图
    await doctor.goto(base + `/admin/consult/${sid}`);
    await ready(doctor);
    const doctorThumb = doctor.locator('.details .gal .th').first();
    await doctorThumb.waitFor();
    await doctorThumb.click();
    await assertViewerOpen(doctor, 'doctor');
    await doctor.screenshot({ path: 'output/playwright/symptom-preview-doctor-open.png' });
    results.push('PASS doctor opens symptom photo viewer from session details, viewer holds 2 photos');
    // 管理员处置会话：两端大图关闭、图片列表清空
    await api('PUT', `/admin/consult/${sid}/moderate?moderateStatus=2&reason=symptom-photo-check`);
    await assertViewerClosed(page, 'client');
    await assertViewerClosed(doctor, 'doctor');
    await page.screenshot({ path: 'output/playwright/symptom-preview-client-cleared.png' });
    await doctor.screenshot({ path: 'output/playwright/symptom-preview-doctor-cleared.png' });
    results.push('PASS session governance closes and clears symptom photo previews on both live pages');
    assert(errors.length === 0, 'browser page errors: ' + errors.join('; '));
    results.push('PASS no uncaught browser errors');
    return { results, browserErrors: errors };
  } finally {
    try { await api('PUT', `/admin/consult/${sid}/moderate?moderateStatus=0&reason=restore-after-check`); } catch {}
    await doctorContext.close();
  }
}
