import { requireNativeView } from 'expo';
import * as React from 'react';

import { ExpoLocalLlmViewProps } from './ExpoLocalLlm.types';

const NativeView: React.ComponentType<ExpoLocalLlmViewProps> =
  requireNativeView('ExpoLocalLlm');

export default function ExpoLocalLlmView(props: ExpoLocalLlmViewProps) {
  return <NativeView {...props} />;
}
