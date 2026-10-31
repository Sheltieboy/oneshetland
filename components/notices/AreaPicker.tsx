/**
 * AreaPicker — choose Shetland areas from the canonical `areas` list (physical areas only; the Shetland-wide root is never offered).
 * Single mode picks one and closes; multi mode toggles up to `max` and confirms with Done.
 */
import React, { useMemo, useState } from 'react';
import { Modal, View, Text, TextInput, FlatList, Pressable, StyleSheet, SafeAreaView } from 'react-native';
import { FontAwesome5 } from '@expo/vector-icons';
import { colors, fontSize, radius, spacing } from '@/constants/theme';
import type { AreaOption } from '@/lib/notices-alerts-api';

export function AreaPicker({ visible, title, areas, selected, multi, max, onClose, onDone }: {
  visible: boolean; title: string; areas: AreaOption[]; selected: string[]; multi?: boolean; max?: number;
  onClose: () => void; onDone: (ids: string[]) => void;
}) {
  const [q, setQ] = useState('');
  const [draft, setDraft] = useState<string[]>(selected);
  React.useEffect(() => { if (visible) { setDraft(selected); setQ(''); } }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps
  const list = useMemo(() => {
    const t = q.trim().toLowerCase();
    return t ? areas.filter((a) => a.name.toLowerCase().includes(t)) : areas;
  }, [areas, q]);
  const atMax = !!multi && max != null && draft.length >= max;
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} presentationStyle="pageSheet">
      <SafeAreaView style={s.safe}>
        <View style={s.head}>
          <Pressable onPress={onClose} hitSlop={10} style={s.headBtn} accessibilityRole="button" accessibilityLabel="Cancel"><Text style={s.headText}>Cancel</Text></Pressable>
          <Text style={s.title} numberOfLines={1}>{title}</Text>
          {multi ? <Pressable onPress={() => onDone(draft)} hitSlop={10} style={[s.headBtn, { alignItems: 'flex-end' }]} accessibilityRole="button" accessibilityLabel="Done"><Text style={[s.headText, { fontWeight: '800' }]}>Done</Text></Pressable> : <View style={s.headBtn} />}
        </View>
        <TextInput value={q} onChangeText={setQ} placeholder="Search areas" placeholderTextColor={colors.textLight} style={s.search} accessibilityLabel="Search areas" autoCorrect={false} />
        {multi && max != null ? <Text style={s.count}>{draft.length} of {max} chosen</Text> : null}
        <FlatList
          data={list}
          keyExtractor={(a) => a.id}
          keyboardShouldPersistTaps="handled"
          ListEmptyComponent={<Text style={s.empty}>No areas match.</Text>}
          renderItem={({ item }) => {
            const on = draft.includes(item.id);
            const blocked = !on && atMax;
            return (
              <Pressable
                disabled={blocked}
                onPress={() => { if (multi) setDraft((d) => (d.includes(item.id) ? d.filter((x) => x !== item.id) : [...d, item.id])); else onDone([item.id]); }}
                accessibilityRole={multi ? 'checkbox' : 'button'} accessibilityState={{ checked: on, disabled: blocked }}
                style={[s.item, blocked && { opacity: 0.4 }]}
              >
                <Text style={s.itemText}>{item.name}</Text>
                {on ? <FontAwesome5 name="check" size={14} color={colors.navy} solid /> : null}
              </Pressable>
            );
          }}
        />
      </SafeAreaView>
    </Modal>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.screenBackground },
  head: { flexDirection: 'row', alignItems: 'center', padding: spacing.md, gap: 8 },
  headBtn: { minWidth: 70, minHeight: 44, justifyContent: 'center' },
  headText: { color: colors.navy, fontSize: fontSize.md },
  title: { flex: 1, textAlign: 'center', fontSize: fontSize.md, fontWeight: '800', color: colors.textPrimary },
  search: { marginHorizontal: spacing.md, minHeight: 44, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: '#fff', paddingHorizontal: 12, fontSize: fontSize.md, color: colors.textPrimary },
  count: { marginHorizontal: spacing.md, marginTop: 8, fontSize: fontSize.xs, color: colors.textMuted },
  item: { minHeight: 48, paddingHorizontal: spacing.md, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  itemText: { fontSize: fontSize.md, color: colors.textPrimary },
  empty: { textAlign: 'center', color: colors.textMuted, padding: spacing.lg },
});
