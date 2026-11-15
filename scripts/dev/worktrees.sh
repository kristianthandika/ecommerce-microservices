#!/usr/bin/env bash
# =============================================================================
# Helper git worktree untuk instruktur/peserta: buka branch starter & solution
# sebuah fitur BERDAMPINGAN di dua folder, tanpa checkout bolak-balik.
#
#   bash scripts/dev/worktrees.sh m2.2     # buat worktree starter & solution m2.2
#   bash scripts/dev/worktrees.sh --list   # daftar fitur yang tersedia
#   bash scripts/dev/worktrees.sh --clean [mX.Y]  # hapus worktree (semua / satu)
#
# Worktree dibuat di folder saudara: ../<repo>-worktrees/<fitur>-(starter|solution)
# =============================================================================
set -euo pipefail

# Path absolut skrip ini DULU (sebelum cd) supaya usage() tetap bisa membaca
# komentarnya sendiri walau dijalankan dari direktori mana pun.
SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
# pindah ke root repo (dua level di atas skrip ini)
cd "$(dirname "$0")/../.."
REPO_NAME="$(basename "$PWD")"
WT_BASE="$(cd .. && pwd)/${REPO_NAME}-worktrees"

usage() {
  grep '^#' "$SELF" | sed 's/^# \{0,1\}//;1d'
  exit "${1:-0}"
}

list_features() {
  # Branch di server ikut dihitung, supaya clone baru (yang belum punya branch
  # lokal) juga melihat semua lab. Urutan versi: m12.2 sebelum m12.10.
  { git branch --list 'starter/*'; git branch -r --list 'origin/starter/*'; } \
    | sed 's#^[* ]*##; s#^origin/##; s#^starter/##' | sort -uV
}

# resolve <mX.Y|slug> → cetak slug tunggal. Error kalau tak ada, ambigu, atau
# pasangan solution-nya tidak ada. Tidak memakai `head` (hindari SIGPIPE + pipefail).
resolve() {
  local q="$1" matches count slug
  # ID lengkap ("m12.1") dicocokkan persis dulu, supaya tidak bentrok dengan
  # m12.10/m12.11/m12.12; baru kemudian sebagai awalan slug ("m12.1-cart").
  matches="$(list_features | grep -E "^${q//./\\.}-" || true)"
  [ -n "$matches" ] || matches="$(list_features | grep -F "$q" | grep -E "^${q//./\\.}" || true)"
  count="$(printf '%s' "$matches" | grep -c . || true)"
  if [ "$count" -eq 0 ]; then
    echo "Fitur '$q' tidak ditemukan. Coba --list." >&2
    exit 1
  fi
  if [ "$count" -gt 1 ]; then
    echo "Prefix '$q' ambigu, cocok dengan beberapa fitur:" >&2
    printf '  %s\n' $matches >&2
    echo "Sebutkan fitur yang lebih spesifik." >&2
    exit 1
  fi
  slug="$matches"
  if ! git show-ref --verify --quiet "refs/heads/solution/${slug}" &&
    ! git show-ref --verify --quiet "refs/remotes/origin/solution/${slug}"; then
    echo "Branch 'solution/${slug}' tidak ada (pasangan solution belum dibuat)." >&2
    exit 1
  fi
  printf '%s\n' "$slug"
}

clean() {
  if [ "${1:-}" = "" ]; then
    if [ -d "$WT_BASE" ]; then
      for d in "$WT_BASE"/*/; do
        [ -d "$d" ] && git worktree remove --force "$d" 2>/dev/null || true
      done
      rm -rf "$WT_BASE"
    fi
    git worktree prune
    echo "Semua worktree dibersihkan."
  else
    local slug
    slug="$(resolve "$1")"
    for kind in starter solution; do
      local dir="$WT_BASE/${slug}-${kind}"
      [ -d "$dir" ] && git worktree remove --force "$dir" 2>/dev/null || true
    done
    git worktree prune
    echo "Worktree untuk ${slug} dibersihkan."
  fi
}

case "${1:-}" in
  ''|-h|--help) usage 0 ;;
  --list) list_features; exit 0 ;;
  --clean) clean "${2:-}"; exit 0 ;;
esac

SLUG="$(resolve "$1")"
mkdir -p "$WT_BASE"

for kind in starter solution; do
  branch="${kind}/${SLUG}"
  dir="$WT_BASE/${SLUG}-${kind}"
  if [ -d "$dir" ]; then
    echo "sudah ada: $dir"
  else
    git worktree add "$dir" "$branch" >/dev/null 2>&1
    echo "worktree $kind  → $dir   (branch $branch)"
  fi
done

cat <<EOF

Selesai. Buka dua folder ini berdampingan di editor:
  starter : $WT_BASE/${SLUG}-starter
  solution: $WT_BASE/${SLUG}-solution

Tips: worktree tidak berbagi node_modules dengan repo utama — jalankan
'npm install' lalu 'npm run build:packages' di worktree bila ingin menjalankan
test di sana. Bersihkan dengan: bash scripts/dev/worktrees.sh --clean ${SLUG}
EOF
