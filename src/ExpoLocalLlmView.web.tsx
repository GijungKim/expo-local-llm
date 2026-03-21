import * as React from 'react';

import { ExpoLocalLlmViewProps } from './ExpoLocalLlm.types';

export default function ExpoLocalLlmView(props: ExpoLocalLlmViewProps) {
  return (
    <div>
      <iframe
        style={{ flex: 1 }}
        src={props.url}
        onLoad={() => props.onLoad({ nativeEvent: { url: props.url } })}
      />
    </div>
  );
}
