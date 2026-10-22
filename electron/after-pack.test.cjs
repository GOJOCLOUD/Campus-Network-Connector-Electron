const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { default: afterPack, resolveBundleIdentifier } = require('./after-pack.cjs');

test('package build appId keeps the existing app identity', () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')
  );

  assert.equal(packageJson.build.appId, 'com.gojocloud.campus-network-connector');
});

test('resolveBundleIdentifier reads CFBundleIdentifier from Info.plist', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'after-pack-'));
  const appPath = path.join(tempDir, 'Test.app');
  const contentsDir = path.join(appPath, 'Contents');
  fs.mkdirSync(contentsDir, { recursive: true });
  fs.writeFileSync(path.join(contentsDir, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>com.gojocloud.campus-network-connector</string>
</dict>
</plist>
`);

  assert.equal(resolveBundleIdentifier(appPath), 'com.gojocloud.campus-network-connector');
});

test('afterPack skips non-macOS targets', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'after-pack-win-'));

  await assert.doesNotReject(() =>
    afterPack({
      appOutDir: tempDir,
      electronPlatformName: 'win32',
      packager: {
        appInfo: {
          productName: '模拟输入',
        },
      },
    })
  );
});
