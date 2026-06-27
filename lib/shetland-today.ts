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
