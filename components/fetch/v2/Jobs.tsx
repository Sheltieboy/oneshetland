/**
 * Fetch v2 — the two job screens' content (Step 12): the requester's Fetch and the driver's job. Same states, words and rules as the
 * website (lib/fetch/present.ts, lib/fetch/flow.ts — shared byte-for-byte). Only actions valid now are offered; each confirms the exact
 * consequence and shows the server's answer. Nothing changes status locally.
 */
import React from 'react';
import { Linking, Text, View } from 'react-native';
import { spacing } from '@/constants/theme';
import { fetchMessage, type Detail, type Issue, type JobSummary, type Message, type Photo, type PhotoKind, type ReleaseReason, type TimelineEvent, type UndeliverableReason } from '@/lib/fetch-api';
import { driverActions, requesterActions } from '@/lib/fetch/flow';
import { RELEASE, UNDELIVERABLE, boardWhen, driverStatus, pounds, requesterStatus, sizeLabel, timelineFor } from '@/lib/fetch/present';
import { fetchApi } from '@/lib/fetch/transport';
import { openDirections } from '@/lib/fetch/device';
import { Messages, PaymentConfirm, PhotoSection, ReportProblem } from '@/components/fetch/v2/JobParts';
import { ActionSheet, FButton, MoneyTable, Notice, Panel, RouteLine, StatusCard, Timeline, s, stamp } from '@/components/fetch/v2/ui';

type Common = { detail: Detail; timeline: TimelineEvent[]; messages: { can_send: boolean; messages: Message[] } | null; photos: Photo[]; issues: Issue[]; now: number };
export type RequesterJobData = Common & { hint: { heading_that_way: boolean; hint?: string } | null; posted?: boolean };
export type DriverJobData = Common & { pay: JobSummary['pay'] | null; driverProblem: string | null };
type Nav = { refresh: () => void; go: (path: string) => void };

const place = (area: string | null | undefined, region: string) => `${area ? `${area}, ` : ''}${region}`;

function Issues({ issues }: { issues: Issue[] }) {
  return <>{issues.map((i) => <Text key={i.id} style={[s.body, { marginBottom: spacing.sm }]}>{i.status === 'open' ? 'Reported' : 'Resolved'} {stamp(i.created_at)}{i.resolution ? ` — ${i.resolution}` : ''}</Text>)}</>;
}

export function RequesterJob({ data, refresh, go }: { data: RequesterJobData } & Nav) {
  const r = data.detail.request;
  const actions = requesterActions(r, data.now);
  const lines: [string, number][] = [['Driver payment', r.base_fee_pence ?? 0]];
  if (r.ferry_supplement_pence) lines.push(['Ferry journey extra', r.ferry_supplement_pence]);
  if (r.waiting_fee_pence) lines.push(['Waiting time', r.waiting_fee_pence]);
  if (r.return_fee_pence) lines.push(['Return journey', r.return_fee_pence]);
  const fee = (r.total_fee_pence ?? 0) - lines.reduce((t, [, v]) => t + v, 0);
  if (fee > 0) lines.push(['OneShetland fee', fee]);
  const driverName: string = r.driver?.first_name ?? 'Your driver';

  return (
    <View>
      {data.posted && <Notice tone="ok">Your Fetch is posted. Nothing has been charged.</Notice>}
      <StatusCard status={requesterStatus(r)} />
      {r.status === 'pending' && (
        <Notice>
          <Text style={s.body}>You'll hear from us as soon as someone accepts; your card is only authorised then.</Text>
          <Text style={[s.bodyStrong, { marginTop: 4 }]}>This isn't a booking yet — a driver still needs to accept your Fetch.</Text>
          {data.hint?.heading_that_way && <Text style={[s.bodyStrong, { marginTop: 4 }]}>{data.hint.hint ?? 'A Fetch driver may be heading that way soon.'}</Text>}
          {!!r.expires_at && <Text style={[s.muted, { marginTop: 4 }]}>Open to drivers until {stamp(r.expires_at)}.</Text>}
        </Notice>
      )}
      {actions.includes('pay') && <Panel title="Payment"><PaymentConfirm requestId={r.id} paymentStatus={r.payment_status} onDone={refresh} openPayments={() => go('/payment-setup')} /></Panel>}

      <Panel>
        <RouteLine from={place(r.pickup_area, r.pickup_region)} to={place(r.destination_area, r.destination_region)} ferry={r.ferry_required} />
        <Text style={[s.bodyStrong, { marginTop: 4 }]}>{r.item_description}</Text>
        <Text style={s.body}>{sizeLabel(r.size_class)}{r.handling_flags?.includes('heavy_two_person') ? ' · two-person lift' : ''}{r.handling_flags?.includes('fragile') ? ' · fragile' : ''} · {boardWhen(r)}</Text>
        {r.driver && <Text style={[s.body, { marginTop: 4 }]}>Driver: <Text style={s.bodyStrong}>{driverName}</Text>{r.driver.vehicle_class ? ` · ${String(r.driver.vehicle_class).replace(/_/g, ' ')}` : ''}</Text>}
        {r.operational_details_visible !== false && r.pickup_location && (
          <View style={{ marginTop: spacing.sm }}>
            <Text style={s.muted}>Collect from</Text><Text style={s.body}>{r.pickup_name ? `${r.pickup_name}, ` : ''}{r.pickup_location}</Text>
            <Text style={[s.muted, { marginTop: 4 }]}>Deliver to</Text><Text style={s.body}>{r.destination_address}</Text>
            {r.safe_place_allowed && <><Text style={[s.muted, { marginTop: 4 }]}>Safe place</Text><Text style={s.body}>{r.safe_place_note || 'Allowed'}</Text></>}
          </View>
        )}
      </Panel>

      {(actions.some((a) => ['cancel', 'ask_cancel', 'extend', 'ready'].includes(a)) || (r.cancel_requested_at && r.status === 'matched')) && (
        <Panel title="What you can do">
          {r.cancel_requested_at && r.status === 'matched' && <Text style={[s.body, { marginBottom: spacing.sm }]}>You asked to cancel. Your driver can agree, or ask to go ahead; OneShetland decides if you don't agree.</Text>}
          <View style={{ gap: spacing.sm }}>
            {actions.includes('ready') && <ActionSheet trigger="The item is ready" title="Tell your driver it's ready?" confirm="Yes, it's ready" refresh={refresh}
              body="Your driver will be told the item is ready to collect." run={() => fetchApi.ready(r.id)} />}
            {actions.includes('extend') && <ActionSheet trigger="Give drivers more time" title="Keep your Fetch open longer?" confirm="Keep it open" refresh={refresh}
              body="Your Fetch stays open to drivers for longer. You can do this twice." run={() => fetchApi.extend(r.id)} />}
            {actions.includes('cancel') && <ActionSheet trigger="Cancel this Fetch" title="Cancel your Fetch?" confirm="Cancel Fetch" danger refresh={refresh}
              body="No driver has accepted yet, so it is cancelled straight away and nothing is charged."
              reason={{ label: 'Why are you cancelling?' }} run={({ reason }) => fetchApi.cancelOpen(r.id, reason || undefined)} />}
            {actions.includes('ask_cancel') && <ActionSheet trigger="Ask to cancel" title="Ask your driver to cancel?" confirm="Ask to cancel" danger refresh={refresh}
              body="A driver has already accepted. They'll be asked to agree. If they agree, nothing is charged; if they don't, OneShetland decides. The item can't be cancelled once it has been collected."
              reason={{ label: 'Why do you want to cancel?', required: true }} run={({ reason }) => fetchApi.askToCancel(r.id, reason)} />}
          </View>
        </Panel>
      )}

      <Panel title="Price">
        <MoneyTable lines={lines} total={r.total_fee_pence ?? 0} totalLabel={['delivered', 'returned'].includes(r.status) ? 'Total' : 'Expected total'} />
        {r.return_max_pence > 0 && !['delivered', 'returned', 'cancelled', 'expired'].includes(r.status) && (
          <Text style={[s.muted, { marginTop: spacing.sm }]}>The higher amount is only temporarily reserved in case there is waiting time or the item has to be returned (up to {pounds(r.return_max_pence)} for a return). You are only charged for what actually happens.</Text>
        )}
        {r.status === 'pending' && <Text style={[s.muted, { marginTop: spacing.sm }]}>Nothing is charged until delivery.</Text>}
      </Panel>

      {(actions.includes('photos') || data.photos.length > 0) && (
        <Panel title="Photos">
          <PhotoSection requestId={r.id} photos={data.photos} addKinds={actions.includes('photos') ? ['item'] : []} manageItem={r.status === 'pending'} onChange={refresh} />
          {r.size_class === 'bulky' && r.status === 'pending' && !data.photos.some((p) => p.kind === 'item') && <View style={{ marginTop: spacing.sm }}><Notice tone="warn">Bulky items need a photo before a driver can accept.</Notice></View>}
        </Panel>
      )}

      {actions.includes('message') && data.messages && (
        <Panel title={`Messages with ${driverName}`}>
          <Messages requestId={r.id} initial={data.messages.messages} canSend={data.messages.can_send} otherName={driverName} />
        </Panel>
      )}

      <Panel title="What's happened"><Timeline items={timelineFor('requester', data.timeline)} /></Panel>

      {(actions.includes('report') || data.issues.length > 0) && (
        <Panel title="Problems">
          <Issues issues={data.issues} />
          {actions.includes('report') ? <ReportProblem requestId={r.id} viewer="requester" onDone={refresh} /> : <Text style={s.muted}>Problems can be reported up to 72 hours after a Fetch finishes.</Text>}
        </Panel>
      )}
      {r.status === 'expired' && <FButton label="Post it again" kind="secondary" onPress={() => go('/fetch/new')} />}
    </View>
  );
}

/** The driver's own pay, line by line (waiting and return only once the server has set them). */
export function payLines(pay?: JobSummary['pay'] | null): [string, number][] {
  if (!pay) return [];
  const l: [string, number][] = [['Delivery', pay.delivery_pence ?? 0]];
  if (pay.ferry_pence) l.push(['Ferry journey extra', pay.ferry_pence]);
  if (pay.waiting_pence) l.push(['Waiting time', pay.waiting_pence]);
  if (pay.return_pence) l.push(['Return journey', pay.return_pence]);
  return l;
}

export function DriverJob({ data, refresh, go }: { data: DriverJobData } & Nav) {
  const { detail } = data;
  const r = detail.request;
  const arrived = r.status === 'matched' ? [...data.timeline].reverse().find((e) => e.event === 'arrived') : undefined;
  // Arrival is recorded once; after that the waiting notice replaces the button.
  const actions = driverActions(r, data.now).filter((a) => !(a === 'arrive' && arrived));
  const name: string = r.requester_first_name ?? 'The requester';
  const photoKinds: PhotoKind[] = r.status === 'matched' ? ['collection'] : r.status === 'collected' ? ['delivery', 'collection'] : r.status === 'undeliverable' ? ['return', 'delivery'] : [];
  const hasDeliveryPhoto = data.photos.some((p) => p.kind === 'delivery');
  const hasReturnPhoto = data.photos.some((p) => p.kind === 'return');
  const safePlace = !!r.safe_place_allowed;
  const next = actions.some((a) => !['photos', 'message', 'report'].includes(a));

  return (
    <View>
      <StatusCard status={driverStatus(r)} />
      {data.driverProblem && r.status === 'matched' && (
        <Notice tone="warn">
          <Text style={s.body}>{fetchMessage(data.driverProblem)} You can't collect the item until this is sorted.</Text>
          <FButton label="Your driver details" kind="quiet" onPress={() => go('/fetch/driver/verification')} />
        </Notice>
      )}
      {r.status === 'matched' && r.payment_status !== 'authorised' && !r.cancel_requested_at && (
        <Notice tone="warn">Waiting for the requester's payment to be confirmed. Please don't collect the item until this says it's ready.</Notice>
      )}
      {r.cancel_requested_at && r.status === 'matched' && <Notice tone="warn">{`${name} has asked to cancel${r.cancel_request_reason ? `: “${r.cancel_request_reason}”` : '.'} Please agree, or ask to go ahead.`}</Notice>}
      {arrived && <Notice>{`Waiting started ${stamp(arrived.created_at)}. Any waiting charge is calculated automatically.`}</Notice>}

      {next && (
        <Panel title="Next">
          <View style={{ gap: spacing.sm }}>
            {actions.includes('agree_cancel') && <ActionSheet trigger="Agree to cancel" title="Agree to cancel this job?" confirm="Agree to cancel" primary refresh={refresh}
              body="The Fetch is cancelled, the requester isn't charged, and the job comes off your list." run={() => fetchApi.agreeToCancel(r.id)} />}
            {actions.includes('decline_cancel') && <ActionSheet trigger="Ask to go ahead" title="Ask to go ahead with this job?" confirm="Ask to go ahead" refresh={refresh}
              body="OneShetland will decide whether the Fetch goes ahead. Please don't collect until it's decided."
              reason={{ label: 'Why should it go ahead?' }} run={({ reason }) => fetchApi.declineToCancel(r.id, reason || undefined)} />}
            {actions.includes('arrive') && <ActionSheet trigger="I've arrived to collect" title="Tell the requester you've arrived?" confirm="I've arrived" refresh={refresh}
              body="The requester is told you're there. If you're kept waiting, the waiting time is added to your payment automatically." run={() => fetchApi.arrived(r.id)} />}
            {actions.includes('collect') && <ActionSheet trigger="I've collected the item" title="Confirm you have the item?" confirm="I've got it" primary refresh={refresh}
              body="Only confirm once the item is with you. The requester is told it's on its way." run={() => fetchApi.collected(r.id)}
              onDone={() => 'Collected. Deliver it, or tell us if you can’t.'} />}
            {actions.includes('refresh_payment') && <ActionSheet trigger="Check the payment again" title="Check the requester's payment?" confirm="Check now" refresh={refresh}
              body="We'll ask the bank for the latest state of the payment authorisation. Please don't collect until it's confirmed." run={() => fetchApi.refreshHold(r.id)}
              onDone={(res) => (res.ok && (res.data as { can_collect?: boolean }).can_collect ? 'Payment confirmed — you can collect.' : "The payment still isn't confirmed. Please don't collect yet.")} />}
            {actions.includes('deliver') && <ActionSheet trigger="I've delivered it" title="Confirm delivery?" confirm="Confirm delivery" primary refresh={refresh}
              body={safePlace ? `Choose how you handed it over. Leaving it in a safe place needs a delivery photo first${hasDeliveryPhoto ? " (you've added one)" : ' — add it under Photos'}.`
                : "Only confirm once the item has been handed over. The requester's card is then charged for what happened."}
              choices={safePlace ? { label: 'How was it delivered?', options: [{ value: 'hand', label: 'Handed to someone' }, { value: 'safe', label: 'Left in the agreed safe place' }] } : undefined}
              run={({ choice }) => fetchApi.deliver(r.id, choice === 'safe')} onDone={() => 'Delivered. Thank you!'} />}
            {actions.includes('cannot_deliver') && <ActionSheet trigger="I can't deliver it" title="Tell us you can't deliver it?" confirm="I can't deliver it" danger refresh={refresh}
              body="Keep the item safe. The requester and OneShetland are told, and you'll be asked to return it to where you collected it."
              choices={{ label: 'What happened?', options: UNDELIVERABLE }} reason={{ label: 'Anything else we should know?' }}
              run={({ choice, reason }) => fetchApi.cannotDeliver(r.id, choice as UndeliverableReason, reason || undefined)} />}
            {actions.includes('report_return') && <ActionSheet trigger="I've returned it" title="Report the return?" confirm="Report the return" refresh={refresh}
              body={`A photo of the returned item is needed${hasReturnPhoto ? " (you've added one)" : ' — add it under Photos first'}. OneShetland then reviews what happened and what you're paid.`}
              reason={{ label: 'Where did you leave it?' }} run={({ reason }) => fetchApi.reportReturn(r.id, reason || undefined)}
              onDone={() => 'Return reported — OneShetland will review this.'} />}
            {actions.includes('release') && <ActionSheet trigger="I can't do this job" title="Give this job up?" confirm="Give it up" danger refresh={refresh}
              body="The Fetch goes back to other drivers and the requester's authorisation is released. Giving jobs up often may pause your driver account."
              choices={{ label: 'Why?', options: RELEASE }} reason={{ label: 'Anything else?' }}
              run={({ choice, reason }) => fetchApi.release(r.id, choice as ReleaseReason, reason || undefined)} />}
          </View>
        </Panel>
      )}

      <Panel>
        <RouteLine from={r.pickup_region} to={r.destination_region} ferry={r.ferry_required} />
        <Text style={[s.bodyStrong, { marginTop: 4 }]}>{r.item_description}</Text>
        <Text style={s.body}>{sizeLabel(r.size_class)}{r.approx_dimensions_cm ? ` · about ${r.approx_dimensions_cm.l}×${r.approx_dimensions_cm.w}×${r.approx_dimensions_cm.h} cm` : ''}
          {r.handling_flags?.includes('heavy_two_person') ? ' · two-person lift' : ''}{r.handling_flags?.includes('fragile') ? ' · fragile' : ''} · {boardWhen(r)}</Text>
        <Text style={[s.body, { marginTop: 4 }]}>For {name}</Text>
        {detail.addresses_visible === false ? (
          <Text style={[s.muted, { marginTop: spacing.sm }]}>The exact addresses are no longer shown for this job.</Text>
        ) : r.pickup_location ? (
          <View style={{ marginTop: spacing.sm }}>
            <Text style={s.muted}>Collect from</Text>
            <Text style={s.body}>{r.pickup_name ? `${r.pickup_name}, ` : ''}{r.pickup_location}</Text>
            {!!r.pickup_notes && <Text style={s.body}>“{r.pickup_notes}”</Text>}
            {['matched'].includes(r.status) && <FButton label="Directions to the collection" kind="quiet" onPress={() => openDirections(String(r.pickup_location))} />}
            <Text style={[s.muted, { marginTop: 4 }]}>Deliver to</Text>
            <Text style={s.body}>{r.destination_address}</Text>
            {!!r.delivery_notes && <Text style={s.body}>“{r.delivery_notes}”</Text>}
            {['collected', 'undeliverable'].includes(r.status) && <FButton label="Directions to the delivery" kind="quiet" onPress={() => openDirections(String(r.destination_address))} />}
            <Text style={[s.muted, { marginTop: 4 }]}>Safe place</Text>
            <Text style={s.body}>{r.safe_place_allowed ? (r.safe_place_note || 'Allowed — take a photo') : 'Not allowed — hand it to someone'}</Text>
            {detail.phone_shared && r.contact_phone && <FButton label={`Call ${name}`} kind="quiet" onPress={() => Linking.openURL(`tel:${r.contact_phone}`)} />}
          </View>
        ) : null}
      </Panel>

      <Panel title="Your pay">
        <MoneyTable lines={payLines(data.pay)} total={r.driver_pay_pence ?? 0} totalLabel={['delivered', 'returned'].includes(r.status) ? 'You earned' : "You'll receive"} />
        {r.status === 'undeliverable' && <Text style={[s.muted, { marginTop: spacing.sm }]}>Any return payment is decided by OneShetland when it reviews the return.</Text>}
        <Text style={[s.muted, { marginTop: spacing.sm }]}>Paid to the bank account in your payouts; bank transfers can take a few working days.</Text>
        <FButton label="My payouts" kind="quiet" onPress={() => go('/(driver)/connect-bank')} />
      </Panel>

      {(actions.includes('photos') || data.photos.length > 0) && (
        <Panel title="Photos"><PhotoSection requestId={r.id} photos={data.photos} addKinds={actions.includes('photos') ? photoKinds : []} manageItem={false} onChange={refresh} /></Panel>
      )}
      {actions.includes('message') && data.messages && (
        <Panel title={`Messages with ${name}`}><Messages requestId={r.id} initial={data.messages.messages} canSend={data.messages.can_send} otherName={name} /></Panel>
      )}
      <Panel title="What's happened"><Timeline items={timelineFor('driver', data.timeline)} /></Panel>
      {(actions.includes('report') || data.issues.length > 0) && (
        <Panel title="Problems">
          <Issues issues={data.issues} />
          {actions.includes('report') ? <ReportProblem requestId={r.id} viewer="driver" onDone={refresh} /> : <Text style={s.muted}>Problems can be reported up to 72 hours after a job finishes.</Text>}
        </Panel>
      )}
    </View>
  );
}
