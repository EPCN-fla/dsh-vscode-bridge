# DSH 0.2.1 RC 兼容记录

本次为外部插件源码兼容迁移与 Web 配置导入，插件版本保持 0.3.0；未发布、未打标签。源码基线为 a260974，执行期间保留维护者在分支 `0.4.0` 新增的 f124de6 文档提交。

## 来源与范围

DSH checkout `/home/chenmingyu/deepseek-harness` 仅执行只读 Git 和源码查询，未切换 tag、安装依赖或写入该目录。隔离依赖、运行时和测试副本保存在插件工作区 `.sandbox/`（忽略提交）。

| 版本 | tag 对应 commit |
|---|---|
| 0.2.0-rc.2 | 639ed015397290b3745d163aafe02ffee4aa3f84 |
| 0.2.1-rc.1 | 1600d8a1e140dcde43a1a0941940a0480712c011 |
| 0.2.1-rc.2 | 687f282e8625c6b8d11ff58211a90524be2e4317 |

两段 merge-base 均等于起点，未发生基线漂移。已有技能版本卡未覆盖本走廊，结论来自准确 tag 的净差异和发布包。第一段包含 1477 个非合并提交；本报告仅审计桥接实际消费面，不是整个 DSH 的外部 API 审计。rc.1 → rc.2 的源码变化集中于 Web Search/Fetch 和客户端显示，未改动桥接消费的服务实现。

## 结论与接口核对

| 接口 | 目标变化 | 处理 |
|---|---|---|
| Cordis | 4.0.4 → 4.0.5，DSH 包 peer 要求 ~4.0.5 | 开发依赖精确对齐 ~4.0.5，插件 peer 保留 ^4.0.2；旧版本测试使用 ~4.0.4 |
| Session | `SESSION_FORMAT_VERSION` 仍为 4；新增 ignorable plugin records | 桥接继续透传所订阅事件，不自行解析新 payload |
| `sessions.list/get`、session/created、session/event | 消费签名未变 | 保留原调用 |
| `agents.get`、Agent.ctx | 消费签名未变 | 保留原调用 |
| `sessionPersistence.list/stat/open` | Snapshot 增加可选 formatStatus | 原 header、read/close 调用保持有效 |
| `sessionTitle.get/rename` | provider 生命周期与生成输入变化，消费方法未变 | 不接入 provider 内部 |
| `workspaceRegistry` / Workspace | 既有目录缺失时保留成员；消费方法未变 | 使用宿主 membership 结果 |
| `agentPresets.list/defaultId/composedPreset/select` | 挂载 revision 查找重构；空白会话重复选择当前 revision 不再重复写事件 | 直接透传宿主选择结果，不自行写选择事件 |
| commands / permission-presets / skill | 消费实现未变（删除 invariant 文件不影响调用） | 保留原调用 |
| session-log-export | 消费的 Host API 未变 | 延迟解析，保持可选能力 |
| `profileContext` | home、dir、patchPath、installAnchor 保持；新增 readBundlePatches | 版本探测不变，导入从 launcher facts 定位 |
| Profile patches | 保留标准 id override / insert 与 `!!js` | 复用宿主 parse、compose、dump，避免另实现 YAML 方言 |

一手路径：`packages/core/session/src/{index,types}.ts`、`packages/core/agent/src/runtime-types.ts`、`packages/session/session-persistence/src/index.ts`、`packages/session/session-title/src/index.ts`、`packages/workspace/workspace/src/{index,entity}.ts`、`packages/preset/agent-preset-registry/src/index.ts`、`packages/boot/app-boot/src/{index,profile,profile-context}.ts`、`vendor/include/src/index.ts`、`vendor/cordis/package.json`。使用 `git diff <from> <to> -- <path>` 与 `git show <tag>:<path>` 核对。

## Reverts

`b173f3e2a2` 撤回中间 alpha 的 preset-scoped profile patches（`{ preset, insert }`）；rc 目标仍以普通 Host 行和完整 agent-preset 声明组合。本插件不采用被撤回语法。后续 `a8e9e9b546` 为该回退的修正。其他 revert 涉及 DeepSeek 显示名、Web 基准、Agent Team 归属，不命中桥接消费面。没有因中间 alpha 的新增能力而迁移后又回退的代码。

## 七类触点

| 类别 | 命中与验证范围 |
|---|---|
| 源码补丁 | 不命中；不改 DSH，profile patch 是配置组合 |
| 事件 | session/created、session/event；原有推送测试 |
| 服务 / Remote | 原生服务调用与错误转译；类型检查及 RPC 测试 |
| 宿主文件 | discovery、ZIP；新增 profile 导入，验证来源不变、备份和冲突 |
| UI / commands / tools | 原生 command.list/run；插件本身没有 Web 客户端 |
| 自定义通道 | token 鉴权 TCP、连接关闭及卸载；新方法沿用同一鉴权 |
| 子进程 / 输出 | 插件生产代码不启动子进程；隔离验证进程单独记录 |

## 验证基线

Node v22.23.1、pnpm 11.7.0。原 0.2.0-rc.2 锁文件状态运行 `pnpm run typecheck && pnpm test && pnpm run build` 全过，51 项测试，既有失败豁免为空。切换 0.2.1-rc.2 后原 51 项测试仍通过。开发依赖对齐后 `pnpm peers check` 无问题。

CI 在 Node 22/24 下分别选择 0.1.7-rc.1、0.2.0-rc.1、0.2.0-rc.2、0.2.1-rc.1、0.2.1-rc.2；每个 job 独立安装一致 cohort 并执行类型检查、测试、构建和产物消费。CI 配置不是已执行证据；本地结果在交付记录中列出。

## 最终验证与阶段账本

最终源码在五组一致 DSH 开发依赖下均通过 `pnpm run typecheck`、`pnpm test`（64 项）、`pnpm run build`，退出码全部 0；主工作区 `pnpm peers check` 无冲突。原有 51 项测试之外，新增导入、鉴权与发现文件并发/停止回归。发现文件并发回归在修复前以 rename ENOENT 失败，修复后通过；真实 ACP 新建会话后的 EOF 退出发现文件残留也已修复。

| DSH | typecheck / 64 tests / build | 同一 tarball 的真实 ACP 验证 | 本地结果 |
|---|---|---|---|
| 0.1.7-rc.1 | 全过 | 全过 | [结果](<../.sandbox/smoke-home-boxk3Q/result.json>) |
| 0.2.0-rc.1 | 全过 | 全过 | [结果](<../.sandbox/smoke-home-hrr9nx/result.json>) |
| 0.2.0-rc.2 | 全过 | 全过 | [结果](<../.sandbox/smoke-home-x79C7C/result.json>) |
| 0.2.1-rc.1 | 全过 | 全过 | [结果](<../.sandbox/smoke-home-eejPKD/result.json>) |
| 0.2.1-rc.2 | 全过 | 全过 | [结果](<../.sandbox/smoke-home-SD2rcK/result.json>) |

本地结果位于忽略提交的隔离目录；干净 checkout 可使用 [验证脚本](<../scripts/runtime-smoke.mjs>) 重建。持久化预期为 [协议快照](<../tests/fixtures/config-import.expected.json>)。脚本执行真实 `dsh --profile bridge-test`（非 Web 替代服务器），安装 tarball 后校验宿主版本、bridge 版本与 token 拒绝；预览并导入；断言来源文件逐字不变；重启后断言所有导入预设无 broken、自定义模型出现在 ACP `session/new` 的 configOptions、活会话切换预设成功；两次 EOF 退出都为 0，发现文件均删除。该配置功能专用链路不调用真实 LLM，不等同于一次真实模型推理成功。

同 payload 控制产物 SHA-256：`bdd81ee15f5e1290ea5fb2e1da36c1350cdecfeee9a78972d39e6d1ac53da033`，名称为 `dsh-vscode-bridge-0.3.0.tgz`，仅位于隔离目录，用于测试、未发布。内容检查包括全部运行时 JS、声明文件、README 和 LICENSE；未收录源码、沙箱、凭据或 session 数据。后续纯文档修订不改变该产物的运行时代码。

工作流为 `compatibility-migration`；保留 `dsh-audit`（限定插件消费面）、`touchpoint-scan`、`static-tests`、`functional-probe`、`rollback`，并增加产物消费验证。阶段结果：

| 阶段 | 能力 | Owner | 状态 | 证据或边界 |
|---|---|---|---|---|
| P01 | discovery | plugin-workflow | completed | 来源 SHA、包管理器、源码与安装身份分开记录 |
| P02 | dsh-audit | dsh-upgrade-audit | completed | 准确 tag 的插件消费面比对、revert 核对；不是全宿主审计 |
| P03 | touchpoint-scan | plugin-upgrade | completed | 七类触点表 |
| P04 | source-migration | plugin-upgrade | completed | 版本依赖/CI 与兼容文档；旧支持范围保留 |
| P04b | config-import | plugin-write | completed | Web → 当前 profile 的预览、导入、备份、原子写入 |
| P05 | static-tests | plugin-test | completed | 五 cohort 各 64 项全过；types/build 全过 |
| P06 | docker-smoke | plugin-test | blocked | 环境未提供 Docker；没有伪称容器通过 |
| P07 | functional-probe | plugin-test | completed | 替代方式：隔离 HOME/DSH_HOME、五精确 npm CLI 的原生 Node 冷启动 |
| P08 | rollback | plugin-upgrade | completed | 本地提交可逆；目标 patch 逐字备份 |
| P09 | package-artifact | plugin-release | completed | 打包检查、同产物五宿主消费、协议快照 |
| — | browser-check | plugin-test | not_applicable | 本插件没有 Web Client；VS Code UI 未修改 |
| — | registry/release | plugin-release | skipped | 未选命名查询/注册，未推送/打 tag/发布 |

未验证：Windows/macOS、Node 24 本地执行、外部真实模型 API、任意第三方预设的额外 Host 服务依赖。CI 声明 Node 22/24 静态矩阵，并在 Node 22 为五宿主运行该精确版本 smoke；本地没有执行 GitHub Actions。

### 复现

在全新隔离目录创建仅依赖 `@deepseek-ai/dsh@<exact-version>` 的 package，执行 `pnpm install --ignore-scripts`，不要更新全局 dsh 或修改真实用户 profile。然后从插件仓库执行：

```sh
pnpm run typecheck
pnpm test
pnpm pack --pack-destination .sandbox/artifacts
node scripts/runtime-smoke.mjs .sandbox/runtime-rc2 .sandbox/artifacts/dsh-vscode-bridge-0.3.0.tgz
```

`runtime-rc2` 内应已安装精确的 `0.2.1-rc.2`，脚本会核对安装版本等于依赖声明。另一个目标使用隔离的 rc.1 安装目录。测试 profile 每次新建，不复用真实 Web 配置，不传入用户 API key；所有临时 profile 均留在工作区 `.sandbox/`，便于检查，不纳入提交。

## 回滚

本次提交均为本地原子化约定式提交，可按逆序 `git revert <commit>`，不回退维护者的 f124de6。运行时配置导入返回的 `backupPath` 是目标 patch 的逐字备份；停止目标 profile 后恢复该文件并重启。导入没有修改 Web 来源、安装包、用户环境文件或凭据仓库。
