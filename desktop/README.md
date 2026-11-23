# LibreTV Desktop Windows 构建

当前目录提供 P1 打包验证版。Electron Main 托管 Next.js 15 生产 Custom Server，固定监听在 127.0.0.1:17888。预览版加载现有首页和直播页面，保留上游登录校验，桌面自动鉴权和媒体访问留待 P2 后启用。

## 构建和运行

使用原生 Windows x64 Node 和 npm。在本次验证中使用 Node 24.13.0、npm 11.6.2。项目锁定 Next.js 15.5.28、Electron 44.9.3 与 electron-builder 26.17.0。

在仓库根目录执行：

```powershell
npm.cmd --prefix desktop ci --no-audit --no-fund
npm.cmd --prefix desktop run build
```

每次构建创建一个独立的 `artifacts/validation/desktop-*` 目录。`dist/win-unpacked/` 内的 `LibreTV Desktop.exe` 可双击启动，搬移时保留同目录的 DLL 和 `resources`。启动过程使用 Electron 内置 Node，Next 和 Windows 原生模块均随包提供。端口被占用或资源缺失时，应用显示启动错误。日志位于 `%APPDATA%\LibreTVDesktop`。

`resource-manifest.json` 记录 Git HEAD、应用与桌面工具的锁文件 SHA-256、版本、构建 ID、EXE 和 app.asar 校验值。构建会生成桌面专用 JavaScript Next 配置并核对打包后的运行目录。Web 和 Docker 继续使用仓库根目录的 Next 配置与原有 build scripts。

离线构建可在已备齐两份依赖锁文件的 npm 缓存和 Electron Windows x64 分发缓存时运行 `npm.cmd --prefix desktop ci --offline --no-audit --no-fund` 和 `npm.cmd --prefix desktop run build -- --offline`。可通过 `npm_config_cache` 和 `electron_config_cache` 指定缓存。

编译和打包先在 Windows 本地临时目录完成，再复制到验收目录。若系统临时目录含有 Webpack 保留字符 `!`，使用 `LIBRETV_DESKTOP_BUILD_TEMP` 指定一个可写的本地目录。

## Windows 生命周期验收

PowerShell 7.2+ 支持运行自动测试。把该次构建输出的 EXE 路径传给脚本。

```powershell
pwsh -NoProfile -File .\desktop\test-packaged.ps1 -Executable 'E:\path\to\win-unpacked\LibreTV Desktop.exe'
```

脚本使用隔离配置目录、后台窗口和 Windows 系统 PATH。它检查打包后的页面和 API、Windows 监听 PID 和进程树、十次正常退出、单实例、端口占用、强制终止后重启，以及缺少运行时配置。每次运行生成独立的 `artifacts/validation/p1-smoke-*` 证据目录。
