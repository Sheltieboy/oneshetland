import AsyncStorage from '@react-native-async-storage/async-storage';
import { createTicketCelebrations } from '@/lib/ticket-celebration';

/** The one tracker the ticket screens share, so they cannot double-celebrate. */
export const ticketCelebrations = createTicketCelebrations({
  get: (k) => AsyncStorage.getItem(k),
  set: (k, v) => AsyncStorage.setItem(k, v),
});
