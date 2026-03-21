import { NativeModule, requireNativeModule } from 'expo';

import { ExpoLocalLlmModuleEvents } from './ExpoLocalLlm.types';

declare class ExpoLocalLlmModule extends NativeModule<ExpoLocalLlmModuleEvents> {
  PI: number;
  hello(): string;
  setValueAsync(value: string): Promise<void>;
}

// This call loads the native module object from the JSI.
export default requireNativeModule<ExpoLocalLlmModule>('ExpoLocalLlm');
