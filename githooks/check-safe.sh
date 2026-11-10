#!/bin/bash
# Safety gate for everything that enters or leaves this public repo.
#   check-safe.sh staged               pre-commit: the staged changes
#   check-safe.sh range <base> <tip>   pre-push: every commit being pushed (base may be empty)
# Blocks personal data files, secrets, personal info (emails, home paths, IPs), big files,
# commits authored with another identity, regressions of the server/page hardening, and any
# word listed in .git/info/check-safe-denylist (private: one extended regex per line, never committed).
set -u
MODE="${1:-staged}"
SELF="githooks/check-safe.sh" # holds the generic patterns themselves, so its content is not scanned
DENYLIST="$(git rev-parse --git-path info/check-safe-denylist)"
fail=0
block() { printf '  ✘ %s\n' "$*" >&2; fail=1; }

if [ "$MODE" = "range" ]; then
  BASE="${2:-}"
  TIP="$3"
  DIFF_FROM="${BASE:-$(git hash-object -t tree /dev/null)}"
  list_files() { git diff --name-only --diff-filter=ACMR "$DIFF_FROM" "$TIP"; }
  added_lines() { git diff -U0 "$DIFF_FROM" "$TIP" -- . ":(exclude)$SELF" | grep '^+' | grep -v '^+++'; }
  file_at() { git show "$TIP:$1" 2>/dev/null; }
  size_of() { git cat-file -s "$TIP:$1" 2>/dev/null || echo 0; }
else
  list_files() { git diff --cached --name-only --diff-filter=ACMR; }
  added_lines() { git diff --cached -U0 -- . ":(exclude)$SELF" | grep '^+' | grep -v '^+++'; }
  file_at() { git show ":$1" 2>/dev/null; }
  size_of() { git cat-file -s ":$1" 2>/dev/null || echo 0; }
fi

echo "🔒 Revisión de seguridad ($MODE)…" >&2

# 1. Files that must never be published.
while IFS= read -r f; do
  [ -z "$f" ] && continue
  case "$f" in
    todos.json | labels.json | config.json | *backup*.json | *.log | *.tmp | .env | .env.* | \
      *.pem | *.key | *.p12 | id_rsa* | id_ed25519* | .claude/* | *.app/*)
      block "Archivo prohibido: $f (datos personales, claves o configuración local)" ;;
  esac
  size="$(size_of "$f")"
  [ "$size" -gt 2000000 ] && block "Archivo demasiado grande ($((size / 1024)) KB): $f"
done <<<"$(list_files)"

# 2. Secrets and personal info.
LINES=""
scan() { # <description> <extended regex> [regex of allowed matches]
  local hits
  hits="$(printf '%s\n' "$LINES" | grep -Ei -- "$2")"
  [ -n "${3:-}" ] && hits="$(printf '%s\n' "$hits" | grep -Eiv -- "$3")"
  [ -z "$hits" ] && return
  block "$1:"
  printf '%s\n' "$hits" | head -3 | cut -c1-140 | sed 's/^/      /' >&2
}
scan_denylist() { # <where>
  [ -f "$DENYLIST" ] || return
  while IFS= read -r word; do
    case "$word" in '' | '#'*) continue ;; esac
    scan "Dato privado de tu lista ($where)" "$word"
  done <"$DENYLIST"
}

LINES="$(added_lines)"
if [ -n "$LINES" ]; then
  where="código"
  scan "Clave privada" '-----BEGIN [A-Z ]*PRIVATE KEY'
  scan "Token de GitHub" 'gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,}'
  scan "Token de Slack" 'xox[abprs]-[A-Za-z0-9-]{10,}'
  scan "Clave de API (OpenAI/Anthropic/AWS/Google)" 'sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}'
  scan "Contraseña o secreto escrito en el código" \
    "(password|passwd|secret|api[_-]?key|token)[\"']?[[:space:]]*[:=][[:space:]]*[\"'][^\"']{8,}"
  scan "Correo electrónico" '[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z.]{2,}'
  scan "Ruta absoluta con tu usuario" '/Users/[A-Za-z0-9._-]+'
  scan "Dirección IP de una máquina" '(^|[^0-9.])([0-9]{1,3}\.){3}[0-9]{1,3}([^0-9.]|$)' '127\.0\.0\.1'
  scan_denylist
fi

# Commit messages are published too (the Co-Authored-By trailer is the only email allowed).
if [ "$MODE" = "range" ]; then
  LINES="$(git log --format=%B "$TIP" ${BASE:+"^$BASE"} | grep -v '^Co-Authored-By: .*<noreply@anthropic.com>$')"
  if [ -n "$LINES" ]; then
    where="mensaje de commit"
    scan "Token o clave en un mensaje de commit" 'gh[pousr]_[A-Za-z0-9]{30,}|xox[abprs]-|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|PRIVATE KEY'
    scan "Correo en un mensaje de commit" '[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z.]{2,}'
    scan "Ruta con tu usuario en un mensaje de commit" '/Users/[A-Za-z0-9._-]+'
    scan_denylist
  fi
fi

# 3. Second opinion from gitleaks, when installed.
if command -v gitleaks >/dev/null 2>&1; then
  if [ "$MODE" = "range" ]; then
    LOG_RANGE="${BASE:+$BASE..}$TIP"
    gitleaks git --no-banner --redact --log-opts="$LOG_RANGE" . >/dev/null 2>&1 ||
      block "gitleaks ha encontrado secretos (detalle: gitleaks git -v --log-opts=\"$LOG_RANGE\")"
  else
    gitleaks git --no-banner --redact --staged . >/dev/null 2>&1 ||
      block "gitleaks ha encontrado secretos (detalle: gitleaks git -v --staged)"
  fi
fi

# 4. The hardening must stay in place.
SERVER="$(file_at server.py)"
if [ -n "$SERVER" ]; then
  grep -qF '("127.0.0.1", PORT)' <<<"$SERVER" || block "server.py ya no escucha solo en 127.0.0.1"
  grep -qF '_is_local_request' <<<"$SERVER" || block "server.py ha perdido la protección de Host/Origin"
  grep -qE '0\.0\.0\.0|Access-Control-Allow-Origin' <<<"$SERVER" &&
    block "server.py abre el acceso a otras máquinas o webs (0.0.0.0 o CORS)"
fi
PAGE="$(file_at index.html)"
if [ -n "$PAGE" ]; then
  grep -qF 'HEX_COLOR.test' <<<"$PAGE" || block "index.html ya no valida los colores de las etiquetas"
  grep -qE '(^|[^A-Za-z_.])eval\(|new Function\(' <<<"$PAGE" && block "index.html usa eval o new Function"
fi

# 5. New commits must be signed with a key from .git/info/allowed_signers (the app refuses unsigned updates).
if [ "$MODE" = "range" ]; then
  for commit in $(git rev-list "$TIP" --not --remotes); do
    [ "$(git log -1 --format=%G? "$commit")" = "G" ] ||
      block "El commit ${commit:0:7} no lleva tu firma (git config commit.gpgsign true y vuelve a hacer el commit)"
  done
fi

# 6. Commits must carry this repo's identity (never the global work identity).
if [ "$MODE" = "range" ]; then
  ME="$(git config --local user.email)"
  [ -z "$ME" ] && block "Este repo no tiene user.email propio (git config --local user.email …)"
  for commit in $(git rev-list "$TIP" ${BASE:+"^$BASE"}); do
    for who in "$(git log -1 --format=%ae "$commit")" "$(git log -1 --format=%ce "$commit")"; do
      [ "$who" != "$ME" ] && block "El commit ${commit:0:7} lleva el correo $who (se esperaba $ME)"
    done
  done
fi

if [ "$fail" = 1 ]; then
  echo "❌ Bloqueado: corrige lo anterior y vuelve a intentarlo." >&2
  exit 1
fi
echo "✅ Sin problemas de seguridad." >&2
