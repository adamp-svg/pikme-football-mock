#!/usr/bin/env bash
# Deploy to Render, then PROVE the new bytes are actually being served.
#
#   ./scripts/deploy.sh game        # the football game  (pikme-football.onrender.com)
#   ./scripts/deploy.sh api         # pikme-server       (server.pikme.tv)
#   ./scripts/deploy.sh game --push # push origin main first, then deploy
#
# WHY THIS EXISTS
# Render's GitHub link for this repo is broken: there is NO webhook on
# adamp-svg/pikme-football-mock, so `git push` deploys NOTHING even though the Render API reports
# autoDeploy=yes. That is how the game server ended up 61 commits behind production for two days.
# Re-arming autoDeploy through the API was tried and provably did nothing (empty probe commit
# 564cdc4 -> no deploy in 3 minutes). So deploying is an explicit CLI step, which also matches the
# standing rule in CLAUDE.md: never deploy unless the user asks.
#
# THE TWO TRAPS THIS SCRIPT EXISTS TO CATCH
#  1. Render builds from GITHUB, not from your working tree. It deploys `origin/main`. Local commits
#     you haven't pushed are invisible to it, and a dirty tree is invisible to it. Comparing prod
#     against local HEAD gives false confidence.
#  2. "status: live" arrives slightly BEFORE the new bytes are served. Hashing prod the instant the
#     status flips can return the OLD file and look like a failed deploy. So we re-check.
set -euo pipefail

cd "$(dirname "$0")/.."

TARGET="${1:-game}"
PUSH_FIRST="no"
for a in "${@:2}"; do [ "$a" = "--push" ] && PUSH_FIRST="yes"; done

case "$TARGET" in
  game) SVC="srv-d9ebcvtaeets73ar91sg"; HOST="https://pikme-football.onrender.com"
        # Files whose content we can verify byte-for-byte against the deployed commit.
        PROBES=("/client.js:public/client.js"); ASSETS=("/" "/hub-rank.js" "/rank.css" "/shared/rank.js") ;;
  api)  SVC="srv-chgb1k67avjbbju8aoig"; HOST="https://server.pikme.tv"
        PROBES=(); ASSETS=() ;;
  *) echo "usage: $0 [game|api] [--push]" >&2; exit 2 ;;
esac

command -v render >/dev/null || { echo "❌ the Render CLI is not installed (brew install render)" >&2; exit 1; }

say() { printf '%s\n' "$*"; }

# ---- 1. what will Render actually build? ------------------------------------
if [ "$PUSH_FIRST" = "yes" ]; then
  say "→ pushing origin main"
  git push origin main
fi
git fetch -q origin main

LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)
say "→ local HEAD    $(git rev-parse --short HEAD)  $(git log -1 --format=%s | cut -c1-58)"
say "→ origin/main   $(git rev-parse --short origin/main)  <- this is what Render builds"

if [ "$LOCAL" != "$REMOTE" ]; then
  AHEAD=$(git rev-list --count origin/main..HEAD)
  say "⚠️  local main is $AHEAD commit(s) ahead of origin — those will NOT be deployed."
  say "    Re-run with --push, or push yourself first."
fi
DIRTY=$(git status --porcelain -- public shared server.js | wc -l | tr -d ' ')
[ "$DIRTY" != "0" ] && say "⚠️  $DIRTY uncommitted change(s) under public/ shared/ server.js — invisible to Render."

# ---- 2. deploy --------------------------------------------------------------
say "→ triggering deploy of $TARGET ($SVC)"
DEP=$(render deploys create "$SVC" --output json --confirm \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
say "  deploy $DEP"

for i in $(seq 1 60); do
  ST=$(render deploys list "$SVC" --output json --confirm 2>/dev/null | python3 -c '
import json,sys
d=json.load(sys.stdin)
for x in d:
    dep=x.get("deploy",x)
    if dep.get("id")=="'"$DEP"'": print(dep.get("status")); break
else: print("pending")')
  printf '\r  [%02d] %-22s' "$i" "$ST"
  case "$ST" in
    live) say ""; break ;;
    build_failed|update_failed|canceled|pre_deploy_failed)
      say ""; say "❌ deploy ended as '$ST' — check: render logs $SVC"; exit 1 ;;
  esac
  sleep 15
done
[ "${ST:-}" = "live" ] || { say ""; say "❌ timed out waiting for $DEP"; exit 1; }

# ---- 3. prove it: are the DEPLOYED bytes really being served? ---------------
# Trap 2: "live" can precede the swap, so allow a few retries before failing.
FAILED=0
for p in ${PROBES[@]+"${PROBES[@]}"}; do
  URL="${p%%:*}"; PATHNAME="${p#*:}"
  WANT=$(git show "origin/main:$PATHNAME" | shasum | cut -c1-12)
  for try in 1 2 3 4 5; do
    GOT=$(curl -s "$HOST$URL?cb=$RANDOM$$" --max-time 30 | shasum | cut -c1-12)
    [ "$GOT" = "$WANT" ] && break
    sleep 6
  done
  if [ "$GOT" = "$WANT" ]; then say "✅ $URL matches origin/main ($WANT)"
  else say "❌ $URL is STALE — serving $GOT, origin/main has $WANT"; FAILED=1; fi
done

for a in ${ASSETS[@]+"${ASSETS[@]}"}; do
  CODE=$(curl -s -o /dev/null -w '%{http_code}' "$HOST$a" --max-time 30)
  if [ "$CODE" = "200" ]; then say "✅ $a -> 200"
  else say "❌ $a -> $CODE"; FAILED=1; fi
done

[ "$FAILED" = "0" ] || { say ""; say "❌ deploy reported live but verification FAILED."; exit 1; }
say ""
say "✅ $TARGET is live and verified at $(git rev-parse --short origin/main)"
