import { registerWebModule, NativeModule } from 'expo';

import { ExpoLocalLlmModuleEvents } from './ExpoLocalLlm.types';

class ExpoLocalLlmModule extends NativeModule<ExpoLocalLlmModuleEvents> {
  PI = Math.PI;
  async setValueAsync(value: string): Promise<void> {
    this.emit('onChange', { value });
  }
  hello() {
    return 'Hello world! 👋';
  }
}

export default registerWebModule(ExpoLocalLlmModule, 'ExpoLocalLlmModule');
