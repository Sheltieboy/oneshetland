/**
 * shetland-today.ts
 * A tiny "today at a glance" snapshot for Lerwick — current weather plus
 * sunrise/sunset and daylight length. Powered by Open-Meteo (free, no API key).
 *
 * Tides are intentionally omitted: a reliable UK tide feed (UKHO/Admiralty)
 * needs a paid key, so we keep this dependency-free. Easy to add later.
 */

const LERWICK = { lat: 60.1551, lng: -1.1481 };

export interface TodaySnapshot {
  tempC:        number | null;
  weatherCode:  number | null;
  sunrise:      string;   // "04:12"
  sunset:       string;   // "22:31"
  daylight:     string;   // "18h 19m"
}

export interface WeatherLook {
  icon:  string;   // FontAwesome5 name
  label: string;
}

/** Map a WMO weather code to an icon + short label. */
export function describeWeather(code: number | null): WeatherLook {
  if (code == null) return { icon: 'cloud', label: '—' };
  if (code === 0)             return { icon: 'sun',                  label: 'Clear' };
  if (code <= 2)              return { icon: 'cloud-sun',            label: 'Partly cloudy' };
  if (code === 3)             return { icon: 'cloud',                label: 'Overcast' };
  if (code === 45 || code === 48) return { icon: 'smog',            label: 'Fog' };
  if (code >= 51 && code <= 57)   return { icon: 'cloud-rain',      label: 'Drizzle' };
  if (code >= 61 && code <= 67)   return { icon: 'cloud-showers-heavy', label: 'Rain' };
  if (code >= 71 && code <= 77)   return { icon: 'snowflake',       label: 'Snow' };
  if (code >= 80 && code <= 82)   return { icon: 'cloud-showers-heavy', label: 'Showers' };
  if (code >= 85 && code <= 86)   return { icon: 'snowflake',       label: 'Snow showers' };
  if (code >= 95)                 return { icon: 'bolt',            label: 'Thunder' };
  return { icon: 'cloud', label: 'Cloudy' };
}

function hhmm(iso: string): string {
  // Open-Meteo returns local ISO like "2026-06-11T04:12"
  const t = iso.split('T')[1] ?? '';
  return t.slice(0, 5);
}

function daylightBetween(sunriseIso: string, sunsetIso: string): string {
  const a = new Date(sunriseIso).getTime();
  const b = new Date(sunsetIso).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return '—';
  const mins = Math.round((b - a) / 60000);
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`;
}

export const LERWICK_COORDS = LERWICK;

/**
 * Fetch the weather + daylight snapshot for a location. Defaults to Lerwick,
 * but pass the user's own coordinates to power a "near me" toggle. Shetland is
 * all on Europe/London time, so we keep that timezone for daylight figures.
 */
export async function fetchTodaySnapshot(
  coords: { lat: number; lng: number } = LERWICK,
): Promise<TodaySnapshot | null> {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${coords.lat}&longitude=${coords.lng}` +
    `&current=temperature_2m,weather_code&daily=sunrise,sunset&forecast_days=1&timezone=Europe%2FLondon`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const d = await res.json();
    const sunrise = d?.daily?.sunrise?.[0] ?? '';
    const sunset  = d?.daily?.sunset?.[0] ?? '';
    return {
      tempC:       typeof d?.current?.temperature_2m === 'number' ? Math.round(d.current.temperature_2m) : null,
      weatherCode: typeof d?.current?.weather_code === 'number' ? d.current.weather_code : null,
      sunrise:     sunrise ? hhmm(sunrise) : '—',
      sunset:      sunset  ? hhmm(sunset)  : '—',
      daylight:    sunrise && sunset ? daylightBetween(sunrise, sunset) : '—',
    };
  } catch {
    return null;
  }
}

/* ── Conditions at showtime — for the What's On "Getting there" panel ── */

export interface EventConditions {
  tempC:       number | null;  // at the event's hour; null when beyond forecast
  weatherCode: number | null;
  sunrise:     string;
  sunset:      string;
  daylight:    string;
  simmerDim:   boolean;        // Shetland midsummer near-24h twilight
  withinForecast: boolean;     // false when too far out for Open-Meteo
}

/** The event's local (Europe/London) calendar date + hour, for hourly lookup. */
function londonDateHour(iso: string): { date: string; hour: number } | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  let hour = parseInt(get('hour'), 10);
  if (hour === 24) hour = 0;
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: Number.isFinite(hour) ? hour : 0 };
}

/**
 * Weather at the event's hour + daylight for the event's day (Open-Meteo, no key).
 * Honest nulls for weather when the event is beyond the ~16-day forecast horizon.
 */
export async function fetchEventConditions(
  coords: { lat: number; lng: number },
  startsAt: string | null | undefined,
): Promise<EventConditions> {
  const empty: EventConditions = {
    tempC: null, weatherCode: null, sunrise: '—', sunset: '—',
    daylight: '—', simmerDim: false, withinForecast: false,
  };
  const when = startsAt ? londonDateHour(startsAt) : null;
  if (!when) return empty;
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${coords.lat}&longitude=${coords.lng}` +
    `&hourly=temperature_2m,weather_code&daily=sunrise,sunset` +
    `&start_date=${when.date}&end_date=${when.date}&timezone=Europe%2FLondon`;
  try {
    const res = await fetch(url);
    if (!res.ok) return empty;
    const d = await res.json();
    const sunrise = d?.daily?.sunrise?.[0] ?? '';
    const sunset  = d?.daily?.sunset?.[0] ?? '';
    const daylight = sunrise && sunset ? daylightBetween(sunrise, sunset) : '—';
    const daylightMins = sunrise && sunset ? (new Date(sunset).getTime() - new Date(sunrise).getTime()) / 60000 : 0;
    const times: string[] = Array.isArray(d?.hourly?.time) ? d.hourly.time : [];
    const prefix = `${when.date}T${String(when.hour).padStart(2, '0')}`;
    let idx = times.findIndex((t) => t.startsWith(prefix));
    if (idx < 0) idx = times.length ? Math.min(when.hour, times.length - 1) : -1;
    const temp = idx >= 0 ? d?.hourly?.temperature_2m?.[idx] : null;
    const code = idx >= 0 ? d?.hourly?.weather_code?.[idx] : null;
    return {
      tempC:       typeof temp === 'number' ? Math.round(temp) : null,
      weatherCode: typeof code === 'number' ? code : null,
      sunrise:     sunrise ? hhmm(sunrise) : '—',
      sunset:      sunset  ? hhmm(sunset)  : '—',
      daylight,
      simmerDim:   daylightMins >= 1080,
      withinForecast: idx >= 0,
    };
  } catch {
    return empty;
  }
}
