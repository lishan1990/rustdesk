# 2026-11-10 服务端切换 Pro -> OSS

- 原因: Pro hbbs 1.8.7 license 门控间歇性拒绝连接（未配置 license 却偶发 'license expired or invalid'）。
- 变更: hbbs/hbbr/rustdesk-utils 替换为官方 OSS 1.1.16（GitHub rustdesk/rustdesk-server）。
  systemd 单元去掉 Pro 特有 --bind 参数；hbbs 加 -k _ 仅允许持正确公钥客户端注册。
- 保留: id_ed25519 密钥对不变 → 客户端无需重装；Pro 数据备份在 /opt/rustdesk-server/bin.pro-backup。
- 失去: 21114 Pro 控制台（客户端账号登录/地址簿/审计同步/在线状态）。定制客户端编译系统在 dashboard(21120)，不受影响。
- dashboard 适配: /api/devices 改读 db_v2.sqlite3(peer 表，created_at 为最近注册时间)；checkpoint 每 30s 在线合并 db_v2 WAL；withDbWrite 不再停启 hbbs。
- 回退: 恢复 bin.pro-backup 三个二进制 + systemd ExecStart 加回 --bind 0.0.0.0 + daemon-reload + restart。
