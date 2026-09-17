import React, { useCallback, useMemo, useRef, useState } from 'react';
import { LayoutChangeEvent, PanResponder, StyleSheet, View } from 'react-native';

import { radius, theme } from '../theme';

const TRACK_HEIGHT = 5;
const THUMB_SIZE = 26;

/**
 * A pure-JS slider. Written by hand rather than pulled from a package because
 * it keeps the app free of third-party native modules, which means it runs in
 * Expo Go with no custom dev build.
 */
export default function Slider({
  value,
  minimumValue,
  maximumValue,
  step = 1,
  onValueChange,
  tint = theme.accent,
  accessibilityLabel,
}: {
  value: number;
  minimumValue: number;
  maximumValue: number;
  step?: number;
  onValueChange: (v: number) => void;
  tint?: string;
  accessibilityLabel?: string;
}) {
  const [width, setWidth] = useState(0);
  // The responder closes over these once, so the live values go through refs.
  const widthRef = useRef(0);
  const range = maximumValue - minimumValue;

  const quantize = useCallback(
    (raw: number) => {
      const clamped = Math.min(maximumValue, Math.max(minimumValue, raw));
      if (!step) return clamped;
      return Math.round((clamped - minimumValue) / step) * step + minimumValue;
    },
    [maximumValue, minimumValue, step],
  );

  const emit = useCallback(
    (x: number) => {
      const w = widthRef.current - THUMB_SIZE;
      if (w <= 0) return;
      const ratio = Math.min(1, Math.max(0, (x - THUMB_SIZE / 2) / w));
      onValueChange(quantize(minimumValue + ratio * range));
    },
    [minimumValue, onValueChange, quantize, range],
  );

  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        // Claim the gesture before an ancestor ScrollView can steal it.
        onMoveShouldSetPanResponderCapture: (_, g) => Math.abs(g.dx) > Math.abs(g.dy),
        onPanResponderGrant: (evt) => emit(evt.nativeEvent.locationX),
        onPanResponderMove: (evt) => emit(evt.nativeEvent.locationX),
      }),
    [emit],
  );

  const onLayout = (e: LayoutChangeEvent) => {
    widthRef.current = e.nativeEvent.layout.width;
    setWidth(e.nativeEvent.layout.width);
  };

  const ratio = range > 0 ? (value - minimumValue) / range : 0;
  const travel = Math.max(0, width - THUMB_SIZE);
  const thumbLeft = ratio * travel;

  return (
    <View
      style={styles.root}
      onLayout={onLayout}
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={accessibilityLabel}
      accessibilityValue={{ min: minimumValue, max: maximumValue, now: Math.round(value) }}
      onAccessibilityAction={(e) => {
        const dir = e.nativeEvent.actionName === 'increment' ? 1 : -1;
        onValueChange(quantize(value + dir * (step || 1)));
      }}
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      {...responder.panHandlers}
    >
      <View style={styles.track} />
      <View style={[styles.fill, { width: thumbLeft + THUMB_SIZE / 2, backgroundColor: tint }]} />
      <View style={[styles.thumb, { left: thumbLeft, borderColor: tint }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { height: 44, justifyContent: 'center' },
  track: {
    height: TRACK_HEIGHT,
    borderRadius: radius.pill,
    backgroundColor: theme.border,
    marginHorizontal: THUMB_SIZE / 2,
  },
  fill: {
    position: 'absolute',
    left: 0,
    height: TRACK_HEIGHT,
    borderRadius: radius.pill,
    marginLeft: THUMB_SIZE / 2,
  },
  thumb: {
    position: 'absolute',
    width: THUMB_SIZE,
    height: THUMB_SIZE,
    borderRadius: THUMB_SIZE / 2,
    backgroundColor: theme.text,
    borderWidth: 3,
  },
});
