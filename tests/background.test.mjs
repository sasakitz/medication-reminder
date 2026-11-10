import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
process.env.TZ = 'Asia/Tokyo';
const coreSource = await readFile(new URL('../src/core.js', import.meta.url), 'utf8');
const backgroundSource = await readFile(new URL('../src/background.js', import.meta.url), 'utf8');
const medId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
function event() { const listeners = []; return { addListener: fn => listeners.push(fn), emit: (...args) => listeners.forEach(fn => fn(...args)) }; }
function harness({ firefox = false, sync = {}, local = {}, time = '2026-11-10T09:00:00+09:00' } = {}) {
  let clock = new Date(time).getTime();
  let rejectNotification = false;
  let rejectSync = false;
  const sent = [];
  const shown = {};
  const alarms = {};
  const clone = value => structuredClone(value);
  const area = data => ({
    get: async () => clone(data),
    set: async entries => { if (data === sync && rejectSync) throw new Error('QUOTA_BYTES'); Object.assign(data, clone(entries)); },
    remove: async keys => { for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]; },
  });
  const api = {
    storage: { sync: area(sync), local: area(local), onChanged: event() },
    runtime: { id: 'test-extension', onInstalled: event(), onStartup: event(), onMessage: event(), getURL: path => `extension://${path}` },
    notifications: { getAll: async () => clone(shown), create: async (id, opts) => { if (rejectNotification) throw new Error('OS denied'); sent.push({ id, ...clone(opts) }); shown[id] = opts; return id; }, clear: async id => { delete shown[id]; }, onClicked: event() },
    alarms: { get: async id => alarms[id], create: async (id, opts) => { alarms[id] = opts; }, onAlarm: event() },
    action: { setBadgeBackgroundColor: async () => {}, setBadgeText: async () => {}, setTitle: async () => {} },
    tabs: { create: async () => {} },
  };
  class FakeDate extends Date { constructor(...args) { super(...(args.length ? args : [clock])); } static now() { return clock; } }
  const context = vm.createContext({ [firefox ? 'browser' : 'chrome']: api, Date: FakeDate, crypto: { randomUUID }, console: { error() {} } });
  if (firefox) vm.runInContext(coreSource, context);
  else context.importScripts = () => vm.runInContext(coreSource, context);
  vm.runInContext(backgroundSource, context);
  const message = data => new Promise(resolve => api.runtime.onMessage.emit(data, { id: api.runtime.id }, response => resolve(clone(response))));
  return { sync, local, sent, shown, alarms, api, message, setTime: value => { clock = new Date(value).getTime(); }, failNotifications: value => { rejectNotification = value; }, failSync: value => { rejectSync = value; }, async tick() { api.alarms.onAlarm.emit({ name: 'yururi-check' }); return message({ type: 'snapshot' }); } };
}
const morningMed = { name: '薬A', note: '', active: true, periods: ['morning'], createdAt: '2026-11-01' };
for (const firefox of [false, true]) {
  test(`${firefox ? 'Firefox event page' : 'Chromium worker'}: 記録・通知抑制・再起動を通して動作`, async () => {
    const h = harness({ firefox, sync: { [`med:${medId}`]: morningMed } });
    assert.equal((await h.message({ type: 'snapshot' })).ok, true);
    assert.equal(h.alarms['yururi-check'].periodInMinutes, 5);
    assert.equal(h.sent.length, 0);
    h.setTime('2026-11-10T10:00:00+09:00');
    await h.tick(); await h.tick();
    assert.equal(h.sent.length, 1);
    assert.ok(!h.sent[0].message.includes('薬A'));
    assert.equal((await h.message({ type: 'record', id: medId, period: 'morning', date: '2026-11-10', taken: true })).ok, true);
    assert.ok(h.local[`record:2026-11-10:${medId}:morning`]);
    assert.equal(Object.keys(h.shown).length, 0);
    assert.ok(!Object.keys(h.sync).some(key => key.startsWith('record:')));
    const restarted = harness({ firefox, sync: h.sync, local: h.local, time: '2026-11-10T11:00:00+09:00' });
    await restarted.tick();
    assert.equal(restarted.sent.length, 0);
    assert.equal((await restarted.message({ type: 'record', id: medId, period: 'morning', date: '2026-11-09', taken: true })).ok, false);
  });
}
test('スヌーズ中は通知せず、1時間後に1回だけ再通知', async () => {
  const h = harness({ sync: { [`med:${medId}`]: morningMed }, time: '2026-11-10T10:00:00+09:00' });
  await h.message({ type: 'snapshot' });
  assert.equal(h.sent.length, 1);
  await h.message({ type: 'snooze' });
  h.setTime('2026-11-10T10:59:00+09:00'); await h.tick();
  assert.equal(h.sent.length, 1);
  h.setTime('2026-11-10T11:00:00+09:00'); await h.tick(); await h.tick();
  assert.equal(h.sent.length, 2);
});
test('通知失敗は次回に再試行、記録の保存は成功として扱う', async () => {
  const h = harness({ sync: { [`med:${medId}`]: morningMed } });
  await h.message({ type: 'snapshot' });
  h.failNotifications(true);
  h.setTime('2026-11-10T10:00:00+09:00'); await h.tick();
  assert.equal(h.local['notice:2026-11-10:morning'], undefined);
  h.failNotifications(false); await h.tick();
  assert.equal(h.sent.length, 1);
  h.failNotifications(true);
  assert.equal((await h.message({ type: 'record', id: medId, period: 'morning', date: '2026-11-10', taken: true })).ok, true);
});
test('設定の同期失敗をUIに返し、保存完了と偽らない', async () => {
  const h = harness(); await h.message({ type: 'snapshot' });
  h.failSync(true);
  const result = await h.message({ type: 'save-med', med: morningMed });
  assert.equal(result.ok, false);
  assert.match(result.error, /QUOTA/);
  assert.deepEqual(h.sync, {});
});
test('通知無効・薬の削除と編集・履歴の保持', async () => {
  const h = harness(); await h.message({ type: 'snapshot' });
  let response = await h.message({ type: 'save-med', med: morningMed });
  assert.equal(response.ok, true);
  const id = response.data.meds[0].id;
  await h.message({ type: 'record', id, period: 'morning', date: '2026-11-10', taken: true });
  response = await h.message({ type: 'save-med', id, med: { ...morningMed, name: '変更後' } });
  assert.equal(response.data.meds[0].name, '変更後');
  await h.message({ type: 'save-settings', settings: { enabled: false } });
  await h.message({ type: 'delete-med', id });
  assert.equal(Object.keys(h.sync).filter(key => key.startsWith('med:')).length, 0);
  assert.ok(h.local[`record:2026-11-10:${id}:morning`]);
  assert.equal((await h.message({ type: 'save-med', id, med: morningMed })).ok, false);
  h.setTime('2026-11-10T10:00:00+09:00'); await h.tick();
  assert.equal(h.sent.length, 0);
});
test('翌朝は前日の通知済み状態に影響されず通知する', async () => {
  const h = harness({ sync: { [`med:${medId}`]: morningMed }, local: { 'notice:2026-11-09:morning': true }, time: '2026-11-10T10:00:00+09:00' });
  await h.tick();
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].id, 'notice:2026-11-10:morning');
});
