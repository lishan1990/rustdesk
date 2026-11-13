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

## 本分支：rustdesk-api

### 文件
- `conf/config.yaml`：线上配置（ID/中继/API 地址、公钥；无密码等敏感项）
- `systemd/rustdesk-api.service`：systemd 单元
- 二进制 `apimain`、`data/rustdeskapi.db`、`resources/` 静态资源不在仓库（体积大/含运行时数据）

### 部署
1. 下载 lejianwen/rustdesk-api v2.7 的 `linux-amd64.tar.gz` 解压到 `/opt/rustdesk-api/release`（服务器直连 GitHub 慢时经 gh-proxy.com 镜像）
2. 把本分支 `conf/config.yaml` 放到 `conf/`，`systemd/rustdesk-api.service` 放到 `/etc/systemd/system/`
3. `systemctl daemon-reload && systemctl enable --now rustdesk-api`
4. 首次启动会生成随机管理员密码，用 `./apimain reset-admin-pwd <密码>` 重置；密码只保存在服务器本地，不写入仓库

### 说明
- Web 管理台：`http://<服务器>:21114/_admin/`
- 客户端登录接口：`/api/login`、`/api/login-options`；注册默认关闭（`app.register: false`），用户由管理台创建
- `key` 必须与 hbbs 的 `id_ed25519.pub` 一致
