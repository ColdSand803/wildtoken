#!/usr/bin/env bash
# 用一份备份替换 wildtoken 的数据库。
#
#   scripts/restore.sh .backup/wildtoken-20261104-050000.db
#   YES=1 scripts/restore.sh <备份>     不问，直接换
#
# 会停掉容器，正在跑的请求被切断。换下来的库留在数据卷里，名为
# wildtoken.db.before-restore-<时间>，要退回就把它改回 wildtoken.db。
#
# 备份里的凭证是用当时的密钥加密的：数据卷里的 wildtoken.key 或
# ENCRYPTION_KEY 得还是那一把，否则服务拒绝启动，脚本会报出来。
set -euo pipefail
cd "$(dirname "$0")/.."

SERVICE=wildtoken
log() { printf '[restore] %s %s\n' "$(date +%H:%M:%S)" "$*"; }

backup=${1:-}
if [ -z "$backup" ] || [ ! -f "$backup" ]; then
	echo "用法：scripts/restore.sh <备份文件>"
	exit 1
fi
# SQLite 文件以这 15 个字节开头（第 16 个是 NUL）。
[ "$(head -c 15 "$backup")" = "SQLite format 3" ] || { log "$backup 不是 SQLite 数据库"; exit 1; }
backup="$(cd "$(dirname "$backup")" && pwd)/$(basename "$backup")"

id=$(docker compose ps -aq "$SERVICE")
[ -n "$id" ] || { log "找不到容器，先部署一次"; exit 1; }
volume=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' "$id")
[ -n "$volume" ] || { log "容器没有挂 /data 卷"; exit 1; }
# 用容器自己的镜像做拷贝：版本一致，sh 和 cp 都在。
image=$(docker inspect -f '{{.Image}}' "$id")

if [ "${YES:-0}" != 1 ]; then
	printf '停掉 %s，用 %s 替换数据库？[y/N] ' "$SERVICE" "$(basename "$backup")"
	read -r answer
	case $answer in y | Y) ;; *) log "没换"; exit 1 ;; esac
fi

log "停容器"
docker compose stop "$SERVICE" >/dev/null

# 连同 -wal 一起改名：被强杀过的库，最后的事务还在 WAL 里。
stamp=$(date +%Y%m%d-%H%M%S)
log "换库，原库留作 wildtoken.db.before-restore-$stamp"
docker run --rm -v "$volume":/data -v "$backup":/restore.db:ro --entrypoint sh "$image" -c '
	set -e
	for suffix in "" -wal -shm; do
		if [ -e "/data/wildtoken.db$suffix" ]; then
			mv "/data/wildtoken.db$suffix" "/data/wildtoken.db.before-restore-$0$suffix"
		fi
	done
	cp /restore.db /data/wildtoken.db
	chmod 600 /data/wildtoken.db' "$stamp"

log "起容器"
if ! docker compose up -d --no-build --wait --wait-timeout 120 "$SERVICE" >/dev/null 2>&1; then
	log "容器没起来："
	docker compose logs --tail 20 "$SERVICE"
	log "退回：把卷里的 wildtoken.db.before-restore-$stamp 改回 wildtoken.db 再起容器"
	exit 1
fi
log "完成：$(docker compose logs --since 3m "$SERVICE" 2>&1 | grep -o 'credentials sealed at rest.*' | tail -1)"
