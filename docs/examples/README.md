# Moment Timezone example

An npm patch release nearly tripled the download size of `moment-timezone`. Compare the published archives to see where the bytes went.

| npm release | Compressed download | Unpacked file contents | Files |
| --- | ---: | ---: | ---: |
| [0.5.34](https://registry.npmjs.org/moment-timezone/0.5.34) | 217,410 B | 1,233,621 B | 22 |
| [0.5.35](https://registry.npmjs.org/moment-timezone/0.5.35) | 639,171 B | 1,663,776 B | 26 |

The new file `tzdata-latest.tar.gz` contributed 425,833 of the 430,155 additional unpacked bytes. The maintainers later removed temporary archives from the npm package. [Upstream change](https://github.com/moment/moment-timezone/pull/1000)

`before.json` and `after.json` contain published file paths, byte lengths and SHA-256 content digests. To reproduce either snapshot, download its linked tarball, record its compressed length, then enumerate the regular tar members. Strip the leading `package/` directory, hash the uncompressed contents of each file and sort by path. [0.5.34 tarball](https://registry.npmjs.org/moment-timezone/-/moment-timezone-0.5.34.tgz) · [0.5.35 tarball](https://registry.npmjs.org/moment-timezone/-/moment-timezone-0.5.35.tgz)
