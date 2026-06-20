plugins {
    id("com.android.application")
    id("kotlin-android")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

val parentReleaseKeystore = file("edutrack-parent-release.jks")
if (!parentReleaseKeystore.exists()) {
    throw org.gradle.api.GradleException("Missing parent release keystore. Refusing to build an APK that would break in-app updates.")
}

android {
    namespace = "ph.gov.sipalay.attendance"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = "28.2.13676358"
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
        isCoreLibraryDesugaringEnabled = true
    }

    kotlinOptions {
        jvmTarget = JavaVersion.VERSION_17.toString()
    }

    defaultConfig {
        // TODO: Specify your own unique Application ID (https://developer.android.com/studio/build/application-id.html).
        applicationId = "ph.gov.sipalay.edutrack.parent"
        // You can update the following values to match your application needs.
        // For more information, see: https://flutter.dev/to/review-gradle-config.
        minSdk = flutter.minSdkVersion
        targetSdk = flutter.targetSdkVersion
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }

    signingConfigs {
        create("release") {
            storeFile = parentReleaseKeystore
            storePassword = System.getenv("PARENT_RELEASE_STORE_PASSWORD") ?: "EduTrackParent2026!"
            keyAlias = System.getenv("PARENT_RELEASE_KEY_ALIAS") ?: "edutrack-parent"
            keyPassword = System.getenv("PARENT_RELEASE_KEY_PASSWORD") ?: "EduTrackParent2026!"
        }
    }

    buildTypes {
        release {
            signingConfig = signingConfigs.getByName("release")
        }
    }
}

flutter {
    source = "../.."
}

dependencies {
    coreLibraryDesugaring("com.android.tools:desugar_jdk_libs:2.1.5")
}
