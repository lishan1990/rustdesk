#!/bin/sh
# 2026-11-13 线上 hbbs/hbbr 启动命令（secure-tcp 版，host 网络）
# 数据目录 /opt/rustdesk-server/bin 必须已存在，内含 id_ed25519(.pub) 与 db_v2.sqlite3
set -e
docker run -d --name rustdesk-hbbs --restart unless-stopped --network host \
  -w /data -v /opt/rustdesk-server/bin:/data \
  rustdesk-server:secure-tcp hbbs -k _ -r 182.44.6.48:21117
docker run -d --name rustdesk-hbbr --restart unless-stopped --network host \
  -w /data -v /opt/rustdesk-server/bin:/data \
  rustdesk-server:secure-tcp hbbr -k _
docker ps --format '{{.Names}} {{.Status}}' | grep rustdesk
