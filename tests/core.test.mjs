import test from 'node:test';
import assert from 'node:assert/strict';
import '../src/core.js';
process.env.TZ = 'Asia/Tokyo';
const C = globalThis.ReminderCore;
const now = time => new Date(`2026-11-10T${time}:00+09:00`);
const meds = [
  { id: 'a', name: '薬A', active: true, periods: ['morning', 'evening'] },
  { id: 'b', name: '薬B', active: true, periods: ['noon', 'evening'] },
  { id: 'c', name: 'お休み', active: false, periods: ['morning'] },
];

test('朝・昼・晩の境界と深夜の服薬日をローカル時刻で判定', () => {
  for (const [time, date, period, hour] of [
    ['03:59', '2026-11-09', 'evening', 27], ['04:00', '2026-11-10', 'morning', 4],
    ['11:59', '2026-11-10', 'morning', 11], ['12:00', '2026-11-10', 'noon', 12],
    ['17:59', '2026-11-10', 'noon', 17], ['18:00', '2026-11-10', 'evening', 18],
    ['23:59', '2026-11-10', 'evening', 23],
  ]) assert.deepEqual(C.context(now(time)), { date, period, hour });
});
test('月末・年末・閏日でも深夜は前日', () => {
  assert.equal(C.context(new Date('2027-01-01T02:00:00+09:00')).date, '2026-12-31');
  assert.equal(C.context(new Date('2028-03-01T02:00:00+09:00')).date, '2028-02-29');
});
test('通知目安までは通知しない。過ぎたら未記録の有効な薬だけ', () => {
  assert.equal(C.reminder(meds, {}, C.DEFAULTS, now('09:59')), null);
  assert.deepEqual(C.reminder(meds, {}, C.DEFAULTS, now('10:00')).missing.map(m => m.id), ['a']);
  assert.equal(C.reminder(meds, { [C.recordKey('2026-11-10', 'a', 'morning')]: {} }, C.DEFAULTS, now('10:30')), null);
  assert.deepEqual(C.reminder(meds, {}, C.DEFAULTS, now('21:00')).missing.map(m => m.id), ['a', 'b']);
});
test('過去の時間帯の未記録を新しい時間帯に通知しない', () => {
  assert.equal(C.reminder(meds, {}, C.DEFAULTS, now('12:00')), null);
  assert.deepEqual(C.reminder(meds, {}, C.DEFAULTS, now('15:00')).missing.map(m => m.id), ['b']);
});
test('通知停止と翌日深夜の通知目安を扱う', () => {
  assert.equal(C.reminder(meds, {}, { ...C.DEFAULTS, enabled: false }, now('10:00')), null);
  const config = C.config({ hours: { evening: 25 } });
  assert.equal(C.reminder(meds, {}, config, now('00:59')), null);
  const due = C.reminder(meds, {}, config, now('01:00'));
  assert.equal(due.date, '2026-11-09');
  assert.equal(due.key, 'notice:2026-11-09:evening');
});
test('不正な同期設定は初期値に戻し、薬の入力を検証', () => {
  assert.deepEqual(C.config(null), C.DEFAULTS);
  assert.deepEqual(C.config({ hours: { morning: 20, noon: '15', evening: 28 } }), C.DEFAULTS);
  assert.throws(() => C.medication({ name: '  ', periods: ['morning'] }));
  assert.throws(() => C.medication({ name: '薬', periods: ['invalid'] }));
  assert.throws(() => C.medication({ name: '薬', note: 'あ'.repeat(121), periods: ['morning'] }));
  assert.deepEqual(C.medication({ name: ' 薬 ', periods: ['evening', 'morning', 'morning', 'bad'] }), { name: '薬', note: '', active: true, periods: ['morning', 'evening'] });
});
test('90日保持する記録と通知のみを掃除する', () => {
  const dates = C.previousDays(now('10:00'), 91);
  assert.equal(dates.length, 91);
  const local = { [`record:${dates[89]}:a:morning`]: {}, [`record:${dates[90]}:a:morning`]: {}, [`notice:${dates[90]}:evening`]: true, [`snooze:${dates[90]}:noon`]: 1, 'other:2020-01-01': true };
  assert.deepEqual(C.expiredKeys(local, now('10:00')), [`record:${dates[90]}:a:morning`, `notice:${dates[90]}:evening`, `snooze:${dates[90]}:noon`]);
});
test('DSTのあるタイムゾーンでもカレンダーの日付を使用', () => {
  const original = process.env.TZ;
  process.env.TZ = 'America/New_York';
  try {
    const dates = C.previousDays(new Date('2026-11-02T10:00:00-05:00'), 3);
    assert.deepEqual(dates, ['2026-11-02', '2026-11-01', '2026-10-31']);
  } finally { process.env.TZ = original; }
});
