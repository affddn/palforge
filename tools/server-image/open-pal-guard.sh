#!/bin/bash
# open-pal start-time guard. start.sh runs it after updating the game and right before starting the server.
# A pak built for another game build, or whose bytes no longer match its manifest, is moved aside so the
# server starts vanilla. It never stops the server from starting.
root="${PALWORLD_ROOT:-/palworld}"
mods="$root/Pal/Content/Paks/~mods"
pak="$mods/OpenPal_P.pak"
manifest="$mods/OpenPal_P.manifest.json"

[ -e "$pak" ] || exit 0

field() {
  sed -n "s/.*\"$1\"[[:space:]]*:\{0,1\}[[:space:]]*\"\([0-9a-f]*\)\".*/\1/p" "$2" 2>/dev/null | head -n 1
}

installed="$(field buildid "$root/steamapps/appmanifest_2394010.acf")"
built="$(field gameBuildId "$manifest")"
expected="$(field pakSha256 "$manifest")"
actual="$({ sha256sum "$pak" 2>/dev/null || shasum -a 256 "$pak"; } | cut -d " " -f 1)"

if [ -z "$built" ] || [ -z "$expected" ]; then
  reason="it has no readable manifest"
elif [ "$built" != "$installed" ]; then
  reason="it was built for game build $built but build ${installed:-unknown} is installed"
elif [ "$actual" != "$expected" ]; then
  reason="its SHA-256 does not match its manifest"
else
  echo "[open-pal] OpenPal_P.pak matches game build $installed"
  exit 0
fi

# Outside Pal/Content/Paks: the engine mounts every .pak anywhere under it, including subdirectories.
aside="$root/open-pal-disabled/$(date -u +%Y%m%dT%H%M%SZ)"

if mkdir -p "$aside" && mv "$pak" "$aside/"; then
  [ ! -e "$manifest" ] || mv "$manifest" "$aside/"
  echo "[open-pal] Moved OpenPal_P.pak aside because $reason; starting without it ($aside)"
else
  rm -f "$pak"
  echo "[open-pal] Deleted OpenPal_P.pak because $reason and it could not be moved; starting without it"
fi

exit 0
