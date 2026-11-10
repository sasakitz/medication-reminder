import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { zipDirectory } from './zip.mjs';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
// Public key only. Stabilizes unpacked-extension IDs across device paths.
const developmentKey = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAzbHXjwvN/M18ZTAUxjXWcBETut5Rbu4M74G3rPXYuO7WoWb+1ClkpMGGynH+32yCPCe6mfLIx0zZGLUwbR9bkwJ30+0VqU54WNNiCBMK1chHgnYKNJJi9upv0ugSb8AkV76W507MJdEtH+/iEOL9PiAv9dL4OuZG4aCjmndeicVh/t7xlwFpe/4axW4f+O+CPr8kfEybq6MQzhNumPjqNkAbcJKMgQG5Eu7ZnOG13VeVFi/nsLeZPchbpQVlFDen8xHq5FQtXK7OFIcbT6j3aePYhkKLR9PqpsUo8GUR1dyMuDcYISQ5lX5GtyqkM2DlgkFNyu0yF2DxjzjeYRVB8wIDAQAB';
const common = {
  manifest_version: 3,
  name: 'ゆるり — おくすりリマインダー',
  version: pkg.version,
  description: '朝・昼・晩の服薬を記録し、未記録の薬を通知します。',
  permissions: ['storage', 'alarms', 'notifications'],
  icons: { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png', 48: 'icons/icon-48.png', 128: 'icons/icon-128.png' },
  action: { default_title: 'ゆるり · おくすりの記録', default_popup: 'app.html?popup', default_icon: { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png' } },
  options_ui: { page: 'app.html?view=settings', open_in_tab: true },
  content_security_policy: { extension_pages: "script-src 'self'; object-src 'none'; base-uri 'none'" },
};
for (const target of ['chromium', 'firefox']) {
  const out = path.join(root, 'dist', target);
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  await cp(path.join(root, 'src'), out, { recursive: true });
  const manifest = target === 'chromium'
    ? { ...common, key: developmentKey, minimum_chrome_version: '120', background: { service_worker: 'background.js' } }
    : { ...common, background: { scripts: ['core.js', 'background.js'] }, browser_specific_settings: { gecko: { id: 'yururi-medication-reminder@tak.local', strict_min_version: '140.0', data_collection_permissions: { required: ['healthInfo'] } } } };
  await writeFile(path.join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const archive = path.join(root, 'dist', `yururi-${target}.zip`);
  await rm(archive, { force: true });
  await zipDirectory(out, archive);
  console.log(`Built dist/${target} and dist/yururi-${target}.zip`);
}
