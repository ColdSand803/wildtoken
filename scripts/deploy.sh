#!/usr/bin/env bash
# 重建并替换 wildtoken 容器，不切断正在跑的请求。
#
# 先构建，旧容器照常服务；等进行中的请求清零再换容器；换完核对健康检查、
# 运行的镜像和控制台 CSP，任一步失败就换回旧镜像。
#
#   scripts/deploy.sh             最多等 600 秒
#   WAIT=60 scripts/deploy.sh     最多等 60 秒，仍有请求就放弃，不换
#   FORCE=1 scripts/deploy.sh     等满仍有请求也换，它们会被切断
#
# 剩下的风险在换容器那一两秒：清零后刚到的请求最多再跑 15 秒
# （requestDrainTimeout），到达时旧容器已停的请求连接失败，由客户端重试。
set -euo pipefail
cd "$(dirname "$0")/.."

SERVICE=wildtoken
WAIT=${WAIT:-600}
FORCE=${FORCE:-0}
log() { printf '[deploy] %s %s\n' "$(date +%H:%M:%S)" "$*"; }

for tool in docker curl; do
	command -v "$tool" >/dev/null || { log "缺少 $tool"; exit 1; }
done

# 备份目录由宿主用户建，备份才归宿主用户（见 docker-compose.yml）。
mkdir -p "${BACKUP_DIR:-.backup}"

image=$(docker compose config --images "$SERVICE")
build_log=$(mktemp -t wildtoken-deploy.XXXXXX)
trap 'rm -f "$build_log"' EXIT

container() { docker compose ps -q "$SERVICE" 2>/dev/null; }

# active 打印正在转发的请求数；说不出来时打印 -1：容器不在跑，或者是没有
# 这个接口的旧版本。
active() {
	local id out
	id=$(container)
	[ -n "$id" ] || { echo -1; return; }
	out=$(docker exec "$id" curl -fsS --max-time 5 http://127.0.0.1:3100/health/active 2>/dev/null) ||
		{ echo -1; return; }
	sed -n 's/.*"active":\([0-9][0-9]*\).*/\1/p' <<<"$out" | grep . || echo -1
}

# fingerprint 是镜像的层和配置。镜像 ID 比不得：BuildKit 每次附上带时间的
# 构建证明，什么都没改也换一个 ID。
fingerprint() { docker image inspect -f '{{json .RootFS.Layers}}{{json .Config}}' "$1" 2>/dev/null; }

# pending 判断该不该换容器：镜像内容或 compose 配置变了，或者容器不在。
pending() {
	local id want
	id=$(container)
	[ -n "$id" ] || return 0
	[ "$(fingerprint "$(docker inspect -f '{{.Image}}' "$id")")" = "$(fingerprint "$built")" ] || return 0
	want=$(docker compose config --hash "$SERVICE" | awk '{print $2}')
	[ "$(docker inspect -f '{{index .Config.Labels "com.docker.compose.config-hash"}}' "$id")" != "$want" ]
}

# verify 在新版本真正接手后通过：健康，跑的是刚构建的镜像（没重建成的话，
# 旧容器一样健康），控制台带着 CSP。
verify() {
	local id health running address headers
	id=$(container)
	[ -n "$id" ] || { log "核对：容器不在"; return 1; }
	health=$(docker inspect -f '{{.State.Health.Status}}' "$id" 2>/dev/null) || health=missing
	[ "$health" = healthy ] || { log "核对：容器 $health"; return 1; }
	running=$(docker inspect -f '{{.Image}}' "$id")
	[ "$running" = "$built" ] || { log "核对：在跑 ${running:7:12}，刚构建 ${built:7:12}"; return 1; }

	address=$(docker compose port "$SERVICE" 3100 | sed 's/^0\.0\.0\.0:/127.0.0.1:/; s/^\[::\]:/127.0.0.1:/')
	curl -fsS -o /dev/null --max-time 5 "http://$address/health" || { log "核对：/health 失败"; return 1; }
	# 先整段读完再匹配：grep -q 中途退出会让 curl 收到 SIGPIPE。
	headers=$(curl -s -D - -o /dev/null --max-time 5 "http://$address/console") || headers=
	grep -qi "^content-security-policy: script-src 'self' 'sha256-" <<<"$headers" ||
		{ log "核对：控制台缺 CSP"; return 1; }
}

rollback() {
	set +e
	trap - ERR
	tail -20 "$build_log"
	if [ "$rollback_ready" != 1 ]; then
		log "失败，且没有旧镜像可换回"
		exit 1
	fi
	log "失败，换回旧镜像"
	docker tag "$image:rollback" "$image:latest"
	docker compose up -d --no-build --force-recreate --wait --wait-timeout 120 "$SERVICE"
	log "换回后：容器 $(docker inspect -f '{{.State.Health.Status}}' "$(container)" 2>/dev/null)"
	exit 1
}

# 换回的是正在跑的镜像，不是 latest：上次构建了却没换上的那个从没核对过。
rollback_ready=0
current=$(container)
if [ -n "$current" ]; then
	docker tag "$(docker inspect -f '{{.Image}}' "$current")" "$image:rollback"
	rollback_ready=1
else
	log "没有在跑的容器，失败时无法换回"
fi
log "构建"
docker compose build "$SERVICE" >"$build_log" 2>&1 || { tail -30 "$build_log"; exit 1; }
built=$(docker image inspect -f '{{.Id}}' "$image:latest")
log "已构建 ${built:7:12}"

if ! pending; then
	log "镜像和配置都没变，不用换"
	exit 0
fi

# 说不出数的不等：旧版本没有这个接口，或者它正是这次要修的问题。
deadline=$(( $(date +%s) + WAIT ))
last=
while :; do
	n=$(active)
	if [ "$n" = -1 ]; then
		log "进行中：未知，直接换"
		break
	fi
	if [ "$n" = 0 ]; then
		log "进行中：0"
		break
	fi
	[ "$n" = "$last" ] || log "进行中：$n，等待"
	last=$n
	if [ "$(date +%s)" -ge "$deadline" ]; then
		if [ "$FORCE" = 1 ]; then
			log "等了 ${WAIT} 秒仍有 $n 个，FORCE=1，照换"
			break
		fi
		log "等了 ${WAIT} 秒仍有 $n 个，放弃，没换；FORCE=1 可强制"
		exit 2
	fi
	sleep 1
done

trap rollback ERR
# --no-build 时 compose 看不出镜像换了，照旧留着老容器，所以强制重建；走到
# 这里，pending 已经确认有变化。不接管道：up 失败要落到 ERR。
docker compose up -d --no-build --force-recreate --wait --wait-timeout 120 "$SERVICE" >>"$build_log" 2>&1
for i in $(seq 1 12); do
	verify && break
	[ "$i" = 12 ] && false
	sleep 5
done
trap - ERR
log "完成 ${built:7:12}"
