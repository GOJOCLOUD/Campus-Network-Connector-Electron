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
 * 钥匙串里有没有**有效的**代码签名身份。
 *
 * ## 为什么不能用 ad-hoc(2026-10-24 定位)
 *
 * ad-hoc 签名(`TeamIdentifier=not set`)拿不到**稳定的**系统授权身份:
 * 用户在「系统设置 → 隐私与安全性 → 辅助功能」里勾选这个 App 之后,
 * **每次重新构建、重新签名,身份都会变** ⇒ 授权留不住 ⇒
 * 发合成点击/按键(`CGEventPost`)被系统静默丢弃 ⇒
 * 「默认执行」(回放)、键入文本、录制**全都没功能**。
 *
 * 与 Tauri 版的 `tools/install-macos-app.sh` **同口径**:能用真证书就用真证书
 * (本机用的是 Apple Development: 8618291894921)。
 *
 * CI 上没有证书 ⇒ 返回 null ⇒ 退回 ad-hoc(分发场景的限制,见项目记忆.md)。
 */
function resolveSigningIdentity() {
  try {
    const out = execFileSync(
      'security',
      ['find-identity', '-v', '-p', 'codesigning'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    );
    // 行长这样:  1) BE837299...168B65FD "Apple Development: 8618291894921 (FY2K6ZB64V)"
    const m = out.match(/^\s*\d+\) [0-9A-F]{40} "([^"]+)"/m);
    return m ? m[1] : null;
  } catch (_) {
    return null;
  }
}

function signApp(appPath, bundleId, identity) {
  const args = ['--force', '--deep'];
  args.push('--sign', identity || '-');
  args.push('--identifier', bundleId);
  args.push(appPath);
  execFileSync('codesign', args, { stdio: 'inherit' });
}

exports.default = async function afterPack(context) {
  const { appOutDir, electronPlatformName, packager } = context;
  if (electronPlatformName && electronPlatformName !== 'darwin') {
    return;
  }

  const productName = packager.appInfo.productName;
  const appPath = path.join(appOutDir, `${productName}.app`);
  const bundleId = resolveBundleIdentifier(appPath);

  // 优先用**真证书**签(授权能长期留着);签不了再退回 ad-hoc。
  const identity = resolveSigningIdentity();
  try {
    signApp(appPath, bundleId, identity);
    console.log(
      identity
        ? `[afterPack] signed ${appPath} with ${identity} (${bundleId})`
        : `[afterPack] ad-hoc signed ${appPath} (${bundleId}) —— 钥匙串里没有可用签名身份`
    );
  } catch (e) {
    if (!identity) {
      console.error('[afterPack] ad-hoc 签名失败:', e.message);
      return;
    }
    // 真证书签不过 ⇒ 退一步,别把包打成"签名坏了"的状态。
    console.error('[afterPack] 用', identity, '签名失败,退回 ad-hoc:', e.message);
    try {
      signApp(appPath, bundleId, null);
      console.log(`[afterPack] ad-hoc signed ${appPath} (${bundleId})`);
    } catch (e2) {
      console.error('[afterPack] ad-hoc 签名也失败:', e2.message);
    }
  }
};

exports.resolveBundleIdentifier = resolveBundleIdentifier;
exports.resolveSigningIdentity = resolveSigningIdentity;
