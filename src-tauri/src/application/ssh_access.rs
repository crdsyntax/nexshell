use crate::application::pool::PoolManager;
use crate::application::services::shell_quote;
use crate::error::{AppError, AppResult};
use crate::models::{ConnectionProfile, SshActionResult, SshConfig, SshKey};
use russh::keys::ssh_key::{HashAlg, PublicKey};
use std::time::Duration;

const SSHD_DROPIN: &str = "/etc/ssh/sshd_config.d/00-2shell-key-only.conf";
const KEY_TIMEOUT: Duration = Duration::from_secs(30);

pub struct SshAccessManager;

impl SshAccessManager {
    pub async fn keys(pools: &PoolManager, profile: &ConnectionProfile) -> AppResult<Vec<SshKey>> {
        let script = r####"export LC_ALL=C 2>/dev/null
echo __KEYS__
for f in /root/.ssh/authorized_keys /home/*/.ssh/authorized_keys; do
  [ -f "$f" ] || continue
  user=$(stat -c %U "$f" 2>/dev/null)
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      ''|'#'*) continue ;;
    esac
    printf '%s\t%s\t%s\n' "$user" "$f" "$line"
  done < "$f"
done
exit 0
"####;
        let output = pools
            .execute_with_category(
                &profile.id,
                &as_root(profile, script),
                KEY_TIMEOUT,
                "ssh-access",
            )
            .await?;
        if !output.success() {
            return Err(AppError::Remote(format!(
                "cannot list authorized keys: {}{}",
                output.stdout.trim(),
                output.stderr.trim()
            )));
        }

        Ok(output
            .stdout
            .lines()
            .filter(|line| !line.starts_with("__"))
            .filter_map(|line| {
                let mut parts = line.splitn(3, '\t');
                let user = parts.next()?.trim().to_string();
                let path = parts.next()?.trim().to_string();
                let raw = parts.next()?.trim().to_string();
                if user.is_empty() || raw.is_empty() {
                    return None;
                }
                let (key_type, comment, fingerprint) = inspect_key(&raw);
                Some(SshKey {
                    user,
                    path,
                    key_type,
                    comment,
                    fingerprint,
                    raw,
                })
            })
            .collect())
    }

    pub async fn config(pools: &PoolManager, profile: &ConnectionProfile) -> AppResult<SshConfig> {
        let script = format!(
            r####"export LC_ALL=C 2>/dev/null
echo __SSHD__
sshd -T 2>/dev/null | grep -E '^(pubkeyauthentication|passwordauthentication|kbdinteractiveauthentication|permitrootlogin)' || true
echo __TEST__
sshd -t 2>&1
echo "__RC__$?"
echo "__DROPIN__"
[ -f {dropin} ] && echo yes || echo no
exit 0
"####,
            dropin = shell_quote(SSHD_DROPIN)
        );
        let output = pools
            .execute_with_category(
                &profile.id,
                &as_root(profile, &script),
                KEY_TIMEOUT,
                "ssh-access",
            )
            .await?;
        Ok(parse_config(&output.stdout, &output.stderr))
    }

    pub async fn add_key(
        pools: &PoolManager,
        profile: &ConnectionProfile,
        user: &str,
        public_key: &str,
    ) -> AppResult<SshActionResult> {
        let key = normalize_public_key(public_key)?;
        validate_user(user)?;
        let fingerprint = inspect_key(&key).2;

        let script = format!(
            r####"set -e
user={user}
key={key}
home=$(getent passwd "$user" | cut -d: -f6)
[ -n "$home" ] || {{ echo "user not found" >&2; exit 1; }}
group=$(id -gn "$user")
mkdir -p "$home/.ssh"
chmod 700 "$home/.ssh"
touch "$home/.ssh/authorized_keys"
chmod 600 "$home/.ssh/authorized_keys"
chown "$user:$group" "$home/.ssh" "$home/.ssh/authorized_keys"
if grep -Fqx -- "$key" "$home/.ssh/authorized_keys"; then
  echo "key already present"
  exit 2
fi
printf '%s\n' "$key" >> "$home/.ssh/authorized_keys"
echo "key added for $user"
"####,
            user = shell_quote(user),
            key = shell_quote(&key)
        );
        let output = pools
            .execute_sensitive(&profile.id, &as_root(profile, &script), KEY_TIMEOUT)
            .await?;
        let combined = format!("{}{}", output.stdout, output.stderr)
            .trim()
            .to_string();
        Ok(SshActionResult {
            ok: output.success(),
            output: if combined.is_empty() {
                format!("key {fingerprint} processed")
            } else {
                combined
            },
            config: None,
        })
    }

    pub async fn remove_key(
        pools: &PoolManager,
        profile: &ConnectionProfile,
        user: &str,
        public_key: &str,
    ) -> AppResult<SshActionResult> {
        let key = normalize_public_key(public_key)?;
        validate_user(user)?;
        let script = format!(
            r####"set -e
user={user}
key={key}
home=$(getent passwd "$user" | cut -d: -f6)
[ -n "$home" ] || {{ echo "user not found" >&2; exit 1; }}
file="$home/.ssh/authorized_keys"
[ -f "$file" ] || {{ echo "authorized_keys not found" >&2; exit 1; }}
grep -Fqx -- "$key" "$file" || {{ echo "key not found" >&2; exit 1; }}
tmp=$(mktemp)
grep -Fvx -- "$key" "$file" > "$tmp" || true
cat "$tmp" > "$file"
rm -f "$tmp"
group=$(id -gn "$user")
chmod 600 "$file"
chown "$user:$group" "$file"
echo "key removed for $user"
"####,
            user = shell_quote(user),
            key = shell_quote(&key)
        );
        let output = pools
            .execute_sensitive(&profile.id, &as_root(profile, &script), KEY_TIMEOUT)
            .await?;
        let combined = format!("{}{}", output.stdout, output.stderr)
            .trim()
            .to_string();
        Ok(SshActionResult {
            ok: output.success(),
            output: if combined.is_empty() {
                "key removed".to_string()
            } else {
                combined
            },
            config: None,
        })
    }

    pub async fn set_key_only(
        pools: &PoolManager,
        profile: &ConnectionProfile,
        enabled: bool,
        confirmed: bool,
    ) -> AppResult<SshActionResult> {
        if !confirmed {
            return Err(AppError::Validation(
                "confirmation is required to change SSH authentication".into(),
            ));
        }

        let script = if enabled {
            format!(
                r####"set -e
dropin={dropin}
count=$(cat /root/.ssh/authorized_keys /home/*/.ssh/authorized_keys 2>/dev/null | awk 'NF && $1 !~ /^#/' | wc -l)
[ "$count" -gt 0 ] || {{ echo "no authorized keys found; refusing to disable password authentication" >&2; exit 3; }}
mkdir -p "$(dirname "$dropin")"
backup=""
[ -f "$dropin" ] && backup="$dropin.bak.$(date +%s)" && cp -p "$dropin" "$backup"
cat > "$dropin" <<'EOF'
# Managed by 2Shell
PubkeyAuthentication yes
PasswordAuthentication no
KbdInteractiveAuthentication no
ChallengeResponseAuthentication no
EOF
testfile=$(mktemp)
if ! sshd -t >"$testfile" 2>&1; then
  [ -n "$backup" ] && cp -p "$backup" "$dropin" || rm -f "$dropin"
  cat "$testfile" >&2
  rm -f "$testfile"
  exit 1
fi
rm -f "$testfile"
if sshd -T 2>/dev/null | grep -qi '^passwordauthentication yes'; then
  [ -n "$backup" ] && cp -p "$backup" "$dropin" || rm -f "$dropin"
  echo "another sshd config still enables PasswordAuthentication; change not applied" >&2
  exit 4
fi
systemctl reload sshd 2>/dev/null || systemctl reload ssh 2>/dev/null || service sshd reload 2>/dev/null || true
echo "PasswordAuthentication disabled; key-only access enabled"
sshd -T 2>/dev/null | grep -E '^(pubkeyauthentication|passwordauthentication|kbdinteractiveauthentication)'
"####,
                dropin = shell_quote(SSHD_DROPIN)
            )
        } else {
            format!(
                r####"set -e
dropin={dropin}
if [ -f "$dropin" ]; then
  cp -p "$dropin" "$dropin.bak.$(date +%s)"
  rm -f "$dropin"
fi
sshd -t >/dev/null 2>&1 || {{ echo "sshd config test failed" >&2; exit 1; }}
systemctl reload sshd 2>/dev/null || systemctl reload ssh 2>/dev/null || service sshd reload 2>/dev/null || true
echo "2Shell drop-in removed; other sshd settings are active again"
sshd -T 2>/dev/null | grep -E '^(pubkeyauthentication|passwordauthentication|kbdinteractiveauthentication)'
"####,
                dropin = shell_quote(SSHD_DROPIN)
            )
        };

        let output = pools
            .execute_sensitive(
                &profile.id,
                &as_root(profile, &script),
                Duration::from_secs(45),
            )
            .await?;
        let combined = format!("{}{}", output.stdout, output.stderr)
            .trim()
            .to_string();
        let config = Self::config(pools, profile).await.ok();
        Ok(SshActionResult {
            ok: output.success(),
            output: if combined.is_empty() {
                if enabled {
                    "key-only access enabled".to_string()
                } else {
                    "password authentication restored".to_string()
                }
            } else {
                combined
            },
            config,
        })
    }
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

fn normalize_public_key(input: &str) -> AppResult<String> {
    let key = input.trim();
    if key.is_empty() || key.contains('\n') || key.contains('\r') {
        return Err(AppError::Validation(
            "public key must be a single non-empty line".into(),
        ));
    }
    PublicKey::from_openssh(key)
        .map_err(|error| AppError::Validation(format!("invalid SSH public key: {error}")))?;
    Ok(key.to_string())
}

fn inspect_key(raw: &str) -> (String, String, String) {
    let key_type = raw
        .split_whitespace()
        .next()
        .unwrap_or("unknown")
        .to_string();
    match PublicKey::from_openssh(raw) {
        Ok(key) => {
            let comment = key.comment().as_str().unwrap_or("").to_string();
            let fingerprint = key.fingerprint(HashAlg::Sha256).to_string();
            (key_type, comment, fingerprint)
        }
        Err(_) => (key_type, String::new(), "unparsed".to_string()),
    }
}

fn validate_user(user: &str) -> AppResult<()> {
    if user.trim().is_empty() {
        return Err(AppError::Validation("system user is required".into()));
    }
    if user.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err(AppError::Validation("invalid system user name".into()));
    }
    Ok(())
}

fn parse_config(stdout: &str, stderr: &str) -> SshConfig {
    let mut config = SshConfig {
        pubkey_authentication: "unknown".into(),
        password_authentication: "unknown".into(),
        kbd_interactive_authentication: "unknown".into(),
        permit_root_login: "unknown".into(),
        config_test_ok: false,
        dropin_present: false,
        dropin_path: SSHD_DROPIN.to_string(),
        output: String::new(),
    };

    for line in stdout.lines() {
        let trimmed = line.trim();
        if let Some(value) = trimmed.strip_prefix("pubkeyauthentication ") {
            config.pubkey_authentication = value.trim().to_string();
        } else if let Some(value) = trimmed.strip_prefix("passwordauthentication ") {
            config.password_authentication = value.trim().to_string();
        } else if let Some(value) = trimmed.strip_prefix("kbdinteractiveauthentication ") {
            config.kbd_interactive_authentication = value.trim().to_string();
        } else if let Some(value) = trimmed.strip_prefix("permitrootlogin ") {
            config.permit_root_login = value.trim().to_string();
        }
    }

    config.dropin_present = stdout
        .lines()
        .skip_while(|line| line.trim() != "__DROPIN__")
        .nth(1)
        .map(|line| line.trim() == "yes")
        .unwrap_or(false);

    config.config_test_ok = stdout
        .lines()
        .find_map(|line| line.trim().strip_prefix("__RC__"))
        .map(|value| value.trim() == "0")
        .unwrap_or(false);

    let test_output = stdout
        .split("__TEST__")
        .nth(1)
        .and_then(|section| section.split("__RC__").next())
        .unwrap_or("")
        .trim();
    config.output = if test_output.is_empty() {
        stderr.trim().to_string()
    } else {
        format!("{}{}", test_output, stderr.trim())
    };

    config
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_sshd_effective_config() {
        let stdout = "__SSHD__\npubkeyauthentication yes\npasswordauthentication no\nkbdinteractiveauthentication no\npermitrootlogin prohibit-password\n__TEST__\nsshd: no hostkeys available\n__RC__0\n__DROPIN__\nyes\n";
        let config = parse_config(stdout, "");
        assert_eq!(config.pubkey_authentication, "yes");
        assert_eq!(config.password_authentication, "no");
        assert_eq!(config.kbd_interactive_authentication, "no");
        assert_eq!(config.permit_root_login, "prohibit-password");
        assert!(config.config_test_ok);
        assert!(config.dropin_present);
    }

    #[test]
    fn rejects_multiline_public_keys() {
        assert!(normalize_public_key("ssh-ed25519 AAAA\nssh-rsa BBBB").is_err());
        assert!(normalize_public_key("not-a-key").is_err());
    }

    #[test]
    fn rejects_unsafe_usernames() {
        assert!(validate_user("root").is_ok());
        assert!(validate_user("bad user").is_err());
        assert!(validate_user("bad\nuser").is_err());
    }
}
