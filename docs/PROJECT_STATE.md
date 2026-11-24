# LibreTV Desktop Project State

项目 LIBRETV-DESKTOP-WIN。基线分支 codex/libretv-desktop。第三轮构建基线为 e7bbbdb771807b4fe05fa92f335e78b8668cca47。方案 B 继续使用，历史 v3 独立审查仍为 BLOCKED / LIMITED。

## 第四轮 — Integration Validation & Stabilization

- 功能验收收尾诊断包 desktop-o8JHkX，Windows x64 个人版，源码 d1a296ef178becb7d437c7f7f0f27cff2ecda174，EXE SHA-256 2ab59ed20c1b4db4b2c16eeb0bc186f5930f5200f05ce1ee5c528cac525268e2。普通 MP4、实际下载文件和仅重封装文件均通过 FFmpeg 完整解码。三路 Electron 测试共享窗口、Session、CSP 和 Blob 路径，记录异常、媒体事件及播放时间。普通 Windows 新包三路对照为 NOT RUN，托管 GUI 启动受审批策略阻断。前次通过的落盘和跨重启对账继续有效，原 Chromium Blob 失败保留。P7 实际截图待核心媒体复验。参见[对照证据](../artifacts/validation/round4/mp4-comparison-readiness.md)。

- Windows x64 个人验收修复包 desktop-J49Qmc 构建与包内校验 PASS，源码提交 36937fa4df02c3d31e470cafc07e733ee2855801，EXE SHA-256 f72a5b04154f913641f2e09f7e67beabd07ce49f4cfb8a6a1abbf6e910d88844。MP4 时长修复后的文件通过生产下载器、Windows 写入、FFmpeg 全文件解码及 3 秒定位。新报告区分文件落盘与 Chromium 播放，并保留重启所需的 SHA-256。普通 Windows 实机复验 PASS 的项目包括授权 HLS 播放、下载落盘、历史与进度恢复、下载任务恢复及重启后的输出 SHA-256 对账。实际保存 129,203 字节，SHA-256 与修复后生产下载夹具一致。Chromium 下载后播放复核仍为 FAIL（DOWNLOAD_CHROMIUM_PLAY_REJECTED）。浏览器已读到 160 像素视频和 7.443 秒时长，拒绝类型未记录。

- 普通 Windows 实机运行 `desktop-FVcFgW`。一次正常启停及四项故障场景、自动登录及受保护 API、三例原生全屏、缩短 Profile 后的 Chromium IndexedDB 读写与重启均 PASS。授权合成 HLS 经过 ArtPlayer 实际解码、播放、跳转和暂停，结果 PASS。源导入及搜索到播放页使用隔离夹具，范围为 PARTIAL。
- 实机下载完成三个分段并保存 129,203 字节的 MP4，下载清单与 SHA-256 一致，FFmpeg 严格全文件解码 PASS。原始验收的 Chromium 文件播放复核仍为 FAIL，独立查出 MP4 轨道时长保留了占位值，呈现 24:51:18.49 的错误时长。重启后历史、播放进度和任务均存在，原探针未执行重启后 SHA 校验，业务重启保持 PARTIAL。

- 普通 Windows 桌面自动化实测已产生。第一次预检因 17888 被占用停止，未记录占用者。第二次成功完成十次启停、单实例、端口占用拒绝、强杀恢复、缺资源拒绝、自动登录、匿名拒绝、RSC、Range、Blob Worker 及隔离 Profile 的重启检查。
- 实机确认新 Profile 首次写入并在重启后保留 22 条个人点播源。三个原生全屏探针 FAIL，合成搜索/详情探针超时，播放及下载 NOT RUN。跨端口 Chromium 请求返回 403，目标收到的请求及凭据头均为零，覆盖范围 PARTIAL。实际生命周期日志仍记录了 Next.js 关闭时的 /api/hot-list AwaiterOnce 异常。
- 实机反馈后的稳定性修复包 desktop-uoXwHS 已构建并复核。原热榜关停异常在真实 Next 编译产物上复现 HTTP 500。新顺序让同一请求返回 200，4 秒硬退出期限保留。全屏 DOM 取样和搜索卡片探针已修复并通过定向回归。普通 Windows 实机复跑通过三次启停、故障场景、关停异常检查和原生全屏三例。设置导入、搜索与详情在合成上游下可靠进入播放页。合成 HLS 播放和原生下载探针仍超时，业务重启验收保持 PARTIAL。
- 第四轮个人 Windows x64 验收包 desktop-9tgfWM 构建 PASS，源码提交 b7c910d73744535a82aa634c827230f2d5136a09，EXE SHA-256 1d9becafecc3f3489b5e9c3c72629d70865c5c07a34dce7da04b2610df895cfb。原生 Windows 启动工具要求审批，当前托管策略拒绝，Codex 托管环境的原生 Electron 仍为 ENVIRONMENT_BLOCKED。普通桌面实机证据由用户启动统一验收入口取得。
- 第四轮从 `a6cbabf` 继续。第三轮基线验收包 `desktop-ZxYrB9` 及源码提交 `e7bbbdb771807b4fe05fa92f335e78b8668cca47` 已复核并保留。用户在普通 Windows 桌面实际体验该包，反馈网页全屏可用，原生显示器全屏未进入。
- 全屏缺陷定位到 Session 的全拒绝权限处理。Electron 44.9.3 通过可信播放主框架的 fullscreen 权限进入原生显示器全屏，继续拒绝自动全屏、子框架和其它权限。点播与直播保留原生与网页两种 ArtPlayer 控件。网关单测 13/13 PASS，实际窗口化、最大化、Esc 和多显示器结果由打包验收单独记录。
- 用户确认个人使用包内置此前提供的 22 条历史点播源。个人构建使用 `npm.cmd --prefix desktop run build:personal`。首次初始化对 URL 去重并分配稳定标识，现有配置保持优先，停用和删除可持久保存。普通桌面构建、Web/Docker 默认行为及鉴权、SSRF、成人过滤沿用原机制。源站有效性和内容授权仍按实际访问情况判断。
- 统一验收入口 `desktop/test-integration.ps1`。使用隔离 Profile、临时数据、有权使用的合成媒体、自动报告和证据索引。实际 EXE、Node 夹具与用户人工结果分别归档。
- 现有产物为 `win-unpacked` 验收目录。单文件 portable EXE 和安装包形式待确认。生产依赖 PostCSS 8.4.31 的构建可达性已确认，已测生产请求未见加载，风险评估仍为 PARTIAL。受保护安装目录、Docker 真实容器、长播与并发下载和其他文件系统结果以本轮验收矩阵为准。

### P7 — Desktop UI/UX Refinement（待确认）

排在 P0–P6 核心验收和主要缺陷修复之后。进入 P7 前提交真实界面截图、主要体验问题和建议方案。整体布局、字体、色彩、留白、卡片、播放器、设置、下载管理和交互反馈待用户确认设计后再实施。

[最新实机媒体复验](../artifacts/validation/round4/media-real-rerun.md) · [稳定性实机复验](../artifacts/validation/round4/stabilization-real-rerun.md) · [第四轮证据](../artifacts/validation/round4/summary.md) · [历史第三轮验收矩阵](../artifacts/validation/round3/acceptance-matrix.md)

## 第二轮证据（历史）

- P1 原包在普通 Windows 桌面人工启动 PASS。同一原包的 Codex 自动化启动原始 FAIL 保留，执行环境结论为 ENVIRONMENT_BLOCKED。其余生命周期验收待独立运行。
- P2 源码包含 Main 内部登录、Session 级请求桥接、所有权绑定准入及媒体出网边界。真实 Next + Windows Node 夹具通过基本登录和准入，真实 Electron renderer、Worker 和媒体请求验证分别记录。
- P3 并行实现现代/旧版历史身份迁移和下载任务隔离。真实 Windows 最终落盘与重启对账仍有独立验收门槛。
- Next 15.5.29 为本轮同系列安全补丁。Electron 保持已锁定版本。生产审计剩余 PostCSS 需按 F-005 跟踪。

[第二轮验收索引](../artifacts/validation/round2/manifest.md) · [人工启动与原始日志](../artifacts/validation/round2/p1-manual.md) · [构建和验收脚本](../desktop/README.md)

## 第二轮验收快照（历史）

- Windows x64 验收包已构建并复核 EXE 与 ASAR 校验值。自动启动首轮仍为 0x80000003，后续真实 GUI 用例受执行环境阻断。
- 最终包 Next 15.5.29 的真实路由与 Session mock 集成测试通过。Web 483 项回归、TypeScript、lint 和 Windows standalone 构建通过，实际 Docker 容器尚待验证。
- 1 GiB 原生暂存及 SHA-256 夹具通过。原子落盘返回 EPERM，持久下载清单和重启对账仍待完成。

[构建清单](../artifacts/validation/desktop-xcTakE/resource-manifest.json) · [第二轮矩阵](../artifacts/validation/round2/acceptance-matrix.md)

## 第三轮起点

继续 codex/libretv-desktop，第二轮提交 6249429b3972555e7b7ac789aa63ea40f9cbe7bb。用户在普通 Windows 桌面实际运行 desktop-xcTakE。EXE 启动、免密码入首页、首页渲染及打开设置均为人工 PASS。未配置点播源，因此源添加、搜索和播放为 NOT RUN。

[第二轮包人工验收](../artifacts/validation/round3/second-round-manual.md)
## 第三轮验收包（2026-11-24）

- 源码提交 `e7bbbdb771807b4fe05fa92f335e78b8668cca47`，Windows x64 包 `artifacts/validation/desktop-ZxYrB9/dist/win-unpacked`。应用 2.19.7、Next.js 15.5.29、Electron 44.9.3。EXE SHA-256 `7cc8b2661673748f38263243c2348c00acff4e0faaa9a067831e17f93f09fc3b`。
- P1 两次独立 Windows 原生构建 PASS，源码和锁文件摘要相同。第三轮实际启动首轮记录 FAIL，进程以 `0x80000003` 退出且无 Main 日志。当前环境用同版本最小 Electron 再现同一结果，整体验收标为 ENVIRONMENT_BLOCKED，其余生命周期用例 NOT RUN。第二轮人工启动、自动登录、首页和设置 PASS。
- P2 安全会话按需恢复，显式退出保持登出，桌面请求读取限额、超时、回压与 API 文档隔离已落地。12 项网关测试和包内代码摘要确认通过。真实 renderer Worker、浏览器凭据 canary 与强杀接管仍待验收。
- P3 落盘支持硬链接不可用的 Windows 同目录无覆盖提交，持久化下载清单、租约、崩溃对账与错误提示。13 项原生测试通过。1 GiB 最终文件回读 SHA-256 一致，Node 峰值 RSS 增量约 40.2 MiB。生产下载夹具保存的 TS/MP4 均能解码。实际 EXE 下载及收藏、历史、播放进度跨重启待验证。
- P4 单测 490 项、ESLint、TypeScript、原始配置的 Web standalone 构建和登录 API 冒烟通过。历史点播源 22 条隔离导入通过，真实源 HTTP 测活受 DNS 公网校验阻塞。合成媒体输入及下载输出文件可解码，真实播放器交互未运行。Docker Linux 引擎在当前环境不可用。
- P5 最终包真实 Next 运行时副本通过 32 路并发 256 次请求，暖态请求 p99 92.79 ms。测试前后 11,039 文件摘要一致。非管理员 Program Files、真实 Electron 主进程、UI/IPC 及长流混合负载仍待验收。
- P6 生产依赖审计 FAIL，嵌套 PostCSS 8.4.31 仍在包中。实际构建加载，已测生产路径的 CommonJS 跟踪为零，可达性评估 PARTIAL。当前交付是未签名本地验收包。
- 证据入口 `artifacts/validation/round3/acceptance-matrix.md`、`manifest.md`、`findings-status.md`。独立 v3 历史结论维持 BLOCKED / LIMITED。
