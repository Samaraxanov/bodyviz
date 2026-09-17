import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';

import { Sex, bmiCategory } from '../body/anthropometry';
import { Button, LabeledSlider, Segmented } from '../components/ui';
import { radius, theme } from '../theme';
import { UnitSystem, formatHeight, formatWeight } from '../units';

export interface Profile {
  sex: Sex;
  heightCm: number;
  weightKg: number;
}

export const LIMITS = {
  heightCm: { min: 130, max: 220 },
  weightKg: { min: 35, max: 200 },
};

export default function SetupScreen({
  profile,
  units,
  onChange,
  onUnitsChange,
  onSubmit,
}: {
  profile: Profile;
  units: UnitSystem;
  onChange: (p: Profile) => void;
  onUnitsChange: (u: UnitSystem) => void;
  onSubmit: () => void;
}) {
  const insets = useSafeAreaInsets();
  const bmi = profile.weightKg / (profile.heightCm / 100) ** 2;
  const category = bmiCategory(bmi);

  const pickSex = (sex: Sex) => {
    Haptics.selectionAsync().catch(() => {});
    onChange({ ...profile, sex });
  };

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={[
        styles.content,
        { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 32 },
      ]}
      keyboardShouldPersistTaps="handled"
    >
      <Text style={styles.eyebrow}>Body model</Text>
      <Text style={styles.title}>Let's build your figure</Text>
      <Text style={styles.subtitle}>
        Three numbers are enough to generate a proportioned 3D body you can turn and inspect.
      </Text>

      <Text style={styles.sectionLabel}>Sex</Text>
      <View style={styles.sexRow}>
        {(['male', 'female'] as Sex[]).map((s) => {
          const active = profile.sex === s;
          const tint = s === 'female' ? theme.female : theme.male;
          return (
            <Pressable
              key={s}
              onPress={() => pickSex(s)}
              accessibilityRole="radio"
              accessibilityState={{ selected: active }}
              style={[
                styles.sexCard,
                active && { borderColor: tint, backgroundColor: `${tint}1A` },
              ]}
            >
              <View style={[styles.sexGlyph, { backgroundColor: active ? tint : theme.border }]}>
                <Text style={styles.sexGlyphText}>{s === 'female' ? '♀' : '♂'}</Text>
              </View>
              <Text style={[styles.sexLabel, active && { color: theme.text }]}>
                {s === 'female' ? 'Female' : 'Male'}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <Text style={styles.hint}>
        Sets the skeletal proportions and where body mass sits — shoulders and waist, or hips and
        thighs.
      </Text>

      <View style={styles.unitsRow}>
        <Text style={styles.sectionLabel}>Units</Text>
        <Segmented
          style={styles.unitsControl}
          value={units}
          onChange={onUnitsChange}
          options={[
            { value: 'metric', label: 'cm / kg' },
            { value: 'imperial', label: 'ft / lb' },
          ]}
        />
      </View>

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

      <View style={styles.bmiCard}>
        <View>
          <Text style={styles.bmiLabel}>BMI</Text>
          <Text style={styles.bmiValue}>{bmi.toFixed(1)}</Text>
        </View>
        <View style={[styles.bmiPill, { backgroundColor: `${category.color}22` }]}>
          <View style={[styles.bmiDot, { backgroundColor: category.color }]} />
          <Text style={[styles.bmiCategory, { color: category.color }]}>{category.label}</Text>
        </View>
      </View>

      <Button title="Generate 3D model" onPress={onSubmit} style={styles.cta} />
      <Text style={styles.disclaimer}>
        A visual estimate built from population averages, not a medical measurement or a scan of
        you.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  content: { paddingHorizontal: 22 },
  eyebrow: {
    color: theme.accent,
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1.4,
    textTransform: 'uppercase',
  },
  title: { color: theme.text, fontSize: 30, fontWeight: '800', marginTop: 8, lineHeight: 36 },
  subtitle: { color: theme.textMuted, fontSize: 15, lineHeight: 22, marginTop: 10 },

  sectionLabel: {
    color: theme.textMuted,
    fontSize: 13,
    fontWeight: '600',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    marginTop: 30,
  },
  sexRow: { flexDirection: 'row', gap: 12, marginTop: 12 },
  sexCard: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 20,
    borderRadius: radius.md,
    borderWidth: 1.5,
    borderColor: theme.border,
    backgroundColor: theme.bgElevated,
  },
  sexGlyph: {
    width: 44,
    height: 44,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sexGlyphText: { fontSize: 22, color: '#06101F', fontWeight: '700' },
  sexLabel: { color: theme.textMuted, fontSize: 15, fontWeight: '700', marginTop: 10 },
  hint: { color: theme.textFaint, fontSize: 12.5, lineHeight: 18, marginTop: 10 },

  unitsRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  unitsControl: { width: 190, marginTop: 30 },

  bmiCard: {
    marginTop: 26,
    padding: 18,
    borderRadius: radius.md,
    backgroundColor: theme.card,
    borderWidth: 1,
    borderColor: theme.border,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  bmiLabel: {
    color: theme.textFaint,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  bmiValue: {
    color: theme.text,
    fontSize: 28,
    fontWeight: '800',
    marginTop: 2,
    fontVariant: ['tabular-nums'],
  },
  bmiPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: radius.pill,
  },
  bmiDot: { width: 8, height: 8, borderRadius: 4 },
  bmiCategory: { fontSize: 13, fontWeight: '700' },

  cta: { marginTop: 26 },
  disclaimer: {
    color: theme.textFaint,
    fontSize: 11.5,
    lineHeight: 17,
    textAlign: 'center',
    marginTop: 16,
  },
});
