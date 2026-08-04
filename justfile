set shell := ["bash", "-eu", "-o", "pipefail", "-c"]

# Run every plugin's test suite (bats suites today; extend per plugin).
test:
    bats plugins/rg-flag-guard/tests/

# Watch the active R1-accelerated shadow. Override root for a later binding.
r1-watch root="/tmp/amc-r1-accel-20260729-2h-c" interval="2s":
    viddy --interval "{{interval}}" --differences --precise --unfold --exec ./scripts/r1-observe "{{root}}"
