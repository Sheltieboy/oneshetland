/**
 * components/ImagePickerField.tsx
 *
 * Reusable image picker + uploader for any *_url field in OneShetland.
 *
 * Renders the existing image as a preview, a "Choose photo" button that
 * opens the system picker, and shows upload progress + remove button.
 *
 * Soft-loads `expo-image-picker` so the screen still mounts if the
 * dependency hasn't been installed yet (alerts the user instead of
 * crashing). Run `npx expo install expo-image-picker` to enable.
 *
 * Usage:
 *   <ImagePickerField
 *     value={form.logo_url}
 *     onChange={(url) => setForm({ ...form, logo_url: url })}
 *     upload={(file) => uploadBusinessImage(businessId, 'logo', file)}
 *     label="Business logo"
 *     aspect={[1, 1]}
 *   />
 */

import React, { useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ActivityIndicator,
  Alert, Image,
} from 'react-native';
import { FontAwesome5 } from '@expo/vector-icons';
import { colors, fontSize, spacing, radius } from '@/constants/theme';
import { PickedFile, UploadedImage } from '@/lib/image-upload';

type AspectTuple = [number, number];

interface ImagePickerFieldProps {
  /** Current image URL — pass null/undefined if no image yet. */
  value:    string | null | undefined;
  /** Called with the new public URL after upload, or null on remove. */
  onChange: (url: string | null) => void;
  /** Upload function — typically one of the helpers from lib/image-upload. */
  upload:   (file: PickedFile) => Promise<UploadedImage>;
  /** Field label shown above the picker. */
  label?:   string;
  /** Help text shown under the label. */
  hint?:    string;
  /** Crop aspect ratio. Default [1, 1] (square). Use [16, 9] for cover images. */
  aspect?:  AspectTuple;
  /** Allow the user to crop/edit before upload. Default true. */
  allowsEditing?: boolean;
  /** Disable upload — read-only preview. */
  disabled?: boolean;
}

// Soft-load expo-image-picker. Wrapped in try/catch so a missing dep
// doesn't crash the bundle at import time.
let ImagePicker: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  ImagePicker = require('expo-image-picker');
} catch {
  ImagePicker = null;
}

export function ImagePickerField({
  value,
  onChange,
  upload,
  label,
  hint,
  aspect = [1, 1],
  allowsEditing = true,
  disabled = false,
}: ImagePickerFieldProps) {
  const [busy, setBusy] = useState(false);

  const handlePick = async () => {
    if (!ImagePicker) {
      Alert.alert(
        'Setup needed',
        'Image picker is not installed yet. Run `npx expo install expo-image-picker` and rebuild the app.',
      );
      return;
    }

    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        Alert.alert(
          'Permission needed',
          'OneShetland needs access to your photos to upload an image.',
        );
        return;
      }

      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions
          ? ImagePicker.MediaTypeOptions.Images
          : ['images'],
        allowsEditing,
        aspect,
        quality: 0.85,
      });

      if (result.canceled || !result.assets?.[0]) return;

      const asset = result.assets[0];
      const file: PickedFile = {
        uri:      asset.uri,
        mimeType: asset.mimeType,
        ext:      asset.fileName?.split('.').pop(),
      };

      setBusy(true);
      const uploaded = await upload(file);
      onChange(uploaded.publicUrl);
    } catch (err: any) {
      Alert.alert('Upload failed', err?.message ?? 'Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const handleRemove = () => {
    Alert.alert(
      'Remove image?',
      'You can always add another one later.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: () => onChange(null),
        },
      ],
    );
  };

  return (
    <View style={styles.wrap}>
      {label ? <Text style={styles.label}>{label}</Text> : null}
      {hint  ? <Text style={styles.hint}>{hint}</Text>   : null}

      <View style={styles.row}>
        <View style={styles.preview}>
          {value ? (
            <Image source={{ uri: value }} style={styles.previewImage} resizeMode="cover" />
          ) : (
            <View style={styles.previewPlaceholder}>
              <FontAwesome5 name="image" size={28} color={colors.textLight} />
            </View>
          )}
          {busy ? (
            <View style={styles.previewOverlay}>
              <ActivityIndicator color={colors.white} />
            </View>
          ) : null}
        </View>

        <View style={styles.actions}>
          <TouchableOpacity
            onPress={handlePick}
            disabled={busy || disabled}
            style={[styles.btn, (busy || disabled) && styles.btnDisabled]}
          >
            <FontAwesome5 name="camera" size={14} color={colors.white} />
            <Text style={styles.btnText}>
              {value ? 'Change photo' : 'Choose photo'}
            </Text>
          </TouchableOpacity>
          {value ? (
            <TouchableOpacity
              onPress={handleRemove}
              disabled={busy || disabled}
              style={styles.btnGhost}
            >
              <Text style={styles.btnGhostText}>Remove</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    marginBottom: spacing.lg,
  },
  label: {
    fontSize: fontSize.sm,
    fontWeight: '600',
    color: colors.textPrimary,
    marginBottom: 4,
  },
  hint: {
    fontSize: fontSize.xs,
    color: colors.textMuted,
    marginBottom: spacing.sm,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  preview: {
    width: 88,
    height: 88,
    borderRadius: radius.md,
    overflow: 'hidden',
    backgroundColor: colors.offWhite,
    borderWidth: 1,
    borderColor: colors.border,
  },
  previewImage: {
    width: '100%',
    height: '100%',
  },
  previewPlaceholder: {
    width: '100%',
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  previewOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  actions: {
    flex: 1,
    gap: spacing.xs,
  },
  btn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.navy,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.sm,
    gap: 8,
  },
  btnDisabled: {
    opacity: 0.5,
  },
  btnText: {
    color: colors.white,
    fontSize: fontSize.sm,
    fontWeight: '600',
  },
  btnGhost: {
    paddingVertical: spacing.xs,
    alignItems: 'center',
  },
  btnGhostText: {
    color: colors.error,
    fontSize: fontSize.xs,
    fontWeight: '500',
  },
});

export default ImagePickerField;
