# One place for the working root: the upstream clone, the dev T3 homes, the demo project, logs.
# Override with ALLOW_FORKING_ROOT (Windows form with forward slashes, e.g. E:/work/allow-forking).
# Sourced by tools/setup.sh, tools/demo/*.sh and tools/trials/*.sh. The same default is in tools/root.mjs.
AFW="${ALLOW_FORKING_ROOT:-D:/tmp/allow-forking}"
AFW="${AFW%/}"
# The same path in Git Bash form (/d/tmp/allow-forking).
AFP="/$(printf '%s' "${AFW:0:1}" | tr 'A-Z' 'a-z')${AFW:2}"
