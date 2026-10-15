# Consumer rules applied to apps that minify release builds (the default from
# Expo SDK 58). ML Kit discovers its components by instantiating the
# registrars named in its manifest metadata through reflection. ML Kit's own
# rules do not keep their no-argument constructors, so R8 removes them and
# ML Kit never initialises: availability checks then fail on every device.
-keep class * implements com.google.firebase.components.ComponentRegistrar {
  <init>();
}
