import React from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  ViewStyle,
} from 'react-native';
import Slider from './Slider';

import { radius, theme } from '../theme';

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  style,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  style?: ViewStyle;
}) {
  return (
    <View style={[styles.segmented, style]}>
      {options.map((o) => {
        const active = o.value === value;
        return (
          <Pressable
            key={o.value}
            onPress={() => onChange(o.value)}
            style={[styles.segment, active && styles.segmentActive]}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
          >
            <Text style={[styles.segmentLabel, active && styles.segmentLabelActive]}>
              {o.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function LabeledSlider({
  label,
  display,
  value,
  min,
  max,
  step = 1,
  onChange,
  tint = theme.accent,
}: {
  label: string;
  display: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  tint?: string;
}) {
  return (
    <View style={styles.sliderBlock}>
      <View style={styles.sliderHeader}>
        <Text style={styles.sliderLabel}>{label}</Text>
        <Text style={styles.sliderValue}>{display}</Text>
      </View>
      <Slider
        value={value}
        minimumValue={min}
        maximumValue={max}
        step={step}
        onValueChange={onChange}
        tint={tint}
        accessibilityLabel={label}
      />
    </View>
  );
}

export function Stat({
  label,
  value,
  tint = theme.text,
}: {
  label: string;
  value: string;
  tint?: string;
}) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={[styles.statValue, { color: tint }]}>{value}</Text>
    </View>
  );
}

export function Button({
  title,
  onPress,
  variant = 'primary',
  style,
}: {
  title: string;
  onPress: () => void;
  variant?: 'primary' | 'ghost';
  style?: ViewStyle;
}) {
  const primary = variant === 'primary';
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [
        styles.button,
        primary ? styles.buttonPrimary : styles.buttonGhost,
        pressed && styles.buttonPressed,
        style,
      ]}
    >
      <Text style={[styles.buttonText, !primary && styles.buttonTextGhost]}>{title}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  segmented: {
    flexDirection: 'row',
    backgroundColor: theme.bgElevated,
    borderRadius: radius.pill,
    padding: 4,
    borderWidth: 1,
    borderColor: theme.border,
  },
  segment: {
    flex: 1,
    paddingVertical: 9,
    borderRadius: radius.pill,
    alignItems: 'center',
  },
  segmentActive: { backgroundColor: theme.accent },
  segmentLabel: { color: theme.textMuted, fontSize: 14, fontWeight: '600' },
  segmentLabelActive: { color: '#06101F' },

  sliderBlock: { marginTop: 18 },
  sliderHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
  },
  sliderLabel: {
    color: theme.textMuted,
    fontSize: 13,
    fontWeight: '600',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  sliderValue: { color: theme.text, fontSize: 22, fontWeight: '700', fontVariant: ['tabular-nums'] },

  stat: { flexGrow: 1, flexBasis: '30%', paddingVertical: 8 },
  statLabel: {
    color: theme.textFaint,
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.7,
    textTransform: 'uppercase',
  },
  statValue: { fontSize: 18, fontWeight: '700', marginTop: 3, fontVariant: ['tabular-nums'] },

  button: {
    borderRadius: radius.md,
    paddingVertical: 15,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonPrimary: { backgroundColor: theme.accent },
  buttonGhost: { backgroundColor: 'transparent', borderWidth: 1, borderColor: theme.border },
  buttonPressed: { opacity: 0.75 },
  buttonText: { color: '#06101F', fontSize: 16, fontWeight: '700' },
  buttonTextGhost: { color: theme.text },
});
