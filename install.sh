#!/usr/bin/env sh
# Install this skill into the local DSH skills directory.
#
#   ./install.sh              # install / update
#   ./install.sh --uninstall  # remove
#
# Honors $DSH_HOME, falling back to ~/.dsh.
set -eu

skill_name='zcode-session-migration'
source_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
dsh_home=${DSH_HOME:-"$HOME/.dsh"}
target="$dsh_home/skills/$skill_name"

if [ "${1:-}" = "--uninstall" ]; then
    if [ -d "$target" ]; then rm -rf "$target"; echo "removed $target"; else echo "not installed: $target"; fi
    exit 0
fi

if [ ! -f "$source_dir/SKILL.md" ]; then
    echo "SKILL.md not found next to install.sh; run this from the repository root." >&2
    exit 1
fi

rm -rf "$target"
mkdir -p "$target"
cp "$source_dir/SKILL.md" "$target/"
for dir in references scripts; do
    [ -d "$source_dir/$dir" ] && cp -R "$source_dir/$dir" "$target/"
done

echo "installed $skill_name -> $target"
echo "Start a new DSH session for the skill to appear in the catalog."
