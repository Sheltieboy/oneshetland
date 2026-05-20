import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  Alert,
  Image,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { supabase } from '@/lib/supabase';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { colors, fontSize, spacing, radius } from '@/constants/theme';

interface Application {
  id: string;
  vehicle_type: string | null;
  vehicle_reg: string | null;
  notes: string | null;
  created_at: string;
  driver_status: string;
  profile: {
    full_name: string;
    email: string;
  } | null;
}

export default function DriverApprovalsScreen() {
  const router = useRouter();
  const [applications, setApplications] = useState<Application[]>([]);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState<string | null>(null);

  useEffect(() => {
    fetchApplications();
  }, []);

  async function fetchApplications() {
    setLoading(true);
    const { data } = await supabase
      .from('driver_profiles')
      .select('id, vehicle_type, vehicle_reg, notes, created_at, driver_status, profile:profiles(full_name, email)')
      .eq('driver_status', 'pending')
      .order('created_at', { ascending: true });
    setApplications((data as Application[]) ?? []);
    setLoading(false);
  }

  async function handleDecision(id: string, decision: 'approved' | 'rejected') {
    const name = applications.find((a) => a.id === id)?.profile?.full_name ?? 'this driver';
    const label = decision === 'approved' ? 'Approve' : 'Reject';

    Alert.alert(
      `${label} application?`,
      decision === 'approved'
        ? `${name} will be able to create runs immediately.`
        : `${name}'s application will be marked as rejected.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: label,
          style: decision === 'rejected' ? 'destructive' : 'default',
          onPress: async () => {
            setActing(id);

            const { error } = await supabase
              .from('driver_profiles')
              .update({ driver_status: decision })
              .eq('id', id);

            setActing(null);

            if (error) {
              Alert.alert('Could not update application', error.message);
              return;
            }

            // Remove from list
            setApplications((prev) => prev.filter((a) => a.id !== id));
            Alert.alert(
              decision === 'approved' ? 'Driver approved ✅' : 'Application rejected',
              decision === 'approved'
                ? `${name} can now create runs.`
                : `${name} has been notified.`,
            );
          },
        },
      ],
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>

        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()} style={styles.backLink}>
            <Text style={styles.backLinkText}>← Back</Text>
          </TouchableOpacity>
          <View style={styles.brandRow}>
            <View style={styles.logoCircle}>
              <Image source={require('../../assets/icon.png')} style={styles.logoImage} resizeMode="contain" />
            </View>
            <Text style={styles.brandName}>OneShetland Fetch</Text>
          </View>
          <Text style={styles.title}>Driver applications</Text>
          <Text style={styles.subtitle}>
            Review and approve drivers before they can create runs.
          </Text>
        </View>

        <View style={styles.body}>
          {loading ? (
            <Card style={styles.emptyCard}>
              <Text style={styles.emptyBody}>Loading applications…</Text>
            </Card>
          ) : applications.length === 0 ? (
            <Card style={styles.emptyCard}>
              <Text style={styles.emptyIcon}>🎉</Text>
              <Text style={styles.emptyTitle}>All caught up</Text>
              <Text style={styles.emptyBody}>No pending driver applications right now.</Text>
            </Card>
          ) : (
            <>
              <Text style={styles.count}>
                {applications.length} pending application{applications.length !== 1 ? 's' : ''}
              </Text>
              {applications.map((app) => (
                <Card key={app.id} style={styles.appCard}>
                  {/* Applicant */}
                  <View style={styles.applicantRow}>
                    <View style={styles.avatar}>
                      <Text style={styles.avatarText}>
                        {(app.profile?.full_name ?? 'D')[0].toUpperCase()}
                      </Text>
                    </View>
                    <View style={styles.applicantInfo}>
                      <Text style={styles.applicantName}>
                        {app.profile?.full_name ?? 'Unknown'}
                      </Text>
                      <Text style={styles.applicantEmail}>
                        {app.profile?.email ?? ''}
                      </Text>
                    </View>
                    <Text style={styles.appDate}>
                      {new Date(app.created_at).toLocaleDateString('en-GB', {
                        day: 'numeric', month: 'short',
                      })}
                    </Text>
                  </View>

                  <View style={styles.divider} />

                  {/* Vehicle */}
                  <View style={styles.detailRow}>
                    <Text style={styles.detailLabel}>Vehicle</Text>
                    <Text style={styles.detailValue}>{app.vehicle_type ?? '—'}</Text>
                  </View>
                  <View style={styles.detailRow}>
                    <Text style={styles.detailLabel}>Registration</Text>
                    <Text style={[styles.detailValue, styles.reg]}>{app.vehicle_reg ?? '—'}</Text>
                  </View>

                  {/* Statement */}
                  {app.notes && (
                    <View style={styles.statementBox}>
                      <Text style={styles.statementLabel}>About the applicant</Text>
                      <Text style={styles.statementText}>{app.notes}</Text>
                    </View>
                  )}

                  {/* Actions */}
                  <View style={styles.actions}>
                    <Button
                      label="Approve"
                      onPress={() => handleDecision(app.id, 'approved')}
                      loading={acting === app.id}
                      variant="secondary"
                      size="md"
                      style={styles.approveBtn}
                    />
                    <Button
                      label="Reject"
                      onPress={() => handleDecision(app.id, 'rejected')}
                      loading={acting === app.id}
                      variant="ghost"
                      size="md"
                      style={styles.rejectBtn}
                    />
                  </View>
                </Card>
              ))}
            </>
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.navy },
  content: { backgroundColor: colors.screenBackground, paddingBottom: spacing.xxl, flexGrow: 1 },

  header: {
    backgroundColor: colors.navy,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.xl,
  },
  backLink: { marginBottom: spacing.md },
  backLinkText: { color: 'rgba(255,255,255,0.7)', fontSize: fontSize.sm },
  brandRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  logoCircle: {
    width: 32, height: 32, borderRadius: 16,
    backgroundColor: colors.white,
    alignItems: 'center', justifyContent: 'center', padding: 2,
  },
  logoImage: { width: 28, height: 28, borderRadius: 14 },
  brandName: { color: colors.white, fontSize: fontSize.sm, fontWeight: '700', opacity: 0.9 },
  title: { color: colors.white, fontSize: fontSize.xxl, fontWeight: '800', marginBottom: spacing.xs },
  subtitle: { color: 'rgba(255,255,255,0.7)', fontSize: fontSize.sm, lineHeight: 20 },

  body: { padding: spacing.lg },
  count: {
    fontSize: fontSize.sm,
    fontWeight: '600',
    color: colors.textMuted,
    marginBottom: spacing.md,
  },

  emptyCard: { alignItems: 'center', paddingVertical: spacing.xxl },
  emptyIcon: { fontSize: 36, marginBottom: spacing.sm },
  emptyTitle: { fontSize: fontSize.md, fontWeight: '700', color: colors.navy, marginBottom: spacing.xs },
  emptyBody: { fontSize: fontSize.sm, color: colors.textMuted, textAlign: 'center' },

  appCard: { marginBottom: spacing.md },
  applicantRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  avatar: {
    width: 44, height: 44, borderRadius: radius.full,
    backgroundColor: colors.accent,
    alignItems: 'center', justifyContent: 'center',
  },
  avatarText: { color: colors.white, fontWeight: '800', fontSize: fontSize.lg },
  applicantInfo: { flex: 1 },
  applicantName: { fontSize: fontSize.md, fontWeight: '700', color: colors.navy },
  applicantEmail: { fontSize: fontSize.sm, color: colors.textMuted },
  appDate: { fontSize: fontSize.xs, color: colors.textLight },

  divider: { height: 1, backgroundColor: colors.border, marginVertical: spacing.md },

  detailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: spacing.xs,
  },
  detailLabel: { fontSize: fontSize.sm, color: colors.textMuted },
  detailValue: { fontSize: fontSize.sm, fontWeight: '600', color: colors.textPrimary },
  reg: {
    fontFamily: 'monospace',
    backgroundColor: colors.offWhite,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 4,
    overflow: 'hidden',
  },

  statementBox: {
    backgroundColor: colors.offWhite,
    borderRadius: radius.md,
    padding: spacing.md,
    marginTop: spacing.sm,
  },
  statementLabel: {
    fontSize: fontSize.xs,
    fontWeight: '700',
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: spacing.xs,
  },
  statementText: { fontSize: fontSize.sm, color: colors.textPrimary, lineHeight: 20 },

  actions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md },
  approveBtn: { flex: 1 },
  rejectBtn: { flex: 1 },
});
