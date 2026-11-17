#!/usr/bin/env bash
# brokie was here >:3 | @quieterdown! | 6767 gng
# Auto-sync external power skills into OpenCode & Claude Agent stack

SKILL_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/opencode/skill"
mkdir -p "$SKILL_DIR"

REPOS=(
  "https://github.com/Leonxlnx/unlazy"
  "https://github.com/obra/superpowers"
  "https://github.com/nextlevelbuilder/ui-ux-pro-max-skill"
  "https://github.com/elayadesign/ai-design-skills"
  "https://github.com/Owl-Listener/designer-skills"
  "https://github.com/blacktwist/social-media-skills"
  "https://github.com/karanb192/awesome-claude-skills"
  "https://github.com/dipakkr/awesome-agent-skills"
)

echo "==> [Brokie Sync] Pulling power skills into OpenCode..."
for repo in "${REPOS[@]}"; do
  name=$(basename "$repo" .git)
  target="$SKILL_DIR/$name"
  if [ -d "$target/.git" ]; then
    echo "Updating $name..."
    git -C "$target" pull --quiet --rebase 2>/dev/null || true
  else
    echo "Cloning $name..."
    git clone --depth 1 "$repo" "$target" 2>/dev/null || echo "Failed to clone $name, skipping."
  fi
done
echo "==> [Brokie Sync] Done! Skills loaded."
