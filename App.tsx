import React, { useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import ModelScreen from './src/screens/ModelScreen';
import SetupScreen, { Profile } from './src/screens/SetupScreen';
import { UnitSystem } from './src/units';

export default function App() {
  const [profile, setProfile] = useState<Profile>({
    sex: 'male',
    heightCm: 178,
    weightKg: 76,
  });
  const [units, setUnits] = useState<UnitSystem>('metric');
  const [showModel, setShowModel] = useState(false);

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      {showModel ? (
        <ModelScreen
          profile={profile}
          units={units}
          onChange={setProfile}
          onBack={() => setShowModel(false)}
        />
      ) : (
        <SetupScreen
          profile={profile}
          units={units}
          onChange={setProfile}
          onUnitsChange={setUnits}
          onSubmit={() => setShowModel(true)}
        />
      )}
    </SafeAreaProvider>
  );
}
