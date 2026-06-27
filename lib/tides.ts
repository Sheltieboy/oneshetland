/**
 * tides.ts — official UK tide times via the Admiralty UK Tidal API.
 *
 * Free "Discovery" tier: register at
 *   https://admiraltyapi.portal.azure-api.net/  → subscribe to "UK Tidal API – Discovery"
 * then put the key in your env as EXPO_PUBLIC_ADMIRALTY_KEY.
 *
 * Without a key, fetchTides() returns null and the tide strip simply hides —
 * we never show invented tide times (this is a maritime community).
 *
 * The API is station-based, so we fetch the station list once (cached), find the
 * nearest station to the given coordinates, then read its tidal events. That
 * makes it work for both Lerwick and the "Near me" toggle.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const BASE = 'https://admiraltyapi.azure-api.net/uktidalapi/api/V1';
const KEY = process.env.EXPO_PUBLIC_ADMIRALTY_KEY ?? '';

const STATIONS_KEY = 'admiralty_stations_v1';
const STATIONS_TTL = 30 * 24 * 3600 * 1000; // 30 days — the station list is near-static

export interface TideEvent {
  type:     'flow' | 'ebb';   // HighWater → flow, LowWater → ebb
  time:     string;           // "04:12" local
  fraction: number;           // 0..1 position across the day (for the timeline)
}
export interface TideResult {
  stationName: string;
  events:      TideEvent[];   // today's events, in order
}

interface Station { id: string; name: string; lat: number; lng: number; }

let stationsMem: Station[] | null = null;

export function tidesEnabled(): boolean { return !!KEY; }

const HEADERS = { 'Ocp-Apim-Subscription-Key': KEY };

async function getStations(): Promise<Station[]> {
  if (stationsMem) return stationsMem;
  try {
    const raw = await AsyncStorage.getItem(STATIONS_KEY);
    if (raw) {
      const { at, data } = JSON.parse(raw);
      if (Date.now() - at < STATIONS_TTL && Array.isArray(data) && data.length) {
        stationsMem = data;
        return data;
      }
    }
  } catch { /* ignore cache errors */ }

  const res = await fetch(`${BASE}/Stations`, { headers: HEADERS });
  if (!res.ok) throw new Error(`stations ${res.status}`);
  const json = await res.json();
  const data: Station[] = (json?.features ?? [])
    .map((f: any) => ({
      id:   f?.properties?.Id,
      name: f?.properties?.Name,
      lat:  f?.geometry?.coordinates?.[1],
      lng:  f?.geometry?.coordinates?.[0],
    }))
    .filter((s: Station) => s.id && typeof s.lat === 'number' && typeof s.lng === 'number');
  stationsMem = data;
  try { await AsyncStorage.setItem(STATIONS_KEY, JSON.stringify({ at: Date.now(), data })); } catch { /* ignore */ }
  return data;
}

function distSq(aLat: number, aLng: number, bLat: number, bLng: number): number {
  // Good enough for "nearest" comparison at these latitudes — no need for haversine.
  const dLat = aLat - bLat;
  const dLng = (aLng - bLng) * Math.cos((aLat * Math.PI) / 180);
  return dLat * dLat + dLng * dLng;
}

function nearestStation(stations: Station[], lat: number, lng: number): Station | null {
  let best: Station | null = null;
  let bestD = Infinity;
  for (const s of stations) {
    const d = distSq(lat, lng, s.lat, s.lng);
    if (d < bestD) { bestD = d; best = s; }
  }
  return best;
}

/** Parse an Admiralty UTC DateTime ("2026-06-26T03:12:00") to a local Date. */
function toLocal(iso: string): Date {
  const hasTz = /[zZ]$|[+\-]\d\d:?\d\d$/.test(iso);
  return new Date(hasTz ? iso : `${iso}Z`);
}

export async function fetchTides(coords: { lat: number; lng: number }): Promise<TideResult | null> {
  if (!KEY) return null;
  try {
    const stations = await getStations();
    const st = nearestStation(stations, coords.lat, coords.lng);
    if (!st) return null;

    const res = await fetch(`${BASE}/Stations/${st.id}/TidalEvents?duration=1`, { headers: HEADERS });
    if (!res.ok) return null;
    const arr = await res.json();
    if (!Array.isArray(arr)) return null;

    const todayDate = new Date().getDate();
    const events: TideEvent[] = arr
      .map((e: any): (TideEvent & { day: number }) | null => {
        if (!e?.DateTime) return null;
        const d = toLocal(e.DateTime);
        if (isNaN(d.getTime())) return null;
        const h = d.getHours();
        const m = d.getMinutes();
        return {
          type:     e.EventType === 'HighWater' ? 'flow' : 'ebb',
          time:     `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`,
          fraction: (h * 60 + m) / 1440,
          day:      d.getDate(),
        };
      })
      .filter((e): e is TideEvent & { day: number } => !!e && e.day === todayDate)
      .map(({ day, ...e }) => e);

    return { stationName: st.name, events };
  } catch {
    return null;
  }
}
