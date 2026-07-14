/**
 * components/ContentActions.tsx
 *
 * The per-item "⋯" affordance that exposes the app-store-required UGC safety
 * actions on a piece of user-generated content:
 *
 *   • Report      — always offered; opens the <ReportSheet>.
 *   • Block user   — offered when an author id is known and it isn't the
 *                    viewer's own content; confirms via the branded alert,
 *                    calls blockUser(), then tells the host to hide/refresh.
 *
 * Matches the app's existing "ellipsis + branded action menu" pattern, so it
 * drops cleanly next to a comment, a memory header, a profile name, etc.
 *
 *   <ContentActions
 *     contentType="memory_comment"
 *     contentId={comment.id}
 *     authorId={comment.author_id}
 *     authorName={comment.author?.full_name}
 *     onBlocked={() => reloadComments()}
 *   />
 */

import React, { useState } from 'react';
import { TouchableOpacity, StyleSheet, ViewStyle } from 'react-native';
import { FontAwesome5 } from '@expo/vector-icons';
import { useAlert } from '@/components/BrandedAlert';
import { ReportSheet } from '@/components/ReportSheet';
import { useAuth } from '@/context/AuthContext';
import { colors } from '@/constants/theme';
import { blockUser, ReportContentType } from '@/lib/moderation';

interface Props {
  contentType: ReportContentType;
  contentId: string;
  /** The content author's user id — enables "Block this user". */
  authorId?: string | null;
  /** Author's display name, used in the block confirmation copy. */
  authorName?: string | null;
  /** Called after the author has been blocked, so the host can hide/refresh. */
  onBlocked?: (authorId: string) => void;
  /** Icon tint. Defaults to a muted grey. */
  color?: string;
  /** FontAwesome5 glyph — 'ellipsis-h' (default) or 'ellipsis-v'. */
  icon?: 'ellipsis-h' | 'ellipsis-v';
  size?: number;
  style?: ViewStyle;
}

export function ContentActions({
  contentType, contentId, authorId, authorName,
  onBlocked, color = colors.textMuted, icon = 'ellipsis-h', size = 16, style,
}: Props) {
  const { alert } = useAlert();
  const { profile } = useAuth();
  const [reporting, setReporting] = useState(false);

  // Don't offer "block yourself".
  const canBlock = !!authorId && authorId !== profile?.id;
  const who = authorName?.trim() || 'this person';

  const confirmBlock = () => {
    if (!authorId) return;
    alert({
      title: `Block ${who}?`,
      message: `You won't see ${who}'s stories, comments or posts anywhere in OneShetland. You can undo this later in your account settings.`,
      icon: 'user-slash',
      accent: colors.error,
      actions: [
        { label: 'Cancel', style: 'cancel' },
        {
          label: 'Block', style: 'destructive',
          onPress: async () => {
            try {
              await blockUser(authorId);
              onBlocked?.(authorId);
              alert({
                title: 'Blocked',
                message: `You won't see ${who}'s content any more.`,
                icon: 'check',
                accent: colors.success,
              });
            } catch (err: any) {
              alert({ title: 'Could not block', message: err?.message ?? '' });
            }
          },
        },
      ],
    });
  };

  const openMenu = () => {
    const actions = [
      {
        label: 'Report', style: 'destructive' as const,
        onPress: () => setReporting(true),
      },
      ...(canBlock
        ? [{ label: `Block ${who}`, style: 'destructive' as const, onPress: confirmBlock }]
        : []),
      { label: 'Cancel', style: 'cancel' as const },
    ];
    alert({
      title: 'Content options',
      message: 'Help keep OneShetland a friendly place.',
      icon: 'flag',
      actions,
    });
  };

  return (
    <>
      <TouchableOpacity
        onPress={openMenu}
        hitSlop={10}
        style={[styles.btn, style]}
        accessibilityLabel="Report or block"
      >
        <FontAwesome5 name={icon} size={size} color={color} />
      </TouchableOpacity>

      <ReportSheet
        visible={reporting}
        onClose={() => setReporting(false)}
        contentType={contentType}
        contentId={contentId}
        reportedUserId={authorId ?? null}
      />
    </>
  );
}

const styles = StyleSheet.create({
  btn: {
    width: 30, height: 30,
    alignItems: 'center', justifyContent: 'center',
  },
});
