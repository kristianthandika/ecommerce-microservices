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

# pindah ke root repo (dua level di atas skrip ini)
cd "$(dirname "$0")/../.."
REPO_NAME="$(basename "$PWD")"
WT_BASE="$(cd .. && pwd)/${REPO_NAME}-worktrees"

usage() {
  grep '^#' "$0" | sed 's/^# \{0,1\}//;1d'
  exit "${1:-0}"
}

list_features() {
  git branch --list 'starter/*' | sed 's#^[* ]*starter/##' | sort
}

resolve() { # $1 = mX.Y atau slug penuh; echo "starter_branch solution_branch slug"
  local q="$1"
  local s
  s="$(git branch --list "starter/${q}*" | head -1 | sed 's/^[* ]*//')"
  [ -z "$s" ] && { echo "Fitur '$q' tidak ditemukan. Coba --list." >&2; exit 1; }
  local slug="${s#starter/}"
  echo "starter/${slug} solution/${slug} ${slug}"
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
    read -r sb so slug < <(resolve "$1")
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

read -r STARTER SOLUTION SLUG < <(resolve "$1")
mkdir -p "$WT_BASE"

for kind in starter solution; do
  branch="starter/${SLUG}"; [ "$kind" = solution ] && branch="solution/${SLUG}"
  dir="$WT_BASE/${SLUG}-${kind}"
  if [ -d "$dir" ]; then
    echo "sudah ada: $dir"
  else
    git worktree add "$dir" "$branch" >/dev/null
    echo "worktree $kind  → $dir   (branch $branch)"
  fi
done

cat <<EOF

Selesai. Buka dua folder ini berdampingan di editor:
  starter : $WT_BASE/${SLUG}-starter
  solution: $WT_BASE/${SLUG}-solution

Tips: 'npm install' dijalankan di repo utama sudah cukup (node_modules dibagi),
tapi worktree tidak berbagi node_modules — jalankan 'npm install' di tiap
worktree bila ingin menjalankan test di sana, lalu 'npm run build:packages'.
Bersihkan dengan: bash scripts/dev/worktrees.sh --clean ${SLUG}
EOF
