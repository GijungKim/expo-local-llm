# Image prompts

[Back to usage](../README.md#describe-or-compare-images) · [API reference](api.md)

## Inputs and limits

An `LLMPrompt` is either the existing string prompt or `{ text, images? }`. Each image requires a `uri` and a nonblank `label` of at most 128 characters without control characters; the label is sent to the model with the image. Android neutralises conversation role markers in labels; iOS uses native attachment metadata. Download remote images to a local file before calling the library. Only local `file://` URIs with an empty or `localhost` authority are accepted; credentials, ports, query strings and fragments are rejected. Percent-encode spaces in file paths (for example, `my%20photo.jpg`).

Both platforms accept **up to eight images per request**, with a unique label for each image. The model's context and device resources still determine whether a particular request can complete.

```ts
import { generate } from 'expo-local-llm';

// Both URIs point to local files already available to your app.
const comparison = await generate({
  text: 'What changed between the before and after photos?',
  images: [
    { uri: beforePhotoUri, label: 'before' },
    { uri: afterPhotoUri, label: 'after' },
  ],
});
```

## Platform behavior

iOS uses native Foundation Models image attachments and requires iOS 27+, an app built with Xcode 27+, and a ready system model that advertises vision support. Older OS versions, older builds, and models without vision reject image prompts with `ERR_IMAGE_NOT_SUPPORTED`; text prompts still work with the existing iOS 26 / Xcode 26.4 minimum. The framework handles image scaling and orientation. Completed image turns remain in the native session transcript until `reset()` or release.

Android remains experimental. Multiple images use ML Kit `1.0.0-beta5`, requiring Kotlin 2.3.0+ in the host app. The module also supplies coroutines 1.11.0 for the SDK's runtime ABI. Image decoding runs off the main thread, limits each image's long edge to 2048 pixels, and applies EXIF orientation. Before SDK submission, failed or cancelled requests recycle all decoded bitmaps. After submission, garbage collection reclaims them when all references are gone: ML Kit's bitmap-preparation worker can outlive cancellation of the coroutine awaiting it. On Android, images belong only to the current request: conversation history retains text and tool protocol only. Images stay available during internal tool follow-up turns, but attach them again for a new visual request.

## Capability reporting

`getCapabilities().images` returns `'supported'` when the iOS integration, OS, and ready system model support vision. On Android it returns `'unknown'` when the native bridge implements the image-prompt protocol and the last cached model availability is `'available'`, because ML Kit cannot report whether that device's model understands images. It returns `'unsupported'` otherwise, including when newer JavaScript runs against an older native binary; rebuild the app to add native image support. The initial Android cache is `'unknown'`, so the first call may report images as `'unsupported'` even on an eligible device. On an Android bridge with image support, each call also starts an asynchronous availability refresh and emits `availabilityChange`; read capabilities again when the hook's `availability` changes. A ready text model does not guarantee image understanding: it may reject or ignore the image. Android image inference has not yet been validated on compatible hardware. Invalid image inputs fail with `ERR_IMAGE_INVALID`.

## Try the example app

The example app’s **Image** tab bundles a known image and streams a description of its shapes and colors. Its **Images** tab compares two labeled fixtures. The prompt does not provide the answer, and the samples require no photo-library permissions or network download in a Release build.
