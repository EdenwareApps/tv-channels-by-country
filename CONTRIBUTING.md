# Contributing

Thank you for considering contributing to TV Channels by Country. All contributions are welcome.

## How to contribute

### Fix typos or names

Edit `channels/{country}.json` directly. Ensure the JSON is valid and follows the [channels schema](channels/README.md).

### Add missing channels

1. Pick the country file: `channels/{code}.json` (ISO 3166-1 alpha-2, e.g. `br`, `us`).
2. Add entries to the appropriate category (Entertainment, News, Sports, etc.).
3. Follow the compact format: omit `keywords` when derived from name, `logo`/`website` when null, `priority` when 5.

Example:

```json
{
  "name": "New Channel",
  "isFree": true
}
```

For custom search terms:

```json
{
  "name": "CJC",
  "isFree": true,
  "keywords": "cjc | canal juventude crista"
}
```

### Improve keywords

Keywords help match channels in M3U playlists. Rules:

- **Never use accents** — use ASCII (e.g. `cancao` not `canção`).
- **Excludes** — use `-keyword` to avoid matching variants (e.g. `globo -news`).
- **OR alternatives** — use `|` (e.g. `cjc | canal juventude crista`).

### Affiliates (retransmits)

Only use `retransmits` for channels that rebroadcast another network's programming. Do **not** use for sister/co-channels (e.g. Band News does not retransmit Band). See [docs/affiliates-flow.md](docs/affiliates-flow.md).

## Pull requests

1. Fork the repository.
2. Create a branch (`git checkout -b fix/add-channels-br`).
3. Make your changes.
4. Validate the data and run the tests: `npm run validate` then `npm run build && npm test`.
5. Commit with a clear message.
6. Open a PR describing the changes.

## Issues

Use GitHub Issues for:

- Bug reports
- Feature requests
- Questions or suggestions

## Data sources

For adding channels, you can use:

- Wikipedia: "List of television stations in [country]"
- [iptv-org/api](https://iptv-org.github.io/api/)
- [docs/coverage-and-sources.md](docs/coverage-and-sources.md) for more sources

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
