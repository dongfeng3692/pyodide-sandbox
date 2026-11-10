# API 回归套件(pyodide-sandbox)

按契约冻结的 HTTP 回归测试:每个错误分支、每个策略预设、每条资源限制都有
稳定 ID 的用例。改完代码跑 `npm run test:server` 即回归(全量 140 条(PKG 组为可注入依赖清单),
暖缓存约 90s)。

```bash
npm run test:server                                  # 全量
node packages/server/test/regression/run.mjs --filter POL   # 只跑一组/ID 前缀
node packages/server/test/regression/run.mjs --list        # 列出用例清单
```

## 运行方式(与旧套件的差别)

- **临时服务隔离**:每个 profile 一个真实服务实例(pyodide 池 + HTTP),
  随机端口 + OS 临时目录 SQLite,跑完自动清理。绝不接触 8787 开发服务
  与 `data/sbx.db`。
- **顺序执行、失败不中断**:用例间通过 profile 的 `state` 传递状态
  (AUTH 建的令牌 EXEC/POL 直接复用);单用例 60s 硬超时;任一失败退出码
  非零,报告按组小计并列出失败详情。
- **自播种**:依赖历史数据的用例(ADM 组的 metrics/logs 断言)自己先
  制造流量,`--filter ADM` 单独跑也成立。

## profile(harness.mjs `PATCHES`)

| profile | 要点 | 服务对象 |
|---|---|---|
| `main` | 默认 general,池 2 | INFRA/AUTH(令牌)/EXEC/POL/SEC/ADM/PERS/AGENT |
| `tight` | raw 预设 + 紧限制(超时 1.5s、maxQueue 1、code 1000B、result 1KB、stdout 64、文件 2/64B、body 64KB) | VAL/LIM/EXEC(stdout、超限) |
| `strict` / `minimal` | 对应预设,池 1 | PRESET |
| `recycle` | raw,recycleAfter 2(recycle 单独成档:放 tight 会每两案换一次 worker,毒化 LIM-001 的排队时序) | LIM-004 |
| `account` | 不做 bootstrap(首跑 setup/登录/锁定用例自己驱动;锁定用例会废掉 admin,必须留在组末) | AUTH 后半 |
| `mcp` | general,池 1(单 worker:跨调用状态复原用例必须落到同一 worker) | MCP / SEC-006..008 |
| `packages` | 依赖清单三通道全开:stdlib json/re + 仓库 wheels/ 的 openpyxl(pin 3.1.5) | PKG(清单生效/校验/重启应用/描述同步;在线安装路径不出网,纯逻辑在 installer.test.mjs) |

通用覆盖:所有 profile 的 `rssLimitMb` 提到 2048——pandas worker 实际
RSS 逼近默认 512MB,会触发 RSS 回收让每隔一个用例多付 ~10s 的 pyodide
重启,破坏确定性(真机监控页可见 ~400MB/worker)。

## 用例规范

- **ID = `组-序号`(如 `POL-007`),永不复用**。删除用例留空洞,不补位;
  引用用例(报告、commit、issue)一律用 ID。
- 用例是 `{ id, profile, title, run(ctx) }`;断言直接用
  `node:assert/strict`,失败信息由 runner 前缀用例 ID。
- `ctx`:`exec(body, token?)`(默认 profile 令牌,`null` 不带)、
  `admin(method, path, body?, {cookie?})`(默认 bootstrap 会话)、
  `fetch(path, opts)`(裸 fetch)、`state`(profile 内共享)、
  `pool`/`base`(restart 后自动跟随)、`sleep`。
- 时序敏感的用例看 LIM 组的注释:超时从**提交**起算(排队任务含排队时间);
  worker 换新是异步的,轮询 `/admin/api/metrics` 的 `pool.workers[].id`
  (注意字段名是 `id` = threadId)。

## 已知不覆盖(挂账)

- `pool_degraded` / `shutting_down` / `pool_boot_timeout`(需要注入故障,
  现有 profile 无法自然触发)
- `store_unavailable` 降级(需要 node:sqlite 不可用的环境)
- RSS 回收路径(`rss_recycle` 事件)与 `dbRetentionHours` 清扫
- strict-data 的 `nonlocal`(模块层非合法语法,包一层 def 又先撞
  functiondef 禁令)
- stdoutMode `discard`(无对应 profile,如需可给某 profile 加
  `output.stdoutMode`)

## 排障

- **boot 卡死/超时**:先看 G 盘(仓库所在盘)是否写满——pyodide worker
  启动要写缓存目录元数据,磁盘 100% 满时静默挂死,表现是
  `pool_boot_timeout` 且 worker 无任何输出(2026-11-05 实测)。
- 首跑会把 Pyodide 包下载进 `pkg-cache/`(约 8MB),CI 用 `SBX_CACHE_DIR`
  指向缓存;本地默认 `./pkg-cache`(相对仓库根)。
