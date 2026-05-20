#!/usr/bin/env bash
# install.sh — symlink `tcc` onto your PATH.
#
# Preference order:
#   1. ~/bin/tcc            (if ~/bin is on PATH)
#   2. ~/.local/bin/tcc     (if on PATH)
#   3. npm link             (fallback — registers under npm's global bin)
set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
BIN="${REPO}/bin/tcc"
cd "$REPO"

if [ ! -d node_modules ]; then
  echo "==> installing npm deps"
  npm install --silent
fi

dir_on_path() {
  case ":$PATH:" in *":$1:"*) return 0 ;; esac
  return 1
}

choose_target() {
  if [ -d "$HOME/bin" ] && dir_on_path "$HOME/bin"; then
    echo "$HOME/bin/tcc"
    return
  fi
  if [ -d "$HOME/.local/bin" ] && dir_on_path "$HOME/.local/bin"; then
    echo "$HOME/.local/bin/tcc"
    return
  fi
  echo ""
}

TARGET="$(choose_target)"

if [ -n "$TARGET" ]; then
  ln -sfn "$BIN" "$TARGET"
  echo "==> linked $TARGET → $BIN"
else
  echo "==> ~/bin and ~/.local/bin are not on \$PATH; falling back to 'npm link'"
  npm link
  TARGET="$(npm prefix -g)/bin/tcc"
  echo "==> tcc installed at $TARGET (via npm link)"
fi

# Sanity check.
if "$TARGET" --version >/dev/null 2>&1; then
  echo "==> verified: $TARGET runs cleanly"
else
  echo "warning: $TARGET did not run cleanly. Try: hash -r && tcc --version" >&2
fi

cat <<EOF

next:
  - run 'tcc' from any directory (sessions write to ~/.tcc/sessions/)
  - optional: export TCC_DEFAULT_THEME=tokyo-night  (catppuccin-mocha | gruvbox-dark)
  - to uninstall: rm $TARGET   (or 'npm unlink -g tcc' if you used the npm fallback)
EOF
