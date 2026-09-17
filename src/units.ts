/** Unit conversion + formatting. Input is always stored in metric internally. */

export type UnitSystem = 'metric' | 'imperial';

export const CM_PER_IN = 2.54;
export const KG_PER_LB = 0.45359237;

export function formatHeight(cm: number, units: UnitSystem): string {
  if (units === 'metric') return `${Math.round(cm)} cm`;
  const totalIn = Math.round(cm / CM_PER_IN);
  return `${Math.floor(totalIn / 12)}′ ${totalIn % 12}″`;
}

export function formatWeight(kg: number, units: UnitSystem): string {
  if (units === 'metric') return `${kg.toFixed(kg % 1 ? 1 : 0)} kg`;
  return `${Math.round(kg / KG_PER_LB)} lb`;
}

/** Circumferences are reported in cm or inches to match the chosen system. */
export function formatGirth(cm: number, units: UnitSystem): string {
  return units === 'metric' ? `${cm.toFixed(0)} cm` : `${(cm / CM_PER_IN).toFixed(1)}″`;
}
