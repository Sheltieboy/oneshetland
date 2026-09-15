/**
 * app/payment-return.tsx
 *
 * Deep-link landing pad for Stripe PaymentSheet / SetupIntent redirects.
 *
 * Every card-collection flow that can trigger a redirect-based bank challenge
 * (3DS / SCA) passes the same returnURL: oneshetland-fetch://payment-return —
 * card setup (payment-setup.tsx), local-buy-unit, local-gift, and every saved
 * card purchase that goes through the shared stripe-sca helper (events,
 * products, hubs, local). Stripe's native SDK is *supposed* to intercept that
 * URL itself and hand the result back to whichever screen is waiting on it,
 * without this ever being routed. In practice that intercept can still let
 * the same URL reach Expo Router as well (SDK quirks, an external browser
 * hop) — when it does, this screen exists only so there is a real route to
 * land on instead of "Unmatched Route", exactly like driver/connect-return.tsx
 * does for Connect onboarding.
 *
 * This screen deliberately does NOTHING with the payment itself:
 *   - no reading/trusting of setup_intent / payment_intent query params as
 *     financial truth — that verdict belongs to the server (webhooks,
 *     confirm-card-setup, and friends), never to a client-side query string
 *   - no confirmation calls, no Stripe SDK calls, no writes of any kind
 *   - it is pure navigation: get the person off this dead-end and back to
 *     wherever they came from
 *
 * Because it is shared by many different callers, it cannot assume a single
 * destination (unlike connect-return.tsx, which always knows it's a driver).
 * It simply un-does the navigation that led here.
 */

import { useEffect } from 'react';
import { View, ActivityIndicator } from 'react-native';
import { useRouter } from 'expo-router';

export default function PaymentReturn() {
  const router = useRouter();

  useEffect(() => {
    if (router.canGoBack()) {
      router.back();
    } else {
      // No screen to return to (e.g. the app was relaunched fresh into this
      // link) — land somewhere real rather than a dead end.
      router.replace('/(tabs)');
    }
  }, []);

  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#000' }}>
      <ActivityIndicator color="#fff" />
    </View>
  );
}
