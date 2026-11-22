# Check an npm package on pull requests

Save this workflow as `.github/workflows/package-contents.yml`. Set `working-directory` to the folder containing your package's `package.json`. The default is the repository root.

```yaml
name: Package contents
on: [pull_request]
permissions:
  contents: read

jobs:
  package:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v6
        with:
          node-version: 22
          package-manager-cache: false
      - uses: hakm12-ship-it/tarball-atlas@v1.0.0
        with:
          working-directory: .
          require: |
            README.md
            package.json
          forbid: |
            **/*.map
            **/.env
          max-unpacked: '500000'
```

Each `require` line names one exact file. Each `forbid` line is a pattern relative to the package root. Use `*` and `?` within one path segment or `**` for zero or more segments. Blank lines are skipped. `max-unpacked` counts the bytes of all files in the package. Omit any input to skip that gate.

The action reports the packed file count, byte totals, and gate failures in the job summary. It runs npm's offline packing dry run with lifecycle scripts disabled. If you publish generated files, run your usual build step before this check and add the generated entry points to `require`.

The composite action uses Bash, Node.js 22 or newer, and npm on the runner. If the package declares a `prepare` script, use npm 11 or newer so the scan can disable that hook. The action needs only read access to the checkout.
