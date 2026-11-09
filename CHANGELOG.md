# ChangeLog

## Unreleased

- Fix bubblewrap setup failing when its AppArmor profile already exists on the runner.

## v1.2.1 (2026-03-31)

- Error reporting now surfaces the full error tree, including cause chains and `AggregateError` sub-errors.

## v1.2.0 (2026-03-30)

- The `publish` action now warns when immutable releases are not enabled for the repository.
- Added `install-bubblewrap` input to the `build` action to automatically install bubblewrap and configure AppArmor before building (defaults to `true` when `sandbox: bubblewrap`).

## v1.1.0 (2026-03-24)

- Added `sandbox` option to the `build` action to isolate gem builds and hooks using bubblewrap, preventing subprocesses from accessing secrets.
- Strip GitHub Actions secret variables (`INPUT_*`, `GITHUB_TOKEN`, `ACTIONS_*`) from the environment before spawning gem build and hook processes.
- Attestation is automatically skipped when the build action runs in a pull request from a forked repository.
- Build action now verifies by default that the triggering tag is an annotated tag with a GitHub-verified signature (Opt out by setting `verify-tag: false`).
- Third-party registries: API keys are now read from `~/.gem/credentials` (the standard RubyGems credential store).

## v1.0.3 (2026-03-15)

- Add sbom input to attach an SBOM attestation to the build. It automatically detects CyclondDX and SPDX 2.x/3.x formats.
- Provenance attestation is now a single multi-subject bundle covering all the gems built in a job.

## v1.0.2 (2026-03-06)

- Moved to <https://github.com/release-gems/action>.

## v1.0.1 (2026-03-06)

## v1.0.0 (2026-03-06)

- Initial release
