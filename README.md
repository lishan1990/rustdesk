# 逍遥远控 · 自建 RustDesk 服务部署代码

本仓库保存自建 RustDesk 服务端的**代码与配置**，按组件分三个独立分支（主分支 master 不受影响）：

| 分支 | 内容 |
|---|---|
| `rustdesk-server` | ID/信令与中继服务（hbbs/hbbr，Docker secure-tcp 版）、systemd 回滚单元、公钥、部署说明 |
| `rustdesk-api` | 客户端登录/地址簿 API 服务（lejianwen/rustdesk-api v2.7）的配置与 systemd 单元 |
| `rustdesk-dashboard` | 自研 Web 管理面板（Node.js，端口 21120）完整源码 |

> 本仓库为**公开仓库**，以下敏感文件一律不上传：`auth.json`（面板账号密码）、`github.json`（GitHub PAT）、`id_ed25519`（服务器私钥）、各类 `*.sqlite3` 数据库/WAL、`rustdeskapi.db`、备份 `.bak*`、可执行文件与 node_modules。部署时请在服务器本地另行创建。

## 服务架构（当前线上状态，2026-11-13）

| 服务 | 运行方式 | 端口 | 版本 |
|---|---|---|---|
| hbbs（ID/信令） | Docker 容器 `rustdesk-hbbs`，host 网络 | 21115/21116(TCP+UDP)/21118 | iget-master/rustdesk-server v1.1.17-secure-tcp.3 |
| hbbr（中继） | Docker 容器 `rustdesk-hbbr`，host 网络 | 21117/21119 | 同上 |
| rustdesk-api | systemd `rustdesk-api` | 21114 | lejianwen/rustdesk-api v2.7 |
| 管理面板 | systemd `rustdesk-dashboard` | 21120 | 自研 Node.js |

服务器公钥：`WcIytNmPq4M3uwX86PG1jEH9irBi5GrDCl8LU0vUFtE=`
（更换 hbbs 版本时保持密钥对不变，客户端才无需重装）

## 相关仓库

客户端定制源码在 `lishan1990/rustdesk-api-server-pro` 的 `rd-client` 分支（云编译工作流 client-build.yml 也在那里）。

## 本分支：rustdesk-dashboard

### 文件
- `server.js`：面板后端（Express，端口 21120）
- `public/app.js`、`index.html`、`login.html`、`styles.css`、`logo.png`：前端
- `package.json` / `package-lock.json`：Node 依赖
- `systemd/rustdesk-dashboard.service`：systemd 单元
- 运行时数据 `auth.json`（登录账号）、`github.json`（PAT + 仓库信息）、`builds/`、`build-history.json`、数据库文件均不在仓库

### 部署
1. `npm ci`（Node 18+，需 `sql.js`；读取 OSS 库用服务器上的 `/opt/sqlite/bin/sqlite3` 命令行，能正确合并 WAL）
2. 创建 `auth.json`：`{"username":"...","password":"..."}`，以及 `github.json`（含 `token`/`repo` 等字段）
3. `systemctl daemon-reload && systemctl enable --now rustdesk-dashboard`

### 功能
设备管理（OSS peer 表、旧 Pro 库回填主机名/系统、改备注）、服务状态（Docker 容器 + systemd 混合检测）、
审计日志/用户列表时区统一、定制客户端云编译（触发 GitHub Actions、下载 MSI 成品、构建历史）、连接参数展示。


## 2026-11-13 更新：定制客户端支持 iOS / 三系统构建

- 「外观 / 其他」→「客户端系统」新增 **iOS 系统（.ipa 安装包）** 单选项。
- 原「双系统构建」改为 **「三系统构建」**：勾选后一次构建 Windows + Android + iOS。
- 后端 `server.js`：`targets` 支持 `ios` / `all`，`workflow_dispatch` 的 `target` 相应传 `ios` 或 `all`，
  下载 `rd-client-ios-arm64` 产物、整理 `.ipa`、打包「三系统客户端.zip」、构建历史新增 `ios` / `all` 标签。
- 云端工作流在 `lishan1990/rustdesk-api-server-pro` 的 `rd-client` 分支
  `.github/workflows/client-build.yml`：新增 `build-rustdesk-ios` job（macos-14 + aarch64-apple-ios + flutter ipa），
  未配置苹果签名材料时产出未签名 .ipa（需自行重签后安装）。
