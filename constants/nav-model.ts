/**
 * nav-model.ts — the SINGLE source of truth for app navigation destinations.
 *
 * Both the phone bottom bar / "More" sheet (AppTabBar) and the tablet sidebar
 * (NavRail) render from this one list, so the two can never drift apart again.
 *
 * Jobs and Shifts are ONE destination ("Work" hub) — Shifts is reached via the
 * in-screen tier switch on Jobs, not a separate nav item.
 */

import { type Href } from 'expo-router';
import { colors } from './theme';
import { SECTIONS } from './sections';

export interface NavDest {
  label: string;
  icon:  string;
  color: string;
  /** Full path — used for navigation (router.push) and active detection. */
  href:  Href;
  /** The (tabs) screen name when this destination is a tab. Lets the phone bar
   *  switch tabs in place (navigation.navigate) rather than push. */
  route?: string;
}

export const NAV: NavDest[] = [
  { label: 'Home',                   icon: 'home',                  color: colors.accent,            href: '/(tabs)',          route: 'index' },
  { label: 'Events',                 icon: SECTIONS.events.icon,    color: SECTIONS.events.color,    href: '/(tabs)/whats-on', route: 'whats-on' },
  { label: 'Directory',              icon: SECTIONS.services.icon,  color: SECTIONS.services.color,  href: '/(tabs)/services', route: 'services' },
  { label: 'Local',                  icon: SECTIONS.local.icon,     color: SECTIONS.local.color,     href: '/(tabs)/local',    route: 'local' },
  { label: 'Jobs',                   icon: SECTIONS.jobs.icon,      color: SECTIONS.jobs.color,      href: '/(tabs)/jobs',     route: 'jobs' },
  { label: SECTIONS.memories.label,  icon: SECTIONS.memories.icon,  color: SECTIONS.memories.color,  href: '/(tabs)/memories', route: 'memories' },
  { label: SECTIONS.spik.label,      icon: SECTIONS.spik.icon,      color: SECTIONS.spik.color,      href: '/(tabs)/spik',     route: 'spik' },
  { label: SECTIONS.daBoats.label,   icon: SECTIONS.daBoats.icon,   color: SECTIONS.daBoats.color,   href: '/(tabs)/da-boats', route: 'da-boats' },
  { label: SECTIONS.fetch.label,     icon: SECTIONS.fetch.icon,     color: SECTIONS.fetch.color,     href: '/(tabs)/fetch',    route: 'fetch' },
  { label: SECTIONS.community.label, icon: SECTIONS.community.icon,  color: SECTIONS.community.color, href: '/hubs' },
  { label: SECTIONS.games.label,     icon: SECTIONS.games.icon,     color: SECTIONS.games.color,     href: '/games' },
];

export const PROFILE: NavDest = { label: 'Profile', icon: 'user', color: colors.accent, href: '/(tabs)/me', route: 'me' };

/** Number of leading destinations shown on the phone bottom bar; the rest go in "More". */
export const PHONE_PRIMARY = 5;

/** The pathname expo-router reports for a destination (group prefix + query stripped). */
export function navTargetPath(href: Href): string {
  const h = String(href).split('?')[0].replace('/(tabs)', '');
  return h === '' ? '/' : h;
}

/** Whether a destination is the active one for the current pathname. */
export function isNavActive(href: Href, pathname: string): boolean {
  const target = navTargetPath(href);
  if (target === '/') return pathname === '/' || pathname === '/index';
  return pathname === target || pathname.startsWith(target + '/');
}
