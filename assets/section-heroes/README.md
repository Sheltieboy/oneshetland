# Section hero photos

Drop one image per section here and the landing pages will pick them up
automatically. Each file should be:

* JPG or PNG
* **at least 1080 × 720** (so it stays sharp on the largest phones)
* landscape orientation
* photographically rich on the right and bottom (the title sits on the
  left-bottom of the hero) — avoid critical detail there

Suggested file names and what fits the mood:

| File                | Subject ideas                                                          |
|---------------------|------------------------------------------------------------------------|
| `memories.jpg`      | Lerwick Lodberries from the sea / peat banks at last light / a slipway |
| `da-boats.jpg`      | LK fishing boat slipping past Bressay / hauled on a stocks at Hamnavoe |
| `spik.jpg`          | A hand-knit Fair Isle jumper laid on driftwood / chalk on a black slate |
| `fetch.jpg`         | Brown-paper parcel on a harbour wall / a Royal Mail van on a single track |
| `local.jpg`         | A shop window on Commercial Street / fish at the morning auction       |
| `shifts.jpg`        | Fish boxes stacked at first light / a hand stitching a net             |
| `games.jpg`         | A fiddle on a window sill / a Spik Sprint screen reflected in spectacles |
| `events.jpg`        | Up Helly Aa galley before it's torched / a Folk Festival crowd        |
| `da-boats.jpg`      | LK hull side-profile in dock                                          |

You don't need all of them — any landing without a matching file just
falls back to a tinted gradient using the section's brand colour, which
already looks intentional. Add photos as you find them.

Once a file is in place, wire it into the screen with:

```tsx
import heroPhoto from '@/assets/section-heroes/memories.jpg';
…
<SectionHero
  section="memories"
  title="Memories"
  eyebrow="The living map"
  photo={heroPhoto}
/>
```

(The screens for Memories and Da Boats are pre-wired with these
imports — they'll start working the instant the file lands.)
