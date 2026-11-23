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
