#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FAILED=0

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  FAILED=1
}

print_matches() {
  local title="$1"
  shift
  printf '\n%s\n' "$title" >&2
  "$@" >&2 || true
}

cd "$ROOT_DIR"

if [[ ! -f "site/index.html" ]]; then
  fail "site/index.html is missing"
fi

if [[ ! -f "site/assets/siriusmsg-icon.png" ]]; then
  fail "site/assets/siriusmsg-icon.png is missing"
fi

if find . -path './.git' -prune -o \( \
  -iname '*.p12' -o \
  -iname '*.p8' -o \
  -iname '*.mobileprovision' -o \
  -iname '*.cer' -o \
  -iname '*.key' -o \
  -iname '*.pem' -o \
  -iname '.env' -o \
  -iname '.env.*' -o \
  -iname '*token*' -o \
  -iname '*secret*' -o \
  -iname '*keychain*' -o \
  -iname '*notary*' -o \
  -iname 'chat.db*' -o \
  -iname '*.sqlite' -o \
  -iname '*.sqlite3' -o \
  -iname '*.log' \
\) -print | grep -q .; then
  print_matches "Sensitive-looking files:" find . -path './.git' -prune -o \( \
    -iname '*.p12' -o \
    -iname '*.p8' -o \
    -iname '*.mobileprovision' -o \
    -iname '*.cer' -o \
    -iname '*.key' -o \
    -iname '*.pem' -o \
    -iname '.env' -o \
    -iname '.env.*' -o \
    -iname '*token*' -o \
    -iname '*secret*' -o \
    -iname '*keychain*' -o \
    -iname '*notary*' -o \
    -iname 'chat.db*' -o \
    -iname '*.sqlite' -o \
    -iname '*.sqlite3' -o \
    -iname '*.log' \
  \) -print
  fail "sensitive-looking file names are present"
fi

if find . -path './.git' -prune -o \( \
  -iname '*.swift' -o \
  -iname '*.xcodeproj' -o \
  -iname '*.xcworkspace' -o \
  -iname 'Package.swift' -o \
  -iname 'Package.resolved' -o \
  -iname 'project.yml' -o \
  -path './Sources/*' -o \
  -path './Tests/*' -o \
  -path './Apps/*' -o \
  -path './Agents/*' -o \
  -path './Entitlements/*' \
\) -print | grep -q .; then
  print_matches "Source-looking files:" find . -path './.git' -prune -o \( \
    -iname '*.swift' -o \
    -iname '*.xcodeproj' -o \
    -iname '*.xcworkspace' -o \
    -iname 'Package.swift' -o \
    -iname 'Package.resolved' -o \
    -iname 'project.yml' -o \
    -path './Sources/*' -o \
    -path './Tests/*' -o \
    -path './Apps/*' -o \
    -path './Agents/*' -o \
    -path './Entitlements/*' \
  \) -print
  fail "private source tree material is present"
fi

if rg -n --hidden --glob '!.git/**' --glob '!tools/audit-public-release.sh' \
  '(ghp_[A-Za-z0-9_]{20,}|gho_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|APPLE_ID\s*=|APP_SPECIFIC_PASSWORD\s*=|SIRIUSMSG_NOTARY_PROFILE\s*=|com\.apple\.developer\.team-identifier|NYAM936LHR)' . >/tmp/siriusmsg-public-secret-matches.txt; then
  cat /tmp/siriusmsg-public-secret-matches.txt >&2
  fail "secret-like literal or signing identifier found"
fi
rm -f /tmp/siriusmsg-public-secret-matches.txt

if rg -n --hidden --glob '!.git/**' --glob '!tools/audit-public-release.sh' \
  '(github\.com/mikhutchinson|/Users/mikhutchinson|Library/Messages|chat\.db|service-token\.json|validation-runs|operational-log\.json)' . >/tmp/siriusmsg-public-private-matches.txt; then
  cat /tmp/siriusmsg-public-private-matches.txt >&2
  fail "private source, local path, or operational artifact reference found"
fi
rm -f /tmp/siriusmsg-public-private-matches.txt

if [[ "$FAILED" != "0" ]]; then
  exit 1
fi

printf 'Public release audit passed.\n'
