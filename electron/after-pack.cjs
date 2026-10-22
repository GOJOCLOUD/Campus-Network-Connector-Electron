const { execFileSync } = require('child_process');
const path = require('path');

function resolveBundleIdentifier(appPath) {
  const infoPlist = path.join(appPath, 'Contents', 'Info.plist');
  return execFileSync(
    'plutil',
    ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', infoPlist],
    { encoding: 'utf8' }
  ).trim();
}

exports.default = async function afterPack(context) {
  const { appOutDir, electronPlatformName, packager } = context;
  if (electronPlatformName && electronPlatformName !== 'darwin') {
    return;
  }

  const productName = packager.appInfo.productName;
  const appPath = path.join(appOutDir, `${productName}.app`);
  const bundleId = resolveBundleIdentifier(appPath);

  // Ad-hoc sign the whole .app bundle (includes native .node addon)
  try {
    execFileSync(
      'codesign',
      ['--force', '--deep', '--sign', '-', '--identifier', bundleId, appPath],
      { stdio: 'inherit' }
    );
    console.log(`[afterPack] ad-hoc signed ${appPath} (${bundleId})`);
  } catch (e) {
    console.error('[afterPack] re-sign failed:', e.message);
  }
};

exports.resolveBundleIdentifier = resolveBundleIdentifier;
