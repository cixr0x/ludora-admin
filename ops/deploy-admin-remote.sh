#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

CURRENT_STEP="initialize"
EXPECTED_COMMIT=""
REQUESTED_COMPONENT="auto"
ASSET_MARKER_BASE64=""
ADMIN_CHECKOUT=""
ORIGIN_URL=""
PUBLIC_HOST=""
EXPECTED_USER=""
ALLOW_DATABASE_PATCH_PRESENCE="false"
INITIALIZE_DEPLOYMENT_BASELINE="false"
PREVIOUS_COMMIT=""
LAST_SUCCESSFUL_COMMIT=""
CHANGE_BASE=""
RESOLVED_COMPONENT="verify"
UI_BACKUP_DIR=""

on_error() {
  local exit_code=$?
  if [[ "$BASHPID" == "$$" ]]; then
    printf 'DEPLOY_STATUS=failed\n' >&2
    printf 'FAILED_STEP=%s\n' "$CURRENT_STEP" >&2
    printf 'FAILED_EXIT_CODE=%s\n' "$exit_code" >&2
  fi
  exit "$exit_code"
}
trap on_error ERR

die() {
  local message=$1
  local exit_code=${2:-1}
  printf 'DEPLOY_STATUS=failed\n' >&2
  printf 'FAILED_STEP=%s\n' "$CURRENT_STEP" >&2
  printf 'ERROR=%s\n' "$message" >&2
  exit "$exit_code"
}

step() {
  CURRENT_STEP=$1
  printf 'DEPLOY_STEP=%s\n' "$CURRENT_STEP"
}

while (($# > 0)); do
  case "$1" in
    --expected-commit)
      EXPECTED_COMMIT=$2
      shift 2
      ;;
    --component)
      REQUESTED_COMPONENT=$2
      shift 2
      ;;
    --asset-marker-base64)
      ASSET_MARKER_BASE64=$2
      shift 2
      ;;
    --admin-checkout)
      ADMIN_CHECKOUT=$2
      shift 2
      ;;
    --origin-url)
      ORIGIN_URL=$2
      shift 2
      ;;
    --public-host)
      PUBLIC_HOST=$2
      shift 2
      ;;
    --expected-user)
      EXPECTED_USER=$2
      shift 2
      ;;
    --allow-database-patch-presence)
      ALLOW_DATABASE_PATCH_PRESENCE="true"
      shift
      ;;
    --initialize-deployment-baseline)
      INITIALIZE_DEPLOYMENT_BASELINE="true"
      shift
      ;;
    *)
      die "Unknown argument '$1'." 64
      ;;
  esac
done

[[ "$EXPECTED_COMMIT" =~ ^[0-9a-f]{40}$ ]] || die "Expected commit must be a full lowercase SHA." 64
[[ "$REQUESTED_COMPONENT" =~ ^(auto|ui|service|discovery|full)$ ]] || die "Invalid component '$REQUESTED_COMPONENT'." 64
[[ "$ADMIN_CHECKOUT" =~ ^/[A-Za-z0-9._/-]+$ ]] || die "Invalid admin checkout path." 64
[[ "$PUBLIC_HOST" =~ ^[A-Za-z0-9.-]+$ ]] || die "Invalid public host." 64
[[ "$EXPECTED_USER" =~ ^[A-Za-z0-9._-]+$ ]] || die "Invalid expected user." 64
[[ -n "$ORIGIN_URL" ]] || die "Origin URL is required." 64

step "preflight.tools"
for required_command in awk base64 curl flock git grep mv node npm rm sed sleep ss stat sudo; do
  command -v "$required_command" >/dev/null || die "Required command '$required_command' is unavailable." 69
done

[[ "$(id -un)" == "$EXPECTED_USER" ]] || die "Deployment is running as unexpected user '$(id -un)'." 77
[[ -d "$ADMIN_CHECKOUT/.git" ]] || die "Admin checkout '$ADMIN_CHECKOUT' is missing." 66

exec 9>"$ADMIN_CHECKOUT/.git/ludora-production-deploy.lock"
flock -n 9 || die "Another Ludora deployment holds the remote lock." 75
success_state_file="$ADMIN_CHECKOUT/.git/ludora-production-deploy.success"

step "preflight.repository"
[[ "$(git -C "$ADMIN_CHECKOUT" branch --show-current)" == "main" ]] || die "Remote checkout is not on main." 65
[[ "$(git -C "$ADMIN_CHECKOUT" remote get-url origin)" == "$ORIGIN_URL" ]] || die "Remote origin does not match the pinned repository." 65

tracked_status=$(git -C "$ADMIN_CHECKOUT" status --porcelain --untracked-files=no)
[[ -z "$tracked_status" ]] || die "Remote checkout has tracked changes; nothing was overwritten." 65

untracked_count=$(git -C "$ADMIN_CHECKOUT" ls-files --others --exclude-standard | awk 'NF { count += 1 } END { print count + 0 }')
printf 'REMOTE_UNTRACKED_COUNT=%s\n' "$untracked_count"

for required_file in \
  "$ADMIN_CHECKOUT/ludora-admin-service/.env" \
  "$ADMIN_CHECKOUT/ludora-admin-ui/.env.production" \
  "$ADMIN_CHECKOUT/ludora-discovery/.env"; do
  [[ -f "$required_file" && ! -L "$required_file" ]] || die "Required configuration '$required_file' must be a regular file, not a symlink." 66
  relative_file=${required_file#"$ADMIN_CHECKOUT/"}
  if git -C "$ADMIN_CHECKOUT" ls-files --error-unmatch "$relative_file" >/dev/null 2>&1; then
    die "Production configuration '$relative_file' is tracked by Git." 77
  fi
  git -C "$ADMIN_CHECKOUT" check-ignore -q "$relative_file" || die "Production configuration '$relative_file' is not ignored by Git." 77
  file_owner_mode=$(stat -c '%U:%a' "$required_file")
  [[ "$file_owner_mode" == "$EXPECTED_USER:600" ]] || die "Production configuration '$relative_file' must be owned by $EXPECTED_USER with mode 600; found '$file_owner_mode'." 77
done

step "preflight.fetch"
git -C "$ADMIN_CHECKOUT" fetch --prune origin main
PREVIOUS_COMMIT=$(git -C "$ADMIN_CHECKOUT" rev-parse HEAD)
origin_commit=$(git -C "$ADMIN_CHECKOUT" rev-parse refs/remotes/origin/main)
[[ "$origin_commit" == "$EXPECTED_COMMIT" ]] || die "Fetched origin/main '$origin_commit' differs from expected '$EXPECTED_COMMIT'." 65
git -C "$ADMIN_CHECKOUT" merge-base --is-ancestor "$PREVIOUS_COMMIT" "$EXPECTED_COMMIT" || die "Expected commit is not a fast-forward from remote HEAD '$PREVIOUS_COMMIT'." 65

baseline_valid="false"
force_full="false"
if [[ -f "$success_state_file" ]]; then
  IFS= read -r LAST_SUCCESSFUL_COMMIT <"$success_state_file" || true
fi

if [[ "$LAST_SUCCESSFUL_COMMIT" =~ ^[0-9a-f]{40}$ ]] \
  && git -C "$ADMIN_CHECKOUT" cat-file -e "$LAST_SUCCESSFUL_COMMIT^{commit}" 2>/dev/null \
  && git -C "$ADMIN_CHECKOUT" merge-base --is-ancestor "$LAST_SUCCESSFUL_COMMIT" "$PREVIOUS_COMMIT" \
  && git -C "$ADMIN_CHECKOUT" merge-base --is-ancestor "$LAST_SUCCESSFUL_COMMIT" "$EXPECTED_COMMIT"; then
  baseline_valid="true"
  CHANGE_BASE="$LAST_SUCCESSFUL_COMMIT"
else
  CHANGE_BASE="$PREVIOUS_COMMIT"
  LAST_SUCCESSFUL_COMMIT=""
  printf 'DEPLOYMENT_BASELINE_STATUS=missing_or_invalid\n'
  if [[ "$INITIALIZE_DEPLOYMENT_BASELINE" != "true" ]]; then
    die "No trustworthy successful-deployment baseline exists. Verify the current deployment, then rerun with --initialize-deployment-baseline to force a full rebuild." 43
  fi
  if [[ "$REQUESTED_COMPONENT" != "auto" && "$REQUESTED_COMPONENT" != "full" ]]; then
    die "Baseline initialization requires component auto or full." 64
  fi
  force_full="true"
fi

mapfile -t changed_paths < <(git -C "$ADMIN_CHECKOUT" diff --name-only "$CHANGE_BASE" "$EXPECTED_COMMIT")
database_paths=()
has_ui="false"
has_service="false"
has_discovery="false"
has_unknown_runtime="false"
discovery_dependencies_changed="false"

for changed_path in "${changed_paths[@]}"; do
  case "$changed_path" in
    ludora-admin-ui/*)
      has_ui="true"
      ;;
    ludora-admin-service/*)
      has_service="true"
      ;;
    ludora-discovery/*)
      has_discovery="true"
      ;;
    docs/*|ops/*|chrome-extension/*|database/*|AGENTS.md|README.md|.gitattributes|.gitignore)
      ;;
    *)
      has_unknown_runtime="true"
      ;;
  esac
  if [[ "$changed_path" == "ludora-discovery/pyproject.toml" ]]; then
    discovery_dependencies_changed="true"
  fi
  if [[ "$changed_path" =~ ^database/.*\.sql$ ]]; then
    database_paths+=("$changed_path")
  fi
done

if [[ "$force_full" == "true" ]]; then
  discovery_dependencies_changed="true"
fi

if ((${#database_paths[@]} > 0)); then
  printf 'DATABASE_PATCHES_DETECTED=%s\n' "$(IFS=,; printf '%s' "${database_paths[*]}")"
  if [[ "$ALLOW_DATABASE_PATCH_PRESENCE" != "true" ]]; then
    die "Database SQL changes require separate review and explicit approval; no SQL was executed." 42
  fi
  printf 'DATABASE_PATCH_PRESENCE_ACKNOWLEDGED=true\n'
fi

if [[ "$LAST_SUCCESSFUL_COMMIT" == "$EXPECTED_COMMIT" && "$PREVIOUS_COMMIT" == "$EXPECTED_COMMIT" && "$REQUESTED_COMPONENT" == "auto" ]]; then
  RESOLVED_COMPONENT="verify"
elif [[ "$force_full" == "true" && "$REQUESTED_COMPONENT" == "auto" ]]; then
  RESOLVED_COMPONENT="full"
elif [[ "$REQUESTED_COMPONENT" != "auto" ]]; then
  RESOLVED_COMPONENT="$REQUESTED_COMPONENT"
  if [[ "$REQUESTED_COMPONENT" != "full" && "$has_unknown_runtime" == "true" ]]; then
    die "Explicit component '$REQUESTED_COMPONENT' is narrower than unclassified runtime changes." 64
  fi
  if [[ "$REQUESTED_COMPONENT" == "ui" && ("$has_service" == "true" || "$has_discovery" == "true") ]]; then
    die "Explicit UI deployment is narrower than detected service/discovery changes." 64
  fi
  if [[ "$REQUESTED_COMPONENT" == "service" && ("$has_ui" == "true" || "$has_discovery" == "true") ]]; then
    die "Explicit service deployment is narrower than detected UI/discovery changes." 64
  fi
  if [[ "$REQUESTED_COMPONENT" == "discovery" && ("$has_ui" == "true" || "$has_service" == "true") ]]; then
    die "Explicit discovery deployment is narrower than detected UI/service changes." 64
  fi
else
  if [[ "$has_unknown_runtime" == "true" ]]; then
    RESOLVED_COMPONENT="full"
    component_count=-1
  else
  component_count=0
  [[ "$has_ui" == "true" ]] && ((component_count += 1))
  [[ "$has_service" == "true" ]] && ((component_count += 1))
  [[ "$has_discovery" == "true" ]] && ((component_count += 1))
  case "$component_count" in
    0) RESOLVED_COMPONENT="verify" ;;
    1)
      if [[ "$has_ui" == "true" ]]; then
        RESOLVED_COMPONENT="ui"
      elif [[ "$has_service" == "true" ]]; then
        RESOLVED_COMPONENT="service"
      else
        RESOLVED_COMPONENT="discovery"
      fi
      ;;
    *) RESOLVED_COMPONENT="full" ;;
  esac
  fi
fi
printf 'RESOLVED_COMPONENT=%s\n' "$RESOLVED_COMPONENT"
printf 'PREVIOUS_COMMIT=%s\n' "$PREVIOUS_COMMIT"
printf 'LAST_SUCCESSFUL_COMMIT=%s\n' "${LAST_SUCCESSFUL_COMMIT:-none}"
printf 'CHANGE_BASE=%s\n' "$CHANGE_BASE"

step "deploy.fast_forward"
git -C "$ADMIN_CHECKOUT" merge --ff-only "$EXPECTED_COMMIT"
[[ "$(git -C "$ADMIN_CHECKOUT" rev-parse HEAD)" == "$EXPECTED_COMMIT" ]] || die "Remote HEAD did not reach expected commit." 65

run_ui() {
  step "deploy.ui"
  local ui_dir="$ADMIN_CHECKOUT/ludora-admin-ui"
  local staging_dir="$ui_dir/.dist-deploy-$EXPECTED_COMMIT"
  local backup_dir="$ui_dir/.dist-before-$EXPECTED_COMMIT"
  local displaced_dir="$ui_dir/.dist-displaced-$EXPECTED_COMMIT"

  remove_ui_temp_dir() {
    local path=$1
    case "$path" in
      "$ui_dir"/.dist-*) rm -rf -- "$path" ;;
      *) die "Refusing to remove unexpected UI deployment path '$path'." 70 ;;
    esac
  }

  remove_ui_temp_dir "$staging_dir"
  (
    cd "$ui_dir"
    npm ci
    npm test -- --testTimeout=60000 --hookTimeout=60000
    npm run build -- --outDir "$staging_dir" --emptyOutDir
  )
  [[ -f "$staging_dir/index.html" ]] || die "Staged UI build did not produce index.html." 70

  remove_ui_temp_dir "$displaced_dir"
  if [[ -e "$ui_dir/dist" || -L "$ui_dir/dist" ]]; then
    if [[ ! -e "$backup_dir" && ! -L "$backup_dir" ]]; then
      mv -- "$ui_dir/dist" "$backup_dir"
      UI_BACKUP_DIR="$backup_dir"
    else
      mv -- "$ui_dir/dist" "$displaced_dir"
      UI_BACKUP_DIR="$backup_dir"
    fi
  fi

  if ! mv -- "$staging_dir" "$ui_dir/dist"; then
    if [[ -e "$displaced_dir" || -L "$displaced_dir" ]]; then
      mv -- "$displaced_dir" "$ui_dir/dist"
    elif [[ -e "$backup_dir" || -L "$backup_dir" ]]; then
      mv -- "$backup_dir" "$ui_dir/dist"
      UI_BACKUP_DIR=""
    fi
    die "Failed to activate staged UI build." 70
  fi
  if [[ -e "$displaced_dir" || -L "$displaced_dir" ]]; then
    remove_ui_temp_dir "$displaced_dir"
  fi
}

run_service() {
  step "deploy.service"
  (
    cd "$ADMIN_CHECKOUT/ludora-admin-service"
    npm ci
    npm test
    npm run build
  )
}

run_discovery() {
  step "deploy.discovery"
  (
    cd "$ADMIN_CHECKOUT/ludora-discovery"
    if [[ "$discovery_dependencies_changed" == "true" ]]; then
      .venv/bin/python -m pip install -e .
      .venv/bin/python -m playwright install chromium
    fi
    .venv/bin/python -m unittest discover -s tests -v
  )
}

case "$RESOLVED_COMPONENT" in
  ui)
    run_ui
    ;;
  service)
    run_service
    step "deploy.restart_admin_service"
    sudo -n systemctl restart ludora-admin-service.service
    ;;
  discovery)
    run_discovery
    step "deploy.restart_admin_service"
    sudo -n systemctl restart ludora-admin-service.service
    ;;
  full)
    run_discovery
    run_service
    run_ui
    step "deploy.restart_admin_service"
    sudo -n systemctl restart ludora-admin-service.service
    step "deploy.reload_nginx"
    sudo -n systemctl reload nginx.service
    ;;
  verify)
    ;;
  *)
    die "Resolved unexpected component '$RESOLVED_COMPONENT'." 70
    ;;
esac

retry_curl() {
  local url=$1
  local attempt
  for attempt in {1..10}; do
    if curl -fsS --max-time 10 "$url" >/dev/null; then
      return 0
    fi
    sleep 2
  done
  return 1
}

step "verify.services"
sudo -n systemctl is-active --quiet ludora-admin-service.service
sudo -n systemctl is-active --quiet codexapi.service
sudo -n systemctl is-active --quiet nginx.service
retry_curl "http://127.0.0.1:3001/health"
retry_curl "http://127.0.0.1:4001/health"
sudo -n nginx -t
nginx_config=$(sudo -n nginx -T 2>&1)
grep -Fq "root $ADMIN_CHECKOUT/ludora-admin-ui/dist;" <<<"$nginx_config" || die "Effective nginx config does not serve the pinned admin UI dist path." 70
grep -Fq 'proxy_pass http://127.0.0.1:4001/;' <<<"$nginx_config" || die "Effective nginx config does not proxy the admin API to 127.0.0.1:4001." 70
if grep -Eq 'proxy_pass[[:space:]]+http://(127\.0\.0\.1:)?3001' <<<"$nginx_config"; then
  die "Effective nginx config exposes codexapi through a proxy." 70
fi

listeners=$(sudo -n ss -ltnp)
grep -Eq '127\.0\.0\.1:3001([[:space:]]|$)' <<<"$listeners" || die "codexapi is not listening on 127.0.0.1:3001." 70
grep -Eq '127\.0\.0\.1:4001([[:space:]]|$)' <<<"$listeners" || die "admin service is not listening on 127.0.0.1:4001." 70
if grep -Eq '(^|[[:space:]])(0\.0\.0\.0|\*|\[::\]):(3001|4001)([[:space:]]|$)' <<<"$listeners"; then
  die "A private service is listening on a public interface." 70
fi

step "verify.public"
https_status=$(curl -sS --max-time 20 -o /dev/null -w '%{http_code}' "https://$PUBLIC_HOST/")
[[ "$https_status" == "200" ]] || die "HTTPS UI returned '$https_status', expected 200." 70
curl -fsS --max-time 20 "https://$PUBLIC_HOST/api/health" >/dev/null
IFS=' ' read -r redirect_status redirect_url < <(curl -sS --max-time 20 -o /dev/null -w '%{http_code} %{redirect_url}\n' "http://$PUBLIC_HOST/")
[[ "$redirect_status" =~ ^30[1278]$ ]] || die "HTTP endpoint returned '$redirect_status', expected a redirect." 70
[[ "$redirect_url" == https://$PUBLIC_HOST/* ]] || die "HTTP redirect target '$redirect_url' is unexpected." 70

step "verify.authenticated_read_only"
(
  cd "$ADMIN_CHECKOUT/ludora-admin-service"
  PUBLIC_API_BASE="https://$PUBLIC_HOST/api" \
  node --input-type=module <<'NODE'
import dotenv from 'dotenv';
dotenv.config({ path: '.env', quiet: true });

const base = process.env.PUBLIC_API_BASE;
if (!base) process.exit(1);
const login = await fetch(`${base}/admin/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  signal: AbortSignal.timeout(20000),
  body: JSON.stringify({
    username: process.env.ADMIN_USERNAME,
    password: process.env.ADMIN_PASSWORD
  })
});
const setCookie = login.headers.get('set-cookie') ?? '';
const cookie = setCookie.split(';', 1)[0];
console.log(`AUTH_LOGIN_STATUS=${login.status}`);
console.log(`AUTH_SECURE_COOKIE=${/;\s*secure/i.test(setCookie) && /;\s*httponly/i.test(setCookie)}`);
if (!login.ok || !cookie || !/;\s*secure/i.test(setCookie) || !/;\s*httponly/i.test(setCookie)) {
  process.exit(1);
}

const stores = await fetch(`${base}/stores?page=1&page_size=1`, {
  headers: { cookie },
  signal: AbortSignal.timeout(20000)
});
console.log(`AUTH_STORES_STATUS=${stores.status}`);
if (!stores.ok) process.exit(1);
NODE
)

if [[ -n "$ASSET_MARKER_BASE64" ]]; then
  step "verify.asset_marker"
  asset_marker=$(printf '%s' "$ASSET_MARKER_BASE64" | base64 --decode)
  [[ -n "$asset_marker" ]] || die "Decoded asset marker is empty." 64
  grep -R -q -F -- "$asset_marker" "$ADMIN_CHECKOUT/ludora-admin-ui/dist/assets" || die "Asset marker is absent from the activated local bundle." 70

  served_index=$(curl -fsS --max-time 20 "https://$PUBLIC_HOST/")
  mapfile -t served_assets < <(printf '%s' "$served_index" | grep -oE 'src="[^"]+\.js"' | sed -E 's/^src="|"$//g')
  ((${#served_assets[@]} > 0)) || die "Served index does not reference a JavaScript asset." 70
  marker_served="false"
  for served_asset in "${served_assets[@]}"; do
    if [[ "$served_asset" =~ ^https?:// ]]; then
      served_asset_url="$served_asset"
    elif [[ "$served_asset" == /* ]]; then
      served_asset_url="https://$PUBLIC_HOST$served_asset"
    else
      served_asset_url="https://$PUBLIC_HOST/$served_asset"
    fi
    served_asset_body=$(curl -fsS --max-time 20 "$served_asset_url")
    if grep -q -F -- "$asset_marker" <<<"$served_asset_body"; then
      marker_served="true"
      break
    fi
  done
  [[ "$marker_served" == "true" ]] || die "Asset marker is not present in any JavaScript asset served over HTTPS." 70
  printf 'SERVED_ASSET_MARKER=found\n'
fi

step "verify.repository"
[[ "$(git -C "$ADMIN_CHECKOUT" rev-parse HEAD)" == "$EXPECTED_COMMIT" ]] || die "Final remote HEAD changed unexpectedly." 70
final_tracked_status=$(git -C "$ADMIN_CHECKOUT" status --porcelain --untracked-files=no)
[[ -z "$final_tracked_status" ]] || die "Deployment left tracked worktree changes." 70

if [[ -n "$UI_BACKUP_DIR" && (-e "$UI_BACKUP_DIR" || -L "$UI_BACKUP_DIR") ]]; then
  case "$UI_BACKUP_DIR" in
    "$ADMIN_CHECKOUT/ludora-admin-ui"/.dist-*) rm -rf -- "$UI_BACKUP_DIR" ;;
    *) die "Refusing to remove unexpected UI backup path '$UI_BACKUP_DIR'." 70 ;;
  esac
fi

step "verify.record_success"
success_state_temp="$success_state_file.$$"
printf '%s\n' "$EXPECTED_COMMIT" >"$success_state_temp"
mv -f -- "$success_state_temp" "$success_state_file"

printf 'REMOTE_DEPLOY_STATUS=success\n'
printf 'REMOTE_DEPLOY_RESULT={"status":"success","component":"%s","previousCommit":"%s","commit":"%s"}\n' \
  "$RESOLVED_COMPONENT" "$PREVIOUS_COMMIT" "$EXPECTED_COMMIT"
