# release-gems

release-gems is a GitHub Action that automates the release workflow for Ruby gems --- building, attesting, and publishing to RubyGems.org with minimal configuration.

## Prerequisites

- For publishing to RubyGems.org, configure your gem as a [trusted publisher](https://docs.rubygems.org/trusted-publishers/) on RubyGems.org, and create a GitHub Actions environment named `rubygems`.

## Quick Start

Add the following workflow to `.github/workflows/release.yml`:

```yaml
on:
  push:
    branches: [master]
    tags: ["v*"]

jobs:
  build:
    runs-on: ubuntu-latest
    permissions:
      id-token: write  # To obtain an ID token used for provenance attestation
      attestations: write  # To store the provenance on GitHub
    steps:
    - uses: actions/checkout@v4
    - uses: ruby/setup-ruby@v1
    - uses: hanazuki/release-gems/build@HASH

  publish:
    if: startsWith(github.ref, 'refs/tags/')
    needs: [build]
    environment: rubygems
    runs-on: ubuntu-slim
    permissions:
      contents: write  # To create a GitHub release and publish assets
      id-token: write  # To obtain an ID token to log in RubyGems.org as a trusted publisher
    steps:
    - uses: hanazuki/release-gems/publish@HASH
```

Replace `HASH` with the commit SHA or tag of the release-gems release you want to pin to.

## Releasing

Push a tag to trigger a release:

```sh
git tag v1.2.0
git push origin v1.2.0
```

The `build` job builds and attests the gem. The `publish` job creates a GitHub release and pushes the gem to RubyGems.org.

The gem version in your `.gemspec` must match the tag version (`v1.2.0` → `1.2.0`). A mismatch fails the build.

## Configuration

For advanced setups, create `.github/release-gems.yml`:

```yaml
gems:
- directory: .        # path relative to repo root (default: .)
  gemspec: foo.gemspec  # auto-detected if omitted and exactly one .gemspec exists
  hooks:
    prebuild: bundle exec rake generate
    postbuild: shell command
hooks:                # global hooks, run once around the entire build
  prebuild: shell command
  postbuild: shell command
registries:           # defaults to rubygems.org if omitted
- host: rubygems.org
```

All fields are optional. The config file itself is optional for single-gem repositories.

## Monorepo with per-gem versioning

For repositories with multiple gems, list each gem under `gems:`. Each gem can be released independently using per-gem tags:

```sh
git tag my-gem/v1.0.0
git push origin my-gem/v1.0.0
```

This builds and releases only `my-gem`, leaving other gems untouched.

To support per-gem tags, update your workflow trigger:

```yaml
on:
  push:
    tags: ["*/v*"]
```

## Action Inputs

### `build`

| Input | Default | Description |
|---|---|---|
| `github-token` | `secrets.GITHUB_TOKEN` | Token for uploading artifacts and creating attestations. |
| `retention-days` | GitHub account default | Artifact retention period in days. |
| `ruby` | `ruby` | Path or name of the Ruby binary. |

### `publish`

| Input | Default | Description |
|---|---|---|
| `github-token` | `secrets.GITHUB_TOKEN` | Token for downloading artifacts and managing GitHub releases. |
