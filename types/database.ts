export type Role =
  | 'customer'       // default — can use all OneShetland features
  | 'driver'         // approved delivery driver
  | 'business_owner' // listed in the services/business directory
  | 'employer'       // can post jobs
  | 'contributor'    // trusted community member; can submit events/notices
  | 'moderator'      // can approve/reject submitted content
  | 'admin';         // full platform access
export type DriverStatus =
  | 'not_applied'
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'suspended';
export type RunStatus = 'open' | 'full' | 'completed' | 'cancelled';
export type RequestStatus =
  | 'pending'
  | 'matched'
  | 'collected'
  | 'delivered'
  | 'cancelled';

export interface Profile {
  id: string;
  role: Role;
  full_name: string | null;
  display_name: string | null;  // public-facing name; falls back to full_name
  phone: string | null;
  avatar_url: string | null;
  bio: string | null;
  website_url: string | null;
  location_area: string | null; // e.g. "Lerwick", "Yell"
  // Ranking hint only — reorders Home for someone visiting rather than living
  // here. Never hides a section, never gates anything. See lib/audience.ts.
  audience: 'resident' | 'visiting';
  email_verified: boolean;
  is_active: boolean;
  // Games Centre — public handle shown on leaderboards. Null = "Anon".
  games_handle: string | null;
  // Payments — card on file (paying for things across the app)
  has_payment_method: boolean;
  stripe_customer_id: string | null;
  // Payouts — central Stripe Connect bank account (receiving money across the app)
  // Covers drivers, shift workers, business owners — any user who receives money.
  stripe_account_id:          string | null;
  stripe_onboarding_complete: boolean;
  stripe_payouts_enabled:     boolean;
  stripe_charges_enabled:     boolean;
  created_at: string;
  updated_at: string;
}

export interface DriverProfile {
  id: string;
  driver_status: DriverStatus;
  vehicle_type: string | null;
  vehicle_reg: string | null;
  notes: string | null;
  stripe_account_id: string | null;
  stripe_onboarding_complete: boolean;
  stripe_payouts_enabled: boolean;
  stripe_charges_enabled: boolean;
  dispute_count: number;
  flagged_for_review: boolean;
  created_at: string;
  updated_at: string;
}

export interface Region {
  id: string;
  slug: string;
  name: string;
  display_order: number;
  created_at: string;
}

export interface DeliveryCategory {
  id: string;
  slug: string;
  name: string;
  icon: string | null;
  created_at: string;
}

export interface Run {
  id: string;
  driver_id: string;
  origin_region_id: string | null;
  destination_region_id: string | null;
  destination_area: string | null;
  departure_start: string;
  departure_end: string;
  categories_accepted: string[];
  ferry_crossing: boolean;
  notes: string | null;
  status: RunStatus;
  created_at: string;
  updated_at: string;
}

export interface DeliveryRequest {
  id: string;
  customer_id: string;
  run_id: string | null;
  category_slug: string | null;
  pickup_name: string;
  pickup_location: string;
  pickup_notes: string | null;
  already_paid: boolean;
  ready_for_collection: boolean;
  destination_region_id: string | null;
  destination_area: string | null;
  destination_address: string;
  delivery_notes: string | null;
  liability_acknowledged: boolean;
  status: RequestStatus;
  created_at: string;
  updated_at: string;
}
