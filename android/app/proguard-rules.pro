# PiDash Android — ProGuard/R8 rules
# (minify is currently OFF for release; these are here for when it is enabled.)

# OkHttp
-dontwarn okhttp3.**
-dontwarn okio.**

# kotlinx.serialization
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.**
-keepclassmembers class **$$serializer { *; }
-keepclasseswithmembers class com.sam.pidash.** {
    kotlinx.serialization.KSerializer serializer(...);
}
