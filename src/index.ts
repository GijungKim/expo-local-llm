// Reexport the native module. On web, it will be resolved to ExpoLocalLlmModule.web.ts
// and on native platforms to ExpoLocalLlmModule.ts
export { default } from './ExpoLocalLlmModule';
export { default as ExpoLocalLlmView } from './ExpoLocalLlmView';
export * from  './ExpoLocalLlm.types';
