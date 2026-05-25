import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  RefreshControl,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { supabase } from '@/lib/supabase';
import { Card } from '@/components/ui/Card';
import { colors, fontSize, spacing, radius } from '@/constants/theme';

interface Region {
  id: string;
  slug: string;
  name: string;
  display_order: number;
  created_at: string;
}

function toSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export default function AdminRegionsScreen() {
  const router = useRouter();
  const [regions, setRegions] = useState<Region[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Add form
  const [addName, setAddName] = useState('');
  const [addOrder, setAddOrder] = useState('');
  const [adding, setAdding] = useState(false);

  // Edit state: which region is being edited
  const [editId, setEditId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editOrder, setEditOrder] = useState('');
  const [saving, setSaving] = useState(false);

  const fetchRegions = useCallback(async () => {
    const { data } = await supabase
      .from('regions')
      .select('id, slug, name, display_order, created_at')
      .order('display_order', { ascending: true })
      .order('name', { ascending: true });

    setRegions((data as Region[]) ?? []);
    setLoading(false);
    setRefreshing(false);
  }, []);

  useEffect(() => {
    fetchRegions();
  }, [fetchRegions]);

  async function handleAdd() {
    const trimmed = addName.trim();
    if (!trimmed) return;

    const slug = toSlug(trimmed);
    const order = parseInt(addOrder, 10);

    setAdding(true);
    const { error } = await supabase.from('regions').insert({
      name: trimmed,
      slug,
      display_order: isNaN(order) ? regions.length : order,
    });
    setAdding(false);

    if (error) {
      Alert.alert('Error', error.message.includes('unique') ? `A region with slug "${slug}" already exists.` : error.message);
    } else {
      setAddName('');
      setAddOrder('');
      fetchRegions();
    }
  }

  function startEdit(region: Region) {
    setEditId(region.id);
    setEditName(region.name);
    setEditOrder(String(region.display_order));
  }

  function cancelEdit() {
    setEditId(null);
    setEditName('');
    setEditOrder('');
  }

  async function handleSave(id: string) {
    const trimmed = editName.trim();
    if (!trimmed) return;

    const order = parseInt(editOrder, 10);
    setSaving(true);
    const { error } = await supabase
      .from('regions')
      .update({
        name: trimmed,
        slug: toSlug(trimmed),
        display_order: isNaN(order) ? 0 : order,
      })
      .eq('id', id);
    setSaving(false);

    if (error) {
      Alert.alert('Error', error.message);
    } else {
      cancelEdit();
      fetchRegions();
    }
  }

  function handleDelete(region: Region) {
    Alert.alert(
      'Delete region',
      `Remove "${region.name}"? This can't be undone and may affect delivery requests that reference this region.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            const { error } = await supabase.from('regions').delete().eq('id', region.id);
            if (error) {
              Alert.alert('Error', error.message);
            } else {
              fetchRegions();
            }
          },
        },
      ],
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => { setRefreshing(true); fetchRegions(); }}
            tintColor={colors.accent}
          />
        }
      >
        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()} style={styles.backLink}>
            <Text style={styles.backLinkText}>← Back</Text>
          </TouchableOpacity>
          <Text style={styles.title}>Regions</Text>
          <Text style={styles.subtitle}>
            Manage the Shetland delivery areas shown to customers.
          </Text>
        </View>

        <View style={styles.body}>
          {/* Add region form */}
          <Card style={styles.addCard}>
            <Text style={styles.addTitle}>Add region</Text>
            <View style={styles.addRow}>
              <TextInput
                style={[styles.input, styles.inputName]}
                placeholder="Region name"
                placeholderTextColor={colors.textLight}
                value={addName}
                onChangeText={setAddName}
                returnKeyType="next"
              />
              <TextInput
                style={[styles.input, styles.inputOrder]}
                placeholder="Order"
                placeholderTextColor={colors.textLight}
                value={addOrder}
                onChangeText={setAddOrder}
                keyboardType="number-pad"
                returnKeyType="done"
                onSubmitEditing={handleAdd}
              />
            </View>
            {addName.trim().length > 0 && (
              <Text style={styles.slugPreview}>
                Slug: <Text style={styles.slugValue}>{toSlug(addName)}</Text>
              </Text>
            )}
            <TouchableOpacity
              style={[styles.addBtn, (!addName.trim() || adding) && styles.addBtnDisabled]}
              onPress={handleAdd}
              disabled={!addName.trim() || adding}
            >
              {adding ? (
                <ActivityIndicator color={colors.white} size="small" />
              ) : (
                <Text style={styles.addBtnText}>+ Add region</Text>
              )}
            </TouchableOpacity>
          </Card>

          {/* Region list */}
          {loading ? (
            <Card style={styles.emptyCard}>
              <Text style={styles.emptyBody}>Loading…</Text>
            </Card>
          ) : regions.length === 0 ? (
            <Card style={styles.emptyCard}>
              <Text style={styles.emptyIcon}>🗺️</Text>
              <Text style={styles.emptyTitle}>No regions yet</Text>
              <Text style={styles.emptyBody}>Add your first delivery region above.</Text>
            </Card>
          ) : (
            <>
              <Text style={styles.count}>
                {regions.length} region{regions.length !== 1 ? 's' : ''}
              </Text>
              {regions.map((region) => {
                const isEditing = editId === region.id;
                return (
                  <Card key={region.id} style={styles.regionCard}>
                    {isEditing ? (
                      // Edit mode
                      <>
                        <Text style={styles.editHeading}>Edit region</Text>
                        <View style={styles.addRow}>
                          <TextInput
                            style={[styles.input, styles.inputName]}
                            value={editName}
                            onChangeText={setEditName}
                            placeholder="Region name"
                            placeholderTextColor={colors.textLight}
                            autoFocus
                          />
                          <TextInput
                            style={[styles.input, styles.inputOrder]}
                            value={editOrder}
                            onChangeText={setEditOrder}
                            placeholder="Order"
                            placeholderTextColor={colors.textLight}
                            keyboardType="number-pad"
                          />
                        </View>
                        {editName.trim().length > 0 && (
                          <Text style={styles.slugPreview}>
                            Slug: <Text style={styles.slugValue}>{toSlug(editName)}</Text>
                          </Text>
                        )}
                        <View style={styles.editActions}>
                          <TouchableOpacity style={styles.editCancelBtn} onPress={cancelEdit}>
                            <Text style={styles.editCancelText}>Cancel</Text>
                          </TouchableOpacity>
                          <TouchableOpacity
                            style={[styles.editSaveBtn, saving && styles.addBtnDisabled]}
                            onPress={() => handleSave(region.id)}
                            disabled={saving}
                          >
                            {saving ? (
                              <ActivityIndicator color={colors.white} size="small" />
                            ) : (
                              <Text style={styles.editSaveText}>Save</Text>
                            )}
                          </TouchableOpacity>
                        </View>
                      </>
                    ) : (
                      // View mode
                      <View style={styles.regionRow}>
                        <View style={styles.orderBadge}>
                          <Text style={styles.orderText}>{region.display_order}</Text>
                        </View>
                        <View style={styles.regionBody}>
                          <Text style={styles.regionName}>{region.name}</Text>
                          <Text style={styles.regionSlug}>{region.slug}</Text>
                        </View>
                        <View style={styles.regionActions}>
                          <TouchableOpacity
                            style={styles.editBtn}
                            onPress={() => startEdit(region)}
                          >
                            <Text style={styles.editBtnText}>Edit</Text>
                          </TouchableOpacity>
                          <TouchableOpacity
                            style={styles.deleteBtn}
                            onPress={() => handleDelete(region)}
                          >
                            <Text style={styles.deleteBtnText}>Delete</Text>
                          </TouchableOpacity>
                        </View>
                      </View>
                    )}
                  </Card>
                );
              })}
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
  title: { color: colors.white, fontSize: fontSize.xxl, fontWeight: '800', marginBottom: spacing.xs },
  subtitle: { color: 'rgba(255,255,255,0.7)', fontSize: fontSize.sm, lineHeight: 20 },

  body: { padding: spacing.lg },

  addCard: { marginBottom: spacing.md },
  addTitle: { fontSize: fontSize.md, fontWeight: '700', color: colors.navy, marginBottom: spacing.sm },
  addRow: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.xs },
  input: {
    backgroundColor: colors.offWhite,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
    fontSize: fontSize.sm,
    color: colors.textPrimary,
  },
  inputName: { flex: 1 },
  inputOrder: { width: 72 },
  slugPreview: { fontSize: fontSize.xs, color: colors.textMuted, marginBottom: spacing.sm },
  slugValue: { color: colors.navy, fontWeight: '600' },
  addBtn: {
    backgroundColor: colors.navy,
    borderRadius: radius.md,
    paddingVertical: spacing.sm + 2,
    alignItems: 'center',
    marginTop: spacing.xs,
  },
  addBtnDisabled: { opacity: 0.4 },
  addBtnText: { color: colors.white, fontSize: fontSize.sm, fontWeight: '700' },

  count: { fontSize: fontSize.sm, fontWeight: '600', color: colors.textMuted, marginBottom: spacing.md },

  emptyCard: { alignItems: 'center', paddingVertical: spacing.xxl },
  emptyIcon: { fontSize: 36, marginBottom: spacing.sm },
  emptyTitle: { fontSize: fontSize.md, fontWeight: '700', color: colors.navy, marginBottom: spacing.xs },
  emptyBody: { fontSize: fontSize.sm, color: colors.textMuted, textAlign: 'center' },

  regionCard: { marginBottom: spacing.sm },

  regionRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  orderBadge: {
    width: 32,
    height: 32,
    borderRadius: radius.full,
    backgroundColor: colors.offWhite,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.border,
  },
  orderText: { fontSize: fontSize.sm, fontWeight: '700', color: colors.navy },
  regionBody: { flex: 1 },
  regionName: { fontSize: fontSize.sm, fontWeight: '700', color: colors.navy },
  regionSlug: { fontSize: fontSize.xs, color: colors.textMuted, fontFamily: 'monospace', marginTop: 2 },

  regionActions: { flexDirection: 'row', gap: spacing.xs },
  editBtn: {
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs + 1,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  editBtnText: { fontSize: fontSize.xs, fontWeight: '600', color: colors.textMuted },
  deleteBtn: {
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs + 1,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: '#FCA5A5',
    backgroundColor: '#FFF1F2',
  },
  deleteBtnText: { fontSize: fontSize.xs, fontWeight: '600', color: '#9F1239' },

  editHeading: {
    fontSize: fontSize.sm,
    fontWeight: '700',
    color: colors.navy,
    marginBottom: spacing.sm,
  },
  editActions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.xs },
  editCancelBtn: {
    flex: 1,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
  },
  editCancelText: { fontSize: fontSize.sm, fontWeight: '600', color: colors.textMuted },
  editSaveBtn: {
    flex: 1,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: colors.navy,
    alignItems: 'center',
  },
  editSaveText: { fontSize: fontSize.sm, fontWeight: '700', color: colors.white },
});
