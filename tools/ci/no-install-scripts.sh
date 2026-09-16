#!/usr/bin/env bash
#
# Shows that --ignore-scripts does what the workflows rely on it doing.
#
# "No install scripts" is a supply-chain rule (docs/design.md, "API and data rules"), and
# every workflow passes the flag -- but a flag that had been renamed, or that npm had
# quietly stopped honouring, would look exactly the same in the file. So a package whose
# postinstall leaves a file behind is installed twice.
#
# The install without the flag is the control, and it is the point: if the marker does
# not appear there, the probe is broken and the run with the flag proves nothing at all.
# That is why this lives here rather than in a workflow -- an install with no
# --ignore-scripts inside .github/workflows/ is the thing tools/ci/workflows.test.ts
# exists to forbid, and it should stay forbidden there.
#
# Run it locally the same way CI does: tools/ci/no-install-scripts.sh
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
probe="$root/tools/ci/__fixtures__/install-script-probe"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

tarball="$work/$(cd "$work" && npm pack --ignore-scripts --silent "$probe")"
test -f "$tarball"

# Installs the probe into an empty project. A failed install is fatal and says so: the
# whole check turns on whether one file exists afterwards, and an install that never
# happened leaves no file either -- which would read as a pass. Nothing calls this from
# inside an `if` condition, because that suspends `set -e` for everything it touches and
# would bring that failure mode straight back.
install_probe() {
  local where="$work/$1"
  shift
  mkdir -p "$where"
  printf '{"name":"probe-host","version":"0.0.0","private":true}' > "$where/package.json"

  if ! (
    cd "$where"
    PROBE_MARKER="$where/marker.txt" npm install --no-audit --no-fund "$@" "$tarball"
  ) > "$where/npm.log" 2>&1; then
    echo "::error::the probe install failed, so this check proves nothing either way. npm said:"
    cat "$where/npm.log"
    exit 1
  fi

  # The package is there whether or not its script ran. Without this, an install that
  # silently pulled nothing would look exactly like a suppressed postinstall.
  if [ ! -d "$where/node_modules/install-script-probe" ]; then
    echo "::error::the probe install reported success but installed no probe. npm said:"
    cat "$where/npm.log"
    exit 1
  fi
}

postinstall_ran() {
  test -f "$work/$1/marker.txt"
}

install_probe control
if ! postinstall_ran control; then
  echo "::error::the probe never ran its own postinstall, so this check cannot tell you anything."
  echo "::error::Either the probe is broken, or this npm no longer runs install scripts without being asked -- which would be good news, and still needs this control rewritten to say so."
  exit 1
fi
echo "Control: installed without the flag, and the postinstall ran."

install_probe guarded --ignore-scripts
if postinstall_ran guarded; then
  echo "::error::npm install --ignore-scripts ran the package's postinstall anyway. Every workflow in this repository assumes it does not."
  exit 1
fi
echo "Guarded: installed with --ignore-scripts, and the postinstall did not run."
