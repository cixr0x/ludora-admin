#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

SCRIPT_UNDER_TEST=${1:?Pass the absolute path to deploy-admin-remote.sh}
[[ -f "$SCRIPT_UNDER_TEST" ]] || { printf 'Missing script: %s\n' "$SCRIPT_UNDER_TEST" >&2; exit 2; }

TEST_ROOT=$(mktemp -d /tmp/ludora-deploy-test.XXXXXX)
cleanup() {
  case "$TEST_ROOT" in
    /tmp/ludora-deploy-test.*) rm -rf -- "$TEST_ROOT" ;;
    *) printf 'Refusing to remove unexpected test path: %s\n' "$TEST_ROOT" >&2 ;;
  esac
}
trap cleanup EXIT

ORIGIN_REPO="$TEST_ROOT/origin.git"
SEED_REPO="$TEST_ROOT/seed"
REMOTE_REPO="$TEST_ROOT/remote"
FAKE_BIN="$TEST_ROOT/bin"
CALL_LOG="$TEST_ROOT/calls.log"
FAIL_ONCE_FLAG="$TEST_ROOT/ui-build-failed-once"

git init --bare --initial-branch=main "$ORIGIN_REPO" >/dev/null
git init --initial-branch=main "$SEED_REPO" >/dev/null
git -C "$SEED_REPO" config user.name 'Deploy Test'
git -C "$SEED_REPO" config user.email 'deploy-test@example.invalid'
git -C "$SEED_REPO" remote add origin "$ORIGIN_REPO"

mkdir -p \
  "$SEED_REPO/ludora-admin-ui/src" \
  "$SEED_REPO/ludora-admin-service/src" \
  "$SEED_REPO/ludora-discovery/src" \
  "$SEED_REPO/database/patches"
printf '.env\n.env.production\n' >"$SEED_REPO/.gitignore"
printf 'initial ui\n' >"$SEED_REPO/ludora-admin-ui/src/app.txt"
printf 'initial service\n' >"$SEED_REPO/ludora-admin-service/src/server.txt"
printf 'initial discovery\n' >"$SEED_REPO/ludora-discovery/src/worker.txt"
git -C "$SEED_REPO" add .
git -C "$SEED_REPO" commit -m 'Initial fixture' >/dev/null
git -C "$SEED_REPO" push -u origin main >/dev/null 2>&1
INITIAL_COMMIT=$(git -C "$SEED_REPO" rev-parse HEAD)

git clone "$ORIGIN_REPO" "$REMOTE_REPO" >/dev/null 2>&1
git -C "$REMOTE_REPO" config user.name 'Deploy Test'
git -C "$REMOTE_REPO" config user.email 'deploy-test@example.invalid'
printf 'service env\n' >"$REMOTE_REPO/ludora-admin-service/.env"
printf 'ui env\n' >"$REMOTE_REPO/ludora-admin-ui/.env.production"
printf 'discovery env\n' >"$REMOTE_REPO/ludora-discovery/.env"
chmod 600 \
  "$REMOTE_REPO/ludora-admin-service/.env" \
  "$REMOTE_REPO/ludora-admin-ui/.env.production" \
  "$REMOTE_REPO/ludora-discovery/.env"
mkdir -p "$REMOTE_REPO/ludora-discovery/.venv/bin"
cat >"$REMOTE_REPO/ludora-discovery/.venv/bin/python" <<'FAKE_PYTHON'
#!/usr/bin/env bash
set -u
printf 'python:%s:%s\n' "$PWD" "$*" >>"$CALL_LOG"
exit 0
FAKE_PYTHON
chmod +x "$REMOTE_REPO/ludora-discovery/.venv/bin/python"

printf 'changed ui\n' >"$SEED_REPO/ludora-admin-ui/src/app.txt"
git -C "$SEED_REPO" add ludora-admin-ui/src/app.txt
git -C "$SEED_REPO" commit -m 'Change UI fixture' >/dev/null
git -C "$SEED_REPO" push origin main >/dev/null 2>&1
UI_COMMIT=$(git -C "$SEED_REPO" rev-parse HEAD)

mkdir -p "$FAKE_BIN"
cat >"$FAKE_BIN/npm" <<'FAKE_NPM'
#!/usr/bin/env bash
set -u
printf 'npm:%s:%s\n' "$PWD" "$*" >>"$CALL_LOG"
if [[ "$PWD" == */ludora-admin-ui && "$*" == run\ build* && ! -f "$FAIL_ONCE_FLAG" ]]; then
  : >"$FAIL_ONCE_FLAG"
  exit 23
fi
if [[ "$PWD" == */ludora-admin-ui && "$*" == run\ build* ]]; then
  arguments=("$@")
  for ((index = 0; index < ${#arguments[@]}; index += 1)); do
    if [[ "${arguments[$index]}" == '--outDir' ]]; then
      output_dir=${arguments[$((index + 1))]}
      mkdir -p "$output_dir/assets"
      printf '<script type="module" src="/assets/index-test.js"></script>\n' >"$output_dir/index.html"
      printf '%s\n' "${TEST_ASSET_MARKER:-fixture}" >"$output_dir/assets/index-test.js"
    fi
  done
fi
exit 0
FAKE_NPM

cat >"$FAKE_BIN/curl" <<'FAKE_CURL'
#!/usr/bin/env bash
set -u
arguments=" $* "
last_argument=${!#}
if [[ "$arguments" == *'%{redirect_url}'* ]]; then
  printf '301 https://admin.example.invalid/\n'
elif [[ "$arguments" == *'%{http_code}'* ]]; then
  printf '200'
elif [[ "$last_argument" == 'https://admin.example.invalid/' ]]; then
  printf '<script type="module" src="/assets/index-test.js"></script>\n'
elif [[ "$last_argument" == 'https://admin.example.invalid/assets/index-test.js' ]]; then
  printf '%s\n' "$TEST_ASSET_MARKER"
fi
exit 0
FAKE_CURL

cat >"$FAKE_BIN/node" <<'FAKE_NODE'
#!/usr/bin/env bash
cat >/dev/null
printf 'AUTH_LOGIN_STATUS=200\nAUTH_SECURE_COOKIE=true\nAUTH_STORES_STATUS=200\n'
FAKE_NODE

cat >"$FAKE_BIN/sudo" <<'FAKE_SUDO'
#!/usr/bin/env bash
set -u
[[ "${1:-}" == '-n' ]] && shift
case "${1:-}" in
  systemctl) exit 0 ;;
  nginx)
    if [[ "${2:-}" == '-T' ]]; then
      printf 'root %s/ludora-admin-ui/dist;\n' "$REMOTE_REPO"
      printf 'proxy_pass http://127.0.0.1:4001/;\n'
    fi
    exit 0
    ;;
  ss)
    printf 'LISTEN 0 511 127.0.0.1:3001 0.0.0.0:*\n'
    printf 'LISTEN 0 511 127.0.0.1:4001 0.0.0.0:*\n'
    exit 0
    ;;
  *) exec "$@" ;;
esac
FAKE_SUDO

chmod +x "$FAKE_BIN/npm" "$FAKE_BIN/curl" "$FAKE_BIN/node" "$FAKE_BIN/sudo"
export PATH="$FAKE_BIN:$PATH"
export CALL_LOG FAIL_ONCE_FLAG REMOTE_REPO
export TEST_ASSET_MARKER='served-marker'

printf '%s\n' "$INITIAL_COMMIT" >"$REMOTE_REPO/.git/ludora-production-deploy.success"

common_arguments=(
  --component auto
  --asset-marker-base64 ''
  --admin-checkout "$REMOTE_REPO"
  --origin-url "$ORIGIN_REPO"
  --public-host admin.example.invalid
  --expected-user "$(id -un)"
)

set +e
first_output=$(bash "$SCRIPT_UNDER_TEST" --expected-commit "$UI_COMMIT" "${common_arguments[@]}" 2>&1)
first_exit=$?
set -e
[[ "$first_exit" == '23' ]] || { printf '%s\n' "$first_output" >&2; exit 1; }
grep -Fq 'FAILED_STEP=deploy.ui' <<<"$first_output"
[[ "$(git -C "$REMOTE_REPO" rev-parse HEAD)" == "$UI_COMMIT" ]]
[[ "$(<"$REMOTE_REPO/.git/ludora-production-deploy.success")" == "$INITIAL_COMMIT" ]]

second_output=$(bash "$SCRIPT_UNDER_TEST" --expected-commit "$UI_COMMIT" "${common_arguments[@]}" 2>&1)
grep -Fq 'RESOLVED_COMPONENT=ui' <<<"$second_output"
grep -Fq 'REMOTE_DEPLOY_STATUS=success' <<<"$second_output"
[[ "$(<"$REMOTE_REPO/.git/ludora-production-deploy.success")" == "$UI_COMMIT" ]]
[[ "$(grep -c 'ludora-admin-ui:run build' "$CALL_LOG")" == '2' ]]
! grep -Fq 'ludora-admin-service' "$CALL_LOG"

mkdir -p "$SEED_REPO/unexpected-runtime"
printf 'runtime change\n' >"$SEED_REPO/unexpected-runtime/config.txt"
git -C "$SEED_REPO" add unexpected-runtime/config.txt
git -C "$SEED_REPO" commit -m 'Add unknown runtime fixture' >/dev/null
git -C "$SEED_REPO" push origin main >/dev/null 2>&1
UNKNOWN_COMMIT=$(git -C "$SEED_REPO" rev-parse HEAD)
marker_base64=$(printf '%s' "$TEST_ASSET_MARKER" | base64 --wrap=0)
unknown_output=$(bash "$SCRIPT_UNDER_TEST" --expected-commit "$UNKNOWN_COMMIT" --component auto --asset-marker-base64 "$marker_base64" "${common_arguments[@]:4}" 2>&1)
grep -Fq 'RESOLVED_COMPONENT=full' <<<"$unknown_output"
grep -Fq 'SERVED_ASSET_MARKER=found' <<<"$unknown_output"
[[ "$(<"$REMOTE_REPO/.git/ludora-production-deploy.success")" == "$UNKNOWN_COMMIT" ]]

exec 8>"$REMOTE_REPO/.git/ludora-production-deploy.lock"
flock -n 8
set +e
lock_output=$(bash "$SCRIPT_UNDER_TEST" --expected-commit "$UNKNOWN_COMMIT" "${common_arguments[@]}" 2>&1)
lock_exit=$?
set -e
flock -u 8
exec 8>&-
[[ "$lock_exit" == '75' ]] || { printf '%s\n' "$lock_output" >&2; exit 1; }
grep -Fq 'Another Ludora deployment holds the remote lock.' <<<"$lock_output"

rm -f -- "$REMOTE_REPO/.git/ludora-production-deploy.success"
set +e
baseline_output=$(bash "$SCRIPT_UNDER_TEST" --expected-commit "$UNKNOWN_COMMIT" "${common_arguments[@]}" 2>&1)
baseline_exit=$?
set -e
[[ "$baseline_exit" == '43' ]] || { printf '%s\n' "$baseline_output" >&2; exit 1; }
grep -Fq 'DEPLOYMENT_BASELINE_STATUS=missing_or_invalid' <<<"$baseline_output"

initialize_output=$(bash "$SCRIPT_UNDER_TEST" --expected-commit "$UNKNOWN_COMMIT" --initialize-deployment-baseline "${common_arguments[@]}" 2>&1)
grep -Fq 'RESOLVED_COMPONENT=full' <<<"$initialize_output"
grep -Fq 'REMOTE_DEPLOY_STATUS=success' <<<"$initialize_output"
[[ "$(<"$REMOTE_REPO/.git/ludora-production-deploy.success")" == "$UNKNOWN_COMMIT" ]]

printf 'select 1;\n' >"$SEED_REPO/database/patches/999-test.sql"
git -C "$SEED_REPO" add database/patches/999-test.sql
git -C "$SEED_REPO" commit -m 'Add SQL fixture' >/dev/null
git -C "$SEED_REPO" push origin main >/dev/null 2>&1
SQL_COMMIT=$(git -C "$SEED_REPO" rev-parse HEAD)

set +e
sql_output=$(bash "$SCRIPT_UNDER_TEST" --expected-commit "$SQL_COMMIT" "${common_arguments[@]}" 2>&1)
sql_exit=$?
set -e
[[ "$sql_exit" == '42' ]] || { printf '%s\n' "$sql_output" >&2; exit 1; }
grep -Fq 'DATABASE_PATCHES_DETECTED=database/patches/999-test.sql' <<<"$sql_output"
[[ "$(git -C "$REMOTE_REPO" rev-parse HEAD)" == "$UNKNOWN_COMMIT" ]]
[[ "$(<"$REMOTE_REPO/.git/ludora-production-deploy.success")" == "$UNKNOWN_COMMIT" ]]

printf 'REMOTE_DEPLOY_TESTS=passed\n'
