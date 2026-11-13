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

## 本分支：rustdesk-server

### 文件
- `docker/run-rustdesk-server.sh`：当前线上 hbbs/hbbr 容器启动命令
- `systemd/`：官方 OSS 版 hbbs/hbbr 的 systemd 单元（已停用，仅作回滚保留）
- `keys/id_ed25519.pub`：服务器公钥（私钥不在仓库）
- `docs/Pro-to-OSS-MIGRATION.md`：Pro → OSS 迁移记录

### 为什么用 Docker
官方 OSS hbbs 不响应客户端登录后的 secure_tcp 握手（`Failed to secure tcp: deadline has elapsed`）。
现用 iget-master/rustdesk-server 的 secure-tcp 补丁版（官方代码 drop-in 替换），发布物为 Docker OCI 镜像且需 glibc 2.29，
服务器为 CentOS 7（glibc 2.17），因此 `docker load` 后以 host 网络容器运行。

镜像获取（服务器直连 GitHub 慢时用加速镜像）：
```
curl -sL -o rs.tar.gz 'https://gh-proxy.com/https://github.com/iget-master/rustdesk-server/releases/download/v1.1.17-secure-tcp.3/rustdesk-server-secure-tcp.tar.gz'
docker load -i rs.tar.gz   # 镜像标签 rustdesk-server:secure-tcp
```

### 数据
`/opt/rustdesk-server/bin/` 下：`db_v2.sqlite3`（OSS 设备注册库）、`id_ed25519`（私钥）、`id_ed25519.pub`（公钥），
容器以 `-v /opt/rustdesk-server/bin:/data -w /data` 挂载，故公钥与设备库保持不变。

### 回滚
旧 systemd 单元（见 systemd/）配合 `bin.bak.20261110` 备份可回退到官方 OSS 版。
