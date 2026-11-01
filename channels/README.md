# channels/ — schema

Every file in this folder is named after a country code (`ISO 3166-1 alpha-2`, lowercase) and holds the channel lineup of that country:

```
channels/
  countries.json   # list of available codes
  br.json
  pt.json
  us.json
  ...
```

`countries.json` is a plain array of the codes that have a file, plus the pseudo code `adult` (channels that only make sense in an adult-only list). Keep it sorted when you add a new country.

---

## Structure

A country file maps **category name → array of channels**:

```json
{
  "News": [
    { "name": "Globo News", "isFree": false, "priority": 9 }
  ],
  "Religious": [
    { "name": "Rede Vida", "isFree": true, "retransmits": "Rede Vida" }
  ]
}
```

Categories in use: `Entertainment`, `News`, `Sports`, `Kids`, `Movies & Series`, `Education & Culture`, `Music Videos`, `Religious`, `Shop`, `Local`, `Cooking`, `Auto`, `Travel`, `Relax`, `Comedy`, `Radios`, `Added`. Use the closest existing category instead of inventing a new one; a new category is only added when a whole country needs it.

Inside a category, channels are not sorted — order carries no meaning, `priority` does.

---

## Channel fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `string` | yes | Display name, as viewers know it. Must be unique inside the file (accent/case insensitive). |
| `keywords` | `string` | no | Extra search terms, no diacritics. `\|` separates alternatives, `-term` excludes. |
| `shortName` | `string` | no | Acronym or short name (`RTPi` for `RTP Internacional`). Also matched by `search()`. |
| `retransmits` | `string \| null` | no | Parent network, **only** for stations that rebroadcast another network. See [docs/affiliates-flow.md](../docs/affiliates-flow.md). |
| `isFree` | `boolean` | no | Free-to-air. Omitted means paid. |
| `logo` | `string \| null` | no | Logo URL (https preferred). |
| `website` | `string \| null` | no | Official site. |
| `priority` | `number` | no | `0`–`10`, relative to the country + category. Default `5`. |

### Compact format

Keep files small — omit what is implicit:

- `keywords` only when a search term is **not** derivable from `name`/`shortName`;
- `shortName` only when it is not the name itself;
- `logo`, `website`, `retransmits` only when they exist (never `null`);
- `priority` only when it differs from the default.

```json
{ "name": "Globo", "isFree": true, "priority": 10 }
```

Minimal valid entry:

```json
{ "name": "New Channel" }
```

---

## Priority rules

`priority` says how much a channel deserves a slot when a list must be trimmed. Higher = more important.

- Default is `5`. Use `0`–`4` for niche/filler, `6`–`8` for popular, `9`–`10` for must-have (main national networks).
- **Religious** channels cap at `4` and **Shop** channels at `4` when they have no `retransmits`.
- Channels with `retransmits` are raised to at least `8` — an affiliate is only useful when its parent is present.
- Paid channels (`isFree: false`) are capped at `8`.

These limits are enforced by `src/index.js` at load time, so a value above the cap in the JSON is not a bug — it is clamped. `scripts/validate-channels.js --strict` reports them; `npm run validate -- --fix` writes the clamped values back so the JSON matches what consumers actually get.

---

## Keywords

`keywords` is what the matching engine uses to find the channel in messy sources (M3U playlists, XMLTV feeds):

```json
{ "name": "CJC", "keywords": "cjc | canal juventude crista" }
```

- **No diacritics.** `cancao`, not `canção`. The matcher strips combining marks before comparing, so an accented keyword only breaks the validator. Non-Latin scripts are fine — they are kept as-is (e.g. `-страшное` in `ru.json`).
- `|` = OR alternative. `-term` = exclusion (`globo -news` skips `Globo News` once `globo` matches `Globo`).
- Add keywords when the source uses an abbreviation (`sky sp main ev`), a former name, or a regional suffix that the display name does not carry.

---

## Adding a channel

1. Pick the country file — the lineup **in that country**, which includes international channels available there (`CNN International UK`, `CBeebies Africa`).
2. Choose the category and append the entry in compact format.
3. If the channel is a rebroadcast of another network, set `retransmits` to the parent name and `priority` to `8` or more.
4. Validate and test:

```bash
npm run validate      # JSON shape, names, priorities
npm run validate -- --fix   # repair priorities, accents and duplicated names in place
npm run build         # generates dist/
npm test              # library behaviour against the built data
```

5. Open a pull request. See [CONTRIBUTING.md](../CONTRIBUTING.md).

---

## Rules of thumb

- One entry per channel, not per feed variant: `Globo HD`, `Globo` and `Globo 4K` are the same entry.
- No call signs as entries unless the station is only known by its call sign (`CBFT` in Canada).
- No test cards, promo loops, PPV events, temporary pop-up channels or placeholder names.
- No duplicated name inside a category of the same file — merge the entries instead. The same name may appear in two categories only when the channel genuinely belongs to both (e.g. `Entertainment` + `News`).
