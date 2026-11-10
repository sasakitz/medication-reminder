/* Firefox loads core.js first; Chromium uses a classic service worker. */
if (typeof importScripts === 'function') importScripts('core.js');
const api = globalThis.browser ?? globalThis.chrome;
const core = globalThis.ReminderCore;
const ALARM = 'yururi-check';
let work = Promise.resolve();
function enqueue(task) {
  const next = work.then(task);
  work = next.catch(error => console.error('ゆるり:', error));
  return next;
}
async function snapshot() {
  const [synced, local] = await Promise.all([api.storage.sync.get(null), api.storage.local.get(null)]);
  const meds = Object.entries(synced).filter(([key]) => key.startsWith('med:')).flatMap(([key, value]) => {
    try { return [{ ...core.medication(value), id: key.slice(4), createdAt: value.createdAt ?? '' }]; }
    catch { return []; }
  }).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  return { meds, settings: core.config(synced.settings), local, now: new Date().toISOString() };
}
async function clearNotices() {
  const shown = await api.notifications.getAll();
  await Promise.all(Object.keys(shown).filter(id => id.startsWith('notice:')).map(id => api.notifications.clear(id)));
}
async function check() {
  const state = await snapshot();
  const now = new Date();
  const ctx = core.context(now);
  const missing = core.pending(state.meds, state.local, ctx.date, ctx.period);
  await api.action.setBadgeBackgroundColor({ color: '#25796c' });
  await api.action.setBadgeText({ text: missing.length ? String(missing.length) : '' });
  await api.action.setTitle({ title: missing.length ? `ゆるり · ${core.PERIODS.find(p => p.id === ctx.period).label}の未記録 ${missing.length}件` : 'ゆるり · おくすりの記録' });
  const due = core.reminder(state.meds, state.local, state.settings, now);
  const shown = await api.notifications.getAll();
  for (const id of Object.keys(shown)) {
    if (id.startsWith('notice:') && id !== due?.key) await api.notifications.clear(id);
  }
  if (due && !state.local[due.key]) {
    const snoozedUntil = state.local[`snooze:${ctx.date}:${ctx.period}`] ?? 0;
    if (now.getTime() >= snoozedUntil) {
      const label = core.PERIODS.find(p => p.id === due.period).label;
      await api.notifications.create(due.key, {
        type: 'basic', iconUrl: api.runtime.getURL('icons/icon-128.png'),
        title: `${label}のおくすり、飲み忘れていませんか？`,
        message: state.settings.privateNotifications ? '服薬の記録がありません。' : `${due.missing.map(m => m.name).join('、').slice(0, 180)} の記録がありません。`,
      });
      // Only mark sent after the notification API succeeds, so failed delivery can retry.
      await api.storage.local.set({ [due.key]: now.toISOString() });
    }
  }
  const expired = core.expiredKeys(state.local, now);
  if (expired.length) await api.storage.local.remove(expired);
}
async function init() {
  if (!await api.alarms.get(ALARM)) await api.alarms.create(ALARM, { periodInMinutes: 5 });
  await check();
}
async function handle(message) {
  if (message.type === 'snapshot') return snapshot();
  if (message.type === 'save-med') {
    const clean = core.medication(message.med);
    const state = await snapshot();
    const existing = state.meds.find(m => m.id === message.id);
    if (message.id && !existing) throw new Error('この薬は別の画面またはデバイスで削除されました。画面を開き直してください。');
    if (!existing && state.meds.length >= 40) throw new Error('登録できる薬は40件までです。');
    const id = existing?.id ?? crypto.randomUUID();
    await api.storage.sync.set({ [`med:${id}`]: { ...clean, createdAt: existing?.createdAt ?? new Date().toISOString() } });
  } else if (message.type === 'delete-med') {
    if (typeof message.id !== 'string' || !/^[a-f0-9-]{36}$/.test(message.id)) throw new Error('薬のIDが正しくありません。');
    await api.storage.sync.remove(`med:${message.id}`);
  } else if (message.type === 'record') {
    const state = await snapshot();
    const med = state.meds.find(m => m.id === message.id && m.active && m.periods.includes(message.period));
    if (!med || !core.PERIODS.some(p => p.id === message.period)) throw new Error('薬の設定が変更されています。画面を開き直してください。');
    const date = core.context(new Date()).date;
    if (message.date !== date) throw new Error('日付が切り替わりました。画面を更新して記録してください。');
    const key = core.recordKey(date, med.id, message.period);
    if (message.taken) await api.storage.local.set({ [key]: { at: new Date().toISOString(), name: med.name, period: message.period } });
    else await api.storage.local.remove(key);
  } else if (message.type === 'save-settings') {
    await api.storage.sync.set({ settings: core.config(message.settings) });
    if (message.settings.enabled === false) await clearNotices();
  } else if (message.type === 'snooze') {
    const ctx = core.context(new Date());
    await api.storage.local.set({ [`snooze:${ctx.date}:${ctx.period}`]: Date.now() + 60 * 60 * 1000 });
    await api.storage.local.remove(core.noticeKey(ctx.date, ctx.period));
    await clearNotices();
  } else if (message.type === 'test-notification') {
    await api.notifications.create('yururi-test', { type: 'basic', iconUrl: api.runtime.getURL('icons/icon-128.png'), title: 'ゆるり · 通知のテスト', message: 'テスト通知です。' });
  } else throw new Error('不明な操作です。');
  // A successful storage write remains a success even if the OS rejects notifications.
  try { await check(); } catch (error) { console.error('通知の確認に失敗しました:', error); }
  return snapshot();
}
api.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== api.runtime.id) return false;
  enqueue(() => handle(message)).then(data => respond({ ok: true, data }), error => respond({ ok: false, error: error.message }));
  return true;
});
api.runtime.onInstalled.addListener(() => { enqueue(init); });
api.runtime.onStartup.addListener(() => { enqueue(init); });
api.alarms.onAlarm.addListener(alarm => { if (alarm.name === ALARM) enqueue(check); });
api.storage.onChanged.addListener((changes, area) => { if (area === 'sync') enqueue(check); });
api.notifications.onClicked.addListener(id => {
  if (id.startsWith('notice:') || id === 'yururi-test') {
    api.tabs.create({ url: api.runtime.getURL('app.html') });
    api.notifications.clear(id);
  }
});
enqueue(init);
