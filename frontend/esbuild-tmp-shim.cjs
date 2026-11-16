// 构建 shim:让 esbuild 的 transform 输入走管道内联,不再经临时文件中转。
//
// 背景(2026-10 Windows 实测):esbuild 0.21.5 的 JS↔Go 服务协议对超过 1MB 的
// transform 输入走"临时文件中转"——JS 端写 %TEMP%\esbuild-<64 位哈希>,Go 端
// 读取后 os.Remove。本机构建时该删除持续报错:
//   remove C:\...\Temp\esbuild-xxxx: Access is denied.
// 构建随即失败(退出码 1)并遗留临时文件。具体占用来源尚未确认:本机装有
// Defender 与联想/火绒等实时防护,但未定位到持有句柄的进程;换 TEMP 到其他盘、
// 写后延迟交付均无效。已核对上游最新 esbuild 源码,删除失败仍直接报错、无重试,
// 升级能否解决未实测。
//
// 原理:esbuild 自身对桥接写入失败有容错路径——直接把输入从管道内联传输
// (即 ≤1MB 输入的既有通道)。这里让桥接写入"故意失败",于是全程不产生临时
// 文件,删除失败问题不再出现。3MB 级输入内联实测正常,构建产物无残留。
// 这是本机构建的绕行措施,依赖 0.21.5 的临时文件命名与失败降级行为;
// 升级 esbuild 后运行 npm run build，确认大体积产物仍能正常构建。
//
// 恢复默认行为:把 package.json 的 dev / build 脚本里的
//   node -r ./esbuild-tmp-shim.cjs node_modules/vite/bin/vite.js ...
// 改回 `vite` / `vite build` 即可;若想从占用来源一侧解决,先确认持有临时文件
// 句柄的进程,再在对应杀软中给 %TEMP%\esbuild-* 加扫描排除。
'use strict';

const fs = require('fs');

if (process.platform === 'win32') {
  const origWriteFile = fs.writeFile;
  fs.writeFile = function (p, data) {
    // fs.writeFile 有 (path, data, cb) 与 (path, data, options, cb) 两种签名,
    // 回调一律取末位参数并校验类型;普通路径原样转发所有参数。
    const cb = arguments[arguments.length - 1];
    if (typeof p === 'string' && typeof cb === 'function' && /[\\/]esbuild-[0-9a-f]{64}$/.test(p)) {
      return setImmediate(() => cb(new Error('esbuild temp bridge disabled by esbuild-tmp-shim')));
    }
    return origWriteFile.apply(fs, arguments);
  };
}
