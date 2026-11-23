# LibreTV Desktop Windows 构建

Electron Main 托管 Next.js 15 生产 Custom Server，固定监听在 127.0.0.1:17888。桌面启动时由 Main 调用原有登录路由，在应用专属 Session 中安装 HttpOnly 会话。当前验收状态见 docs/PROJECT_STATE.md。

## 构建和运行

使用原生 Windows x64 Node 和 npm。在本次验证中使用 Node 24.13.0、npm 11.6.2。项目锁定 Next.js 15.5.29、Electron 44.9.3 与 electron-builder 26.17.0。

在仓库根目录执行：

```powershell
npm.cmd --prefix desktop ci --no-audit --no-fund
npm.cmd --prefix desktop run build
```

每次构建创建一个独立的 `artifacts/validation/desktop-*` 目录。`dist/win-unpacked/` 内的 `LibreTV Desktop.exe` 可双击启动，搬移时保留同目录的 DLL 和 `resources`。启动过程使用 Electron 内置 Node，Next 和 Windows 原生模块均随包提供。端口被占用或资源缺失时，应用显示启动错误。日志位于 `%APPDATA%\LibreTVDesktop`。

`resource-manifest.json` 记录 Git HEAD、应用与桌面工具的锁文件 SHA-256、版本、构建 ID、应用源码快照与 Main 输入摘要、EXE 和 app.asar 校验值。构建会生成桌面专用 JavaScript Next 配置并核对打包后的运行目录。Web 和 Docker 继续使用仓库根目录的 Next 配置与原有 build scripts。

离线构建可在已备齐两份依赖锁文件的 npm 缓存和 Electron Windows x64 分发缓存时运行 `npm.cmd --prefix desktop ci --offline --no-audit --no-fund` 和 `npm.cmd --prefix desktop run build -- --offline`。可通过 `npm_config_cache` 和 `electron_config_cache` 指定缓存。

编译和打包先在 Windows 本地临时目录完成，再复制到验收目录。若系统临时目录含有 Webpack 保留字符 `!`，使用 `LIBRETV_DESKTOP_BUILD_TEMP` 指定一个可写的本地目录。

## Windows 集成验收

先退出当前正在运行的 LibreTV Desktop。在仓库根目录使用普通 Windows PowerShell 7.2+ 执行一次。下面的路径对应第四轮个人验收包，测试其他构建时替换 `-Executable`。

```powershell
pwsh -NoProfile -File .\desktop\test-integration.ps1 -Executable '.\artifacts\validation\desktop-9tgfWM\dist\win-unpacked\LibreTV Desktop.exe'
```

控制器为每次运行创建独立的 `artifacts/validation/round4/integration-*`。其中的 `acceptance.md` 汇总状态，`run.json` 保存构建身份和结构化结果，`index.md` 指向原始日志、生命周期 CSV、进程树和 Main CPU、工作集、启动时间采样。不需要手工收集这些文件。

控制器识别打包文件中实际存在的探针。第三轮包已有生命周期、自动登录、受保护 API、RSC、Range、Blob Worker 和 profile 重启检查。后续包含专用集成探针的包会在同一份隔离 profile 额外执行初次和重启两阶段。历史源 JSON 和第三轮生成的合成媒体会按固定文件名复制到该测试 profile，缺失数据的用例报告 NOT RUN。可用 `-FixtureDirectory` 指定包含同名合成媒体文件的目录。

测试使用独立的临时 profile，并从系统 PATH 排除 Node。端口 17888 已被占用时记录阻塞并停止。测试仅关闭自己创建的测试进程。退出码 `0` 表示全部自动检查通过，`1` 表示存在失败，`2` 表示结果未齐或环境阻塞。长时间播放、不同文件系统、受保护安装目录和 Docker 的证据需要独立验证，表中单独列出。

`test-packaged.ps1` 是底层生命周期脚本，可独立执行。P1 旧二进制的原始启动验收使用 `-LegacyStartupOnly`。

## 个人使用构建

本机已有用户提供的历史源 JSON 时，执行 npm.cmd --prefix desktop run build:personal。构建校验并装配被 Git 忽略的 artifacts/fixtures/libretv-historical-sources.json。仅全新 Profile 初始化 22 条源，已有设置、停用和删除保持。普通 build 与 Web/Docker 默认配置不变。
