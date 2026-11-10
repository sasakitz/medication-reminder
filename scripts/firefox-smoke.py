"""Optional smoke test against a dedicated Firefox --marionette profile.

Set marionette.port to 2831 in that profile, set the environment variable
MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1, and start Firefox with
--headless --no-remote --marionette.
Uses only Python's standard library. Never target a personal profile.
"""
import json
import os
from pathlib import Path
import socket
import time

root = Path(__file__).resolve().parent.parent
sock = socket.create_connection(('127.0.0.1', int(os.environ.get('MARIONETTE_PORT', '2831'))), timeout=15)


def receive():
    length = b''
    while True:
        char = sock.recv(1)
        if not char:
            raise RuntimeError('Firefox disconnected')
        if char == b':':
            break
        length += char
    remaining = int(length)
    chunks = []
    while remaining:
        chunk = sock.recv(remaining)
        if not chunk:
            raise RuntimeError('Firefox disconnected')
        chunks.append(chunk)
        remaining -= len(chunk)
    return json.loads(b''.join(chunks))


receive()  # protocol greeting
sequence = 0


def command(name, params=None):
    global sequence
    sequence += 1
    data = json.dumps([0, sequence, name, params or {}]).encode()
    sock.sendall(str(len(data)).encode() + b':' + data)
    response = receive()
    if response[2]:
        raise RuntimeError(f'{name}: {response[2]}')
    return response[3]


def js(script):
    result = command('WebDriver:ExecuteScript', {'script': script, 'args': [], 'newSandbox': True, 'sandbox': 'default', 'line': 1, 'filename': 'firefox-smoke.py'})
    return result.get('value') if isinstance(result, dict) else result


def wait_for(expression):
    for _ in range(60):
        if js(f'return Boolean({expression});'):
            return
        time.sleep(0.1)
    raise AssertionError(f'UI condition failed: {expression}')


try:
    session = command('WebDriver:NewSession', {'capabilities': {'alwaysMatch': {'acceptInsecureCerts': True}}})
    print('Firefox', session.get('capabilities', {}).get('browserVersion', ''))
    command('Addon:Install', {'path': str(root / 'dist' / 'yururi-firefox.zip'), 'temporary': True})
    command('Marionette:SetContext', {'value': 'chrome'})
    url = js('return WebExtensionPolicy.getByID("yururi-medication-reminder@tak.local").getURL("app.html");')
    command('Marionette:SetContext', {'value': 'content'})
    command('WebDriver:Navigate', {'url': url})
    wait_for('document.querySelector("[data-action=add]")')
    js('document.querySelector("[data-action=add]").click();')
    wait_for('document.querySelector("dialog").open')
    js('document.querySelector("[name=name]").value="Firefox動作テスト"; document.querySelector("[value=morning]").checked=true; document.querySelector("#med-form").requestSubmit(document.querySelector("#med-form [type=submit]"));')
    wait_for('document.querySelector("[data-action=record]")')
    js('document.querySelector("[data-action=record]").click();')
    wait_for('document.querySelector(".record-button.done")')
    js('document.querySelector("[data-view=history]").click();')
    wait_for('document.querySelector(".history-row")')
    js('document.querySelector("[data-view=settings]").click();')
    wait_for('document.querySelector("#settings-form")')
    js('document.querySelector("#enabled").click(); document.querySelector("#settings-form").requestSubmit(document.querySelector("#settings-form [type=submit]"));')
    wait_for('document.querySelector("#status").textContent.includes("設定を同期領域に保存")')
    js('document.querySelector("[data-action=edit]").click();')
    wait_for('document.querySelector("dialog").open')
    assert js('return document.querySelector("[name=name]").value;') == 'Firefox動作テスト'
    js('document.querySelector("#cancel-dialog").click(); document.querySelector("[data-action=ask-delete]").click(); document.querySelector("[data-action=delete]").click();')
    wait_for('!document.querySelector("[data-action=edit]")')
    print('Firefox real-extension smoke test passed: install, add, record, history, settings, edit, delete.')
finally:
    sock.close()
