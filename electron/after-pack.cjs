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

/**
 * 整包 ad-hoc 签名 —— **只为一件事:让签名有效**。
 *
 * ## 为什么不追真证书
 *
 * 曾经这里是「优先用钥匙串里的真证书签」,理由是「ad-hoc 签名的身份跟着二进制变
 * ⇒ 之前授过的「辅助功能」授权留不住」。
 * **那个理由已作废**(2026-10-24 用户口径):重新安装需要重新授权是**正常代价**,
 * 不值得为它维护任何额外机制 —— 不追证书、不追授权状态、
 * 也不写「以后更新包不会再掉」这种承诺。重新勾一次就是了。
 *
 * ## 那为什么还要签
 *
 * 只为一个目的:**签名必须有效**。
 * 没经过整包签名的 app,`codesign --verify` 会报
 * 「code has no resources but signature indicates they must be present」——
 * 那是**无效签名**,Gatekeeper 判成「应用已损坏」,比「无法验证开发者」更难绕过。
 * ad-hoc 整包签名足够让 Gatekeeper 走「无法验证开发者 → 右键打开」那条可绕过的路。
 */
function signApp(appPath, bundleId) {
  execFileSync(
    'codesign',
    ['--force', '--deep', '--sign', '-', '--identifier', bundleId, appPath],
    { stdio: 'inherit' }
  );
}

exports.default = async function afterPack(context) {
  const { appOutDir, electronPlatformName, packager } = context;
  if (electronPlatformName && electronPlatformName !== 'darwin') {
    return;
  }

  const productName = packager.appInfo.productName;
  const appPath = path.join(appOutDir, `${productName}.app`);
  const bundleId = resolveBundleIdentifier(appPath);

  try {
    signApp(appPath, bundleId);
    console.log(`[afterPack] ad-hoc 整包签名完成 ${appPath} (${bundleId})`);
  } catch (e) {
    // 签不了就照实说 —— 别把「签坏了」的包当成好的发出去。
    console.error('[afterPack] 签名失败:', e.message);
  }
};

exports.resolveBundleIdentifier = resolveBundleIdentifier;
