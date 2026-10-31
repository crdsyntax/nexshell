use crate::application::cron::CronManager;
use crate::application::pool::PoolManager;
use crate::application::services::shell_quote;
use crate::application::ssh_access::SshAccessManager;
use crate::error::{AppError, AppResult};
use crate::models::{ConnectionProfile, SecurityFixResult};
use std::time::Duration;

const SSHD_DIR: &str = "/etc/ssh/sshd_config.d";
const FIX_TIMEOUT: Duration = Duration::from_secs(90);

pub fn is_fixable(finding_id: &str) -> bool {
    matches!(
        finding_id,
        "ssh-root-login"
            | "ssh-password-auth"
            | "ssh-empty-passwords"
            | "ssh-no-pubkey"
            | "ssh-x11"
            | "ssh-max-auth-tries"
            | "ssh-key-perms"
            | "perms-shadow"
            | "perms-sudoers"
            | "perms-passwd"
            | "world-writable-etc"
            | "suspicious-cron"
            | "public-db-3306"
            | "public-db-6379"
    )
}

pub async fn apply(
    pools: &PoolManager,
    profile: &ConnectionProfile,
    finding_id: &str,
) -> AppResult<SecurityFixResult> {
    if !is_fixable(finding_id) {
        return Err(AppError::Validation(format!(
            "finding '{finding_id}' has no automated remediation"
        )));
    }

    let mut cron_backups = Vec::new();
    let output = match finding_id {
        "ssh-password-auth" => {
            let result = SshAccessManager::set_key_only(pools, profile, true, true).await?;
            if !result.ok {
                return Ok(SecurityFixResult {
                    finding_id: finding_id.to_string(),
                    ok: false,
                    output: result.output,
                    cron_backups,
                });
            }
            result.output
        }
        "ssh-root-login" => {
            let script = sshd_script("permitrootlogin", "PermitRootLogin", "prohibit-password");
            run_fix(pools, profile, &script).await?
        }
        "ssh-empty-passwords" => {
            let script = sshd_script("permitemptypasswords", "PermitEmptyPasswords", "no");
            run_fix(pools, profile, &script).await?
        }
        "ssh-no-pubkey" => {
            let script = sshd_script("pubkeyauthentication", "PubkeyAuthentication", "yes");
            run_fix(pools, profile, &script).await?
        }
        "ssh-x11" => {
            let script = sshd_script("x11forwarding", "X11Forwarding", "no");
            run_fix(pools, profile, &script).await?
        }
        "ssh-max-auth-tries" => {
            let script = sshd_script("maxauthtries", "MaxAuthTries", "3");
            run_fix(pools, profile, &script).await?
        }
        "ssh-key-perms" => {
            let script = r####"set -e
fixed=0
for file in /root/.ssh/authorized_keys /home/*/.ssh/authorized_keys; do
  [ -f "$file" ] || continue
  dir=$(dirname "$file")
  owner=$(stat -c %U "$file")
  group=$(id -gn "$owner" 2>/dev/null || echo "$owner")
  chown "$owner:$group" "$dir" "$file"
  chmod 700 "$dir"
  chmod 600 "$file"
  fixed=$((fixed + 1))
  echo "secured $file ($owner:$group 700/600)"
done
[ "$fixed" -gt 0 ] || { echo "no authorized_keys files found" >&2; exit 1; }
"####;
            run_fix(pools, profile, script).await?
        }
        "perms-shadow" => {
            let script = r####"set -e
chown root:root /etc/shadow
chmod 000 /etc/shadow
stat -c '%a %U:%G %n' /etc/shadow
"####;
            run_fix(pools, profile, script).await?
        }
        "perms-sudoers" => {
            let script = r####"set -e
chown root:root /etc/sudoers
chmod 440 /etc/sudoers
visudo -c >/dev/null
stat -c '%a %U:%G %n' /etc/sudoers
"####;
            run_fix(pools, profile, script).await?
        }
        "perms-passwd" => {
            let script = r####"set -e
chown root:root /etc/passwd
chmod 644 /etc/passwd
stat -c '%a %U:%G %n' /etc/passwd
"####;
            run_fix(pools, profile, script).await?
        }
        "world-writable-etc" => {
            let script = r####"set -e
count=0
for file in $(find /etc -xdev -type f -perm -0002 2>/dev/null); do
  chmod o-w "$file"
  count=$((count + 1))
  echo "removed world-write: $file"
done
if [ "$count" -eq 0 ]; then
  echo "no world-writable files found under /etc"
fi
"####;
            run_fix(pools, profile, script).await?
        }
        "public-db-3306" => {
            let script = r####"set -e
svc=""
for candidate in mariadb mysqld mysql; do
  if systemctl is-active "$candidate" >/dev/null 2>&1; then svc=$candidate; break; fi
done
[ -n "$svc" ] || { echo "no active MariaDB/MySQL service found" >&2; exit 1; }
dropdir=""
for dir in /etc/my.cnf.d /etc/mysql/conf.d /etc/mysql/mariadb.conf.d; do
  [ -d "$dir" ] && { dropdir=$dir; break; }
done
[ -n "$dropdir" ] || { echo "no MariaDB/MySQL config directory found" >&2; exit 1; }
file="$dropdir/99-2shell-bind.cnf"
backup=""
if [ -f "$file" ]; then backup=$(mktemp); cp -p "$file" "$backup"; fi
restore() {
  if [ -n "$backup" ]; then cp -p "$backup" "$file"; else rm -f "$file"; fi
  systemctl restart "$svc" >/dev/null 2>&1 || true
}
printf '%s\n' '# Managed by 2Shell' '[mysqld]' 'bind-address = 127.0.0.1' > "$file"
chmod 644 "$file"
if ! systemctl restart "$svc"; then
  restore
  echo "service $svc failed to start; rolled back" >&2
  exit 1
fi
sleep 2
if ss -ltn 2>/dev/null | awk 'NR>1 {print $4}' | grep -qxE '(0\.0\.0\.0|\[::\]|\*):3306'; then
  restore
  echo "port 3306 is still exposed on all interfaces; rolled back" >&2
  exit 2
fi
echo "$svc now listens on 127.0.0.1 (config: $file)"
"####;
            run_fix(pools, profile, script).await?
        }
        "public-db-6379" => {
            let script = r####"set -e
file=""
for candidate in /etc/redis/redis.conf /etc/redis.conf; do
  [ -f "$candidate" ] && { file=$candidate; break; }
done
[ -n "$file" ] || { echo "redis.conf not found" >&2; exit 1; }
svc=""
for candidate in redis redis-server; do
  if systemctl is-active "$candidate" >/dev/null 2>&1; then svc=$candidate; break; fi
done
[ -n "$svc" ] || { echo "no active redis service found" >&2; exit 1; }
backup=$(mktemp)
cp -p "$file" "$backup"
restore() { cp -p "$backup" "$file"; systemctl restart "$svc" >/dev/null 2>&1 || true; }
sed -i -E 's/^[[:space:]]*bind[[:space:]].*/bind 127.0.0.1 -::1/' "$file"
grep -qx 'bind 127.0.0.1 -::1' "$file" || { echo "could not rewrite the bind directive" >&2; restore; exit 1; }
if ! systemctl restart "$svc"; then restore; echo "redis failed to start; rolled back" >&2; exit 1; fi
sleep 2
if ss -ltn 2>/dev/null | awk 'NR>1 {print $4}' | grep -qxE '(0\.0\.0\.0|\[::\]|\*):6379'; then
  restore
  echo "port 6379 is still exposed; rolled back" >&2
  exit 2
fi
echo "redis now listens on 127.0.0.1 (config: $file)"
"####;
            run_fix(pools, profile, script).await?
        }
        "suspicious-cron" => {
            let result = CronManager::delete_suspicious(pools, profile).await?;
            cron_backups = result.results;
            result.output
        }
        _ => {
            return Err(AppError::Validation(format!(
                "finding '{finding_id}' has no automated remediation"
            )))
        }
    };

    Ok(SecurityFixResult {
        finding_id: finding_id.to_string(),
        ok: true,
        output,
        cron_backups,
    })
}

fn sshd_script(slug: &str, option: &str, value: &str) -> String {
    const TEMPLATE: &str = r####"set -e
dir=__DIR__
file="$dir/00-2shell-__SLUG__.conf"
mkdir -p "$dir"
tmp=$(mktemp)
backup=""
if [ -f "$file" ]; then
  backup=$(mktemp)
  cp -p "$file" "$backup"
fi
restore() {
  if [ -n "$backup" ]; then cp -p "$backup" "$file"; else rm -f "$file"; fi
}
printf '%s\n' '# Managed by 2Shell' '__OPTION__ __VALUE__' > "$file"
chmod 644 "$file"
if ! sshd -t > "$tmp" 2>&1; then
  restore
  cat "$tmp" >&2
  rm -f "$tmp"
  exit 1
fi
effective=$(sshd -T 2>/dev/null | awk -v key='__LOWER__' 'tolower($1) == key { print $2; exit }')
case " __ACCEPT__ " in
  *" $effective "*)
    ;;
  *)
    restore
    echo "sshd kept __OPTION__=${effective:-unknown}; change reverted" >&2
    rm -f "$tmp"
    exit 2
    ;;
esac
rm -f "$tmp"
systemctl reload sshd 2>/dev/null || systemctl reload ssh 2>/dev/null || service sshd reload 2>/dev/null || true
echo "__OPTION__=$effective"
"####;
    TEMPLATE
        .replace("__DIR__", SSHD_DIR)
        .replace("__SLUG__", slug)
        .replace("__LOWER__", &option.to_lowercase())
        .replace("__OPTION__", option)
        .replace("__VALUE__", value)
        .replace("__ACCEPT__", &accepted_values(option, value))
}

fn accepted_values(option: &str, value: &str) -> String {
    match (option.to_lowercase().as_str(), value) {
        ("permitrootlogin", "prohibit-password") => {
            "prohibit-password without-password".to_string()
        }
        _ => value.to_string(),
    }
}

async fn run_fix(
    pools: &PoolManager,
    profile: &ConnectionProfile,
    script: &str,
) -> AppResult<String> {
    let command = as_root(profile, script);
    let output = pools
        .execute_sensitive(&profile.id, &command, FIX_TIMEOUT)
        .await?;
    let combined = format!("{}{}", output.stdout, output.stderr)
        .trim()
        .to_string();
    if !output.success() {
        return Err(AppError::Remote(format!(
            "automatic fix failed: {}",
            if combined.is_empty() {
                format!("exit code {}", output.exit_status)
            } else {
                combined
            }
        )));
    }
    Ok(if combined.is_empty() {
        "fix applied".to_string()
    } else {
        combined
    })
}

fn as_root(profile: &ConnectionProfile, script: &str) -> String {
    if profile.username == "root" {
        script.to_string()
    } else if profile.elevated {
        format!("sudo -n sh -c {}", shell_quote(script))
    } else {
        script.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn whitelists_only_validated_fixes() {
        assert!(is_fixable("ssh-password-auth"));
        assert!(is_fixable("public-db-3306"));
        assert!(is_fixable("suspicious-cron"));
        assert!(!is_fixable("public-db-5432"));
        assert!(!is_fixable("uid-zero"));
        assert!(!is_fixable("ld-preload"));
        assert!(!is_fixable("firewall"));
    }

    #[test]
    fn accepts_sshd_alias_spellings() {
        assert_eq!(
            accepted_values("PermitRootLogin", "prohibit-password"),
            "prohibit-password without-password"
        );
        assert_eq!(accepted_values("X11Forwarding", "no"), "no");
        assert_eq!(accepted_values("MaxAuthTries", "3"), "3");
    }

    #[test]
    fn sshd_script_targets_a_managed_dropin() {
        let script = sshd_script("x11forwarding", "X11Forwarding", "no");
        assert!(script.contains("dir=/etc/ssh/sshd_config.d"));
        assert!(script.contains("00-2shell-x11forwarding.conf"));
        assert!(script.contains("X11Forwarding no"));
        assert!(script.contains("sshd -t"));
        assert!(script.contains("sshd -T"));
        assert!(!script.contains("__"));
    }
}
