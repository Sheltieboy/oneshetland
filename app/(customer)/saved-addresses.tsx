import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,

  StyleSheet,
  TouchableOpacity,
  Alert,
  RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useAuth } from '@/context/AuthContext';
import { supabase } from '@/lib/supabase';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { FormScrollView } from '@/components/ui/FormScrollView';
import { Input, KeyboardDoneBar } from '@/components/ui/Input';
import { colors, fontSize, spacing, radius } from '@/constants/theme';

interface SavedAddress {
  id: string;
  label: string;
  address: string;
  postcode: string | null;
  delivery_instructions: string | null;
  created_at: string;
}

export default function SavedAddressesScreen() {
  const router = useRouter();
  const { profile } = useAuth();

  const [addresses, setAddresses] = useState<SavedAddress[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);

  // New address form
  const [label, setLabel] = useState('');
  const [address, setAddress] = useState('');
  const [postcode, setPostcode] = useState('');
  const [deliveryInstructions, setDeliveryInstructions] = useState('');

  const fetchAddresses = useCallback(async () => {
    if (!profile?.id) return;
    const { data } = await supabase
      .from('saved_addresses')
      .select('id, label, address, postcode, delivery_instructions, created_at')
      .eq('user_id', profile.id)
      .order('created_at', { ascending: false });
    setAddresses((data as SavedAddress[]) ?? []);
    setLoading(false);
    setRefreshing(false);
  }, [profile?.id]);

  useEffect(() => {
    fetchAddresses();
  }, [fetchAddresses]);

  function onRefresh() {
    setRefreshing(true);
    fetchAddresses();
  }

  async function handleSave() {
    if (!address.trim()) {
      Alert.alert('Address required', 'Please enter an address before saving.');
      return;
    }
    if (!label.trim()) {
      Alert.alert('Label required', 'Give this address a name, e.g. "Home" or "Mum\'s house".');
      return;
    }

    setSaving(true);
    const { error } = await supabase.from('saved_addresses').insert({
      user_id: profile?.id,
      label: label.trim(),
      address: address.trim(),
      postcode: postcode.trim() || null,
      delivery_instructions: deliveryInstructions.trim() || null,
    });
    setSaving(false);

    if (error) {
      Alert.alert('Could not save address', error.message);
      return;
    }

    setLabel('');
    setAddress('');
    setPostcode('');
    setDeliveryInstructions('');
    setAdding(false);
    fetchAddresses();
  }

  async function handleDelete(id: string, addressLabel: string) {
    Alert.alert(
      'Remove address?',
      `Remove "${addressLabel}" from your saved addresses?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            await supabase.from('saved_addresses').delete().eq('id', id);
            setAddresses((prev) => prev.filter((a) => a.id !== id));
          },
        },
      ],
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <KeyboardDoneBar />
      <FormScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} />
        }
      >
        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()} style={styles.backLink}>
            <Text style={styles.backLinkText}>← Back</Text>
          </TouchableOpacity>
          <Text style={styles.title}>Saved addresses</Text>
          <Text style={styles.subtitle}>
            Save your frequent delivery addresses for faster requests.
          </Text>
        </View>

        <View style={styles.body}>
          {/* Add new */}
          {adding ? (
            <Card style={styles.addCard}>
              <Text style={styles.addCardTitle}>New address</Text>
              <Input
                label="Label"
                value={label}
                onChangeText={setLabel}
                placeholder="e.g. Home, Mum's house, Work"
                hint="A short name so you can find it quickly."
              />
              <Input
                label="Address"
                value={address}
                onChangeText={setAddress}
                placeholder="Street address"
                hint="Include house number and street."
              />
              <Input
                label="Postcode"
                value={postcode}
                onChangeText={setPostcode}
                placeholder="e.g. ZE1 0AA"
                hint="Optional but helps the driver's satnav."
                autoCapitalize="characters"
              />
              <Input
                label="Delivery instructions (optional)"
                value={deliveryInstructions}
                onChangeText={setDeliveryInstructions}
                placeholder="e.g. Leave at the blue door, ring bell twice"
                hint="Shown to the driver when they deliver here."
                multiline
                numberOfLines={3}
                style={{ minHeight: 72, textAlignVertical: 'top' }}
              />
              <View style={styles.addActions}>
                <Button
                  label="Save address"
                  onPress={handleSave}
                  loading={saving}
                  variant="secondary"
                  size="md"
                  style={styles.saveBtn}
                />
                <Button
                  label="Cancel"
                  onPress={() => {
                    setAdding(false);
                    setLabel('');
                    setAddress('');
                    setPostcode('');
                    setDeliveryInstructions('');
                  }}
                  variant="ghost"
                  size="md"
                  style={styles.cancelBtn}
                />
              </View>
            </Card>
          ) : (
            <Button
              label="+ Add address"
              onPress={() => setAdding(true)}
              variant="secondary"
              size="md"
              fullWidth
              style={styles.addButton}
            />
          )}

          {/* List */}
          {loading ? (
            <Card style={styles.emptyCard}>
              <Text style={styles.emptyBody}>Loading…</Text>
            </Card>
          ) : addresses.length === 0 && !adding ? (
            <Card style={styles.emptyCard}>
              <Text style={styles.emptyIcon}>📍</Text>
              <Text style={styles.emptyTitle}>No saved addresses</Text>
              <Text style={styles.emptyBody}>
                Add your home address or anywhere you regularly receive deliveries.
              </Text>
            </Card>
          ) : (
            addresses.map((addr) => (
              <Card key={addr.id} style={styles.addressCard}>
                <View style={styles.addressRow}>
                  <View style={styles.addressIcon}>
                    <Text style={styles.addressIconText}>📍</Text>
                  </View>
                  <View style={styles.addressInfo}>
                    <Text style={styles.addressLabel}>{addr.label}</Text>
                    <Text style={styles.addressText}>{addr.address}</Text>
                    {addr.postcode && (
                      <Text style={styles.addressPostcode}>{addr.postcode}</Text>
                    )}
                    {addr.delivery_instructions && (
                      <Text style={styles.addressInstructions}>💬 {addr.delivery_instructions}</Text>
                    )}
                  </View>
                  <TouchableOpacity
                    onPress={() => handleDelete(addr.id, addr.label)}
                    style={styles.deleteButton}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  >
                    <Text style={styles.deleteText}>✕</Text>
                  </TouchableOpacity>
                </View>
              </Card>
            ))
          )}
        </View>
      </FormScrollView>
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
  title: { color: colors.white, fontSize: fontSize.xxl, fontWeight: '800', marginBottom: spacing.xs },
  subtitle: { color: 'rgba(255,255,255,0.7)', fontSize: fontSize.sm, lineHeight: 20 },

  body: { padding: spacing.lg, gap: spacing.sm },

  addButton: { marginBottom: spacing.sm },
  addCard: { marginBottom: spacing.sm },
  addCardTitle: {
    fontSize: fontSize.md,
    fontWeight: '700',
    color: colors.navy,
    marginBottom: spacing.md,
  },
  addActions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.xs },
  saveBtn: { flex: 1 },
  cancelBtn: { flex: 1 },

  emptyCard: { alignItems: 'center', paddingVertical: spacing.xxl },
  emptyIcon: { fontSize: 36, marginBottom: spacing.sm },
  emptyTitle: { fontSize: fontSize.md, fontWeight: '700', color: colors.navy, marginBottom: spacing.xs },
  emptyBody: { fontSize: fontSize.sm, color: colors.textMuted, textAlign: 'center' },

  addressCard: {},
  addressRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
  addressIcon: {
    width: 36,
    height: 36,
    borderRadius: radius.full,
    backgroundColor: colors.offWhite,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  addressIconText: { fontSize: 18 },
  addressInfo: { flex: 1 },
  addressLabel: { fontSize: fontSize.md, fontWeight: '700', color: colors.navy, marginBottom: 2 },
  addressText: { fontSize: fontSize.sm, color: colors.textPrimary, marginBottom: 2 },
  addressPostcode: { fontSize: fontSize.sm, color: colors.textMuted },
  addressInstructions: { fontSize: fontSize.sm, color: colors.textMuted, marginTop: 4, lineHeight: 18 },
  deleteButton: { padding: spacing.xs },
  deleteText: { fontSize: fontSize.sm, color: colors.textLight, fontWeight: '600' },
});
