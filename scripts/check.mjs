import { readFile, access, readdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createPublicKey } from 'node:crypto';
for (const target of ['chromium', 'firefox']) {
  const dir = `dist/${target}`;
  const manifest = JSON.parse(await readFile(`${dir}/manifest.json`, 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, ['storage', 'alarms', 'notifications']);
  assert.equal(manifest.host_permissions, undefined);
  for (const icon of Object.values(manifest.icons)) await access(`${dir}/${icon}`);
  for (const file of await readdir(dir)) if (file.endsWith('.js')) new vm.Script(await readFile(`${dir}/${file}`, 'utf8'), { filename: file });
  for (const page of [manifest.action.default_popup, manifest.options_ui.page]) await access(`${dir}/${page.split('?')[0]}`);
  if (target === 'firefox') {
    assert.ok(manifest.browser_specific_settings.gecko.id);
    assert.deepEqual(manifest.background.scripts, ['core.js', 'background.js']);
    assert.deepEqual(manifest.browser_specific_settings.gecko.data_collection_permissions.required, ['healthInfo']);
  } else {
    assert.equal(manifest.background.service_worker, 'background.js');
    assert.equal(createPublicKey({ key: Buffer.from(manifest.key, 'base64'), format: 'der', type: 'spki' }).asymmetricKeyType, 'rsa');
  }
  console.log(`${target}: manifest, assets, permissions and JavaScript OK`);
}
