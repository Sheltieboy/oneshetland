-- ── 041_seed_heritage_memories.sql ──────────────────────────────────────────
--
-- Seed Memories with 25 curated, historically-grounded stories from across
-- 4,000 years of Shetland history. Goal: fill the map with enough real
-- content from day one that any islander who opens the app sees the place
-- they're from already pinned with something interesting.
--
-- Author attribution
--   Memories require a non-null author_id. This migration looks up the
--   first admin profile and owns the seeds from them. If no admin exists
--   yet, the migration is a no-op and prints a notice — set yourself
--   admin, then re-run.
--
-- Idempotency
--   Every seed memory carries the hidden tag 'heritage-seed' alongside
--   its visible category tags. The migration deletes any pre-existing
--   seed memories before re-inserting, so:
--     * Re-running this migration safely refreshes the seed set.
--     * You can clear all seeds with one SQL statement if you want to
--       start fresh:
--         DELETE FROM public.memories WHERE 'heritage-seed' = ANY(tags);
--
-- Sources
--   Stories are drawn from generally well-documented Shetland history.
--   Lat/lng values are approximate to the actual site (settlement
--   centroid, broch coordinates, etc). If you find a factual slip, edit
--   the row directly — these aren't sacred.
--
-- ────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_author UUID;
BEGIN
  -- Find an admin to own these seed memories. Most-recently-created admin
  -- so a freshly-promoted account works; fall back to oldest if you want.
  SELECT id INTO v_author
    FROM public.profiles
   WHERE role = 'admin'
   ORDER BY created_at DESC
   LIMIT 1;

  IF v_author IS NULL THEN
    RAISE NOTICE '041_seed_heritage_memories: no admin profile found — skipping seed. Promote a user to admin then re-run.';
    RETURN;
  END IF;

  -- Clean out any previous run so the migration is idempotent.
  DELETE FROM public.memories
   WHERE 'heritage-seed' = ANY(tags)
     AND author_id = v_author;

  -- ── 1. Prehistoric / Neolithic ───────────────────────────────────────────

  -- visibility column omitted intentionally — DEFAULT 'public' applies to every row.
  INSERT INTO public.memories (author_id, lat, lng, place_name, era, tags, title, body)
  VALUES (
    v_author, 60.30150, -1.56600, 'Staneydale', 'Neolithic',
    ARRAY['folklore','faith','heritage-seed'],
    'Staneydale "Temple"',
    'On a low rise west of Walls stands one of the largest Neolithic buildings in northern Britain — a heart-shaped hall built around 3,000 BC with walls four metres thick. Antiquarians called it a "temple" because it dwarfs the houses around it; archaeologists now suspect it was a great hall for the people of west Mainland. Charred wood found inside suggested a roof of timbers carried from as far as Norway, before Shetland''s trees ran out.'
  ),
  (
    v_author, 60.00000, -1.17900, 'Mousa', 'Iron Age',
    ARRAY['folklore','boats','heritage-seed'],
    'Mousa Broch',
    'The best-preserved broch in Scotland still rises thirteen metres above the shore of the uninhabited isle of Mousa — built around 100 BC and now over two millennia old. It was already ancient when the Norse sagas were written: in 1153 Earl Harald Maddadson''s mother Margaret was kidnapped here by her lover Erlend the Young, who held the broch against the earl''s siege. On summer nights storm petrels return to nest in its dry-stone walls and you can hear them churring inside the tower long after dark.'
  ),
  (
    v_author, 59.88000, -1.29700, 'Old Scatness', 'Iron Age',
    ARRAY['folklore','heritage-seed'],
    'Old Scatness Broch',
    'Found by accident in 1975 when the road to Sumburgh Airport was being widened, Old Scatness turned out to be an Iron Age broch surrounded by a complete village — wheelhouses, byres, smithies — occupied from about 200 BC well into Pictish times. The site sat undisturbed under farmland for fifteen centuries. A summer of full-scale excavation ran from 1995 to 2004 and turned up everything from a copper alloy stud bearing a Pictish symbol to charred barley still in the souterrains.'
  ),
  (
    v_author, 59.86000, -1.28600, 'Sumburgh Head', 'Multiple eras',
    ARRAY['folklore','crofting','faith','heritage-seed'],
    'Jarlshof — 4,000 years in one place',
    'A great storm in the 1890s tore open the dunes at the tip of the South Mainland and exposed the corner of a stone building. What lay underneath has become one of the most remarkable archaeological sites in Britain: continuous human occupation from the late Neolithic about 2,500 BC, through Bronze Age, Iron Age broch, Pictish wheelhouses, Norse longhouses, a medieval farm, and finally the 16th-century laird''s house of Earl Robert Stewart. Sir Walter Scott gave the site its name in his novel "The Pirate" — a Norse-sounding invention that stuck.'
  );

  -- ── 2. Norse / Medieval ──────────────────────────────────────────────────

  -- visibility column omitted intentionally — DEFAULT 'public' applies to every row.
  INSERT INTO public.memories (author_id, lat, lng, place_name, era, tags, title, body)
  VALUES (
    v_author, 60.18700, -1.25300, 'Tingwall', 'Norse',
    ARRAY['folklore','faith','heritage-seed'],
    'The Althing at Lawting Holm',
    'On a tiny grass islet in the Loch of Tingwall — once joined to the shore by a stone causeway — the Norse parliament of Shetland sat for several centuries. The lawmen and freemen rowed or walked across to hear cases and make law: one of the oldest open-air democratic assemblies in Britain. The althing was still meeting here when Shetland was pledged to Scotland in 1469, and only quietly faded out after 1611 when Scots law replaced Norse custom. The Law Rock and the holm are still there.'
  ),
  (
    v_author, 60.81100, -0.81100, 'Haroldswick', 'Norse / Recent',
    ARRAY['boats','folklore','heritage-seed'],
    'Skidbladner — a Norse longship in Unst',
    'In 2000 a full-scale replica of the Gokstad ship was built at Haroldswick on Unst and named Skidbladner after Freyr''s magical vessel in the eddas. She is 24 metres long, oak-built, and sits in the open beside the Unst Boat Haven as a reminder that the Norse who settled Shetland did so from boats just like her. Unst is sometimes called the most Norse place in Britain — there are more recorded Viking longhouse sites here than anywhere else outside Scandinavia.'
  );

  -- ── 3. Pre-1900 fishing, crofting, sea ──────────────────────────────────

  -- visibility column omitted intentionally — DEFAULT 'public' applies to every row.
  INSERT INTO public.memories (author_id, lat, lng, place_name, era, tags, title, body)
  VALUES (
    v_author, 60.61200, -1.29800, 'Fethaland', 'Pre-1900',
    ARRAY['fishing','boats','crofting','heritage-seed'],
    'Fethaland — the haaf at the top of the world',
    'For two centuries the most northerly point of Mainland Shetland was a summer fishing town. Crofter-fishermen rowed six-oared sixerns from Fethaland up to forty miles offshore into the haaf — the deep open sea — and slept in stone böds between trips. June to August the place was full of men, women cleaning fish, and the smell of curing cod. Steam trawlers killed it by 1900 and the families went home. The walls of the böds, the noosts cut into the beach, and the cobbled drying ground are still there above the tide.'
  ),
  (
    v_author, 60.73000, -1.02000, 'Gloup', 'Pre-1900',
    ARRAY['fishing','boats','family','heritage-seed'],
    'The Gloup Disaster, 20 July 1881',
    'A summer gale rose with no warning over the haaf grounds north-east of Yell. Ten open six-oared sixerns from Gloup and the surrounding villages were caught miles offshore. Fifty-eight men drowned in a single night — fathers, sons and brothers from the same crofting townships. The granite memorial on the cliff above Gloup lists every name and every boat. The disaster was one of the events that drove the Crofters Holdings Act of 1886 and the slow death of the open-boat haaf fishery.'
  ),
  (
    v_author, 60.00100, -1.19300, 'Hoswick', 'Pre-1900',
    ARRAY['whaling','crofting','trade','heritage-seed'],
    'The Hoswick Whale Case, 1888',
    'In September 1888 a school of 340 caaing whales was driven ashore by the men of Hoswick — a windfall worth thousands of pounds at a time when most families lived on the edge of poverty. The local laird, Henry Cheyne, claimed two-thirds of the catch under feudal rights stretching back to Norse udal law. The case went all the way to the Court of Session in Edinburgh and the villagers won. It was a turning point: the old rights of the lairds over their tenants began to fray, and three years later the Crofters Commission arrived in Shetland.'
  ),
  (
    v_author, 60.15200, -1.14000, 'Lerwick', '17th–19th century',
    ARRAY['trade','boats','heritage-seed'],
    'Da Lodberries — Lerwick''s sea-merchants',
    'Walk south along Commercial Street and the road runs between tall stone gables and the sea. The lodberries are 18th-century merchant houses built straight out onto the water, each with its own private pier so cargo could come ashore through a hatch in the floor. Dutch herring boats, smugglers, and later the agents for the Greenland whalers all unloaded here. During the Second World War one of the lodberries became a Shetland Bus drop-off point for arms and operatives bound for occupied Norway.'
  ),
  (
    v_author, 60.55500, -1.45000, 'Ronas Voe', 'Pre-war',
    ARRAY['whaling','trade','heritage-seed'],
    'The whaling stations of Ronas Voe',
    'For three decades from 1903 Norwegian-owned whaling companies ran two stations on the deep sheltered Ronas Voe — one at Olna and one at Collafirth. Steam catchers brought fin and blue whales in from the Atlantic to be flensed, boiled and rendered into oil. Local men were hired as labourers; the smell, said an old account, "carried for three miles before the wind". The stations closed in 1929 when the whaling moved south to Antarctica. The remains of the slipways and oil tanks are still visible on both sides of the voe.'
  ),
  (
    v_author, 60.08000, -1.38200, 'Hamnavoe', 'Pre-war',
    ARRAY['fishing','trade','heritage-seed'],
    'Hamnavoe and the herring boom',
    'In the years before the First World War Hamnavoe on West Burra was one of dozens of "country stations" supporting Shetland''s herring fishery. Drifters lay alongside the piers and gutting crews — many of them women travelling the British coast with the boats — packed cured herring into barrels by the thousand. The name itself is pure Norn: hamna voe, the haven inlet. The boom collapsed in the 1920s when the Russian and German export markets disappeared; the bridge that finally linked Burra to Mainland came only in 1971.'
  );

  -- ── 4. Lighthouses + sea safety ─────────────────────────────────────────

  -- visibility column omitted intentionally — DEFAULT 'public' applies to every row.
  INSERT INTO public.memories (author_id, lat, lng, place_name, era, tags, title, body)
  VALUES (
    v_author, 59.85200, -1.27200, 'Sumburgh Head', '1820s',
    ARRAY['boats','wildlife','heritage-seed'],
    'Sumburgh Head Lighthouse',
    'Built in 1821 by Robert Stevenson — grandfather of Robert Louis Stevenson — Sumburgh Head was the first lighthouse in Shetland. The white tower stands on the very tip of the South Mainland above a 100-metre cliff alive in summer with puffins, fulmars, kittiwakes and guillemots. Stevenson''s design used Aberdeen granite hauled by sea and a fixed catoptric light. The light became automatic in 1991; the keepers'' cottages now house a visitor centre with one of the best seabird viewpoints in Britain.'
  ),
  (
    v_author, 60.48500, -1.62400, 'Eshaness', '1929',
    ARRAY['boats','heritage-seed'],
    'Eshaness Lighthouse',
    'The squat white tower on Eshaness was designed in 1929 by David A. Stevenson — cousin of Robert Louis — and was the last manned lighthouse built in Shetland. It stands on a 60-metre cliff that takes the full brunt of the Atlantic, where storm waves throw spray clean over the lantern room. The light was automated in 1974. The keeper''s cottage was bought and lived in for many years by photographer Sandra Sutherland; the cliffs around it are now one of the most photographed coastlines in the islands.'
  );

  -- ── 5. Faith + community ────────────────────────────────────────────────

  -- visibility column omitted intentionally — DEFAULT 'public' applies to every row.
  INSERT INTO public.memories (author_id, lat, lng, place_name, era, tags, title, body)
  VALUES (
    v_author, 59.97100, -1.37100, 'St Ninian''s Isle', '1958',
    ARRAY['faith','folklore','school','heritage-seed'],
    'The St Ninian''s Isle Treasure',
    'In July 1958 a 15-year-old Lerwick schoolboy named Douglas Coutts, working as a volunteer on an archaeological dig inside a ruined chapel on St Ninian''s Isle, lifted a flat stone and uncovered a wooden box. Inside were 28 pieces of 8th-century Pictish silver: bowls, brooches, sword chapes, a single jawbone of a porpoise. The hoard had been hidden, probably under threat of a Viking raid, twelve centuries earlier. The originals went to the National Museum of Scotland; high-quality replicas are on permanent display at the Shetland Museum in Lerwick.'
  ),
  (
    v_author, 60.44400, -1.06900, 'Lunna', '17th c. / WWII',
    ARRAY['faith','wartime','heritage-seed'],
    'Lunna Kirk',
    'Lunna Kirk, built in 1753, is the oldest church in Shetland still in use. A leper hole in the outside wall once let sufferers hear the service without entering. In 1940 the bare and inaccessible Lunna estate became the first base of the secret Norwegian-Shetland operation that became known as the Shetland Bus. The fishing boats lay in Lunna Voe; the men slept in Lunna House. Wreaths are still laid in the kirkyard each year for the 44 Norwegians who never came back.'
  );

  -- ── 6. Music + culture ──────────────────────────────────────────────────

  -- visibility column omitted intentionally — DEFAULT 'public' applies to every row.
  INSERT INTO public.memories (author_id, lat, lng, place_name, era, tags, title, body)
  VALUES (
    v_author, 60.15700, -1.14600, 'Lerwick (Islesburgh)', '20th century',
    ARRAY['music','spik','heritage-seed'],
    'Tom Anderson and the Shetland fiddle',
    'When Tom Anderson (1910–1991) was a young man it looked as though the Shetland fiddle tradition would not survive him. By the time he died it was the strongest folk-instrument tradition in Britain. Anderson collected hundreds of old tunes from elderly fiddlers across the islands, founded the Shetland Fiddlers Society in 1960, and taught two generations of children at Islesburgh House in Lerwick. His own compositions — "Da Slockit Light", "Da Day Dawn" — are now part of the standard repertoire. Aly Bain, Catriona Macdonald, Chris Stout: all his pupils.'
  ),
  (
    v_author, 60.15500, -1.14500, 'Lerwick', 'Pre-war / Recent',
    ARRAY['up-helly-aa','music','folklore','heritage-seed'],
    'Up Helly Aa — the galley burns',
    'The midwinter fire festival as Lerwick now knows it was a Victorian re-invention of older Norse-edged customs: tar barrels rolled flaming through the streets gave way in the 1880s to torchlight processions and, in 1889, to the burning of a full-size replica Viking galley at the King George V playing field. The Guizer Jarl and his squad spend a year planning their costumes; on the last Tuesday in January the rest of the town joins them. Forty-six other Up Helly Aas now run across rural Shetland through January and February.'
  );

  -- ── 7. 20th century — war, oil, disaster ───────────────────────────────

  -- visibility column omitted intentionally — DEFAULT 'public' applies to every row.
  INSERT INTO public.memories (author_id, lat, lng, place_name, era, tags, title, body)
  VALUES (
    v_author, 60.13500, -1.27500, 'Scalloway', 'WWII',
    ARRAY['wartime','boats','heritage-seed'],
    'The Shetland Bus',
    'From 1941 a clandestine flotilla of Norwegian fishing boats ran the 200 miles of the North Sea from Shetland to occupied Norway, dropping arms, agents and wireless sets on remote fjords and bringing refugees back. The base moved from Lunna to Scalloway in 1942. Forty-four Norwegian crewmen and ten of the boats were lost — mostly in winter, on what came to be called the "Shetland Bus run." The losses ended only when the US Navy gave the operation three fast sub-chasers in late 1943. The granite memorial on Scalloway shore lists every name.'
  ),
  (
    v_author, 60.83200, -0.85100, 'Saxa Vord, Unst', 'Cold War',
    ARRAY['wartime','heritage-seed'],
    'Saxa Vord — listening across the GIUK gap',
    'On the cliff above Hermaness — the most northerly point in the United Kingdom — the RAF opened a radar station in 1957 to watch the Greenland-Iceland-UK gap for Soviet aircraft and submarines. At its peak Saxa Vord employed several hundred personnel and supported a small village in the heather. It closed in 2006 as defence priorities shifted south; the runway and domes lay abandoned until 2018, when the site began a second life as a UK Space Command launch facility.'
  ),
  (
    v_author, 60.45300, -1.30200, 'Sullom Voe', '1970s',
    ARRAY['trade','family','heritage-seed'],
    'Sullom Voe and the oil years',
    'When North Sea oil came ashore at Sullom Voe in 1978 it changed Shetland more profoundly than anything since the Norse. At its 1981 opening by HM the Queen it was the largest oil terminal in Europe. The Shetland Charitable Trust, funded by a hard-bargained disturbance levy on every barrel, gave the islands schools, leisure centres, sheltered housing, ferries and music tuition that few rural areas in Britain enjoy. The terminal is quieter now — output from the Brent and Ninian fields has dropped — but the trust fund built on those years still pays for much of island life.'
  ),
  (
    v_author, 59.88000, -1.37800, 'Garth''s Ness, Quendale', '1993',
    ARRAY['boats','wildlife','heritage-seed'],
    'The Braer disaster',
    'On the morning of 5 January 1993, the Liberian-registered tanker MV Braer, en route from Norway to Canada with 85,000 tonnes of light crude oil, lost engine power in hurricane-force winds off Sumburgh and drifted onto the rocks at Garth''s Ness. For the first days the spill looked as though it would dwarf the Exxon Valdez. In the end the lighter Norwegian crude dispersed with the storm; the environmental damage, while real, was far less than feared. The lessons drove new traffic-routing rules for the waters around Shetland that remain in force today.'
  );

  -- ── 8. Notable people ──────────────────────────────────────────────────

  -- visibility column omitted intentionally — DEFAULT 'public' applies to every row.
  INSERT INTO public.memories (author_id, lat, lng, place_name, era, tags, title, body)
  VALUES (
    v_author, 60.15500, -1.14500, 'Lerwick', 'Pre-1900',
    ARRAY['school','family','heritage-seed'],
    'Sir Robert Stout, Premier of New Zealand',
    'Robert Stout was born in Lerwick in 1844, the son of a merchant. He left school at 13, worked as a schoolteacher and surveyor, then emigrated to Otago, New Zealand in 1863. He read law, entered parliament, and twice served as Premier of New Zealand (1884–87). A radical liberal, he championed women''s suffrage — New Zealand became the first country in the world to give women the vote in 1893 — and free education. Knighted in 1886, Chief Justice from 1899 to 1926, he never lost his Shetland accent.'
  );

  -- ── 9. Outer islands ───────────────────────────────────────────────────

  -- visibility column omitted intentionally — DEFAULT 'public' applies to every row.
  INSERT INTO public.memories (author_id, lat, lng, place_name, era, tags, title, body)
  VALUES (
    v_author, 60.13500, -2.06000, 'Foula', 'Multiple eras',
    ARRAY['spik','crofting','folklore','family','heritage-seed'],
    'Foula — Shetland''s outpost',
    'Twenty miles west of the Mainland, Foula''s 30-odd residents live under the highest sea cliffs in Britain (the Kame, 376 m) and one of the most reliably stormy patches of Atlantic. The Norn language survived here later than anywhere else — last fluent speakers c. 1850 — and the island still celebrates Yule on the old Julian calendar (6 January) instead of 25 December. The 1937 silent film "The Edge of the World" was shot here. Boat and small plane connections to Mainland are weather-dependent; a Foula trip can become a week long.'
  ),
  (
    v_author, 59.53400, -1.62000, 'Fair Isle', 'Multiple eras',
    ARRAY['textiles','wildlife','boats','heritage-seed'],
    'Fair Isle — knitting, birds, and El Gran Griffón',
    'Fair Isle sits halfway between Shetland and Orkney and has been internationally famous for two things: its multi-colour knitting patterns and its bird observatory, the first in Britain (founded 1948). Less remembered: in September 1588 the Spanish Armada flagship El Gran Griffón, blown north around Scotland in retreat, wrecked on the cliffs at Stroms Hellier. 200 of the crew survived as guests of the islanders for six weeks, eventually being shipped home. Population today is around 50.'
  );

  -- ── done ────────────────────────────────────────────────────────────────

  RAISE NOTICE '041_seed_heritage_memories: seeded 25 memories owned by admin %', v_author;
END $$;
