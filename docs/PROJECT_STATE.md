# LibreTV Desktop Project State

项目 LIBRETV-DESKTOP-WIN。基线分支 codex/libretv-desktop。上一轮冻结提交 b51510544abad106af32350c2410a928fcc373c0。方案 B 继续使用，历史 v3 独立审查仍为 BLOCKED / LIMITED。

## 最新证据

- P1 原包在普通 Windows 桌面人工启动 PASS。同一原包的 Codex 自动化启动原始 FAIL 保留，执行环境结论为 ENVIRONMENT_BLOCKED。其余生命周期验收待独立运行。
- P2 源码包含 Main 内部登录、Session 级请求桥接、所有权绑定准入及媒体出网边界。真实 Next + Windows Node 夹具通过基本登录和准入，真实 Electron renderer、Worker 和媒体请求验证分别记录。
- P3 并行实现现代/旧版历史身份迁移和下载任务隔离。真实 Windows 最终落盘与重启对账仍有独立验收门槛。
- Next 15.5.29 为本轮同系列安全补丁。Electron 保持已锁定版本。生产审计剩余 PostCSS 需按 F-005 跟踪。

[第二轮验收索引](../artifacts/validation/round2/manifest.md) · [人工启动与原始日志](../artifacts/validation/round2/p1-manual.md) · [构建和验收脚本](../desktop/README.md)

## 最终验收快照

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
