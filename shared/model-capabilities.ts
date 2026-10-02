export const reasoningEfforts = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ReasoningEffort = typeof reasoningEfforts[number];
export interface ModelCapabilities {
  chat: boolean;
  vision: boolean | null;
  imageGeneration: boolean;
  reasoningEfforts: ReasoningEffort[];
  webSearch: boolean;
  explicitBase64: boolean;
  source: 'catalog' | 'custom' | 'unknown' | 'migration';
}
export type ModelCapabilityOverride = Partial<Omit<ModelCapabilities, 'source'>>;
export const unknownCapabilities: ModelCapabilities = { chat: true, vision: null, imageGeneration: false, reasoningEfforts: [], webSearch: false, explicitBase64: false, source: 'unknown' };
export function capabilitiesFor(connection: { capabilities?: Record<string, ModelCapabilities> }, model: string): ModelCapabilities {
  return connection.capabilities?.[model] ?? unknownCapabilities;
}
export function capabilityLabels(value: ModelCapabilities): string[] {
  return [value.vision && '看图', value.imageGeneration && '生图', value.reasoningEfforts.length > 0 && '思考', value.webSearch && '联网', value.source === 'unknown' && '能力待确认'].filter((label): label is string => !!label);
}
export function supportsSearch(value: ModelCapabilities, effort?: ReasoningEffort | 'default'): boolean {
  return value.webSearch && effort !== 'minimal';
}
