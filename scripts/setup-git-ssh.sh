#!/usr/bin/env bash
#
# setup-git-ssh.sh — materialize a GitHub SSH key from a Replit Secret
# into ~/.ssh/ on every workspace boot.
#
# Why this script exists
# ----------------------
# The git remote `origin` for this project is an SSH URL
# (git@github.com:PerfectGameFTW/Perfect-Game-Daily-Dash.git). SSH auth
# requires a private key in ~/.ssh/, but ~/.ssh/ lives in the home
# directory — which is REBUILT from scratch every time the Replit
# workspace container is recycled. So an SSH key that worked yesterday
# is gone today, and `git fetch / push` fails with
# "Permission denied (publickey)".
#
# The durable fix is to keep the private key in a Replit Secret
# (which DOES persist across container rebuilds) and re-materialize it
# into ~/.ssh/id_ed25519 on every shell start. Replit Secrets often
# strip newlines from multi-line values, so this script also REPAIRS
# the PEM line-wrap if the secret arrived as a single line.
#
# Hook
# ----
# This script is invoked from .config/bashrc (the workspace-tracked
# user bashrc that ~/.bashrc auto-sources on every interactive shell).
# Run it manually any time with:  bash scripts/setup-git-ssh.sh
#
# Idempotent: safe to re-run; skips work if the key on disk already
# matches the secret. Silently no-ops if GIT_SSH_PRIVATE_KEY is unset
# (so a forked workspace without the secret doesn't spam errors).

set -euo pipefail

SSH_DIR="${HOME}/.ssh"
KEY_PATH="${SSH_DIR}/id_ed25519"
KNOWN_HOSTS="${SSH_DIR}/known_hosts"

if [[ -z "${GIT_SSH_PRIVATE_KEY:-}" ]]; then
  # Not an error — just no key configured for this workspace.
  return 0 2>/dev/null || exit 0
fi

mkdir -p "${SSH_DIR}"
chmod 700 "${SSH_DIR}"

# ---------------------------------------------------------------------------
# Normalize the key.
# ---------------------------------------------------------------------------
# Replit Secrets sometimes preserve newlines and sometimes collapse
# them to spaces depending on how the value was pasted. OpenSSH refuses
# to load a key that has the BEGIN/END markers and base64 body all on a
# single line, so we always rebuild the PEM with proper line-wrap.
#
# We support both OPENSSH and RSA private key formats — the marker
# wording differs but the layout (header / base64 body / footer) is
# identical.
header=""
footer=""
raw="${GIT_SSH_PRIVATE_KEY}"
if [[ "${raw}" == *"BEGIN OPENSSH PRIVATE KEY"* ]]; then
  header="-----BEGIN OPENSSH PRIVATE KEY-----"
  footer="-----END OPENSSH PRIVATE KEY-----"
elif [[ "${raw}" == *"BEGIN RSA PRIVATE KEY"* ]]; then
  header="-----BEGIN RSA PRIVATE KEY-----"
  footer="-----END RSA PRIVATE KEY-----"
elif [[ "${raw}" == *"BEGIN EC PRIVATE KEY"* ]]; then
  header="-----BEGIN EC PRIVATE KEY-----"
  footer="-----END EC PRIVATE KEY-----"
elif [[ "${raw}" == *"BEGIN PRIVATE KEY"* ]]; then
  header="-----BEGIN PRIVATE KEY-----"
  footer="-----END PRIVATE KEY-----"
else
  echo "[setup-git-ssh] ERROR: GIT_SSH_PRIVATE_KEY does not look like a PEM private key (no BEGIN marker found)." >&2
  exit 1
fi

# Extract the base64 body: strip everything up to and including the
# header, strip the footer and everything after, then strip ALL
# whitespace (spaces, tabs, CR, LF) so we can re-wrap cleanly.
body="${raw#*${header}}"
body="${body%${footer}*}"
body_clean="$(printf '%s' "${body}" | tr -d ' \t\r\n')"

if [[ -z "${body_clean}" ]]; then
  echo "[setup-git-ssh] ERROR: GIT_SSH_PRIVATE_KEY body is empty after stripping markers." >&2
  exit 1
fi

# Rewrap base64 at 70 chars per line and assemble the canonical PEM.
# `fold` doesn't always emit a trailing newline (depends on whether the
# final segment is a full 70 chars), so we feed everything through a
# brace-grouped subshell that emits one newline per logical line —
# header, each base64 line, footer — and lets the redirection produce
# the canonical PEM in one shot.
body_wrapped="$(printf '%s' "${body_clean}" | fold -w 70)"
new_key="$({
  printf '%s\n' "${header}"
  printf '%s\n' "${body_wrapped}"
  printf '%s\n' "${footer}"
})"

# Atomic validate-then-replace: write candidate to a sibling temp file,
# verify ssh-keygen accepts it, and only then move into place. Without
# this, a misformatted secret value could clobber a previously-working
# key file and leave the workspace unable to push to git — strictly
# WORSE than the pre-fix state. With this, a bad secret leaves the
# existing key untouched and the script exits non-zero so the failure
# is visible.
tmp_key="${KEY_PATH}.new.$$"
trap 'rm -f "${tmp_key}"' EXIT
printf '%s\n' "${new_key}" > "${tmp_key}"
chmod 600 "${tmp_key}"
if ! ssh-keygen -y -f "${tmp_key}" >/dev/null 2>&1; then
  echo "[setup-git-ssh] ERROR: GIT_SSH_PRIVATE_KEY did not parse as a valid private key after normalization. Existing ~/.ssh/id_ed25519 left untouched." >&2
  exit 1
fi

# Only swap in if the contents differ — keeps file mtime stable across
# no-op shell starts.
if [[ ! -f "${KEY_PATH}" ]] || ! cmp -s "${tmp_key}" "${KEY_PATH}"; then
  mv "${tmp_key}" "${KEY_PATH}"
else
  rm -f "${tmp_key}"
fi
trap - EXIT

# ---------------------------------------------------------------------------
# known_hosts pinning for github.com
# ---------------------------------------------------------------------------
# Without this, the first SSH connection prompts for host-key
# acceptance (or fails outright in non-interactive contexts like
# automated git pulls). We pin GitHub's published host keys here. If
# GitHub ever rotates them, update this block — current values are
# from https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints
touch "${KNOWN_HOSTS}"
chmod 600 "${KNOWN_HOSTS}"
github_keys=$(cat <<'EOF'
github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl
github.com ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBEmKSENjQEezOmxkZMy7opKgwFB9nkt5YRrYMjNuG5N87uRgg6CLrbo5wAdT/y6v0mKV0U2w0WZ2YB/++Tpockg=
github.com ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQCj7ndNxQowgcQnjshcLrqPEiiphnt+VTTvDP6mHBL9j1aNUkY4Ue1gvwnGLVlOhGeYrnZaMgRK6+PKCUXaDbC7qtbW8gIkhL7aGCsOr/C56SJMy/BCZfxd1nWzAOxSDPgVsmerOBYfNqltV9/hWCqBywINIR+5dIg6JTJ72pcEpEjcYgXkE2YEFXV1JHnsKgbLWNlhScqb2UmyRkQyytRLtL+38TGxkxCflmO+5Z8CSSNY7GidjMIZ7Q4zMjA2n1nGrlTDkzwDCsw+wqFPGQA179cnfGWOWRVruj16z6XyvxvjJwbz0wQZ75XK5tKSb7FNyeIEs4TT4jk+S4dhPeAUC5y+bDYirYgM4GC7uEnztnZyaVWQ7B381AK4Qdrwt51ZqExKbQpTUNn+EjqoTwvqNj4kqx5QUCI0ThS/YkOxJCXmPUWZbhjpCg56i+2aB6CmK2JGhn57K5mj0MNdBXA4/WnwH6XoPWJzK5Nyu2zB3nAZp+S5hpQs+p1vN1/wsjk=
EOF
)

while IFS= read -r line; do
  [[ -z "${line}" ]] && continue
  # Match by the constant prefix (host + key-type + first 30 chars of
  # base64) so a key rotation overwrites the old line instead of
  # appending an unbounded list of stale entries.
  prefix="$(printf '%s' "${line}" | awk '{print $1, $2, substr($3, 1, 30)}')"
  if ! grep -Fq "${prefix}" "${KNOWN_HOSTS}" 2>/dev/null; then
    printf '%s\n' "${line}" >> "${KNOWN_HOSTS}"
  fi
done <<< "${github_keys}"

# Done. Stay quiet on success so this is invisible noise in normal
# shell startup; the calling bashrc is responsible for any "ready"
# message if it wants one.
