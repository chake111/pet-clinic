async (page) => {
  const base = 'http://127.0.0.1:5174';
  const sid = 15;
  const results = [];
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const adminToken = await page.evaluate(() => localStorage.getItem('qa_admin_token'));
  const clientToken = await page.evaluate(() => localStorage.getItem('pet_clinic_client_token'));
  
  const api = async (token, method, path, data) => {
    const response = await page.request.fetch(base + '/api' + path, {
      method, headers: { Authorization: 'Bearer ' + token }, data
    });
    const body = await response.json();
    assert(body.code === 200, `${method} ${path}: ${body.code} ${body.msg || ''}`);
    return body.data;
  };
  const monitor = () => {
    window.__qaFrames = []; window.__qaSent = []; window.__qaSockets = [];
    const Native = window.WebSocket;
    window.WebSocket = class extends Native {
      constructor(...args) {
        super(...args); window.__qaSockets.push(this);
        this.addEventListener('message', e => { try { window.__qaFrames.push(JSON.parse(e.data)); } catch {} });
      }
      send(data) { try { window.__qaSent.push(JSON.parse(data)); } catch {} return super.send(data); }
    };
  };
  await page.addInitScript(monitor);
  const browser = page.context().browser();
  const doctorContext = await browser.newContext({ storageState: await page.context().storageState() });
  await doctorContext.addInitScript(monitor);
  const doctor = await doctorContext.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  doctor.on('pageerror', error => errors.push(error.message));
  const ready = p => p.waitForFunction(() => window.__qaFrames.some(f => f.type === 'HISTORY'));
  const details = () => api(clientToken, 'GET', `/client/consult/sessions/${sid}`);
  const hide = (id, hidden) => api(adminToken, 'PUT', `/admin/consult/message/${id}/hidden?hidden=${hidden}&reason=browser-check`);
  const send = async (p, content, type = 'TEXT') => {
    const requestId = 'browser-' + Date.now();
    await p.evaluate(({ sid, content, type, requestId }) => {
      const ws = window.__qaSockets.findLast(s => s.readyState === WebSocket.OPEN);
      ws.send(JSON.stringify({ type: 'CHAT', sessionId: sid, content, msgType: type, requestId }));
    }, { sid, content, type, requestId });
    await p.waitForFunction(id => window.__qaFrames.some(f => f.type === 'ACK' && f.requestId === id), requestId);
    return await p.evaluate(id => window.__qaFrames.find(f => f.type === 'ACK' && f.requestId === id).message, requestId);
  };
  const waitHidden = (p, id, hidden) => p.waitForFunction(({id,hidden}) =>
    window.__qaFrames.some(f => f.type === 'MESSAGE_VISIBILITY' && f.messageId === id && f.hidden === hidden), {id, hidden});
  const checkViewerCleared = async () => {
    await page.waitForFunction(() => !document.querySelector('.el-image-viewer__wrapper'));
    assert(await page.evaluate(async () => {
      const { imageViewer } = await import('/src/utils/imageViewer.js');
      return !imageViewer.open && imageViewer.urls.length === 0 && imageViewer.captions.length === 0;
    }), 'global preview retained governed content');
  };
  try {
    await page.reload(); await ready(page);
    await doctor.goto(base + `/admin/consult/${sid}`); await ready(doctor);
    // Native WebSocket delivers actual IMAGE messages to the unmodified chat UI.
    const one = await send(doctor, '/api/uploads/seed/sym-1.jpg', 'IMAGE');
    const two = await send(doctor, '/api/uploads/seed/sym-2.jpg', 'IMAGE');
    await page.getByRole('button', { name: '放大查看这张患部照片' }).first().click();
    await page.locator('.el-image-viewer__wrapper').waitFor();
    await page.screenshot({ path: 'output/playwright/governance-preview-before.png' });
    await hide(one.id, 1); await waitHidden(page, one.id, 1); await checkViewerCleared();
    await page.screenshot({ path: 'output/playwright/governance-preview-cleared.png' });
    assert(await page.getByRole('button', { name: '放大查看这张患部照片' }).count() === 1, 'hidden image still in chat');
    results.push('PASS opened image disappears and global preview is cleared after message hiding');
    await hide(one.id, 0); await waitHidden(page, one.id, 0);
    await page.getByRole('button', { name: '放大查看这张患部照片' }).first().click();
    await hide(two.id, 1); await waitHidden(page, two.id, 1); await checkViewerCleared();
    results.push('PASS hiding another image clears its stale preview switching list');
    // Close the real socket and prevent reconnect while the administrator restores the message.
    const historiesBeforeDisconnect = await page.evaluate(() => window.__qaFrames.filter(f => f.type === 'HISTORY').length);
    await page.context().setOffline(true);
    await page.evaluate(() => new Promise(resolve => {
      const ws = window.__qaSockets.findLast(s => s.readyState === WebSocket.OPEN);
      ws.addEventListener('close', () => resolve(), { once: true });
      ws.close();
    }));
    await hide(two.id, 0);
    assert(await page.evaluate(id => window.__qaFrames.filter(f => f.type === 'MESSAGE_VISIBILITY' && f.messageId === id).at(-1).hidden === 1, two.id), 'restore was received before reconnection');
    await page.context().setOffline(false);
    await page.waitForFunction(count => window.__qaFrames.filter(f => f.type === 'HISTORY').length > count, historiesBeforeDisconnect);
    await page.waitForFunction(() => document.querySelectorAll('.shot').length === 2);
    assert(await page.evaluate(id => window.__qaFrames.filter(f => f.type === 'HISTORY').at(-1).messages.some(m => m.id === id), two.id), 'restored message missing from true reconnect history');
    results.push('PASS restore while disconnected becomes visible on automatic reconnect without reload');
    await page.screenshot({ path: 'output/playwright/governance-reconnected.png' });
    // Create an unread message while recipient has left; hide it before re-entering.
    await page.goto(base + '/');
    await doctor.getByRole('textbox', { name: '问诊回复' }).fill('在线恢复后确认已读');
    await doctor.getByRole('button', { name: '发送', exact: true }).click();
    await doctor.waitForFunction(() => window.__qaFrames.some(f => f.type === 'MSG' && f.message.content === '在线恢复后确认已读'));
    const unread = await doctor.evaluate(() => window.__qaFrames.findLast(f => f.type === 'MSG' && f.message.content === '在线恢复后确认已读').message);
    assert((await details()).userUnread === 1, 'setup expected one unread message');
    await hide(unread.id, 1);
    assert((await details()).userUnread === 0, 'hidden message still counts unread');
    await page.goto(base + `/consult/${sid}`); await ready(page);
    assert(await page.getByText('在线恢复后确认已读', { exact: true }).count() === 0, 'hidden message shown on entry');
    await hide(unread.id, 0); await waitHidden(page, unread.id, 0);
    await page.getByText('在线恢复后确认已读', { exact: true }).waitFor();
    await doctor.waitForFunction(id => window.__qaFrames.some(f => f.type === 'READ' && f.readMessageIds.includes(id)), unread.id);
    const delivered = doctor.locator('.msg.mine').filter({ hasText: '在线恢复后确认已读' });
    await delivered.getByText('已读', { exact: true }).waitFor();
    assert(await page.evaluate(() => window.__qaSent.some(f => f.type === 'READ')), 'recipient did not send READ');
    assert((await details()).userUnread === 0, 'restored read message retained unread count');
    const persisted = await api(adminToken, 'GET', `/admin/consult/${sid}/messages`);
    assert(persisted.records.find(m => m.id === unread.id).isRead === 1, 'database did not mark restored message read');
    results.push('PASS online restoration sends READ, persisted isRead=1, userUnread=0 and sender UI shows read');
    await doctor.screenshot({ path: 'output/playwright/governance-sender-read.png' });
    // Both participants must discard their open image preview on session governance.
    await page.getByRole('button', { name: '放大查看这张患部照片' }).first().click();
    await doctor.getByRole('button', { name: '放大查看这张患部照片' }).first().click();
    await api(adminToken, 'PUT', `/admin/consult/${sid}/moderate?moderateStatus=2&reason=browser-check`);
    await checkViewerCleared();
    await doctor.waitForFunction(() => !document.querySelector('.el-image-viewer__wrapper'));
    await page.getByText('会话不存在', { exact: false }).count();
    assert(await doctor.evaluate(async () => (await import('/src/utils/imageViewer.js')).imageViewer.urls.length === 0), 'doctor preview retained disposed session');
    results.push('PASS session governance closes and clears previews in both live browser pages');
    assert(errors.length === 0, 'browser page errors: ' + errors.join('; '));
    results.push('PASS no uncaught browser errors');
    return { results, browserErrors: errors };
  } finally {
    await page.context().setOffline(false);
    await doctorContext.close();
  }
}
