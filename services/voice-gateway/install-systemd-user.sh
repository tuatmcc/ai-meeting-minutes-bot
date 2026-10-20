#!/usr/bin/env bash
set -euo pipefail

service_name=ai-meeting-minutes-voice-gateway.service
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/../.." && pwd)"
gateway_dir="$repo_root/services/voice-gateway"
config_home="${XDG_CONFIG_HOME:-$HOME/.config}"
state_home="${XDG_STATE_HOME:-$HOME/.local/state}"
config_dir="$config_home/ai-meeting-minutes-voice-gateway"
env_file="$config_dir/production.env"
recordings_dir="$state_home/ai-meeting-minutes-voice-gateway/recordings"
unit_dir="$config_home/systemd/user"
unit_file="$unit_dir/$service_name"

if [[ "$(uname -s)" != Linux ]]; then
	printf 'This installer requires Linux with systemd.\n' >&2
	exit 1
fi

if ! command -v systemctl >/dev/null 2>&1; then
	printf 'systemctl was not found. Install or enable systemd before registering this service.\n' >&2
	exit 1
fi

if ! command -v node >/dev/null 2>&1; then
	printf 'Node.js 22.12 or newer is required.\n' >&2
	exit 1
fi

node_bin="$(command -v node)"
node_version="$("$node_bin" --version)"
if [[ ! "$node_version" =~ ^v([0-9]+)\.([0-9]+)\. ]]; then
	printf 'Could not determine the Node.js version from %s.\n' "$node_version" >&2
	exit 1
fi
node_major="${BASH_REMATCH[1]}"
node_minor="${BASH_REMATCH[2]}"
if ((node_major < 22 || (node_major == 22 && node_minor < 12))); then
	printf 'Node.js 22.12 or newer is required; found %s.\n' "$node_version" >&2
	exit 1
fi

if ! command -v pnpm >/dev/null 2>&1; then
	printf 'pnpm is required to install the gateway dependencies.\n' >&2
	exit 1
fi

if [[ ! -f "$env_file" ]]; then
	mkdir -p "$config_dir"
	chmod 700 "$config_dir"
	install -m 600 "$gateway_dir/production.env.example" "$env_file"
	cat <<EOF
Created $env_file from the production template.
Fill in DISCORD_BOT_TOKEN, WORKER_API_URL, WORKER_API_TOKEN, and WORKER_CONTROL_TOKEN,
then run this installer again.
EOF
	exit 0
fi

missing=()
for variable in DISCORD_BOT_TOKEN WORKER_API_URL WORKER_API_TOKEN WORKER_CONTROL_TOKEN; do
	if ! grep -Eq "^${variable}=[^[:space:]].*$" "$env_file"; then
		missing+=("$variable")
	fi
done
if grep -Fqx 'WORKER_API_URL=https://<worker-host>' "$env_file"; then
	missing+=(WORKER_API_URL)
fi
if ((${#missing[@]} > 0)); then
	printf 'Set these required values in %s: %s\n' "$env_file" "$(printf '%s ' "${missing[@]}")" >&2
	exit 1
fi

mkdir -p "$config_dir" "$recordings_dir" "$unit_dir"
chmod 700 "$config_dir" "$recordings_dir"
chmod 600 "$env_file"

pnpm install --frozen-lockfile --filter @ai-meeting-minutes/voice-gateway...

escape_unit_value() {
	local value="$1"
	value="${value//\\/\\\\}"
	value="${value//\"/\\\"}"
	value="${value//%/%%}"
	printf '"%s"' "$value"
}

escape_unit_path() {
	local value="$1"
	value="${value//%/%%}"
	printf '%s' "$value"
}

temporary_unit="$(mktemp "$unit_dir/.${service_name}.XXXXXX")"
trap 'rm -f "$temporary_unit"' EXIT
cat >"$temporary_unit" <<EOF
[Unit]
Description=AI Meeting Minutes Voice Gateway
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$(escape_unit_path "$gateway_dir")
EnvironmentFile=$(escape_unit_path "$env_file")
Environment=NODE_ENV=production
Environment=RECORDINGS_DIR=$(escape_unit_value "$recordings_dir")
ExecStart=$(escape_unit_value "$node_bin") --experimental-transform-types src/index.ts
Restart=on-failure
RestartSec=5s
TimeoutStopSec=2min
KillSignal=SIGTERM

[Install]
WantedBy=default.target
EOF

install -m 644 "$temporary_unit" "$unit_file"
systemctl --user daemon-reload
systemctl --user enable "$service_name"
if ! systemctl --user start "$service_name"; then
	systemctl --user status "$service_name" --no-pager -l >&2 || true
	exit 1
fi
if ! systemctl --user is-active --quiet "$service_name"; then
	printf 'The service did not become active. Check its logs with journalctl --user -u %s.\n' "$service_name" >&2
	exit 1
fi

printf 'Enabled %s.\n' "$service_name"
printf 'Check status: systemctl --user status %s\n' "$service_name"
printf 'Follow logs: journalctl --user -u %s -f\n' "$service_name"
