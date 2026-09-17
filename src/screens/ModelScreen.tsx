import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';

import { bmiCategory } from '../body/anthropometry';
import { buildBody } from '../body/buildBody';
import BodyViewer, { BodyViewerHandle } from '../components/BodyViewer';
import { LabeledSlider, Stat } from '../components/ui';
import { radius, theme } from '../theme';
import { UnitSystem, formatGirth, formatHeight, formatWeight } from '../units';
import { LIMITS, Profile } from './SetupScreen';

export default function ModelScreen({
  profile,
  units,
  onChange,
  onBack,
}: {
  profile: Profile;
  units: UnitSystem;
  onChange: (p: Profile) => void;
  onBack: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [adjusting, setAdjusting] = useState(false);
  const [spinning, setSpinning] = useState(false);
  const [ready, setReady] = useState(false);
  const viewer = useRef<BodyViewerHandle | null>(null);
  // Kept mounted through the fade so the model isn't revealed mid-dissolve.
  const [veiled, setVeiled] = useState(true);
  const fade = useRef(new Animated.Value(1)).current;

  // Rounded inputs keep the slider from rebuilding the mesh sub-pixel often.
  const h = Math.round(profile.heightCm);
  const w = Math.round(profile.weightKg);
  const body = useMemo(
    () => buildBody({ heightCm: h, weightKg: w, sex: profile.sex }),
    [h, w, profile.sex],
  );

  const onReady = useCallback((handle: BodyViewerHandle) => {
    viewer.current = handle;
  }, []);

  const onFirstFrame = useCallback(() => setReady(true), []);

  // If the GL surface never reports a frame, show the scene anyway rather than
  // leaving the loader up for good.
  useEffect(() => {
    const id = setTimeout(() => setReady(true), 6000);
    return () => clearTimeout(id);
  }, []);

  useEffect(() => {
    if (!ready) return;
    const anim = Animated.timing(fade, {
      toValue: 0,
      duration: 420,
      useNativeDriver: true,
    });
    anim.start(({ finished }) => finished && setVeiled(false));
    return () => anim.stop();
  }, [ready, fade]);

  const m = body.metrics;
  const category = bmiCategory(m.bmi);

  const tap = () => Haptics.selectionAsync().catch(() => {});

  return (
    <View style={styles.root}>
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <Pressable onPress={onBack} style={styles.iconButton} accessibilityLabel="Back">
          <Text style={styles.iconText}>‹</Text>
        </Pressable>
        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle}>
            {formatHeight(profile.heightCm, units)} · {formatWeight(profile.weightKg, units)}
          </Text>
          <Text style={styles.headerSub}>{profile.sex === 'female' ? 'Female' : 'Male'}</Text>
        </View>
        <Pressable
          onPress={() => {
            tap();
            setSpinning(viewer.current?.toggleAutoRotate() ?? false);
          }}
          style={[styles.iconButton, spinning && styles.iconButtonActive]}
          accessibilityLabel="Toggle auto-rotate"
        >
          <Text style={[styles.iconText, spinning && styles.iconTextActive]}>↻</Text>
        </Pressable>
      </View>

      <View style={styles.stage}>
        <BodyViewer body={body} onReady={onReady} onFirstFrame={onFirstFrame} />

        {veiled ? (
          <Animated.View style={[styles.loader, { opacity: fade }]} pointerEvents="none">
            <ActivityIndicator size="large" color={theme.accent} />
            <Text style={styles.loaderText}>Building your model</Text>
            <Text style={styles.loaderHint}>
              Shaping {profile.heightCm} cm · {profile.weightKg} kg
            </Text>
          </Animated.View>
        ) : null}

        <Pressable
          onPress={() => {
            tap();
            viewer.current?.resetView();
            setSpinning(false);
          }}
          style={styles.resetChip}
          accessibilityLabel="Reset view"
        >
          <Text style={styles.resetChipText}>Reset view</Text>
        </Pressable>
        {ready ? (
          <Text style={styles.stageHint} pointerEvents="none">
            Drag to rotate · pinch to zoom
          </Text>
        ) : null}
      </View>

      <View style={[styles.panel, { paddingBottom: insets.bottom + 14 }]}>
        <View style={styles.grabber} />

        <View style={styles.bmiRow}>
          <View>
            <Text style={styles.bmiLabel}>Body mass index</Text>
            <Text style={styles.bmiValue}>{m.bmi.toFixed(1)}</Text>
          </View>
          <View style={[styles.bmiPill, { backgroundColor: `${category.color}22` }]}>
            <View style={[styles.bmiDot, { backgroundColor: category.color }]} />
            <Text style={[styles.bmiCategory, { color: category.color }]}>{category.label}</Text>
          </View>
        </View>

        <ScrollView
          horizontal={false}
          style={styles.statsScroll}
          contentContainerStyle={styles.stats}
          showsVerticalScrollIndicator={false}
        >
          <Stat
            label={profile.sex === 'female' ? 'Bust' : 'Chest'}
            value={formatGirth(m.chest, units)}
          />
          <Stat label="Waist" value={formatGirth(m.waist, units)} />
          <Stat label="Hips" value={formatGirth(m.hip, units)} />
          <Stat label="Thigh" value={formatGirth(m.thigh, units)} />
          <Stat label="Upper arm" value={formatGirth(m.upperArm, units)} />
          <Stat label="Waist / hip" value={m.whr.toFixed(2)} />
        </ScrollView>

        {adjusting ? (
          <View style={styles.adjust}>
            <LabeledSlider
              label="Height"
              display={formatHeight(profile.heightCm, units)}
              value={profile.heightCm}
              min={LIMITS.heightCm.min}
              max={LIMITS.heightCm.max}
              onChange={(heightCm) => onChange({ ...profile, heightCm })}
            />
            <LabeledSlider
              label="Weight"
              display={formatWeight(profile.weightKg, units)}
              value={profile.weightKg}
              min={LIMITS.weightKg.min}
              max={LIMITS.weightKg.max}
              onChange={(weightKg) => onChange({ ...profile, weightKg })}
            />
          </View>
        ) : null}

        <Pressable
          onPress={() => {
            tap();
            setAdjusting((v) => !v);
          }}
          style={styles.adjustToggle}
        >
          <Text style={styles.adjustToggleText}>
            {adjusting ? 'Done adjusting' : 'Adjust measurements'}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingBottom: 10,
    gap: 12,
  },
  headerCenter: { flex: 1, alignItems: 'center' },
  headerTitle: { color: theme.text, fontSize: 16, fontWeight: '700' },
  headerSub: { color: theme.textFaint, fontSize: 12, marginTop: 2 },
  iconButton: {
    width: 40,
    height: 40,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.bgElevated,
    borderWidth: 1,
    borderColor: theme.border,
  },
  iconButtonActive: { backgroundColor: theme.accentSoft, borderColor: theme.accent },
  iconText: { color: theme.textMuted, fontSize: 22, lineHeight: 26, fontWeight: '600' },
  iconTextActive: { color: theme.accent },

  stage: { flex: 1, overflow: 'hidden' },
  loader: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.bgSunken,
    gap: 14,
  },
  loaderText: { color: theme.text, fontSize: 15, fontWeight: '600' },
  loaderHint: { color: theme.textFaint, fontSize: 12.5, marginTop: -6 },
  resetChip: {
    position: 'absolute',
    top: 14,
    right: 14,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(20,25,34,0.82)',
    borderWidth: 1,
    borderColor: theme.border,
  },
  resetChipText: { color: theme.textMuted, fontSize: 12, fontWeight: '600' },
  stageHint: {
    position: 'absolute',
    bottom: 12,
    alignSelf: 'center',
    color: theme.textFaint,
    fontSize: 12,
    letterSpacing: 0.3,
  },

  panel: {
    backgroundColor: theme.card,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    borderTopWidth: 1,
    borderColor: theme.border,
    paddingHorizontal: 22,
    paddingTop: 10,
  },
  grabber: {
    width: 38,
    height: 4,
    borderRadius: 2,
    backgroundColor: theme.border,
    alignSelf: 'center',
    marginBottom: 14,
  },

  bmiRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  bmiLabel: {
    color: theme.textFaint,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  bmiValue: {
    color: theme.text,
    fontSize: 26,
    fontWeight: '800',
    marginTop: 2,
    fontVariant: ['tabular-nums'],
  },
  bmiPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: radius.pill,
  },
  bmiDot: { width: 8, height: 8, borderRadius: 4 },
  bmiCategory: { fontSize: 12.5, fontWeight: '700' },

  statsScroll: { maxHeight: 190, marginTop: 6 },
  stats: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    borderTopWidth: 1,
    borderTopColor: theme.border,
    paddingTop: 8,
    marginTop: 12,
  },

  adjust: { borderTopWidth: 1, borderTopColor: theme.border, paddingTop: 4, marginTop: 8 },
  adjustToggle: { alignSelf: 'center', paddingVertical: 14, paddingHorizontal: 20 },
  adjustToggleText: { color: theme.accent, fontSize: 14, fontWeight: '700' },
});
